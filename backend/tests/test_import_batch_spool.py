"""IS-2：ImportBatchManager 临时文件所有权契约（Commit 3 + Commit 5）。

验证点：
- Commit 3：manager 无 _batch_inputs 独立持有 dict；1000 文件只搬 refId 不搬 bytes（INV-1）；
  scheduler 把 ref_id（非 bytes）传给 submit_job；_parse_via_registry 适配壳 ref→bytes（签名不变）；
  全链路 worker 收到的 bytes 来自 temp 文件、file_hash == record.sha256（INV-2）。
- Commit 5：temp 文件"谁拥有 / 何时释放"闭环——
  * _on_job_done 在 worker 终态时释放该 job 的 ref（success/failed/cancelled 均释放，幂等）
  * cancel 不删已提交(inflight)的 temp 文件（避免与 worker 竞态 FileNotFoundError），
    只释放尚未提交的 pending ref
  * cleanup_batch 仅终态批次释放残留 pending，运行态批次的 ref 不碰
  * 归一化失败回收已 spool 的孤立 ref

运行：backend/venv/Scripts/python -m pytest tests/test_import_batch_spool.py -q
"""
import contextlib
import io
import os
import sys
import time
import types

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from temp_file_registry import TempFileRegistry, LocalTempFileStorageBackend
from import_batch_manager import ImportBatchManager, ImportBatch


class FakeJobManager:
    """极简 ParseJobManager 替身，验证 manager→worker 的 ref_id 链路。

    execute=True（默认）：submit_job 同步执行适配壳并触发完成回调（端到端测试用）。
    execute=False：submit_job 仅登记（job 保持 inflight，不触发回调），用于 cancel 竞态测试。
    queue_size_val：模拟队列深度，用于让 scheduler 在首窗口后停顿，制造 pending 引用。
    """

    def __init__(self, execute: bool = True, queue_size: int = 0, stall_after: int = None):
        self._cb = None
        self._jobs = {}
        self.execute = execute
        self.queue_size_val = queue_size
        self._stall_after = stall_after
        self.submitted = []   # 记录提交给 submit_job 的 (input_ref, filename, job_id)
        self.created = []     # 记录 create_job 收到的 (file_name, file_hash)
        self.executed = []    # 记录 _parse_via_registry 解析出的结果（同步执行时）

    def on_job_complete(self, callback):
        self._cb = callback

    def queue_size(self):
        # 动态队列深度：提交数达到 stall_after 后返回"满"，迫使 scheduler 停顿，
        # 制造"已提交(inflight) + 未提交(pending)"的分裂态（cancel 竞态测试用）。
        if self._stall_after is not None and len(self.submitted) >= self._stall_after:
            return self.queue_size_val
        return 0

    def create_job(self, file_name, file_hash, batch_id=""):
        job_id = "job-" + str(len(self._jobs) + 1)
        job = _FakeJob(job_id, batch_id, file_name)
        self._jobs[job_id] = job
        self.created.append((file_name, file_hash))
        return job

    def submit_job(self, job, parse_func, *args, **kwargs):
        input_ref = args[0] if args else kwargs.get("input_ref")
        filename = args[1] if len(args) > 1 else kwargs.get("filename")
        self.submitted.append({
            "input_ref": input_ref,
            "filename": filename,
            "job_id": job.id,
        })
        if self.execute:
            # 同步执行适配壳，验证 ref_id → bytes → worker 全链路（测试专用）
            result = parse_func(*args, **kwargs)
            self.executed.append({"input_ref": input_ref, "result": result})
            if self._cb:
                self._cb(job.id, "success")
        return True

    def get_job(self, job_id):
        job = self._jobs.get(job_id)
        if not job:
            return None
        # 镜像真实 ParseJobManager.to_dict：metrics 浅拷贝（含 ref_id），在调用时取值
        return {
            "batch_id": job.batch_id,
            "file_name": job.file_name,
            "metrics": dict(job.metrics),
            "status": "success",
        }

    def get_job_result(self, job_id):
        return None


class _FakeJob:
    def __init__(self, job_id, batch_id="", file_name=""):
        self.id = job_id
        self.batch_id = batch_id
        self.file_name = file_name
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
    # 保证 spool 与 manager 读/释放的是同一个 registry。
    mgr = ImportBatchManager(FakeJobManager())
    mgr._temp_registry = registry
    return mgr, registry


