/**
 * exportSnapshotBuilder.test.js — D2-2-c1 几何同源锁 + 三契约陷阱
 *
 * 运行环境：vitest（或等价注入 import.meta.env 的 runner）。
 *   本文件经 exportSnapshotBuilder → resolvePaper → config 间接依赖 import.meta.env，
 *   与 renderSpec.test.js / RenderLayoutFactory.test.js 同约束，不假定裸 node --test。
 *
 * 覆盖：
 *   A) contentRect @EXPORT_DPI 重算（禁转发 Preview @72 command）
 *   B) paper 发后端 PaperSpec {widthMm,heightMm,dpi}（禁 PaperLayout）
 *   C) sourceRef 必填 {path, page}（PDF=当前页 / image=0）
 *   零自有几何：桥接仅委托 createPlacement，无 fit/scale/center/rotate
 *   Producer 同源：snapshot ≡ buildSingleFileRenderCommand（同输入）= Preview buildRenderCommand（同输入）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildExportSnapshot, buildExportPaperSpec, computeContentRectAtDpi } from './exportSnapshotBuilder.js'
import { buildSingleFileRenderCommand } from './singleFileRenderCommand.js'
import { EXPORT_DPI } from './exportConstants.js'
import { buildRenderCommand } from './RenderLayoutFactory.js'

const A4 = { paperSize: 'A4', marginTop: 3, marginRight: 3, marginBottom: 3, marginLeft: 3 }

test('buildExportPaperSpec: 后端 PaperSpec（陷阱 B，非 PaperLayout）', () => {
  const spec = buildExportPaperSpec(A4)
  assert.deepEqual(spec, { widthMm: 210, heightMm: 297, dpi: EXPORT_DPI })
  for (const k of ['marginRect', 'displayRect', 'viewport', 'zoom']) {
    assert.ok(!(k in spec), `paperSpec 不应含 Preview-only 字段 ${k}`)
  }
})

test('computeContentRectAtDpi: @EXPORT_DPI 重算（陷阱 A）且与 @PREVIEW_DPI 不同', () => {
  const at300 = computeContentRectAtDpi(A4, EXPORT_DPI)
  assert.deepEqual(at300, { x: 35, y: 35, width: 2480 - 70, height: 3508 - 70 })
  const at72 = computeContentRectAtDpi(A4, 72)
  assert.notDeepEqual(at300, at72)
  assert.ok(at300.width > at72.width * 4, 'contentRect 必须随 dpi 放大，否则转发 Preview command 会缩角')
})

test('buildExportSnapshot: sourceRef 必填（陷阱 C）+ rotation 来自 fileRotations', () => {
  const files = [
    { key: 'img1', path: '/p/a.png', status: 'parsed' },
    { key: 'pdf1', path: '/p/b.pdf', status: 'parsed' },
    { key: 'skip', path: '/p/c.pdf', status: 'failed' },
  ]
  const fileRotations = { img1: 90, pdf1: 0 }

  // 代表文档为 PDF（当前预览是 PDF）→ 所有命令 page = 当前页
  const pdfDoc = { pageSize: { w: 1240, h: 1754 }, pageNum: 2, sourceType: 'pdf' }
  const pdfCmds = buildExportSnapshot({ files, documentState: pdfDoc, fileRotations, previewPage: 2, settings: A4 })
  assert.equal(pdfCmds.length, 2, 'failed 文件应被过滤')
  assert.deepEqual(pdfCmds[0].sourceRef, { path: '/p/a.png', page: 2 })
  assert.equal(pdfCmds[0].contentRotation, 90)
  assert.deepEqual(pdfCmds[1].sourceRef, { path: '/p/b.pdf', page: 2 })
  assert.equal(pdfCmds[1].contentRotation, 0)
  assert.deepEqual(pdfCmds[0].paper, { widthMm: 210, heightMm: 297, dpi: EXPORT_DPI })

  // 代表文档为 image → 所有命令 page = 0
  const imgDoc = { pageSize: { w: 1240, h: 1754 }, pageNum: 2, sourceType: 'image' }
  const imgCmds = buildExportSnapshot({ files, documentState: imgDoc, fileRotations, previewPage: 2, settings: A4 })
  assert.deepEqual(imgCmds[0].sourceRef, { path: '/p/a.png', page: 0 })
})

test('buildExportSnapshot 零自有几何：委托 createPlacement（c1-a 静态验收）', () => {
  const selfPath = fileURLToPath(import.meta.url).replace(/\.test\.js$/, '.js')
  const src = readFileSync(selfPath, 'utf8')
  // 仅匹配真正的几何自生成代码，不误伤注释里的「居中/旋转」等中文描述。
  for (const bad of ['Math.min(', 'scale = Math', 'calculateFit', 'calculateCentered', '.rotate(', 'fitScale']) {
    assert.ok(!src.includes(bad), `exportSnapshotBuilder.js 不应含几何自生成标记 "${bad}"`)
  }
})

test('Producer 同源：buildExportSnapshot ≡ buildSingleFileRenderCommand（同输入，无额外变换）', () => {
  const documentState = { pageSize: { w: 1240, h: 1754 }, pageNum: 2, sourceType: 'pdf' }
  const fileRotations = { k: 90 }
  const files = [{ key: 'k', path: '/p/x.pdf', status: 'parsed' }]
  const cmds = buildExportSnapshot({ files, documentState, fileRotations, previewPage: 2, settings: A4 })

  const expected = buildSingleFileRenderCommand({
    sourceWidth: 1240,
    sourceHeight: 1754,
    contentRect: computeContentRectAtDpi(A4, EXPORT_DPI),
    rotation: 90,
    paper: buildExportPaperSpec(A4),
    sourceRef: { path: '/p/x.pdf', page: 2 },
  })

  assert.deepEqual(cmds[0].placement, expected.placement)
  assert.deepEqual(cmds[0].rotatedBounds, expected.rotatedBounds)
  assert.equal(cmds[0].contentRotation, expected.contentRotation)
  assert.deepEqual(cmds[0].paper, expected.paper)
  assert.deepEqual(cmds[0].sourceRef, expected.sourceRef)
})

test('Preview producer ≡ Export producer：同输入 placement/rotatedBounds/contentRotation 一致（clip 刻意不同，不比）', () => {
  // 构造 @EXPORT_DPI 的 paperLayout（与 computeContentRectAtDpi 同一组边距→px），供 Preview producer 消费。
  const paperLayoutAt300 = {
    valid: true,
    paperRect: { w: 2480, h: 3508 },
    marginRect: { w: 2410, h: 3438 },
    contentRect: { w: 2410, h: 3438 },
    usableRect: { x: 35, y: 35, w: 2410, h: 3438 },
    displayRect: { w: 2480, h: 3508 },
    clipRect: { w: 2480, h: 3508 },
  }
  const documentState = { id: 'k', pageSize: { w: 1240, h: 1754 }, pageNum: 2, sourceType: 'pdf', contentRotation: 90 }

  const previewCmd = buildRenderCommand(paperLayoutAt300, documentState)
  const exportCmd = buildExportSnapshot({
    files: [{ key: 'k', path: '/p/x.pdf', status: 'parsed' }],
    documentState, fileRotations: { k: 90 }, previewPage: 2, settings: A4,
  })[0]

  assert.deepEqual(previewCmd.placement, exportCmd.placement)
  assert.deepEqual(previewCmd.rotatedBounds, exportCmd.rotatedBounds)
  assert.equal(previewCmd.contentRotation, exportCmd.contentRotation)
  // 物理纸张一致（A4）；字段形状故意不同（陷阱 B：Preview=PaperLayout / Export=PaperSpec）
  assert.equal(previewCmd.paper.paperRect.w, 2480)
  assert.equal(exportCmd.paper.widthMm, 210)
})
