# -*- coding: utf-8 -*-
"""
测试：PageResultStore + InvoiceAssemblyPipeline

验收 Case A-D，详见 Phase B 冻结验收标准。
"""

import sys
import os

# 确保 project root 和 backend 都在 sys.path 中
_root = os.path.join(os.path.dirname(__file__), '..', '..')
sys.path.insert(0, _root)
sys.path.insert(0, os.path.join(_root, 'backend'))

from page_result_store import PageResultStore
from invoice_assembly_pipeline import assemble


def _make_page(
    invoice_number: str,
    page_num: int,
    total_pages: int,
    line_items: list = None,
    total_amount: float = None,
) -> dict:
    """构造模拟页面解析结果"""
    result = {
        'invoice_number': invoice_number,
        'page_num': page_num,
        'total_pages': total_pages,
        'extra_fields': {
            'fphm': invoice_number,
        },
    }
    if line_items:
        result['extra_fields']['line_items'] = line_items
    if total_amount is not None:
        result['amount'] = total_amount
        result['extra_fields']['amountHj'] = total_amount
    return result


def assert_result(inv_no, items, amount, result):
    """验证组装结果"""
    ef = result.get('extra_fields', {})
    assert result.get('invoice_number') == inv_no, \
        f"期望 invoice_number={inv_no}, 实际={result.get('invoice_number')}"
    assert ef.get('line_items', []) == items, \
        f"期望 line_items={items}, 实际={ef.get('line_items')}"
    if amount is not None:
        assert result.get('amount') == amount, \
            f"期望 amount={amount}, 实际={result.get('amount')}"


# ═══════════════════════════════════════════
# Case A: 单页 → 1 InvoiceDocument
# ═══════════════════════════════════════════
def test_single_page():
    print("[Case A] 单页 → 1 InvoiceDocument")
    pages = [
        _make_page('001', 0, 1, ['A', 'B'], 100.0),
    ]
    results = assemble(pages)
    assert len(results) == 1, f"期望 1 个发票文档，实际 {len(results)}"
    assert_result('001', ['A', 'B'], 100.0, results[0])
    print("  ✅ PASS")


# ═══════════════════════════════════════════
# Case B: 三页同票 → 1 InvoiceDocument
# ═══════════════════════════════════════════
def test_three_pages_same_invoice():
    print("[Case B] 三页同票 → 1 InvoiceDocument")
    pages = [
        _make_page('001', 0, 3, ['A', 'B']),
        _make_page('001', 1, 3, ['C']),
        _make_page('001', 2, 3, ['D'], 200.0),
    ]
    results = assemble(pages)
    assert len(results) == 1, f"期望 1 个发票文档，实际 {len(results)}"
    assert_result('001', ['A', 'B', 'C', 'D'], 200.0, results[0])
    print("  ✅ PASS")


# ═══════════════════════════════════════════
# Case C: 三页三票 → 3 InvoiceDocuments
# ═══════════════════════════════════════════
def test_three_pages_three_invoices():
    print("[Case C] 三页三票 → 3 InvoiceDocuments")
    pages = [
        _make_page('001', 0, 3, ['A'], 10.0),
        _make_page('002', 1, 3, ['B'], 20.0),
        _make_page('003', 2, 3, ['C'], 30.0),
    ]
    results = assemble(pages)
    assert len(results) == 3, f"期望 3 个发票文档，实际 {len(results)}"
    assert_result('001', ['A'], 10.0, results[0])
    assert_result('002', ['B'], 20.0, results[1])
    assert_result('003', ['C'], 30.0, results[2])
    print("  ✅ PASS")


# ═══════════════════════════════════════════
# Case D: 混合（2页同票 + 1页单票）→ 2 InvoiceDocuments
# ═══════════════════════════════════════════
def test_mixed_pages():
    print("[Case D] 混合（2页同票 + 1页单票）→ 2 InvoiceDocuments")
    pages = [
        _make_page('001', 0, 2, ['A']),
        _make_page('001', 1, 2, ['B'], 50.0),
        _make_page('002', 0, 1, ['C'], 30.0),
    ]
    results = assemble(pages)
    assert len(results) == 2, f"期望 2 个发票文档，实际 {len(results)}"
    assert_result('001', ['A', 'B'], 50.0, results[0])
    assert_result('002', ['C'], 30.0, results[1])
    print("  ✅ PASS")


# ═══════════════════════════════════════════
# PageResultStore 单元测试
# ═══════════════════════════════════════════
def test_page_result_store():
    print("[PageResultStore 单元测试]")

    store = PageResultStore()

    # 存入第 0 页（共 3 页）→ 应返回 False（未收齐）
    r1 = store.put('doc001', 0, 3, {'page': 0, 'data': 'p0'})
    assert r1 is False, "存入第 0 页应返回 False（未收齐）"
    assert store.is_completed('doc001') is False

    # 存入第 1 页 → 仍 False
    r2 = store.put('doc001', 1, 3, {'page': 1, 'data': 'p1'})
    assert r2 is False

    # 存入第 2 页（最后一页）→ 返回 True（已收齐）
    r3 = store.put('doc001', 2, 3, {'page': 2, 'data': 'p2'})
    assert r3 is True
    assert store.is_completed('doc001') is True

    # 验证 get_pages 按序返回
    pages = store.get_pages('doc001')
    assert pages is not None
    assert len(pages) == 3
    assert pages[0]['page'] == 0
    assert pages[1]['page'] == 1
    assert pages[2]['page'] == 2

    # 验证 get_all_completed
    completed = store.get_all_completed()
    assert 'doc001' in completed

    # 验证 remove
    store.remove('doc001')
    assert store.get_pages('doc001') is None
    assert store.is_completed('doc001') is False

    # 验证 size / clear
    store.put('doc002', 0, 1, {'data': 'single'})
    assert store.size == 1
    store.clear()
    assert store.size == 0

    print("  ✅ PASS")


if __name__ == '__main__':
    test_page_result_store()
    test_single_page()
    test_three_pages_same_invoice()
    test_three_pages_three_invoices()
    test_mixed_pages()
    print("\n🎉 全部测试通过")