def _wait_until(predicate, timeout=10.0, interval=0.02):
    """轮询等待 predicate() 为真（测试专用，避免固定 sleep）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


# ─── Commit 3：无 bytes 常驻 + ref 链路 ─────────────────────────

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
    # Commit 5：完成后 temp 文件已被 _on_job_done 释放（不再常驻）
    assert registry.active_refs() == [], "完成后所有 ref 应已释放"
    assert not os.path.exists(r1.path)
    assert not os.path.exists(r2.path)


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
    assert not hasattr(mgr, '_batch_inputs')
    assert len(mgr._job_manager.submitted) == 1000
    for s in mgr._job_manager.submitted:
        assert isinstance(s['input_ref'], str)  # refId，不是 bytes
        assert not isinstance(s['input_ref'], (bytes, bytearray))
    # Commit 5：全部完成后 1000 个 temp 引用均已释放
    assert len(registry.active_refs()) == 0


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
    assert mgr._job_manager.submitted[0]["input_ref"] == r.refId
    assert mgr._job_manager.submitted[0]["input_ref"] != content
    # Commit 5：完成后释放
    assert registry.active_refs() == []


def test_parse_via_registry_reads_bytes_from_temp(tmp_path):
    """ref→bytes 适配壳：从 temp 文件读出 bytes 喂给 worker（worker 签名不变）。"""
    mgr, registry = _make_manager(tmp_path)
    content = b"resolve via registry"
    r = registry.spool(io.BytesIO(content), "x.pdf")
    with _mock_parse_service() as captured:
        result = mgr._parse_via_registry(r.refId, "x.pdf", auto_orient=False, skip_db_write=True)
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
    assert mgr._job_manager.created and mgr._job_manager.created[0][1] == r.sha256
    assert captured['bytes'] == content
    # Commit 5：完成后释放
    assert registry.active_refs() == []


# ─── Commit 5：release 生命周期闭环 ─────────────────────────

def test_registry_lifecycle_retain_release_removes_file(tmp_path):
    """registry 层：spool 落盘 → release 删除文件 → 二次 release 幂等(返回 False)。"""
    backend = LocalTempFileStorageBackend(base_dir=str(tmp_path))
    registry = TempFileRegistry(backend)
    rec = registry.spool(io.BytesIO(b"to release"), "r.pdf")
    assert os.path.exists(rec.path)
    assert rec.refId in registry.active_refs()
    # 释放 → 文件删除
    assert registry.release(rec.refId) is True
    assert not os.path.exists(rec.path)
    assert rec.refId not in registry.active_refs()
    # 二次释放幂等，不抛、不二删
    assert registry.release(rec.refId) is False


def test_on_job_done_releases_ref_on_success(tmp_path):
    """Commit 5：_on_job_done(success) 释放该 job 的 temp 引用。"""
    mgr, registry = _make_manager(tmp_path)
    r = registry.spool(io.BytesIO(b"success payload"), "s.pdf")
    batch_id = "B-on-done-success"
    mgr._batches[batch_id] = ImportBatch(id=batch_id, total=1, status='running')
    mgr._job_manager._jobs["job-s"] = _FakeJob("job-s", batch_id, "s.pdf")
    mgr._job_manager._jobs["job-s"].metrics['ref_id'] = r.refId
    mgr._on_job_done("job-s", "success")
    assert r.refId not in registry.active_refs()
    assert not os.path.exists(r.path)


def test_on_job_done_releases_ref_on_failure(tmp_path):
    """Commit 5：_on_job_done(failed) 同样释放（失败也不能泄漏 temp 文件）。"""
    mgr, registry = _make_manager(tmp_path)
    r = registry.spool(io.BytesIO(b"failed payload"), "f.pdf")
    batch_id = "B-on-done-fail"
    mgr._batches[batch_id] = ImportBatch(id=batch_id, total=1, status='running')
    mgr._job_manager._jobs["job-f"] = _FakeJob("job-f", batch_id, "f.pdf")
    mgr._job_manager._jobs["job-f"].metrics['ref_id'] = r.refId
    mgr._on_job_done("job-f", "failed")
    assert r.refId not in registry.active_refs()
    assert not os.path.exists(r.path)


def test_on_job_done_release_is_idempotent(tmp_path):
    """Commit 5：完成回调重复触发不会二次删除（INV-3）。"""
    mgr, registry = _make_manager(tmp_path)
    r = registry.spool(io.BytesIO(b"idempotent"), "i.pdf")
    batch_id = "B-idem"
    mgr._batches[batch_id] = ImportBatch(id=batch_id, total=1, status='running')
    mgr._job_manager._jobs["job-i"] = _FakeJob("job-i", batch_id, "i.pdf")
    mgr._job_manager._jobs["job-i"].metrics['ref_id'] = r.refId
    mgr._on_job_done("job-i", "success")
    mgr._on_job_done("job-i", "success")  # 重复回调
    assert r.refId not in registry.active_refs()
    assert not os.path.exists(r.path)


def test_cancel_does_not_delete_inflight_ref(tmp_path):
    """Commit 5：cancel 不得删除已提交(inflight)的 temp 文件（worker 可能仍在读取）。"""
    mgr, registry = _make_manager(tmp_path)
    mgr._job_manager.execute = False  # 不自动执行，job 保持 inflight
    r = registry.spool(io.BytesIO(b"inflight"), "i.pdf")
    file_inputs = [{"refId": r.refId, "filename": r.filename}]
    with _mock_parse_service():
        batch_id = mgr.create_batch(file_inputs, auto_orient=False)
        assert _wait_until(lambda: len(mgr._job_manager.submitted) >= 1)
        mgr.cancel_batch(batch_id)
        mgr._scheduler_threads[batch_id].join(timeout=5)
    # cancel 不应删除 inflight ref
    assert r.refId in registry.active_refs(), "cancel 不应删除已提交(inflight)的 temp 文件"
    assert os.path.exists(r.path)
    # worker 终态后 _on_job_done 释放
    job_id = mgr._job_manager.submitted[0]["job_id"]
    mgr._on_job_done(job_id, "success")
    assert r.refId not in registry.active_refs()
    assert not os.path.exists(r.path)


def test_cancel_releases_only_pending_not_inflight(tmp_path):
    """Commit 5：cancel 只释放尚未提交的 pending ref，保留已提交(inflight)的 ref。"""
    mgr, registry = _make_manager(tmp_path)
    mgr._job_manager.execute = False
    mgr._job_manager.queue_size_val = 99   # 首窗口(50)提交后切换为"队列满"，迫使 scheduler 停顿
    mgr._job_manager._stall_after = 50
    refs = []
    for i in range(100):
        r = registry.spool(io.BytesIO(f"p{i}".encode()), f"p{i}.pdf")
        refs.append({"refId": r.refId, "filename": r.filename})
    with _mock_parse_service():
        batch_id = mgr.create_batch(refs, auto_orient=False)
        assert _wait_until(lambda: len(mgr._job_manager.submitted) >= 50)
        mgr.cancel_batch(batch_id)
        mgr._scheduler_threads[batch_id].join(timeout=5)
    submitted_refs = {s["input_ref"] for s in mgr._job_manager.submitted}
    assert len(submitted_refs) == 50
    # inflight（已提交）ref 必须仍在；pending（未提交）ref 已被 cancel 释放
    active = set(registry.active_refs())
    assert active == submitted_refs, "cancel 应只释放 pending，保留 inflight"
    for sref in submitted_refs:
        assert os.path.exists(registry.get(sref).path), "inflight 文件不应被 cancel 删除"


def test_cleanup_batch_releases_terminal_pending_only(tmp_path):
    """Commit 5：cleanup_batch 仅终态批次释放残留 pending；运行态批次的 ref 不碰。"""
    mgr, registry = _make_manager(tmp_path)
    # 场景 A：已终态(cancelled)批次，残留 pending ref → cleanup 释放
    ra = registry.spool(io.BytesIO(b"a"), "a.pdf")
    batch_a = "B-term"
    mgr._batches[batch_a] = ImportBatch(
        id=batch_a, total=1, status='cancelled',
        file_inputs=[{"refId": ra.refId, "filename": ra.filename}],
    )
    mgr.cleanup_batch(batch_a)
    assert ra.refId not in registry.active_refs()
    assert not os.path.exists(ra.path)

    # 场景 B：仍在运行批次，pending ref 不得被 cleanup 释放（scheduler 仍持有）
    rb = registry.spool(io.BytesIO(b"b"), "b.pdf")
    batch_b = "B-run"
    mgr._batches[batch_b] = ImportBatch(
        id=batch_b, total=1, status='running',
        file_inputs=[{"refId": rb.refId, "filename": rb.filename}],
    )
    mgr.cleanup_batch(batch_b)
    assert rb.refId in registry.active_refs(), "运行态批次的 pending ref 不得被 cleanup 释放"
    assert os.path.exists(rb.path)
    # 收尾：手动释放，避免测试泄漏
    mgr._release_inputs(mgr._batches[batch_b].file_inputs)


def test_create_batch_orphan_refs_released_on_normalization_failure(tmp_path):
    """Commit 5：归一化失败（如第 N 个非法输入）时，已 spool 的孤立 ref 必须回收。"""
    mgr, registry = _make_manager(tmp_path)
    ok = registry.spool(io.BytesIO(b"ok"), "ok.pdf")
    bad = registry.spool(io.BytesIO(b"bad"), "bad.pdf")
    file_inputs = [
        {"refId": ok.refId, "filename": ok.filename},
        {"refId": bad.refId, "filename": bad.filename},
        {"bytes": b"third"},  # 会先 spool 再因下一行非法而整体回滚
        {"neither": "x"},     # 非法：既无 refId 也无 bytes
    ]
    try:
        mgr.create_batch(file_inputs, auto_orient=False)
        assert False, "create_batch 应因非法输入抛 ValueError"
    except ValueError:
        pass
    # 前三个已 spool 的 ref 必须被回收（无孤立 temp 文件）
    assert ok.refId not in registry.active_refs()
    assert bad.refId not in registry.active_refs()
    assert not os.path.exists(ok.path)
    assert not os.path.exists(bad.path)
