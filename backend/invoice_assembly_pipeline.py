# -*- coding: utf-8 -*-
"""
InvoiceAssemblyPipeline — 页面结果 → 发票文档组装管道

职责：
    将同一 source_doc_id 的页面解析结果按 invoice_number 分组，
    调用 merge_page_results 组装为 InvoiceDocument。

输入：
    List[Dict] — 每项为 parse_invoice_service 对单页的返回结果

输出：
    List[Dict] — 每项为合并后的 InvoiceDocument（同 parse_invoice_service 结构）

内部流程：
    PageParseResult[]
        |
        | 1. 确认 invoice_number（从 extra_fields.fphm 获取）
        | 2. 按 invoice_number 分组
        | 3. 同号码的 pages 按 page_num 排序
        | 4. 每组调用 merge_page_results()
        |
        ↓
    InvoiceDocument[]
"""

import logging
from typing import List, Dict, Any
from collections import defaultdict

from backend.multi_page_merge import merge_page_results

logger = logging.getLogger(__name__)


def _resolve_invoice_number(result: Dict[str, Any]) -> str:
    """从解析结果中提取发票号码

    优先从 extra_fields.fphm 获取，回退到顶层 invoice_number。
    """
    ef = result.get('extra_fields') or {}
    no = ef.get('fphm') or result.get('invoice_number') or ''
    return str(no).strip()


def _sort_pages(pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """按 page_num 排序（未提供 page_num 时保持原序）"""
    def page_sort_key(p):
        # 尝试多种可能的页码字段
        return (
            p.get('page_num') or
            p.get('page_index') or
            0
        )
    return sorted(pages, key=page_sort_key)


def assemble(pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """将页面解析结果组装为发票文档列表

    Args:
        pages: 同一 source_doc_id 的页面解析结果列表
              （来自 PageResultStore.get_pages()）

    Returns:
        组装后的发票文档列表
    """
    if not pages:
        return []

    # ── 1. 按 invoice_number 分组 ──
    groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

    for page in pages:
        inv_no = _resolve_invoice_number(page)
        if not inv_no:
            # 无 invoice_number → 每页独立成组（使用页码区分）
            inv_no = f"__no_inv_{page.get('page_num', id(page))}__"
        groups[inv_no].append(page)

    # ── 2. 组装每组 ──
    results: List[Dict[str, Any]] = []
    for inv_no, group in groups.items():
        # 按页码排序
        sorted_group = _sort_pages(group)
        # 调用 merge_page_results 合并
        merged = merge_page_results(sorted_group)
        # 写入组装元信息
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
