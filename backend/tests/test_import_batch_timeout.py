# -*- coding: utf-8 -*-
"""
Commit 5.1c-1（test-only：锁定 timeout/watchdog 行为 contract，不实现业务）

═══════════════════════════════════════════════════════════════
驱动入口选择（关键，回应「不要锁内部 watchdog 函数名」）
═══════════════════════════════════════════════════════════════
5.1c 的 timeout 是机制层，实现可能是 _check_job_timeout / _apply_timeouts /
嵌入 _wait_for_completion 等任一形态。本测试**不调用任何未来函数名**，
只通过两条已存在的链路驱动并断言可观察行为：

  1) ImportBatchManager._wait_for_completion(batch_id)
     —— 既有批次解析器。冻结 TIMEOUT_CONTRACT_5_1c0.md §2.2 明确把
        "Batch assembly timeout" 的 owner 定为该循环：它把 batch.status 设为
        终态后，get_batch_dict 才能报 completed_with_errors / failed。
        测试以线程运行它触发 timeout 解析（当前无 timeout → 无限循环，
        由 cancel flag 安全回收，不污染状态）。

  2) ImportBatchManager.get_batch_dict(batch_id)
     —— SSE 每 0.5s 观察点（5.1b-3a）：running 批次暴露 missingPages/failedPages
        预览；终态批次暴露终态 status。

测试只断言「观察链路暴露的行为契约」，不假设 watchdog 内部函数名；
5.1c-2 可在 _wait_for_completion 内或独立 watchdog 实现，只要上述观察链路
暴露相同行为即合规。

═══════════════════════════════════════════════════════════════
当前（5.1c-2 未实现）应为 RED 的原因
═══════════════════════════════════════════════════════════════
- _collect_batch_page_health 只读 job.status：running/pending 的超时 job
  归入 missingPages，且不会把 job.status 改写为 failed。
- _wait_for_completion 无 timeout，stuck job → 无限循环（测试用 cancel 回收）。
故 timeout 页落 missing、job 仍为 running/pending、batch 永不终态 → 本测试红。
5.1c-2 让 _wait_for_completion 超时感知 + 把超时 job 翻 failed 后转绿。

契约定锁（来自 TIMEOUT_CONTRACT_5_1c0.md §2/§3）：
  Case 1: running job 超时 → failedPages（非 missingPages），job.status == 'failed'
  Case 2: timeout 后晚到 success 不复活（timed_out 优先）
  Case 3: queued(pending) job 超排队时间 → failedPages
  Case 4: 部分成功 + 其余超时 → completed_with_errors + failedPages
  Case 5: 全部超时 → failed
  Case 6: cancel 优先 → cancelled（timeout 不覆盖，且 stale job 不被翻 failed）
  Case 7: 正常完成（terminal 且 created_at 旧）不受 timeout 改写 → completed

字段断言：超时页须 job.status == 'failed'（区分普通 worker fail 与 timeout fail）；
  若 5.1c-2 引入 timed_out/reason 字段则额外校验（软断言，不强制）。

运行（backend 测试被 gitignore，需 -f 纳入）：
  backend/venv/Scripts/python -m pytest tests/test_import_batch_timeout.py -q
"""
import os
import sys
import time
import threading
import unittest

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _BACKEND_DIR)

from import_batch_manager import ImportBatchManager, ImportBatch


STALE_TS = time.time() - 99999  # 远过去，保证触发超时


class FakeJobManager:
    """极简 ParseJobManager 替身，仅满足 _wait_for_completion / get_batch_dict 所需接口。"""
    def __init__(self, jobs=None):
        self._jobs = jobs or {}

    def on_job_complete(self, callback):
        pass

    def get_job(self, job_id):
        return self._jobs.get(job_id)

    def update_status(self, job_id, status, progress=None, error=''):
        """镜像真实 ParseJob.update_status 的 manager 级接口（供 5.1c-2 watchdog 翻 failed 用）。"""
        j = self._jobs.get(job_id)
        if j:
            j['status'] = status
            if error:
                j['error'] = error
            if status == 'failed' and error == 'timeout':
                j['timed_out'] = True


def _job(job_id, status, page_num, total_pages, source_doc_id='docA',
         started_at=None, created_at=None, timed_out=False):
    return {
        'id': job_id,
        'status': status,
        'error': '',
        'timed_out': timed_out,
        'created_at': created_at if created_at is not None else STALE_TS,
        'started_at': started_at if started_at is not None else (STALE_TS if status == 'running' else ''),
        'metrics': {
            'page_num': str(page_num),
            'total_pages': str(total_pages),
            'source_doc_id': source_doc_id,
            'client_key': f'ck{page_num}',
        },
    }


def _batch(mgr, batch_id, job_ids, status='running'):
    batch = ImportBatch(id=batch_id, total=len(job_ids), status=status, job_ids=list(job_ids))
    mgr._batches[batch_id] = batch
    return batch


def _resolve(mgr, batch_id, join_timeout=1.5):
    """以线程运行既有解析器 _wait_for_completion，触发 timeout 解析。

    当前实现无 timeout → 无限循环；用 cancel flag 安全回收（不解析）。
    5.1c-2 超时感知后会在超时处解析并返回。
    """
    t = threading.Thread(target=mgr._wait_for_completion, args=(batch_id,), daemon=True)
    t.start()
    t.join(join_timeout)
    if t.is_alive():
        mgr._cancel_flags[batch_id] = True
        t.join(2.0)
    return mgr.get_batch_dict(batch_id)


def _pages_for(pages_list, source_doc_id):
    for entry in pages_list:
        if entry.get('sourceDocId') == source_doc_id:
            return entry.get('pages', [])
    return []


