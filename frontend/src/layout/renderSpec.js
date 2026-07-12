/**
 * RenderSpec — V16 Stage 1 的「请求 DTO」（非领域对象）。
 *
 * 设计纪律（与 v16-stage1-design.md / v16-architecture-target.md 对齐）：
 *  • RenderSpec 是 Factory 输出的投影，只含「解析后的值」，不携带 fitMode/alignment 等意图。
 *  • Plain Object（非 class）：它只是前端→RE 的请求载荷，可测试性最高。
 *  • 坐标系：与 PaperLayout / RenderLayout 同一坐标系（当前 px@PREVIEW_DPI），禁止 px/mm 混用。
 *  • RE 末端仅做一次 坐标→设备像素(dpi) 换算（Step 4 消费）。
 *
 * 阶段约束（Step 2）：本模块产出的 URL 参数一律使用「后端当前不识别的新字段名」
 * （paper_w / scale / ox / oy / clip_* / dpi），因此不改变现有 RE 渲染输出；
 * 后端在 Step 4 才会消费这些字段并移除 A4 硬编码 / fitMode switch。
 * 切勿在 Step 2 发送后端已识别的 rotation / paper(key) / margin(key)，
 * 否则会与 PreviewCanvas 的 CSS 旋转 / 既有 A4 默认产生双重作用导致渲染异常。
 */

import { PREVIEW_DPI } from '../config.js'

/**
 * RenderSpec 线路版本号（用户审核②）。
 * 随 URL 一并发送（?spec=v1），后端在 Step 4 起按版本分支消费；
 * 未来 v2 引入 crop / 新对齐 / 多页拼版时，可 switch(spec) 兼容旧前端，成本最低。
 */
export const RENDER_SPEC_VERSION = 'v1'

/**
 * 把 RenderSpec 投影为「进入 URL 的线字段」（与后端 Step 4 消费字段一一对应）。
 * 仅用于拼 URL；签名改由 normalizeRenderSpec + renderSpecSignature 基于完整 spec 计算（见下方）。
 */
function wireFieldsOf(spec) {
  return {
    paper_w: spec.paper ? String(spec.paper.width) : undefined,
    paper_h: spec.paper ? String(spec.paper.height) : undefined,
    margin_t: spec.margin ? String(spec.margin.top) : undefined,
    margin_r: spec.margin ? String(spec.margin.right) : undefined,
    margin_b: spec.margin ? String(spec.margin.bottom) : undefined,
    margin_l: spec.margin ? String(spec.margin.left) : undefined,
    scale: spec.placement ? String(spec.placement.scale) : undefined,
    ox: spec.placement ? String(spec.placement.offsetX) : undefined,
    oy: spec.placement ? String(spec.placement.offsetY) : undefined,
    rotation: String(spec.rotation ?? 0),  // 🆕 V17 deprecated：内容不再旋转，保留字段仅作兼容
    paper_landscape: spec.paperLandscape ? '1' : '0',  // 🆕 V17：纸随内容方向
    clip_x: spec.clip ? String(spec.clip.x) : undefined,
    clip_y: spec.clip ? String(spec.clip.y) : undefined,
    clip_w: spec.clip ? String(spec.clip.width) : undefined,
    clip_h: spec.clip ? String(spec.clip.height) : undefined,
    dpi: String(spec.dpi ?? PREVIEW_DPI),
  }
}

/**
 * 规范化 RenderSpec，使序列化稳定（用户建议一）。
 *  • 递归按 key 字典序排序（消除对象字面量插入顺序导致的 hash 漂移）。
 *  • 浮点四舍五入到 6 位小数（消除 fit 计算产生的 0.4999999 vs 0.5 类噪声，
 *    否则同一布局的 hash 会随机变化）。
 * 返回新的纯对象，**不修改入参**。
 */
export function normalizeRenderSpec(spec) {
  if (spec === null || typeof spec !== 'object') {
    if (typeof spec === 'number' && Number.isFinite(spec)) {
      return Math.round(spec * 1e6) / 1e6
    }
    return spec
  }
  if (Array.isArray(spec)) return spec.map(normalizeRenderSpec)
  const out = {}
  for (const k of Object.keys(spec).sort()) {
    out[k] = normalizeRenderSpec(spec[k])
  }
  return out
}

/**
 * 跨语言稳定序列化（用户 Commit A 核心）。
 *
 * 为什么不用 `JSON.stringify`？
 *   JS `JSON.stringify(595.0)` 输出 `"595"`，Python `json.dumps(595.0)` 输出 `"595.0"`，
 *   两者 hash 永远对不上 → 后端重算签名永远与前端的对不上，Debug 机制失效。
 * 这里统一口径（与 backend/render_engine/render_spec_sig.py 的 canonical_string 逐字节对齐）：
 *   • 数字  → 固定 6 位小数（`toFixed(6)`），消除 `"595" vs "595.0"` 与 fit 浮点抖动。
 *   • 字符串 → `JSON.stringify`（与 Python `json.dumps(ensure_ascii=False)` 一致）。
 *   • key 递归字典序（normalizeRenderSpec 已排序，这里再排双保险）。
 *   • 数组 / 对象递归。
 * 这样 JS 与 Python（f"{v:.6f}" / json.dumps）对同一 spec 产出完全相同的字节串，
 * 后端 Step 4 可重算同一签名回显比对（见 Commit A 验收）。
 */
