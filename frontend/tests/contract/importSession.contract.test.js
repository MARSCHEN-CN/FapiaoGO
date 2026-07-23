/**
 * IS-1 Commit 4-A — Import Session 契约回归测试（纯 contract tests）
 *
 * 目的：把已冻结的 Import Session 契约固化为可回归的护栏，防止未来有人：
 *   - 删除 session.childBatchIds（1:N batch 聚合 / cancel cascade / retry mapping）
 *   - 把 SessionFile 简化回 {fileId,status}（丢失 batchId / error 字段）
 *   - 让 ImportSession 偷偷持有 File bytes（破坏 §9 的 _ref opaque 边界）
 *   - 把 updateSessionStatus('cancelled') 做成级联回退（破坏 §7 的 cancel 语义）
 *
 * 运行：node --test tests/contract/
 *
 * 范围纪律（不碰）：
 *   ❌ useFileOps（React hook orchestration，留待 Commit 5 端到端）
 *   ❌ ImportBatchManager / ParseJobManager / OCR / ProcessPool / SSE 协议 / DB
 *
 * 依赖：仅纯 JS 模块（ImportSessionStore / ImportFileRegistry / ImportSession 模型），
 *       无 React / 浏览器全局 / 网络。可直接被 node --test 运行。
 *
 * @module tests/contract/importSession.contract
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  createImportSession,
  addFilesToSession,
  addChildBatch,
  getChildBatchIds,
  attachFilesToBatch,
  updateFileError,
  updateFileStatus,
  updateSessionStatus,
} from '../../src/stores/ImportSessionStore.js'
import {
  retain,
  get,
  has,
  release,
  releaseAll,
} from '../../src/stores/ImportFileRegistry.js'
import { createSession, createSessionFile } from '../../src/models/ImportSession.js'

// ── helpers ────────────────────────────────────────────

const mkFileInput = (key, name = 'invoice.pdf', format = 'pdf', size = 1024) => ({
  key,
  name,
  format,
  size,
})

// registry 是模块级单例，每个测试后清空，避免跨测试污染
afterEach(() => releaseAll())

// ════════════════════════════════════════════════════════
// 1. childBatchIds 聚合（合同 §2/§3）
// ════════════════════════════════════════════════════════

describe('childBatchIds aggregation (合同 §2/§3)', () => {
  it('createImportSession 初始化 childBatchIds 为数组', () => {
    const s = createImportSession()
    assert.ok(Array.isArray(s.childBatchIds), 'childBatchIds 必须存在且为数组')
    assert.deepEqual(s.childBatchIds, [])
  })

  it('addChildBatch 去重并保持插入顺序', () => {
    const s = createImportSession()
    addChildBatch(s.id, 'batch-A')
    addChildBatch(s.id, 'batch-A') // 重复应被忽略
    addChildBatch(s.id, 'batch-B')
    assert.deepEqual(getChildBatchIds(s.id), ['batch-A', 'batch-B'])
  })

  it('getChildBatchIds 返回副本（外部突变不影响 store）', () => {
    const s = createImportSession()
    addChildBatch(s.id, 'batch-A')
    const copy = getChildBatchIds(s.id)
    copy.push('batch-rogue')
    assert.deepEqual(
      getChildBatchIds(s.id),
      ['batch-A'],
      'store 内部的 childBatchIds 不应被外部副本污染',
    )
  })
})

// ════════════════════════════════════════════════════════
// 2. file-level mapping（合同 §6：{fileId,status,batchId,error}）
// ════════════════════════════════════════════════════════

describe('file-level mapping (合同 §6)', () => {
  it('SessionFile 必须携带 batchId / error 字段（防止被简化回 {fileId,status}）', () => {
    const f = createSessionFile(mkFileInput('f1'))
    assert.ok('batchId' in f && 'error' in f, 'SessionFile 必须保留 batchId 与 error')
    assert.equal(f.batchId, null)
    assert.equal(f.error, null)
    assert.equal(f.status, 'uploading')
  })

  it('生命周期 created→uploading→submitted(batchId)→failed(error) 不丢 batchId', () => {
    const s = createImportSession()
    addFilesToSession(s.id, [mkFileInput('f1')])
    const file = s.files[0]
    assert.equal(file.status, 'uploading')

    attachFilesToBatch(s.id, ['f1'], 'batch-B1')
    assert.equal(file.batchId, 'batch-B1')
    assert.equal(file.status, 'uploading')

    updateFileError(s.id, 'f1', 'parse failed: malformed PDF')
    assert.equal(file.status, 'error')
    assert.equal(file.error, 'parse failed: malformed PDF')
    assert.equal(file.batchId, 'batch-B1', '失败回填后 batchId 不得丢失')
  })

  it('updateFileError 对失败计数幂等（不重复累加）', () => {
    const s = createImportSession()
    addFilesToSession(s.id, [mkFileInput('f1')])
    updateFileError(s.id, 'f1', 'err-1')
    assert.equal(s.progress.failed, 1)
    updateFileError(s.id, 'f1', 'err-2')
    assert.equal(s.progress.failed, 1, 'failed 计数不可因重复调用而翻倍')
    assert.equal(s.files[0].error, 'err-2', 'error 文案应更新为最新值')
  })
})

// ════════════════════════════════════════════════════════
// 3. ImportFileRegistry（合同 §9：_ref opaque + Store 不持有 File）
// ════════════════════════════════════════════════════════

describe('ImportFileRegistry (合同 §9)', () => {
  it('retain → get → has → release → undefined 生命周期', () => {
    const fakeFile = { name: 'invoice.pdf' }
    retain('x1', fakeFile)
    assert.equal(get('x1'), fakeFile)
    assert.equal(has('x1'), true)
    release('x1')
    assert.equal(get('x1'), undefined)
    assert.equal(has('x1'), false)
  })

  it('releaseAll 清空全部引用', () => {
    retain('a', { name: 'a' })
    retain('b', { name: 'b' })
    releaseAll()
    assert.equal(get('a'), undefined)
    assert.equal(get('b'), undefined)
  })

  it('Store 永不直接持有 File 对象（session file 仅为元数据）', () => {
    const fakeFile = { name: 'invoice.pdf', __isFileRef: true }
    retain('f1', fakeFile)
    const s = createImportSession()
    addFilesToSession(s.id, [mkFileInput('f1')])
    const file = s.files[0]
    // 关键边界：被 retain 的 File 引用不得泄漏进 session file 条目
    assert.ok(!('__isFileRef' in file), 'session file 不得内嵌 File 引用')
    assert.ok(
      !['file', 'blob', 'bytes'].some((k) => k in file),
      'session file 不得携带 file/blob/bytes 字段',
    )
  })
})

// ════════════════════════════════════════════════════════
// 4. Session cancel 契约（合同 §7）
// ════════════════════════════════════════════════════════

describe('session cancel contract (合同 §7)', () => {
  it('updateSessionStatus(cancelled) 保留 childBatchIds 且不回退文件状态', () => {
    const s = createImportSession()
    addFilesToSession(s.id, [mkFileInput('f1'), mkFileInput('f2')])
    const [f1, f2] = s.files
    updateFileStatus(s.id, 'f1', { status: 'parsed' }) // 已完成
    // f2 保持 'uploading'（运行中）

    attachFilesToBatch(s.id, ['f1', 'f2'], 'batch-B1')
    addChildBatch(s.id, 'batch-B1')

    updateSessionStatus(s.id, 'cancelled')

    assert.equal(s.status, 'cancelled')
    assert.deepEqual(getChildBatchIds(s.id), ['batch-B1'], 'childBatchIds 必须保留')
    assert.equal(f1.status, 'parsed', '已完成的文件不得被回退')
    assert.equal(f2.status, 'uploading', '运行中的文件不得被强制回退')
    assert.equal(f1.batchId, 'batch-B1', 'batch 绑定必须保留')
  })
})
