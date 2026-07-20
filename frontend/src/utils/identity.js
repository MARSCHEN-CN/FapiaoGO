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

// ============================================================================
// Document Identity Contract v1.1 — Identity Resolver
// ----------------------------------------------------------------------------
// 以下为 Stage 4.1.2 新增的「身份出口」(见 docs/architecture/identity-contract-v1.md)。
//
// 纪律（Stage 4.1.2）：
//  - 纯函数：零 I/O、零哈希计算。哈希权属 backend registry._make_doc_id，
//    frontend 只透传 docId / contentHash。
//  - 不改任何消费者。消费者迁移在 4.1.3（注入）/ 4.1.4（DocumentState）进行。
//  - 与上方 stripIdentity（Import Scale 字段剥离）互不相关，各自独立。
// ============================================================================

/**
 * @typedef {Object} DocumentIdentity
 * @property {string} uiKey         UI 生命周期身份（React key / FileList 行 / selection）
 * @property {string} docId         文档永久身份（sha256(bytes)[:24]，backend 生成并透传）
 * @property {string} sourceHash    内容来源身份（sha256(bytes) 全 64 字符；缺省为 ''，不伪造）
 * @property {string} [pageId]      页面实例身份（docId:pN）；单页文档无此字段
 */

/**
 * 将原始文件对象规范化为标准 DocumentIdentity。
 * 纯函数——不修改入参、不执行 I/O。
 *
 * @param {Object} fileObj
 * @param {string} [fileObj.key]          UI key（name+timestamp+uuid）
 * @param {string} [fileObj.docId]        backend 文档 id
 * @param {string} [fileObj.id]           备选文档 id 字段
 * @param {string} [fileObj.contentHash]  后端返回的完整 64 字符内容哈希
 * @param {string} [fileObj.sourceHash]   已解析的 sourceHash（优先）
 * @param {number} [fileObj.pageNum]      页码（1-based）；>1 隐含 pageId
 * @param {string} [fileObj.pageId]       显式 pageId（优先于推导）
 * @returns {DocumentIdentity|null}
 */
export function resolveIdentity(fileObj) {
  if (!fileObj || typeof fileObj !== 'object') return null

  const uiKey = fileObj.key ?? fileObj.uiKey ?? ''
  const docId = fileObj.docId ?? fileObj.id ?? ''
  const sourceHash = fileObj.sourceHash ?? fileObj.contentHash ?? ''
  const pageId = resolvePageId(docId, fileObj.pageNum, fileObj.pageId)

  return { uiKey, docId, sourceHash, pageId }
}

/**
 * 由文档 id + 页码推导页面实例 id。
 * 单页文档（pageNum 缺省或等于 1）不携带 pageId。
 *
 * @param {string} docId
 * @param {number} [pageNum]
 * @param {string} [explicitPageId]
 * @returns {string|undefined}
 */
export function resolvePageId(docId, pageNum, explicitPageId) {
  if (explicitPageId) return explicitPageId
  if (!docId) return undefined
  if (pageNum == null || pageNum <= 1) return undefined
  return `${docId}:p${pageNum}`
}
