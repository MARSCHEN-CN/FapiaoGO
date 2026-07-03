# -*- coding: utf-8 -*-
"""
TableAnchor 系统

存储表格的定位信息（表头、合计、整个表格的 bbox），
用于替换不稳定的 segmenter.line_items 机制。

核心改进：
1. 存储 header_bbox, summary_bbox, table_bbox（不仅仅是 y 坐标）
2. 支持左右分栏布局的检测
3. 提供表格区域的精确边界，供列边界检测使用
"""

from dataclasses import dataclass, field
from typing import Optional, Tuple, List
import logging

# 使用绝对导入
from models import OCRDocument
from anchor_detector import AnchorCollection, Anchor


logger = logging.getLogger(__name__)


@dataclass
class TableAnchor:
    """
    表格锚点信息
    
    存储表格的三个关键边界：
    1. header_bbox: 表头区域的包围盒（项目名称、规格型号等）
    2. summary_bbox: 合计区域的包围盒（价税合计、合计等）
    3. table_bbox: 整个表格区域的包围盒（从表头到合计）
    """
    header_bbox: Optional[Tuple[float, float, float, float]] = None  # (x0, y0, x1, y1)
    summary_bbox: Optional[Tuple[float, float, float, float]] = None  # (x0, y0, x1, y1)
    table_bbox: Optional[Tuple[float, float, float, float]] = None   # (x0, y0, x1, y1)
    
    # 额外信息（用于调试和优化）
    header_anchor: Optional[Anchor] = None
    summary_anchor: Optional[Anchor] = None
    confidence: float = 1.0
    
    def is_valid(self) -> bool:
        """检查 TableAnchor 是否有效（至少包含 table_bbox）"""
        return self.table_bbox is not None
    
    def get_table_height(self) -> float:
        """获取表格高度"""
        if not self.table_bbox:
            return 0
        return self.table_bbox[3] - self.table_bbox[1]
    
    def get_table_width(self) -> float:
        """获取表格宽度"""
        if not self.table_bbox:
            return 0
        return self.table_bbox[2] - self.table_bbox[0]
    
    def contains_y(self, y: float) -> bool:
        """检查给定的 y 坐标是否在表格区域内"""
        if not self.table_bbox:
            return False
        return self.table_bbox[1] <= y <= self.table_bbox[3]
    
    def contains_point(self, x: float, y: float) -> bool:
        """检查给定的点是否在表格区域内"""
        if not self.table_bbox:
            return False
        x0, y0, x1, y1 = self.table_bbox
        return x0 <= x <= x1 and y0 <= y <= y1
    
    def to_dict(self) -> dict:
        """转换为字典（用于调试和日志）"""
        return {
            'header_bbox': self.header_bbox,
            'summary_bbox': self.summary_bbox,
            'table_bbox': self.table_bbox,
            'confidence': self.confidence
        }


@dataclass
class TableAnchorCollection:
    """表格锚点集合（支持多页发票）"""
    anchors: List[TableAnchor] = field(default_factory=list)
    
    def get_primary_anchor(self) -> Optional[TableAnchor]:
        """获取主要的表格锚点（第一个有效的）"""
        for anchor in self.anchors:
            if anchor.is_valid():
                return anchor
        return None
    
    def get_all_valid_anchors(self) -> List[TableAnchor]:
        """获取所有有效的表格锚点"""
        return [a for a in self.anchors if a.is_valid()]
    
    def add_anchor(self, anchor: TableAnchor):
        """添加一个表格锚点"""
        self.anchors.append(anchor)


