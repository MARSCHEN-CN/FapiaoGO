# -*- coding: utf-8 -*-
"""
Commit 5.1b-3a-0（test-only：锁定 backend contract exposure 契约，不实现业务）

目标：在 5.1b-3a 实现「SSE / results 输出 completed_with_errors + missingPages/failedPages」
之前，先用测试把 LIFECYCLE_STATE_CONTRACT_5_1b0.md §3 / §6 的暴露契约锁住。

当前 get_batch_dict 不暴露 missingPages/failedPages、get_batch_results 仍返回扁平 list
→ 本测试为红（KeyError / TypeError），符合 5.1b-3a 实现前的 test-first 纪律；
5.1b-3a 落地后转绿。

契约定锁（来自设计冻结 §3 / §6）：
- SSE（get_batch_dict → to_dict）：
    completed_with_errors / failed / cancelled 终态须携带 missingPages / failedPages；
    completed 须保持旧 payload（不强行新增空字段，向后兼容旧 SSE 消费者）。
- results（get_batch_results）：
    返回 batch-level {items, documents, status, missingPages, failedPages}，
    missingPages/failedPages 按 sourceDocId 归组，不塞进每个 invoice item。

页面健康分类权威源 = JobStore（5.1b-2 _collect_batch_page_health 已锁），本测试只验证
「暴露层」是否把健康信息正确呈现，不重复验证分类逻辑。

运行（backend/tests 被 gitignore，需 -f 纳入）：
  backend/venv/Scripts/python -m pytest tests/test_import_batch_contract_exposure.py -q
"""
import os
import sys
import unittest

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _BACKEND_DIR)

from import_batch_manager import ImportBatchManager, ImportBatch


class FakeJobManager:
    """极简 ParseJobManager 替身，仅满足 get_batch_dict / get_batch_results 所需接口。"""
    def __init__(self, jobs=None):
        self._jobs = jobs or {}

    def on_job_complete(self, callback):
        pass

    def get_job(self, job_id):
        return self._jobs.get(job_id)

    def get_job_result(self, job_id):
        # 暴露测试只关心健康归组，不依赖 per-page 解析结果体
        return None


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


def _batch(manager, batch_id, job_ids, status='completed'):
    batch = ImportBatch(
        id=batch_id,
        total=len(job_ids),
        status=status,
        job_ids=list(job_ids),
    )
    manager._batches[batch_id] = batch
    return batch


class TestBatchContractExposure(unittest.TestCase):
    # ── Case A（暴露部分）：completed_with_errors → SSE dict 暴露缺页 ──
    def test_sse_dict_exposes_error_pages_when_completed_with_errors(self):
        jobs = {
            'j0': _job('j0', 'success', 0, 3),
            'j1': _job('j1', 'success', 1, 3),
            # 无 j2：page2 从未到达
        }
        mgr = ImportBatchManager(FakeJobManager(jobs))
        batch = _batch(mgr, 'b-cwe', list(jobs.keys()), status='completed_with_errors')
        state = mgr.get_batch_dict(batch.id)

        self.assertEqual(state['status'], 'completed_with_errors')
        self.assertEqual(state['missingPages'], [{'sourceDocId': 'docA', 'pages': [2]}])
        self.assertEqual(state['failedPages'], [])

    # ── Case C：completed → SSE dict 保持旧 payload（不污染旧客户端）──
    def test_sse_dict_omits_error_fields_when_completed(self):
        jobs = {
            'j0': _job('j0', 'success', 0, 3),
            'j1': _job('j1', 'success', 1, 3),
            'j2': _job('j2', 'success', 2, 3),
        }
        mgr = ImportBatchManager(FakeJobManager(jobs))
        batch = _batch(mgr, 'b-comp', list(jobs.keys()), status='completed')
        state = mgr.get_batch_dict(batch.id)

        self.assertEqual(state['status'], 'completed')
        self.assertNotIn('missingPages', state)
        self.assertNotIn('failedPages', state)

    # ── Case B：results 返回 batch-level 健康（缺页）──
    def test_results_exposes_batch_health_with_missing(self):
        jobs = {
            'j0': _job('j0', 'success', 0, 3),
            'j1': _job('j1', 'success', 1, 3),
        }
        mgr = ImportBatchManager(FakeJobManager(jobs))
        batch = _batch(mgr, 'b-res-miss', list(jobs.keys()), status='completed_with_errors')
        result = mgr.get_batch_results(batch.id)

        self.assertEqual(result['status'], 'completed_with_errors')
        self.assertEqual(result['missingPages'], [{'sourceDocId': 'docA', 'pages': [2]}])
        self.assertEqual(result['failedPages'], [])
        # per-page 与 assembled 文档仍透传（hydration 需要）
        self.assertIn('items', result)
        self.assertIn('documents', result)

    # ── Case B（失败页变体）：results 暴露 failedPages 且不进 missingPages ──
    def test_results_exposes_failed_pages(self):
        jobs = {
            'j0': _job('j0', 'success', 0, 3),
            'j1': _job('j1', 'success', 1, 3),
            'j2': _job('j2', 'failed', 2, 3),
        }
        mgr = ImportBatchManager(FakeJobManager(jobs))
        batch = _batch(mgr, 'b-res-fail', list(jobs.keys()), status='completed_with_errors')
        result = mgr.get_batch_results(batch.id)

        self.assertEqual(result['failedPages'], [{'sourceDocId': 'docA', 'pages': [2]}])
        self.assertEqual(result['missingPages'], [])


if __name__ == '__main__':
    unittest.main()
