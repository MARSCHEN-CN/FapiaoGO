"""PdfExportResolver — 格式检测 + 按类型分发到 Handler。

职责：接收 file_bytes + filename → 检测格式 → 返回对应 Handler。
不感知：SSE、Task、Progress。
"""

import logging
from typing import Any, Dict, Optional

from .base import PdfExportHandler
from .pdf_handler import PdfExportHandlerImpl
from .image_handler import ImageExportHandler
from .ofd_handler import OfdExportHandler

logger = logging.getLogger(__name__)

# 延迟导入 detect_file_format（避免 module 级依赖循环）
_INVOICE_SERVICE = None


def _get_detect_file_format():
    global _INVOICE_SERVICE
    if _INVOICE_SERVICE is None:
        from services.invoice_service import detect_file_format
        _INVOICE_SERVICE = detect_file_format
    return _INVOICE_SERVICE


class PdfExportResolver:
    """格式检测 + 按类型分发到 Handler。"""

    def __init__(self):
        self._handlers: Dict[str, PdfExportHandler] = {
            'pdf': PdfExportHandlerImpl(),
            'image': ImageExportHandler(),
            'ofd': OfdExportHandler(),
        }

    def resolve(self, file_bytes: bytes, filename: str) -> Optional[PdfExportHandler]:
        """检测文件格式并返回对应的 Handler。

        Args:
            file_bytes: 源文件字节。
            filename:   原名（用于格式推断）。

        Returns:
            匹配的 Handler，或 None（格式不支持）。
        """
        detect = _get_detect_file_format()
        file_format, details = detect(file_bytes, filename)
        if file_format is None:
            logger.warning("resolve: unsupported format for %s", filename)
            return None

        handler = self._handlers.get(file_format)
        if handler is None:
            logger.warning("resolve: no handler for format '%s' (%s)", file_format, filename)
            return None

        return handler

    def resolve_by_format(self, file_format: str) -> Optional[PdfExportHandler]:
        """按已知格式字符串获取 Handler（跳过格式检测，调用方已确认格式时用）。"""
        return self._handlers.get(file_format)

    @property
    def supported_formats(self):
        return list(self._handlers.keys())
