"""IS-2 Commit 3：ImportBatchManager 移除 bytes 常驻（refId 元数据 + 适配壳）。

验证点（对齐用户 Commit 3 验收目标）：
- manager 不再有 _batch_inputs 独立持有 dict；refId 元数据收进 ImportBatch.file_inputs
- 1000 文件：manager 内存只搬运 refId，从不搬运 bytes（INV-1）
- scheduler 把 ref_id（而非 bytes）传给 submit_job
- _parse_via_registry 适配壳：ref_id → 读 temp 文件 bytes → 喂给 worker（签名不变）
- 全链路：worker 收到的 bytes 来自 temp 文件、file_hash == record.sha256（INV-2）

运行：backend/venv/Scripts/python -m pytest tests/test_import_batch_spool.py -q
"""
import contextlib
import io
import os
import sys
import types

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from temp_file_registry import TempFileRegistry, LocalTempFileStorageBackend
from import_batch_manager import ImportBatchManager


class FakeJobManager:
    """极简 ParseJobManager 替身，验证 manager→worker 的 ref_id 链路。"""

    def __init__(self):
        self._cb = None
        self._jobs = {}
        self.queue_depth = 0
        self.submitted = []   # 记录提交给 submit_job 的 (input_ref, filename)
        self.created = []     # 记录 create_job 收到的 (file_name, file_hash)
        self.executed = []    # 记录 _parse_via_registry 解析出的结果（测试专用同步执行）

    def on_job_complete(self, callback):
        self._cb = callback

    def queue_size(self):
        return self.queue_depth

    def create_job(self, file_name, file_hash, batch_id=""):
        job_id = "job-" + str(len(self._jobs) + 1)
        self._jobs[job_id] = {"batch_id": batch_id, "file_name": file_name}
        self.created.append((file_name, file_hash))
        return _FakeJob(job_id)

    def submit_job(self, job, parse_func, *args, **kwargs):
        input_ref = args[0] if args else kwargs.get("input_ref")
        filename = args[1] if len(args) > 1 else kwargs.get("filename")
        self.submitted.append({"input_ref": input_ref, "filename": filename})
        # 同步执行适配壳，验证 ref_id → bytes → worker 全链路（测试专用）
        result = parse_func(*args, **kwargs)
        self.executed.append({"input_ref": input_ref, "result": result})
        if self._cb:
            self._cb(job.id, "success")
        return True

    def get_job(self, job_id):
        return self._jobs.get(job_id)

    def get_job_result(self, job_id):
        return None


class _FakeJob:
    def __init__(self, job_id):
        self.id = job_id
        self.metrics = {}


@contextlib.contextmanager
def _mock_parse_service():
    """把 services.invoice_service.parse_invoice_service 替换为记录入参的 mock。"""
    captured = {}

    def mock_parse(file_bytes, filename, **kwargs):
        captured['bytes'] = file_bytes
        captured['filename'] = filename
        return {
            'parse_method': 'mock',
            'file_format': 'pdf',
            'db_record': {'file_name': filename, 'hash_sha256': 'x'},
        }

    mod = types.ModuleType('services.invoice_service')
    mod.parse_invoice_service = mock_parse
    svc = types.ModuleType('services')
    svc.invoice_service = mod
    saved_services = sys.modules.get('services')
    saved_svc = sys.modules.get('services.invoice_service')
    sys.modules['services'] = svc
    sys.modules['services.invoice_service'] = mod
    try:
        yield captured
    finally:
        if saved_services is None:
            sys.modules.pop('services', None)
        else:
            sys.modules['services'] = saved_services
        if saved_svc is None:
            sys.modules.pop('services.invoice_service', None)
        else:
            sys.modules['services.invoice_service'] = saved_svc


def _make_manager(tmp_path):
    backend = LocalTempFileStorageBackend(base_dir=str(tmp_path))
    registry = TempFileRegistry(backend)
    # 真实 __init__ 会创建默认 registry + 注册回调；这里用测试 registry 覆盖，
    # 保证 spool 与 manager 读的是同一个 registry。
    mgr = ImportBatchManager(FakeJobManager())
    mgr._temp_registry = registry
    return mgr, registry


def test_manager_has_no_batch_inputs_dict(tmp_path):
    mgr, registry = _make_manager(tmp_path)
    # Commit 3 必须删除 manager 独立的 _batch_inputs 持有 dict（INV-1：不常驻 bytes）
    assert not hasattr(mgr, '_batch_inputs'), "Commit 3 必须删除 manager 独立的 _batch_inputs 持有 dict"


