/**
 * mergeFinalArtifactCanonical.js — R2.3-A Final Artifact 生产端（CanonicalPlacement 驱动）
 *
 * 在 `renderMergeFinalArtifact` 入口处替换旧几何路径：
 *   Old: renderMultipleItemsToCanvas → MultiTicketComposer / buildRenderCommand / createPlacement
 *   New: raw raster(rotation:0) → composeCanonicalArtifactPlan → executeComposePlan
 *        （computeSlots + buildCanonicalPlacement + buildCanvasDrawOps/applyDrawOps）
 *
 * 不变量（与旧 producer 输出契约一致，doPrint 消费零改动）：
 *   • 返回 { canvas, dataURL }
 *   • 输入签名与 renderMergeFinalArtifact 相同（paperSize/dpi/forcedLandscape/fileRotations/
 *     groupSize/paperLayout/layoutOptions）
 *   • 旧 raster 路径（renderMultipleItemsToCanvas/MultiTicketComposer）原样保留，未删。
 *
 * @module print/mergeFinalArtifactCanonical
 */

import { PREVIEW_DPI } from '../config'
import { renderPDFPageRaw } from '../renderers.js'
import { composeCanonicalArtifactPlan, executeComposePlan } from './canonicalArtifactComposer.js'
import { resolveMergeModeContract } from './mergeModeContract.js'

// 轻量 L2 缓存（与旧 renderResultCache 同角色）：相同输入签名直接命中，避免重复 rasterize PDF。
const _canonicalCache = new Map()
const _CANONICAL_CACHE_MAX = 30

function _cacheKey(opts, validItems) {
  const pl = opts.paperLayout
  return JSON.stringify({
    v: 2,
    keys: validItems.map(i => i.id || i.key),
    paperSize: opts.paperSize,
    dpi: opts.dpi ?? PREVIEW_DPI,
    mergeMode: opts.mergeMode || null,
    forcedLandscape: !!opts.forcedLandscape,
    rotations: opts.fileRotations || {},
    groupSize: opts.groupSize,
    strategy: (opts.layoutOptions || {}).strategy,
    gridCols: (opts.layoutOptions || {}).gridCols ?? 2,
    gridRows: (opts.layoutOptions || {}).gridRows ?? 2,
    paperLayout: pl ? { r: pl.paperRect, u: pl.usableRect } : null,
  })
}

function _createCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function _loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/**
 * Rasterize 一个合并项为 raw 源（rotation:0，px@dpi，未经 fit）：
 *   PDF  → renderPDFPageRaw 无 paperKey（raw 页自然尺寸 × dpi/72）
 *   OFD/image → _previewImageUrl 解码（Image）
 * 失败返回 null（该 slot 留空，与旧路径 contentSources 缺失语义一致）。
 */
async function _rasterizeItem(item, dpi) {
  try {
    if (item._pdfData) {
      const r = await renderPDFPageRaw(item._pdfData, dpi, item.key)
      if (r && r.canvas && r.width > 0 && r.height > 0) {
        return { source: r.canvas, width: r.width, height: r.height }
      }
      console.warn('[canonical-artifact] PDF 栅格返回 null:', item.key)
    } else if (item._previewImageUrl) {
      const img = await _loadImage(item._previewImageUrl)
      if (img && img.naturalWidth > 0) {
        return { source: img, width: img.naturalWidth, height: img.naturalHeight }
      }
      console.warn('[canonical-artifact] 图像解码失败:', item.key)
    }
  } catch (e) {
    console.error('[canonical-artifact] 栅格化异常:', item.key, e)
  }
  return null
}

/**
 * R2.3-A 生产端主入口（app 环境）。
 *
 * @param {Array} validItems - 已加载合并项（含 _pdfData 或 _previewImageUrl）
 * @param {Object} opts - 与 renderMergeFinalArtifact 相同
 * @returns {Promise<{canvas: HTMLCanvasElement, dataURL: string}|null>}
 */
export async function renderMergeFinalArtifactCanonical(validItems, opts = {}) {
  if (!validItems || validItems.length === 0) return null
  if (!opts.paperLayout || !opts.paperLayout.paperRect) {
    console.warn('[canonical-artifact] paperLayout 缺失（canonical 需要 usableRect 语义）⇒ return null')
    return null
  }

  const dpi = opts.dpi ?? PREVIEW_DPI
  const key = _cacheKey(opts, validItems)
  const hit = _canonicalCache.get(key)
  if (hit) return hit

  // 1. raw rasterize（rotation:0）
  const sources = []
  for (const item of validItems) {
    const src = await _rasterizeItem(item, dpi)
    sources.push(src ? { ...src, contentRotation: (opts.fileRotations && (opts.fileRotations[item.id || item.key])) || 0 } : null)
  }

  // 2. 几何计划（纯函数）+ 3. 执行
  // ✅ R2.3-A.1：Virtual Paper topology 由 MergeMode Contract 决定（slotCount 与文件数彻底分离）。
  //    有 mergeMode 时，contract.slotCount 覆盖 opts.groupSize（调用方即使传了文件数也不影响），
  //    缺失 source 由 composer 的 sourceIndex=-1 生成 EMPTY Virtual Paper（区域保留、不绘制）。
  const contract = opts.mergeMode ? resolveMergeModeContract(opts.mergeMode) : null
  const slotCount = contract ? contract.slotCount : (opts.groupSize || validItems.length)
  const plan = composeCanonicalArtifactPlan({
    paperLayout: opts.paperLayout,
    groupSize: slotCount,
    strategy: (contract && contract.strategy) || (opts.layoutOptions || {}).strategy || (slotCount === 4 ? 'grid' : 'vertical'),
    gridCols: (contract && contract.gridCols) ?? (opts.layoutOptions || {}).gridCols ?? 2,
    gridRows: (contract && contract.gridRows) ?? (opts.layoutOptions || {}).gridRows ?? 2,
    forcedLandscape: contract ? contract.forcedLandscape : !!opts.forcedLandscape,
    dpi,
    slotSources: sources.map(s => (s ? { width: s.width, height: s.height, contentRotation: s.contentRotation } : null)),
  })
  if (plan.invalid || !plan.canvasSize) return null

  const canvas = _createCanvas(plan.canvasSize.width, plan.canvasSize.height)
  const ctx = canvas.getContext('2d')
  executeComposePlan(ctx, plan, sources, _createCanvas)

  const artifact = { canvas, dataURL: canvas.toDataURL('image/png') }
  _canonicalCache.set(key, artifact)
  if (_canonicalCache.size > _CANONICAL_CACHE_MAX) {
    const firstKey = _canonicalCache.keys().next().value
    _canonicalCache.delete(firstKey)
  }
  return artifact
}

export default renderMergeFinalArtifactCanonical
