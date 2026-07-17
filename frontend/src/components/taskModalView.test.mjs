// Phase 4.4 前端状态机契约测试（无框架，node --test 直接跑）。
//
// 锁死：后端 ExportTask 状态 → TaskProgressModal 展示 的映射「无状态丢失」。
// 对应 4 个 E2E 场景：正常完成 / Service 异常 / 用户取消 / 非法 taskId(404→failed)。
//
// 运行：node --test frontend/src/components/taskModalView.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveTaskModalView } from './taskModalView.mjs'

// ── Case 1：正常完成 pending → running → completed ──
test('completed → 结果视图 + 可关闭 + 成功图标', () => {
  const v = deriveTaskModalView('completed', [])
  assert.equal(v.isRunning, false)
  assert.equal(v.isFinished, true)
  assert.equal(v.resultIcon, 'success')
  // isFinished=true → 弹窗渲染「关闭」键（onClose）
})

// ── Case 2：Service 异常 → failed ──
test('failed(无 per-file errors) → 结果视图 + 可关闭 + 错误图标（不误显成功）', () => {
  const v = deriveTaskModalView('failed', [])
  assert.equal(v.isRunning, false)
  assert.equal(v.isFinished, true)        // 关键：failed 必须可关闭
  assert.equal(v.resultIcon, 'error')     // 关键：不能误显 success 对勾
})

test('failed(带 per-file errors) → 错误图标', () => {
  const v = deriveTaskModalView('failed', [{ file: 'a.pdf', error: 'boom' }])
  assert.equal(v.resultIcon, 'error')
  assert.equal(v.hasErrors, true)
})

// ── Case 3：用户取消 → cancelled ──
test('cancelled → 结果视图 + 可关闭 + cancelled 图标', () => {
  const v = deriveTaskModalView('cancelled', [])
  assert.equal(v.isRunning, false)
  assert.equal(v.isFinished, true)
  assert.equal(v.resultIcon, 'cancelled')
})

// ── Case 4：非法 taskId → GET 404 → EventSource.onerror → status=failed ──
test('404/连接中断 → failed → 终态可关闭（不无限重连、不卡 running）', () => {
  const v = deriveTaskModalView('failed', [{ file: '', error: 'SSE 连接中断' }])
  assert.equal(v.isRunning, false)
  assert.equal(v.isFinished, true)
  assert.equal(v.resultIcon, 'error')
})

// ── 瞬态保护：starting / pending / running 必须显示进度环，不闪成功 ──
test('瞬态 starting/pending/running/未设 → 进度环视图', () => {
  for (const s of ['starting', 'pending', 'running', undefined]) {
    const v = deriveTaskModalView(s)
    assert.equal(v.isRunning, true, `status=${s} 应显示进度环`)
    assert.equal(v.isFinished, false)
    assert.notEqual(v.resultIcon, 'success', `status=${s} 不得误显成功`)
  }
})