def test_create_batch_passes_ref_ids_to_scheduler(tmp_path):
    mgr, registry = _make_manager(tmp_path)
    r1 = registry.spool(io.BytesIO(b"file-one"), "a.pdf")
    r2 = registry.spool(io.BytesIO(b"file-two"), "b.pdf")
    file_inputs = [
        {"refId": r1.refId, "filename": r1.filename, "clientKey": "k1"},
        {"refId": r2.refId, "filename": r2.filename, "clientKey": "k2"},
    ]
    with _mock_parse_service():
        batch_id = mgr.create_batch(file_inputs, auto_orient=False)
        mgr._scheduler_threads[batch_id].join(timeout=5)
    # scheduler 提交给 submit_job 的是 refId，不是 bytes
    assert len(mgr._job_manager.submitted) == 2
    got = {s["input_ref"] for s in mgr._job_manager.submitted}
    assert got == {r1.refId, r2.refId}
    for s in mgr._job_manager.submitted:
        assert isinstance(s["input_ref"], str)
        assert not isinstance(s["input_ref"], (bytes, bytearray))
    # registry 仍持有这两个 ref（释放由 Commit 5 接线）
    assert set(registry.active_refs()) >= {r1.refId, r2.refId}


def test_1000_files_manager_holds_only_ref_ids(tmp_path):
    """核心验收：1000 文件时 manager 只搬运 refId，从不搬运 bytes（无 RAM 峰值）。"""
    mgr, registry = _make_manager(tmp_path)
    refs = []
    for i in range(1000):
        r = registry.spool(io.BytesIO(f"payload-{i}".encode()), f"f{i:04d}.pdf")
        refs.append({"refId": r.refId, "filename": r.filename})
    with _mock_parse_service():
        batch_id = mgr.create_batch(refs, auto_orient=False)
        mgr._scheduler_threads[batch_id].join(timeout=30)
    # manager 从未持有 bytes：无 _batch_inputs dict
    assert not hasattr(mgr, '_batch_inputs')
    # scheduler 全程只搬运 refId（1000 条），从不搬运 bytes
    assert len(mgr._job_manager.submitted) == 1000
    for s in mgr._job_manager.submitted:
        assert isinstance(s['input_ref'], str)  # refId，不是 bytes
        assert not isinstance(s['input_ref'], (bytes, bytearray))
    # temp 文件仍在（释放由 Commit 5），registry 持有 1000 refs → 责任已转移给 registry
    assert len(registry.active_refs()) == 1000


def test_scheduler_submits_ref_id_not_bytes(tmp_path):
    mgr, registry = _make_manager(tmp_path)
    content = b"scheduler payload"
    r = registry.spool(io.BytesIO(content), "s.pdf")
    file_inputs = [{"refId": r.refId, "filename": r.filename, "clientKey": "k"}]
    with _mock_parse_service():
        batch_id = mgr.create_batch(file_inputs, auto_orient=False)
        mgr._scheduler_threads[batch_id].join(timeout=5)
    assert mgr._batches[batch_id].status == "completed"
    assert len(mgr._job_manager.submitted) == 1
    # scheduler 传给 submit_job 的是 ref_id，不是 bytes
    assert mgr._job_manager.submitted[0]["input_ref"] == r.refId
    assert mgr._job_manager.submitted[0]["input_ref"] != content


def test_parse_via_registry_reads_bytes_from_temp(tmp_path):
    """ref→bytes 适配壳：从 temp 文件读出 bytes 喂给 worker（worker 签名不变）。"""
    mgr, registry = _make_manager(tmp_path)
    content = b"resolve via registry"
    r = registry.spool(io.BytesIO(content), "x.pdf")
    with _mock_parse_service() as captured:
        result = mgr._parse_via_registry(r.refId, "x.pdf", auto_orient=False, skip_db_write=True)
    # 适配壳从 temp 文件读出的 bytes 喂给了 worker
    assert captured['bytes'] == content
    assert result['parse_method'] == 'mock'


def test_scheduler_end_to_end_bytes_from_temp_and_hash_from_record(tmp_path):
    """全链路：worker 收到的 bytes 来自 temp 文件，file_hash == record.sha256（INV-2）。"""
    mgr, registry = _make_manager(tmp_path)
    content = b"end to end payload"
    r = registry.spool(io.BytesIO(content), "e2e.pdf")
    file_inputs = [{"refId": r.refId, "filename": r.filename, "clientKey": "k"}]
    with _mock_parse_service() as captured:
        batch_id = mgr.create_batch(file_inputs, auto_orient=False)
        mgr._scheduler_threads[batch_id].join(timeout=5)
    assert mgr._batches[batch_id].status == "completed"
    # 传给 create_job 的 file_hash 就是 spool 物化的 sha256（未重算）
    assert mgr._job_manager.created and mgr._job_manager.created[0][1] == r.sha256
    # worker 实际收到的 bytes 来自 temp 文件
    assert captured['bytes'] == content
