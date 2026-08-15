/**
 * mergeModeContract.js — R2.3-A.1 Merge Mode → Paper Contract（Virtual Paper 拓扑唯一权威）
 *
 * ❄️ 冻结硬规则（用户钉死，2026-08-15）：
 *   1. **Merge Mode 决定 Virtual Paper 的数量与拓扑**；实际文件数量只决定
 *      哪些 Virtual Paper 有内容（缺失 = EMPTY Virtual Paper）。
 *   2. 缺失文件**不得**导致：slot 数量减少、slot 合并、内容扩张、模式降级。
 *   3. **Merge4 的 Real Paper orientation 由 Merge4 contract 强制为 Landscape**，
 *      与用户输入纸张原始方向无关（merge2/3 强制竖向，Normal 跟随用户）。
 *   4. **Preview 与 Artifact 必须共享同一套 mode → paper → slots 语义**
 *      （本模块即该共享契约；Golden Preview 的 slotCount 真值源 = resolveMergeSpec，
 *      方向真值源 = getForcedLandscape——二者在此合并为单一契约）。
 *
 * 表格（冻结）：
 *   | Mode   | slotCount | strategy | grid     | 最终纸张   |
 *   |--------|-----------|----------|----------|-----------|
 *   | Normal | 1         | vertical | -        | 用户方向   |
 *   | Merge2 | 2         | vertical | -        | 纵向       |
 *   | Merge3 | 3         | vertical | -        | 纵向       |
 *   | Merge4 | 4         | grid     | 2×2      | **横向**   |
 *
 * 本模块零依赖（resolveMergeSpec / getForcedLandscape 均为纯函数），node 可直测。
 *
 * @module print/mergeModeContract
 */

import { resolveMergeSpec } from '../compose/composeSlot.js'
import { getForcedLandscape } from '../utils/mergeMode.js'

/** Merge Mode Contract 版本号。 */
export const MERGE_MODE_CONTRACT_VERSION = 1

/**
 * 解析 mergeMode → 完整 Paper Contract。
 *
 * @param {string|null|undefined} mergeMode - 'none' | 'merge2' | 'merge3' | 'merge4'
 * @returns {{
 *   mergeMode: string,
 *   slotCount: number,          // Virtual Paper 数量（= mode 定义值，与文件数无关）
 *   strategy: 'vertical'|'grid',
 *   gridCols: number,
 *   gridRows: number,
 *   forcedLandscape: boolean,   // merge4=true（强制横向）；merge2/3=false；none=false（跟随用户）
 *   isMerge: boolean,
 * }}
 */
export function resolveMergeModeContract(mergeMode) {
  const mode = mergeMode || 'none'
  const isMerge = mode !== 'none'
  if (!isMerge) {
    return {
      mergeMode: mode,
      slotCount: 1,
      strategy: 'vertical',
      gridCols: 2,
      gridRows: 2,
      forcedLandscape: false, // Normal：方向跟随用户（调用方用 settings.landscape 覆盖）
      isMerge: false,
    }
  }
  const spec = resolveMergeSpec(mode) // Golden 同源：merge2/3/4 → groupSize/strategy/gridCols/gridRows
  return {
    mergeMode: mode,
    slotCount: spec.groupSize,
    strategy: spec.strategy,
    gridCols: spec.gridCols,
    gridRows: spec.gridRows,
    forcedLandscape: getForcedLandscape(mode, false), // merge4 → true；merge2/3 → false
    isMerge: true,
  }
}

export default resolveMergeModeContract