function canonicalString(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null'
    return value.toFixed(6)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalString).join(',') + ']'
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalString(value[k])).join(',') + '}'
  }
  return 'null'
}

/**
 * RenderSpec 线路签名（FNV-1a，8 位十六进制，用户审核④ + 建议一 + Commit A 跨语言对齐）。
 * 基于「规范化后的完整 RenderSpec」计算：normalizeRenderSpec 保证 key 顺序与浮点精度稳定
 * → 同一布局无论字段插入顺序 / 浮点抖动，hash 恒定（stable serialization 成为模块不变量）。
 * 序列化改用 canonicalString（数字定宽 6 小数）以保证与 Python 侧逐字节一致（见上）。
 * 后端 Step 4 重建完整 spec（docId 取自 URL path、page 取自 ?page=、其余取自线字段）
 * 并应用相同 normalize + canonicalString + 本函数重算，回显逐字节比对，消除双算/分叉猜测。
 * ⚠️ 签名不含 spec / spec_sig 自身；后端须用相同字段集合重算才能复现同一签名。
 */
export function renderSpecSignature(spec) {
  const canonical = canonicalString(normalizeRenderSpec(spec))
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * 将 RenderLayout（Derived）投影为 RenderSpec（前端→RE 请求载荷，Plain Object）。
 *
 * @param {ReturnType<import('./RenderLayoutFactory.js').buildRenderLayout>} renderLayout
 * @param {{ docId?: string, page?: number, dpi?: number, marginsMm?: {top:number,right:number,bottom:number,left:number} }} opts
 * @returns {object|null} 渲染规格 DTO；renderLayout 未就绪时返回 null
 */
export function buildRenderSpec(renderLayout, { docId, page = 1, dpi = PREVIEW_DPI, marginsMm } = {}) {
  if (!renderLayout || !renderLayout.paper || !renderLayout.paper.paperRect) return null
  const { paper, placement, rotation, clip, paperLandscape } = renderLayout
  const pr = paper.paperRect
  return {
    docId,
    page,
    dpi,
    // 纸张物理尺寸（显式 w/h，不依赖后端纸型查表；Step 4 后端据此渲染任意纸型）
    paper: { width: pr.w ?? 0, height: pr.h ?? 0 },
    // 边距（mm）：来自 PaperLayout 的 margins，Step 4 后端据此替换 A4 硬编码默认 0
    margin: marginsMm || { top: 0, right: 0, bottom: 0, left: 0 },
    // 解析后 placement（已是内容→纸张的最终缩放+偏移，RE 直接 draw，不重算）
    placement: {
      scale: placement?.scale ?? 0,
      offsetX: placement?.offsetX ?? 0,
      offsetY: placement?.offsetY ?? 0,
    },
    // 🆕 V17 deprecated：内容不再旋转（纸随内容方向）；保留字段仅作兼容，恒为 0
    rotation: rotation ?? 0,
    // 🆕 V17：纸随内容方向（True=横纸/False=竖纸）；RE/Canvas/Print 三端统一消费此字段
    paperLandscape: !!paperLandscape,
    // 完全来自 PaperLayout.clipRect（评审修正④），RE 不得重算
    // 注：buildRenderLayout 已把 clipRect 统一为 {x,y,width,height} 形态
    clip: { x: clip?.x ?? 0, y: clip?.y ?? 0, width: clip?.width ?? 0, height: clip?.height ?? 0 },
  }
}

/**
 * 把 RenderSpec 编码进 RE URL 查询参数（保持 GET，不破坏 P0 <img> 恢复链路）。
 * 仅使用后端当前忽略的新字段名，因此不改变现有渲染输出（Step 4 才消费）。
 *
 * @param {string} baseUrl 形如 http://.../preview/{docId}?page=1
 * @param {object|null} spec buildRenderSpec 的产出；为 null 时原样返回 baseUrl
 * @returns {string}
 */
export function appendRenderSpecToUrl(baseUrl, spec) {
  if (!spec) return baseUrl
  const wire = wireFieldsOf(spec)
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(wire)) {
    if (v !== undefined) p.set(k, v)
  }
  // 用户审核②：线路版本号，后端 Step 4 起按 switch(spec) 分支消费
  p.set('spec', RENDER_SPEC_VERSION)
  // 用户审核④：调试签名，Step 4 后端可重算同一签名回显，逐字节比对 Preview vs RE
  p.set('spec_sig', renderSpecSignature(spec))
  const sep = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${sep}${p.toString()}`
}
