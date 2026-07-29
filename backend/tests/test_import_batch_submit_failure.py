"""#2 回归：submit_job 返回 False（队列满）时，批次不得卡死 / 泄漏 temp / 跳过 job。

修复前（import_batch_manager.py 旧 :516-521）：
  scheduler 在 submit_job 失败后仅 `break`，随后 `submitted = window_end` 无条件
  跳过窗口内尚未提交的 job；且失败 job 已在 :505 追加进 job_ids，却因从未入队、
  执行器完成回调永不触发，_on_job_done 不会为它计数 / 释放 ref。
  后果：batch.finished 永远到不了 total → _wait_for_completion 死循环、批次卡死
  running、temp 文件泄漏、窗口内其余 job 被静默丢弃。

修复后（import_batch_manager.py :519-537）：
  失败 job 就地镜像 _on_job_done 的 failed 分支补账（release ref + failed++，
  含 cancelled 护栏），并以 stop_at = i+1 续传，[i+1, window_end) 的未提交 job
  留待下轮重试，不再跳过。

验收：
  - 全部 submit 失败 → 批次走到终态 failed（不挂起），failed==total，所有 ref 释放
  - 首个 submit 失败、其余成功 → 批次 completed，failed==1、success==total-1，
    submit_job 恰被调用 total 次（无 job 被跳过），所有 ref 释放

运行：backend/venv/Scripts/python -m pytest tests/test_import_batch_submit_failure.py -q
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


class _FakeJob:
    def __init__(self, job_id, batch_id="", file_name=""):
        self.id = job_id
        self.batch_id = batch_id
        self.file_name = file_name
        self.metrics = {}


class FlakyJobManager:
    """模拟队列满：前 fail_first_n 次 submit_job 返回 False（不入队 / 不执行 / 不回调），
    之后正常同步执行适配壳并触发 success 完成回调。

    镜像真实 submit_job 的失败语义（parse_job_manager.py:449）：返回 False 时 job 已被
    标记终态 failed 但从未入队 → add_done_callback 永不触发 → _on_job_done 不会为它
    计数 / 释放 ref。修复必须在该分支就地补账，本替身正是为暴露这条路径而设。
    """

    def __init__(self, fail_first_n: int = 0):
        self._cb = None
        self._jobs = {}
        self._fail_first_n = fail_first_n
        self._submit_calls = 0
        self.submitted = []     # 每次 submit_job 尝试（含失败），用于核对"无跳过"
        self.executed_ok = 0    # 成功入队并执行的次数

    def on_job_complete(self, callback):
        self._cb = callback

    def queue_size(self):
        # 始终低于 QUEUE_LOW_WATER，让 scheduler 持续尝试提交（充分暴露重试 / 补账路径）
        return 0

    def create_job(self, file_name, file_hash, batch_id=""):
        job_id = "job-" + str(len(self._jobs) + 1)
        job = _FakeJob(job_id, batch_id, file_name)
        self._jobs[job_id] = job
        return job

    def submit_job(self, job, parse_func, *args, **kwargs):
        self._submit_calls += 1
        input_ref = args[0] if args else kwargs.get("input_ref")
        filename = args[1] if len(args) > 1 else kwargs.get("filename")
        self.submitted.append({"input_ref": input_ref, "filename": filename, "job_id": job.id})
        if self._submit_calls <= self._fail_first_n:
            return False  # 队列满：不入队、不执行、不回调
        # 成功入队 → 同步执行适配壳并触发完成回调（端到端）
        parse_func(*args, **kwargs)
        self.executed_ok += 1
        if self._cb:
            self._cb(job.id, "success")
        return True

    def get_job(self, job_id):
        job = self._jobs.get(job_id)
        if not job:
            return None
        # 镜像真实 ParseJobManager.to_dict：metrics 浅拷贝（含 ref_id）
        return {
            "batch_id": job.batch_id,
            "file_name": job.file_name,
            "metrics": dict(job.metrics),
            "status": "success",
        }

    def get_job_result(self, job_id):
        return None


@contextlib.contextmanager
def _mock_parse_service():
    """把 services.invoice_service.parse_invoice_service 替换为轻量 mock，
    避免成功路径的 _parse_via_registry 引入真实解析依赖。"""
    def mock_parse(file_bytes, filename, **kwargs):
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
        yield
    finally:
        if saved_services is None:
            sys.modules.pop('services', None)
        else:
            sys.modules['services'] = saved_services
        if saved_svc is None:
            sys.modules.pop('services.invoice_service', None)
        else:
            sys.modules['services.invoice_service'] = saved_svc


def _make_manager(tmp_path, job_manager):
    backend = LocalTempFileStorageBackend(base_dir=str(tmp_path))
    registry = TempFileRegistry(backend)
    # 真实 __init__ 会创建默认 registry；这里用测试 registry 覆盖，
    # 保证 spool 与 manager 读 / 释放的是同一个 registry。
    mgr = ImportBatchManager(job_manager)
    mgr._temp_registry = registry
    return mgr, registry


def _spool_refs(registry, n):
    refs = []
    for i in range(n):
        r = registry.spool(io.BytesIO(f"payload-{i}".encode()), f"f{i:04d}.pdf")
        refs.append({"refId": r.refId, "filename": r.filename})
    return refs


# ─── 验收 1：全部 submit 失败 → 批次走到 failed 终态（不挂起），ref 全释放 ───

def test_all_submit_fail_batch_reaches_failed_terminal(tmp_path):
    """修复前：首个 submit 失败即 break + submitted=window_end，job 从不计数
    → finished 永远 < total → _wait_for_completion 死循环、批次卡死 running。
    修复后：每个失败 job 就地 failed++ 并释放 ref，批次走到 failed 终态。"""
    total = 5
    jm = FlakyJobManager(fail_first_n=10 ** 9)  # 永远失败
    mgr, registry = _make_manager(tmp_path, jm)
    refs = _spool_refs(registry, total)
    with _mock_parse_service():
        batch_id = mgr.create_batch(refs, auto_orient=False)
        # 修复后毫秒级完成；若回归（卡死），join 超时后 batch 仍 running → 断言失败
        mgr._scheduler_threads[batch_id].join(timeout=10)

    batch = mgr._batches[batch_id]
    assert batch.status == "failed", f"批次应走到 failed 终态，实际 {batch.status}（疑似卡死回归）"
    assert batch.failed == total
    assert batch.success == 0
    assert batch.finished == batch.total == total
    # temp 引用全部释放（无泄漏）
    assert registry.active_refs() == [], "失败 job 的 temp 引用必须被释放"


# ─── 验收 2：首个 submit 失败、其余成功 → 无 job 被跳过，批次 completed ───

def test_transient_submit_failure_no_job_skipped(tmp_path):
    """修复前：job[0] submit 失败后 submitted=window_end 直接跳过 job[1..N-1]
    → 它们从不提交、从不成功，且批次卡死。
    修复后：job[0] 计为 failed，job[1..N-1] 下轮重试并成功 → completed，
    且 submit_job 恰被调用 total 次（每个文件恰好一次，无跳过）。"""
    total = 5
    jm = FlakyJobManager(fail_first_n=1)  # 仅第一次 submit 失败
    mgr, registry = _make_manager(tmp_path, jm)
    refs = _spool_refs(registry, total)
    with _mock_parse_service():
        batch_id = mgr.create_batch(refs, auto_orient=False)
        mgr._scheduler_threads[batch_id].join(timeout=10)

    batch = mgr._batches[batch_id]
    assert batch.status == "completed", f"批次应 completed，实际 {batch.status}（疑似卡死回归）"
    assert batch.failed == 1, "首个 submit 失败的 job 必须被计数为 failed"
    assert batch.success == total - 1, "其余 job 必须被重试并成功（不得被跳过）"
    assert batch.finished == batch.total == total
    # 关键：无 job 被跳过 → submit_job 恰被调用 total 次
    assert jm._submit_calls == total, (
        f"submit_job 被调用 {jm._submit_calls} 次，应为 {total}（每个文件恰好一次，无跳过）"
    )
    # 所有 ref 释放（失败 job 由修复路径释放，成功 job 由 _on_job_done 释放）
    assert registry.active_refs() == [], "所有 temp 引用必须被释放"
