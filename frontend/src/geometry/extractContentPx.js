/**
 * Extract raw source geometry only.
 *
 * This module MUST NOT derive orientation, rotation, or paper relationship.
 * 本模块只负责 file metadata → 原始内容像素，方向/旋转/纸张关系决策属于
 * PreviewGeometryBuilder / PrintAutoRotationPolicy。
 *
 * extractContentPx — 从文件对象提取原始内容 px。
 *
 * Gate 2 (PreviewGeometryBuilder) 的几何输入辅助。与 `detectDocumentOrientation`
 * （utils/detectOrientation.js）使用**同一几何源**（见其文件头文档注释），确保
 * `PreviewGeometryBuilder.orientationMismatch` 与旧 `isLandscape = contentOrient !== paperOrient`
 * 值等价，从而替换进缓存键不会引发快照回归。
 *
 * 本函数只提取数据，不做方向判断——方向决策属于 PreviewGeometryBuilder / PrintAutoRotationPolicy。
 *
 * @param {object} file - 文件对象（PDF / 图片 / OFD）
 * @returns {{widthPx:number, heightPx:number}}
 */
export function extractContentPx(file) {
  if (!file) return { widthPx: 0, heightPx: 0 }
  // PDF：加载时提取的页面尺寸
  if (file._pdfPageWidth > 0 && file._pdfPageHeight > 0) {
    return { widthPx: file._pdfPageWidth, heightPx: file._pdfPageHeight }
  }
  // 图片 / OFD previewImage（与 detectDocumentOrientation 同优先级）
  const w = file._imageWidth || file.previewWidth || 0
  const h = file._imageHeight || file.previewHeight || 0
  return { widthPx: w, heightPx: h }
}
