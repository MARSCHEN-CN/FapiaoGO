"""OFD 输入处理器：OFD→PDF（通过 render_engine 栅格化后嵌入临时 PDF）。

真实路径（已落地）：
  OFD → OFDAdapter.render(page, dpi) 栅格化 → WebP → PIL 解码/PNG → fitz 嵌入 PDF

页面物理尺寸按渲染 dpi 换算（pt = px * 72 / dpi），保证导出 PDF 为
真实物理页面（A4 @300dpi → 595x842pt），而非把像素当 pt 放大 4 倍。
"""

import hashlib
import io
import logging
import os
from typing import Any, Dict, Optional

from PIL import Image

from .base import PdfExportHandler

logger = logging.getLogger(__name__)

try:
    import fitz
except ImportError:
    fitz = None


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


class OfdExportHandler(PdfExportHandler):
    """OFD 输入处理器：栅格化后嵌入 PDF。"""

    def can_handle(self, file_format: str, details: Optional[Dict] = None) -> bool:
        return file_format == 'ofd'

    def export_to_pdf(self, source: bytes, output_path: str,
                      dpi: int = 300, source_path: str = '',
                      **kwargs) -> Dict[str, Any]:
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is not available")

        raw = source or b''
        if not raw and source_path and os.path.isfile(source_path):
            with open(source_path, 'rb') as f:
                raw = f.read()
        if not raw:
            raise ValueError("OFD 源为空，无法导出")

        pdf_doc, warnings = self._build_pdf_doc(raw, dpi=dpi)
        try:
            page_count = len(pdf_doc)
            if page_count == 0:
                raise ValueError("OFD 未渲染出任何页面")
            os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
            pdf_doc.save(output_path, incremental=False, deflate=True)
        finally:
            pdf_doc.close()

        sha = _sha256_file(output_path)
        size = os.path.getsize(output_path)
        return {
            'pages': page_count,
            'sha256': sha,
            'size': size,
            'warnings': warnings,
        }

    def export_merge(self, source: bytes, filename: str,
                     target_doc: 'fitz.Document', dpi: int = 300,
                     **kwargs) -> int:
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is not available")

        raw = source or b''
        sp = kwargs.get('source_path') or ''
        if not raw and sp and os.path.isfile(sp):
            with open(sp, 'rb') as f:
                raw = f.read()
        if not raw:
            raise ValueError("OFD 源为空，无法合并导出")

        pdf_doc, _warnings = self._build_pdf_doc(raw, dpi=dpi)
        try:
            count = len(pdf_doc)
            if count == 0:
                return 0
            target_doc.insert_pdf(pdf_doc)
            return count
        finally:
            pdf_doc.close()

    # ── 内部 ──
    def _build_pdf_doc(self, raw: bytes, dpi: int = 300):
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is not available")
        from render_engine.adapters.ofd_adapter import OFDAdapter

        adapter = OFDAdapter(raw, dpi=dpi)
        page_count = adapter.page_count()
        pdf_doc = fitz.open()
        warnings: list = []
        inserted = 0
        pt_per_px = 72.0 / dpi
        for i in range(page_count):
            webp = adapter.render(i, dpi=dpi)
            if webp is None:
                warnings.append(f"第 {i + 1} 页渲染失败，已跳过")
                logger.warning("[OfdExport] 第 %d 页渲染为空，跳过", i + 1)
                continue
            # PyMuPDF 无法识别无扩展名 WebP 流，经 PIL 解码并转 PNG 再嵌入
            with Image.open(io.BytesIO(webp)) as img:
                px_w, px_h = img.size
                png_buf = io.BytesIO()
                img.save(png_buf, format='PNG')
                png_bytes = png_buf.getvalue()
            w = px_w * pt_per_px
            h = px_h * pt_per_px
            pdf_doc.new_page(width=w, height=h)
            pdf_page = pdf_doc[inserted]
            pdf_page.insert_image(fitz.Rect(0, 0, w, h), stream=png_bytes)
            inserted += 1
        if inserted == 0 and page_count > 0:
            logger.warning("[OfdExport] %d 页全部渲染失败", page_count)
        return pdf_doc, warnings
