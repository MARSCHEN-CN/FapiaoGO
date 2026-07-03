"""
图片 OCR 解析器

对图片进行 OCR 识别，支持自动方向纠正。
"""

import io
import base64
import hashlib
import logging
import numpy as np
from PIL import Image as PILImage

from .base import BaseParser, ParseResult, FileMeta
from cache import get_ocr_cache, set_ocr_cache
from ocr_engine import (
    get_ocr, auto_orient_and_ocr, OCRModelNotFoundError,
    preprocess_for_invoice, merge_ocr_boxes_by_row,
    ocr_call, ocr_result_to_items,
    ENABLE_PREPROCESS, ENABLE_ROW_MERGE,
)

logger = logging.getLogger(__name__)


class ImageOcrParser(BaseParser):
    """图片 OCR 解析器
    
    对图片进行 OCR 识别，支持自动方向纠正。
    支持 JPG、PNG、BMP、TIFF 等格式。
    """
    
    name = 'image_ocr'
    supported_exts = ['jpg', 'jpeg', 'png', 'bmp', 'tiff', 'tif']
    priority = 40  # 优先级低于 PDF 解析器
    
    def parse(self, meta: FileMeta, options: dict = None) -> ParseResult:
        """对图片进行 OCR 识别
        
        Args:
            meta: 文件元信息
            options: 解析选项
                - auto_orient: 是否自动纠正图片方向
        
        Returns:
            ParseResult: 解析结果
        """
        options = options or {}
        auto_orient = options.get('auto_orient', True)
        raw_bytes = meta.raw_bytes
        
        # 检查缓存
        cache_key = self._make_cache_key(raw_bytes, auto_orient)
        cached = get_ocr_cache(cache_key)
        if cached:
            return ParseResult(
                text=cached.get('text', ''),
                bbox_data=cached.get('bbox_data', []),
                preview_image=cached.get('preview_image'),
                parse_method='图片 OCR（缓存）',
                source_type='image',
                used_ocr=True,
                from_cache=True,
            )
        
        # 执行 OCR
        result = self._do_ocr(raw_bytes, auto_orient)
        
        # 缓存结果
        set_ocr_cache(cache_key, result.to_dict())
        
        return result
    
    def _make_cache_key(self, raw_bytes: bytes, auto_orient: bool) -> bytes:
        """生成缓存键"""
        if auto_orient:
            return raw_bytes
        return b'_no_orient_' + raw_bytes
    
    def _do_ocr(self, raw_bytes: bytes, auto_orient: bool) -> ParseResult:
        """执行 OCR 识别"""
        result = ParseResult(
            parse_method='图片 OCR',
            source_type='image',
            used_ocr=True,
        )
        
        try:
            ocr_engine = get_ocr()
            img = PILImage.open(io.BytesIO(raw_bytes))
            
            self._logger.debug("图片: 格式=%s, 尺寸=%s, 模式=%s", 
                              img.format, img.size, img.mode)
            
            if img.mode not in ('RGB', 'L'):
                img = img.convert('RGB')
            
            # 根据设置决定是否进行方向纠正
            if auto_orient:
                ocr_result, elapse, rotation_angle, rotated_img = auto_orient_and_ocr(img, ocr_engine)
            else:
                img_array = np.array(img)
                if ENABLE_PREPROCESS:
                    img_array = preprocess_for_invoice(img_array)
                ocr_result, elapse = ocr_call(ocr_engine, img_array)
                if ENABLE_ROW_MERGE and ocr_result:
                    ocr_result = merge_ocr_boxes_by_row(ocr_result)
                rotation_angle = 0
                rotated_img = None
            
            if ocr_result and len(ocr_result) > 0:
                # OcrResult → [[box, text, score], ...] 用于遍历
                lines = ocr_result_to_items(ocr_result)
                texts = []
                bbox_data = []
                
                for line in lines:
                    if line and len(line) >= 2:
                        texts.append(line[1])
                        # 捕获 bbox 坐标
                        if line[0] and len(line[0]) >= 4:
                            bbox_data.append({'text': line[1], 'box': line[0]})
                
                full_text = '\n'.join(texts)
                result.text = full_text[:2000]
                result.bbox_data = bbox_data
                
                if rotation_angle != 0:
                    self._logger.debug("图片已自动旋转 %d°", rotation_angle)
                
                # 生成纠正后的预览图
                if rotated_img is not None and rotation_angle != 0:
                    buf = io.BytesIO()
                    PILImage.fromarray(rotated_img).convert('RGB').save(buf, format='PNG')
                    result.preview_image = base64.b64encode(buf.getvalue()).decode('ascii')
            
            else:
                self._logger.warning("OCR 未识别到文本")
                
        except OCRModelNotFoundError as e:
            self._logger.warning("OCR 模型缺失: %s", e)
        except Exception as e:
            self._logger.error("图片 OCR 失败: %s", e)
        
        return result
