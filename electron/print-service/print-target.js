/**
 * print-target.js — 解决"真正打印什么文件"
 *
 * 职责（v2 Raster 接入版）：
 * - OFD 不再在此解析：OFD 单文件打印已在前端路由进 Canvas 管线
 *   （renderFileToPrintImage → renderMultipleItemsToCanvas 施加 placement/rotation/margin
 *    → printMergedImages），与图片同构，几何变换不丢失。原生 Sumatra 直送路径无法施加
 *   canvas 级几何变换，因此 OFD 不应到达此处。
 * - 其他格式 → 源文件直通
 *
 * 历史：旧版 resolveOfdPreview 依赖 import_batch 产出的 previewImage.png，该产出已于
 * fae7805 停用，导致 OFD 恒抛「尚未解析完成，无法打印」。现移除该死逻辑（见 commit v2）。
 */

/**
 * 解析真实打印目标
 *
 * @param {object} target - PrintTarget
 * @param {string} target.filePath - 源文件路径
 * @param {string} target.fileFormat - 文件格式
 * @param {string} target.printer - 打印机名称
 * @returns {Promise<object>} 解析后的 PrintTarget
 * @throws {Error} 如果 filePath 缺失，或 OFD 错误地到达原生路径
 */
async function resolvePrintTarget(target) {
  if (!target || !target.filePath) {
    throw new Error('PrintTarget.filePath is required');
  }

  // OFD 必须走前端 Canvas 管线（见文件头注释）。若仍到达原生 Sumatra 路径，
  // 说明前端路由遗漏，属异常——抛清晰错误而非静默漏打或绕过几何变换。
  if (target.fileFormat === 'ofd') {
    throw new Error('OFD 已改走前端 Canvas 打印管线，不应到达原生 Sumatra 路径（print-source-file）');
  }

  // 其他格式直接返回源文件
  return { ...target };
}

module.exports = { resolvePrintTarget };
