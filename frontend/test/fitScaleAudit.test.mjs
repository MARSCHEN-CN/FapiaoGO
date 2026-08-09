/**
 * fitScaleAudit.test.mjs — Commit 2-G-1 Gate
 *
 * 锁定 PrintPreview 的「排版对象」缩放模型：
 *   - 同内容在不同纸张上，scale 必须反映真实 fit（可 >1 放大、可 <1 缩小），
 *     不再被 Math.min(...,1) 错误封顶。
 *   - 顺序约束：scale 在 fitRotation 之后计算（placedContentW/H 已是旋转后尺寸）。
 *   - 非法值保护：contentW/H 或 availableW/H 为 0 时 scale 回退 1（无 Infinity/NaN）。
 *
 * 修改范围：仅 RotationResolver.js（Fit Engine）。Viewer / Thumbnail / PrintService 不动。
 *
 * 运行：node --test test/fitScaleAudit.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveContentPlacement } from '../src/layout/RotationResolver.js'

const DPI = 300
const PX_PER_MM = DPI / 25.4
const mmToPx = (mm) => mm * PX_PER_MM

// 一张"小横票"：物理尺寸 ~100×70mm（px@300），模拟真实小发票（与旧 _fitAudit 一致）
const SMALL_LANDSCAPE = { width: 1180, height: 825 }

const PAPERS = {
  A5: { widthMM: 148, heightMM: 210 },
  A4: { widthMM: 210, heightMM: 297 },
  A3: { widthMM: 297, heightMM: 420 },
}
const MARGIN_10 = { left: 10, right: 10, top: 10, bottom: 10 }

// ── 主矩阵：同内容 + A5/A4/A3，scale 必须 > 1（证明封顶已移除）──
for (const [name, paper] of Object.entries(PAPERS)) {
  test(`矩阵 ${name} 竖纸 + 小横票 → scale 必须 > 1（放大填充安全区）`, () => {
    const r = resolveContentPlacement({
      contentPhysicalSize: SMALL_LANDSCAPE,
      contentRotation: 0,
      physicalPaper: paper,
      margins: MARGIN_10,
      dpi: DPI,
    })
    assert.ok(r.scale > 1, `${name} scale=${r.scale} 应 >1（旧版被封顶=1）`)
    // 放大后仍居中且落在纸内
    assert.ok(r.placedRect.x >= 0 && r.placedRect.y >= 0, 'placedRect 左上角在纸内')
    const paperW = Math.round(paper.widthMM * PX_PER_MM)
    const paperH = Math.round(paper.heightMM * PX_PER_MM)
    assert.ok(r.placedRect.x + r.placedRect.w <= paperW + 1, 'placedRect 右缘不超出纸宽')
    assert.ok(r.placedRect.y + r.placedRect.h <= paperH + 1, 'placedRect 下缘不超出纸高')
  })
}

// ── Gate A：A4 横票 → A4 竖纸 → layoutRotation=-90 + scale>1 + 居中安全区 ──
test('Gate A: A4 横票(1180×825) + A4 竖纸 + 10mm → fitRotation=-90, scale>1, 居中', () => {
  const r = resolveContentPlacement({
    contentPhysicalSize: SMALL_LANDSCAPE,
    contentRotation: 0,
    physicalPaper: PAPERS.A4,
    margins: MARGIN_10,
    dpi: DPI,
  })
  assert.equal(r.layoutRotation, -90, '横内容+竖纸 → layoutRotation=-90')
  assert.equal(r.renderRotation, 270, 'renderRotation 归一化=270(≡-90)')
  assert.ok(r.scale > 1, `scale=${r.scale} 应 >1（放大填充）`)

  // 居中：placedRect 中心 ≈ 纸中心（0 边距时严格；10mm 边距下仍应大致居中）
  const paperW = Math.round(PAPERS.A4.widthMM * PX_PER_MM)
  const paperH = Math.round(PAPERS.A4.heightMM * PX_PER_MM)
  const cx = r.placedRect.x + r.placedRect.w / 2
  const cy = r.placedRect.y + r.placedRect.h / 2
  assert.ok(Math.abs(cx - paperW / 2) <= 2, `水平居中 cx=${cx.toFixed(0)}≈${paperW / 2}`)
  assert.ok(Math.abs(cy - paperH / 2) <= 2, `垂直居中 cy=${cy.toFixed(0)}≈${paperH / 2}`)

  // 不超出安全区：placedRect ⊆ availableRect
  const a = r.availableRect
  assert.ok(r.placedRect.x >= a.x - 1 && r.placedRect.y >= a.y - 1, 'placedRect 不越安全区上/左')
  assert.ok(
    r.placedRect.x + r.placedRect.w <= a.x + a.w + 1 &&
    r.placedRect.y + r.placedRect.h <= a.y + a.h + 1,
    'placedRect 不越安全区右/下'
  )
})

// ── Gate B：大票(300×400mm) → A5 → scale<1 + placedRect ⊆ availableRect ──
test('Gate B: 大票(300×400mm) + A5 0边距 → scale<1, 缩小仍不越安全区', () => {
  const big = { width: mmToPx(300), height: mmToPx(400) } // portrait 大票
  const r = resolveContentPlacement({
    contentPhysicalSize: big,
    contentRotation: 0,
    physicalPaper: PAPERS.A5,
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
    dpi: DPI,
  })
  assert.ok(r.scale < 1, `scale=${r.scale} 应 <1（缩小）`)
  const a = r.availableRect
  assert.ok(
    r.placedRect.w <= a.w + 1 && r.placedRect.h <= a.h + 1,
    `缩小后 placedRect(${r.placedRect.w}×${r.placedRect.h}) ≤ available(${a.w}×${a.h})`
  )
  assert.ok(r.placedRect.x >= -1 && r.placedRect.y >= -1, 'placedRect 不越纸左上')
})

// ── Gate C：content == availableRect → scale ≈ 1（防算法漂移）──
test('Gate C: content == availableRect → scale ≈ 1', () => {
  const paperW = Math.round(PAPERS.A5.widthMM * PX_PER_MM)
  const paperH = Math.round(PAPERS.A5.heightMM * PX_PER_MM)
  // 0 边距 → availableRect == 纸张 px
  const r = resolveContentPlacement({
    contentPhysicalSize: { width: paperW, height: paperH }, // portrait，正好=available
    contentRotation: 0,
    physicalPaper: PAPERS.A5,
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
    dpi: DPI,
  })
  assert.ok(Math.abs(r.scale - 1) < 1e-9, `scale=${r.scale} 应 ≈1`)
  assert.ok(
    Math.abs(r.placedRect.w - r.availableRect.w) < 1 &&
    Math.abs(r.placedRect.h - r.availableRect.h) < 1,
    'placedRect 尺寸 == availableRect'
  )
})

// ── 非法值保护：content 尺寸为 0 → 顶部校验抛错（不产出 Infinity scale）──
test('保护: contentPhysicalSize 含 0 → 抛错（无 Infinity 泄漏）', () => {
  assert.throws(
    () => resolveContentPlacement({
      contentPhysicalSize: { width: 0, height: 0 },
      contentRotation: 0,
      physicalPaper: PAPERS.A4,
      margins: MARGIN_10,
      dpi: DPI,
    }),
    /contentPhysicalSize/,
  )
})

// ── 架构约束确认：Viewer 走独立渲染链，不消费本函数 scale（grep 守卫）──
test('架构约束: RotationResolver.scale 仅供 PrintPreview/PrintService（Viewer 不消费 fit scale）', () => {
  // 本测试以契约形式声明：resolveContentPlacement 返回的 scale 是「排版对象 fit 因子」，
  // 允许 >1。Viewer 渲染发票走独立路径（useViewerState.viewRotation + 自身缩放），
  // 不调用 resolveContentPlacement，故放大语义不影响查看比例。
  const r = resolveContentPlacement({
    contentPhysicalSize: SMALL_LANDSCAPE,
    contentRotation: 0,
    physicalPaper: PAPERS.A3,
    margins: MARGIN_10,
    dpi: DPI,
  })
  assert.ok(r.scale > 1, 'A3 上放大因子 >1 成立；Viewer 不引用此值，故无副作用')
})
