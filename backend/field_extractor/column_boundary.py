# -*- coding: utf-8 -*-
"""
列边界检测器（ColumnBoundary）

实现基于 overlap_ratio 的单元格归属判定，替代传统的 center_x 方法。

核心改进：
1. 使用 overlap_ratio 替代 center_x 判定单元格归属
2. 当 overlap_ratio < 0.3 时，返回 None（不强制归属）
3. 未归属的 token 放入 orphan_tokens 池，供后续处理
4. 支持动态列边界调整（基于实际 token 分布）
"""

from dataclasses import dataclass, field
from typing import Optional, List, Dict, Tuple
import logging

# 使用绝对导入
from models import Token


logger = logging.getLogger(__name__)


# Overlap ratio 阈值：低于此值时，token 不归属任何列
OVERLAP_RATIO_THRESHOLD = 0.3


@dataclass
class ColumnBoundary:
    """
    列边界定义
    
    存储一列的边界信息和元数据
    """
    name: str                       # 列名（如 "xmmc", "ggxh", "dw", "sl", "dj", "je", "slv", "se"）
    x_min: float                    # 列左边界
    x_max: float                    # 列右边界
    source: str = 'auto'           # 来源（'auto' 自动检测, 'template' 模板定义, 'manual' 手动指定）
    
    # 额外信息（用于调试和优化）
    token_count: int = 0           # 该列中的 token 数量
    avg_token_width: float = 0.0   # 该列中 token 的平均宽度
    
    @property
    def width(self) -> float:
        """列宽度"""
        return self.x_max - self.x_min
    
    @property
    def center_x(self) -> float:
        """列中心 x 坐标"""
        return (self.x_min + self.x_max) / 2
    
    def contains_x(self, x: float) -> bool:
        """检查给定的 x 坐标是否在列边界内"""
        return self.x_min <= x <= self.x_max
    
    def calculate_overlap_ratio(self, token: Token) -> float:
        """
        计算 token 与该列的重叠比例
        
        公式：
            overlap = max(0, min(token.x1, x_max) - max(token.x0, x_min))
            ratio = overlap / (token.x1 - token.x0)
        
        Args:
            token: 要计算的 token
            
        Returns:
            overlap_ratio (0.0 ~ 1.0)
        """
        # 计算重叠宽度
        overlap_width = max(0, min(token.x1, self.x_max) - max(token.x0, self.x_min))
        
        # 计算 token 宽度
        token_width = token.x1 - token.x0
        
        if token_width == 0:
            return 0.0
        
        # 计算重叠比例
        ratio = overlap_width / token_width
        
        return ratio
    
    def to_dict(self) -> dict:
        """转换为字典（用于调试和日志）"""
        return {
            'name': self.name,
            'x_min': self.x_min,
            'x_max': self.x_max,
            'width': self.width,
            'source': self.source,
            'token_count': self.token_count
        }


@dataclass
class ColumnBoundarySet:
    """列边界集合（定义一个表格的所有列）"""
    columns: List[ColumnBoundary] = field(default_factory=list)
    
    def add_column(self, column: ColumnBoundary):
        """添加一列"""
        self.columns.append(column)
    
    def get_column(self, name: str) -> Optional[ColumnBoundary]:
        """按名称获取列"""
        for col in self.columns:
            if col.name == name:
                return col
        return None
    
    def get_column_names(self) -> List[str]:
        """获取所有列名"""
        return [col.name for col in self.columns]
    
    def to_dict(self) -> dict:
        """转换为字典"""
        return {
            'columns': [col.to_dict() for col in self.columns]
        }


