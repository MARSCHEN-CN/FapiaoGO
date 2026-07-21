# -*- coding: utf-8 -*-
"""
MultiPageMerge — 多页解析结果合并（纯函数）

职责：
    将多页独立 parse_invoice_service 结果按 Field Source Policy 合并为一份。

设计原则：
    - 纯函数：无 I/O，无 DB，无 OCR，无 Service 依赖
    - 输入：List[dict]（parse_invoice_service 返回值）
    - 输出：dict（同结构，合并后）
    - Field Source Policy 表驱动，新增字段加一行即可

Field Source Policy:
    第一页：invoice_number, invoice_type, invoice_date, buyer, seller, fphm, kprq, type
    所有页：line_items（append）
    最后一页：amount, amountHj, tax, remark, skr, fhr, kpr, 校验码
"""

import logging
from typing import List, Dict, Any

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════
# Field Source Policy 定义
# ═══════════════════════════════════════════════════════════

# extra_fields 中来自第一页的 key
_FIRST_PAGE_KEYS = frozenset([
    'fphm',       # 发票号码
    'fphmCode',   # 发票代码（如有）
    'kprq',       # 开票日期
    'type',       # 发票类型
    'gmfmc',      # 购买方名称
    'gmfnsrsbh',  # 购买方税号
    'gmfdzdh',    # 购买方地址电话
    'gmfyhzh',    # 购买方银行账号
    'xsfmc',      # 销售方名称
    'xsfnsrsbh',  # 销售方税号
    'xsfdzdh',    # 销售方地址电话
    'xsfyhzh',    # 销售方银行账号
])

# extra_fields 中来自最后一页的 key
_LAST_PAGE_KEYS = frozenset([
    'amountHj',   # 价税合计
    'amountJe',   # 合计金额
    'amountSe',   # 合计税额
    'bz',         # 备注
    'skr',        # 收款人
    'fhr',        # 复核人
    'kpr',        # 开票人
    'jym',        # 校验码
    'jshjdx',     # 价税合计大写
    'jshjxx',     # 价税合计小写
])

# extra_fields 中需要所有页拼接的 key
_APPEND_KEYS = frozenset([
    'line_items',  # 项目明细
])


# ═══════════════════════════════════════════════════════════
# Merge 函数
# ═══════════════════════════════════════════════════════════

def merge_page_results(page_results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """将多页解析结果合并为一份
    
    Args:
        page_results: 每页独立调用 parse_invoice_service 的返回值列表（按页序）
        
    Returns:
        合并后的 dict（与 parse_invoice_service 返回结构相同）
    """
    if not page_results:
        return {}
    if len(page_results) == 1:
        return page_results[0]

    first = page_results[0]
    last = page_results[-1]

    # ── 顶层字段合并 ──
    merged = dict(first)  # 以第一页为基础

    # 顶层：来自最后一页
    merged['amount'] = last.get('amount')

    # ── extra_fields 合并 ──
    first_ef = first.get('extra_fields') or {}
    last_ef = last.get('extra_fields') or {}

    merged_ef = {}

    # 第一页字段
    for key in _FIRST_PAGE_KEYS:
        if key in first_ef:
            merged_ef[key] = first_ef[key]

    # 最后一页字段
    for key in _LAST_PAGE_KEYS:
        if key in last_ef:
            merged_ef[key] = last_ef[key]

    # 拼接字段（所有页 append）
    for key in _APPEND_KEYS:
        combined = []
        for result in page_results:
            ef = result.get('extra_fields') or {}
            items = ef.get(key)
            if items and isinstance(items, list):
                combined.extend(items)
        merged_ef[key] = combined

    # 其余未分类的 key：取第一页（保守策略）
    all_keys = set()
    for result in page_results:
        ef = result.get('extra_fields') or {}
        all_keys.update(ef.keys())
    for key in all_keys:
        if key not in merged_ef:
            merged_ef[key] = first_ef.get(key)

    merged['extra_fields'] = merged_ef

    # ── 顶层 invoice_number/type/date 同步（从 extra_fields 回写）──
    if merged_ef.get('fphm'):
        merged['invoice_number'] = merged_ef['fphm']
    if merged_ef.get('type'):
        merged['invoice_type'] = merged_ef['type']
    if merged_ef.get('kprq'):
        merged['invoice_date'] = merged_ef['kprq']

    # ── 元信息 ──
    merged['page_count'] = len(page_results)
    # 清除单页特有字段（避免误导）
    merged.pop('from_cache', None)

    logger.info(
        f"[MultiPageMerge] 合并 {len(page_results)} 页: "
        f"items={len(merged_ef.get('line_items', []))}, "
        f"number={merged.get('invoice_number', '?')}"
    )
    return merged
