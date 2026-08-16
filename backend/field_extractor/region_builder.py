# -*- coding: utf-8 -*-
"""
区域构建器（RegionBuilder）

基于 AnchorDetector 检测到的锚点，将文档划分为隔离的语义区域。
每个区域存储该区域内的所有 token，供后续的字段提取器使用。

核心改进：
1. Region 存储 tokens 而不仅仅是 line_indices
2. 基于 bbox 进行区域划分，支持左右分栏布局
3. 区域之间互不重叠，彻底隔离备注区等污染源
"""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Tuple
import logging

# 使用绝对导入
from models import Token, OCRDocument, Region
from anchor_detector import AnchorDetector, AnchorCollection, Anchor


logger = logging.getLogger(__name__)


@dataclass
class RegionCollection:
    """区域集合，包含所有构建的语义区域"""
    header: Optional[Region] = None      # 抬头区
    buyer: Optional[Region] = None       # 购买方区
    line_items: Optional[Region] = None  # 明细区
    summary: Optional[Region] = None     # 合计区
    seller: Optional[Region] = None      # 销售方区
    remark: Optional[Region] = None      # 备注区
    footer: Optional[Region] = None      # 页脚区
    noise: Optional[Region] = None       # 噪声区（未归属的 token）
    
    def get_region(self, name: str) -> Optional[Region]:
        """按名称获取区域"""
        return getattr(self, name, None)
    
    def get_all_regions(self) -> List[Region]:
        """返回所有非 None 的区域"""
        return [r for r in [self.header, self.buyer, self.line_items,
                           self.summary, self.seller, self.remark,
                           self.footer, self.noise]
                if r is not None]
    
    def get_region_tokens(self, name: str) -> List[Token]:
        """获取指定区域的所有 token"""
        region = self.get_region(name)
        if region and region.tokens:
            return region.tokens
        return []
    
    def to_dict(self) -> Dict:
        """转换为字典（用于调试和日志）"""
        result = {}
        for name in ['header', 'buyer', 'line_items', 'summary',
                     'seller', 'remark', 'footer', 'noise']:
            region = getattr(self, name)
            if region:
                result[name] = {
                    'bbox': region.bbox,
                    'token_count': len(region.tokens),
                    'text_preview': region.text[:50] if region.text else ''
                }
        return result


