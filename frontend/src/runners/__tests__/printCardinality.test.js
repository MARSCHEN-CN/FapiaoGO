/**
 * 13-B.5.1b: Render Print Page Cardinality Contract（契约锁）。
 *
 * 核心交付（13-B.5.1a 建立，13-B.5.1b 冻结）：
 *   1 render task → N render outputs（buildPrintJobItem().pages 逐页 fetchPrintRaster
 *   → Uint8Array[]）→ runMergedPrintTasks.flattenPrintData 展开 → N 张物理页。
 *
 * 这把 Render Print 子系统从「一个 render task = 一个图片」升级为
 * 「一个 render task = 一个文档页面集合 → flatten → 物理页集合」。
 * 多页 OFD 闭环真正成立的原因即此契约，而非单纯 OFD 特判。
 *
 * 本测试以 runMergedPrintTasks（纯模块、无浏览器依赖）直接验证：
 *   - 旧单 Uint8Array 返回值 → 1 物理页（向后兼容，Check 1）
 *   - 多页 Uint8Array[] → N 物理页
 *   - 混合（3 页 + 1 页）= 4 物理页且原序；每任务仍 1 条结果（任务级成功与页数解耦）
 *
 * @module runners/__tests__/printCardinality
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runMergedPrintTasks } from '../printRunner.js'

// 旧 renderer 返回单个 Uint8Array；Render Print 子系统返回 Uint8Array[]（每页一个）
const single = (n) => ({ key: `s${n}`, data: new Uint8Array([n]) })
const multi = (id, ns) => ({ key: id, data: ns.map((n) => new Uint8Array([n])) })

// 透传任务自带的 data 作为 render 结果（runMergedPrintTasks 期望 renderFn 返回 { data }）
const echoRender = async (task) => ({ data: task.data })

// 捕获 printMergedImages 收到的 images（物理页序列）
const captureMerged = () => {
  let received = null
  const mergedPrintFn = async (images) => {
    received = images
    return { success: true, pagesPrinted: images.length }
  }
  return { get: () => received, fn: mergedPrintFn }
}

test('Cardinality: 旧单 Uint8Array 渲染器 → 1 物理页（向后兼容）', async () => {
  const tasks = [single(7)]
  const cap = captureMerged()
  await runMergedPrintTasks(tasks, echoRender, cap.fn, { batchSize: 1 })
  const received = cap.get()
  assert.ok(Array.isArray(received), 'images 必须是扁平数组')
  assert.equal(received.length, 1, '单 Uint8Array 应产出 1 张物理页')
  assert.deepEqual([...received[0]], [7], '栅格内容原样进入物理页')
})

test('Cardinality: 多页 Uint8Array[] → N 张物理页（N=3）', async () => {
  const tasks = [multi('ofd-A', [1, 2, 3])]
  const cap = captureMerged()
  await runMergedPrintTasks(tasks, echoRender, cap.fn, { batchSize: 1 })
  const received = cap.get()
  assert.equal(received.length, 3, '3 页文档应展开为 3 张物理页（非 1 张、非嵌套）')
  assert.deepEqual(
    received.map((b) => b[0]),
    [1, 2, 3],
    '多页栅格原序进入物理页序列'
  )
})

test('Cardinality: 混合任务（3 页 + 1 页）= 4 物理页且原序，任务级结果解耦', async () => {
  const tasks = [multi('ofd-A', [1, 2, 3]), single(9)]
  const cap = captureMerged()
  const { results } = await runMergedPrintTasks(tasks, echoRender, cap.fn, { batchSize: 2 })
  const received = cap.get()

  // 任务级成功与物理页数解耦：2 个任务 = 2 条结果
  assert.equal(results.length, 2, '2 个 render 任务应各产生 1 条结果')
  assert.equal(results[0].success, true, '多页任务应标记成功')

  // 物理页 cardinality：3 + 1 = 4
  assert.equal(received.length, 4, '3 页 OFD + 1 页 PDF = 4 张物理页（多页已展开）')
  // 文档顺序：先 OFD 三页，再 PDF 一页
  assert.deepEqual(
    received.map((b) => b[0]),
    [1, 2, 3, 9],
    '多文档物理页序列须保持文档顺序且各文档内部页原序'
  )
})
