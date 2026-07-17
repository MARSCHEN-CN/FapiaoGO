"""SSE 进度流生成器 — 纯传输层，不感知导出业务。

职责边界（Phase 3.1.3-B 冻结）：
  - 按 task_id 从 TaskRegistry 读 ExportTask
  - yield 其 to_dict() 快照（状态的唯一来源是 ExportTask）
  - 任务进入终态（completed / failed / cancelled）后停止

禁止（SSE 不得制造或改变业务状态）：
  - 调用 PdfExportService / Handler / Resolver
  - 调用 task.advance() / task.complete() / task.fail() / task.cancel()
  - 自行构造 status 字典（必须用 task.to_dict()，保证状态单一来源）

分层位置：
  - 上层（app.py / routes）：把本生成器的 dict 包成 `data: {...}\\n\\n` SSE 帧，
    并处理 KeyError → 404。
  - 下层：TaskRegistry / ExportTask（生命周期），Service / Handler（业务）。
"""

import time

from .task import ExportTask, TaskRegistry, TaskStatus, task_registry as _global_task_registry

# 终态集合：进入其一即停止推送（状态唯一来源 = ExportTask.to_dict()）
_TERMINAL_STATUSES = frozenset({
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
})


def stream_export_progress(
    task_id: str,
    task_registry: TaskRegistry = None,
    poll_interval: float = 0.5,
):
    """生成导出进度事件序列（纯 dict，无 SSE 帧格式）。

    Args:
        task_id: 任务 ID。
        task_registry: TaskRegistry 实例，默认全局单例。
        poll_interval: 非终态时两次轮询的间隔（秒），避免忙等烧 CPU。
                       传入 0 可关闭等待（测试用）。

    Yields:
        ExportTask.to_dict() 的当前快照。终态只 yield 一次后停止。

    Raises:
        KeyError: task_id 在注册器中不存在（上层映射为 404 / unknown_task）。
    """
    registry = task_registry or _global_task_registry
    task = registry.get(task_id)
    if task is None:
        raise KeyError(task_id)

    while True:
        state = task.to_dict()                      # 状态唯一来源：ExportTask
        yield state
        if TaskStatus(state['status']) in _TERMINAL_STATUSES:
            break
        if poll_interval > 0:
            time.sleep(poll_interval)
