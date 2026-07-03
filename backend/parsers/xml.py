"""
XML 解析器

解析 XML 格式的电子发票。
"""

import io
from .base import BaseParser, ParseResult, FileMeta
from xml_parser import parse_xml


class XmlParser(BaseParser):
    """XML 解析器
    
    解析 XML 格式的电子发票，提取结构化数据。
    """
    
    name = 'xml'
    supported_exts = ['xml']
    priority = 5  # 最高优先级（结构化数据）
    
    def parse(self, meta: FileMeta, options: dict = None) -> ParseResult:
        """解析 XML 文件
        
        Args:
            meta: 文件元信息
            options: 解析选项（未使用）
        
        Returns:
            ParseResult: 解析结果
        """
        options = options or {}
        
        # 创建 file-like object
        file_obj = io.BytesIO(meta.raw_bytes)
        file_obj.name = meta.filename
        
        try:
            result = parse_xml(file_obj)
            
            if result:
                return ParseResult(
                    text=result.get('text', ''),
                    invoice_type=result.get('invoice_type', '其他'),
                    invoice_number=result.get('invoice_number', '未知号码'),
                    amount=result.get('amount', '0.00'),
                    invoice_date=result.get('invoice_date', '未知日期'),
                    preview_image=result.get('preview_image'),
                    parse_method='XML 解析',
                    source_type='xml',
                    used_ocr=False,
                )
        except Exception as e:
            self._logger.error("XML 解析失败: %s", e)
        
        return ParseResult(
            parse_method='XML 解析失败',
            source_type='xml',
        )
