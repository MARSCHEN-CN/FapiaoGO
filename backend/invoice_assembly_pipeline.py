# -*- coding: utf-8 -*-
"""
InvoiceAssemblyPipeline — 页面结果 → 发票文档组装管道

职责（单一）：
    将同一 source_doc_id 的页面解析结果按 invoice_number 分组，
    调用 merge_page_results 组装为 InvoiceDocument，提供 DB 记录转换。

数据契约（冻结）：
    ┌─────────────────────────────────────────────────────────────┐
    │ parse_invoice_service 返回格式                               │
    │   - invoice_number / invoice_type / invoice_date / amount    │
    │   - extra_fields: { fphm, line_items, gmfmc, ... }          │
    │   - file_format / parse_method / ...                        │
    └──────────────────────────┬──────────────────────────────────┘
                               │
                               ↓
    ┌─────────────────────────────────────────────────────────────┐
    │ InvoiceDocument (assemble 返回)                              │
    │   同 parse_invoice_service 返回结构 + _assembly 元信息         │
    │   但字段已按首页/全页/末页合并                                  │
    └──────────────────────────┬──────────────────────────────────┘
                               │
                               ↓
    ┌─────────────────────────────────────────────────────────────┐
    │ db_record (invoice_document_to_db_record 产出)               │
    │   扁平化字段，用于 upsert_invoice                             │
    └─────────────────────────────────────────────────────────────┘
"""

import logging
from typing import List, Dict, Any, Optional
from collections import defaultdict

from multi_page_merge import merge_page_results

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════
# 数据契约
# ═══════════════════════════════════════════

# PageParseResult: parse_invoice_service 对单页的完整返回结果
#   必需字段：extra_fields（含 fphm、line_items 等）
#   可选字段：invoice_number, amount, invoice_date, file_format, ...

# InvoiceDocument: assemble 的输出，同 parse_invoice_service 返回结构
#   但字段已按首页/全页/末页策略合并
#   额外字段：_assembly { invoice_number, page_count, pages_assembled }


# ═══════════════════════════════════════════
# 内部工具函数
# ═══════════════════════════════════════════

def _resolve_invoice_number(result: Dict[str, Any]) -> str:
    """从解析结果中提取发票号码

    优先从 extra_fields.fphm 获取，回退到顶层 invoice_number。
    """
    ef = result.get('extra_fields') or {}
    no = ef.get('fphm') or result.get('invoice_number') or ''
    return str(no).strip()


def _sort_pages(pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """按 page_num 排序"""
    def page_sort_key(p):
        return (
            p.get('page_num') or
            p.get('page_index') or
            0
        )
    return sorted(pages, key=page_sort_key)


# ═══════════════════════════════════════════
# 核心函数
# ═══════════════════════════════════════════

def assemble(pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """将页面解析结果组装为发票文档列表

    输入契约（PageParseResult）：
        每项为 parse_invoice_service 对单页的完整返回结果。
        必须有 extra_fields（含 line_items）。
        应有 invoice_number 或 extra_fields.fphm。

    输出契约（InvoiceDocument）：
        同 parse_invoice_service 返回结构（已合并）。
        多页情况：首页身份字段 + 全页明细 + 末页金额。
        单页情况：直接透传。
    """
    if not pages:
        return []

    # ── 1. 按 invoice_number 分组 ──
    groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

    for page in pages:
        inv_no = _resolve_invoice_number(page)
        if not inv_no:
            inv_no = f"__no_inv_{page.get('page_num', id(page))}__"
        groups[inv_no].append(page)

    # ── 2. 组装每组 ──
    results: List[Dict[str, Any]] = []
    for inv_no, group in groups.items():
        sorted_group = _sort_pages(group)
        merged = merge_page_results(sorted_group)
        merged['_assembly'] = {
            'invoice_number': inv_no if not inv_no.startswith('__no_inv') else '',
            'page_count': len(sorted_group),
            'pages_assembled': len(sorted_group),
        }
        results.append(merged)

        logger.info(
            f"[InvoiceAssembly] 组装完成: number={inv_no}, "
            f"pages={len(sorted_group)}, "
            f"items={len(merged.get('extra_fields', {}).get('line_items', []))}"
        )

    return results


# ═══════════════════════════════════════════
# DB 记录转换
# ═══════════════════════════════════════════

def invoice_document_to_db_record(
    invoice_doc: Dict[str, Any],
    *,
    fallback_hash: str = '',
    fallback_filename: str = '',
    fallback_raw_text: str = '',
) -> Dict[str, Any]:
    """将 InvoiceDocument 转换为 DB upsert 所需的扁平记录。

    输入契约：assemble() / merge_page_results() 返回的 InvoiceDocument。

    输出契约：可传入 db.upsert_invoice() 的 db_record dict。
    """
    ef = invoice_doc.get('extra_fields') or {}

    return {
        'hash_sha256': fallback_hash,
        'file_name': fallback_filename,
        'file_format': invoice_doc.get('file_format', ''),
        'file_size': 0,
        'type': invoice_doc.get('invoice_type', ef.get('type', '')),
        'number': invoice_doc.get('invoice_number', ef.get('fphm', '')),
        'amount': invoice_doc.get('amount', 0),
        'date': invoice_doc.get('invoice_date', ef.get('kprq', '')),
        'buyer': ef.get('gmfmc', ''),
        'buyer_tax': ef.get('gmfsh', ''),
        'seller': ef.get('xsfmc', ''),
        'seller_tax': ef.get('xsfsh', ''),
        'note': ef.get('note', ''),
        'issuer': ef.get('kpr', ''),
        'payee': ef.get('skr', ''),
        'reviewer': ef.get('fhr', ''),
        'tax_amount': ef.get('amountSe', 0),
        'parse_method': invoice_doc.get('parse_method', ''),
        'parse_ok': 1,
        'raw_text': fallback_raw_text[:5000],
        'thumbnail': '',
        'line_items': ef.get('line_items', []),
        'line_items_excel_rows': ef.get('line_items_excel_rows', []),
    }
