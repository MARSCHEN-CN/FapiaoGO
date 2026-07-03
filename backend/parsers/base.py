"""
解析器基类和注册表

定义统一的解析器接口，支持插件化扩展。
"""

import time
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional, Tuple

logger = logging.getLogger(__name__)


@dataclass
class ParseResult:
    """解析结果数据结构"""
    # 基础字段
    text: str = ''                          # 提取的文本
    invoice_type: str = '其他'              # 发票类型
    invoice_number: str = '未知号码'        # 发票号码
    amount: str = '0.00'                    # 金额
    invoice_date: str = '未知日期'          # 开票日期
    
    # OCR 相关
    bbox_data: List[Dict] = field(default_factory=list)  # OCR bbox 坐标
    preview_image: Optional[str] = None     # 预览图（base64）
    # [PERF] 由 extract_text_from_bytes 返回的每页原始 words 元组列表
    # 供下游（如 PdfBboxParser）直接复用，避免对同一页面再次调用 get_text("words")
    # 元素结构: (x0, y0, x1, y1, word_text, block_no, line_no, word_no)
    words_data: List[List[Any]] = field(default_factory=list)
    
    # 解析元信息
    parse_method: str = ''                  # 解析方式描述
    source_type: str = ''                   # 来源类型：pdf_text / pdf_ocr / image / ofd / xml
    used_ocr: bool = False                  # 是否使用了 OCR
    from_cache: bool = False                # 是否来自缓存
    
    # PDF 文档引用（调用方负责关闭）
    pdf_doc: Any = None                     # 已打开的 fitz.Document
    
    # 性能指标
    elapsed_ms: float = 0                   # 解析耗时（毫秒）
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式（不含 pdf_doc 引用）"""
        return {
            'text': self.text,
            'invoice_type': self.invoice_type,
            'invoice_number': self.invoice_number,
            'amount': self.amount,
            'invoice_date': self.invoice_date,
            'bbox_data': self.bbox_data,
            'preview_image': self.preview_image,
            'parse_method': self.parse_method,
            'source_type': self.source_type,
            'used_ocr': self.used_ocr,
            'from_cache': self.from_cache,
            'elapsed_ms': self.elapsed_ms,
        }


@dataclass
class FileMeta:
    """文件元信息"""
    filename: str
    raw_bytes: bytes
    mime_type: Optional[str] = None
    extension: Optional[str] = None
    
    @property
    def ext(self) -> str:
        """获取文件扩展名（小写，不含点）"""
        if self.extension:
            return self.extension.lower().lstrip('.')
        if '.' in self.filename:
            return self.filename.rsplit('.', 1)[1].lower()
        return ''


class BaseParser(ABC):
    """解析器基类
    
    所有具体解析器必须实现：
    - can_parse(): 判断是否能解析该文件
    - parse(): 执行解析
    """
    
    # 解析器名称（用于日志和调试）
    name: str = 'base'
    
    # 支持的文件扩展名（子类可覆盖）
    supported_exts: List[str] = []
    
    # 解析器优先级（数值越小优先级越高）
    priority: int = 100
    
    def __init__(self):
        self._logger = logging.getLogger(f'{__name__}.{self.name}')
    
    def can_parse(self, meta: FileMeta) -> bool:
        """判断是否能解析该文件
        
        默认实现：检查扩展名是否在 supported_exts 中。
        子类可覆盖以实现更复杂的检测逻辑。
        """
        return meta.ext in self.supported_exts
    
    @abstractmethod
    def parse(self, meta: FileMeta, options: Dict[str, Any] = None) -> ParseResult:
        """执行解析
        
        Args:
            meta: 文件元信息
            options: 解析选项，如：
                - auto_orient: 是否自动纠正图片方向
                - force_ocr: 是否强制 OCR
        
        Returns:
            ParseResult: 解析结果
        """
        pass
    
    def _timeit(self, func, *args, **kwargs) -> Tuple[Any, float]:
        """计时辅助方法"""
        start = time.perf_counter()
        result = func(*args, **kwargs)
        elapsed_ms = (time.perf_counter() - start) * 1000
        return result, elapsed_ms


class ParserRegistry:
    """解析器注册表
    
    管理所有解析器，提供统一的解析入口。
    """
    
    def __init__(self):
        self._parsers: List[BaseParser] = []
        self._stats: Dict[str, Dict] = {}  # 解析器统计信息
    
    def register(self, parser: BaseParser) -> None:
        """注册解析器"""
        self._parsers.append(parser)
        self._parsers.sort(key=lambda p: p.priority)
        self._stats[parser.name] = {
            'total_calls': 0,
            'success_calls': 0,
            'failed_calls': 0,
            'total_elapsed_ms': 0,
        }
        logger.info("注册解析器: %s (优先级=%d)", parser.name, parser.priority)
    
    def unregister(self, parser_name: str) -> bool:
        """注销解析器"""
        for i, p in enumerate(self._parsers):
            if p.name == parser_name:
                self._parsers.pop(i)
                del self._stats[parser_name]
                return True
        return False
    
    def get_parser(self, meta: FileMeta) -> Optional[BaseParser]:
        """获取能解析该文件的解析器"""
        for parser in self._parsers:
            if parser.can_parse(meta):
                return parser
        return None
    
    def get_parser_by_name(self, name: str) -> Optional[BaseParser]:
        """按解析器名称获取解析器（跳过 can_parse 检测，直接路由）"""
        for parser in self._parsers:
            if parser.name == name:
                return parser
        return None
    
    def parse(self, raw_bytes: bytes, filename: str, 
              options: Dict[str, Any] = None) -> Tuple[ParseResult, str]:
        """统一解析入口
        
        Args:
            raw_bytes: 文件原始字节
            filename: 文件名
            options: 解析选项，支持特殊键：
                - parser_name: 直接按名称路由（跳过 can_parse 检测）
                - auto_orient: 是否自动纠正图片方向
                - force_ocr: 是否强制 OCR
        
        Returns:
            Tuple[ParseResult, str]: (解析结果, 解析器名称)
        """
        meta = FileMeta(filename=filename, raw_bytes=raw_bytes)
        options = options or {}
        
        # 支持按名称直接路由（PDF 预分类场景）
        parser_name = options.pop('parser_name', None)
        if parser_name:
            parser = self.get_parser_by_name(parser_name)
        else:
            parser = self.get_parser(meta)
        if not parser:
            logger.warning("未找到能解析 %s 的解析器", filename)
            return ParseResult(
                parse_method='无可用解析器',
                source_type='unknown',
            ), 'none'
        
        # 记录统计信息
        stats = self._stats[parser.name]
        stats['total_calls'] += 1
        
        try:
            start = time.perf_counter()
            result = parser.parse(meta, options)
            elapsed_ms = (time.perf_counter() - start) * 1000
            
            result.elapsed_ms = elapsed_ms
            stats['success_calls'] += 1
            stats['total_elapsed_ms'] += elapsed_ms
            
            logger.info(
                "[%s] 解析完成: %s, 耗时=%.1fms, OCR=%s",
                parser.name, filename, elapsed_ms, result.used_ocr
            )
            
            return result, parser.name
            
        except Exception as e:
            stats['failed_calls'] += 1
            logger.error("[%s] 解析失败: %s - %s", parser.name, filename, e)
            # 保留调用方传入的 pdf_doc 引用，确保 doc 能被正确关闭
            error_doc = options.get('pdf_doc') if isinstance(options, dict) else None
            return ParseResult(
                parse_method=f'{parser.name} 解析失败',
                source_type='error',
                pdf_doc=error_doc,
            ), parser.name
    
    def get_stats(self) -> Dict[str, Dict]:
        """获取所有解析器的统计信息"""
        result = {}
        for name, stats in self._stats.items():
            if stats['total_calls'] == 0:
                avg_ms = 0
                success_rate = 0
            else:
                avg_ms = stats['total_elapsed_ms'] / stats['total_calls']
                success_rate = stats['success_calls'] / stats['total_calls']
            
            result[name] = {
                **stats,
                'avg_elapsed_ms': avg_ms,
                'success_rate': success_rate,
            }
        return result
    
    def list_parsers(self) -> List[Dict[str, Any]]:
        """列出所有已注册的解析器"""
        return [
            {
                'name': p.name,
                'priority': p.priority,
                'supported_exts': p.supported_exts,
            }
            for p in self._parsers
        ]
