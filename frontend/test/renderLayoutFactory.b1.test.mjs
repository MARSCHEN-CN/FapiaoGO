import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRenderCommand } from '../src/layout/RenderLayoutFactory.js'

// 构造最小 paperLayout（px@PREVIEW_DPI）。native 形状由 paperRect 决定；
// 不设置 valid 字段 → isPaperLayoutInvalid 视为「未就绪」豁免，可通过。
function makePaperLayout(nativeW, nativeH) {
  const paperRect = { w: nativeW, h: nativeH }
  const contentRect = { x: 0, y: 0, w: nativeW, h: nativeH }
  const usableRect = { x: 0, y: 0, w: nativeW, h: nativeH }
  const clipRect = { x: 0, y: 0, w: nativeW, h: nativeH }
  return { paperRect, contentRect, clipRect, usableRect }
}

function makeDocState(paperOrientation, pageSize) {
  return {
    paperOrientation, // 有效（请求）方向——基线契约字段
    pageSize, // {w,h} 内容内禀尺寸
    contentRotation: 0,
  }
}

// 4 组合矩阵：原生纸型 × 用户方向 → 期望 effPaperRect / usableRect 是否 swap
const CASES = [
  { name: '竖向纸型 + portrait  → 不 swap', native: [100, 200], req: 'portrait', swap: false },
  { name: '竖向纸型 + landscape → swap', native: [100, 200], req: 'landscape', swap: true },
  { name: '横向纸型 + portrait  → swap', native: [200, 100], req: 'portrait', swap: true },
  { name: '横向纸型 + landscape → 不 swap（本次真正抓出的 regression）', native: [200, 100], req: 'landscape', swap: false },
]

describe('RenderLayoutFactory B1: paper swap = needSwap(requested ≠ native)', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const pl = makePaperLayout(c.native[0], c.native[1])
      const ds = makeDocState(c.req, { w: c.native[0], h: c.native[1] })
      const cmd = buildRenderCommand(pl, ds)
      const expW = c.swap ? c.native[1] : c.native[0]
      const expH = c.swap ? c.native[0] : c.native[1]
      assert.equal(cmd.paperRect.w, expW, 'paperRect.w')
      assert.equal(cmd.paperRect.h, expH, 'paperRect.h')
      assert.equal(cmd.usableRect.w, expW, 'usableRect.w')
      assert.equal(cmd.usableRect.h, expH, 'usableRect.h')
      // 关键 regression：横向纸型选 landscape 必须保持横向 MediaBox
      if (c.req === 'landscape') {
        assert.ok(cmd.paperRect.w >= cmd.paperRect.h, 'landscape 请求必须产生横向 MediaBox')
      }
    })
  }
})
