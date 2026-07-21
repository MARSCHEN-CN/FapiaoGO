# -*- coding: utf-8 -*-
"""
MultiPageAnalyzer — 多页 PDF 纯数据提取

职责（且仅）：
    输入 PDF bytes → 输出 PageInfo[]（每页的结构化元数据）

不做归组判定。不做 OCR。不依赖任何 Service。
归组逻辑由 group_pages.py 负责。

设计原则：
    - 纯提取，永远不需要因为归组规则变化而修改本模块
    - 仅依赖 PDF 文字层（PyMuPDF extract_text）
    - 无文字层时标记 has_text_layer=False，由上层决定回退策略
"""

import re
import logging
from dataclasses import dataclass
from typing import List, Optional

import fitz  # PyMuPDF

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════
# 正则模式
# ═══════════════════════════════════════════════════════════

# 页码标识：共N页 第M页（及常见变体）
_PAGE_MARKER_RE = re.compile(
    r'共\s*(\d+)\s*页\s*第\s*(\d+)\s*页'
    r'|第\s*(\d+)\s*页\s*/\s*(\d+)'
    r'|第\s*(\d+)\s*页\s*共\s*(\d+)\s*页'
)

# 发票号码：支持"发票号码：XXX"和"发票号码 XXX"
_INVOICE_NUMBER_RE = re.compile(
    r'发票号码[：:\s]*([0-9]{8,20})'
)

# 发票代码
_INVOICE_CODE_RE = re.compile(
    r'发票代码[：:\s]*([0-9]{10,12})'
)


# ═══════════════════════════════════════════════════════════
# 数据模型
# ═══════════════════════════════════════════════════════════

@dataclass
class PageInfo:
    """单页提取结果（纯数据，不含业务判定）"""
    page_index: int                       # 页序（0-based）
    invoice_number: Optional[str] = None  # 发票号码（文字层提取）
    invoice_code: Optional[str] = None    # 发票代码
    declared_page: Optional[int] = None   # "第M页"中的 M
    declared_total: Optional[int] = None  # "共N页"中的 N
    has_text_layer: bool = False          # 是否有可提取的文字层


# ═══════════════════════════════════════════════════════════
# Analyzer
# ═══════════════════════════════════════════════════════════

class MultiPageAnalyzer:
    """多页 PDF 纯数据提取器
    
    Usage:
        analyzer = MultiPageAnalyzer()
        pages = analyzer.analyze(pdf_bytes)
        # pages: List[PageInfo]
    """

    def analyze(self, pdf_bytes: bytes) -> List[PageInfo]:
        """提取 PDF 每页的结构化元数据
        
        Args:
            pdf_bytes: PDF 文件字节
            
        Returns:
            PageInfo 列表（长度 = PDF 页数）
        """
        try:
            doc = fitz.open(stream=pdf_bytes, filetype='pdf')
        except Exception as e:
            logger.warning(f"[MultiPageAnalyzer] 无法打开 PDF: {e}")
            return []

        pages: List[PageInfo] = []

        try:
            for idx in range(len(doc)):
                page = doc[idx]
                text = page.get_text('text') or ''

                info = PageInfo(page_index=idx)

                # 判断文字层
                stripped = text.strip()
                info.has_text_layer = len(stripped) > 20  # 少于20字符视为无有效文字层

                if info.has_text_layer:
                    info.invoice_number = self._extract_invoice_number(stripped)
                    info.invoice_code = self._extract_invoice_code(stripped)
                    declared = self._extract_page_marker(stripped)
                    if declared:
                        info.declared_page, info.declared_total = declared

                pages.append(info)
        finally:
            doc.close()

        logger.debug(
            f"[MultiPageAnalyzer] 分析完成: {len(pages)} 页, "
            f"有文字层={sum(1 for p in pages if p.has_text_layer)}"
        )
        return pages

    # ─── 内部提取方法 ─────────────────────────────────────

    @staticmethod
    def _extract_page_marker(text: str) -> Optional[tuple]:
        """提取页码标识 → (current_page, total_pages)"""
        m = _PAGE_MARKER_RE.search(text)
        if not m:
            return None
        groups = m.groups()
        # 模式1: 共N页 第M页 → groups = (N, M, None, None, None, None)
        if groups[0] is not None:
            return (int(groups[1]), int(groups[0]))
        # 模式2: 第M页/N → groups = (None, None, M, N, None, None)
        if groups[2] is not None:
            return (int(groups[2]), int(groups[3]))
        # 模式3: 第M页 共N页 → groups = (None, None, None, None, M, N)
        if groups[4] is not None:
            return (int(groups[4]), int(groups[5]))
        return None

    @staticmethod
    def _extract_invoice_number(text: str) -> Optional[str]:
        """提取发票号码"""
        m = _INVOICE_NUMBER_RE.search(text)
        return m.group(1) if m else None

    @staticmethod
    def _extract_invoice_code(text: str) -> Optional[str]:
        """提取发票代码"""
        m = _INVOICE_CODE_RE.search(text)
        return m.group(1) if m else None
