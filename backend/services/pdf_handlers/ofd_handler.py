"""OFD 输入处理器（stub — 待 Phase 5 实现完整路径）。

当前 OFD→PDF 需通过 render_engine 栅格化为图片再嵌入 PDF，
依赖 registry 和 fitz 共享文档，计划 Phase 5 实现。
"""

from typing import Any, Dict, Optional

from .base import PdfExportHandler


class OfdExportHandler(PdfExportHandler):
    """OFD 输入处理器（stub）。

    真实路径（Phase 5）：
      OFD → render_engine 栅格化 → page image → 临时 PDF → insert_pdf
    """

    def can_handle(self, file_format: str, details: Optional[Dict] = None) -> bool:
        return file_format == 'ofd'

    def export_to_pdf(self, source: bytes, output_path: str, **kwargs) -> Dict[str, Any]:
        raise NotImplementedError(
            "OFD→PDF 需通过 render_engine 栅格化后嵌入临时 PDF，"
            "依赖 registry 和 fitz 共享文档，计划 Phase 5 实现"
        )

    def export_merge(self, source: bytes, filename: str,
                     target_doc: 'fitz.Document') -> int:
        raise NotImplementedError(
            "OFD→PDF(merge) 同上，计划 Phase 5 实现"
        )
