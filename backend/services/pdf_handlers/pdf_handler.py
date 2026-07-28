"""PDF 输入处理器：单独导出→直接写入（无损），合并→fitz insert_pdf。"""

import logging
import os
import shutil
from typing import Any, Dict, Optional

from .base import PdfExportHandler

logger = logging.getLogger(__name__)

try:
    import fitz
except ImportError:
    fitz = None


class PdfExportHandlerImpl(PdfExportHandler):
    """处理 PDF 输入。

    关键约束：PDF 不走 fitz 重编码，直接写 bytes/拷贝文件 保持原内容。
    - 单独导出：优先文件系统拷贝（零拷贝、最快），否则 source bytes 直接写 output_path。
    - 合并导出：fitz.open(stream) → insert_pdf
    - PermissionError fallback：fitz.open(stream) → save
    """

    def can_handle(self, file_format: str, details: Optional[Dict] = None) -> bool:
        return file_format == 'pdf'

    def export_to_pdf(self, source: bytes, output_path: str,
                      source_path: str = '', **kwargs) -> Dict[str, Any]:
        pages = 0
        size = 0

        if source_path and os.path.isfile(source_path) and os.path.abspath(source_path) != os.path.abspath(output_path):
            try:
                shutil.copy2(source_path, output_path)
                size = os.path.getsize(output_path)
                if fitz is not None:
                    try:
                        doc = fitz.open(output_path)
                        pages = len(doc)
                        doc.close()
                    except Exception:
                        pages = 1
                else:
                    pages = 1
                return {'pages': pages, 'size': size, 'warnings': []}
            except OSError:
                pass

        if not source and source_path and os.path.isfile(source_path):
            with open(source_path, 'rb') as f:
                source = f.read()

        os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
        tmp_path = output_path + '.tmp'
        try:
            with open(tmp_path, 'wb') as f:
                f.write(source)
            os.replace(tmp_path, output_path)
        except OSError:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            if fitz is None:
                raise RuntimeError("PyMuPDF (fitz) is not available for fallback")
            logger.info("write failed for %s, falling back to fitz", output_path)
            self._fallback_fitz_open(source, output_path)

        size = os.path.getsize(output_path)
        if fitz is not None:
            try:
                doc = fitz.open(output_path)
                pages = len(doc)
                doc.close()
            except Exception:
                pages = 1
        else:
            pages = 1

        return {'pages': pages, 'size': size, 'warnings': []}

    def export_merge(self, source: bytes, filename: str,
                     target_doc: 'fitz.Document') -> int:
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is not available")

        src_doc = fitz.open(stream=source, filetype="pdf")
        try:
            page_count = len(src_doc)
            if page_count == 0:
                logger.warning("merge: %s is empty (0 pages)", filename)
                return 0
            target_doc.insert_pdf(src_doc)
            return page_count
        finally:
            src_doc.close()

    def _fallback_fitz_open(self, source: bytes, output_path: str):
        src_doc = fitz.open(stream=source, filetype="pdf")
        try:
            src_doc.save(output_path, incremental=False, deflate=True)
        finally:
            src_doc.close()
