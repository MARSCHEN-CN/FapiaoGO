"""IS-2 Commit 2：ImportBatchManager 接线验证（spool + identity）。

验证点：
- create_batch 接收 refId 形态输入（不再常驻全量 bytes）→ INV-1
- _read_input 按 refId 即时读 bytes 并消费 record.sha256（identity 不重算）→ INV-2
- 全链路：scheduler 提交给 worker 的 bytes 来自 temp 文件、file_hash == record.sha256

运行：backend/venv/Scripts/python -m pytest tests/test_import_batch_spool.py -q
"""
import io
import os
import sys
import threading

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from temp_file_registry import TempFileRegistry, LocalTempFileStorageBackend
from import_batch_manager import ImportBatchManager


class FakeJobManager:
    """极简 ParseJobManager 替身，仅供 ImportBatchManager 调度闭环测试。"""

    def __init__(self):
        self._cb = None
        self._jobs = {}
        self.queue_depth = 0
        self.submitted = []  # 记录提交给 worker 的 (file_bytes, filename)
        self.created = []    # 记录 create_job 收到的 (file_name, file_hash)

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
        file_bytes = args[0] if args else kwargs.get("file_bytes")
        filename = args[1] if len(args) > 1 else kwargs.get("filename")
        self.submitted.append({"file_bytes": file_bytes, "filename": filename})
        # 同步触发完成回调（success），驱动 _on_job_done → _wait_for_completion
        if self._cb:
            self._cb(job.id, "success")
        return True

    def get_job(self, job_id):
        return self._jobs.get(job_id)

    def get_job_result(self, job_id):
        return None  # 无 db_record → 仅计数，不触发 flush（避免触 DB）


class _FakeJob:
    def __init__(self, job_id):
        self.id = job_id
        self.metrics = {}


def _make_manager(tmp_path):
    backend = LocalTempFileStorageBackend(base_dir=str(tmp_path))
    registry = TempFileRegistry(backend)
    # 真实 __init__ 会创建默认 registry + 注册回调；这里用测试 registry 覆盖，
    # 保证 spool 与 manager 读的是同一个 registry。
    mgr = ImportBatchManager(FakeJobManager())
    mgr._temp_registry = registry
    return mgr, registry


def test_create_batch_stores_ref_ids_not_bytes(tmp_path):
    mgr, registry = _make_manager(tmp_path)
    r1 = registry.spool(io.BytesIO(b"file-one"), "a.pdf")
    r2 = registry.spool(io.BytesIO(b"file-two"), "b.pdf")
    file_inputs = [
        {"refId": r1.refId, "filename": r1.filename, "clientKey": "k1"},
        {"refId": r2.refId, "filename": r2.filename, "clientKey": "k2"},
    ]
    batch_id = mgr.create_batch(file_inputs, auto_orient=False)
    stored = mgr._batch_inputs[batch_id]
    assert len(stored) == 2
    for fi in stored:
        assert "refId" in fi
        assert "bytes" not in fi  # INV-1：上传期不再常驻全量 bytes
    # registry 仍持有这两个 ref（释放由 Commit 5 接线）
    assert set(registry.active_refs()) >= {r1.refId, r2.refId}


def test_read_input_resolves_ref_to_bytes_and_hash(tmp_path):
    mgr, registry = _make_manager(tmp_path)
    content = b"resolve me"
    r = registry.spool(io.BytesIO(content), "x.pdf")
    file_bytes, file_hash, filename = mgr._read_input({"refId": r.refId})
    assert file_bytes == content
    assert file_hash == r.sha256  # INV-2：直接用 spool 物化的 sha256，未重算
    assert filename == "x.pdf"


def test_read_input_legacy_bytes_fallback(tmp_path):
    """transitional 回退：旧 bytes 形态仍可用（Commit 3 删除）。"""
    mgr, registry = _make_manager(tmp_path)
    content = b"legacy bytes"
    import hashlib
    file_bytes, file_hash, filename = mgr._read_input({"bytes": content, "filename": "leg.pdf"})
    assert file_bytes == content
    assert file_hash == hashlib.sha256(content).hexdigest()
    assert filename == "leg.pdf"


def test_scheduler_end_to_end_reads_from_temp(tmp_path):
    """全链路：scheduler 提交给 worker 的 bytes 来自 temp 文件，hash 来自 record。"""
    mgr, registry = _make_manager(tmp_path)
    content = b"end to end payload"
    r = registry.spool(io.BytesIO(content), "e2e.pdf")
    file_inputs = [{"refId": r.refId, "filename": r.filename, "clientKey": "k"}]
    batch_id = mgr.create_batch(file_inputs, auto_orient=False)
    # 等待调度线程结束（FakeJobManager 同步触发完成）
    mgr._scheduler_threads[batch_id].join(timeout=5)
    assert mgr._batches[batch_id].status == "completed"
    # 提交给 worker 的字节确来自 temp 文件
    assert len(mgr._job_manager.submitted) == 1
    assert mgr._job_manager.submitted[0]["file_bytes"] == content
    assert mgr._job_manager.submitted[0]["filename"] == "e2e.pdf"
    # 传给 create_job 的 file_hash 就是 spool 物化的 sha256（未重算）
    assert mgr._job_manager.created[0][1] == r.sha256
