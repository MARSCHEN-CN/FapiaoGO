/**
 * singleFileRenderCommand.test.js — D1-1 contract 护栏（node-safe，不依赖 config / renderers）
 *
 * 锁定 buildSingleFileRenderCommand 产出与 compose / print 同形状的 RenderCommand，
 * 并锁定几何 ownership：单文件预览 producer 只消费 contentRect，绝不用裸 margin / dpi / slot 重算几何。
 *
 * 手工构造 contentRect + source 尺寸（不依赖 createLayout / config.js），与 mergeFactory.test.js 同思路。
 *
 * 不变量：单文件预览是 Preview 侧最后一块未接入 RenderCommand 的路径（D0 已定位）。
 * 本测试证明 D1-1 产出的命令与已接线的 _buildComposeCommand / mergeFactory 共用同一套
 * createPlacement → RenderCommand 契约，为 D1-2 切换执行点铺平（Preview≡Export≡Print）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildSingleFileRenderCommand } from './singleFileRenderCommand.js'
import { createPlacement } from '../compose/composePlacement.js'

// ── 极简 RenderCommand 契约断言（镜像 renderDraw.validateRenderCommand 的同款校验，
//    但内联以避免 import RenderLayoutFactory → layout.js → config.js 使测试不可纯 node 跑）──
function assertRenderCommandContract(cmd, paper) {
  assert.equal(cmd.version, 1, 'version 必须为 1')
  assert.ok(cmd.placement && typeof cmd.placement === 'object', 'placement 必存在')
  for (const k of ['scale', 'offsetX', 'offsetY']) {
    const v = cmd.placement[k]
    assert.ok(typeof v === 'number' && Number.isFinite(v), `placement.${k} 必须为有限数，得到 ${v}`)
  }
  assert.ok(
    cmd.rotatedBounds &&
    typeof cmd.rotatedBounds.width === 'number' &&
    typeof cmd.rotatedBounds.height === 'number' &&
    cmd.rotatedBounds.width > 0 &&
    cmd.rotatedBounds.height > 0,
    `rotatedBounds 必须为正，得到 ${JSON.stringify(cmd.rotatedBounds)}`
  )
  assert.equal(typeof cmd.contentRotation, 'number', 'contentRotation 必须为 number')
  assert.ok(cmd.paper || paper, 'paper 必填（Renderer 需要 PaperLayout 上下文）')
}

// ── Oracle：冻结「fit 进 contentRect」的居中数学（与 createPlacement 逐字同源）──
function oracleRect(rect, contentW, contentH, rotate) {
  const isRotated90 = rotate === 90 || rotate === 270
  const effectiveW = isRotated90 ? contentH : contentW
  const effectiveH = isRotated90 ? contentW : contentH
  const scale = Math.min(rect.width / effectiveW, rect.height / effectiveH)
  const rotatedBounds = isRotated90
    ? { width: contentH, height: contentW }
    : { width: contentW, height: contentH }
  const drawW = rotatedBounds.width * scale
  const drawH = rotatedBounds.height * scale
  const offsetX = rect.x + (rect.width - drawW) / 2
  const offsetY = rect.y + (rect.height - drawH) / 2
  return { scale, rotatedBounds, offsetX, offsetY }
}

function assertClose(a, b, msg, eps = 1e-6) {
  assert.ok(Math.abs(a - b) <= eps, `${msg}: 期望 ${b}, 得到 ${a}`)
}

const PAPER = { width: 1000, height: 1400 }

// ── Golden：0° 单文件页 fit 进 contentRect，clip===contentRect ──
test('single-file 0°: fit 进 contentRect，clip===contentRect，通过 executor 契约', () => {
  const contentRect = { x: 40, y: 40, width: 920, height: 1320 }
  const cmd = buildSingleFileRenderCommand({
    sourceWidth: 600, sourceHeight: 800, contentRect, rotation: 0, paper: PAPER,
  })
  const exp = oracleRect(contentRect, 600, 800, 0)
  assert.deepEqual(cmd.rotatedBounds, exp.rotatedBounds)
  assertClose(cmd.placement.scale, exp.scale, 'scale')
  assertClose(cmd.placement.offsetX, exp.offsetX, 'offsetX')
  assertClose(cmd.placement.offsetY, exp.offsetY, 'offsetY')
  assert.equal(cmd.contentRotation, 0)
  assert.deepEqual(cmd.clip, contentRect, 'clip 必须 === contentRect（几何边界，不泄漏 margin）')
  assertRenderCommandContract(cmd, PAPER)
})

// ── Golden：90° 交换 rotatedBounds 且 fit 重算 ──
test('single-file 90°: 交换 rotatedBounds，fit 基于旋转后包围盒', () => {
  const contentRect = { x: 40, y: 40, width: 920, height: 1320 }
  const cmd = buildSingleFileRenderCommand({
    sourceWidth: 600, sourceHeight: 800, contentRect, rotation: 90, paper: PAPER,
  })
  const exp = oracleRect(contentRect, 600, 800, 90)
  assert.equal(cmd.rotatedBounds.width, 800, 'rotatedBounds 必须交换 w/h')
  assert.equal(cmd.rotatedBounds.height, 600)
  assertClose(cmd.placement.scale, exp.scale, 'scale')
  assertClose(cmd.placement.offsetX, exp.offsetX, 'offsetX')
  assertClose(cmd.placement.offsetY, exp.offsetY, 'offsetY')
  assert.equal(cmd.contentRotation, 90)
  assert.deepEqual(cmd.clip, contentRect, 'clip === contentRect')
})

// ── Golden：180° / 270° 同样受 createPlacement 统一处理 ──
test('single-file 180°/270°: rotatedBounds 与 contentRotation 一致', () => {
  const contentRect = { x: 10, y: 10, width: 980, height: 1380 }
  for (const rotate of [180, 270]) {
    const cmd = buildSingleFileRenderCommand({
      sourceWidth: 600, sourceHeight: 800, contentRect, rotation: rotate, paper: PAPER,
    })
    const exp = oracleRect(contentRect, 600, 800, rotate)
    assert.deepEqual(cmd.rotatedBounds, exp.rotatedBounds, `${rotate}°: rotatedBounds`)
    assertClose(cmd.placement.scale, exp.scale, `${rotate}°.scale`)
    assertClose(cmd.placement.offsetX, exp.offsetX, `${rotate}°.offsetX`)
    assertClose(cmd.placement.offsetY, exp.offsetY, `${rotate}°.offsetY`)
    assert.equal(cmd.contentRotation, rotate)
  }
})

// ── D1 同构锁：producer 必须是 createPlacement 的薄封装，不引入额外几何 ──
test('D1 同构锁: 单文件命令与 createPlacement 直组命令逐字段相等', () => {
  const contentRect = { x: 40, y: 40, width: 920, height: 1320 }
  const viaProducer = buildSingleFileRenderCommand({
    sourceWidth: 600, sourceHeight: 800, contentRect, rotation: 90, paper: PAPER,
  })
  const p = createPlacement({ contentRect, sourceWidth: 600, sourceHeight: 800, rotation: 90 })
  const viaCreatePlacement = {
    version: 1,
    paper: PAPER,
    rotatedBounds: p.rotatedBounds,
    placement: { scale: p.scale, offsetX: p.offsetX, offsetY: p.offsetY },
    contentRotation: 90,
    rotation: 0,
    clip: p.clip,
    sourceRef: null,
  }
  assert.deepEqual(viaProducer, viaCreatePlacement, 'producer 必须等价于 createPlacement 直组（无额外几何推导）')
})

// ── Ownership 锁：fit 严格不溢出几何边界（drawW<=contentRect.width, drawH<=contentRect.height）──
test('ownership lock: 绘制尺寸永不溢出 contentRect（无 Renderer 几何泄漏）', () => {
  const contentRect = { x: 40, y: 40, width: 920, height: 1320 }
  for (const rotate of [0, 90, 180, 270]) {
    const cmd = buildSingleFileRenderCommand({
      sourceWidth: 600, sourceHeight: 800, contentRect, rotation: rotate, paper: PAPER,
    })
    const drawW = cmd.rotatedBounds.width * cmd.placement.scale
    const drawH = cmd.rotatedBounds.height * cmd.placement.scale
    assert.ok(drawW <= contentRect.width + 1e-6, `${rotate}°: drawW 不溢出 contentRect.width`)
    assert.ok(drawH <= contentRect.height + 1e-6, `${rotate}°: drawH 不溢出 contentRect.height`)
  }
})

// ── 未就绪态：contentRect 坍缩 → empty 命令（scale=0），executor 会跳过 ──
test('未就绪态: contentRect 坍缩返回 scale=0 的 empty 命令', () => {
  const cmd = buildSingleFileRenderCommand({
    sourceWidth: 600, sourceHeight: 800, contentRect: { x: 0, y: 0, width: 0, height: 0 },
    rotation: 0, paper: PAPER,
  })
  assert.equal(cmd.placement.scale, 0, '坍缩 → scale=0')
  assert.equal(cmd.rotatedBounds.width, 0)
  // 注意：rotatedBounds 非正 → 真实 executor 的 validateRenderCommand 会拦截；此处仅验证 producer 不抛。
})