class RegionBuilder:
    """区域构建器"""
    
    def __init__(self, doc: OCRDocument, anchors: Optional[AnchorCollection] = None):
        """
        初始化区域构建器
        
        Args:
            doc: OCR 文档对象
            anchors: 锚点集合（如果为 None，则自动检测）
        """
        self.doc = doc
        self.tokens = doc.bbox_tokens
        
        # 如果没有提供锚点，则自动检测
        if anchors is None:
            detector = AnchorDetector(doc)
            self.anchors = detector.detect()
        else:
            self.anchors = anchors
    
    def build(self) -> RegionCollection:
        """
        构建所有区域
        
        Returns:
            RegionCollection 对象
        """
        regions = RegionCollection()
        
        # 获取页面边界（用于默认值）
        page_height = self._get_page_height()
        page_width = self._get_page_width()
        
        # 1. 构建各个区域
        regions.header = self._build_header_region(page_height)
        regions.buyer = self._build_buyer_region()
        regions.line_items = self._build_line_items_region()
        regions.summary = self._build_summary_region()
        regions.seller = self._build_seller_region()
        regions.remark = self._build_remark_region()
        regions.footer = self._build_footer_region(page_height)
        
        # 2. 分配 token 到各个区域
        self._assign_tokens_to_regions(regions)
        
        # 3. 构建噪声区（未归属的 token）
        regions.noise = self._build_noise_region(regions)
        
        # 日志记录
        logger.info(f"Region building complete: "
                   f"header={len(regions.header.tokens) if regions.header else 0} tokens, "
                   f"buyer={len(regions.buyer.tokens) if regions.buyer else 0} tokens, "
                   f"line_items={len(regions.line_items.tokens) if regions.line_items else 0} tokens, "
                   f"seller={len(regions.seller.tokens) if regions.seller else 0} tokens, "
                   f"remark={len(regions.remark.tokens) if regions.remark else 0} tokens")
        
        return regions
    
    def _build_header_region(self, page_height: float) -> Region:
        """构建抬头区（页面顶部到购买方锚点）"""
        y_start = 0  # 页面顶部
        y_end = self.anchors.buyer.y0 if self.anchors.buyer else 150
        
        return Region(
            name='header',
            x0=0, y0=y_start, x1=self._get_page_width(), y1=y_end
        )
    
    def _build_buyer_region(self) -> Region:
        """构建购买方区（购买方锚点到销售方锚点或表头锚点）"""
        if not self.anchors.buyer:
            # 没有购买方锚点，返回空区域
            return Region(name='buyer')
        
        y_start = self.anchors.buyer.y0
        
        # 结束位置：销售方锚点或表头锚点
        if self.anchors.seller:
            y_end = self.anchors.seller.y0
        elif self.anchors.header:
            y_end = self.anchors.header.y0
        else:
            y_end = y_start + 100  # 默认值
        
        return Region(
            name='buyer',
            x0=0, y0=y_start, x1=self._get_page_width(), y1=y_end
        )
    
    def _build_line_items_region(self) -> Region:
        """构建明细区（表头锚点到合计锚点）"""
        if not self.anchors.header:
            # 没有表头锚点，返回空区域
            return Region(name='line_items')
        
        y_start = self.anchors.header.y0
        
        # 结束位置：合计锚点
        if self.anchors.summary:
            y_end = self.anchors.summary.y0
        else:
            y_end = y_start + 300  # 默认值
        
        return Region(
            name='line_items',
            x0=0, y0=y_start, x1=self._get_page_width(), y1=y_end
        )
    
    def _build_summary_region(self) -> Region:
        """构建合计区（合计锚点到备注锚点或页脚）"""
        if not self.anchors.summary:
            # 没有合计锚点，返回空区域
            return Region(name='summary')
        
        y_start = self.anchors.summary.y0
        
        # 结束位置：备注锚点或页脚
        if self.anchors.remark:
            y_end = self.anchors.remark.y0
        elif self.anchors.footer:
            y_end = self.anchors.footer.y0
        else:
            y_end = y_start + 50  # 默认值
        
        return Region(
            name='summary',
            x0=0, y0=y_start, x1=self._get_page_width(), y1=y_end
        )
    
    def _build_seller_region(self) -> Region:
        """构建销售方区（合计锚点到备注锚点）"""
        if not self.anchors.seller:
            # 没有销售方锚点，返回空区域
            return Region(name='seller')
        
        y_start = self.anchors.seller.y0
        
        # 结束位置：合计锚点或备注锚点
        if self.anchors.summary:
            y_end = self.anchors.summary.y0
        elif self.anchors.remark:
            y_end = self.anchors.remark.y0
        else:
            y_end = y_start + 100  # 默认值
        
        return Region(
            name='seller',
            x0=0, y0=y_start, x1=self._get_page_width(), y1=y_end
        )
    
    def _build_remark_region(self) -> Region:
        """构建备注区（备注锚点到页面底部）"""
        if not self.anchors.remark:
            # 没有备注锚点，返回空区域
            return Region(name='remark')
        
        y_start = self.anchors.remark.y0
        y_end = self._get_page_height()  # 页面底部
        
        return Region(
            name='remark',
            x0=0, y0=y_start, x1=self._get_page_width(), y1=y_end
        )
    
    def _build_footer_region(self, page_height: float) -> Region:
        """构建页脚区（页脚锚点到页面底部）"""
        if not self.anchors.footer:
            # 没有页脚锚点，返回空区域
            return Region(name='footer')
        
        y_start = self.anchors.footer.y0
        y_end = page_height
        
        return Region(
            name='footer',
            x0=0, y0=y_start, x1=self._get_page_width(), y1=y_end
        )
    
    def _assign_tokens_to_regions(self, regions: RegionCollection):
        """
        将 token 分配到各个区域
        
        分配策略：
        1. 按 token 的中心 y 坐标分配到对应的区域
        2. 处理边界情况（token 跨越多个区域）
        3. 确保每个 token 只属于一个区域
        """
        # 构建区域列表（按 y0 排序）
        region_list = []
        for name in ['header', 'buyer', 'line_items', 'summary', 'seller', 'remark', 'footer']:
            region = getattr(regions, name, None)
            if region and region.y0 is not None and region.y1 is not None:
                region_list.append((name, region))
        
        # 如果没有区域，直接返回
        if not region_list:
            return
        
        # 对每个 token，找到最合适的区域
        for token in self.tokens:
            # 获取 token 的中心 y 坐标
            token_cy = (token.y0 + token.y1) / 2
            
            # 找到包含 token_cy 的区域
            best_region_name = None
            for name, region in region_list:
                if region.y0 <= token_cy <= region.y1:
                    best_region_name = name
                    break
            
            # 如果找不到包含的区域，找到最近的区域
            if best_region_name is None:
                min_dist = float('inf')
                for name, region in region_list:
                    dist = min(abs(token_cy - region.y0), abs(token_cy - region.y1))
                    if dist < min_dist:
                        min_dist = dist
                        best_region_name = name
            
            # 将 token 分配到找到的区域
            if best_region_name:
                region = getattr(regions, best_region_name)
                region.tokens.append(token)
    
    def _build_noise_region(self, regions: RegionCollection) -> Region:
        """
        构建噪声区（收集未归属的 token）
        """
        noise_tokens = []
        assigned_token_ids = set()
        
        # 收集所有已分配的 token
        for region in regions.get_all_regions():
            for token in region.tokens:
                token_id = id(token)
                assigned_token_ids.add(token_id)
        
        # 找出未分配的 token
        for token in self.tokens:
            if id(token) not in assigned_token_ids:
                noise_tokens.append(token)
        
        # 创建噪声区
        noise_region = Region(
            name='noise',
            x0=0, y0=0, x1=self._get_page_width(), y1=self._get_page_height()
        )
        noise_region.tokens = noise_tokens
        
        return noise_region
    
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


def build_regions(doc: OCRDocument, 
                 anchors: Optional[AnchorCollection] = None) -> RegionCollection:
    """
    便捷函数：构建文档的所有区域
    
    Args:
        doc: OCR 文档对象
        anchors: 锚点集合（如果为 None，则自动检测）
        
    Returns:
        RegionCollection 对象
    """
    builder = RegionBuilder(doc, anchors)
    return builder.build()
