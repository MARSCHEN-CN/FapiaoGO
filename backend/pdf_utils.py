import io
import re
import hashlib
import logging

import numpy as np
import fitz
from PIL import Image as PILImage

from cache import get_ocr_cache, set_ocr_cache
from ocr_engine import (
    get_ocr, auto_orient_and_ocr, OCRModelNotFoundError,
    preprocess_for_invoice, merge_ocr_boxes_by_row,
    ocr_call, ocr_result_to_items,
    ENABLE_PREPROCESS, ENABLE_ROW_MERGE,
)
from field_extractor import extract_fields_legacy

logger = logging.getLogger(__name__)

# 发票关键词列表（用于文本质量评分和 OCR 触发判断）
_INVOICE_KEYWORDS = [
    "发票",
    "发票号码",
    "开票日期",
    "金额",
    "税额",
    "购买方",
    "销售方",
]

# OCR 触发阈值：文本质量评分低于此值时触发 OCR（满分 7）
_OCR_QUALITY_THRESHOLD = 4


def _normalize_for_dedup(s):
    """将文本行归一化用于去重比较：去除空白和常见标点变体"""
    s = s.strip()
    # 去除所有空白字符
    s = re.sub(r'\s+', '', s)
    # 统一中英文标点
    s = s.replace('：', ':').replace('，', ',').replace('。', '.').replace('（', '(').replace('）', ')')
    return s.lower()


def _dedup_ocr_lines(existing_text, ocr_lines):
    """过滤掉已在 existing_text 中出现的 OCR 行，返回去重后的行列表。
    
    策略：将已有文本按行拆分为归一化集合，逐行检查 OCR 行是否已存在。
    允许部分匹配（OCR 行是已有行的子串或反之）以避免语义重复。
    """
    if not existing_text or not ocr_lines:
        return ocr_lines
    
    # 构建已有文本的归一化行集合
    existing_normalized = {
        _normalize_for_dedup(line)
        for line in existing_text.split('\n')
        if line.strip()
    }
    
    deduped = []
    for line in ocr_lines:
        norm = _normalize_for_dedup(line)
        if not norm:
            continue
        # 精确匹配：归一化后完全相同
        if norm in existing_normalized:
            continue
        # 子串匹配：OCR 行是已有行的子串，或已有行是 OCR 行的子串
        is_dup = False
        for existing in existing_normalized:
            if len(norm) >= 4 and len(existing) >= 4:
                if norm in existing or existing in norm:
                    is_dup = True
                    break
        if not is_dup:
            deduped.append(line)
    
    return deduped

# 发票号码模式：8-20 位连续数字（用于判断 PDF 文本层是否包含真实结构化数据）
_INVOICE_NUMBER_PATTERN = re.compile(r'\d{8,20}')


def evaluate_text_quality(text):
    """评估提取文本中包含多少发票关键词，0~7 分
    
    处理竖排文字（\"购\\n买\\n方\"→\"购买方\"）和横排多词 token，
    通过去掉换行和空格来合并拆字的竖排文字。
    """
    if not text:
        return 0
    # 去掉换行和空格，合并竖排拆分的单字（"购\n买\n方" → "购买方"）
    text_flat = text.replace('\n', '').replace(' ', '')
    keywords = ['发票', '号码', '日期', '购买方', '销售方', '金额', '合计']
    hits = [k for k in keywords if k in text_flat]
    logger.debug("[QUALITY] text_flat='%s...' hits=%s count=%d/%d",
                 text_flat[:60], hits, len(hits), len(keywords))
    return len(hits)


def _is_image_page(page) -> bool:
    """判断单个 PDF 页面是否为图片型（无可提取文本但有嵌入图片）。

    判定标准：
    - 页面可提取文本（去除空白后）< 10 个字符
    - 页面包含至少 1 张嵌入图片
    """
    text = (page.get_text("text") or "").strip()
    if len(text) >= 10:
        return False
    images = page.get_images(full=True)
    return len(images) > 0


def classify_pdf(pdf_bytes) -> str:
    """分类 PDF 为文本型或图片型。

    通过检测每个页面的结构（可提取文本 vs 嵌入图片）判断 PDF 类型。
    若多数页面为图片型（无可提取文本但有嵌入图片），则为图片型 PDF。

    Args:
        pdf_bytes: PDF 文件字节

    Returns:
        str: 'text'（文本型）或 'image'（图片型）
    """
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            total = len(doc)
            if total == 0:
                return 'image'
            image_pages = sum(1 for p in doc if _is_image_page(p))
            kind = 'image' if image_pages > total / 2 else 'text'
            logger.info("[CLASSIFY_PDF] pages=%d, image_pages=%d, kind=%s", total, image_pages, kind)
            return kind
        finally:
            doc.close()
    except Exception as e:
        logger.warning("[CLASSIFY_PDF] 分类失败，默认为图片型: %s", e)
        return 'image'


