"""通用任务生命周期模型（Task — 不感知具体业务类型）。

职责：管理 task_id、status、progress、cancel_flag、errors。
可复用：PDF 导出、Excel 导出、OFD 导出、批量重命名等。

分层位置：
  - Handler 层（pdf_handlers/）：纯能力，不含 Task。
  - Service 层（pdf_export.py 等）：创建 Task，调用 Handler，更新进度。
  - SSE 端点：创建 Task，返回 task_id，流式推送 progress。
"""

import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional


# ═══════════════════════════════════════════════════════════
# 数据类型
# ═══════════════════════════════════════════════════════════


class TaskStatus(str, Enum):
    PENDING = 'pending'
    RUNNING = 'running'
    COMPLETED = 'completed'
    CANCELLED = 'cancelled'
    FAILED = 'failed'


@dataclass
class TaskError:
    """单个文件处理失败记录。"""
    file: str          # 文件名
    error: str         # 错误描述


@dataclass
class ExportTask:
    """通用导出任务模型。

    不感知：
      - 具体业务类型（PDF/Excel/...）
      - SSE/Flask/Electron
      - Handler 接口

    Service 层使用方式：
      task = TaskRegistry.create(total=10)
      task.progress_callback = on_progress  # 可选
      for file in files:
          if task.cancelled:
              break
          try:
              handler.export_to_pdf(...)
              task.advance(file_name)
          except Exception as e:
              task.add_error(file_name, str(e))
      task.complete()
    """
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    status: TaskStatus = TaskStatus.PENDING
    total: int = 0
    current: int = 0
    current_file: str = ''    # 当前正在处理的文件名
    errors: List[TaskError] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    # ── 可选回调：Service 层设置，用于通知外部（SSE/progress modal） ──
    progress_callback: Optional[Callable[['ExportTask'], None]] = None

    # ── 内部 ──
    _cancelled: bool = False

    # ── 进度控制 ──

    def start(self):
        """标记任务开始。"""
        self.status = TaskStatus.RUNNING
        self.updated_at = time.time()
        self._notify()

    def advance(self, file_name: str = ''):
        """推进一个文件进度。"""
        self.current += 1
        self.current_file = file_name
        self.updated_at = time.time()
        self._notify()

    def add_error(self, file: str, error: str):
        """记录单个文件错误（不中断整体流程）。"""
        self.errors.append(TaskError(file=file, error=error))
        self._notify()

    def complete(self):
        """标记任务完成（无错误或含错误均视为完成）。"""
        self.status = TaskStatus.COMPLETED
        self.updated_at = time.time()
        self._notify()

    def cancel(self):
        """请求取消（不强制中断线程，由 Service 层在每次 advance 前检查）。"""
        self._cancelled = True
        self.status = TaskStatus.CANCELLED
        self.updated_at = time.time()
        self._notify()

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    @property
    def percent(self) -> int:
        if self.total <= 0:
            return 0
        return min(100, round(self.current / self.total * 100))

    @property
    def success_count(self) -> int:
        return self.current - len(self.errors)

    # ── 序列化 ──

    def to_dict(self, include_progress_callback: bool = False) -> Dict[str, Any]:
        stage = ''
        if self.status == TaskStatus.RUNNING:
            stage = '正在导出'
        elif self.status == TaskStatus.COMPLETED:
            stage = '导出完成'
        elif self.status == TaskStatus.CANCELLED:
            stage = '已取消'

        d = {
            'taskId': self.id,
            'status': self.status.value,
            'total': self.total,
            'current': self.current,
            'percent': self.percent,
            'currentFile': self.current_file,
            'stage': stage,
            'successCount': self.success_count,
            'failCount': len(self.errors),
            'errors': [{'file': e.file, 'error': e.error} for e in self.errors],
        }
        if not include_progress_callback:
            pass  # callback 不可序列化，不返回
        return d

    def _notify(self):
        if self.progress_callback is not None:
            try:
                self.progress_callback(self)
            except Exception:
                pass


# ═══════════════════════════════════════════════════════════
# 任务注册器（管理多个任务生命周期 + 取消）
# ═══════════════════════════════════════════════════════════


class TaskRegistry:
    """全局任务注册器，管理所有导出任务。

    职责：
      - 创建任务（生成 task_id）
      - 按 task_id 获取任务
      - 取消任务（设 cancel flag）
      - 清理已完成的任务
    """

    def __init__(self):
        self._tasks: Dict[str, ExportTask] = {}
        self._lock = threading.Lock()

    def create(self, total: int = 0, progress_callback: Optional[Callable] = None) -> ExportTask:
        """创建新任务并注册。"""
        task = ExportTask(
            total=total,
            progress_callback=progress_callback,
        )
        with self._lock:
            self._tasks[task.id] = task
        return task

    def get(self, task_id: str) -> Optional[ExportTask]:
        with self._lock:
            return self._tasks.get(task_id)

    def cancel(self, task_id: str) -> bool:
        """请求取消任务。"""
        task = self.get(task_id)
        if task is None:
            return False
        task.cancel()
        return True

    def cleanup_old(self, max_age_seconds: int = 3600):
        """清理超过指定时间的已完成/已取消任务。"""
        cutoff = time.time() - max_age_seconds
        with self._lock:
            to_remove = [
                tid for tid, t in self._tasks.items()
                if t.status in (TaskStatus.COMPLETED, TaskStatus.CANCELLED, TaskStatus.FAILED)
                and t.updated_at < cutoff
            ]
            for tid in to_remove:
                del self._tasks[tid]
            return len(to_remove)

    def stats(self) -> Dict[str, Any]:
        with self._lock:
            active = sum(1 for t in self._tasks.values()
                         if t.status in (TaskStatus.PENDING, TaskStatus.RUNNING))
            completed = sum(1 for t in self._tasks.values()
                            if t.status == TaskStatus.COMPLETED)
            return {
                'total': len(self._tasks),
                'active': active,
                'completed': completed,
            }


# 全局单例
task_registry = TaskRegistry()
