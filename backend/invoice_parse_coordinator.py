# -*- coding: utf-8 -*-
"""
InvoiceParseCoordinator — 多页发票解析协调器

职责：
    串联 MultiPageAnalyzer → GroupPages → parse_invoice_service → MultiPageMerge。
    对 parse_invoice_service 完全透明——它永远认为自己在解析一页。

调用链：
    PDF bytes
        → MultiPageAnalyzer.analyze() → PageInfo[]
        → group_pages() → InvoiceGroup[]
        → 对每个 group:
            单页 → 直接调 parse_invoice_service（原流程）
            多页 → 逐页提取 → 逐页 parse_invoice_service → merge_page_results()
        → 返回 List[ParseResult]（每个 group 一个结果）

设计原则：
    - 不修改 parse_invoice_service
    - 不修改 MultiPageAnalyzer / GroupPages / MultiPageMerge
    - 只做"接线"
"""

import logging
from typing import List, Dict, Any, Optional

import fitz  # PyMuPDF

from multi_page_analyzer import MultiPageAnalyzer, PageInfo
from group_pages import group_pages, InvoiceGroup
from multi_page_merge import merge_page_results

logger = logging.getLogger(__name__)


class InvoiceParseCoordinator:
    """多页发票解析协调器
    
    Usage:
        coordinator = InvoiceParseCoordinator()
        results = coordinator.parse(pdf_bytes, filename, **parse_kwargs)
        # results: List[dict]  每个 dict = parse_invoice_service 返回结构
        # 单页 PDF → len(results) == 1
        # 多页同号 → len(results) == 1（合并后）
        # 多页不同号 → len(results) == N（每页独立）
    """

    def __init__(self):
        self._analyzer = MultiPageAnalyzer()

    def parse(
        self,
        pdf_bytes: bytes,
        filename: str,
        parse_fn=None,
        **parse_kwargs,
    ) -> List[Dict[str, Any]]:
        """解析 PDF（自动处理多页归组）
        
        Args:
            pdf_bytes: PDF 文件字节
            filename: 原始文件名
            parse_fn: 单页解析函数（默认 parse_invoice_service）
            **parse_kwargs: 透传给 parse_fn 的参数
            
        Returns:
            解析结果列表（每个 InvoiceGroup 一个结果）
        """
        if parse_fn is None:
            from services.invoice_service import parse_invoice_service
            parse_fn = parse_invoice_service

        # Step 1: 分析
        pages_info = self._analyzer.analyze(pdf_bytes)

        if not pages_info:
            # 无法分析（非 PDF 或损坏）→ 直接调原函数
            logger.warning(f"[Coordinator] 无法分析，回退原流程: {filename}")
            return [parse_fn(pdf_bytes, filename, **parse_kwargs)]

        # 单页 → 原流程
        if len(pages_info) == 1:
            return [parse_fn(pdf_bytes, filename, **parse_kwargs)]

        # Step 2: 归组
        groups = group_pages(pages_info)

        # 全部是单页组 → 回退原流程（交给现有 split_pdf 逻辑）
        if all(not g.is_multi_page for g in groups):
            logger.debug(f"[Coordinator] 无多页组，回退原流程: {filename}")
            return [parse_fn(pdf_bytes, filename, **parse_kwargs)]

        # Step 3: 逐组处理
        results = []
        for group in groups:
            if group.is_multi_page:
                result = self._parse_multi_page_group(
                    pdf_bytes, group, filename, parse_fn, **parse_kwargs
                )
            else:
                # 单页组：提取该页，独立解析
                page_bytes = self._extract_page(pdf_bytes, group.page_indices[0])
                page_filename = f"{filename}_p{group.page_indices[0] + 1}"
                result = parse_fn(page_bytes, page_filename, **parse_kwargs)
            results.append(result)

        logger.info(
            f"[Coordinator] {filename}: {len(pages_info)} 页 → "
            f"{len(groups)} 组 → {len(results)} 个结果"
        )
        return results

    # ─── 内部方法 ─────────────────────────────────────────

    def _parse_multi_page_group(
        self,
        pdf_bytes: bytes,
        group: InvoiceGroup,
        filename: str,
        parse_fn,
        **parse_kwargs,
    ) -> Dict[str, Any]:
        """解析多页组：逐页 parse → merge"""
        page_results = []

        for page_idx in group.page_indices:
            page_bytes = self._extract_page(pdf_bytes, page_idx)
            page_filename = f"{filename}_p{page_idx + 1}"

            # 强制跳过 DB 写入（多页中间结果不入库，merge 后才入）
            kwargs = dict(parse_kwargs)
            kwargs['skip_db_write'] = True

            result = parse_fn(page_bytes, page_filename, **kwargs)
            page_results.append(result)

        # 合并
        merged = merge_page_results(page_results)
        return merged

    @staticmethod
    def _extract_page(pdf_bytes: bytes, page_index: int) -> bytes:
        """从 PDF 中提取单页为独立 PDF bytes"""
        doc = fitz.open(stream=pdf_bytes, filetype='pdf')
        try:
            new_doc = fitz.open()
            new_doc.insert_pdf(doc, from_page=page_index, to_page=page_index)
            page_bytes = new_doc.tobytes()
            new_doc.close()
            return page_bytes
        finally:
            doc.close()