def need_ocr(text, doc=None):
    """判断 PDF 是否需要 OCR 补充。

    核心逻辑：仅图片型 PDF 需要 OCR，文本型不需要。

    判断流程：
    1. 如果传入了 doc（fitz.Document），直接检测 PDF 结构：
       - 遍历页面，若多数页面为图片型（无可提取文本但有嵌入图片）→ 需要 OCR
       - 否则为文本型 PDF → 不需要 OCR
    2. 如果未传入 doc，退化为文本内容判断（向后兼容）：
       - 空文本 → 需要 OCR
       - 有效字符 >= 20 → 文本型，不需要 OCR
       - 否则 → 需要 OCR

    Args:
        text: 已从 PDF 提取的文本
        doc: 可选的 fitz.Document 对象，传入时进行结构检测（推荐）
    """
    # ── 优先：基于 PDF 结构判断 ──
    if doc is not None:
        try:
            total_pages = len(doc)
            if total_pages == 0:
                logger.info("[NEED_OCR] doc has 0 pages, returning True")
                return True
            image_pages = sum(1 for p in doc if _is_image_page(p))
            is_image_pdf = image_pages > total_pages / 2
            logger.info(
                "[NEED_OCR] pages=%d, image_pages=%d, is_image_pdf=%s",
                total_pages, image_pages, is_image_pdf,
            )
            print(f"[NEED_OCR] pages={total_pages}, image_pages={image_pages}, is_image_pdf={is_image_pdf}")
            return is_image_pdf
        except Exception as e:
            logger.warning("[NEED_OCR] 结构检测失败，退化为文本判断: %s", e)

    # ── 退化：基于文本内容判断（向后兼容） ──
    if not text:
        logger.info("[NEED_OCR] text is empty, returning True")
        return True

    effective_chars = len(text.replace('\n', '').replace(' ', '').strip())
    if effective_chars >= 20:
        logger.info("[NEED_OCR] effective_chars=%d >= 20, text-based, returning False", effective_chars)
        return False

    logger.info("[NEED_OCR] effective_chars=%d < 20, returning True", effective_chars)
    return True


# =========================
# PDF 转图片（PyMuPDF）
# =========================
def pdf_page_to_image(pdf_bytes, page_index=0, dpi=200):
    """用 PyMuPDF 将 PDF 页面转为 PIL Image"""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        if page_index >= len(doc):
            return None
        page = doc[page_index]
        zoom = dpi / 72.0
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        img = PILImage.frombytes("RGB", (pix.width, pix.height), pix.samples)
        return img
    finally:
        doc.close()


# =========================
# 带坐标的文本提取
# =========================

def extract_words_with_bbox(pdf_bytes):
    """
    使用 PyMuPDF 的 words 模式提取带坐标的文本
    
    Returns:
        list: 每个元素为 dict，包含 'text', 'x0', 'y0', 'x1', 'y1', 'page'
    """
    words = []
    
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            max_pages = min(len(doc), 5)
            
            for page_idx in range(max_pages):
                page = doc[page_idx]
                # 使用 words 模式获取带坐标的文本
                page_words = page.get_text("words")
                
                for word in page_words:
                    x0, y0, x1, y1, text, block_no, line_no, word_no = word
                    if text.strip():
                        words.append({
                            'text': text.strip(),
                            'x0': x0,
                            'y0': y0,
                            'x1': x1,
                            'y1': y1,
                            'page': page_idx,
                            'block_no': block_no,
                            'line_no': line_no
                        })
        finally:
            doc.close()
    except Exception as e:
        logger.error(f"提取 words 失败: {e}")
    
    return words


