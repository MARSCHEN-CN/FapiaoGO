"""
OFD 解析器

解析 OFD（Open Fixed-layout Document）格式的电子发票。
"""

import io
from .base import BaseParser, ParseResult, FileMeta
from ofd_parser import parse_ofd


class OfdParser(BaseParser):
    """OFD 解析器
    
    解析 OFD 格式的电子发票，提取结构化数据。
    OFD 是中国电子发票的标准格式。
    """
    
    name = 'ofd'
    supported_exts = ['ofd']
    priority = 10  # 优先级很高（结构化数据）
    
    def parse(self, meta: FileMeta, options: dict = None) -> ParseResult:
        """解析 OFD 文件
        
        Args:
            meta: 文件元信息
            options: 解析选项（未使用）
        
        Returns:
            ParseResult: 解析结果
        """
        options = options or {}
        
        # 创建 file-like object
        file_obj = io.BytesIO(meta.raw_bytes)
        file_obj.name = meta.filename  # 某些解析器需要文件名
        
        try:
            result = parse_ofd(file_obj)
            
            if result:
                return ParseResult(
                    text=result.get('text', ''),
                    invoice_type=result.get('invoice_type', '其他'),
                    invoice_number=result.get('invoice_number', '未知号码'),
                    amount=result.get('amount', '0.00'),
                    invoice_date=result.get('invoice_date', '未知日期'),
                    preview_image=result.get('preview_image'),
                    parse_method='OFD 解析',
                    source_type='ofd',
                    used_ocr=False,
                )
        except Exception as e:
            self._logger.error("OFD 解析失败: %s", e)
        
        return ParseResult(
            parse_method='OFD 解析失败',
            source_type='ofd',
        )
