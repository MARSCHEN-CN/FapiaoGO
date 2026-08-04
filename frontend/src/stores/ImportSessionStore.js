/**
 * ImportSessionStore — 导入会话运行时存储
 *
 * 职责：
 *   管理 ImportSession 实例的创建、查询、更新。
 *   作为一次导入任务的唯一状态根。
 *
 * 非 React store：
 *   不使用 useState / useReducer / 任何 React API。
 *   纯模块级 Map + 导出方法。
 *
 * 调用方 (useFileOps) 负责：
 *   - 创建 session
 *   - 将用户操作转化为 store 方法调用
 *   - 将 store 数据同步到 React state（通过 BatchUIUpdater）
 *
 * 与 TaskScheduler 的关系：
 *   Store 属于业务状态层（what），
 *   Scheduler 属于执行层（how）。
 *   Scheduler 不直接读写 Store。
 *
 * @module stores/ImportSessionStore
 */

import { createSession, createSessionFile } from '../models/ImportSession.js'

// ── 会话存储 ────────────────────────────────────────────

/** @type {Map<string, import('../models/ImportSession').ImportSessionData>} */
const sessions = new Map()

/** 最近活跃的 sessionId（供 FileContext 等 React 组件通过订阅获取） */
let activeSessionId = null

/** 文档版本计数器：每次 addDocument 递增，供 useSyncExternalStore 检测文档变更 */
let documentVersion = 0

export function getDocumentVersion() { return documentVersion }

// ── 订阅者（用于 React 同步） ───────────────────────────

/** @type {Set<(sessionId: string) => void>} */
const subscribers = new Set()

// ── 批量通知（B-1，镜像 DocumentStore silent + flushDocumentNotifications）──
/** 待 flush 的会话通知目标：silent addDocument 累积，flushSessionNotifications 一次性清空 */
const pendingNotifySessionIds = new Set()

// ── Session 自动回收（P6-C，与 TaskRegistry TTL 同模式）──
// 会话到达终态后延迟移除，期间仍可被 UI 查询（最近历史），
// 避免长会话下 sessions Map 单调增长。owner = 本 store 自身。
const SESSION_TTL_MS = 60000
const cleanupTimers = new Map()

function scheduleSessionCleanup(id) {
  clearSessionCleanupTimer(id)
  const t = setTimeout(() => {
    cleanupTimers.delete(id)
    removeSession(id)
  }, SESSION_TTL_MS)
  cleanupTimers.set(id, t)
}

function clearSessionCleanupTimer(id) {
  const t = cleanupTimers.get(id)
  if (t) {
    clearTimeout(t)
    cleanupTimers.delete(id)
  }
}

/**
 * 订阅会话变化。
 * @param {(sessionId: string) => void} fn - 回调函数
 * @returns {() => void} 取消订阅函数
 */