def extract_text_from_bytes(pdf_bytes, doc=None, return_words=False):
    """使用 PyMuPDF 提取文本，同时返回纯文本和 bbox 格式的坐标数据。

    [PERF] 每页只调用一次 get_text("words")，从 words 中拼接纯文本，
    避免 `get_text()` + `get_text("words")` 双重调用。
    可选 return_words=True 返回原始 words 元组列表，供下游 bbox 解析器直接复用，
    避免对同一页面再次调用 get_text("words")。

    Args:
        pdf_bytes: PDF 文件字节
        doc: 可选的外部 fitz.Document，传入时复用而不新建/关闭
        return_words: 是否额外返回每页的原始 words 元组列表

    Returns:
        return_words=False: tuple (text, bbox_data)
        return_words=True:  tuple (text, bbox_data, words_per_page)
            - text: 纯文本字符串（每页以换行分隔）
            - bbox_data: bbox 格式列表，每个元素 {'text', 'box', 'page'}
                - box: [[x0,y0], [x1,y0], [x1,y1], [x0,y1]]（200 DPI 坐标）
            - words_per_page: list[list[tuple]]，每页的原始 words 元组
                （tuple 结构: (x0, y0, x1, y1, word_text, block_no, line_no, word_no)）
    """
    text = ""
    bbox_data = []
    words_per_page = [] if return_words else None
    own_doc = doc is None

    # 坐标系转换：PyMuPDF 返回 PDF points (72 DPI)，转换为 OCR 坐标 (200 DPI)
    _PDF_TO_OCR_SCALE = 200.0 / 72.0  # ≈ 2.778

    try:
        if own_doc:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        max_pages = min(len(doc), 5)

        for page_idx in range(max_pages):
            page = doc[page_idx]

            # [PERF] 仅调用一次 get_text("words")，同时生成纯文本 + bbox
            page_words = page.get_text("words")

            if return_words:
                words_per_page.append(page_words)

            # 从 words 拼接本页纯文本（按出现顺序空格分隔 + 尾部换行）
            page_text_parts = []
            for word in page_words:
                x0, y0, x1, y1, word_text, block_no, line_no, word_no = word
                word_text_stripped = word_text.strip()
                if word_text_stripped:
                    page_text_parts.append(word_text_stripped)
                    # 构造 bbox（与 OCR 格式兼容）
                    bbox_data.append({
                        'text': word_text_stripped,
                        'box': [
                            [x0 * _PDF_TO_OCR_SCALE, y0 * _PDF_TO_OCR_SCALE],
                            [x1 * _PDF_TO_OCR_SCALE, y0 * _PDF_TO_OCR_SCALE],
                            [x1 * _PDF_TO_OCR_SCALE, y1 * _PDF_TO_OCR_SCALE],
                            [x0 * _PDF_TO_OCR_SCALE, y1 * _PDF_TO_OCR_SCALE]
                        ],
                        'page': page_idx
                    })

            if page_text_parts:
                text += " ".join(page_text_parts) + "\n"

            # 提前退出：已获取足够文本
            if len(text) > 10000:
                text = text[:10000] + "\n[文本截断]"
                break

    except Exception as e:
        logger.error(f"提取文本失败: {e}")
    finally:
        if own_doc and doc is not None:
            doc.close()

    if return_words:
        return text, bbox_data, words_per_page
    return text, bbox_data


