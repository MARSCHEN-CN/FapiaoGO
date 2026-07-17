"""PDF 输入处理器：单独导出→直接写入（无损），合并→fitz insert_pdf。"""

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


class PdfExportHandlerImpl(PdfExportHandler):
    """处理 PDF 输入。

    关键约束：PDF 不走 fitz 重编码，直接写 bytes 保持原内容。
    - 单独导出：source bytes 直接写 output_path（零质量损失、保留元数据）。
    - 合并导出：fitz.open(stream) → insert_pdf
    - PermissionError fallback（对已打开的源文件句柄异常）：fitz.open(stream) → save
    """

    def can_handle(self, file_format: str, details: Optional[Dict] = None) -> bool:
        return file_format == 'pdf'

    def export_to_pdf(self, source: bytes, output_path: str, **kwargs) -> Dict[str, Any]:
        # ── 直接写字节，不经过 fitz，保持原文件内容 ──
        tmp_path = output_path + '.tmp'
        try:
            with open(tmp_path, 'wb') as f:
                f.write(source)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, output_path)
        except OSError:
            # 清理临时文件
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            # fallback：fitz 兜底（极端情况）
            if fitz is None:
                raise RuntimeError("PyMuPDF (fitz) is not available for fallback")
            logger.info("write failed for %s, falling back to fitz", output_path)
            self._fallback_fitz_open(source, output_path)

        # 验证输出
        sha256 = self._verify_pdf(output_path)

        return {
            'pages': self._count_pages(output_path),
            'sha256': sha256,
            'size': os.path.getsize(output_path),
            'warnings': [],
        }

    def export_merge(self, source: bytes, filename: str,
                     target_doc: 'fitz.Document') -> int:
        """将源 PDF 的页面插入目标文档（合并模式用）。

        Args:
            source:     源文件字节。
            filename:   文件名（仅用于日志）。
            target_doc: 目标 fitz.Document（调用方持有生命周期）。

        Returns:
            插入的页数。
        """
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is not available")

        src_doc = fitz.open(stream=source, filetype="pdf")
        try:
            page_count = len(src_doc)
            if page_count == 0:
                logger.warning("merge: %s is empty (0 pages)", filename)
                return 0
            target_doc.insert_pdf(src_doc)
            logger.debug("merge: inserted %d pages from %s", page_count, filename)
            return page_count
        finally:
            src_doc.close()

    # ── internal ────────────────────────────────────────────────

    def _fallback_fitz_open(self, source: bytes, output_path: str):
        """fitz 兜底路径：open(stream) → save。"""
        src_doc = fitz.open(stream=source, filetype="pdf")
        try:
            src_doc.save(output_path, incremental=False, deflate=True)
        finally:
            src_doc.close()

    def _verify_pdf(self, path: str) -> str:
        """验证 PDF 可打开，返回 SHA256。"""
        with open(path, 'rb') as f:
            content = f.read()
        sha256 = hashlib.sha256(content).hexdigest()
        # 快速验证：fitz 可打开
        if fitz is not None:
            doc = fitz.open(path)
            doc.close()
        return sha256

    def _count_pages(self, path: str) -> int:
        if fitz is None:
            return 1
        doc = fitz.open(path)
        try:
            return len(doc)
        finally:
            doc.close()
