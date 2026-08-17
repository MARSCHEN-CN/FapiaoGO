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
    """构造模拟页面解析结果

    同时提供两条页码标记路径：
    - raw_text 中的「共N页 第M页」字符串（贴近真实 OCR 路径）
    - 顶层 page_num / total_pages（结构化回退）
    page_num 为 0 基索引，raw_text 中的第M页为 1 基。
    """
    current_marker = page_num + 1
    result = {
        'invoice_number': invoice_number,
        'page_num': page_num,
        'total_pages': total_pages,
        # 真实 OCR 场景 raw_text 中会出现「共N页 第M页」标记
        'raw_text': f'购买方信息\n共{total_pages}页 第{current_marker}页\n销售方信息',
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
#   - 001 有第 1、3 页标记（共 3 页，非连续但首尾证据齐全 → 合并）
#   - 002 单页 → 拆分
# ═══════════════════════════════════════════
def test_mixed_pages():
    print("[Case D] 混合（非连续2页同票 + 1页单票）→ 2 InvoiceDocuments")
    pages = [
        _make_page('001', 0, 3, ['A']),        # 第 1 页 (共 3 页)
        _make_page('001', 2, 3, ['B'], 50.0),  # 第 3 页 (共 3 页) ← 末页证据
        _make_page('002', 2, 3, ['C'], 30.0),  # 不同发票号 → 独立文档
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


# ═══════════════════════════════════════════
# Case E: extra_fields 缺失/None 契约（2026-08-17 P0 回归）
#   真实故障：OFD 数据缺失时 invoice_service 返回 extra_fields=None，
#   assemble 日志行 `merged.get('extra_fields', {}).get('line_items', [])`
#   因 dict.get 对「key 存在但值为 None」返回 None 而崩溃（AttributeError）。
#   契约：extra_fields 缺失 / None / {} / line_items=None 均不得让 Assembly 崩溃。
# ═══════════════════════════════════════════

def _make_ofd_degraded_page(extra_fields):
    """构造 OFD 数据缺失的模拟页面（text 为空、无字段提取）"""
    return {
        'invoice_number': '未知号码',
        'invoice_type': '其他',
        'amount': '0.00',
        'invoice_date': '未知日期',
        'raw_text': '',
        'extra_fields': extra_fields,  # 可能是 None / {} / 带 line_items 的 dict
        'file_format': 'ofd',
        'parse_method': 'OFD 解析（数据缺失）',
        'page_num': 0,
        'total_pages': 1,
    }


def test_assembly_extra_fields_none():
    """真实故障 reproducer：extra_fields=None → Assembly 必须成功"""
    results = assemble([_make_ofd_degraded_page(None)])
    assert len(results) == 1, f"期望 1 个发票文档，实际 {len(results)}"
    assert results[0].get('extra_fields') is None or \
        results[0].get('extra_fields', {}).get('line_items', []) == []
    print("  ✅ PASS")


def test_assembly_extra_fields_empty_dict():
    """extra_fields={} → Assembly 成功"""
    results = assemble([_make_ofd_degraded_page({})])
    assert len(results) == 1, f"期望 1 个发票文档，实际 {len(results)}"
    print("  ✅ PASS")


def test_assembly_extra_fields_line_items_none():
    """extra_fields={'line_items': None} → Assembly 成功"""
    results = assemble([_make_ofd_degraded_page({'line_items': None})])
    assert len(results) == 1, f"期望 1 个发票文档，实际 {len(results)}"
    print("  ✅ PASS")


def test_assembly_extra_fields_line_items_empty():
    """extra_fields={'line_items': []} → Assembly 成功"""
    results = assemble([_make_ofd_degraded_page({'line_items': []})])
    assert len(results) == 1, f"期望 1 个发票文档，实际 {len(results)}"
    print("  ✅ PASS")


def test_assembly_extra_fields_line_items_preserved():
    """extra_fields={'line_items': [...]} → 行项目正常保留"""
    items = [{'name': '香料原料*迷迭香', 'qty': '1'}, {'name': '水果*苹果', 'qty': '2'}]
    results = assemble([_make_ofd_degraded_page({'line_items': items})])
    assert len(results) == 1, f"期望 1 个发票文档，实际 {len(results)}"
    assert results[0].get('extra_fields', {}).get('line_items') == items, \
        "行项目应原样保留"
    print("  ✅ PASS")


if __name__ == '__main__':
    test_page_result_store()
    test_single_page()
    test_three_pages_same_invoice()
    test_three_pages_three_invoices()
    test_mixed_pages()
    test_assembly_extra_fields_none()
    test_assembly_extra_fields_empty_dict()
    test_assembly_extra_fields_line_items_none()
    test_assembly_extra_fields_line_items_empty()
    test_assembly_extra_fields_line_items_preserved()
    print("\n🎉 全部测试通过")
