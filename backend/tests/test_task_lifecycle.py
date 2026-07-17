"""ExportTask 状态机契约测试 — 锁定任务生命周期的终态不可变性。

本文件是 SSE 接入（Phase 3.1.3-B）前的封板约束：
SSE 消费者依赖 task 终态（COMPLETED / FAILED / CANCELLED）判定流结束，
一旦终态可被覆盖，就会出现"已取消误报完成 / 失败被覆盖"的回归。

状态机：
    RUNNING ──complete()──▶ COMPLETED
           ──fail()──────▶ FAILED
           ──cancel()────▶ CANCELLED

禁止的覆盖（终态不可变）：
    CANCELLED → COMPLETED   (保留 CANCELLED)
    FAILED    → COMPLETED   (保留 FAILED)
    CANCELLED → FAILED      (保留 CANCELLED)   # 取消优先于失败

任何改动 task.py 的人，本文件都应让其无法通过，从而防止重新引入上述 bug。
"""

import pytest

from services.task import ExportTask, TaskStatus


class TestTaskLifecycleStateMachine:
    # ── 允许的 RUNNING → 终态转换 ──

    def test_running_to_completed(self):
        task = ExportTask(total=1)
        task.start()
        task.complete()
        assert task.status == TaskStatus.COMPLETED

    def test_running_to_failed(self):
        task = ExportTask(total=1)
        task.start()
        task.fail("boom")
        assert task.status == TaskStatus.FAILED

    def test_running_to_cancelled(self):
        task = ExportTask(total=1)
        task.start()
        task.cancel()
        assert task.status == TaskStatus.CANCELLED

    # ── 禁止的终态覆盖 ──

    def test_cancelled_cannot_be_completed(self):
        """取消后即便 complete() 被调用，仍是 CANCELLED。

        这正对应生产环境回归：SSE 消费者把"已取消"误判为"完成"。
        """
        task = ExportTask(total=1)
        task.start()
        task.cancel()
        task.complete()
        assert task.status == TaskStatus.CANCELLED

    def test_failed_cannot_be_completed(self):
        """失败后即便 complete() 被调用，仍是 FAILED。"""
        task = ExportTask(total=1)
        task.start()
        task.fail("boom")
        task.complete()
        assert task.status == TaskStatus.FAILED

    def test_cancelled_cannot_be_overwritten_by_fail(self):
        """取消优先：即便编排层随后捕获异常调用 fail()，仍是 CANCELLED。

        场景：用户点取消 → Handler 正在抛异常 → Service catch 到异常调 fail()。
        最终必须是 CANCELLED，否则 UI 显示"导出失败"而非"用户主动取消"。
        """
        task = ExportTask(total=1)
        task.start()
        task.cancel()
        task.fail("late exception")
        assert task.status == TaskStatus.CANCELLED
        # 取消态不应被追加失败错误（fail 守卫提前返回）
        assert len(task.errors) == 0
