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

# 页码标记正则（支持更多变体，容忍OCR常见空格/格式问题）
# 注意：所有模式都必须包含"页"字作为锚点，避免日期、金额等数字/斜杠组合产生假阳性
_PAGE_MARKER_RE = re.compile(
    # 标准格式：共N页 第M页
    r'共\s*(\d+)\s*页\s*[，,。.\s-]*\s*第\s*(\d+)\s*页'
    # 格式：第M页/共N页 或 第M页 / N页
    r'|第\s*(\d+)\s*页\s*/\s*(?:共\s*)?(\d+)\s*页'
    # 格式：第M页 共N页
    r'|第\s*(\d+)\s*页\s*[，,。.\s-]*\s*共\s*(\d+)\s*页'
)


def _extract_page_marker(text: str) -> Optional[tuple]:
    """提取页码标记 → (current_page, total_pages)
    
    支持格式（都必须包含"页"字锚点）：
    1. 共N页 第M页
    2. 第M页/共N页 / 第M页/N页
    3. 第M页 共N页
    
    校验：1 <= current <= total <= 100，过滤假阳性
    """
    if not text:
        return None
    for m in _PAGE_MARKER_RE.finditer(text):
        groups = m.groups()
        # 模式1: 共N页 第M页 → groups = (N, M, None, None, None, None)
        if groups[0] is not None and groups[1] is not None:
            try:
                cur, total = int(groups[1]), int(groups[0])
                if 1 <= cur <= total <= 100:
                    return (cur, total)
            except (ValueError, IndexError):
                pass
        # 模式2: 第M页/共N页 → groups = (None, None, M, N, None, None)
        if groups[2] is not None and groups[3] is not None:
            try:
                cur, total = int(groups[2]), int(groups[3])
                if 1 <= cur <= total <= 100:
                    return (cur, total)
            except (ValueError, IndexError):
                pass
        # 模式3: 第M页 共N页 → groups = (None, None, None, None, M, N)
        if groups[4] is not None and groups[5] is not None:
            try:
                cur, total = int(groups[4]), int(groups[5])
                if 1 <= cur <= total <= 100:
                    return (cur, total)
            except (ValueError, IndexError):
                pass
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
    """严格按两条件判定同票多页：
    条件1：所有页面发票号码一致（不冲突）
    条件2：存在"共N页 第M页"标记，且标记支持该PDF物理页数=N的多页发票
           （至少有一页明确标注total=N，且有页码1和N的标记，或标记序列连续）
    
    判定原则（安全优先，宁拆勿错合）：
    - 必须有明确的"共N页 第M页"标记证据
    - 必须有发票号一致性证据
    - 物理页数必须等于标记声明的N
    - 证据不足 → 一律拆分为单页
    """
    if not pages:
        logger.info('[InvoiceAssembly] 空页面列表，返回空')
        return []

    sorted_pages = sorted(pages, key=_page_num_key)
    n = len(sorted_pages)
    
    logger.info(f'[InvoiceAssembly] ===== 开始分组判定，共{n}页 ===')
    
    # 单页直接返回
    if n <= 1:
        result = [{
            'pages': sorted_pages,
            'invoiceNumber': _resolve_invoice_number(sorted_pages[0]),
            'status': 'MATCH',
            'warnings': [],
        }]
        logger.info('[InvoiceAssembly] 单页文档，直接返回不分组')
        return result
    
    # ── 预检查：提取所有页的 marker 和 invoice_number ──
    page_markers = []
    page_invoices = []
    logger.info('[InvoiceAssembly] --- 逐页检查 ---')
    for i, p in enumerate(sorted_pages):
        marker = _resolve_marker(p)
        inv = _resolve_invoice_number(p)
        text_preview = (_page_raw_text(p) or '')[:100]
        page_num = _page_num_key(p)
        page_markers.append(marker)
        page_invoices.append(inv)
        logger.info(
            f'[InvoiceAssembly] 页{i} (page_num={page_num}): '
            f'marker={marker}, invoice={inv}, '
            f'text_preview="{text_preview}..."'
        )
    
    # ── 条件1检查：发票号一致性 ──
    logger.info('[InvoiceAssembly] --- 条件1：发票号一致性检查 ---')
    ref_inv = ''
    invoice_conflict = False
    for inv in page_invoices:
        if not inv:
            logger.info('[InvoiceAssembly] 某页发票号为空，跳过')
            continue
        if not ref_inv:
            ref_inv = inv
            logger.info(f'[InvoiceAssembly] 基准发票号: {ref_inv}')
        elif inv != ref_inv:
            invoice_conflict = True
            logger.error(
                f'[InvoiceAssembly] 发票号冲突！基准={ref_inv}, 发现={inv} → 拆分'
            )
            break
    
    if invoice_conflict:
        # 发票号冲突 → 直接拆分（不同发票肯定不能合并）
        logger.info('[InvoiceAssembly] ❌ 条件1不满足（发票号冲突）→ 拆分为单页')
        return _split_all_to_single(sorted_pages, page_invoices)
    
    # ── 条件2检查：页码标记证据 ──
    logger.info('[InvoiceAssembly] --- 条件2：页码标记证据检查 ---')
    
    # 统计所有出现的 total 值
    total_counts: Dict[int, int] = {}
    pages_with_marker = 0
    all_currents = []
    for idx, marker in enumerate(page_markers):
        if marker is None:
            logger.info(f'[InvoiceAssembly] 页{idx} 无页码标记')
            continue
        pages_with_marker += 1
        cur, total = marker
        all_currents.append(cur)
        total_counts[total] = total_counts.get(total, 0) + 1
        logger.info(f'[InvoiceAssembly] 页{idx} 有标记: 第{cur}页/共{total}页')
    
    logger.info(f'[InvoiceAssembly] 有标记的页数: {pages_with_marker}/{n}')
    logger.info(f'[InvoiceAssembly] total分布: {total_counts}')
    logger.info(f'[InvoiceAssembly] 当前页序号集合: {all_currents}')
    
    # 没有任何marker → 不是多页发票 → 拆分
    if pages_with_marker == 0:
        logger.info('[InvoiceAssembly] ❌ 条件2不满足（无任何页码标记）→ 拆分为单页')
        return _split_all_to_single(sorted_pages, page_invoices)
    
    # 找出出现次数最多的total作为候选N
    candidate_n = max(total_counts.keys(), key=lambda k: total_counts[k])
    logger.info(f'[InvoiceAssembly] 候选总页数N={candidate_n}（出现次数最多）')
    
    # 关键校验1：物理页数必须等于候选N
    logger.info(
        f'[InvoiceAssembly] 校验1: 物理页数({n}) vs 候选N({candidate_n})'
    )
    if n != candidate_n:
        logger.info(
            f'[InvoiceAssembly] ❌ 校验1失败: 物理页数({n}) != 标记声明总页数({candidate_n}) → 拆分'
        )
        return _split_all_to_single(sorted_pages, page_invoices)
    logger.info('[InvoiceAssembly] ✅ 校验1通过')
    
    # 关键校验2：候选N必须 >= 2（单页发票不需要合并）
    logger.info(f'[InvoiceAssembly] 校验2: 候选N({candidate_n}) >= 2')
    if candidate_n < 2:
        logger.info(f'[InvoiceAssembly] ❌ 校验2失败: N={candidate_n}（单页）→ 拆分')
        return _split_all_to_single(sorted_pages, page_invoices)
    logger.info('[InvoiceAssembly] ✅ 校验2通过')
    
    # 关键校验3：必须有第1页和第N页的标记（首尾页证据齐全）
    has_first_page = 1 in all_currents
    has_last_page = candidate_n in all_currents
    logger.info(
        f'[InvoiceAssembly] 校验3: 首页标记(第1页)={has_first_page}, '
        f'末页标记(第{candidate_n}页)={has_last_page}'
    )
    
    if not (has_first_page and has_last_page):
        logger.info(
            f'[InvoiceAssembly] ❌ 校验3失败: '
            f'首尾标记缺失 → 拆分'
        )
        return _split_all_to_single(sorted_pages, page_invoices)
    logger.info('[InvoiceAssembly] ✅ 校验3通过')
    
    # 关键校验4：发票号不能为空（多页发票应该能识别到发票号）
    logger.info(f'[InvoiceAssembly] 校验4: 发票号不为空 = {bool(ref_inv)}')
    if not ref_inv:
        # 即使标记符合，但完全没有识别到发票号 → 安全起见拆分
        logger.info('[InvoiceAssembly] ❌ 校验4失败: 有页码标记但无发票号 → 安全拆分')
        return _split_all_to_single(sorted_pages, page_invoices)
    logger.info('[InvoiceAssembly] ✅ 校验4通过')
    
    # ── 所有校验通过 → 合并为同票多页 ──
    logger.info(
        f'[InvoiceAssembly] ✅ 同票多页判定通过: invoice={ref_inv}, '
        f'total_pages={candidate_n}, pages_with_marker={pages_with_marker}/{n}'
    )
    return [{
        'pages': sorted_pages,
        'invoiceNumber': ref_inv,
        'status': 'MATCH',
        'warnings': [],
    }]


