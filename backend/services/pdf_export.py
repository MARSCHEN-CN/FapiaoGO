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

        task.complete()
        return task
