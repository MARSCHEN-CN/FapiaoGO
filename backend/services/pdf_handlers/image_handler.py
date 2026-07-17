"""图片输入处理器：Image→PDF（通过 fitz 嵌入单页 PDF 的 Pixmap 实现）。"""

import hashlib
import logging
import os
from typing import Any, Dict, Optional

from .base import PdfExportHandler

logger = logging.getLogger(__name__)

try:
    import fitz
except ImportError:
    fitz = None


class ImageExportHandler(PdfExportHandler):
    """处理图片输入：通过 fitz 打开图片 → 嵌入单页 PDF page。"""

    def can_handle(self, file_format: str, details: Optional[Dict] = None) -> bool:
        return file_format == 'image'

    def export_to_pdf(self, source: bytes, output_path: str, **kwargs) -> Dict[str, Any]:
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is not available")

        # 打开图片获取原始像素尺寸
        img = fitz.open(stream=source)
        try:
            page = img[0]
            pix = page.get_pixmap()
            img_w, img_h = pix.width, pix.height
        finally:
            img.close()

        # 创建 PDF 文档，按图片原始像素尺寸建页
        pdf_doc = fitz.open()
        try:
            pdf_doc.new_page(width=img_w, height=img_h)
            pdf_page = pdf_doc[0]
            pdf_page.insert_image(fitz.Rect(0, 0, img_w, img_h), stream=source)
            pdf_doc.save(output_path, incremental=False, deflate=True)
        finally:
            pdf_doc.close()

        # 验证 & 哈希
        with open(output_path, 'rb') as f:
            content = f.read()
        sha256 = hashlib.sha256(content).hexdigest()

        return {
            'pages': 1,
            'sha256': sha256,
            'size': os.path.getsize(output_path),
            'warnings': [],
        }

    def export_merge(self, source: bytes, filename: str,
                     target_doc: 'fitz.Document') -> int:
        """图片→临时 PDF 页面→insert_pdf。

        流程：图片 → 临时单页 PDF bytes → 用 fitz.open 打开 → insert_pdf。
        不能直接用 FzDocument（图片）insert，必须先包装为 PDF。
        """
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is not available")

        # 先导出为临时 PDF bytes
        import tempfile
        tmp_fd, tmp_path = tempfile.mkstemp(suffix='.pdf')
        os.close(tmp_fd)
        try:
            self.export_to_pdf(source, tmp_path)
            with open(tmp_path, 'rb') as f:
                tmp_bytes = f.read()

            tmp_pdf = fitz.open(stream=tmp_bytes, filetype="pdf")
            try:
                page_count = len(tmp_pdf)
                if page_count == 0:
                    return 0
                target_doc.insert_pdf(tmp_pdf)
                return page_count
            finally:
                tmp_pdf.close()
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
