# -*- coding: utf-8 -*-
"""
锚点检测器（AnchorDetector）

检测发票中的关键锚点（购买方、销售方、项目名称、价税合计、备注），
为 RegionBuilder 提供区域划分的依据。

核心改进：
1. 锚点存储 bbox 而不仅仅是 y 坐标
2. 支持左右分栏布局的检测
3. 返回结构化的锚点信息供 RegionBuilder 使用
"""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Tuple
import re
import logging

# 使用绝对导入
from models import OCRDocument

logger = logging.getLogger(__name__)


@dataclass
class Anchor:
    """锚点信息"""
    name: str           # 锚点名称（如 "buyer", "seller", "header", "summary", "remark"）
    text: str           # 锚点匹配的文本（如 "购买方", "价税合计"）
    x0: float           # 锚点包围盒
    y0: float
    x1: float
    y1: float
    page: int = 0       # 页码
    confidence: float = 1.0  # 置信度
    
    @property
    def bbox(self) -> Tuple[float, float, float, float]:
        """返回包围盒 (x0, y0, x1, y1)"""
        return (self.x0, self.y0, self.x1, self.y1)
    
    @property
    def cy(self) -> float:
        """中心点 y 坐标"""
        return (self.y0 + self.y1) / 2
    
    @property
    def cx(self) -> float:
        """中心点 x 坐标"""
        return (self.x0 + self.x1) / 2


@dataclass
class AnchorCollection:
    """锚点集合，包含所有检测到的锚点"""
    buyer: Optional[Anchor] = None      # 购买方锚点
    seller: Optional[Anchor] = None      # 销售方锚点
    header: Optional[Anchor] = None     # 表头锚点（项目名称）
    summary: Optional[Anchor] = None    # 合计锚点（价税合计）
    remark: Optional[Anchor] = None      # 备注锚点
    
    # 额外锚点（用于精细定位）
    footer: Optional[Anchor] = None      # 页脚锚点（收款人、复核人、开票人）
    
    def get_all_anchors(self) -> List[Anchor]:
        """返回所有非 None 的锚点"""
        return [a for a in [self.buyer, self.seller, self.header, 
                           self.summary, self.remark, self.footer] 
                if a is not None]
    
    def get_sorted_by_y(self) -> List[Anchor]:
        """按 y 坐标排序的所有锚点"""
        return sorted(self.get_all_anchors(), key=lambda a: a.y0)
    
    def find_anchor_at_y(self, y: float, tolerance: float = 10.0) -> Optional[Anchor]:
        """查找指定 y 坐标附近的锚点"""
        for anchor in self.get_all_anchors():
            if abs(anchor.y0 - y) <= tolerance:
                return anchor
        return None


