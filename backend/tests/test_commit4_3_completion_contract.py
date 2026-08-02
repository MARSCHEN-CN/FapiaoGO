# -*- coding: utf-8 -*-
"""Commit 4.3 测试：PageResultStore 完成判定 (B4) 与 total_pages 一致性 (B5)。

走真实 store.put 链路（非手工构造 entry），断言：
- B4：完成 = 所有期望页码都收到（expected <= received），而非 len >= total
      （避免「数量够了但缺中间页」的伪完成，如 page0/page1/page3, total=3 缺 page2）
- B5：total_pages 首次声明锁定 + 冲突告警，禁止末写覆盖导致伪完成
"""
import unittest

import page_result_store
from page_result_store import PageResultStore


def _raw():
    """模拟 production parse_result：不带 page_num/page_index（B2 由 store 边界注入）。"""
    return {
        'invoice_number': 'NO123',
        'extra_fields': {},
        'amount': '100.00',
    }


class TestCommit43CompletionContract(unittest.TestCase):

    def test_b4_missing_middle_page_not_complete(self):
        """B4：page0/page1/page3（total=3）数量已够，但缺 page2 → 不得判定完成。"""
        store = PageResultStore()
        self.assertFalse(store.put('doc', 0, 3, _raw()))
        self.assertFalse(store.put('doc', 1, 3, _raw()))
        # 关键：旧逻辑 len(pages)=3 >= 3 会误判完整；新逻辑检测到缺 page2
        self.assertFalse(store.put('doc', 3, 3, _raw()))
        self.assertFalse(store.is_completed('doc'))
        self.assertEqual(store.get_missing_pages('doc'), {2})
        self.assertEqual(store.get_all_completed(), [])

    def test_b4_all_pages_present_is_complete(self):
        """B4 正向：page0/page1/page2 齐备 → 完成，missing 为空。"""
        store = PageResultStore()
        self.assertFalse(store.put('doc', 0, 3, _raw()))
        self.assertFalse(store.put('doc', 1, 3, _raw()))
        self.assertTrue(store.put('doc', 2, 3, _raw()))
        self.assertTrue(store.is_completed('doc'))
        self.assertEqual(store.get_missing_pages('doc'), set())

    def test_b5_total_pages_first_write_locked_with_warning(self):
        """B5：首报 total=2 锁定；后续误报 total=3 冲突 → 告警且不得覆盖（锁定语义下应为完成）。"""
        store = PageResultStore()
        store.put('doc', 0, 2, _raw())  # 首次声明锁定 total=2
        with self.assertLogs(page_result_store.logger, level='WARNING') as cm:
            store.put('doc', 1, 3, _raw())  # 冲突：某页误报 total=3
        self.assertTrue(any('total_pages' in r for r in cm.output))
        # 锁定语义：期望 {0,1} 已齐 → 完成；若被覆盖为 3 则 received={0,1} 不完整 → False
        self.assertTrue(store.is_completed('doc'))


if __name__ == '__main__':
    unittest.main()
