"""
PDF OCR 解析器

对图片型 PDF 进行 OCR 识别，提取文本和 bbox 坐标。
适用于扫描型 PDF（图片型 PDF）。
"""

import hashlib
import logging

import numpy as np
import fitz  # PyMuPDF
from PIL import Image as PILImage

from .base import BaseParser, ParseResult, FileMeta
from cache import get_ocr_cache, set_ocr_cache
from pdf_utils import extract_text_from_bytes, _dedup_ocr_lines
from ocr_engine import (
    get_ocr, auto_orient_and_ocr, OCRModelNotFoundError,
    preprocess_for_invoice, merge_ocr_boxes_by_row,
    ocr_call, ocr_result_to_items,
    ENABLE_PREPROCESS, ENABLE_ROW_MERGE,
)

logger = logging.getLogger(__name__)


class PdfOcrParser(BaseParser):
    """图片型 PDF 解析器
    
    对图片型 PDF 进行文本提取 + OCR 补充，获取完整文本和 bbox 坐标。
    适用于经 classify_pdf() 分类为 'image' 的扫描型 PDF。
    
    职责：
    - 文本提取（PyMuPDF 提取已有文本层）
    - 首页 OCR（PaddleOCR 补充扫描件文本）
    - OCR 去重（过滤已在文本层中出现的行）
    - OCR 缓存（避免重复解析）
    - 返回已打开的 fitz.Document 供下游 bbox 解析使用
    """
    
    name = 'pdf_ocr'
    supported_exts = ['pdf']
    priority = 35  # 优先级略低于 PdfTextParser
    
    def can_parse(self, meta: FileMeta) -> bool:
        """仅处理 PDF（由路由层预分类后指定）"""
        return meta.ext in self.supported_exts
    
    def parse(self, meta: FileMeta, options: dict = None) -> ParseResult:
        """解析图片型 PDF（文本提取 + OCR 补充）
        
        流程：
        1. 检查缓存
        2. 打开 PDF（或复用调用方传入的 pdf_doc），提取文本 + bbox 坐标
        3. 首页渲染为图片 → OCR → 去重 → 合并
        4. 缓存结果并返回（doc 不关闭，交给调用方管理）
        
        Args:
            meta: 文件元信息
            options: 解析选项
                - auto_orient: 是否自动纠正图片方向（默认 True）
                - force_ocr: 是否强制 OCR（默认 True，图片型默认走 OCR）
                - pdf_doc: 调用方预打开的 fitz.Document（可选），传入后避免重复打开
        
        Returns:
            ParseResult: 包含 text、bbox_data、pdf_doc 的解析结果
        """
        options = options or {}
        auto_orient = options.get('auto_orient', True)
        pdf_bytes = meta.raw_bytes
        external_doc = options.get('pdf_doc')  # 调用方预打开的 doc（可选）
        
        # ── 缓存检查 ──
        cache_key = self._make_cache_key(pdf_bytes, auto_orient)
        cached = get_ocr_cache(cache_key)
        if cached:
            logger.info("[%s] 缓存命中", self.name)
            # 优先复用调用方传入的 doc，否则自行打开
            doc = external_doc if external_doc is not None else self._open_doc(pdf_bytes)
            return ParseResult(
                text=cached.get('text', ''),
                bbox_data=cached.get('bbox_data', []),
                parse_method='PDF OCR 解析（缓存）',
                source_type='pdf_ocr',
                used_ocr=cached.get('used_ocr', True),
                from_cache=True,
                pdf_doc=doc,
            )
        
        # ── 打开 PDF 并提取文本层（复用外部传入的 doc） ──
        doc = external_doc if external_doc is not None else self._open_doc(pdf_bytes)
        if doc is None:
            return ParseResult(
                parse_method='PDF OCR 解析（打开失败）',
                source_type='pdf_ocr',
            )
        
        try:
            text, bbox_data, words_per_page = extract_text_from_bytes(
                pdf_bytes, doc=doc, return_words=True
            )
        except Exception as e:
            logger.error("[%s] 文本提取失败: %s", self.name, e)
            text, bbox_data, words_per_page = '', [], []
        
        # ── 首页 OCR ──
        used_ocr = False
        try:
            ocr_text, ocr_bbox = self._ocr_first_page(doc, auto_orient)
            if ocr_text:
                used_ocr = True
                # 去重：过滤已在文本层中出现的行
                ocr_lines_all = ocr_text.split('\n')
                ocr_lines_deduped = _dedup_ocr_lines(text, ocr_lines_all)
                if ocr_lines_deduped:
                    text += '\n' + '\n'.join(ocr_lines_deduped)
                # 合并 bbox 坐标（OCR 的全部保留）
                bbox_data.extend(ocr_bbox)
        except OCRModelNotFoundError as e:
            logger.warning("[%s] OCR 模型缺失，仅使用文本提取: %s", self.name, e)
        except Exception as e:
            logger.error("[%s] OCR 失败: %s", self.name, e)
        
        # ── 构建结果 ──
        result = ParseResult(
            text=text[:10000] + ("\n[文本截断]" if len(text) > 10000 else ""),
            bbox_data=bbox_data,
            words_data=words_per_page,
            parse_method='PDF OCR 解析' + ('(OCR)' if used_ocr else '(纯文本)'),
            source_type='pdf_ocr',
            used_ocr=used_ocr,
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
    
    def _make_cache_key(self, pdf_bytes: bytes, auto_orient: bool) -> str:
        """生成缓存键"""
        sha = hashlib.sha256()
        chunk_size = 1024 * 1024
        for i in range(0, len(pdf_bytes), chunk_size):
            sha.update(pdf_bytes[i:i + chunk_size])
        key = sha.hexdigest() + '_pdf_ocr'
        if not auto_orient:
            key += '_no_orient'
        return key
    
    def _ocr_first_page(self, doc, auto_orient: bool) -> tuple:
        """对 PDF 首页进行 OCR
        
        Args:
            doc: 已打开的 fitz.Document（复用，不重新打开）
            auto_orient: 是否自动纠正图片方向
        
        Returns:
            tuple: (ocr_text, bbox_data)
        """
        ocr_text = ''
        bbox_data = []
        
        if len(doc) == 0:
            return ocr_text, bbox_data
        
        # 将首页转为图片
        page = doc[0]
        zoom = 200 / 72.0
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        pil_img = PILImage.frombytes("RGB", (pix.width, pix.height), pix.samples)
        
        try:
            ocr_engine = get_ocr()
            
            if auto_orient:
                ocr_result, _, _, _ = auto_orient_and_ocr(pil_img, ocr_engine)
            else:
                img_array = np.asarray(pil_img.convert('RGB'))
                if ENABLE_PREPROCESS:
                    img_array = preprocess_for_invoice(img_array)
                ocr_result, _ = ocr_call(ocr_engine, img_array)
                if ENABLE_ROW_MERGE and ocr_result:
                    ocr_result = merge_ocr_boxes_by_row(ocr_result)
            
            if ocr_result:
                # OcrResult → [[box, text, score], ...] 用于排序和逐行访问
                lines = ocr_result_to_items(ocr_result)
                # 按阅读顺序排序
                lines.sort(key=lambda x: (
                    x[0][0][1] if x[0] and x[0][0] else 0,
                    x[0][0][0] if x[0] and x[0][0] else 0,
                ))
                ocr_text = '\n'.join([line[1] for line in lines if line and len(line) >= 2])
                
                # 捕获 bbox 坐标
                for line in lines:
                    if line and len(line) >= 2 and line[0] and len(line[0]) >= 4:
                        bbox_data.append({'text': line[1], 'box': line[0]})
                        
        finally:
            pil_img.close()
            del pil_img, pix
        
        return ocr_text, bbox_data
