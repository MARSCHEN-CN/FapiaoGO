/**
 * 13-B.5.1a: Render Print 多页闭环（pages[] → N 张物理页）。
 *
 * 背景（13-B.5.1a，用户确认范围）：
 *   - 一个多页 OFD 经 buildPrintJobItem().pages 逐页渲染后，render 任务产出
 *     N 个 Uint8Array（每页一个）；runMergedPrintTasks 必须「展开」数组 data，
 *     使每个 Uint8Array 成为一张独立物理页，而非压成单页或嵌套数组。
 *   - 这正是 13-B.5.1a 从「修 OFD 多页 bug」提升为「建立 Render Print → Physical Print
 *     的 page cardinality 契约」的核心交付。
 *
 * 本测试分两部分：
 *   1. 可执行：直接 import runMergedPrintTasks（纯模块、无浏览器依赖），用 mock renderFn
 *      验证多页 array data 被展开为 N 张物理页（含单页/多页混合）。
 *   2. 静态：usePrint.js OFD 分支遍历 job.pages 并逐页 fetchPrintRaster(job.docId, page.index + 1)，
 *      这是多页闭环在渲染层的落点（hook 无法在 node --test 直接执行，锁死接线）。
 *
 * @module utils/__tests__/multiPagePrint
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runMergedPrintTasks } from '../../runners/printRunner.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = (rel) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

test('13-B.5.1a: runMergedPrintTasks 展开多页 array data → N 张物理页', async () => {
  // 模拟一个多页 OFD（3 页）产出 [buf1, buf2, buf3]，一个单页 PDF 产出单个 buf
  const buf = (n) => new Uint8Array([n])
  const tasks = [
    { id: 'ofd-A', data: { key: 'ofd-A', data: [buf(1), buf(2), buf(3)] } },
    { id: 'pdf-B', data: { key: 'pdf-B', data: buf(9) } },
  ]

  let received = null
  const mergedPrintFn = async (images) => {
    received = images
    return { success: true, pagesPrinted: images.length }
  }
  // renderFn 直接把任务里的 { key, data } 透传给 runMergedPrintTasks
  const renderFn = async (task) => task.data

  const { results } = await runMergedPrintTasks(tasks, renderFn, mergedPrintFn, { batchSize: 2 })

  // 每个任务对应一条结果（任务级成功，与物理页数解耦）
  assert.equal(results.length, 2, '两个 render 任务应各产生一条结果')
  assert.equal(results[0].success, true, '多页 OFD 任务应标记成功')

  // printMergedImages 收到的 images 必须是扁平数组，长度 = 物理页数
  assert.ok(Array.isArray(received), 'printMergedImages 收到的 images 必须是扁平数组')
  assert.equal(received.length, 4, '3 页 OFD + 1 页 PDF = 4 张物理页（多页已展开）')

  // 多页 OFD 的三页栅格必须原序进入物理页序列（不丢页、不乱序）
  assert.deepEqual(
    [...received[0], ...received[1], ...received[2]],
    [1, 2, 3],
    'OFD 三页栅格必须原序进入物理页序列'
  )
  assert.equal(received[3][0], 9, '单页 PDF 栅格保持独立物理页')
})

test('13-B.5.1a: usePrint.js OFD 分支逐页取 Render Contract 栅格（多页闭环落点）', () => {
  const code = src('hooks/usePrint.js')
  assert.ok(
    code.includes('buildPrintJobItem'),
    'usePrint.js 必须引入并使用 buildPrintJobItem（消费 pages[] 模型）'
  )
  assert.ok(
    code.includes('fetchPrintRaster(job.docId, page.index + 1)'),
    'usePrint.js OFD 分支必须逐页 fetchPrintRaster(job.docId, page.index + 1)（多页闭环核心）'
  )
  assert.ok(
    code.includes('for (const page of pages)'),
    'usePrint.js 必须遍历 job.pages 逐页渲染（而非仅 page=1）'
  )
})

test('13-B.5.1a: usePrint.js OFD 多页产出 data 为页 buffer 数组（交给 runMergedPrintTasks 展开）', () => {
  const code = src('hooks/usePrint.js')
  assert.ok(
    code.includes('data: buffers'),
    'usePrint.js OFD 多页分支必须返回 data: buffers（页 buffer 数组），交由 printRunner 展开'
  )
})
