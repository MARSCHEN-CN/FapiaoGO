"""
文档解析器插件架构

提供统一的解析器接口，支持 PDF、图片、OFD、XML 等多种格式的插件化解析。
"""

from .base import BaseParser, ParserRegistry, ParseResult
from .pdf_text import PdfTextParser
from .pdf_ocr import PdfOcrParser
from .ofd import OfdParser
from .xml import XmlParser

# 创建全局解析器注册表
registry = ParserRegistry()

# 注册默认解析器（按优先级排序）
registry.register(XmlParser())        # XML 优先级最高（结构化数据）
registry.register(OfdParser())        # OFD 次之（结构化数据）
registry.register(PdfTextParser())    # 文本型 PDF
registry.register(PdfOcrParser())     # 扫描型 PDF（OCR）

__all__ = [
    'BaseParser',
    'ParserRegistry',
    'ParseResult',
    'PdfTextParser',
    'PdfOcrParser',
    'OfdParser',
    'XmlParser',
    'registry',
]
