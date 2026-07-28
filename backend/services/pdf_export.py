"""PDF 导出编排层 — 纯 orchestration，不感知 Flask/SSE。

职责：
  接收导出请求 → 遍历文件 → 调 Resolver → 调 Handler → 更新 Task 状态。

分层位置：
  - Handler 层（pdf_handlers/）：纯能力，不含 Task。
  - Service 层（本文件）：编排 Handler + Task，暴露 progress_callback。
  - SSE 端点（app.py）：创建 Service/Task，处理 HTTP 请求/响应。

核心原则：
  - 不做格式判断（`if ext == ".pdf"`）
  - 不直接调 fitz
  - 不处理 HTTP/SSE
  - 单个失败不终止整个批次
  - 每个文件前检查取消 flag
  - 文件名生成由调用方负责，Service 不碰命名逻辑
"""

import logging
import os
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from .pdf_handlers.resolver import PdfExportResolver
from .task import ExportTask, TaskRegistry, task_registry as _global_task_registry

logger = logging.getLogger(__name__)


@dataclass
class ExportItem:
    """单个导出文件项。

    source:      源文件字节（可为空，此时 source_path 必须有值）。
    source_path: 源文件路径（优先用于零拷贝文件操作）。
    output_path: 目标 .pdf 文件绝对路径（Service 不校验目录存在性）。
    filename:    源文件名（仅用于日志 / progress 展示，不影响处理逻辑）。
    file_format: 文件格式提示（'pdf'/'image'/'ofd' 等），不传则由 resolver 探测。
    """
    output_path: str
    filename: str = ''
    source: bytes = b''
    source_path: str = ''
    file_format: str = ''

    def ensure_source(self) -> bytes:
        if self.source:
            return self.source
        if self.source_path and os.path.isfile(self.source_path):
            with open(self.source_path, 'rb') as f:
                self.source = f.read()
            return self.source
        return b''


class PdfExportService:

    def __init__(
        self,
        resolver: Optional[PdfExportResolver] = None,
        task_registry: Optional[TaskRegistry] = None,
    ):
        self.resolver = resolver or PdfExportResolver()
        self._task_registry = task_registry or _global_task_registry

    def _resolve_format(self, item: ExportItem) -> str:
        if item.file_format:
            return item.file_format
        if item.filename:
            ext = os.path.splitext(item.filename)[1].lower().lstrip('.')
            if ext in ('pdf', 'png', 'jpg', 'jpeg', 'bmp', 'gif', 'tiff', 'webp', 'ofd'):
                return 'pdf' if ext == 'pdf' else ('ofd' if ext == 'ofd' else 'image')
        head = b''
        if item.source:
            head = item.source[:8]
        elif item.source_path and os.path.isfile(item.source_path):
            with open(item.source_path, 'rb') as f:
                head = f.read(8)
        if head.startswith(b'%PDF'):
            return 'pdf'
        if head.startswith(b'%OFD'):
            return 'ofd'
        return 'image'

    def export_file(self, item: ExportItem,
                    task: Optional[ExportTask] = None) -> bool:
        filename = item.filename or 'unknown'
        file_format = self._resolve_format(item)
        handler = self.resolver.resolve_by_format(file_format) if file_format else None
        if handler is None:
            source = item.ensure_source()
            handler = self.resolver.resolve(source, filename)
        if handler is None:
            msg = f"不支持的格式: {filename}"
            logger.warning("[PdfExport] %s", msg)
            if task is not None:
                task.add_error(filename, msg)
                task.advance(filename)
            return False

        try:
            kwargs = {}
            if hasattr(handler, 'export_to_pdf'):
                import inspect
                sig = inspect.signature(handler.export_to_pdf)
                if 'source_path' in sig.parameters:
                    kwargs['source_path'] = item.source_path

            source = item.ensure_source()
            result = handler.export_to_pdf(source, item.output_path, **kwargs)
            logger.info("[PdfExport] 成功: %s → %s (%d pages, %.1f KB)",
                        filename, item.output_path, result.get('pages', 1), result.get('size', 0) / 1024)
            if task is not None:
                task.advance(filename)
            return True
        except Exception as e:
            logger.error("[PdfExport] 失败: %s → %s: %s", filename, item.output_path, e)
            if task is not None:
                task.add_error(filename or item.output_path, str(e))
                task.advance(filename)
            return False

    def export_files(self, items: List[ExportItem],
                     task: Optional[ExportTask] = None) -> ExportTask:
        if task is None:
            task = self._task_registry.create(total=len(items))
        else:
            task.total = len(items)
            task.current = 0

        task.start()

        try:
            for item in items:
                if task.cancelled:
                    logger.info("[PdfExport] 任务 %s 已取消，跳过剩余 %d 个文件",
                                task.id[:8], len(items) - task.current)
                    break
                self.export_file(item, task=task)
        except Exception as e:
            logger.exception("[PdfExport] 任务 %s 编排失败: %s", task.id[:8], e)
            task.fail(str(e))
            raise

        task.complete()
        return task

    def merge_files(self, items: List[ExportItem], output_path: str,
                    task: Optional[ExportTask] = None) -> ExportTask:
        if task is None:
            task = self._task_registry.create(total=1)
        else:
            task.total = 1
            task.current = 0

        task.start()

        try:
            import fitz
        except ImportError:
            raise RuntimeError("PyMuPDF (fitz) is not available for merge")

        target_doc = fitz.open()
        try:
            for item in items:
                if task.cancelled:
                    logger.info("[PdfExport] merge 任务 %s 已取消，跳过剩余 %d 个文件",
                                task.id[:8], len(items) - task.current)
                    break

                task.current_file = item.filename
                task._notify()

                file_format = self._resolve_format(item)
                handler = self.resolver.resolve_by_format(file_format) if file_format else None
                if handler is None:
                    source = item.ensure_source()
                    handler = self.resolver.resolve(source, item.filename or 'unknown')
                if handler is None:
                    msg = f"不支持的格式，跳过合并: {item.filename}"
                    logger.warning("[PdfExport] %s", msg)
                    if task is not None:
                        task.add_error(item.filename or 'unknown', msg)
                    continue

                try:
                    export_merge = getattr(handler, 'export_merge', None)
                    if export_merge is None:
                        raise NotImplementedError(
                            f"{type(handler).__name__} 不支持合并")
                    source = item.ensure_source()
                    insert_count = export_merge(source, item.filename, target_doc)
                    logger.info("[PdfExport] merge: %s → %d pages",
                                item.filename, insert_count)
                except Exception as e:
                    logger.error("[PdfExport] merge 失败: %s: %s", item.filename, e)
                    if task is not None:
                        task.add_error(item.filename, str(e))
            else:
                if len(target_doc) > 0:
                    target_doc.save(output_path, incremental=False, deflate=True)
                    total_pages = len(target_doc)
                    logger.info("[PdfExport] merge 完成: %s (%d pages)",
                                output_path, total_pages)
                    if total_pages > 500:
                        logger.warning("[PdfExport] 合并文件超过 500 页 (%d)，"
                                      "建议分批导出以控制内存", total_pages)
                else:
                    logger.warning("[PdfExport] merge: 无有效页面，跳过保存")

                task.advance('merged.pdf')
        except Exception as e:
            logger.exception("[PdfExport] merge 任务 %s 编排失败: %s", task.id[:8], e)
            task.fail(str(e))
            raise
        finally:
            target_doc.close()

        task.complete()
        return task
