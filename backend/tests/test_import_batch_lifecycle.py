# -*- coding: utf-8 -*-
"""
Commit 5.1b-1（test-only：锁定 batch 终态页面健康分类契约，不实现业务）

目标：在 5.1b-2 实现 `_collect_batch_page_health()` 之前，先用测试把
LIFECYCLE_STATE_CONTRACT_5_1b0.md（§4.1 / §4.2 / §5 / §7）的 4 case 契约锁住。

当前 `_collect_batch_page_health` 不存在 → 本测试为红（AttributeError），
符合 5.1b-2 实现前的 test-first 纪律；5.1b-2 落地后转绿。

契约定锁（关键，来自设计冻结）：
- SUCCESS = JobStore job.status == 'success'   （权威来源，非 PageResultStore §4.1 注记）
- FAILED  = JobStore job.status == 'failed'
- MISSING = expected - success - failed         （expected = set(range(total_pages))）
- 优先级 FAILED > MISSING（failed 页绝不进 missingPages）
- failed 终态唯一条件：failed_pages == 全部 expected 页（failed_count == total），
  而非 success_count == 0

`_collect_batch_page_health(batch, job_manager)` 返回值约定（5.1b-2 实现此契约）：
    {
      'status':       'completed' | 'completed_with_errors' | 'failed',
      'missingPages': [{'sourceDocId': str, 'pages': [int, ...]}],
      'failedPages':  [{'sourceDocId': str, 'pages': [int, ...]}],
      'hasErrors':    bool,
      'allFailed':    bool,
    }
status 推导优先级（§5）：cancelled(外部) > failed(allFailed) > completed_with_errors(hasErrors) > completed

运行（backend 测试被 gitignore，需 -f 纳入）：
  backend/venv/Scripts/python -m pytest tests/test_import_batch_lifecycle.py -q
"""
import os
import sys
import unittest

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _BACKEND_DIR)

from import_batch_manager import ImportBatchManager, ImportBatch


class FakeJobManager:
    """极简 ParseJobManager 替身，仅满足 _collect_batch_page_health 所需接口。"""
    def __init__(self, jobs=None):
        self._jobs = jobs or {}

    def on_job_complete(self, callback):
        pass

    def get_job(self, job_id):
        return self._jobs.get(job_id)


def _job(job_id, status, page_num, total_pages, source_doc_id='docA', client_key=None):
    return {
        'status': status,
        'metrics': {
            'page_num': str(page_num),
            'total_pages': str(total_pages),
            'source_doc_id': source_doc_id,
            'client_key': client_key if client_key is not None else f'ck{page_num}',
        },
    }


def _batch(manager, batch_id, job_ids):
    batch = ImportBatch(
        id=batch_id,
        total=len(job_ids),
        status='running',
        job_ids=list(job_ids),
    )
    manager._batches[batch_id] = batch
    return batch


class TestBatchLifecycleHealth(unittest.TestCase):
    # ── Case 1：完整 → completed ──
    def test_complete_no_errors(self):
        jobs = {
            'j0': _job('j0', 'success', 0, 3),
            'j1': _job('j1', 'success', 1, 3),
            'j2': _job('j2', 'success', 2, 3),
        }
        mgr = ImportBatchManager(FakeJobManager(jobs))
        batch = _batch(mgr, 'b-complete', list(jobs.keys()))
        health = mgr._collect_batch_page_health(batch, mgr._job_manager)

        self.assertEqual(health['status'], 'completed')
        self.assertEqual(health['missingPages'], [])
        self.assertEqual(health['failedPages'], [])
        self.assertFalse(health['hasErrors'])
        self.assertFalse(health['allFailed'])

    # ── Case 2：缺页（page2 从未提交 job）→ completed_with_errors + missingPages ──
    def test_missing_page(self):
        jobs = {
            'j0': _job('j0', 'success', 0, 3),
            'j1': _job('j1', 'success', 1, 3),
            # 无 j2：page2 从未到达
        }
        mgr = ImportBatchManager(FakeJobManager(jobs))
        batch = _batch(mgr, 'b-missing', list(jobs.keys()))
        health = mgr._collect_batch_page_health(batch, mgr._job_manager)

        self.assertEqual(health['status'], 'completed_with_errors')
        self.assertEqual(health['missingPages'], [{'sourceDocId': 'docA', 'pages': [2]}])
        self.assertEqual(health['failedPages'], [])
        self.assertTrue(health['hasErrors'])
        self.assertFalse(health['allFailed'])

    # ── Case 3：worker fail（page2 抛错）→ completed_with_errors + failedPages（不进 missingPages）──
    def test_failed_page(self):
        jobs = {
            'j0': _job('j0', 'success', 0, 3),
            'j1': _job('j1', 'success', 1, 3),
            'j2': _job('j2', 'failed', 2, 3),
        }
        mgr = ImportBatchManager(FakeJobManager(jobs))
        batch = _batch(mgr, 'b-failed', list(jobs.keys()))
        health = mgr._collect_batch_page_health(batch, mgr._job_manager)

        self.assertEqual(health['status'], 'completed_with_errors')
        self.assertEqual(health['failedPages'], [{'sourceDocId': 'docA', 'pages': [2]}])
        self.assertEqual(health['missingPages'], [])  # failed 页绝不进 missingPages
        self.assertTrue(health['hasErrors'])
        self.assertFalse(health['allFailed'])

    # ── Case 4：全失败 → failed（不变 completed_with_errors）──
    def test_all_failed(self):
        jobs = {
            'j0': _job('j0', 'failed', 0, 3),
            'j1': _job('j1', 'failed', 1, 3),
            'j2': _job('j2', 'failed', 2, 3),
        }
        mgr = ImportBatchManager(FakeJobManager(jobs))
        batch = _batch(mgr, 'b-allfailed', list(jobs.keys()))
        health = mgr._collect_batch_page_health(batch, mgr._job_manager)

        self.assertEqual(health['status'], 'failed')
        self.assertEqual(health['failedPages'], [{'sourceDocId': 'docA', 'pages': [0, 1, 2]}])
        self.assertEqual(health['missingPages'], [])
        self.assertTrue(health['allFailed'])
        self.assertTrue(health['hasErrors'])


if __name__ == '__main__':
    unittest.main()
