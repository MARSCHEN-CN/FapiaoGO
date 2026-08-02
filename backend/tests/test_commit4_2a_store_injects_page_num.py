# -*- coding: utf-8 -*-
"""
Commit 4.2a 验收：PageResultStore 在边界注入 page_num（修复 B2）

测试纪律（用户裁决）：
    旧测试（test_invoice_assembly.py / test_commit2_assembled_contract.py）手工在 fixture
    里注入 'page_num'，绕过了 store 的真实传输 —— 这是假绿：production parse_result
    实际不带 page_num，assemble 会把每页拆成单页发票，但那些测试永远发现不了。

    本测试走真实链路：
        raw parse result（不带 page_num）
            → PageResultStore.put（store 注入 page_num）
            → get_pages
            → assemble
    断言：
        1) get_pages 返回的每页都带 store 注入的 page_num，顺序正确
        2) 原始 parse_result 未被 store 污染（store 复制而非原地改）
        3) assemble 据此把 3 页同票聚成 1 个 InvoiceDocument，明细按序合并

假绿证明：临时还原 store（不注入 page_num）→
    get_pages 返回的页面无 page_num → _page_num_key 退化到默认 0 →
    assemble 把 3 页拆成 3 个文档 → 断言 len(docs)==1 失败 → 还原修复 → 重新 PASS。
"""

import sys
import os
import unittest

_root = os.path.join(os.path.dirname(__file__), '..', '..')
sys.path.insert(0, _root)
sys.path.insert(0, os.path.join(_root, 'backend'))

from page_result_store import PageResultStore
from invoice_assembly_pipeline import assemble


def _raw_page(invoice_number, line_items, amount=None):
    """模拟 production parse_invoice_service 的单页返回（不带 page_num）。"""
    ef = {'fphm': invoice_number, 'line_items': list(line_items)}
    if amount is not None:
        ef['amountHj'] = amount
    result = {'invoice_number': invoice_number, 'extra_fields': ef}
    if amount is not None:
        result['amount'] = amount
    return result


class TestStoreInjectsPageNum(unittest.TestCase):
    """真实链路：page_num 必须来自 Store，而非 fixture。"""

    def test_store_injects_page_num_and_assembles(self):
        # 三个 raw payload：注意都不带 page_num（模拟 production 实况）
        raw0 = _raw_page('001', ['A', 'B'])
        raw1 = _raw_page('001', ['C'])
        raw2 = _raw_page('001', ['D'], amount=200.0)

        store = PageResultStore()
        # 0-based bucket 写入，与生产 /split_pdf → ImportBatchManager 契约一致
        store.put('doc001', 0, 3, raw0)
        store.put('doc001', 1, 3, raw1)
        store.put('doc001', 2, 3, raw2)

        pages = store.get_pages('doc001')
        self.assertIsNotNone(pages)
        self.assertEqual(len(pages), 3)

        # B2 核心：page_num 由 store 注入，而非来自 fixture
        self.assertEqual(pages[0].get('page_num'), 0)
        self.assertEqual(pages[1].get('page_num'), 1)
        self.assertEqual(pages[2].get('page_num'), 2)

        # store 复制而非原地改：原始对象不应被污染
        self.assertNotIn('page_num', raw0)
        self.assertNotIn('page_num', raw1)
        self.assertNotIn('page_num', raw2)

        # 真实链路终点：assemble 据注入的 page_num 把 3 页同票聚成 1 个文档
        docs = assemble(pages)
        self.assertEqual(len(docs), 1, '3 页同票应聚为 1 个 InvoiceDocument')
        ef = docs[0].get('extra_fields', {})
        self.assertEqual(ef.get('line_items'), ['A', 'B', 'C', 'D'])
        self.assertEqual(docs[0].get('amount'), 200.0)

    def test_store_injects_page_num_for_two_page_doc(self):
        raw0 = _raw_page('002', ['X'])
        raw1 = _raw_page('002', ['Y'], amount=99.0)

        store = PageResultStore()
        store.put('doc002', 0, 2, raw0)
        store.put('doc002', 1, 2, raw1)

        pages = store.get_pages('doc002')
        self.assertEqual(pages[0].get('page_num'), 0)
        self.assertEqual(pages[1].get('page_num'), 1)

        docs = assemble(pages)
        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0].get('extra_fields', {}).get('line_items'), ['X', 'Y'])


if __name__ == '__main__':
    unittest.main()
