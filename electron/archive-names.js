'use strict'

/**
 * 压缩包内文件名冲突策略（纯函数，无 IO、无 electron 依赖）
 *
 * 单独成模块的原因：archive-utils.js 依赖 temp-manager → electron.app.getPath，
 * 在纯 node 下无法加载，导致这段关键逻辑长期没有测试覆盖。
 * 命名策略是业务规则，不应被打包 IO 的运行时依赖绑架。
 */

const path = require('path')

/**
 * 处理压缩包内的文件名冲突。
 *
 * 两种模式（Commit 1b）：
 *   - 宽松（默认 strict=false）：沿用历史行为，重名自动加 `_1`/`_2` 后缀。
 *     用于旧 payload 及「业务层未声明保证唯一」的场景，避免回归。
 *   - 严格（strict=true）：调用方已声明 targetName 由 Document 域算好并保证唯一，
 *     此时出现重名说明上游命名逻辑有缺陷，直接抛错。
 *
 * 为什么严格模式不静默去重：
 *   自动加 `_1` 会掩盖上游 bug，并产出语义错误的压缩包——同票多页本应是
 *   `12345678.pdf` / `12345678_p2.pdf`（页序可辨），静默去重后变成
 *   `12345678.pdf` / `12345678_1.pdf`，且 `_1` 落在哪一页取决于数组顺序，
 *   用户无法判断页序。页码后缀是业务语义，archive 层不应代为发明。
 *
 * 为什么保留宽松模式而非一律抛错：
 *   `renameBeforeArchive=false` 时用原文件名打包，来自不同目录的同名文件
 *   （如两份都叫「发票.pdf」）是合法输入，一律抛错会让整批打包失败。
 *
 * @param {Array<{originalPath:string, targetName:string}>} files
 * @param {{strict?: boolean}} [options]
 * @returns {{resolved: Array, collisions: Array<{targetName:string, finalName:string}>}}
 * @throws {Error} strict 模式下检测到重名
 */
function resolveArchiveFileNames(files, { strict = false } = {}) {
  const usedNames = new Set()
  const resolved = []
  const collisions = []

  for (const file of files) {
    let finalName = file.targetName
    const ext = path.extname(finalName)
    const baseName = path.basename(finalName, ext)

    if (usedNames.has(finalName)) {
      if (strict) {
        throw new Error(
          `压缩包内出现重复文件名「${finalName}」。` +
          `文件名应由发票文档层生成并保证唯一（多页发票需带 _p2/_p3 页码后缀），` +
          `请检查命名规则是否能区分同一张发票的不同页。`
        )
      }
      let counter = 1
      while (usedNames.has(finalName)) {
        finalName = `${baseName}_${counter}${ext}`
        counter++
      }
      collisions.push({ targetName: file.targetName, finalName })
    }

    usedNames.add(finalName)
    resolved.push({ ...file, finalName })
  }

  return { resolved, collisions }
}

module.exports = { resolveArchiveFileNames }
