/**
 * exportFileDimensions.js — merge 导出 per-file 物理尺寸补齐（P0-Image-Geometry）
 *
 * 职责：为每个导出 fileObj 解析可靠的物理尺寸（width/height），供 buildExportSnapshot
 * 的 createPlacement 使用。尺寸源优先级：
 *   1. fileObj._imageWidth/_imageHeight（image，natural px）—— 已预览/打印过则复用
 *   2. fileObj._pdfPageWidth/_pdfPageHeight（PDF，points）—— 已预览/打印过则复用
 *   3. GET /metadata/{effDocId} → pages[pageNum-1] —— 确定性、非 UI，补齐未预览过的文件
 *
 * 单位约定（与后端 src_page 尺寸对齐）：
 *   - image → natural px（fitz.open(image) 的页面尺寸就是 natural px）
 *   - PDF   → points（insert_pdf 透传，sourceWidth 不参与当前 PDF 导出几何；
 *             此处仅建模，暂不做 pt→px 转换，属防御性预留）
 *
 * 纪律：绝不触发 UI 预览/打印来补齐尺寸；缺失时静默返回 0，不抛错。
 */

import { BACKEND_URL } from '../config'

/**
 * 解析单个 fileObj 的物理尺寸。
 * @param {Object} fileObj - page-level fileObj（含 key/_imageWidth/_pdfPageWidth/sourceDocId/docId/pageNum）
 * @returns {Promise<{width:number, height:number}>}
 */
export async function resolveExportFileDimensions(fileObj) {
  if (!fileObj) return { width: 0, height: 0 }

  // 1. 复用已有 image 尺寸（natural px）
  if (fileObj._imageWidth > 0 && fileObj._imageHeight > 0) {
    return { width: fileObj._imageWidth, height: fileObj._imageHeight }
  }
  // 2. 复用已有 PDF 尺寸（points）
  if (fileObj._pdfPageWidth > 0 && fileObj._pdfPageHeight > 0) {
    return { width: fileObj._pdfPageWidth, height: fileObj._pdfPageHeight }
  }

  // 3. /metadata 补齐（确定性、非 UI）
  const effDocId = fileObj.sourceDocId || fileObj.docId
  if (!effDocId) return { width: 0, height: 0 }
  try {
    const resp = await fetch(`${BACKEND_URL}/metadata/${effDocId}`)
    if (!resp.ok) return { width: 0, height: 0 }
    const meta = await resp.json()
    if (!meta.success || !Array.isArray(meta.pages) || meta.pages.length === 0) {
      return { width: 0, height: 0 }
    }
    // 多页拆分页必须精确取 pages[pageNum-1]，不得共用 pages[0]（P0-Image-Geometry 第 4 条）
    const pageNum = (typeof fileObj.pageNum === 'number' && fileObj.pageNum >= 1) ? fileObj.pageNum : 1
    const page = meta.pages[pageNum - 1]
    if (page && page.width > 0 && page.height > 0) {
      return { width: page.width, height: page.height }
    }
  } catch (_) { /* metadata 不可用，静默返回 0 */ }

  return { width: 0, height: 0 }
}

/**
 * 批量解析一组 fileObj 的物理尺寸。
 * @param {Object[]} files - page-level fileObj[]
 * @returns {Promise<Map<string, {width:number,height:number}>>} key → {width, height}
 */
export async function resolveExportFilesDimensions(files) {
  const dimsMap = new Map()
  await Promise.all((files || []).map(async (f) => {
    if (!f || !f.key) return
    const dims = await resolveExportFileDimensions(f)
    dimsMap.set(f.key, dims)
  }))
  return dimsMap
}
