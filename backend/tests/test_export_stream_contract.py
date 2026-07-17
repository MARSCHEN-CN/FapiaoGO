"""SSE 进度流生成器契约测试 — 锁死「SSE 不制造状态」。

本文件是 architecture contract（与 test_task_lifecycle.py 同级别），
通过 .gitignore 白名单跟踪，确保任何改动 export_stream.py 的人
都无法让 SSE 反向控制业务状态。

核心契约：
  1. 流只 yield task.to_dict()，不自行构造状态字典。
  2. 终态（completed/failed/cancelled）后只 yield 一次并停止。
  3. 未知 task_id → 抛 KeyError（上层映射 404）。
  4. 迭代过程不改变 task 自身状态（SSE 只读）。
"""

import pytest

from services.task import ExportTask, TaskRegistry, TaskStatus
from services.export_stream import stream_export_progress


class TestSSEStreamContract:
    def test_sse_completed_yields_once(self):
        registry = TaskRegistry()
        task = registry.create(total=1)
        task.start()
        task.complete()

        events = list(stream_export_progress(task.id, task_registry=registry, poll_interval=0))
        assert len(events) == 1
        assert events[0] == task.to_dict()      # 状态来自 ExportTask，非手搓
        assert events[0]['status'] == 'completed'

    def test_sse_failed_yields_once(self):
        registry = TaskRegistry()
        task = registry.create(total=1)
        task.start()
        task.fail("boom")

        events = list(stream_export_progress(task.id, task_registry=registry, poll_interval=0))
        assert len(events) == 1
        assert events[0] == task.to_dict()
        assert events[0]['status'] == 'failed'

    def test_sse_cancelled_yields_once(self):
        registry = TaskRegistry()
        task = registry.create(total=1)
        task.start()
        task.cancel()

        events = list(stream_export_progress(task.id, task_registry=registry, poll_interval=0))
        assert len(events) == 1
        assert events[0] == task.to_dict()
        assert events[0]['status'] == 'cancelled'

    def test_sse_unknown_task_raises_key_error(self):
        registry = TaskRegistry()
        with pytest.raises(KeyError):
            list(stream_export_progress("does-not-exist", task_registry=registry, poll_interval=0))

    def test_sse_does_not_mutate_task_state(self):
        """SSE 只读：迭代首帧内容 == to_dict，且 task 状态未被改动。"""
        registry = TaskRegistry()
        task = registry.create(total=3)
        task.start()
        task.advance("a.pdf")   # running, current=1

        gen = stream_export_progress(task.id, task_registry=registry, poll_interval=0)
        first = next(gen)
        assert first == task.to_dict()             # 状态来自 ExportTask，非手搓
        assert task.status == TaskStatus.RUNNING   # SSE 没改状态
        assert task.current == 1
        gen.close()