class TableAnchorDetector:
    """表格锚点检测器"""
    
    def __init__(self, doc: OCRDocument, anchors: Optional[AnchorCollection] = None):
        """
        初始化表格锚点检测器
        
        Args:
            doc: OCR 文档对象
            anchors: 已检测的锚点集合（如果为 None，则自动检测）
        """
        self.doc = doc
        self.tokens = doc.tokens
        
        # 如果没有提供锚点，则自动检测
        if anchors is None:
            from .anchor_detector import AnchorDetector
            detector = AnchorDetector(doc)
            self.anchors = detector.detect()
        else:
            self.anchors = anchors
    
    def detect(self) -> TableAnchorCollection:
        """
        检测表格锚点
        
        Returns:
            TableAnchorCollection 对象
        """
        collection = TableAnchorCollection()
        
        # 创建主要的 TableAnchor
        table_anchor = TableAnchor()
        
        # 1. 设置 header_bbox
        if self.anchors.header:
            anchor = self.anchors.header
            table_anchor.header_bbox = anchor.bbox
            table_anchor.header_anchor = anchor
        
        # 2. 设置 summary_bbox
        if self.anchors.summary:
            anchor = self.anchors.summary
            table_anchor.summary_bbox = anchor.bbox
            table_anchor.summary_anchor = anchor
        
        # 3. 计算 table_bbox
        table_anchor.table_bbox = self._calculate_table_bbox(table_anchor)
        
        # 4. 添加到集合
        collection.add_anchor(table_anchor)
        
        # 日志记录
        logger.info(f"TableAnchor detection complete: "
                   f"header_bbox={table_anchor.header_bbox is not None}, "
                   f"summary_bbox={table_anchor.summary_bbox is not None}, "
                   f"table_bbox={table_anchor.table_bbox is not None}")
        
        return collection
    
    def _calculate_table_bbox(self, table_anchor: TableAnchor) -> Optional[Tuple[float, float, float, float]]:
        """
        计算整个表格的包围盒
        
        逻辑：
        1. 如果有 header_bbox 和 summary_bbox，则表格区域为两者之间的区域
        2. 如果只有 header_bbox，则表格区域从表头到底部（估算）
        3. 如果只有 summary_bbox，则表格区域从顶部到合计（估算）
        4. 如果都没有，则返回 None
        
        Returns:
            (x0, y0, x1, y1) 或 None
        """
        # 获取页面边界
        page_width = self._get_page_width()
        page_height = self._get_page_height()
        
        # 情况 1: 有 header_bbox 和 summary_bbox
        if table_anchor.header_bbox and table_anchor.summary_bbox:
            x0 = min(table_anchor.header_bbox[0], table_anchor.summary_bbox[0])
            y0 = table_anchor.header_bbox[1]
            x1 = max(table_anchor.header_bbox[2], table_anchor.summary_bbox[2])
            y1 = table_anchor.summary_bbox[3]
            return (x0, y0, x1, y1)
        
        # 情况 2: 只有 header_bbox
        if table_anchor.header_bbox:
            x0 = table_anchor.header_bbox[0]
            y0 = table_anchor.header_bbox[1]
            x1 = table_anchor.header_bbox[2]
            y1 = min(y0 + 300, page_height)  # 估算表格高度为 300
            return (x0, y0, x1, y1)
        
        # 情况 3: 只有 summary_bbox
        if table_anchor.summary_bbox:
            x0 = table_anchor.summary_bbox[0]
            y0 = max(table_anchor.summary_bbox[1] - 300, 0)  # 估算表格高度为 300
            x1 = table_anchor.summary_bbox[2]
            y1 = table_anchor.summary_bbox[3]
            return (x0, y0, x1, y1)
        
        # 情况 4: 都没有
        logger.warning("Cannot calculate table_bbox: no header or summary anchor found")
        return None
    
    def _get_page_height(self) -> float:
        """获取页面高度（基于 token 的最大 y1）"""
        if not self.tokens:
            return 800  # 默认值
        return max(token.y1 for token in self.tokens)
    
    def _get_page_width(self) -> float:
        """获取页面宽度（基于 token 的最大 x1）"""
        if not self.tokens:
            return 600  # 默认值
        return max(token.x1 for token in self.tokens)


def detect_table_anchors(doc: OCRDocument, 
                        anchors: Optional[AnchorCollection] = None) -> TableAnchorCollection:
    """
    便捷函数：检测文档中的表格锚点
    
    Args:
        doc: OCR 文档对象
        anchors: 锚点集合（如果为 None，则自动检测）
        
    Returns:
        TableAnchorCollection 对象
    """
    detector = TableAnchorDetector(doc, anchors)
    return detector.detect()
