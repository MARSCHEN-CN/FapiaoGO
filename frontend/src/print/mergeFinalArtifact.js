// Merge Final Artifact 生成器（硬约束：Merge 模式唯一 Final Canvas 来源）
//
// 设计契约见 `Merge-Final-Artifact-架构设计_2026-08-14.md`（v2 定稿）。
//
// 硬约束 1：Merge 模式「一次生成 Final Artifact → 预览消费 → 打印消费」，
//          几何 / fit / slot / rotation / margin 只算一次。
// 硬约束 2：Final Artifact 不得包含任何 UI Guide（分割线 / 安全边距线 / slot 边界 /
//          debug overlay / Preview-only 标记）。Guide 属 Preview UI overlay，不在此层。
//
// 本文件是 Merge 模式「Final Artifact 流水线」的 Merge-only 载体：
//   loadMergePrintItems()  —— 项加载（pdf/ofd/image → _pdfData/_previewImageUrl）
//   renderMergeFinalArtifact() —— 调一次共享 renderer 产出 Final Canvas + dataURL
// 二者均仅服务 Merge（merge2/3/4）；Normal 打印不得调用，亦不共享此模块。
//
// 关键纪律：公共 renderer `renderMultipleItemsToCanvas` 的签名与算法**不得修改**；
// 本封装对它的调用与既有打印路径（renderMergeGroupToPrintImage）完全等价。
// 共享 renderer 内部已有 L2 缓存（相同参数直接命中），天然保证「Merge 内几何只算一次」。

import { PREVIEW_DPI } from '../config'
import { previewImageToBlob } from '../utils'
import { fetchPrintRaster } from '../utils/printAdapter'
import { renderMultipleItemsToCanvas } from '../renderers.js'
import { renderMergeFinalArtifactCanonical } from './mergeFinalArtifactCanonical.js'

/**
 * 生成 Merge Final Canvas（唯一最终视觉真值）。
 *
 * @param {Array} validItems  已加载的合并项（含 _pdfData 或 _previewImageUrl）
 * @param {Object} opts
 * @param {string} [opts.paperSize='A4']
 * @param {number} [opts.dpi=PREVIEW_DPI]
 * @param {boolean} [opts.forcedLandscape=false]
 * @param {Object} [opts.fileRotations={}]
 * @param {number} [opts.groupSize=validItems.length]
 * @param {Object} [opts.paperLayout=null]     V16 slotted path：驱动 MultiTicketComposer
 * @param {Object} [opts.layoutOptions={}]
 * @param {boolean} [opts.showSafeMargin=false]
 * @param {boolean} [opts.isPrint=false]       保持与既有打印路径一致；Gate B 后续由 showGuides 控制
 * @param {'canonical'|'legacy'} [opts.geometry='canonical']  R2.3-A：默认走 CanonicalPlacement 生产端；
 *   'legacy' = 旧 renderMultipleItemsToCanvas 路径（保留未删，一键回退）
 * @returns {Promise<{canvas: HTMLCanvasElement, dataURL: string}|null>}
 */
export async function renderMergeFinalArtifact(validItems, opts = {}) {
  if (!validItems || validItems.length === 0) return null

  // ✅ R2.3-A：默认 CanonicalPlacement 生产端（复现 Golden 几何；不碰 Preview、不删旧 Raster、不改 Sumatra 链）。
  // 旧几何路径经 geometry:'legacy' 即时回退（R2 纪律：旧 Raster 保留至覆盖证明完整）。
  if ((opts.geometry ?? 'canonical') === 'canonical') {
    const { geometry: _geom, ...rest } = opts
    return renderMergeFinalArtifactCanonical(validItems, rest)
  }

  const {
    paperSize = 'A4',
    dpi = PREVIEW_DPI,
    forcedLandscape = false,
    fileRotations = {},
    groupSize = validItems.length,
    paperLayout = null,
    layoutOptions = {},
    showSafeMargin = false,
    isPrint = false,
  } = opts

  // 共享 renderer（签名/算法不动）。相同参数 → L2 缓存命中 → 几何只算一次。
  const canvas = await renderMultipleItemsToCanvas(
    validItems,
    paperSize,
    dpi,
    forcedLandscape,
    fileRotations,
    groupSize,
    isPrint,
    showSafeMargin,
    layoutOptions,
    paperLayout,
  )
  if (!canvas) return null

  // dataURL 供 Preview 直接显示；Print 用 canvas 编码 PNG。
  const dataURL = canvas.toDataURL('image/png')
  return { canvas, dataURL }
}

/**
 * 加载 Merge 合并项（Merge-only helper，仅服务 merge2/3/4）。
 *
 * 从 `renderMergeGroupToPrintImage` 抽取，行为 / 输入输出与原内联逻辑 1:1 等价。
 * 供 M2 Preview 与后续 M3 Print 共用，确保两侧消费同一份已加载项。
 * **严禁**被 Normal 打印路径调用——这是本轮架构的硬隔离边界。
 *
 * @param {Array}  group  合并组文件数组（每项含 key/name/printPath/fileFormat/docId/previewImage）
 * @param {Object} ipc    IPC 调用对象（提供 invoke('read-file', path)）
 * @returns {Promise<{ validItems: Array, blobUrls: string[] }>}
 *   validItems —— 已加载的合并项（含 _pdfData 或 _previewImageUrl），供 renderMergeFinalArtifact 消费
 *   blobUrls   —— 加载期间创建的 object URL，调用方须在 Final Canvas 渲染完成后回收
 */
export async function loadMergePrintItems(group, ipc) {
  const blobUrls = []
  const items = await Promise.all((group || []).map(async (f) => {
    try {
      if (f.fileFormat === 'pdf' || (!f.fileFormat && !f.previewImage)) {
        const fileData = await ipc.invoke('read-file', f.printPath)
        if (fileData.success) {
          return { ...f, _pdfData: new Uint8Array(fileData.data) }
        }
      } else if (f.fileFormat === 'ofd' || f.fileFormat === 'image') {
        // IMAGE + OFD 统一加载：获取原始图片 blob，然后统一处理
        let blob = null
        if (f.fileFormat === 'ofd') {
          // OFD：通过 backend /print 栅格化获取图片
          if (f.docId) {
            try {
              blob = await fetchPrintRaster(f.docId, 1)
            } catch (e) {
              console.warn('[usePrint] 合并项 OFD docId 栅格失败，回退 previewImage:', f.docId, e?.message)
            }
          }
        } else {
          // 图片：read-file 优先（保留原图分辨率）
          const fileData = await ipc.invoke('read-file', f.printPath)
          if (fileData.success) {
            blob = new Blob([fileData.data])
          }
        }
        // 统一兜底：previewImage（旧 session）
        if (!blob && f.previewImage) {
          blob = previewImageToBlob(f.previewImage)
        }
        if (!blob) {
          console.error('[usePrint] 合并项 %s 无可用数据源:', f.fileFormat?.toUpperCase(), f.name)
          return null
        }
        const blobUrl = URL.createObjectURL(blob)
        blobUrls.push(blobUrl)
        return { ...f, _previewImageUrl: blobUrl }
      }
    } catch (e) {
      console.error('加载合并项失败:', f.name, e)
    }
    return null
  }))
  return { validItems: items.filter(Boolean), blobUrls }
}

// ✅ F2/F1：输入签名已抽取为纯模块 mergeArtifactSignature.js（零依赖，便于 node 单元测试）。
// 此处 re-export 保持既有调用方（usePrint.js）import 路径不变。
export { getMergeArtifactInputSignature } from './mergeArtifactSignature.js'

