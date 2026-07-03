"""
文件验证模块 - 提供可靠的文件格式检测和安全检查
"""

import io
import logging

logger = logging.getLogger(__name__)

# =========================
# 配置常量
# =========================

# 文件大小限制（字节）- 50MB
MAX_FILE_SIZE = 50 * 1024 * 1024

# PDF 最大页数
MAX_PDF_PAGES = 50

# 图片最大像素数
MAX_IMAGE_PIXELS = 50_000_000

# 文件头 magic number 映射
MAGIC_NUMBERS = {
    b'%PDF-': 'pdf',
    b'\x89PNG\r\n\x1a\n': 'png',
    b'\xff\xd8\xff': 'jpg',
    b'BM': 'bmp',
    b'II*\x00': 'tiff',
    b'MM\x00*': 'tiff',
    b'<?xml': 'xml',
    b'<Invoice': 'xml',
    b'PK\x03\x04': 'zip',  # OFD 是 ZIP 格式
}


# =========================
# 文件类型检测
# =========================

def detect_file_type(raw_bytes, filename):
    """
    使用文件头 magic number 和扩展名检测文件类型
    
    Returns:
        tuple: (detected_type, error_message)
        detected_type: 'pdf', 'image', 'ofd', 'xml', 'unknown'
    """
    # 空文件检查
    if not raw_bytes:
        return 'unknown', '空文件'
    
    # 文件大小检查
    if len(raw_bytes) > MAX_FILE_SIZE:
        return 'unknown', f'文件超过 {MAX_FILE_SIZE / 1024 / 1024:.0f}MB 限制'
    
    # 优先使用 magic number 检测
    detected = _detect_by_magic(raw_bytes)
    if detected:
        return detected, None
    
    # 回退到扩展名检测
    detected = _detect_by_extension(filename)
    return detected, None


def _detect_by_magic(raw_bytes):
    """使用文件头 magic number 检测文件类型"""
    # 检查 PDF
    if raw_bytes.startswith(b'%PDF-'):
        return 'pdf'
    
    # 检查 PNG
    if raw_bytes.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image'
    
    # 检查 JPG
    if raw_bytes.startswith(b'\xff\xd8\xff'):
        return 'image'
    
    # 检查 BMP
    if raw_bytes.startswith(b'BM'):
        return 'image'
    
    # 检查 TIFF
    if raw_bytes.startswith(b'II*\x00') or raw_bytes.startswith(b'MM\x00*'):
        return 'image'
    
    # 检查 XML
    if raw_bytes[:100].lstrip().startswith(b'<?xml') or raw_bytes[:100].lstrip().startswith(b'<Invoice'):
        return 'xml'
    
    # 检查 ZIP（可能是 OFD）
    if raw_bytes.startswith(b'PK\x03\x04'):
        return _detect_ofd_from_zip(raw_bytes)
    
    return None


def _detect_ofd_from_zip(raw_bytes):
    """检查 ZIP 文件是否为 OFD 格式"""
    try:
        import zipfile
        with zipfile.ZipFile(io.BytesIO(raw_bytes), 'r') as z:
            if 'OFD.xml' in z.namelist():
                return 'ofd'
    except Exception:
        pass
    return 'unknown'


def _detect_by_extension(filename):
    """使用扩展名检测文件类型"""
    if not filename:
        return 'unknown'
    
    ext = filename.lower().rsplit('.', 1)[-1] if '.' in filename else ''
    
    if ext in ('pdf',):
        return 'pdf'
    if ext in ('jpg', 'jpeg', 'png', 'bmp', 'tiff', 'tif'):
        return 'image'
    if ext in ('ofd',):
        return 'ofd'
    if ext in ('xml',):
        return 'xml'
    
    return 'unknown'


# =========================
# PDF 安全检查
# =========================

def _is_image_page(page) -> bool:
    """判断单个 PDF 页面是否为图片型：无可提取文本但有嵌入图片"""
    text = (page.get_text("text") or "").strip()
    if len(text) >= 10:
        return False
    images = page.get_images(full=True)
    return len(images) > 0


