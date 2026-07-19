/**
 * exportRenderCommand.test.js — D3-2 Export RenderCommand Producer 契约测试（node-safe）
 *
 * 锁：
 *  1. schema（paper 定义 / placement.scale 有限 / contentRotation number）
 *  2. placement 同构：相同几何输入 → Export producer === Preview producer（Preview≡Export）
 *  3. rotation 0/90/180/270：90/270 交换 width↔height（rotatedBounds）
 *  4. no leakage（scale 必为 createPlacement fit 输出；clip 恒等于 contentRect；无裸 dpi/fit 重算）
 *  5. 多票 buildExportRenderCommands 复用 createPlacement（clip===contentRect；缺源→null）
 *
 * 运行：node --test frontend/src/layout/exportRenderCommand.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildExportRenderCommand, buildExportRenderCommands } from './exportRenderCommand.js'
import { buildSingleFileRenderCommand } from './singleFileRenderCommand.js'

// 仅用于 shape 断言的占位 paper（不验证后端语义，D3-3 负责 transport）。
const paper = { width: 595, height: 842, dpi: 72 }

test('D3-2 schema: paper 定义 / scale 有限 / contentRotation number', () => {
  const cmd = buildExportRenderCommand({
    sourceWidth: 200, sourceHeight: 100,
    contentRect: { x: 0, y: 0, width: 400, height: 300 },
    rotation: 0, paper,
  })
  assert.notEqual(cmd.paper, undefined, 'paper 字段必须存在（透传，executor 用）')
  assert.equal(typeof cmd.placement.scale, 'number')
  assert.ok(Number.isFinite(cmd.placement.scale), 'scale 必须有限数（无 NaN/Infinity）')
  assert.equal(typeof cmd.contentRotation, 'number', 'contentRotation 必须为 number')
  assert.deepEqual(cmd.rotatedBounds, { width: 200, height: 100 })
  assert.deepEqual(cmd.clip, { x: 0, y: 0, width: 400, height: 300 })
})

test('D3-2 placement 同构: Export === Preview（相同几何输入）', () => {
  const input = {
    sourceWidth: 250, sourceHeight: 120,
    contentRect: { x: 10, y: 20, width: 500, height: 400 },
    rotation: 90, paper,
  }
  const preview = buildSingleFileRenderCommand(input)
  const exportCmd = buildExportRenderCommand(input)
  assert.deepEqual(exportCmd, preview, '相同几何输入 → 命令逐字段相等（Preview≡Export）')
})

test('D3-2 rotation 0/90/180/270: 90/270 交换 width↔height', () => {
  const base = {
    sourceWidth: 200, sourceHeight: 100,
    contentRect: { x: 0, y: 0, width: 400, height: 300 },
  }
  const r0 = buildExportRenderCommand({ ...base, rotation: 0 })
  const r90 = buildExportRenderCommand({ ...base, rotation: 90 })
  const r180 = buildExportRenderCommand({ ...base, rotation: 180 })
  const r270 = buildExportRenderCommand({ ...base, rotation: 270 })

  assert.deepEqual(r0.rotatedBounds, { width: 200, height: 100 }, '0°: 不换')
  assert.deepEqual(r90.rotatedBounds, { width: 100, height: 200 }, '90°: 宽高互换')
  assert.deepEqual(r180.rotatedBounds, { width: 200, height: 100 }, '180°: 不换')
  assert.deepEqual(r270.rotatedBounds, { width: 100, height: 200 }, '270°: 宽高互换')
  // 对称：90/270 同 scale，0/180 同 scale
  assert.equal(r90.placement.scale, r270.placement.scale)
  assert.equal(r0.placement.scale, r180.placement.scale)
  // contentRotation 原样透传
  assert.equal(r90.contentRotation, 90)
  assert.equal(r270.contentRotation, 270)
})

test('D3-2 no leakage: scale 来自 createPlacement fit；clip===contentRect；无裸几何', () => {
  const cmd = buildExportRenderCommand({
    sourceWidth: 800, sourceHeight: 600,
    contentRect: { x: 0, y: 0, width: 400, height: 300 },
    rotation: 0,
  })
  // fit = min(400/800, 300/600) = min(0.5, 0.5) = 0.5 —— 由 createPlacement 计算，非本文件重算。
  assert.equal(cmd.placement.scale, 0.5, 'scale 必须是 contentRect 拟合值')
  assert.deepEqual(cmd.clip, { x: 0, y: 0, width: 400, height: 300 }, 'clip 必须锁 contentRect')
  assert.equal(cmd.rotation, 0, 'rotation 兼容字段恒 0（无 ctx.rotate 自行推导）')
  assert.equal(cmd.placement.offsetX, 0, 'offset 由 createPlacement 中心式产出，不在此重算')
})

test('D3-2 multi: buildExportRenderCommands 复用 createPlacement（clip===contentRect；缺源→null）', () => {
  const slots = [
    { itemId: 'a', contentRect: { x: 0, y: 0, width: 400, height: 300 } },
    { itemId: 'b', contentRect: { x: 400, y: 0, width: 400, height: 300 } },
  ]
  const contentSources = new Map([
    ['a', { width: 200, height: 100 }],
    ['b', { width: 200, height: 100 }],
  ])
  const rotations = { a: 0, b: 90 }
  const cmds = buildExportRenderCommands({ slots, contentSources, rotations, paper })
  assert.equal(cmds.length, 2)
  assert.ok(cmds[0] && cmds[0].clip && cmds[0].clip.width === 400, 'slot a clip===contentRect')
  assert.deepEqual(cmds[1].rotatedBounds, { width: 100, height: 200 }, 'slot b 旋转 90° 宽高互换')
  assert.equal(cmds[1].placement.scale, 1.5, 'slot b fit = min(400/100, 300/200) = 1.5')

  // 缺内容源 → null（与 _buildComposeCommand 一致）
  const cmds2 = buildExportRenderCommands({
    slots: [{ itemId: 'x', contentRect: { x: 0, y: 0, width: 10, height: 10 } }],
    contentSources: new Map(), rotations: {}, paper,
  })
  assert.equal(cmds2[0], null)
})
