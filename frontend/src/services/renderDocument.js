/**
 * renderDocument.js — Render Engine 文档注册桥
 *
 * 职责：
 *   把"需要走 Render Engine 渲染的文档"（当前 OFD，未来 CAD/SVG/TIFF/HTML）
 *   主动注册进 backend render registry，换取稳定 doc_id，写回 fileObj。
 *
 * 边界（13-A.3.5b 冻结）：
 *   - 只发起一次 open 请求；不操作 React；不碰 parse_ofd / PreviewCanvas。
 *   - 渲染契约是 ADDITIVE 增强：open 失败 / abort 绝不阻断主解析/导入流
 *     （降级到 legacy previewImage 路径）。
 *   - 不感知具体格式细节，只判断"是否需要 render document"。
 *
 * 与 parseResultConsumer 的关系：
 *   consumer 保持纯消费、不发起请求（其契约）；本模块在 consumer 之外的
 *   import orchestration 层调用，二者通过 fileObj.docId 衔接。
 *
 * @module services/renderDocument
 */

// 本地解析 base URL（不复用 config.js 的 BACKEND_URL）：
// config.js:29 的 `import.meta.env.BASE_URL` 在纯 node 下会抛错，会破坏 node --test；
// 这里采用 config.js:24 的安全写法（可选链），使本模块在测试环境可独立 import，
// 无需 dev-only 的 env-shim loader。env 变量名与 config.js 保持一致。
const BACKEND_URL = import.meta.env?.VITE_BACKEND_URL || 'http://localhost:5000'

/**
 * 把文件主动注册进 backend render registry，换取稳定 doc_id。
 *
 * @param {File} file - 原始文件（fileObj.file）
 * @param {string} [name] - 文件名（后端仅用于日志/兼容，不参与 doc_id 计算）
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - 取消信号（对接 P6-A/B 取消基础设施）
 * @returns {Promise<{docId: string|null}>} 成功含 docId；网络/HTTP/解析失败返回 {docId: null}
 */
export async function openRenderDocument(file, name, options = {}) {
  const { signal } = options
  const formData = new FormData()
  formData.append('file', file, name || (file && file.name) || 'document')

  let resp
  try {
    resp = await fetch(`${BACKEND_URL}/api/documents/open`, {
      method: 'POST',
      body: formData,
      signal,
    })
  } catch (err) {
    // 渲染契约为增强项：网络错误 / 取消都降级，不向上抛出，避免阻断导入主流程。
    // （signal abort 时 fetch 抛 AbortError，同样吞掉——被取消的导入不需要 render 注册）
    console.warn('[renderDocument] openRenderDocument 失败，降级 legacy preview:', err && err.message ? err.message : err)
    return { docId: null }
  }

  if (!resp.ok) {
    console.warn(`[renderDocument] openRenderDocument HTTP ${resp.status}`)
    return { docId: null }
  }

  let data
  try {
    data = await resp.json()
  } catch {
    return { docId: null }
  }

  // 后端返回 { success, doc_id, ... }；doc_id 由 bytes 内容哈希得出（filename 不参与）
  return { docId: data && data.success ? (data.doc_id || null) : null }
}

/**
 * 确保 fileObj 已持有 render registry 的 doc_id（渲染契约 gateway）。
 *
 * 这是"所有非 PDF 文档进入 Render Contract 的唯一入口"：
 *   1. 已存在 docId → 直接返回（幂等，不重复请求）
 *   2. 无 file → 无法注册，返回 null
 *   3. 当前仅 OFD 走 render 契约；未来 CAD/SVG/TIFF/HTML 在此扩展判断
 *   4. 调 openRenderDocument 注册，成功写回 fileObj.docId
 *
 * 由 import orchestration 层（useFileOps 三处 consume 现场之前）统一调用，
 * 不放在 parseResultConsumer 内（consumer 契约：不发起请求）。
 *
 * @param {Object} fileObj - 导入文件对象（需含 .file / .fileFormat / .docId）
 * @returns {Promise<string|null>} docId 或 null
 */
export async function ensureRenderContract(fileObj) {
  if (!fileObj) return null
  if (fileObj.docId) return fileObj.docId
  if (!fileObj.file) return null
  // 渲染契约当前覆盖 OFD；新增格式在此扩展（不要散落到多处 if ofd）
  if (fileObj.fileFormat !== 'ofd') return null

  const { docId } = await openRenderDocument(fileObj.file, fileObj.name)
  if (docId) {
    fileObj.docId = docId
  }
  return docId
}
