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
    """提取单页的原始页码标记（不做 0/1-based 判定）

    双轨提取：
    1) 优先从 raw_text / text 中正则提取（真实 OCR 路径）
    2) 回退：若页面已显式提供 page_num + total_pages 顶层字段，
       枚举 0-based/1-based 两种候选并返回合法值；
       两者皆合法时优先返回 0-based 候选。
    """
    # 轨道1：文本正则（直接返回，无需校准）
    text = _page_raw_text(page)
    if text:
        marker = _extract_page_marker(text)
        if marker is not None:
            return marker

    # 轨道2：显式结构化字段
    page_num = page.get('page_num')
    total_pages = page.get('total_pages')
    if (page_num is not None and total_pages is not None
            and isinstance(total_pages, int) and total_pages >= 2):
        try:
            pn = int(page_num)
            candidates = (
                (pn + 1, total_pages),  # 视为 0-based
                (pn, total_pages),     # 视为 1-based
            )
            for cur, total in candidates:
                if 1 <= cur <= total <= 100:
                    return (cur, total)
        except (TypeError, ValueError):
            pass

    return None


def _resolve_markers_for_group(pages: List[Dict]) -> List[Optional[tuple]]:
    """为同一发票组的所有页面解析页码标记，统一 0/1-based 基准。

    组内决策策略（解决"单页无法区分 0/1-based"歧义）：
    - 若组内最小 page_num == 0 → 全组按 0-based（PageResultStore 真实链路）
    - 否则 → 全组按 1-based（OCR / 历史 fixture）
    这样保证整组语义一致，避免 page_num=1 被误判为"第二页"。
    """
    # 收集每页的原始 page_num（用于基准判定）
    page_nums = []
    for p in pages:
        pn = p.get('page_num')
        page_nums.append(int(pn) if pn is not None else None)

    # 基准：最小 page_num 是否为 0
    valid_nums = [n for n in page_nums if n is not None]
    use_zero_based = bool(valid_nums) and min(valid_nums) == 0

    # 逐页解析：
    #   - 带 raw_text 文本标记 → 直接用文本结果（无需基准校准）
    #   - 仅结构化字段 → 根据基准计算 current
    calibrated: List[Optional[tuple]] = []
    for p, pn in zip(pages, page_nums):
        if _page_raw_text(p):
            calibrated.append(_resolve_marker(p))
            continue
        total = p.get('total_pages')
        if pn is None or total is None or not isinstance(total, int) or total < 2:
            calibrated.append(None)
            continue
        if use_zero_based:
            cur = pn + 1
        else:
            cur = pn
        if 1 <= cur <= total <= 100:
            calibrated.append((cur, total))
        else:
            calibrated.append(None)

    return calibrated


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
    """按发票号分组 + 页码标记判定同票多页

    判定原则（安全优先，宁拆勿错合）：
    1. 先按发票号分组，不同发票号的页面绝不合并
    2. 每组内检查页码标记：有首尾页标记 → 合并为多页；否则拆分
    3. 放宽非连续页码校验：只要求首尾页标记存在，不要求所有物理页数=N
       （与 _is_complete 的首尾页兜底策略一致）
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

    # ── Step 1: 按发票号分组 ──
    # 将页面按发票号分组，不同发票号的页面绝不合并
    invoice_groups: Dict[str, List[Dict]] = {}
    no_invoice_pages: List[Dict] = []

    for p in sorted_pages:
        inv = _resolve_invoice_number(p)
        if inv:
            if inv not in invoice_groups:
                invoice_groups[inv] = []
            invoice_groups[inv].append(p)
        else:
            no_invoice_pages.append(p)

    logger.info(
        f'[InvoiceAssembly] 按发票号分组: '
        f'{len(invoice_groups)} 个发票组, '
        f'{len(no_invoice_pages)} 个无发票号页'
    )

    # ── Step 2: 对每个发票组判定是否多页 ──
    results: List[Dict] = []

    for inv_number, group_pages in invoice_groups.items():
        group_n = len(group_pages)
        logger.info(
            f'[InvoiceAssembly] 处理发票 {inv_number}: '
            f'{group_n} 页'
        )

        if group_n == 1:
            # 单页，直接作为单页文档
            results.append({
                'pages': group_pages,
                'invoiceNumber': inv_number,
                'status': 'MATCH',
                'warnings': [],
            })
            logger.info(f'[InvoiceAssembly] 发票 {inv_number}: 单页文档')
            continue

        # 多页：检查页码标记（整组统一 0/1-based 基准）
        page_markers = _resolve_markers_for_group(group_pages)
        pages_with_marker = 0
        all_currents = []
        total_counts: Dict[int, int] = {}

        for marker in page_markers:
            if marker is None:
                continue
            pages_with_marker += 1
            cur, total = marker
            all_currents.append(cur)
            total_counts[total] = total_counts.get(total, 0) + 1

        logger.info(
            f'[InvoiceAssembly] 发票 {inv_number}: '
            f'有标记 {pages_with_marker}/{group_n}, '
            f'total分布={total_counts}, '
            f'当前页序号={all_currents}'
        )

        # 无页码标记 → 不是多页发票 → 拆分为单页
        if pages_with_marker == 0:
            logger.info(
                f'[InvoiceAssembly] 发票 {inv_number}: '
                f'无页码标记 → 拆分为单页'
            )
            for p in group_pages:
                results.append({
                    'pages': [p],
                    'invoiceNumber': inv_number,
                    'status': 'MATCH',
                    'warnings': [],
                })
            continue

        # 找出出现次数最多的total作为候选N
        candidate_n = max(total_counts.keys(), key=lambda k: total_counts[k])
        logger.info(
            f'[InvoiceAssembly] 发票 {inv_number}: '
            f'候选总页数N={candidate_n}'
        )

        # 校验1: 候选N必须 >= 2
        if candidate_n < 2:
            logger.info(
                f'[InvoiceAssembly] 发票 {inv_number}: '
                f'N={candidate_n} < 2 → 拆分为单页'
            )
            for p in group_pages:
                results.append({
                    'pages': [p],
                    'invoiceNumber': inv_number,
                    'status': 'MATCH',
                    'warnings': [],
                })
            continue

        # 校验2: 必须有第1页和第N页的标记（首尾页证据）
        has_first_page = 1 in all_currents
        has_last_page = candidate_n in all_currents
        logger.info(
            f'[InvoiceAssembly] 发票 {inv_number}: '
            f'首页标记(第1页)={has_first_page}, '
            f'末页标记(第{candidate_n}页)={has_last_page}'
        )

        if not (has_first_page and has_last_page):
            logger.info(
                f'[InvoiceAssembly] 发票 {inv_number}: '
                f'首尾标记缺失 → 拆分为单页'
            )
            for p in group_pages:
                results.append({
                    'pages': [p],
                    'invoiceNumber': inv_number,
                    'status': 'MATCH',
                    'warnings': [],
                })
            continue

        # 所有校验通过 → 合并为同票多页
        # 放宽校验：不再要求 group_n == candidate_n
        # 只要首尾页标记存在即可（支持非连续页码，如第1、3、5页/共5页）
        logger.info(
            f'[InvoiceAssembly] 发票 {inv_number}: '
            f'✅ 同票多页判定通过: '
            f'pages={group_n}, total_pages={candidate_n}'
        )
        results.append({
            'pages': group_pages,
            'invoiceNumber': inv_number,
            'status': 'MATCH',
            'warnings': [],
        })

    # ── Step 3: 无发票号的页面 → 各自作为单页文档 ──
    for p in no_invoice_pages:
        results.append({
            'pages': [p],
            'invoiceNumber': '',
            'status': 'MATCH',
            'warnings': [],
        })

    logger.info(
        f'[InvoiceAssembly] ===== 分组完成: {len(results)} 个文档 ==='
    )
    for i, r in enumerate(results):
        logger.info(
            f'[InvoiceAssembly] 文档{i}: '
            f'invoice={r["invoiceNumber"]}, '
            f'pages={len(r["pages"])}'
        )

    return results


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

        # FIX: 添加 pages 字段到 merged 字典，使下游（import_batch_manager）能获取页面列表
        # 原因：import_batch_manager 需要从每个文档的页面中提取对应的文件名，
        # 但 merge_page_results 返回的是扁平结构，不包含 pages 字段
        merged['pages'] = sorted_group

        merged['_assembly'] = {
            'invoice_number': ag['invoiceNumber'],
            'page_count': len(sorted_group),
            'pages_assembled': len(sorted_group),
            'assembly_status': ag['status'],
            'assembly_warnings': ag['warnings'],
            # Commit 2：声明该 InvoiceDocument 的精确页面成员（前端 clientKey 列表）。
            # 使前端 hydrate 不再需要按 invoiceNumber 反推页身份，直接消费即可。
            # 只读页面结果上已透传的 clientKey（见 import_batch_manager 注入点）。
            # FIX: 过滤掉空字符串，避免 page_client_keys 包含无效的空字符串
            'page_client_keys': [
                key for key in [
                    p.get('clientKey') or p.get('client_key') or ''
                    for p in sorted_group
                ] if key
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
