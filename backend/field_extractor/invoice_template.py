# -*- coding: utf-8 -*-
"""
发票模板抽象（InvoiceTemplate）

为不同类型的发票提供模板化的配置和检测方法。

核心改进：
1. 使用类抽象替代硬编码的字典配置
2. 支持不同类型的发票（电子普票、电子专票、全电发票、机动车发票等）
3. 提供统一的方法来获取列边界、表头模式、合计模式等
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Tuple
import re
import logging

# 使用绝对导入
from column_boundary import ColumnBoundary, ColumnBoundarySet


logger = logging.getLogger(__name__)


@dataclass
class InvoiceTemplateConfig:
    """发票模板配置"""
    name: str                               # 模板名称
    invoice_type: str                      # 发票类型（电子普票、电子专票、全电发票、机动车发票）
    column_ratios: List[float] = None      # 列宽度比例（用于计算列边界）
    anchors: Dict[str, List[str]] = None   # 锚点模式（如 {"buyer": ["购买方", "购方"]}）
    
    def __post_init__(self):
        if self.column_ratios is None:
            # 默认列宽度比例（基于常见的发票明细表）
            self.column_ratios = [0.25, 0.12, 0.06, 0.10, 0.12, 0.12, 0.08, 0.15]
        
        if self.anchors is None:
            # 默认锚点模式
            self.anchors = {
                'buyer': ['购买方信息', '购方信息', '购买方', '购方'],
                'seller': ['销售方信息', '销方信息', '销售方', '销方'],
                'header': ['项目名称', '货物或应税劳务.*名称'],
                'summary': ['价税合计', '合计'],
                'remark': ['备注'],
            }


class InvoiceTemplate(ABC):
    """发票模板抽象基类"""
    
    def __init__(self, config: Optional[InvoiceTemplateConfig] = None):
        """
        初始化发票模板
        
        Args:
            config: 模板配置（如果为 None，则使用默认配置）
        """
        if config is None:
            config = InvoiceTemplateConfig(name=self.get_template_name())
        self.config = config
    
    @abstractmethod
    def get_template_name(self) -> str:
        """获取模板名称"""
        pass
    
    @abstractmethod
    def get_invoice_type(self) -> str:
        """获取发票类型"""
        pass
    
    def get_column_boundaries(self, 
                              table_width: float,
                              table_x0: float = 0) -> ColumnBoundarySet:
        """
        获取列边界定义
        
        Args:
            table_width: 表格宽度
            table_x0: 表格左边界（默认 0）
            
        Returns:
            ColumnBoundarySet 对象
        """
        columns = ColumnBoundarySet()
        column_names = ['xmmc', 'ggxh', 'dw', 'sl', 'dj', 'je', 'slv', 'se']
        
        # 基于列宽度比例计算列边界
        if self.config.column_ratios and len(self.config.column_ratios) == len(column_names):
            x = table_x0
            for i, (name, ratio) in enumerate(zip(column_names, self.config.column_ratios)):
                width = table_width * ratio
                columns.add_column(ColumnBoundary(
                    name=name,
                    x_min=x,
                    x_max=x + width,
                    source='template'
                ))
                x += width
        else:
            # 使用默认列边界
            default_width = table_width / len(column_names)
            x = table_x0
            for name in column_names:
                columns.add_column(ColumnBoundary(
                    name=name,
                    x_min=x,
                    x_max=x + default_width,
                    source='default'
                ))
                x += default_width
        
        return columns
    
    def get_header_patterns(self) -> List[str]:
        """
        获取表头锚点的匹配模式
        
        Returns:
            正则表达式模式列表
        """
        return self.config.anchors.get('header', ['项目名称'])
    
    def get_summary_patterns(self) -> List[str]:
        """
        获取合计锚点的匹配模式
        
        Returns:
            正则表达式模式列表
        """
        return self.config.anchors.get('summary', ['价税合计', '合计'])
    
    def get_buyer_patterns(self) -> List[str]:
        """
        获取购买方锚点的匹配模式
        
        Returns:
            正则表达式模式列表
        """
        return self.config.anchors.get('buyer', ['购买方', '购方'])
    
    def get_seller_patterns(self) -> List[str]:
        """
        获取销售方锚点的匹配模式
        
        Returns:
            正则表达式模式列表
        """
        return self.config.anchors.get('seller', ['销售方', '销方'])
    
    def get_remark_patterns(self) -> List[str]:
        """
        获取备注锚点的匹配模式
        
        Returns:
            正则表达式模式列表
        """
        return self.config.anchors.get('remark', ['备注'])
    
    def detect_invoice_type(self, doc_text: str) -> float:
        """
        检测文档是否匹配此模板
        
        Args:
            doc_text: 文档文本
            
        Returns:
            匹配置信度（0.0 ~ 1.0）
        """
        # 默认实现：基于关键词匹配
        # 子类可以重写此方法以提供更复杂的检测逻辑
        return 0.5
    
    def to_dict(self) -> dict:
        """转换为字典（用于调试和日志）"""
        return {
            'name': self.config.name,
            'invoice_type': self.get_invoice_type(),
            'column_count': len(self.config.column_ratios) if self.config.column_ratios else 0,
            'anchors': {k: v for k, v in self.config.anchors.items()}
        }


# ═══════════════════════════════════════════════════════
#  具体模板实现
# ═══════════════════════════════════════════════════════

class ElectronicCommonTemplate(InvoiceTemplate):
    """电子普通发票模板"""
    
    def get_template_name(self) -> str:
        return "ElectronicCommon"
    
    def get_invoice_type(self) -> str:
        return "电子普通发票"
    
    def __init__(self):
        config = InvoiceTemplateConfig(
            name="ElectronicCommon",
            invoice_type="电子普通发票",
            column_ratios=[0.25, 0.12, 0.06, 0.10, 0.12, 0.12, 0.08, 0.15],
            anchors={
                'buyer': ['购买方信息', '购方信息', '购买方', '购方'],
                'seller': ['销售方信息', '销方信息', '销售方', '销方'],
                'header': ['项目名称', '货物或应税劳务.*名称'],
                'summary': ['价税合计', '合计'],
                'remark': ['备注'],
            }
        )
        super().__init__(config)


class ElectronicSpecialTemplate(InvoiceTemplate):
    """电子增值税专用发票模板"""
    
    def get_template_name(self) -> str:
        return "ElectronicSpecial"
    
    def get_invoice_type(self) -> str:
        return "电子增值税专用发票"
    
    def __init__(self):
        config = InvoiceTemplateConfig(
            name="ElectronicSpecial",
            invoice_type="电子增值税专用发票",
            column_ratios=[0.25, 0.12, 0.06, 0.10, 0.12, 0.12, 0.08, 0.15],
            anchors={
                'buyer': ['购买方信息', '购方信息', '购买方', '购方'],
                'seller': ['销售方信息', '销方信息', '销售方', '销方'],
                'header': ['项目名称', '规格型号', '单位', '数量', '单价', '金额', '税率', '税额'],
                'summary': ['价税合计', '合计'],
                'remark': ['备注'],
            }
        )
        super().__init__(config)


class DigitalInvoiceTemplate(InvoiceTemplate):
    """全电发票（数字化电子发票）模板"""
    
    def get_template_name(self) -> str:
        return "DigitalInvoice"
    
    def get_invoice_type(self) -> str:
        return "全电发票"
    
    def __init__(self):
        config = InvoiceTemplateConfig(
            name="DigitalInvoice",
            invoice_type="全电发票",
            column_ratios=[0.25, 0.12, 0.06, 0.10, 0.12, 0.12, 0.08, 0.15],
            anchors={
                'buyer': ['购买方信息', '购方信息'],
                'seller': ['销售方信息', '销方信息'],
                'header': ['项目名称', '规格型号', '单位', '数量', '单价', '金额', '税率/征收率', '税额'],
                'summary': ['价税合计'],
                'remark': ['备注'],
            }
        )
        super().__init__(config)
    
    def detect_invoice_type(self, doc_text: str) -> float:
        """全电发票的特定检测逻辑"""
        if '数字化电子发票' in doc_text or '全电发票' in doc_text:
            return 0.95
        return 0.3


class MotorVehicleTemplate(InvoiceTemplate):
    """机动车销售统一发票模板"""
    
    def get_template_name(self) -> str:
        return "MotorVehicle"
    
    def get_invoice_type(self) -> str:
        return "机动车销售统一发票"
    
    def __init__(self):
        config = InvoiceTemplateConfig(
            name="MotorVehicle",
            invoice_type="机动车销售统一发票",
            column_ratios=[0.30, 0.15, 0.10, 0.15, 0.15, 0.15],
            anchors={
                'buyer': ['购买方', '购货单位'],
                'seller': ['销售方', '销货单位'],
                'header': ['车辆类型', '厂牌型号', '发动机号', '车架号'],
                'summary': ['合计', '总金额'],
                'remark': ['备注'],
            }
        )
        super().__init__(config)


# ═══════════════════════════════════════════════════════
#  模板工厂
# ═══════════════════════════════════════════════════════

class InvoiceTemplateFactory:
    """发票模板工厂"""
    
    # 注册所有可用的模板
    TEMPLATES = {
        'ElectronicCommon': ElectronicCommonTemplate,
        'ElectronicSpecial': ElectronicSpecialTemplate,
        'DigitalInvoice': DigitalInvoiceTemplate,
        'MotorVehicle': MotorVehicleTemplate,
    }
    
    @classmethod
    def create_template(cls, template_name: str) -> Optional[InvoiceTemplate]:
        """
        根据模板名称创建模板
        
        Args:
            template_name: 模板名称
            
        Returns:
            InvoiceTemplate 对象或 None
        """
        template_class = cls.TEMPLATES.get(template_name)
        if template_class:
            return template_class()
        else:
            logger.warning(f"Unknown template name: {template_name}")
            return None
    
    @classmethod
    def detect_best_template(cls, doc_text: str) -> InvoiceTemplate:
        """
        自动检测最适合的模板
        
        Args:
            doc_text: 文档文本
            
        Returns:
            最适合的 InvoiceTemplate 对象
        """
        best_template = None
        best_confidence = 0.0
        
        for template_name, template_class in cls.TEMPLATES.items():
            template = template_class()
            confidence = template.detect_invoice_type(doc_text)
            
            if confidence > best_confidence:
                best_confidence = confidence
                best_template = template
        
        if best_template is None:
            # 默认返回电子普通发票模板
            best_template = ElectronicCommonTemplate()
        
        logger.info(f"Best template detected: {best_template.get_template_name()} "
                   f"(confidence={best_confidence:.2f})")
        
        return best_template
    
    @classmethod
    def get_all_templates(cls) -> List[InvoiceTemplate]:
        """获取所有可用的模板"""
        return [template_class() for template_class in cls.TEMPLATES.values()]


def get_template_for_invoice(doc: 'OCRDocument') -> InvoiceTemplate:
    """
    便捷函数：为发票文档获取最适合的模板
    
    Args:
        doc: OCR 文档对象
        
    Returns:
        InvoiceTemplate 对象
    """
    # 使用文档文本进行模板检测
    doc_text = doc.collapsed if doc.collapsed else doc.raw
    return InvoiceTemplateFactory.detect_best_template(doc_text)
