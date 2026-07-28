"""图片输入处理器：Image→PDF（通过 fitz 嵌入单页 PDF 实现）。"""

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

    def can_handle(self, file_format: str, details: Optional[Dict] = None) -> bool:
        return file_format == 'image'

    def export_to_pdf(self, source: bytes, output_path: str,
                      source_path: str = '', **kwargs) -> Dict[str, Any]:
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is not available")

        img = fitz.open(stream=source) if source else fitz.open(source_path)
        try:
            page = img[0]
            img_w, img_h = page.rect.width, page.rect.height
        finally:
            img.close()

        pdf_doc = fitz.open()
        try:
            pdf_doc.new_page(width=img_w, height=img_h)
            pdf_page = pdf_doc[0]
            pdf_page.insert_image(fitz.Rect(0, 0, img_w, img_h), stream=source)
            os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
            pdf_doc.save(output_path, incremental=False, deflate=True)
        finally:
            pdf_doc.close()

        return {
            'pages': 1,
            'size': os.path.getsize(output_path),
            'warnings': [],
        }

    def export_merge(self, source: bytes, filename: str,
                     target_doc: 'fitz.Document') -> int:
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is not available")

        import io
        tmp_pdf_bytes = io.BytesIO()
        img = fitz.open(stream=source)
        try:
            page = img[0]
            img_w, img_h = page.rect.width, page.rect.height
        finally:
            img.close()

        tmp_pdf = fitz.open()
        try:
            tmp_pdf.new_page(width=img_w, height=img_h)
            tmp_page = tmp_pdf[0]
            tmp_page.insert_image(fitz.Rect(0, 0, img_w, img_h), stream=source)
            tmp_pdf.save(tmp_pdf_bytes, deflate=True)
        finally:
            tmp_pdf.close()

        tmp_pdf_bytes.seek(0)
        tmp_doc = fitz.open(stream=tmp_pdf_bytes.read(), filetype="pdf")
        try:
            page_count = len(tmp_doc)
            if page_count == 0:
                return 0
            target_doc.insert_pdf(tmp_doc)
            return page_count
        finally:
            tmp_doc.close()