# =========================
# 统一发票解析（已废弃）
# 已迁移至 parsers/pdf_text.py (PdfTextParser) 和 parsers/pdf_ocr.py (PdfOcrParser)
# 由 invoice_service.py 通过 classify_pdf() + ParserRegistry 路由
# 保留此函数以防外部调用
# =========================
def parse_invoice_unified(pdf_bytes, auto_orient=True, force_ocr=False, enable_auto_ocr=False):
    """
    [DEPRECATED] 已迁移至 PdfTextParser / PdfOcrParser。
    
    原统一发票解析：不区分 Text PDF 和 Image PDF，自动处理。
    新架构由 invoice_service.py 通过 classify_pdf() 预分类后
    调用 ParserRegistry.parse(parser_name=...) 路由到对应解析器。
    
    处理逻辑：
    1. 先提取文本（PyMuPDF 快速）
    2. 文本关键词评分：如果"发票/发票号码/开票日期"不足 2 个，OCR 首页补充
    3. 统一用 extract_fields_legacy 提取字段
    
    Args:
        force_ocr: ⚠️ v5: 是否强制 OCR（用于获取 bbox_data）
        enable_auto_ocr: 是否启用自动 need_ocr 检测（默认关闭，仅 force_ocr 触发 OCR）
    
    Returns:
        tuple: (result_dict, from_cache)
    """
    # 缓存键使用分块 SHA256 哈希
    sha = hashlib.sha256()
    chunk_size = 1024 * 1024
    for i in range(0, len(pdf_bytes), chunk_size):
        sha.update(pdf_bytes[i:i + chunk_size])
    cache_key = sha.hexdigest() + ('_unified' if auto_orient else '_unified_no_orient')
    # ⚠️ v5: force_ocr / enable_auto_ocr 需要独立的缓存键
    if force_ocr:
        cache_key += '_force_ocr'
    if enable_auto_ocr:
        cache_key += '_auto_ocr'
    else:
        cache_key += '_no_auto_ocr'
    
    cached = get_ocr_cache(cache_key)
    if cached:
        print(f"[CACHE] Hit! Returning cached result, skipping need_ocr() check")
        return cached, True, None
    
    result = {
        "invoice_type": "其他",
        "invoice_number": "未知号码",
        "amount": "0.00",
        "invoice_date": "未知日期",
        "text": ""
    }
    
    try:
        # 打开一次 PDF，供文本提取 + OCR 渲染 + 调用方 bbox 解析共用
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        
        # 第一步：提取文本和 bbox 数据（快速，复用已打开的 doc）
        text, bbox_data = extract_text_from_bytes(pdf_bytes, doc=doc)
        print(f"[parse_invoice_unified] Extracted text length: {len(text)} chars")
        print(f"[parse_invoice_unified] Text preview: {text[:200]!r}")
        
        # 第二步：图片型 PDF 时用 OCR 补充首页（复用 doc，不再重新打开）
        used_ocr = False
        if force_ocr or (enable_auto_ocr and need_ocr(text, doc=doc)):
            used_ocr = True
            if len(doc) > 0:
                page = doc[0]
                zoom = 200 / 72.0
                mat = fitz.Matrix(zoom, zoom)
                pix = page.get_pixmap(matrix=mat, alpha=False)
                pil_img = PILImage.frombytes("RGB", (pix.width, pix.height), pix.samples)
                
                try:
                    ocr_engine = get_ocr()
                    if auto_orient:
                        ocr_result, _, _, rotated_img = auto_orient_and_ocr(pil_img, ocr_engine)
                    else:
                        img_array = np.asarray(pil_img.convert('RGB'))
                        if ENABLE_PREPROCESS:
                            img_array = preprocess_for_invoice(img_array)
                        ocr_result, _ = ocr_call(ocr_engine, img_array)
                        if ENABLE_ROW_MERGE and ocr_result:
                            ocr_result = merge_ocr_boxes_by_row(ocr_result)
                    
                    if ocr_result:
                        # OcrResult → [[box, text, score], ...] 用于排序/遍历
                        lines = ocr_result_to_items(ocr_result)
                        # 按阅读顺序：直接取第一个点坐标，避免 min() 重复遍历
                        lines.sort(key=lambda x: (
                            x[0][0][1] if x[0] and x[0][0] else 0,  # y1 → top
                            x[0][0][0] if x[0] and x[0][0] else 0,  # x1 → left
                        ))
                        ocr_lines_all = [line[1] for line in lines if line and len(line) >= 2]
                        # 去重：过滤已在文本提取中出现的行，防止重复数据干扰下游字段提取
                        ocr_lines_deduped = _dedup_ocr_lines(text, ocr_lines_all)
                        if ocr_lines_deduped:
                            ocr_text = '\n'.join(ocr_lines_deduped)
                            text += '\n' + ocr_text
                        # 捕获 bbox 坐标（保留全部，不受去重影响）
                        for line in lines:
                            if line and len(line) >= 2 and line[0] and len(line[0]) >= 4:
                                bbox_data.append({'text': line[1], 'box': line[0]})
                finally:
                    pil_img.close()
                    del pil_img, pix
        
        # 第三步：返回文本和元数据（字段提取由 invoice_service.py 统一处理）
        if text:
            result = {
                "invoice_type": "其他",
                "invoice_number": "未知号码",
                "amount": "0.00",
                "invoice_date": "未知日期",
                "text": text[:10000] + ("\n[文本截断]" if len(text) > 10000 else ""),
                "used_ocr": used_ocr,
                "bbox_data": bbox_data
            }
        
        set_ocr_cache(cache_key, result)
        return result, False, doc
        
    except OCRModelNotFoundError as e:
        logger.warning("OCR 模型缺失，仅使用文本提取: %s", e)
        if text:
            result = {
                "invoice_type": "其他",
                "invoice_number": "未知号码",
                "amount": "0.00",
                "invoice_date": "未知日期",
                "text": text[:10000] + ("\n[文本截断]" if len(text) > 10000 else ""),
                "used_ocr": False,
                "bbox_data": bbox_data
            }
        set_ocr_cache(cache_key, result)
        return result, False, doc
        
    except Exception as e:
        logger.error("统一解析失败: %s", e)
        # doc 可能已打开也可能未打开，安全关闭
        try:
            doc.close()
        except Exception:
            pass
        return result, False, None



