/**
 * gate4Regression.test.mjs — Gate 4.3 Regression Matrix（回归护栏实现）
 *
 * 运行方式（必须带 env-shim loader，原因见下）：
 *   node --loader ./test/printGate/env-shim.loader.mjs --test frontend/test/printGate/gate4Regression.test.mjs
 *
 * 为什么需要 loader：前端 src/config.js 使用 `import.meta.env`（Vite 注入），plain Node 下
 * 为 undefined，导致 `import.meta.env.BASE_URL` 抛 TypeError。Path A 生产者
 * (MultiTicketComposer → RenderLayoutFactory → previewState → config) 必然拉入 config.js，
 * 故必须以 loader 将 `import.meta.env` 中性替换为 `({})` 才能加载。本项目
 * src/layout/renderLayoutFactorySlot.test.js 已确认此技术债（"config.js 依赖 import.meta.env，需 shim"）。
 * loader 仅作用于测试加载期，不修改任何生产源码。
 *
 * 设计纪律（来自 R1 + PPC 封存）：
 *   • 仅测试，不改 production source。
 *   • 不触碰 rotation ownership / RotationResolver / effectiveRotation 定义 / OFD 路径 /
 *     VirtualPrintSource / mergeFactory 实现。
 *   • Path B divergence 仅以「architecture sentinel」观察，不统一、不修复、不迁移。
 *
 * 覆盖（来自 docs/gate4-regression-matrix.md）：
 *   Layer A — RenderCommand contentRotation 双路径保真（A1-A4 / B1-B4 + B-10a + Path B snap）
 *   Layer B — Slot Geometry（G1 精确分区 / G2 rotation 解耦 / G3 clip 锁 / orientation）
 *   Layer C — Format Independence（PDF/Image/OFD label → 同一 RenderCommand，不实现 OFD）
 *   §7      — Path B 观察性 Guard（guardPathBSourceInvariant / guardPathBDivergenceWatch）
 *   §8      — rotation-once 不变量（R1 / R2 / R3）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { composePlans } from '../../src/layout/MultiTicketComposer.js'
import { computeSlots, slotToLandscape } from '../../src/layout/SlotLayout.js'
import { buildMergeRenderCommands } from '../../src/layout/mergeFactory.js'
import { validateRenderCommand, normalizeRotation } from '../../src/layout/RenderLayoutFactory.js'
import { drawRenderCommand } from '../../src/layout/renderDraw.js'
import { createPlacement } from '../../src/compose/composePlacement.js'

const MF_SRC = readFileSync(
  fileURLToPath(new URL('../../src/layout/mergeFactory.js', import.meta.url)),
  'utf8'
)

// ── 固定 Fixture ───────────────────────────────────────────────
// A4 @ 300dpi（portrait 自然空间）。usableRect = 全页，slotMarginPx = 0（专测分区公式）。
const PAGE_W = 2480
const PAGE_H = 3508

function makePaperLayout({ w = PAGE_W, h = PAGE_H, slotMarginPx = 0 } = {}) {
  const rect = { x: 0, y: 0, w, h }
  return {
    valid: true,
    paperRect: { w, h },
    usableRect: { ...rect },
    contentRect: { ...rect },
    clipRect: { ...rect },
    slotMarginPx,
  }
}

function makePlan({ effectiveRotation = 0, natW = 1240, natH = 1754, orientation = 'portrait', docId = 'd1', pageId = 1 }) {
  return {
    documentState: { pageSize: { w: natW, h: natH }, pageOrientation: orientation },
    printGeometry: { effectiveRotation },
    source: { docId, pageId },
  }
}

// Path B layout fixture：page/area 全页，slots 为给定 contentRect。
function makeMergeLayout(slots) {
  return {
    page: { width: PAGE_W, height: PAGE_H },
    area: { x: 0, y: 0, width: PAGE_W, height: PAGE_H },
    slots: slots.map((s) => ({
      itemId: s.itemId,
      contentRect: { ...s.contentRect },
      x: s.contentRect.x,
      y: s.contentRect.y,
      width: s.contentRect.width,
      height: s.contentRect.height,
    })),
  }
}

// 期望分区（来自 docs §5.1，冻结公式产物）
const EXPECT = {
  none: [{ x: 0, y: 0, width: PAGE_W, height: PAGE_H }],
  merge2: [
    { x: 0, y: 0, width: PAGE_W, height: 1754 },
    { x: 0, y: 1754, width: PAGE_W, height: 1754 },
  ],
  merge4: [
    { x: 0, y: 0, width: 1240, height: 1754 },
    { x: 1240, y: 0, width: 1240, height: 1754 },
    { x: 0, y: 1754, width: 1240, height: 1754 },
    { x: 1240, y: 1754, width: 1240, height: 1754 },
  ],
}

function assertValidContract(cmd, label) {
  assert.doesNotThrow(() => validateRenderCommand(cmd), `validateRenderCommand must pass (${label})`)
  assert.strictEqual(cmd.version, 1, `${label}: version===1`)
  assert.strictEqual(typeof cmd.contentRotation, 'number', `${label}: contentRotation is number`)
  for (const k of ['scale', 'offsetX', 'offsetY']) {
    assert.ok(Number.isFinite(cmd.placement[k]), `${label}: placement.${k} finite`)
  }
  assert.ok(cmd.rotatedBounds.width > 0 && cmd.rotatedBounds.height > 0, `${label}: rotatedBounds > 0`)
}

// ── Layer A — RenderCommand Contract（双路径 contentRotation 保真） ──

test('Layer A / Path A: contentRotation preservation (0/90/180/270) [A1-A4]', () => {
  const paper = makePaperLayout()
  for (const r of [0, 90, 180, 270]) {
    const out = composePlans({ paperLayout: paper, plans: [makePlan({ effectiveRotation: r })], ticketCount: 1 })
    const cmd = out[0].renderCommand
    assertValidContract(cmd, `PathA rot=${r}`)
    assert.strictEqual(cmd.contentRotation, r, `Path A: contentRotation must === effectiveRotation (${r})`)
  }
})

test('Layer A / Path A: B-10a no second resolver (identity passthrough)', () => {
  // buildRenderCommand 收到 printGeometry 时直接赋值，不二次 normalize。
  const paper = makePaperLayout()
  const out = composePlans({ paperLayout: paper, plans: [makePlan({ effectiveRotation: 90 })], ticketCount: 1 })
  const cmd = out[0].renderCommand
  // 引用同一 canonical 值（直接赋值），证明无重新计算 / 无第二 resolver。
  assert.strictEqual(cmd.contentRotation, 90)
  assert.strictEqual(cmd.contentRotation, makePlan({ effectiveRotation: 90 }).printGeometry.effectiveRotation)
})

test('Layer A / Path B: contentRotation preservation (0/90/180/270) [B1-B4]', () => {
  const layout = makeMergeLayout([{ itemId: 'id1', contentRect: { x: 0, y: 0, width: PAGE_W, height: PAGE_H } }])
  const meta = new Map([['id1', { width: 1240, height: 1754 }]])
  for (const r of [0, 90, 180, 270]) {
    const cmds = buildMergeRenderCommands(layout, meta, { id1: r }, { isLandscape: false })
    const cmd = cmds[0]
    assertValidContract(cmd, `PathB rot=${r}`)
    assert.strictEqual(cmd.contentRotation, r, `Path B: contentRotation must === normalizeRotation(rotations[id]) (${r})`)
  }
})

test('Layer A / Path B: snap semantics (non-canonical 45 → 90)', () => {
  // Path B 对原始 rotations[id] 做一次 snap（非对已旋转 RenderCommand 的二次旋转）。
  const layout = makeMergeLayout([{ itemId: 'id1', contentRect: { x: 0, y: 0, width: PAGE_W, height: PAGE_H } }])
  const meta = new Map([['id1', { width: 1240, height: 1754 }]])
  const cmds = buildMergeRenderCommands(layout, meta, { id1: 45 }, { isLandscape: false })
  assert.strictEqual(cmds[0].contentRotation, normalizeRotation(45), 'Path B: 45 → snap 90')
})

// ── Layer B — Slot Geometry Contract ──

test('Layer B G1: merge none/2/4 exact slot rects (portrait, frozen partition formula)', () => {
  const paper = makePaperLayout()
  const none = computeSlots(paper, { count: 1, strategy: 'vertical' })
  assert.strictEqual(none.length, 1)
  assert.deepEqual(none[0].contentRect, EXPECT.none[0])

  const m2 = computeSlots(paper, { count: 2, strategy: 'vertical' })
  assert.strictEqual(m2.length, 2)
  m2.forEach((s, i) => assert.deepEqual(s.contentRect, EXPECT.merge2[i], `merge2 slot[${i}]`))

  const m4 = computeSlots(paper, { count: 4, strategy: 'grid', gridCols: 2, gridRows: 2 })
  assert.strictEqual(m4.length, 4)
  m4.forEach((s, i) => assert.deepEqual(s.contentRect, EXPECT.merge4[i], `merge4 slot[${i}]`))
})

test('Layer B G2: slot geometry invariant to rotation (0/90/180/270 produce identical slot)', () => {
  // slot 几何与 rotation 输入解耦：composer 不改变 slot 以施加旋转。
  const paper = makePaperLayout()
  for (const cfg of [
    { count: 2, strategy: 'vertical' },
    { count: 4, strategy: 'grid', gridCols: 2, gridRows: 2 },
  ]) {
    const baseSlots = computeSlots(paper, cfg)
    // 用不同 rotation 跑 producer，断言 RenderCommand.clip（=slot.contentRect）保持不变。
    const plans = baseSlots.map((_, i) => makePlan({ effectiveRotation: 0, docId: `d${i}` }))
    const cmds0 = composePlans({ paperLayout: paper, plans, ticketCount: cfg.count, strategy: cfg.strategy, gridCols: cfg.gridCols, gridRows: cfg.gridRows })
    const cmds90 = composePlans({ paperLayout: paper, plans: plans.map((p) => makePlan({ effectiveRotation: 90, docId: p.source.docId })), ticketCount: cfg.count, strategy: cfg.strategy, gridCols: cfg.gridCols, gridRows: cfg.gridRows })
    cmds0.forEach(({ renderCommand: c0 }, i) => {
      assert.deepEqual(c0.clip, cmds90[i].renderCommand.clip, `G2: clip (slot) identical across rotation, cfg=${cfg.strategy} slot[${i}]`)
    })
  }
})

test('Layer B G3: clip === slot.contentRect (Path A + Path B ownership lock)', () => {
  const paper = makePaperLayout()

  // Path A
  const aSlots = computeSlots(paper, { count: 2, strategy: 'vertical' })
  const aOut = composePlans({ paperLayout: paper, plans: [makePlan({ docId: 'd0' }), makePlan({ docId: 'd1' })], ticketCount: 2 })
  aOut.forEach(({ renderCommand: cmd }, i) => {
    assert.deepEqual(cmd.clip, aSlots[i].contentRect, `Path A G3: clip === slot.contentRect[${i}]`)
  })

  // Path B
  const layout = makeMergeLayout([
    { itemId: 'id0', contentRect: EXPECT.merge2[0] },
    { itemId: 'id1', contentRect: EXPECT.merge2[1] },
  ])
  const meta = new Map([['id0', { width: 1240, height: 1754 }], ['id1', { width: 1240, height: 1754 }]])
  const bCmds = buildMergeRenderCommands(layout, meta, { id0: 0, id1: 0 }, { isLandscape: false })
  bCmds.forEach((cmd, i) => {
    assert.deepEqual(cmd.clip, layout.slots[i].contentRect, `Path B G3: clip === slot.contentRect[${i}]`)
  })
})

test('Layer B orientation: portrait vs landscape (paperLandscape flag + slotToLandscape + effPaperRect swap)', () => {
  const paper = makePaperLayout() // 自然空间 portrait

  // portrait
  const pOut = composePlans({ paperLayout: paper, plans: [makePlan({ orientation: 'portrait' })], ticketCount: 1 })
  const pCmd = pOut[0].renderCommand
  assert.strictEqual(pCmd.paperLandscape, false, 'portrait: paperLandscape false')
  assert.deepEqual(pCmd.paperRect, { w: PAGE_W, h: PAGE_H }, 'portrait: effPaperRect unswapped')
  assert.deepEqual(pCmd.clip, { x: 0, y: 0, width: PAGE_W, height: PAGE_H }, 'portrait: clip in natural coords')

  // landscape：pageOrientation='landscape'（自然纸仍 portrait，由 buildRenderCommand 做轴交换）
  const lOut = composePlans({ paperLayout: paper, plans: [makePlan({ orientation: 'landscape' })], ticketCount: 1 })
  const lCmd = lOut[0].renderCommand
  assert.strictEqual(lCmd.paperLandscape, true, 'landscape: paperLandscape true')
  assert.deepEqual(lCmd.paperRect, { w: PAGE_H, h: PAGE_W }, 'landscape: effPaperRect swapped')
  const slot = computeSlots(paper, { count: 1, strategy: 'vertical' })[0].contentRect
  assert.deepEqual(lCmd.clip, slotToLandscape(slot, { mL: 0, mT: 0 }), 'landscape: clip follows slotToLandscape')

  // Path B orientation flag
  const layout = makeMergeLayout([{ itemId: 'id1', contentRect: { x: 0, y: 0, width: PAGE_W, height: PAGE_H } }])
  const meta = new Map([['id1', { width: 1240, height: 1754 }]])
  const bLand = buildMergeRenderCommands(layout, meta, { id1: 0 }, { isLandscape: true })[0]
  assert.strictEqual(bLand.paperLandscape, true, 'Path B landscape: paperLandscape true')
})

// ── Layer C — Format Independence（PPC 边界，不进入实现） ──

test('Layer C: producer format-blind (PDF/Image/OFD label → identical RenderCommand)', () => {
  // 三个 contentMeta 仅来源标签不同（pdf/image/ofd），像素尺寸 + 旋转完全一致。
  const layout = makeMergeLayout([{ itemId: 'id1', contentRect: { x: 0, y: 0, width: PAGE_W, height: PAGE_H } }])
  const dims = { width: 1240, height: 1754 }
  const metaPdf = new Map([['id1', { ...dims, type: 'pdf' }]])
  const metaImage = new Map([['id1', { ...dims, type: 'image' }]])
  const metaOfd = new Map([['id1', { ...dims, type: 'ofd' }]]) // label only，绝不引入真实 OFD renderer

  const cmdPdf = buildMergeRenderCommands(layout, metaPdf, { id1: 90 }, { isLandscape: false })[0]
  const cmdImage = buildMergeRenderCommands(layout, metaImage, { id1: 90 }, { isLandscape: false })[0]
  const cmdOfd = buildMergeRenderCommands(layout, metaOfd, { id1: 90 }, { isLandscape: false })[0]

  assert.deepEqual(cmdPdf, cmdImage, 'PDF === Image (same geometry+rotation)')
  assert.deepEqual(cmdImage, cmdOfd, 'Image === OFD-label (same geometry+rotation)')
})

test('Layer C static: mergeFactory has zero source-format branch', () => {
  // 禁止 2：composer 不得读取 source format。
  assert.ok(
    !/if\s*\(\s*(pdf|ofd|image)/i.test(MF_SRC),
    'mergeFactory must not branch on `if (pdf|ofd|image)` — composer is format-blind'
  )
  assert.ok(
    !/file\.type|source\.format|\.rotate\b|exif/i.test(MF_SRC),
    'mergeFactory must not reference file.type / source.format / .rotate / exif'
  )
})

// ── §7 Path B Guard（architecture sentinel，非 regression failure） ──

test('guardPathBSourceInvariant (architecture sentinel)', () => {
  // PASS = Path B 保持当前冻结状态（contentRotation 仅来自原始用户旋转）。
  // FAIL = Path B rotation source 被改变（需 Future Rotation Semantic Migration 审查）。
  const layout = makeMergeLayout([{ itemId: 'id1', contentRect: { x: 0, y: 0, width: PAGE_W, height: PAGE_H } }])
  const meta = new Map([['id1', { width: 1240, height: 1754 }]])
  const cmd = buildMergeRenderCommands(layout, meta, { id1: 90 }, { isLandscape: false })[0]
  if (cmd.contentRotation !== normalizeRotation(90)) {
    throw new Error('⚠ Architecture Watch: PathB rotation source changed. This requires Future Rotation Semantic Migration review.')
  }
  // 静态：Path B 调用图不得引用 effectiveRotation resolver（否则 double-normalize 风险）。
  if (/\beffectiveRotation\b/.test(MF_SRC) || /PrintGeometryBuilder|PrintAutoRotationPolicy/.test(MF_SRC)) {
    throw new Error('⚠ Architecture Watch: PathB now references an effectiveRotation resolver. This requires Future Rotation Semantic Migration review.')
  }
  // 行为：contentRotation 必须恰好 = normalizeRotation(rotations[id])（一次 snap，非二次旋转）。
  const rotations = { id1: 90 }
  const cmd2 = buildMergeRenderCommands(layout, meta, rotations, { isLandscape: false })[0]
  if (cmd2.contentRotation !== normalizeRotation(rotations.id1)) {
    throw new Error('⚠ Architecture Watch: PathB contentRotation != normalizeRotation(rotations[id]). This requires Future Rotation Semantic Migration review.')
  }
  console.log('ℹ guardPathBSourceInvariant: PASS (Path B frozen state intact)')
})

test('guardPathBDivergenceWatch (architecture sentinel)', () => {
  // 负面检测器：若有人把 rotations[id] 偷偷改成 effectiveRotation（= normalize(autoRotation+userRotation)）
  // 再喂给 normalizeRotation，则 autoRotation≠0 时 double-normalize，本 sentinel 必须响铃。
  // 当前：Path B 不引用任何 effectiveRotation resolver → 通过。
  if (/\beffectiveRotation\b/.test(MF_SRC) || /PrintGeometryBuilder|PrintAutoRotationPolicy/.test(MF_SRC)) {
    throw new Error('⚠ Architecture Watch: PathB divergence — rotation source now derives from an effectiveRotation resolver. This requires Future Rotation Semantic Migration review.')
  }
  // 若未来出现 `effectiveRotation`-style 来源，其值必须等于「仅用户旋转」语义，否则即越界。
  const layout = makeMergeLayout([{ itemId: 'id1', contentRect: { x: 0, y: 0, width: PAGE_W, height: PAGE_H } }])
  const meta = new Map([['id1', { width: 1240, height: 1754 }]])
  const userRotation = 270
  const cmd = buildMergeRenderCommands(layout, meta, { id1: userRotation }, { isLandscape: false })[0]
  if (cmd.contentRotation !== normalizeRotation(userRotation)) {
    throw new Error('⚠ Architecture Watch: PathB contentRotation diverged from declared user rotation. This requires Future Rotation Semantic Migration review.')
  }
  console.log('ℹ guardPathBDivergenceWatch: PASS (Path B divergence watched, no change)')
})

// ── §8 rotation-once 不变量 ──

test('rotation-once R1: placement has no embedded rotation; cmd.rotation === 0', () => {
  // Path A
  const aOut = composePlans({ paperLayout: makePaperLayout(), plans: [makePlan({ effectiveRotation: 90 })], ticketCount: 1 })
  const aCmd = aOut[0].renderCommand
  assert.strictEqual(aCmd.rotation, 0, 'Path A: legacy rotation field === 0')
  assert.ok(!('rotation' in aCmd.placement), 'Path A: placement has no rotation field')

  // Path B
  const layout = makeMergeLayout([{ itemId: 'id1', contentRect: { x: 0, y: 0, width: PAGE_W, height: PAGE_H } }])
  const meta = new Map([['id1', { width: 1240, height: 1754 }]])
  const bCmd = buildMergeRenderCommands(layout, meta, { id1: 90 }, { isLandscape: false })[0]
  assert.strictEqual(bCmd.rotation, 0, 'Path B: legacy rotation field === 0')
  assert.ok(!('rotation' in bCmd.placement), 'Path B: placement has no rotation field')
})

function makeMockCtx() {
  const calls = []
  return {
    calls,
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    translate(x, y) { calls.push(['translate', x, y]) },
    rotate(a) { calls.push(['rotate', a]) },
    drawImage() { calls.push(['drawImage']) },
    get rotateCalls() { return calls.filter((c) => c[0] === 'rotate') },
  }
}

test('rotation-once R2: executor rotates exactly once (cr=90 → 1 call; cr=0 → 0 calls)', () => {
  const layout = makeMergeLayout([{ itemId: 'id1', contentRect: { x: 0, y: 0, width: PAGE_W, height: PAGE_H } }])
  const meta = new Map([['id1', { width: 1240, height: 1754 }]])

  // cr = 90
  const cmd90 = buildMergeRenderCommands(layout, meta, { id1: 90 }, { isLandscape: false })[0]
  const ctx90 = makeMockCtx()
  drawRenderCommand(ctx90, cmd90, {}, 1240, 1754, 1)
  assert.strictEqual(ctx90.rotateCalls.length, 1, 'cr=90: exactly one rotate')
  assert.ok(Math.abs(ctx90.rotateCalls[0][1] - (90 * Math.PI) / 180) < 1e-9, 'cr=90: rotate angle = 90°')

  // cr = 0
  const cmd0 = buildMergeRenderCommands(layout, meta, { id1: 0 }, { isLandscape: false })[0]
  const ctx0 = makeMockCtx()
  drawRenderCommand(ctx0, cmd0, {}, 1240, 1754, 1)
  assert.strictEqual(ctx0.rotateCalls.length, 0, 'cr=0: zero rotate (drawn without rotation)')
})

test('rotation-once R3: producer rotation === executor rotation (no second rotation, both paths)', () => {
  const layout = makeMergeLayout([{ itemId: 'id1', contentRect: { x: 0, y: 0, width: PAGE_W, height: PAGE_H } }])
  const meta = new Map([['id1', { width: 1240, height: 1754 }]])

  // Path B
  const bCmd = buildMergeRenderCommands(layout, meta, { id1: 180 }, { isLandscape: false })[0]
  const bCtx = makeMockCtx()
  drawRenderCommand(bCtx, bCmd, {}, 1240, 1754, 1)
  assert.strictEqual(bCtx.rotateCalls.length, 1)
  assert.ok(Math.abs(bCtx.rotateCalls[0][1] - (bCmd.contentRotation * Math.PI) / 180) < 1e-9, 'Path B: executor rotates by producer contentRotation')

  // Path A
  const aOut = composePlans({ paperLayout: makePaperLayout(), plans: [makePlan({ effectiveRotation: 270 })], ticketCount: 1 })
  const aCmd = aOut[0].renderCommand
  const aCtx = makeMockCtx()
  drawRenderCommand(aCtx, aCmd, {}, 1240, 1754, 1)
  assert.strictEqual(aCtx.rotateCalls.length, 1)
  assert.ok(Math.abs(aCtx.rotateCalls[0][1] - (aCmd.contentRotation * Math.PI) / 180) < 1e-9, 'Path A: executor rotates by producer contentRotation')
})