class AnchorDetector:
    """锚点检测器"""
    
    # 锚点匹配模式
    BUYER_PATTERNS = [
        r'购买方信息', r'购方信息', r'购买方', r'购方'
    ]
    SELLER_PATTERNS = [
        r'销售方信息', r'销方信息', r'销售方', r'销方'
    ]
    HEADER_PATTERNS = [
        r'项目名称', r'货物或应税劳务.*名称', r'服务.*名称'
    ]
    SUMMARY_PATTERNS = [
        r'价税合计', r'合计'
    ]
    REMARK_PATTERNS = [
        r'^备注$', r'^备注：', r'^备注:'
    ]
    FOOTER_PATTERNS = [
        r'收款人', r'复核人', r'开票人'
    ]
    
    def __init__(self, doc: OCRDocument):
        """
        初始化锚点检测器
        
        Args:
            doc: OCR 文档对象
        """
        self.doc = doc
        self.tokens = doc.tokens
        
    def detect(self) -> AnchorCollection:
        """
        检测所有锚点
        
        Returns:
            AnchorCollection 对象
        """
        anchors = AnchorCollection()
        
        # 检测各个锚点
        anchors.buyer = self._detect_buyer_anchor()
        anchors.seller = self._detect_seller_anchor()
        anchors.header = self._detect_header_anchor()
        anchors.summary = self._detect_summary_anchor()
        anchors.remark = self._detect_remark_anchor()
        anchors.footer = self._detect_footer_anchor()
        
        # 日志记录
        logger.info(f"Anchor detection complete: "
                   f"buyer={anchors.buyer is not None}, "
                   f"seller={anchors.seller is not None}, "
                   f"header={anchors.header is not None}, "
                   f"summary={anchors.summary is not None}, "
                   f"remark={anchors.remark is not None}")
        
        return anchors
    
    def _detect_buyer_anchor(self) -> Optional[Anchor]:
        """检测购买方锚点"""
        return self._detect_anchor_by_patterns(
            patterns=self.BUYER_PATTERNS,
            anchor_name='buyer',
            priority=True
        )
    
    def _detect_seller_anchor(self) -> Optional[Anchor]:
        """检测销售方锚点"""
        return self._detect_anchor_by_patterns(
            patterns=self.SELLER_PATTERNS,
            anchor_name='seller',
            priority=True
        )
    
    def _detect_header_anchor(self) -> Optional[Anchor]:
        """检测表头锚点（项目名称）"""
        return self._detect_anchor_by_patterns(
            patterns=self.HEADER_PATTERNS,
            anchor_name='header',
            priority=False
        )
    
    def _detect_summary_anchor(self) -> Optional[Anchor]:
        """检测合计锚点（价税合计）"""
        return self._detect_anchor_by_patterns(
            patterns=self.SUMMARY_PATTERNS,
            anchor_name='summary',
            priority=False
        )
    
    def _detect_remark_anchor(self) -> Optional[Anchor]:
        """检测备注锚点"""
        return self._detect_anchor_by_patterns(
            patterns=self.REMARK_PATTERNS,
            anchor_name='remark',
            priority=False
        )
    
    def _detect_footer_anchor(self) -> Optional[Anchor]:
        """检测页脚锚点（取第一个：收款人/复核人/开票人）"""
        return self._detect_anchor_by_patterns(
            patterns=self.FOOTER_PATTERNS,
            anchor_name='footer',
            priority=False
        )
    
    def _detect_anchor_by_patterns(self, patterns: List[str], 
                                   anchor_name: str,
                                   priority: bool = False) -> Optional[Anchor]:
        """
        根据模式列表检测锚点
        
        Args:
            patterns: 正则表达式模式列表
            anchor_name: 锚点名称
            priority: 是否优先选择（用于购买方/销售方等关键锚点）
            
        Returns:
            Anchor 对象或 None
        """
        candidates = []
        
        for token in self.tokens:
            for pattern in patterns:
                if re.search(pattern, token.text):
                    # 找到匹配
                    anchor = Anchor(
                        name=anchor_name,
                        text=token.text,
                        x0=token.x,
                        y0=token.y,
                        x1=token.x1,
                        y1=token.y1,
                        page=0,
                        confidence=1.0
                    )
                    candidates.append(anchor)
                    break
        
        if not candidates:
            logger.warning(f"No {anchor_name} anchor found")
            return None
        
        # 如果有多个候选，选择最佳的一个
        if len(candidates) == 1:
            return candidates[0]
        
        # 多个候选时的选择策略
        if priority:
            # 关键锚点：选择最明显的（通常是完整的 "购买方信息" 而不是 "购买方"）
            for candidate in candidates:
                for pattern in patterns:
                    if re.fullmatch(pattern, candidate.text):
                        return candidate
            
        # 默认返回第一个（按文档顺序）
        return candidates[0]
    
    def _detect_anchor_by_keywords(self, keywords: List[str], 
                                   anchor_name: str) -> Optional[Anchor]:
        """
        根据关键词列表检测锚点（精确匹配）
        
        Args:
            keywords: 关键词列表
            anchor_name: 锚点名称
            
        Returns:
            Anchor 对象或 None
        """
        for token in self.tokens:
            if token.text in keywords:
                return Anchor(
                    name=anchor_name,
                    text=token.text,
                    x0=token.x,
                    y0=token.y,
                    x1=token.x1,
                    y1=token.y1,
                    page=0,
                    confidence=1.0
                )
        
        return None


def detect_anchors(doc: OCRDocument) -> AnchorCollection:
    """
    便捷函数：检测文档中的所有锚点
    
    Args:
        doc: OCR 文档对象
        
    Returns:
        AnchorCollection 对象
    """
    detector = AnchorDetector(doc)
    return detector.detect()