def _split_all_to_single(sorted_pages: List[Dict], page_invoices: List[str]) -> List[Dict]:
    """将所有页面拆分为单页组"""
    logger.info(f'[InvoiceAssembly] === 拆分为{len(sorted_pages)}个单页文档 ===')
    results = []
    for i, p in enumerate(sorted_pages):
        inv = page_invoices[i] if i < len(page_invoices) else ''
        page_num = _page_num_key(p)
        logger.info(f'[InvoiceAssembly] 拆分: 页{i} (page_num={page_num}), invoice={inv}')
        results.append({
            'pages': [p],
            'invoiceNumber': inv,
            'status': 'MATCH',
            'warnings': [],
        })
    logger.info(f'[InvoiceAssembly] 拆分完成，共{len(results)}个单页文档')
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
        logger.info('[InvoiceAssembly] assemble: 空页面列表，返回空')
        return []

    logger.info(f'[InvoiceAssembly] assemble: 开始组装，共{len(pages)}页')
    
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
            # Commit 2：声明该 InvoiceDocument 的精确页面成员（前端 clientKey 列表）。
            # 使前端 hydrate 不再需要按 invoiceNumber 反推页身份，直接消费即可。
            # 只读页面结果上已透传的 clientKey（见 import_batch_manager 注入点）。
            'page_client_keys': [
                p.get('clientKey') or p.get('client_key') or ''
                for p in sorted_group
            ],
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
        'amount': ef.get('amountHj') or invoice_doc.get('amount', 0),
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
