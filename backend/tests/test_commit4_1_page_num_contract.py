# -*- coding: utf-8 -*-
"""
Commit 4.1 验收：批量导入 page_num 0-based 契约（B1 修复）

背景（ASSEMBLY_DRIFT_AUDIT.md §6 B1）：
  import_batch_manager._buffer_with_assembly 曾对 0-based 的 page_num 做
  `page_num - 1` 归一化（误当 1-based），导致同文档首两页在 PageResultStore 落同一
  key=0 互相覆盖，assembly 永不触发、首页数据丢失。

本测试**驱动真实生产代码路径**（_buffer_with_assembly，含曾被 -1 的那一层），
而非手工调 store.put 绕过归一化。这样假绿证明才有效：
  复现旧 `page_num - 1` 逻辑 → 两页撞 key=0 → get_pages 仅 1 页 → 断言失败。

运行：backend/venv/Scripts/python -m pytest tests/test_commit4_1_page_num_contract.py -q
"""
import os
import sys
import unittest
from unittest.mock import patch

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _BACKEND_DIR)

from import_batch_manager import ImportBatchManager
import page_result_store
from page_result_store import PageResultStore


class FakeJobManager:
    """极简 ParseJobManager 替身，只满足 ImportBatchManager.__init__ 所需。"""
    def __init__(self):
        self._cb = None
    def on_job_complete(self, callback):
        self._cb = callback


class _BatchStub:
    """_buffer_with_assembly 仅在 completed 分支访问 batch.assembled_documents；
    测试把 total_pages 设大，completed 永不为 True，故此处不被访问。"""
    def __init__(self):
        self.assembled_documents = []


def _feed(manager, store, bucket, src_doc_id, page_index, mark):
    """经真实 _buffer_with_assembly 喂一页（total_pages=5 ⇒ 不触发 assembly）。"""
    metrics = {
        # 前端批量路径：pageNum = page_index（0-based 字符串），与 _parse_page_info 约定一致
        'page_num': str(page_index),
        'total_pages': '5',
        'client_key': f'k{page_index}',
    }
    full_result = {'clientKey': '', 'invoice_number': 'X', 'amount': 1, '_mark': mark}
    db_record = {}
    # _buffer_with_assembly 内部 `from page_result_store import get_page_result_store`
    # 在调用时解析，patch 模块属性即可让其对隔离实例生效（避免污染全局单例）。
    with patch.object(page_result_store, 'get_page_result_store', return_value=store):
        manager._buffer_with_assembly(
            _BatchStub(), bucket, db_record, full_result, metrics, src_doc_id, bucket
        )


class TestCommit41PageNumContract(unittest.TestCase):
    def setUp(self):
        self.manager = ImportBatchManager(FakeJobManager())

    def test_zero_based_keys_keep_two_pages(self):
        store = PageResultStore()
        bucket = 'inst-commit4-1'
        src = 'src-commit4-1'
        _feed(self.manager, store, bucket, src, 0, 'page0')
        _feed(self.manager, store, bucket, src, 1, 'page1')

        pages = store.get_pages(bucket)
        self.assertEqual(len(pages), 2, "两页应独立落 store，不应碰撞合并为 1 页")
        # 顺序依赖 store key 正确性：页0 在前、页1 在后
        self.assertEqual(pages[0]['_mark'], 'page0')
        self.assertEqual(pages[1]['_mark'], 'page1')
        # store 内部 key 必须为 0-based {0, 1}，而非被 -1 压成 {0}（碰撞）
        self.assertSetEqual(set(store._store[bucket]['pages'].keys()), {0, 1})


if __name__ == '__main__':
    unittest.main()
