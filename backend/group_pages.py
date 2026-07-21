# -*- coding: utf-8 -*-
"""
GroupPages — 页面归组（PageInfo[] → InvoiceGroup[]）

职责：
    根据 MultiPageAnalyzer 输出的 PageInfo[]，判定哪些页属于同一张发票。

归组规则（当前版本）：
    1. 连续页的发票号码相同 → 同一组
    2. 页码标识（declared_page/declared_total）辅助验证
    3. 单页（pageCount=1 或无多页特征）→ 独立组（回退原流程）

设计原则：
    - 所有归组规则集中在本模块，以后扩展（购买方/销售方/校验码）只改这里
    - 纯函数，无 I/O，无外部依赖
    - 输入 PageInfo[]，输出 InvoiceGroup[]
"""

import logging
from dataclasses import dataclass, field
from typing import List, Optional

from multi_page_analyzer import PageInfo

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════
# 数据模型
# ═══════════════════════════════════════════════════════════

@dataclass
class InvoiceGroup:
    """一组页面 = 一张发票"""
    page_indices: List[int]               # 页序列表（0-based，有序）
    invoice_number: Optional[str] = None  # 该组的发票号码
    declared_total: Optional[int] = None  # 声明的总页数（来自"共N页"）
    confidence: float = 1.0               # 归组置信度（预留）

    @property
    def page_count(self) -> int:
        return len(self.page_indices)

    @property
    def is_multi_page(self) -> bool:
        return len(self.page_indices) > 1


# ═══════════════════════════════════════════════════════════
# 归组逻辑
# ═══════════════════════════════════════════════════════════

def group_pages(pages: List[PageInfo]) -> List[InvoiceGroup]:
    """将 PageInfo[] 归组为 InvoiceGroup[]
    
    规则：
        - 连续页号码相同 → 同一组
        - 号码为 None（无法提取）→ 每页独立组
        - 单页 PDF（len(pages)==1）→ 单个独立组
    
    Args:
        pages: MultiPageAnalyzer 输出的 PageInfo 列表
        
    Returns:
        InvoiceGroup 列表（每组 = 一张发票）
    """
    if not pages:
        return []

    # 单页直接返回
    if len(pages) == 1:
        return [InvoiceGroup(
            page_indices=[0],
            invoice_number=pages[0].invoice_number,
            declared_total=pages[0].declared_total,
        )]

    groups: List[InvoiceGroup] = []
    current_group_indices: List[int] = []
    current_number: Optional[str] = None

    for page in pages:
        num = page.invoice_number

        if num is None:
            # 无法提取号码：当前组结束，本页独立
            if current_group_indices:
                groups.append(_finalize_group(current_group_indices, current_number, pages))
                current_group_indices = []
                current_number = None
            groups.append(InvoiceGroup(page_indices=[page.page_index]))
            continue

        if current_number is None:
            # 开始新组
            current_group_indices = [page.page_index]
            current_number = num
        elif num == current_number:
            # 同号 → 继续当前组
            current_group_indices.append(page.page_index)
        else:
            # 号码变化 → 当前组结束，开始新组
            groups.append(_finalize_group(current_group_indices, current_number, pages))
            current_group_indices = [page.page_index]
            current_number = num

    # 收尾
    if current_group_indices:
        groups.append(_finalize_group(current_group_indices, current_number, pages))

    logger.debug(
        f"[GroupPages] {len(pages)} 页 → {len(groups)} 组: "
        f"{[g.page_indices for g in groups]}"
    )
    return groups


def _finalize_group(
    indices: List[int],
    number: Optional[str],
    pages: List[PageInfo],
) -> InvoiceGroup:
    """完成一个组的构建"""
    # 从组内页提取 declared_total（取最大值，容忍部分页缺失）
    declared_total = None
    for idx in indices:
        if idx < len(pages) and pages[idx].declared_total:
            declared_total = max(declared_total or 0, pages[idx].declared_total)

    return InvoiceGroup(
        page_indices=indices,
        invoice_number=number,
        declared_total=declared_total,
    )
