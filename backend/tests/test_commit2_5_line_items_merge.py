# -*- coding: utf-8 -*-
"""
Commit 2.5 契约测试：InvoiceAssembly 多页明细完整性

修复：multi_page_merge._APPEND_KEYS 增加 'line_items_excel_rows'，
使多页发票的「字符级/OCR 明细通路」(grid_to_excel_rows 产出) 在所有页拼接，
而非仅取第一页。否则下游 _db_record_to_export 因 excel_rows 非空而跳过 line_items，
导致后续页明细与税率（含免税）全部丢失。

边界锁定（用户要求的三项验证）：
  1. 来源优先级：line_items 与 line_items_excel_rows 均为「所有页 append」；
     line_items_excel_rows 是导出权威源（app.py:_db_record_to_export 优先级：
     manual_corrections.line_items > line_items_excel_rows > 传统 line_items）。
  2. 真实 fixture：模拟 parse_invoice_service 输出（extra_fields 中英文键并存），
     验证 parse result → merge_page_results / assemble → merged 链路。
  3. 不变量：len(merged line_items_excel_rows) == Σ各页行数；顺序 = 页码序（用户可见）。
"""

import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from multi_page_merge import merge_page_results
from invoice_assembly_pipeline import assemble


# ── 真实 parser 输出形状（取自 field_extractor / app.py:_EXCEL_KEY_MAP / _ITEM_MAP）──

def _row(name, qty, amount, tax_rate, tax):
    # line_items_excel_rows：字符级/OCR 通路，中文键（grid_to_excel_rows 产出）
    return {
        '项目名称': name, '规格型号': '', '单位': '个',
        '数量': qty, '单价': '', '金额': amount,
        '税率/征收率': tax_rate, '税额': tax,
    }


def _item(name, qty, amount, tax_rate, tax):
    # line_items：传统提取器，英文/简写键（slv 存税率）
    return {
        'name': name, 'quantity': qty, 'amount': amount,
        'slv': tax_rate, 'tax': tax,
    }


def _page(num, fphm, kprq, line_items, excel_rows, amount, client_key):
    return {
        'invoice_number': fphm,
        'amount': amount,
        'page_num': num,
        'clientKey': client_key,
        'extra_fields': {
            'fphm': fphm,
            'kprq': kprq,
            'type': '增值税电子专用发票',
            'line_items': line_items,
            'line_items_excel_rows': excel_rows,
        },
    }


class TestLineItemsExcelRowsMerge(unittest.TestCase):
    """多页 line_items_excel_rows 拼接完整性（核心回归锁）"""

    def test_excel_rows_appended_across_all_pages(self):
        # 真实情形：每页都产出 line_items 与 line_items_excel_rows（提取器+字符级双通路）
        p1 = _page(1, 'A', '2026-01-01',
                   [_item('商品A', '2', '20', '13%', '2.6'),
                    _item('商品B', '1', '10', '13%', '1.3')],
                   [_row('商品A', '2', '20', '13%', '2.6'),
                    _row('商品B', '1', '10', '13%', '1.3')],
                   1000, 'k1')
        p2 = _page(2, 'A', '',
                   [_item('商品C', '3', '30', '13%', '3.9'),
                    _item('商品D', '1', '15', '13%', '1.95')],
                   [_row('商品C', '3', '30', '13%', '3.9'),
                    _row('商品D', '1', '15', '13%', '1.95')],
                   300, 'k2')
        merged = merge_page_results([p1, p2])
        ef = merged['extra_fields']

        # 不变量 3：两页各 2 行 → 共 4 行
        self.assertEqual(len(ef['line_items_excel_rows']), 4)
        self.assertEqual(len(ef['line_items']), 4)
        # 顺序 = 页码序（用户可见输出）
        self.assertEqual([r['项目名称'] for r in ef['line_items_excel_rows']],
                         ['商品A', '商品B', '商品C', '商品D'])
        # 末页金额（与 Commit 2 规则一致：末页金额，非求和）
        self.assertEqual(merged['amount'], 300)

    def test_page2_excel_rows_not_lost_when_page1_absent(self):
        # 边界：page1 仅传统 line_items（无 excel_rows），page2 仅 OCR 通路产出 excel_rows。
        # 旧逻辑（line_items_excel_rows 不在 _APPEND_KEYS）会把它当「未分类」取首页 → []，
        # 导致 page2 明细在导出时被 line_items 覆盖而丢失。新逻辑必须保留 page2 的 2 行。
        p1 = _page(1, 'B', '2026-02-01',
                   [_item('商品E', '5', '50', '9%', '4.5')], [], 800, 'k1')
        p2 = _page(2, 'B', '',
                   [],
                   [_row('商品F', '2', '40', '9%', '3.6'),
                    _row('商品G', '1', '20', '9%', '1.8')],
                   200, 'k2')
        merged = merge_page_results([p1, p2])
        ef = merged['extra_fields']

        # page2 的 OCR 明细必须保留（回归锁：旧代码此处为 0）
        self.assertEqual(len(ef['line_items_excel_rows']), 2)
        self.assertEqual([r['项目名称'] for r in ef['line_items_excel_rows']],
                         ['商品F', '商品G'])
        # 传统 line_items 仍仅首页（page2 无传统提取）→ 不要求拼接，但也不应丢
        self.assertEqual(len(ef['line_items']), 1)
        self.assertEqual(ef['line_items'][0]['name'], '商品E')

    def test_assemble_pipeline_forwards_merged_excel_rows(self):
        # 链路验证：parse result → assemble(InvoiceAssembly) → merged InvoiceDocument
        p1 = _page(1, 'C', '2026-03-01',
                   [_item('商品H', '1', '11', '6%', '0.66')],
                   [_row('商品H', '1', '11', '6%', '0.66')], 500, 'k1')
        p2 = _page(2, 'C', '',
                   [_item('商品I', '1', '12', '6%', '0.72')],
                   [_row('商品I', '1', '12', '6%', '0.72')], 100, 'k2')
        docs = assemble([p1, p2])
        self.assertEqual(len(docs), 1, '同票两页应聚为一个 InvoiceDocument')
        ef = docs[0]['extra_fields']

        # 不变量：assemble 内部的 merge 已聚合所有页
        self.assertEqual(len(ef['line_items_excel_rows']), 2)
        self.assertEqual([r['项目名称'] for r in ef['line_items_excel_rows']],
                         ['商品H', '商品I'])
        # 导出权威源非空 → _db_record_to_export 会走 excel_rows 分支（不丢税率）
        self.assertTrue(ef['line_items_excel_rows'])


if __name__ == '__main__':
    unittest.main()
