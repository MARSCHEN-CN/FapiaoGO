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

from multi_page_merge import merge_page_results

logger = logging.getLogger(__name__)

# Step 1 启动标记：确认新三因子引擎已加载
logger.info("[ASSEMBLY_ENGINE] Step 1 — 三因子分组引擎 v3 loaded")


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
# 三因子分组引擎（v3 冻结契约）
# ═══════════════════════════════════════════

import re

# 页码标记正则（与 multi_page_analyzer 同构）
_PAGE_MARKER_RE = re.compile(
    r'共\s*(\d+)\s*页\s*第\s*(\d+)\s*页'
    r'|第\s*(\d+)\s*页\s*/\s*(\d+)'
    r'|第\s*(\d+)\s*页\s*共\s*(\d+)\s*页'
)


def _extract_page_marker(text: str) -> Optional[tuple]:
    """提取页码标记 → (current_page, total_pages)"""
    m = _PAGE_MARKER_RE.search(text)
    if not m:
        return None
    groups = m.groups()
    if groups[0] is not None:
        return (int(groups[1]), int(groups[0]))
    if groups[2] is not None:
        return (int(groups[2]), int(groups[3]))
    if groups[4] is not None:
        return (int(groups[4]), int(groups[5]))
    return None


def _resolve_invoice_number(result: Dict[str, Any]) -> str:
    """从解析结果中提取发票号码"""
    ef = result.get('extra_fields') or {}
    no = ef.get('fphm') or result.get('invoice_number') or ''
    return str(no).strip()


# ─── 分组工具函数 ──────────────────────────────

def _page_raw_text(page: Dict) -> str:
    """安全获取页面原始文本"""
    return page.get('raw_text') or page.get('text') or ''


def _resolve_marker(page: Dict) -> Optional[tuple]:
    """从页面文本提取页码标记 (current, total)"""
    text = _page_raw_text(page)
    return _extract_page_marker(text) if text else None


def _page_num_key(page: Dict) -> int:
    """物理 page_num（排序用）"""
    return page.get('page_num') or page.get('page_index') or 0


def _marker_continuous(last, cur) -> bool:
    """标记序列连续：current=last+1 且 total 不变"""
    return bool(last and cur and
                cur[0] == last[0] + 1 and cur[1] == last[1])


def _physically_consecutive(a: Dict, b: Dict) -> bool:
    """物理 page_num 是否连续"""
    return _page_num_key(b) == _page_num_key(a) + 1


def _invoice_state(inv_a: str, inv_b: str) -> str:
    """发票号一致性：MATCH / MISSING / CONFLICT（v3 §八 坑2）"""
    if inv_a == inv_b:
        return 'MATCH'
    if not inv_a or not inv_b:
        return 'MISSING'
    return 'CONFLICT'


def group_pages_into_documents(pages: List[Dict]) -> List[Dict]:
    """三因子分组：page sequence → invoiceNumber 一致性

    输入：单 sourceDocId 的 PageResult 列表。
    算法：
        - 排序后扫描，marker 序列连续性优先
        - 两端无 marker 时回退物理 page_num 连续（但号码冲突不合并）
        - 每组用 MATCH/MISSING/CONFLICT 校验
    返回：[{pages, invoiceNumber, status, warnings}]
    """
    if not pages:
        return []

    sorted_pages = sorted(pages, key=_page_num_key)

    # ── 扫描构建候选组 ──
    groups: List[List[Dict]] = []
    current: List[Dict] = []

    for page in sorted_pages:
        if not current:
            current.append(page)
            continue

        last = current[-1]
        last_marker = _resolve_marker(last)
        page_marker = _resolve_marker(page)

        # A: 标记连续性（最高优先级）
        seq_ok = _marker_continuous(last_marker, page_marker)

        if not seq_ok:
            # B: 两端均无标记 → 物理连续降级（号码冲突不合并）
            if last_marker is None and page_marker is None:
                if _physically_consecutive(last, page):
                    last_inv = _resolve_invoice_number(last)
                    cur_inv = _resolve_invoice_number(page)
                    if _invoice_state(last_inv, cur_inv) != 'CONFLICT':
                        seq_ok = True

        if seq_ok:
            current.append(page)
        else:
            groups.append(current)
            current = [page]

    if current:
        groups.append(current)

    # ── 校验每组 ──
    results = []
    for group in groups:
        ref_inv = _resolve_invoice_number(group[0])
        warnings: List[str] = []
        state = 'MATCH'

        for page in group[1:]:
            p_inv = _resolve_invoice_number(page)
            s = _invoice_state(ref_inv, p_inv)
            if s == 'MISSING' and state == 'MATCH':
                state = 'MISSING'
                warnings.append('invoice_number_missing_on_some_pages')
            elif s == 'CONFLICT':
                state = 'CONFLICT'
                warnings.append(f'invoice_conflict: {ref_inv} vs {p_inv}')

        results.append({
            'pages': group,
            'invoiceNumber': ref_inv,
            'status': state,
            'warnings': warnings,
        })

    return results


def _sort_pages(pages: List[Dict]) -> List[Dict]:
    """按物理 page_num 排序（与 _page_num_key 一致）"""
    return sorted(pages, key=_page_num_key)


# ═══════════════════════════════════════════
# 核心函数
# ═══════════════════════════════════════════

def assemble(pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """将页面解析结果组装为发票文档列表

    输入契约（PageParseResult）：
        每项为 parse_invoice_service 对单页的完整返回结果。
        必须有 extra_fields（含 line_items）。

    输出契约（InvoiceDocument）：
        同 parse_invoice_service 返回结构（已通过 merge_page_results 合并）。
        多页情况：首页身份字段 + 全页明细 + 末页金额。
        单页情况：直接透传。
    """
    if not pages:
        return []

    # 三因子分组（替代原先 invoice_number 分组）
    assembled_groups = group_pages_into_documents(pages)

    results: List[Dict[str, Any]] = []
    for ag in assembled_groups:
        group = ag['pages']
        sorted_group = _sort_pages(group)
        merged = merge_page_results(sorted_group)

        merged['_assembly'] = {
            'invoice_number': ag['invoiceNumber'],
            'page_count': len(sorted_group),
            'pages_assembled': len(sorted_group),
            'assembly_status': ag['status'],
            'assembly_warnings': ag['warnings'],
        }
        results.append(merged)

        log_number = ag['invoiceNumber'] or '__no_inv__'
        logger.info(
            f"[InvoiceAssembly] 组装完成: number={log_number}, "
            f"pages={len(sorted_group)}, "
            f"status={ag['status']}, "
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
