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
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

from .pdf_handlers.resolver import PdfExportResolver
from .task import ExportTask, TaskRegistry, task_registry as _global_task_registry

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════
# 数据类型
# ═══════════════════════════════════════════════════════════


@dataclass
class ExportItem:
    """单个导出文件项。

    source:      源文件字节。
    output_path: 目标 .pdf 文件绝对路径（Service 不校验目录存在性）。
    filename:    源文件名（仅用于日志 / progress 展示，不影响处理逻辑）。
    """
    source: bytes
    output_path: str
    filename: str = ''


# ═══════════════════════════════════════════════════════════
# Service
# ═══════════════════════════════════════════════════════════


class PdfExportService:
    """PDF 导出编排服务。

    Args:
        resolver: PdfExportResolver 实例（格式检测 + Handler 分发）。
        task_registry: TaskRegistry 实例（任务生命周期管理），默认全局单例。
    """

    def __init__(
        self,
        resolver: Optional[PdfExportResolver] = None,
        task_registry: Optional[TaskRegistry] = None,
    ):
        self.resolver = resolver or PdfExportResolver()
        self._task_registry = task_registry or _global_task_registry

    # ── 单文件导出 ──

    def export_file(self, source: bytes, output_path: str,
                    filename: str = '', task: Optional[ExportTask] = None) -> bool:
        """导出一个文件到 PDF。

        Args:
            source:      源文件字节。
            output_path: 目标 .pdf 路径。
            filename:    源文件名（日志用）。
            task:        可选，关联到已有任务（更新进度）。为 None 时不记录。

        Returns:
            bool: 导出是否成功。
        """
        handler = self.resolver.resolve(source, filename or 'unknown')
        if handler is None:
            msg = f"不支持的格式: {filename}"
            logger.warning("[PdfExport] %s", msg)
            if task is not None:
                task.add_error(filename or 'unknown', msg)
                task.advance(filename)  # 计入已处理（失败也算）
            return False

        try:
            result = handler.export_to_pdf(source, output_path)
            logger.info("[PdfExport] 成功: %s → %s (%d pages, %.1f KB)",
                        filename, output_path, result['pages'], result['size'] / 1024)
            if task is not None:
                task.advance(filename)
            return True
        except Exception as e:
            logger.error("[PdfExport] 失败: %s → %s: %s", filename, output_path, e)
            if task is not None:
                task.add_error(filename or output_path, str(e))
                task.advance(filename)  # 计入已处理（失败也算）
            return False

    # ── 批量导出 ──

    def export_files(self, items: List[ExportItem],
                     task: Optional[ExportTask] = None) -> ExportTask:
        """批量导出文件（单个失败不中断整个批次）。

        Args:
            items: 导出文件列表。
            task:  可选，已有任务对象。为 None 时自动创建。

        Returns:
            含有最终状态、进度、错误列表的 ExportTask。
        """
        # 初始化 task
        if task is None:
            task = self._task_registry.create(total=len(items))
        else:
            task.total = len(items)
            task.current = 0

        task.start()

        try:
            for item in items:
                # ── 取消检查 ──
                if task.cancelled:
                    logger.info("[PdfExport] 任务 %s 已取消，跳过剩余 %d 个文件",
                                task.id[:8], len(items) - task.current)
                    break

                self.export_file(
                    source=item.source,
                    output_path=item.output_path,
                    filename=item.filename,
                    task=task,
                )
        except Exception as e:
            # 编排层不可恢复错误（resolver 抛错等）：标记失败，保证生命周期闭合
            # （否则 SSE 消费者永远看不到终态）。同步调用方可继续捕获原异常。
            logger.exception("[PdfExport] 任务 %s 编排失败: %s", task.id[:8], e)
            task.fail(str(e))
            raise

        task.complete()
        return task

    # ── 合并导出 ──

    def merge_files(self, items: List[ExportItem], output_path: str,
                    task: Optional[ExportTask] = None) -> ExportTask:
        """将多个文件合并为一个 PDF（按 items 顺序）。

        每个源文件通过对应 Handler 的 export_merge 插入页面到同一 fitz.Document，
        最后保存到 output_path。单个失败不中断整个合并。

        Args:
            items:      源文件列表。
            output_path: 合并后 PDF 输出路径。
            task:        可选，已有任务对象。

        Returns:
            含有最终状态、进度、错误列表的 ExportTask。
        """
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

                # 更新 currentFile 用于进度展示，但不推进计数
                task.current_file = item.filename
                task._notify()

                handler = self.resolver.resolve(item.source, item.filename or 'unknown')
                if handler is None:
                    msg = f"不支持的格式，跳过合并: {item.filename}"
                    logger.warning("[PdfExport] %s", msg)
                    if task is not None:
                        task.add_error(item.filename or 'unknown', msg)
                    continue

                try:
                    # 调用 Handler 的 export_merge
                    export_merge = getattr(handler, 'export_merge', None)
                    if export_merge is None:
                        raise NotImplementedError(
                            f"{type(handler).__name__} 不支持合并")
                    insert_count = export_merge(item.source, item.filename, target_doc)
                    logger.info("[PdfExport] merge: %s → %d pages",
                                item.filename, insert_count)
                except Exception as e:
                    logger.error("[PdfExport] merge 失败: %s: %s", item.filename, e)
                    if task is not None:
                        task.add_error(item.filename, str(e))
            else:
                # 循环未被 break，保存合并结果
                # merge 视为 1 次操作（输出 1 个文件）
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
            # 编排层不可恢复错误：标记失败，保证生命周期闭合
            logger.exception("[PdfExport] merge 任务 %s 编排失败: %s", task.id[:8], e)
            task.fail(str(e))
            raise
        finally:
            target_doc.close()

        task.complete()
        return task
