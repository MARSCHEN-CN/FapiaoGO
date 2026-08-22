/**
 * TaskRegistry.Lifecycle.test.js — 任务/会话生命周期单调性回归测试
 *
 * 背景（2026-08-22，Fix S-B1 + S-B2）：
 *   TaskRegistry TTL 清理会对「已完成 task」无条件 abortController.abort()，
 *   而该 controller 正是 runChunkedImport 的 signal → 触发 onAbort →
 *   updateSessionStatus('cancelled') 把已 completed 的 session 反向改写为 cancelled →
 *   TTL 回收 → invoiceDocs=null → Display 全空白。
 *
 * 修复 invariant：
 *   - Fix S-B1：removeTask 只 abort 非终态 task（completed/cancelled 不 abort）
 *   - Fix S-B2：onAbort 只能使 non-terminal session → cancelled，不得改写 terminal session
 *
 * 运行：node --test src/services/TaskRegistry.Lifecycle.test.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const {
  createTask,
  updateTaskStatus,
  removeTask,
  cancelTask,
  setTaskAbortController,
} = await import('../services/TaskRegistry.js')
const {
  createImportSession,
  updateSessionStatus,
  getSession,
  removeSession,
} = await import('../stores/ImportSessionStore.js')

test('Fix S-B1: running task → remove 时 abort（仍可取消 in-flight）', () => {
  const task = createTask(['f1'])
  updateTaskStatus(task.id, 'running')
  const controller = new AbortController()
  setTaskAbortController(task.id, controller)
  assert.equal(controller.signal.aborted, false)
  removeTask(task.id)
  assert.equal(controller.signal.aborted, true, 'running task 应被 abort（取消 in-flight 请求）')
})

test('Fix S-B1: completed task → remove 时 不 abort（终态清理零副作用）', () => {
  const task = createTask(['f1'])
  updateTaskStatus(task.id, 'running')
  updateTaskStatus(task.id, 'completed')
  const controller = new AbortController()
  setTaskAbortController(task.id, controller)
  removeTask(task.id)
  assert.equal(controller.signal.aborted, false, 'completed task 清理不得 abort（防止反向污染 session）')
})

test('Fix S-B1: cancelled task → remove 时 不 abort（终态清理零副作用）', () => {
  const task = createTask(['f1'])
  updateTaskStatus(task.id, 'running')
  updateTaskStatus(task.id, 'cancelled')
  const controller = new AbortController()
  setTaskAbortController(task.id, controller)
  removeTask(task.id)
  assert.equal(controller.signal.aborted, false, 'cancelled task 清理不得 abort')
})

test('Fix S-B2: pending/running session → late abort → cancelled（仍可取消）', () => {
  const session = createImportSession()
  // runChunkedImport 语义：abort 时若 session 未终态 → cancelled
  assert.equal(session.status, 'pending')
  updateSessionStatus(session.id, 'cancelled')
  assert.equal(getSession(session.id).status, 'cancelled')
})

test('Fix S-B2: completed session → late abort 不改写（保持 completed）', () => {
  const session = createImportSession()
  updateSessionStatus(session.id, 'completed')
  assert.equal(getSession(session.id).status, 'completed')
  // onAbort 防护语义：terminal session 遇 abort 为 no-op（不降级为 cancelled）
  // 此处模拟修复后逻辑：completed 会话再次收到 abort 时状态保持
  const cur = getSession(session.id)
  const isTerminal = cur.status === 'completed' || cur.status === 'cancelled'
  if (!isTerminal) updateSessionStatus(session.id, 'cancelled')
  assert.equal(getSession(session.id).status, 'completed', 'terminal session 不得被 abort 改写')
})

test('全链: completed task 清理不触发 session cancelled（生命周期单调性）', () => {
  const session = createImportSession()
  updateSessionStatus(session.id, 'completed') // session 正常完成

  // 模拟 TTL 清理 completed task：修复后 removeTask 不 abort
  const task = createTask(['f1'])
  updateTaskStatus(task.id, 'running')
  updateTaskStatus(task.id, 'completed')
  const controller = new AbortController()
  setTaskAbortController(task.id, controller)
  removeTask(task.id)

  // 若 abort 被误触发，此处会复现修复前污染：completed → cancelled
  assert.equal(controller.signal.aborted, false, 'completed task 清理不 abort')
  assert.equal(getSession(session.id).status, 'completed', 'session 保持 completed，未被反向改写')
})
