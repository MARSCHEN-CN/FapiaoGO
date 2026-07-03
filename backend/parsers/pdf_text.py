"""
PDF 文本解析器

从文本型 PDF 中提取文本内容和 bbox 坐标，不使用 OCR。
适用于文本型 PDF（可选中文字的 PDF）。
"""

import hashlib
import logging

import fitz  # PyMuPDF

from .base import BaseParser, ParseResult, FileMeta
from cache import get_ocr_cache, set_ocr_cache
from pdf_utils import extract_text_from_bytes

logger = logging.getLogger(__name__)


class PdfTextParser(BaseParser):
    """文本型 PDF 解析器
    
    使用 PyMuPDF 提取 PDF 中的文本和 bbox 坐标，不调用 OCR。
    适用于经 classify_pdf() 分类为 'text' 的文本型 PDF。
    
    职责：
    - 文本提取（纯文本 + bbox 坐标）
    - OCR 缓存（避免重复解析）
    - 返回已打开的 fitz.Document 供下游 bbox 解析使用
    """
    
    name = 'pdf_text'
    supported_exts = ['pdf']
    priority = 30  # 优先级低于结构化格式，高于 OCR 解析器
    
    def can_parse(self, meta: FileMeta) -> bool:
        """仅处理文本型 PDF（由路由层预分类后指定）"""
        return meta.ext in self.supported_exts
    
    def parse(self, meta: FileMeta, options: dict = None) -> ParseResult:
        """提取文本型 PDF 的文本和 bbox 坐标
        
        流程：
        1. 检查缓存
        2. 打开 PDF（或复用调用方传入的 pdf_doc）并提取文本 + bbox 坐标
        3. 缓存结果并返回（doc 不关闭，交给调用方管理）
        
        Args:
            meta: 文件元信息
            options: 解析选项
                - pdf_doc: 调用方预打开的 fitz.Document（可选），传入后避免重复打开
        
        Returns:
            ParseResult: 包含 text、bbox_data、pdf_doc 的解析结果
        """
        options = options or {}
        pdf_bytes = meta.raw_bytes
        external_doc = options.get('pdf_doc')  # 调用方预打开的 doc（可选）
        
        # ── 缓存检查 ──
        cache_key = self._make_cache_key(pdf_bytes)
        cached = get_ocr_cache(cache_key)
        if cached:
            logger.info("[%s] 缓存命中", self.name)
            # 优先复用调用方传入的 doc，否则自行打开
            doc = external_doc if external_doc is not None else self._open_doc(pdf_bytes)
            return ParseResult(
                text=cached.get('text', ''),
                bbox_data=cached.get('bbox_data', []),
                parse_method='PDF 文本解析（缓存）',
                source_type='pdf_text',
                used_ocr=False,
                from_cache=True,
                pdf_doc=doc,
            )
        
        # ── 打开 PDF 并提取文本（复用外部传入的 doc） ──
        doc = external_doc if external_doc is not None else self._open_doc(pdf_bytes)
        if doc is None:
            return ParseResult(
                parse_method='PDF 文本解析（打开失败）',
                source_type='pdf_text',
            )
        
        try:
            text, bbox_data, words_per_page = extract_text_from_bytes(
                pdf_bytes, doc=doc, return_words=True
            )
        except Exception as e:
            logger.error("[%s] 文本提取失败: %s", self.name, e)
            text, bbox_data, words_per_page = '', [], []
        
        # ── 构建结果 ──
        result = ParseResult(
            text=text[:10000] + ("\n[文本截断]" if len(text) > 10000 else ""),
            bbox_data=bbox_data,
            words_data=words_per_page,
            parse_method='PDF 文本解析',
            source_type='pdf_text',
            used_ocr=False,
            pdf_doc=doc,  # 不关闭，交给调用方管理生命周期
        )
        
        # ── 缓存结果（仅缓存文本和 bbox，不含 doc 引用） ──
        set_ocr_cache(cache_key, result.to_dict())
        
        return result
    
    def _open_doc(self, pdf_bytes: bytes):
        """安全打开 PDF 文档"""
        try:
            return fitz.open(stream=pdf_bytes, filetype="pdf")
        except Exception as e:
            logger.error("[%s] 打开 PDF 失败: %s", self.name, e)
            return None
    
    def _make_cache_key(self, pdf_bytes: bytes) -> str:
        """生成缓存键"""
        sha = hashlib.sha256()
        chunk_size = 1024 * 1024
        for i in range(0, len(pdf_bytes), chunk_size):
            sha.update(pdf_bytes[i:i + chunk_size])
        return sha.hexdigest() + '_pdf_text'
    
    def get_text_quality_score(self, text: str) -> int:
        """评估文本质量（0-7分）"""
        if not text:
            return 0
        keywords = ["发票", "发票号码", "开票日期", "金额", "税额", "购买方", "销售方"]
        return sum(1 for kw in keywords if kw in text)