class ColumnDetector:
    """列边界检测器"""
    
    def __init__(self, tokens: List[Token], table_bbox: Optional[Tuple[float, float, float, float]] = None):
        """
        初始化列边界检测器
        
        Args:
            tokens: 表格区域内的 token 列表
            table_bbox: 表格的包围盒 (x0, y0, x1, y1)
        """
        self.tokens = tokens
        self.table_bbox = table_bbox
    
    def detect(self) -> ColumnBoundarySet:
        """
        检测列边界
        
        默认实现：基于常见的发票明细表结构
        （项目名称、规格型号、单位、数量、单价、金额、税率、税额）
        
        Returns:
            ColumnBoundarySet 对象
        """
        # TODO: 实现自动列边界检测
        # 目前返回硬编码的默认值（应该基于实际 token 分布计算）
        
        columns = ColumnBoundarySet()
        
        # 硬编码的列边界（基于 A4 纸张宽度 600px 的假设）
        # 实际应该基于 table_bbox 和 token 分布计算
        columns.add_column(ColumnBoundary('xmmc', 0, 150, 'default'))
        columns.add_column(ColumnBoundary('ggxh', 150, 220, 'default'))
        columns.add_column(ColumnBoundary('dw', 220, 260, 'default'))
        columns.add_column(ColumnBoundary('sl', 260, 310, 'default'))
        columns.add_column(ColumnBoundary('dj', 310, 370, 'default'))
        columns.add_column(ColumnBoundary('je', 370, 430, 'default'))
        columns.add_column(ColumnBoundary('slv', 430, 470, 'default'))
        columns.add_column(ColumnBoundary('se', 470, 530, 'default'))
        
        logger.info(f"Column detection complete: {len(columns.columns)} columns detected")
        
        return columns


def cell_owner(token: Token, 
               columns: ColumnBoundarySet,
               overlap_threshold: float = OVERLAP_RATIO_THRESHOLD) -> Tuple[Optional[str], List[Token]]:
    """
    判定 token 归属哪一列（基于 overlap_ratio）
    
    核心逻辑：
    1. 计算 token 与每一列的 overlap_ratio
    2. 找出 overlap_ratio 最高的列
    3. 如果最高 overlap_ratio < threshold，返回 None（不归属任何列）
    4. 返回 (column_name, orphan_tokens)
    
    Args:
        token: 要判定的 token
        columns: 列边界集合
        overlap_threshold: overlap_ratio 阈值（默认 0.3）
        
    Returns:
        (column_name, orphan_tokens)
        - column_name: 归属的列名（如果无法归属，则为 None）
        - orphan_tokens: 未归属的 token 列表（目前只包含输入 token 本身）
    """
    if not columns or not columns.columns:
        return None, [token]
    
    # 计算 token 与每一列的 overlap_ratio
    ratios = []
    for col in columns.columns:
        ratio = col.calculate_overlap_ratio(token)
        ratios.append((col.name, ratio))
    
    # 找出最高的 overlap_ratio
    best_col_name, best_ratio = max(ratios, key=lambda x: x[1])
    
    # 判定是否归属
    if best_ratio < overlap_threshold:
        # overlap 太低，不归属任何列
        logger.debug(f"Token '{token.text}' has low overlap ratio ({best_ratio:.2f}), "
                    f"not assigned to any column")
        return None, [token]
    else:
        # 归属到最佳列
        logger.debug(f"Token '{token.text}' assigned to column '{best_col_name}' "
                    f"(overlap_ratio={best_ratio:.2f})")
        return best_col_name, []


def batch_cell_owner(tokens: List[Token], 
                     columns: ColumnBoundarySet,
                     overlap_threshold: float = OVERLAP_RATIO_THRESHOLD) -> Dict[str, List[Token]]:
    """
    批量判定 token 归属
    
    Args:
        tokens: token 列表
        columns: 列边界集合
        overlap_threshold: overlap_ratio 阈值
        
    Returns:
        字典：{column_name: [token_list]} + {'orphan': [orphan_token_list]}
    """
    result = {col.name: [] for col in columns.columns}
    result['orphan'] = []
    
    for token in tokens:
        col_name, _ = cell_owner(token, columns, overlap_threshold)
        if col_name:
            result[col_name].append(token)
        else:
            result['orphan'].append(token)
    
    return result
