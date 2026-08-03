/**
 * read-file IPC 返回 → Uint8Array 纯适配（A2-G1-CANVAS-1）
 *
 * 真实契约（electron/ipc-file-ops.js:85-105 实读）：主进程返回 { success, data: Buffer }。
 * structured clone 到渲染进程后 data 可能是三种形态之一（全覆盖，不赌某一种）：
 *   A. Uint8Array（TypedArray 直通）          → 直接用
 *   B. ArrayBuffer                           → new Uint8Array(value)
 *   C. { type:'Buffer', data:[...] }（Node Buffer 序列化）→ Uint8Array.from(value.data)
 *
 * 生产 usePrint.js:186 用 data.arrayBuffer()——仅 A/B 成立；本适配不复制该假设。
 * 纯函数，node 可直接测试（见 gateFramework.test.mjs）。
 */
export function normalizeReadFileData(fileData) {
  const value = fileData?.data ?? fileData

  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value?.type === 'Buffer' && Array.isArray(value.data)) {
    return Uint8Array.from(value.data)
  }

  throw new Error(`unsupported read-file payload: ${value?.constructor?.name || typeof value}`)
}
