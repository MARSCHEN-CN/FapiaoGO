/**
 * FileResolver v1 — 统一文件读取入口
 *
 * 职责：
 *   将 FileInput（可能只有 path）解析为可用的 File 对象。
 *   Worker 通过此接口读取文件，不直接访问 IPC / Electron API。
 *
 * 优先级：
 *   1. input.file 已存在 → 直接返回（browser drag、已加载的文件）
 *   2. input.path 存在  → 通过 ipc.read-file 读取
 *   3. 其他              → 返回 null
 *
 * 输入：
 *   {
 *     name: string,
 *     path?: string,
 *     file?: File | null,
 *     printPath?: string
 *   }
 *
 * 输出：
 *   Promise<File | null>
 *
 * 这是 Import State Model v2 (docs/architecture/import-state-model-v2.md)
 * 定义的 FileResolver 实现。Phase 1a Commit 1a-1: 仅新增模块，不迁移调用点。
 *
 * @module services/FileResolver
 */

import { getExtension, getMimeType } from '../utils'

/**
 * @typedef {Object} FileInput
 * @property {string} name - 文件名
 * @property {string} [path] - 文件路径
 * @property {File|null} [file] - 浏览器 File 对象
 * @property {string} [printPath] - 打印/预览专用路径（优先级高于 path）
 */

/**
 * IPC 读取接口（由调用方注入，避免模块直接依赖 Electron）
 * @typedef {Object} IPCRenderer
 * @property {(channel: string, ...args: any[]) => Promise<any>} invoke
 */

/**
 * 解析文件输入为可用的 File 对象。
 *
 * @param {FileInput} input - 文件输入
 * @param {IPCRenderer} [ipc] - Electron IPC 渲染器（可选，无 IPC 时仅返回已存在的 file）
 * @returns {Promise<File|null>} 解析后的 File 对象，失败或无法解析时返回 null
 */
export async function resolveFile(input, ipc) {
  // 1. 已有 File 对象 → 直接返回（browser drag、已缓存）
  //    注意：不使用 instanceof File（Electron 跨 realm 时可能失效），
  //    改检测 arrayBuffer 方法判断是否为 Blob/File
  if (input.file && typeof input.file.arrayBuffer === 'function') {
    return input.file
  }

  // 2. 有路径 → 通过 IPC 读取
  const filePath = input.printPath || input.path
  if (filePath && ipc) {
    try {
      const result = await ipc.invoke('read-file', filePath)
      if (result && result.success && result.data) {
        console.log('[DIAG] FileResolver IPC read-file success:', input.name, 'size:', result.data.length)
        const ext = getExtension(input.name)
        const mimeType = getMimeType(ext)
        const blob = new Blob([new Uint8Array(result.data)], { type: mimeType })
        return new File([blob], input.name, { type: mimeType })
      }
    } catch (err) {
      console.error('[FileResolver] IPC read-file failed:', input.name, filePath, err)
    }
  }

  // 3. 无法解析
  return null
}
