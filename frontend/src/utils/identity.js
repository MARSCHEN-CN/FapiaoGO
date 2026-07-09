/**
 * 文件身份字段处理
 *
 * 合并 buildFileObj() 产出到列表项时，身份字段必须由「占位项」决定，
 * 不能被新对象的身份字段覆盖——否则后续 parse 更新会因找不到 key 而
 * 静默丢失（见导入 Pipeline 重构的 Blocker 2）。
 *
 * 此模块零依赖，可独立被 Node 单元测试导入（不触发 import.meta / 浏览器全局）。
 */

// 身份字段集合。若将来身份字段增多（id / uuid / internalId），只改这里一处即可。
export const IDENTITY_FIELDS = ['key']

/**
 * 剥离文件对象的身份字段，返回仅含业务字段的副本（不修改入参）。
 * @param {object|null|undefined} fileObj
 * @returns {object|null|undefined}
 */
export function stripIdentity(fileObj) {
  if (!fileObj) return fileObj
  const rest = { ...fileObj }
  for (const f of IDENTITY_FIELDS) delete rest[f]
  return rest
}