def validate_pdf(raw_bytes):
    """
    验证 PDF 文件的安全性，同时完成 text/image 分类。
    
    Returns:
        tuple: (is_valid, error_message, page_count, pdf_kind, doc)
            doc 是已打开的 fitz.Document（调用方负责关闭），
            pdf_kind 为 'text'（文本型）或 'image'（图片型）。
    """
    try:
        import fitz
        
        # 尝试打开 PDF
        doc = fitz.open(stream=raw_bytes, filetype='pdf')
        
        # 检查是否加密
        if doc.is_encrypted:
            doc.close()
            return False, 'PDF 文件已加密，无法解析', 0, 'text', None
        
        # 检查页数
        page_count = len(doc)
        if page_count > MAX_PDF_PAGES:
            doc.close()
            return False, f'PDF 页数超过限制（最大 {MAX_PDF_PAGES} 页）', page_count, 'image', None
        
        # 检查是否可访问
        if page_count > 0:
            try:
                page = doc[0]
                _ = page.get_text()
            except Exception as e:
                doc.close()
                return False, f'PDF 内容无法访问: {str(e)}', page_count, 'image', None
        
        # 分类：文本型 vs 图片型
        # [PERF] 仅检查首页即可分类（绝大多数发票 PDF 为单页，或首页与后续页结构一致）。
        # 仅当首页看起来像图片型时才回退到全页扫描，避免每页一次 get_text 的浪费。
        first_is_image = _is_image_page(doc[0]) if page_count > 0 else False
        if not first_is_image:
            pdf_kind = 'text'
        else:
            # 首页像图片型 → 扫描其余页以确认多数页是否都是图片型
            image_pages = 1 + sum(
                1 for p in list(doc)[1:] if _is_image_page(p)
            )
            pdf_kind = 'image' if image_pages > page_count / 2 else 'text'
        
        # doc 不关闭，交给调用方管理生命周期
        return True, None, page_count, pdf_kind, doc
    
    except Exception as e:
        return False, f'无法打开 PDF 文件: {str(e)}', 0, 'image', None


# =========================
# 图片安全检查
# =========================

def validate_image(raw_bytes):
    """
    验证图片文件的安全性
    
    Returns:
        tuple: (is_valid, error_message, width, height)
    """
    try:
        from PIL import Image as PILImage
        
        # 设置像素上限
        PILImage.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
        
        # 打开图片
        img = PILImage.open(io.BytesIO(raw_bytes))
        
        try:
            # 验证图片完整性（尝试读取像素）
            img.verify()
            
            # 重新打开以获取尺寸
            img = PILImage.open(io.BytesIO(raw_bytes))
            width, height = img.size
            
            # 检查像素数
            total_pixels = width * height
            if total_pixels > MAX_IMAGE_PIXELS:
                return False, f'图片像素数超过限制（最大 {MAX_IMAGE_PIXELS:,} 像素）', width, height
            
            return True, None, width, height
        finally:
            img.close()
    
    except Exception as e:
        return False, f'无法打开图片文件: {str(e)}', 0, 0


# =========================
# 统一验证接口
# =========================

def validate_file(raw_bytes, filename):
    """
    统一文件验证入口
    
    Returns:
        dict: {
            'valid': bool,
            'file_type': str,
            'error': str or None,
            'details': dict
        }
    """
    result = {
        'valid': False,
        'file_type': 'unknown',
        'error': None,
        'details': {}
    }
    
    # 检测文件类型
    file_type, detect_error = detect_file_type(raw_bytes, filename)
    result['file_type'] = file_type
    
    if detect_error:
        result['error'] = detect_error
        return result
    
    # 根据文件类型进行验证
    if file_type == 'pdf':
        valid, error, page_count, pdf_kind, pdf_doc = validate_pdf(raw_bytes)
        result['valid'] = valid
        result['error'] = error
        result['details']['page_count'] = page_count
        result['details']['pdf_kind'] = pdf_kind
        result['details']['pdf_doc'] = pdf_doc  # doc 由调用方负责关闭
    
    elif file_type == 'image':
        valid, error, width, height = validate_image(raw_bytes)
        result['valid'] = valid
        result['error'] = error
        result['details']['width'] = width
        result['details']['height'] = height
        result['details']['pixels'] = width * height
    
    elif file_type in ('ofd', 'xml'):
        # OFD 和 XML 暂时只做基础检查
        result['valid'] = True
    
    else:
        result['error'] = '不支持的文件格式'
    
    return result