def _build(jobs, batch_id, job_ids, status='running'):
    jm = FakeJobManager(jobs)
    mgr = ImportBatchManager(jm)
    _batch(mgr, batch_id, job_ids, status=status)
    return mgr, jm


class TestTimeoutJob(unittest.TestCase):
    # Case 1: running job 超时 → failed page（非 missing）
    def test_case1_running_job_timeout_to_failed_page(self):
        jobs = {
            'j0': _job('j0', 'success', 0, 3),
            'j1': _job('j1', 'running', 1, 3, started_at=STALE_TS),
        }
        mgr, jm = _build(jobs, 'b1', ['j0', 'j1'])
        state = _resolve(mgr, 'b1')
        self.assertEqual(state['status'], 'completed_with_errors')
        self.assertEqual(_pages_for(state['failedPages'], 'docA'), [1])
        self.assertEqual(_pages_for(state['missingPages'], 'docA'), [])
        self.assertEqual(jm.get_job('j1')['status'], 'failed')

    # Case 2: timeout 后晚到 success 不复活（timed_out 优先）
    def test_case2_late_success_does_not_resurrect(self):
        jobs = {
            'j0': _job('j0', 'success', 0, 2),
            'j1': _job('j1', 'success', 1, 2, timed_out=True),
        }
        mgr, jm = _build(jobs, 'b2', ['j0', 'j1'])
        state = _resolve(mgr, 'b2')
        self.assertEqual(state['status'], 'completed_with_errors')
        self.assertEqual(_pages_for(state['failedPages'], 'docA'), [1])
        self.assertEqual(_pages_for(state['missingPages'], 'docA'), [])

    # Case 3: queued(pending) job 超排队时间 → failed
    def test_case3_queued_job_queue_timeout_to_failed(self):
        jobs = {
            'j0': _job('j0', 'success', 0, 2),
            'j1': _job('j1', 'pending', 1, 2, created_at=STALE_TS),
        }
        mgr, jm = _build(jobs, 'b3', ['j0', 'j1'])
        state = _resolve(mgr, 'b3')
        self.assertEqual(state['status'], 'completed_with_errors')
        self.assertEqual(_pages_for(state['failedPages'], 'docA'), [1])
        self.assertEqual(_pages_for(state['missingPages'], 'docA'), [])
        self.assertEqual(jm.get_job('j1')['status'], 'failed')

    # Case 4: 部分成功 + 其余超时 → completed_with_errors + failedPages
    def test_case4_partial_success_with_timeouts(self):
        jobs = {
            'j0': _job('j0', 'success', 0, 3),
            'j1': _job('j1', 'running', 1, 3, started_at=STALE_TS),
            'j2': _job('j2', 'running', 2, 3, started_at=STALE_TS),
        }
        mgr, jm = _build(jobs, 'b4', ['j0', 'j1', 'j2'])
        state = _resolve(mgr, 'b4')
        self.assertEqual(state['status'], 'completed_with_errors')
        self.assertEqual(_pages_for(state['failedPages'], 'docA'), [1, 2])
        self.assertEqual(_pages_for(state['missingPages'], 'docA'), [])
        self.assertEqual(jm.get_job('j1')['status'], 'failed')
        self.assertEqual(jm.get_job('j2')['status'], 'failed')

    # Case 5: 全部超时 → failed（failed_pages == expected_pages）
    def test_case5_all_timeout_to_failed(self):
        jobs = {
            'j0': _job('j0', 'running', 0, 3, started_at=STALE_TS),
            'j1': _job('j1', 'running', 1, 3, started_at=STALE_TS),
            'j2': _job('j2', 'running', 2, 3, started_at=STALE_TS),
        }
        mgr, jm = _build(jobs, 'b5', ['j0', 'j1', 'j2'])
        state = _resolve(mgr, 'b5')
        self.assertEqual(state['status'], 'failed')
        self.assertEqual(_pages_for(state['failedPages'], 'docA'), [0, 1, 2])
        self.assertEqual(_pages_for(state['missingPages'], 'docA'), [])
        self.assertEqual(jm.get_job('j0')['status'], 'failed')

    # Case 6: cancel 优先 → cancelled，stale job 不被翻 failed
    def test_case6_cancel_priority_over_timeout(self):
        jobs = {
            'j0': _job('j0', 'running', 0, 2, started_at=STALE_TS),
            'j1': _job('j1', 'success', 1, 2),
        }
        mgr, jm = _build(jobs, 'b6', ['j0', 'j1'], status='cancelled')
        state = _resolve(mgr, 'b6')
        self.assertEqual(state['status'], 'cancelled')
        # cancel 必须停止 watchdog：stale running job 不应被翻成 failed
        self.assertEqual(jm.get_job('j0')['status'], 'running')

    # Case 7: 正常完成（terminal 且 created_at 旧）不受 timeout 改写 → completed
    def test_case7_terminal_success_not_rewritten_by_timeout(self):
        jobs = {
            'j0': _job('j0', 'success', 0, 3, created_at=STALE_TS),
            'j1': _job('j1', 'success', 1, 3, created_at=STALE_TS),
            'j2': _job('j2', 'success', 2, 3, created_at=STALE_TS),
        }
        mgr, jm = _build(jobs, 'b7', ['j0', 'j1', 'j2'])
        state = _resolve(mgr, 'b7')
        self.assertEqual(state['status'], 'completed')
        self.assertEqual(_pages_for(state['missingPages'], 'docA'), [])
        self.assertEqual(_pages_for(state['failedPages'], 'docA'), [])


if __name__ == '__main__':
    unittest.main()
