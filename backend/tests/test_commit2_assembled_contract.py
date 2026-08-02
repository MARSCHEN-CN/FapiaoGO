# -*- coding: utf-8 -*-
"""
Commit 2 验收：assembled_documents 契约补全的单测

锁定两条业务规则（用户两次强调「不要默认」）：
  1. amount = 末页业务真源（merge_page_results: merged['amount'] =
     last.extra_fields.amountHj or last.amount），不是全页求和。
     合成 fixture page1=1000/page2=300 → 300；若末页含 amountHj=350，则取 350
     （amountHj 优先于原始 amount）。
  2. invoiceDate = 首页开票日期（_FIRST_PAGE_KEYS 含 kprq；续页缺失不覆盖首页）。
  3. page_client_keys：assemble 显式声明每个 InvoiceDocument 的精确页面成员
     （前端 clientKey 列表），顺序与页码一致。
"""

import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from multi_page_merge import merge_page_results
from invoice_assembly_pipeline import assemble


def _page(num, amount, client_key, kprq='', fphm='A'):
    return {
        'invoice_number': fphm,
        'amount': amount,
        'page_num': num,
        'clientKey': client_key,
        'extra_fields': {'fphm': fphm, 'kprq': kprq, 'line_items': []},
    }


class TestMergeAmountPolicy(unittest.TestCase):
    """金额来源：末页金额，而非求和。"""

    def test_amount_is_last_page_not_sum(self):
        merged = merge_page_results([
            {'invoice_number': 'A', 'amount': 1000,
             'extra_fields': {'fphm': 'A', 'kprq': '2026-01-01'}},
            {'invoice_number': 'A', 'amount': 300,
             'extra_fields': {'kprq': '', 'line_items': []}},
        ])
        # 关键回归锁：若是求和会得到 1300，这是错的；正确是末页 300
        self.assertEqual(merged.get('amount'), 300)

    def test_amount_hj_preferred_over_raw_amount(self):
        # 领域事实：amount 是 OCR 初始结果；amountHj 是金额提取器校验后的真价税合计。
        # 合并金额取「末页 amountHj 优先，回退末页 amount」，而非末页原始 amount / 求和。
        merged = merge_page_results([
            {'invoice_number': 'A', 'amount': 1000,
             'extra_fields': {'fphm': 'A', 'kprq': '2026-01-01', 'amountHj': 1100}},
            {'invoice_number': 'A', 'amount': 300,
             'extra_fields': {'kprq': '', 'line_items': [], 'amountHj': 350}},
        ])
        # 末页 amountHj=350 优先；不应是 300（末页原始）、1300/1450（求和）
        self.assertEqual(merged.get('amount'), 350)

    def test_invoice_date_is_first_page(self):
        merged = merge_page_results([
            {'invoice_number': 'A', 'amount': 1000,
             'extra_fields': {'fphm': 'A', 'kprq': '2026-01-01'}},
            {'invoice_number': 'A', 'amount': 300,
             'extra_fields': {'kprq': '', 'line_items': []}},
        ])
        # 续页无开票日期时，保留首页日期
        self.assertEqual(merged.get('invoice_date'), '2026-01-01')

    def test_single_page_amount_unchanged(self):
        merged = merge_page_results([{'invoice_number': 'A', 'amount': 777,
                                      'extra_fields': {'fphm': 'A'}}])
        self.assertEqual(merged.get('amount'), 777)


class TestAssemblePageClientKeys(unittest.TestCase):
    """assemble 显式声明页面成员（page_client_keys）。"""

    def test_page_client_keys_declared_in_order(self):
        pages = [
            _page(1, 1000, 'k1', kprq='2026-01-01'),
            _page(2, 300, 'k2'),
        ]
        docs = assemble(pages)
        self.assertEqual(len(docs), 1, '同票两页应聚为一个文档')
        self.assertEqual(
            docs[0].get('_assembly', {}).get('page_client_keys'),
            ['k1', 'k2'],
        )

    def test_amount_and_invoice_date_on_doc(self):
        pages = [
            _page(1, 1000, 'k1', kprq='2026-01-01'),
            _page(2, 300, 'k2'),
        ]
        docs = assemble(pages)
        self.assertEqual(docs[0].get('amount'), 300)          # 末页金额
        self.assertEqual(docs[0].get('invoice_date'), '2026-01-01')  # 首页日期


if __name__ == '__main__':
    unittest.main()
