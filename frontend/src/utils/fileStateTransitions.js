// 状态迁移与解析 payload 合并的解耦层（Import Pipeline Contract v1.2）
//
// 设计动机：
//   解析结果（invoiceDate / amount / OCR fields 等）是权威业务数据，
//   它**不应**因为状态机中间态竞争而被丢弃。
//
//   缓存命中场景下，parseWorker 的 `queueUpdate(key,'parsing')` 与
//   `queueUpdate(key,'parsed',payload)` 在 flush 前先后入队，pendingUpdatesRef
//   后写覆盖，pending 直接变成 {newStatus:'parsed', extra:payload}，中间态
//   'parsing' 没机会 flush。等 flush 时文件还停在 'ready'，而旧逻辑
//   `ready->parsed` 不在 VALID_TRANSITION['ready'] 白名单里 → 整条 extra 被丢弃
//   → 列表「未知日期」、导出 Excel「无数据」、但详情页因走了另一 store 仍显示全部。
//
//   正确语义：payload 是权威终态数据，**永远合并**；仅当状态迁移合法时才更新
//   status，非法则保留旧 status 并告警，绝不连累 payload。

export const VALID_TRANSITION = {
  uploading: ['splitting', 'ready', 'parsing'],
  splitting: ['ready', 'error'],
  ready: ['parsing', 'error'],
  parsing: ['parsed', 'error'],
  parsed: [],
  error: ['parsing'],
}

// 状态迁移是否合法（仅正向白名单，阻止回退）
export function canTransition(from, to) {
  const allowed = VALID_TRANSITION[from]
  return !allowed || allowed.includes(to)
}

// 合并单次文件状态更新。
// @param {object} file   当前文件对象（含 status）
// @param {{newStatus:string, extra:object}} update
//        extra 为解析结果 payload（不应含 status 字段）
// @returns {object} 新文件对象：payload 始终合并；status 仅在迁移合法时更新
export function applyFileUpdate(file, update) {
  if (!file || !update) return file
  const { newStatus, extra } = update
  const transitionOk = canTransition(file.status, newStatus)
  if (!transitionOk) {
    // 解析数据丢失比状态机不一致更危险：保留旧 status，但 payload 必须落地。
    console.warn(
      `[fileState] status transition rejected: ${file.status} -> ${newStatus} ` +
      `for ${file.key || file.name || '<unknown>'}; payload still merged`
    )
  }
  return {
    ...file,
    ...(transitionOk ? { status: newStatus } : {}),
    ...extra,
  }
}
