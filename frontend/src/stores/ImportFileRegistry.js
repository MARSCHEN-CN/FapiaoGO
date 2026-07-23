/**
 * ImportFileRegistry — 文件对象注册表（IS-1 / 合同 §9）
 *
 * 职责（严格限定）：
 *   维护 fileId → 浏览器 File 对象的映射，使 ImportSessionStore 只持有
 *   文件元数据（id/name/size/status/batchId/error），永不直接持有 File 对象。
 *
 * 为什么需要：
 *   合同 §9 规定 _ref 为 opaque file reference，Session 不知道底层是 bytes / path / s3 key。
 *   IS-2 把 _ref 从「浏览器 File」换成「server temp path」时，只需改本注册表，
 *   ImportSessionStore 编排逻辑不变（drop-in）。
 *
 * 不负责（避免污染边界）：
 *   ❌ 上传 / chunk / fetch
 *   ❌ OCR / ImportBatchClient / useFileOps
 *   本模块零业务依赖，仅做引用 retain/release 生命周期管理。
 *
 * @module stores/ImportFileRegistry
 */

/** @type {Map<string, File>} fileId → File */
const _registry = new Map()

/**
 * 保留文件对象引用。
 * @param {string} fileId
 * @param {File} file
 */
export function retain(fileId, file) {
  _registry.set(fileId, file)
}

/**
 * 获取文件对象引用。
 * @param {string} fileId
 * @returns {File|undefined}
 */
export function get(fileId) {
  return _registry.get(fileId)
}

/**
 * 释放单个文件对象引用。
 * @param {string} fileId
 */
export function release(fileId) {
  _registry.delete(fileId)
}

/**
 * 是否存在某文件引用。
 * @param {string} fileId
 * @returns {boolean}
 */
export function has(fileId) {
  return _registry.has(fileId)
}

/**
 * 释放全部引用（会话结束 / 清理时调用）。
 */
export function releaseAll() {
  _registry.clear()
}