export function subscribe(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/**
 * 通知所有订阅者。
 * @param {string} sessionId
 */
function notify(sessionId) {
  for (const fn of subscribers) {
    try { fn(sessionId) } catch (_) { /* ignore subscriber errors */ }
  }
}

/**
 * 批量刷新 ImportSessionStore 通知（B-1）。
 * 配合 addDocument({ silent: true }) 使用：hydration 等大批量路径在循环内静默添加文档，
 * 循环结束后调用本函数一次性 notify，避免 N 文档 N 次通知。
 * 仅当该 session 存在待发通知时才 notify（幂等，无 pending 时为 no-op）。
 * @param {string} targetSessionId
 */
export function flushSessionNotifications(targetSessionId) {
  if (!targetSessionId) return
  if (pendingNotifySessionIds.delete(targetSessionId)) {
    notify(targetSessionId)
  }
}

// ── 会话管理 ────────────────────────────────────────────

/**
 * 创建新会话。
 * @param {Array} [files] - 初始文件列表
 * @returns {import('../models/ImportSession').ImportSessionData}
 */
export function createImportSession(files = []) {
  const session = createSession(files)
  sessions.set(session.id, session)
  activeSessionId = session.id
  notify(session.id)
  return session
}

/**
 * 获取当前活跃会话的 ID。
 * @returns {string|null}
 */
export function getActiveSessionId() {
  return activeSessionId
}

/**
 * 清除当前活跃会话指针。
 * 使下一次导入创建新 session，而非复用旧 session 的残留状态（documents/files/progress）。
 * 旧 session 保留在 Map 中由 TTL 定时器自然回收（60s），不影响 UI。
 *
 * 与 removeSession 的区别：
 *   - removeSession 从 Map 中硬删除，通知 UI（适用于主动清理已完成会话）。
 *   - clearActiveSession 仅解除指针，不触发通知、不影响旧 session 的 result/error 可查询性。
 */
export function clearActiveSession() {
  activeSessionId = null
}

/**
 * 重新激活已终态的会话（复用前清除清理定时器 + 重置状态）。
 *
 * 场景：上次导入 completed 后 60 秒内用户再次导入，
 * processFilesForAddition 复用活跃 session。若不调用此函数，
 * scheduleSessionCleanup 设置的 60s 定时器会在新导入进行中触发
 * removeSession，导致 session 被删除、所有后续 store 操作变为 no-op。
 *
 * @param {string} id - 会话 ID
 */
export function reactivateSession(id) {
  clearSessionCleanupTimer(id)
  const session = sessions.get(id)
  if (session && (session.status === 'completed' || session.status === 'cancelled' || session.status === 'failed')) {
    session.status = 'running'
  }
}

/**
 * 获取会话。
 * @param {string} id
 * @returns {import('../models/ImportSession').ImportSessionData|undefined}
 */
export function getSession(id) {
  return sessions.get(id)
}

/**
 * 删除会话。
 *
 * 修复：无论 activeSessionId 是否匹配，只要被删除的 session 是当前活跃会话
 *       或 activeSessionId 指向了不存在的会话，都必须清理指针。
 *       防止 FileContext 引用已删除的 session 导致文档分组丢失。
 *
 * @param {string} id
 */
export function removeSession(id) {
  clearSessionCleanupTimer(id)
  sessions.delete(id)
  // 必须清理 activeSessionId 指针：
  // 1) 如果当前活跃会话就是被删除的会话 → 清理
  // 2) 如果 activeSessionId 指向了不存在的会话（悬空指针） → 清理
  if (activeSessionId === id || (activeSessionId && !sessions.has(activeSessionId))) {
    activeSessionId = null
  }
  notify(id)
}

// ── 文件管理 ────────────────────────────────────────────

/**
 * 向会话添加文件。
 * @param {string} sessionId
 * @param {Array} fileInputs - 文件输入数组
 */
export function addFilesToSession(sessionId, fileInputs) {
  const session = sessions.get(sessionId)
  if (!session) return

  const existingKeys = new Set(session.files.map(f => f.key))
  const newFiles = fileInputs
    .filter(f => !existingKeys.has(f.key || f.name))
    .map(f => createSessionFile(f))

  session.files.push(...newFiles)
  session.progress.total = session.files.length
  notify(sessionId)
}

/**
 * 从会话中移除文件（与 addFilesToSession 对称）。
 *
 * Import Admission Gate (IS-4.2.1) 的 existingPaths 由 session.files 派生，
 * 因此删除文件时必须同步从 session.files 移除，否则 gate 会变成「永久黑名单」：
 * 用户已在 UI 删除该文件、重新导入却被拦截 —— 破坏生命周期隔离（O）。
 *
 * @param {string} sessionId
 * @param {Array<string>} fileKeys - 要移除的文件 key 列表
 */
export function removeFilesFromSession(sessionId, fileKeys) {
  const session = sessions.get(sessionId)
  if (!session || !fileKeys || fileKeys.length === 0) return
  const removeSet = new Set(fileKeys)
  const before = session.files.length
  session.files = session.files.filter((f) => !removeSet.has(f.key))
  session.progress.total = session.files.length
  if (session.files.length !== before) {
    console.log(`[IMPORT_ADMISSION] session files pruned: removed=${before - session.files.length}, remaining=${session.files.length}`)
    notify(sessionId)
  }
}

/**
 * 更新会话中某个文件的状态。
 * @param {string} sessionId
 * @param {string} fileKey
 * @param {Partial<import('../models/ImportSession').SessionFile>} updates
 */
export function updateFileStatus(sessionId, fileKey, updates) {
  const session = sessions.get(sessionId)
  if (!session) return

  const file = session.files.find(f => f.key === fileKey)
  if (!file) return

  Object.assign(file, updates)
  notify(sessionId)
}

/**
 * 文档实例去重键（IS-4.2 Step 4.2）。
 *
 * 规则：instanceId || id || docId。
 *   - instanceId：文档实例身份。同内容 A/B（同 docId）实例身份不同 → 各自保留，
 *     不再被误判为重复而丢弃。
 *   - id || docId：无 instanceId 的旧数据回退口径，与 addDocument 旧去重基准
 *     （`d.id || d.docId`）完全一致，行为不变。
 *
 * 注意：与 DocumentStore.resolveDocumentIdentity（instanceId || docId || id）回退顺序
 * 不同——本 store 的历史口径是 id 优先于 docId，此处沿用，避免引入回归。
 *
 * @param {Object|null|undefined} doc
 * @returns {string|null} 去重键，无法解析时返回 null
 */
export function resolveDocumentInstanceKey(doc) {
  if (!doc) return null
  return doc.instanceId || doc.id || doc.docId || null
}

/**
 * 向会话中添加一个 InvoiceDocument（双写模式，E-1）。
 * 通过实例身份去重（IS-4.2 Step 4.2）：去重键 = instanceId || id || docId。
 * 同 instanceId 的文档不会被重复添加；同内容 A/B（不同 instanceId）各自保留。
 *
 * 批处理（B-1）：options.silent=true 时注册后不立即 notify，由调用方在循环结束后
 * 调用 flushSessionNotifications(sessionId) 统一通知，避免 N 文档 N 次通知（hydration 大批量路径）。
 * 非 silent 时行为与原一致：每次 addDocument 都 notify（含去重跳过，无害 no-op 重渲染），
 * 以保持单文档 add 的既有语义（Case 1）。
 *
 * @param {string} sessionId
 * @param {Object} doc - InvoiceDocument（来自 DocumentStore）
 * @param {{silent?: boolean}} [options] - silent=true 时注册后不立即 notify（批处理统一 flush）
 */
export function addDocument(sessionId, doc, options = {}) {
  const session = sessions.get(sessionId)
  if (!session) return
  // IS-4.2 Step 4.2：去重键 = instanceId || id || docId（无 instanceId 回退 id||docId，行为不变）
  const instanceKey = resolveDocumentInstanceKey(doc)
  if (!instanceKey) return
  session.documents = session.documents || []
  const existingIdx = session.documents.findIndex(d => resolveDocumentInstanceKey(d) === instanceKey)
  const isNew = existingIdx === -1
  if (isNew) {
    session.documents.push(doc)
  } else {
    // 更新已存在的文档：assembly 阶段可能更新页数/内容，
    // 必须替换旧版本，否则 invoiceDocumentsToRows 读到过时数据（单页 vs 多页）
    session.documents[existingIdx] = doc
  }
  documentVersion++  // 即使 silent 也递增：flush 时 useSyncExternalStore 快照依赖此版本号
  if (options.silent) {
    // 批处理模式：仅累积待通知，循环结束后由 flushSessionNotifications 统一通知
    if (isNew) pendingNotifySessionIds.add(sessionId)
  } else {
    // 原行为：每次 addDocument 都 notify（含去重跳过）
    notify(sessionId)
  }
}

/**
 * 替换会话中某个文件的占位项（多页 PDF 拆分后）。
 * @param {string} sessionId
 * @param {string} fileKey - 被替换的占位 key
 * @param {Array} newItems - 替换项
 */
export function replaceFileItems(sessionId, fileKey, newItems) {
  const session = sessions.get(sessionId)
  if (!session) return

  const idx = session.files.findIndex(f => f.key === fileKey)
  if (idx === -1) return

  session.files.splice(idx, 1, ...newItems.map(i => createSessionFile(i)))
  session.progress.total = session.files.length
  notify(sessionId)
}

// ── 批次聚合（合同 §2/§3：session 1:N batch） ──────────────

/**
 * 记录一个子批次 ID 到会话。
 * 用于多批进度聚合、cancel cascade、retry mapping。
 * @param {string} sessionId
 * @param {string} batchId
 */
export function addChildBatch(sessionId, batchId) {
  const session = sessions.get(sessionId)
  if (!session) return
  if (!session.childBatchIds.includes(batchId)) {
    session.childBatchIds.push(batchId)
  }
  notify(sessionId)
}

/**
 * 获取会话的子批次 ID 列表副本。
 * @param {string} sessionId
 * @returns {string[]}
 */
export function getChildBatchIds(sessionId) {
  const session = sessions.get(sessionId)
  return session ? [...session.childBatchIds] : []
}

/**
 * 将一批文件绑定到某个子批次（chunk 提交后调用）。
 * @param {string} sessionId
 * @param {string[]} fileIds - 文件标识（= file.key / file.id）
 * @param {string} batchId
 */
export function attachFilesToBatch(sessionId, fileIds, batchId) {
  const session = sessions.get(sessionId)
  if (!session) return
  // 构建 key→file 索引，避免 O(n×m) 线性查找
  const fileIndex = new Map()
  for (const f of session.files) {
    if (f.key) fileIndex.set(f.key, f)
    if (f.id && f.id !== f.key) fileIndex.set(f.id, f)
  }
  for (const fid of fileIds) {
    const file = fileIndex.get(fid)
    if (file) file.batchId = batchId
  }
  notify(sessionId)
}

/**
 * 回填文件级失败信息（合同 §6 file-level mapping）。
 * 仅首次置为 error 时累加失败计数，避免重复调用重复计数。
 * @param {string} sessionId
 * @param {string} fileId
 * @param {string|null} error
 */
export function updateFileError(sessionId, fileId, error) {
  const session = sessions.get(sessionId)
  if (!session) return
  const file = session.files.find(f => f.key === fileId || f.id === fileId)
  if (!file) return
  file.error = error
  if (file.status !== 'error') {
    file.status = 'error'
    session.progress.failed = (session.progress.failed || 0) + 1
  }
  notify(sessionId)
}

// ── 任务管理 ────────────────────────────────────────────

/**
 * 添加任务到会话。
 * @param {string} sessionId
 * @param {import('../models/ImportSession').SessionTask} task
 */
export function addTask(sessionId, task) {
  const session = sessions.get(sessionId)
  if (!session) return
  session.tasks.push(task)
  notify(sessionId)
}

/**
 * 更新任务状态。
 * @param {string} sessionId
 * @param {string} taskId
 * @param {string} status
 */
export function updateTaskStatus(sessionId, taskId, status) {
  const session = sessions.get(sessionId)
  if (!session) return
  const task = session.tasks.find(t => t.id === taskId)
  if (!task) return
  task.status = status
  notify(sessionId)
}

// ── 进度管理 ────────────────────────────────────────────

/**
 * 更新会话进度。
 * @param {string} sessionId
 * @param {Partial<import('../models/ImportSession').SessionProgress>} delta
 */
export function updateProgress(sessionId, delta) {
  const session = sessions.get(sessionId)
  if (!session) return
  if (delta.completed != null) session.progress.completed = delta.completed
  if (delta.failed != null) session.progress.failed = delta.failed
  if (delta.total != null) session.progress.total = delta.total
  notify(sessionId)
}

/**
 * 更新会话状态。
 * @param {string} sessionId
 * @param {import('../models/ImportSession').SessionStatus} status
 */
export function updateSessionStatus(sessionId, status) {
  const session = sessions.get(sessionId)
  if (!session) return
  session.status = status
  notify(sessionId)
  // 终态自动回收（P6-C）：completed/cancelled 后延迟移除，保留最近历史供 UI 查询
  if (status === 'completed' || status === 'cancelled') {
    scheduleSessionCleanup(sessionId)
  }
}

// ── 结果管理 ────────────────────────────────────────────

/**
 * 添加解析结果到会话。
 * @param {string} sessionId
 * @param {Object} result
 */
export function addResult(sessionId, result) {
  const session = sessions.get(sessionId)
  if (!session) return
  session.results.push(result)
  notify(sessionId)
}
