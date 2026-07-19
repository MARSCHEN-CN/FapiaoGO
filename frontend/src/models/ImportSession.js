/**
 * ImportSession — 导入会话数据模型
 *
 * 职责：
 *   定义一次导入流程（从拖入到解析完成）的完整状态。
 *   作为所有导入相关状态的根对象。
 *
 * 当前状态：契约冻结阶段。
 *   已定义但不迁移任何现有状态。
 *   后续 Phase 2-4-2 引入 Store，Phase 2-4-3 接入 useFileOps。
 *
 * 关系：
 *   - 一个 ImportSession 对应一次用户操作（拖入/打开）
 *   - 每个文件对应一个 Task，每个 Task 可能产生一个 ParseResult
 *   - Session 生命周期 = 从用户操作到所有文件解析完成
 *
 * 与 V16 关系：
 *   相当于 Import 侧的 DocumentState。
 *
 * @module models/ImportSession
 */

/**
 * @typedef {'pending'|'processing'|'completed'|'cancelled'} SessionStatus
 */

/**
 * @typedef {Object} SessionFile
 * @property {string} id - 文件标识
 * @property {string} key - React key
 * @property {string} name - 文件名
 * @property {string|null} path - 文件路径
 * @property {string} format - 文件格式
 * @property {'uploading'|'splitting'|'ready'|'parsing'|'parsed'|'error'} status - 当前状态
 */

/**
 * @typedef {Object} SessionProgress
 * @property {number} total - 总文件数
 * @property {number} completed - 已完成数
 * @property {number} failed - 失败数
 */

/**
 * @typedef {Object} SessionTask
 * @property {string} id - 任务标识
 * @property {string} fileId - 关联文件
 * @property {'queued'|'running'|'done'|'failed'} status - 任务状态
 */

/**
 * @typedef {Object} ImportSessionData
 * @property {string} id - 会话标识
 * @property {SessionStatus} status - 会话状态
 * @property {SessionFile[]} files - 文件列表
 * @property {SessionTask[]} tasks - 任务列表
 * @property {Array} results - 解析结果列表
 * @property {SessionProgress} progress - 进度遥测
 * @property {number} createdAt - 创建时间
 */

let sessionIdCounter = 0

/**
 * 生成唯一会话 ID。
 * @returns {string}
 */
function generateSessionId() {
  sessionIdCounter++
  return `session-${Date.now()}-${sessionIdCounter}`
}

/**
 * 创建新的导入会话。
 *
 * @param {SessionFile[]} [files] - 初始文件列表
 * @returns {ImportSessionData}
 */
export function createSession(files = []) {
  return {
    id: generateSessionId(),
    status: 'pending',
    files,
    tasks: [],
    results: [],
    progress: {
      total: files.length,
      completed: 0,
      failed: 0,
    },
    createdAt: Date.now(),
  }
}

/**
 * 创建一个会话文件条目。
 * @param {Object} input - 文件输入
 * @param {string} input.key - React key
 * @param {string} input.name - 文件名
 * @param {string|null} [input.path] - 文件路径
 * @param {string} input.format - 文件格式
 * @returns {SessionFile}
 */
export function createSessionFile(input) {
  return {
    id: input.key,
    key: input.key,
    name: input.name,
    path: input.path || null,
    format: input.format,
    status: 'uploading',
  }
}
