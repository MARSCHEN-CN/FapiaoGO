import hashlib
import io
import base64
import logging
import numpy as np
from PIL import Image as PILImage

from cache import get_ocr_cache, set_ocr_cache
from ocr_engine import (
    get_ocr, auto_orient_and_ocr, OCRModelNotFoundError,
    preprocess_for_invoice, merge_ocr_boxes_by_row,
    ocr_call, ocr_result_to_items,
    ENABLE_PREPROCESS, ENABLE_ROW_MERGE,
)


logger = logging.getLogger(__name__)


# 预览图最大尺寸（像素），超出时缩放
MAX_PREVIEW_WIDTH = 800
MAX_PREVIEW_HEIGHT = 1200

# 预览图质量
PREVIEW_QUALITY = 65


def _resize_image(img, max_width, max_height):
    """调整图片大小，保持宽高比"""
    width, height = img.size
    if width <= max_width and height <= max_height:
        return img
    
    # 计算缩放比例
    ratio = min(max_width / width, max_height / height)
    new_width = int(width * ratio)
    new_height = int(height * ratio)
    return img.resize((new_width, new_height), PILImage.Resampling.LANCZOS)


def parse_image_ocr(file, auto_orient=True, content_sha256=None, content_bytes=None):
    """使用OCR解析发票图片（自动纠正方向，支持缓存）

    content_sha256 / content_bytes 为可选参数：由调用方（parse_invoice_service）
    透传已计算的完整 SHA256 与原始字节，避免对 ≤4MB 文件重复哈希、并避免
    从 BytesIO 拷贝第二份全量字节。未提供时回退到从 file 读取（向下兼容）。
    """
    if content_bytes is not None:
        raw = content_bytes
    else:
        file.seek(0)
        raw = file.read()

    # 缓存键：SHA256 哈希 + 显式后缀，与 pdf_utils.parse_invoice_unified 风格一致
    if content_sha256 is not None:
        sha = content_sha256
    else:
        sha = hashlib.sha256(raw).hexdigest()
    cache_key = sha + ('_orient' if auto_orient else '_no_orient')
    from config import CACHE_DEBUG
    if not CACHE_DEBUG:
        cached_result = get_ocr_cache(cache_key)
        if cached_result:
            return cached_result
    else:
        logger.info("[CACHE_DEBUG] OCR 缓存已禁用，跳过缓存读取")

    result = {
        "invoice_type": "其他",
        "invoice_number": "未知号码",
        "amount": "0.00",
        "invoice_date": "未知日期",
        "text": ""
    }

    img = None
    img_array = None
    rotated_img = None
    buf = None

    try:
        ocr_engine = get_ocr()
        img = PILImage.open(io.BytesIO(raw))
        logger.debug("图片OCR: 格式=%s, 尺寸=%s, 模式=%s", img.format, img.size, img.mode)

        if img.mode not in ('RGB', 'L'):
            img = img.convert('RGB')

        if auto_orient:
            ocr_result, elapse, rotation_angle, rotated_img = auto_orient_and_ocr(img, ocr_engine)
        else:
            img_array = np.array(img)
            # ✅ 预处理（与 auto_orient 路径一致）
            if ENABLE_PREPROCESS:
                img_array = preprocess_for_invoice(img_array)
            ocr_result, elapse = ocr_call(ocr_engine, img_array)
            # ✅ 行合并
            if ENABLE_ROW_MERGE and ocr_result:
                ocr_result = merge_ocr_boxes_by_row(ocr_result)
            rotation_angle = 0

        if ocr_result and len(ocr_result) > 0:
            lines = ocr_result_to_items(ocr_result)
            texts = []
            bbox_data = []
            for line in lines:
                if line and len(line) >= 2:
                    texts.append(line[1])
                    if line[0] and len(line[0]) >= 4:
                        bbox_data.append({'text': line[1], 'box': line[0]})

            full_text = '\n'.join(texts)
            # 保留全量文本供 invoice_service.py 第二步 extract_fields 使用，
            # 文本截断由 response_builder.MAX_RAW_TEXT_LENGTH 在响应层统一控制。
            result["text"] = full_text
            result["bbox_data"] = bbox_data

            logger.debug("OCR 完成: %d 行, %d 字符", len(texts), len(full_text))

            if rotation_angle != 0:
                logger.info("图片已自动旋转 %d°", rotation_angle)

            # 生成预览图（只在旋转后或需要时）
            if rotated_img is not None:
                preview_img = PILImage.fromarray(rotated_img).convert('RGB')
                preview_img = _resize_image(preview_img, MAX_PREVIEW_WIDTH, MAX_PREVIEW_HEIGHT)
                buf = io.BytesIO()
                preview_img.save(buf, format='JPEG', quality=PREVIEW_QUALITY, optimize=True)
                result['preview_image'] = base64.b64encode(buf.getvalue()).decode('ascii')
                logger.debug("已生成预览图: %d bytes", len(buf.getvalue()))
                # 释放预览图内存
                del preview_img

            set_ocr_cache(cache_key, result)
        else:
            logger.warning("OCR未识别到文本")
            set_ocr_cache(cache_key, result)

    except OCRModelNotFoundError as e:
        logger.warning("OCR 模型缺失，跳过 OCR 环节: %s", e)
        set_ocr_cache(cache_key, result)
        return result

    except Exception as e:
        logger.error("图片OCR解析异常: %s", e, exc_info=True)
        set_ocr_cache(cache_key, result)

    finally:
        # 主动释放内存
        if img:
            img.close()
            del img
        if img_array is not None:
            del img_array
        if rotated_img is not None:
            del rotated_img
        if buf:
            buf.close()
            del buf

    return result
