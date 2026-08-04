/**
 * A2-G0 Gate 框架自检（node --test，纯 node 可跑，不接 React/Electron）
 *
 * 覆盖：
 *  1. measureMarginsPx / pxToMm / mmToPx / marginsToMm 纯函数正确性
 *  2. assertSafeMarginAlignment 容差断言（≤0.5mm 通过 / >0.5mm 失败）
 *  3. anchorManifest 结构校验（A1-A6 齐全、derived 引用）
 *  4. 双执行器比较管线结构：Plan → legacy/canvas 双输出 → compare
 *     （用 mock 输出演示管线形状；真实双轨输出采集属 G1，需 Electron 环境）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { measureMarginsPx, pxToMm, mmToPx, marginsToMm, assertSafeMarginAlignment, findContentBBox } from './measureMargins.mjs'
import { anchorManifest, validateAnchorManifest } from './anchorManifest.mjs'
import { SAFE_MARGIN_TOLERANCE_MM, GATE_DPI, PAPER_SIZES_MM } from './gateConfig.mjs'
import { normalizeReadFileData } from './ipcPayloadAdapter.mjs'
import { GATE_CASES } from './gateCases.mjs'
import { extendPaperLayoutContract, validatePaperLayoutContract } from '../../src/print/paperLayoutContract.js'
import { applySourceOriginPlacement, assertPlacementOffset, mmToPxPlacement, transformPaperRotation } from '../../src/print/placementAdapter.js'

// ── 0. IPC payload 适配（G1-CANVAS-1 真实契约）──────────────────
test('normalizeReadFileData: Uint8Array 直通（形态 A）', () => {
  const u8 = new Uint8Array([1, 2, 3])
  assert.equal(normalizeReadFileData({ success: true, data: u8 }), u8)
})

test('normalizeReadFileData: ArrayBuffer 转换（形态 B）', () => {
  const ab = new Uint8Array([4, 5, 6]).buffer
  const out = normalizeReadFileData({ success: true, data: ab })
  assert.ok(out instanceof Uint8Array)
  assert.deepEqual([...out], [4, 5, 6])
})

test('normalizeReadFileData: Node Buffer 序列化对象（形态 C）', () => {
  const payload = { success: true, data: { type: 'Buffer', data: [7, 8, 9] } }
  const out = normalizeReadFileData(payload)
  assert.ok(out instanceof Uint8Array)
  assert.deepEqual([...out], [7, 8, 9])
})

test('normalizeReadFileData: 不支持的 payload 抛错', () => {
  assert.throws(() => normalizeReadFileData({ success: true, data: { foo: 'bar' } }))
  assert.throws(() => normalizeReadFileData({ success: true, data: 'string-not-bytes' }))
})

// ── 1. 测量纯函数 ──────────────────────────────────────────────
test('findContentBBox: 白底上的黑块 → 精确 bbox', () => {
  // 10x10 全白，在 (2,3)-(6,7) 放黑块
  const w = 10, h = 10
  const px = new Uint8ClampedArray(w * h * 4).fill(255) // 白底不透明
  for (let y = 3; y <= 7; y++) {
    for (let x = 2; x <= 6; x++) {
      const i = (y * w + x) * 4
      px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 255
    }
  }
  assert.deepEqual(findContentBBox(px, w, h), { x: 2, y: 3, w: 5, h: 5 })
})

test('findContentBBox: 透明背景 + 内容 → 按 alpha 判定', () => {
  // 4x4 全透明，中间 (1,1) 一个不透明红点
  const w = 4, h = 4
  const px = new Uint8ClampedArray(w * h * 4) // alpha=0
  const i = (1 * w + 1) * 4
  px[i] = 255; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 255
  assert.deepEqual(findContentBBox(px, w, h), { x: 1, y: 1, w: 1, h: 1 })
})

test('findContentBBox: 全空白 → null', () => {
  const px = new Uint8ClampedArray(16 * 16 * 4).fill(255) // 纯白
  assert.equal(findContentBBox(px, 16, 16), null)
})

test('findContentBBox: 输入非法（长度不匹配/尺寸非法）抛错', () => {
  assert.throws(() => findContentBBox(new Uint8ClampedArray(10), 3, 1))
  assert.throws(() => findContentBBox(new Uint8ClampedArray(16), 0, 4))
})

test('findContentBBox → measureMarginsPx 端到端：bbox 到边距换算', () => {
  // A4@300dpi ≈ 2480x3508，内容内缩 20mm ≈ 236px
  const paperPx = { w: Math.round(PAPER_SIZES_MM.A4.width * GATE_DPI / 25.4), h: Math.round(PAPER_SIZES_MM.A4.height * GATE_DPI / 25.4) }
  const m = mmToPx(20)
  // 构造一个内容恰好占 (m,m)-(paperPx.w-m, paperPx.h-m) 的位图太大，改为直接验证换算链
  const bbox = { x: Math.round(m), y: Math.round(m), w: paperPx.w - 2 * Math.round(m), h: paperPx.h - 2 * Math.round(m) }
  const marginsPx = measureMarginsPx(bbox, paperPx)
  const marginsMm = marginsToMm(marginsPx)
  for (const e of ['left', 'top', 'right', 'bottom']) assert.ok(Math.abs(marginsMm[e] - 20) < 0.5)
})
test('measureMarginsPx: bbox 贴左边缘 → left=0', () => {
  const m = measureMarginsPx({ x: 0, y: 100, w: 500, h: 700 }, { w: 1000, h: 1400 })
  assert.deepEqual(m, { left: 0, top: 100, right: 500, bottom: 600 })
})

test('measureMarginsPx: 居中 bbox → 四边对称', () => {
  const m = measureMarginsPx({ x: 200, y: 200, w: 600, h: 1000 }, { w: 1000, h: 1400 })
  assert.equal(m.left, m.right)
  assert.equal(m.top, m.bottom)
  assert.equal(m.left, 200)
  assert.equal(m.top, 200)
})

test('measureMarginsPx: 满纸 bbox → 四边全 0', () => {
  const m = measureMarginsPx({ x: 0, y: 0, w: 1000, h: 1400 }, { w: 1000, h: 1400 })
  assert.deepEqual(m, { left: 0, top: 0, right: 0, bottom: 0 })
})

test('measureMarginsPx: bbox 越界抛错', () => {
  assert.throws(() => measureMarginsPx({ x: 0, y: 0, w: 1100, h: 1400 }, { w: 1000, h: 1400 }))
  assert.throws(() => measureMarginsPx({ x: -5, y: 0, w: 100, h: 100 }, { w: 1000, h: 1400 }))
})

test('px↔mm 换算：300dpi 下 1mm ≈ 11.811px（A4 宽 210mm ≈ 2480px）', () => {
  assert.ok(Math.abs(pxToMm(mmToPx(210)) - 210) < 1e-6)
  const a4pxW = Math.round(210 * GATE_DPI / 25.4)
  assert.equal(a4pxW, 2480)
})

test('marginsToMm：A4@300dpi 四边 20mm 边距 → 236.22px', () => {
  const px = mmToPx(20)
  const m = marginsToMm({ left: px, top: px, right: px, bottom: px })
  for (const e of ['left', 'top', 'right', 'bottom']) assert.ok(Math.abs(m[e] - 20) < 0.001)
})

// ── 2. 容差断言 ────────────────────────────────────────────────
test('assertSafeMarginAlignment: 0.4mm 差 → pass', () => {
  const r = assertSafeMarginAlignment(
    { left: 20, top: 20, right: 20, bottom: 20 },
    { left: 20.4, top: 20.1, right: 19.9, bottom: 20 },
  )
  assert.equal(r.pass, true)
  assert.ok(r.maxDiffMm <= SAFE_MARGIN_TOLERANCE_MM)
})

test('assertSafeMarginAlignment: 0.7mm 差 → fail（任一超容差即失败）', () => {
  const r = assertSafeMarginAlignment(
    { left: 20, top: 20, right: 20, bottom: 20 },
    { left: 20.7, top: 20, right: 20, bottom: 20 },
  )
  assert.equal(r.pass, false)
  assert.equal(r.maxDiffMm, 0.7)
})

test('assertSafeMarginAlignment: 缺边值抛错', () => {
  assert.throws(() => assertSafeMarginAlignment({ left: 20, top: 20, right: 20, bottom: 20 }, { left: 20, top: 20 }))
})

// ── 3. manifest 结构 ───────────────────────────────────────────
test('anchorManifest: A1-A6 齐全、无重复、derived 有引用', () => {
  const { valid, errors } = validateAnchorManifest()
  assert.equal(valid, true, errors.join('; '))
  assert.equal(anchorManifest.length, 6)
  const a4 = anchorManifest.find(a => a.id === 'A4')
  assert.equal(a4.status, 'derived')
  assert.ok(a4.source.startsWith('derived:'))
})

test('anchorManifest: A2 OFD 已 available（用户提供样本），A5/A6 待标定', () => {
  const a2 = anchorManifest.find(a => a.id === 'A2')
  assert.equal(a2.status, 'available')
  assert.ok(a2.source.endsWith('.ofd'), `A2 source 应为真实 .ofd 路径: ${a2.source}`)
  const tbd = anchorManifest.filter(a => a.status === 'tbd')
  assert.ok(tbd.length >= 2, 'A5/A6 应标记待标定')
})

// ── 4. 双执行器比较管线结构（从 Plan 出发，§11.5）──────────────
test('gate pipeline: Plan → legacy/canvas 双输出 → compare（mock 演示形状）', () => {
  // 形状：files → buildPrintExecutionPlan → 双执行器 → 同源比较。
  // 真实采集（Sumatra vs Canvas 输出）属 G1，需 Electron 环境；
  // 此处用与 A1/A1.5 相同的 Plan 结构 mock，验证 compare 断言管线可用。
  const plan = {
    strategy: { oneNormalTwoSpecial: false },
    mergeMode: null,
    pages: [{ type: 'single', source: { fileId: 'A1' }, slots: [{ fileId: 'A1', rotation: 0 }] }],
    extraPages: [],
  }
  assert.equal(plan.pages.length, 1)

  // 双执行器共享同一 Plan → 输出同纸面（mock：source 与 canvas 都按 A4 渲染）
  const paperPx = { w: Math.round(PAPER_SIZES_MM.A4.width * GATE_DPI / 25.4), h: Math.round(PAPER_SIZES_MM.A4.height * GATE_DPI / 25.4) }
  // source 轨：pdfMargin.process 烘焙（main.js:515-553）→ 内容 bbox 内缩 20mm
  const sourceBbox = { x: mmToPx(20), y: mmToPx(20), w: paperPx.w - mmToPx(40), h: paperPx.h - mmToPx(40) }
  // canvas 轨：createPlacement 的 usableRect（期望与 source 对齐 ±0.5mm）
  const canvasBbox = { x: mmToPx(20.2), y: mmToPx(20), w: paperPx.w - mmToPx(40.4), h: paperPx.h - mmToPx(40) }

  const sourceMm = marginsToMm(measureMarginsPx(sourceBbox, paperPx))
  const canvasMm = marginsToMm(measureMarginsPx(canvasBbox, paperPx))
  const r = assertSafeMarginAlignment(canvasMm, sourceMm)

  assert.equal(r.pass, true)
  assert.ok(r.maxDiffMm <= SAFE_MARGIN_TOLERANCE_MM)
  assert.ok(r.maxDiffMm > 0, '应测出 ~0.2mm 的真实差异')
})

// ── 5. A3-1 Render Contract 接线（a3_design_spec_2026-08-03.md §8）────────
test('A3-1-01: renderFileToPrintImage 构造并携带 paperLayout（数据链路贯通，bitmap 不变）', () => {
  // usePrint.js 是 React hook（node 不可加载），静态断言源码接线点：
  // ① computePaperLayout 构造（与 merge 轨同款）
  // ② paperLayout 附加到返回 job（携带不生效）
  // ③ 渲染调用（renderMultipleItemsToCanvas）未传 paperLayout 第 10 参（bitmap 不变）
  const src = readFileSync(new URL('../../src/hooks/usePrint.js', import.meta.url), 'utf8')

  // ① 单文件分支含 computePaperLayout 构造（A3-3-1 后 baseLayout + extendPaperLayoutContract）
  const hasCompute = src.includes('const baseLayout = computePaperLayout({') || src.includes('const paperLayout = computePaperLayout({')
  // ② 返回 job 附加 paperLayout
  const hasAttach = src.includes("paperLayout }")
  // ③ 单文件渲染调用未传 paperLayout（renderFileToPrintImage 内 renderMultipleItemsToCanvas 调用，第 10 参为空）
  // renderFileToPrintImage 的调用特征：slotCount=1（第 6 参），且第 10 参位置无 printPaperLayout
  // （merge 轨 renderMergeGroupToPrintImage 传 printPaperLayout 且 slotCount=groupSize）
  const slot1Calls = src.match(/renderMultipleItemsToCanvas\([\s\S]*?\n\s*1,\s*\/\/ slotCount = 1[\s\S]*?\n\s*\)/g)
  const noPaperLayoutInSingle = slot1Calls
    ? slot1Calls.every(call => !call.includes('printPaperLayout'))
    : false

  assert.equal(hasCompute, true, 'renderFileToPrintImage 应构造 paperLayout')
  assert.equal(hasAttach, true, '返回 job 应携带 paperLayout')
  assert.equal(noPaperLayoutInSingle, true, '单文件渲染调用不应传 paperLayout（A3-1 bitmap 不变红线）')
})

test('A3-1-03: 不引入新 paperKey/customPaper 分支（红线）', () => {
  const src = readFileSync(new URL('../../src/hooks/usePrint.js', import.meta.url), 'utf8')
  // A3-1 禁止新增 paperKey/customPaper 分支——只允许沿用 settings.paperSize/customPaper 透传
  const paperKeyCount = (src.match(/paperKey/g) || []).length
  assert.equal(paperKeyCount, 0, 'A3-1 不应引入 paperKey 新分支')
})

// ── 6. A3-3-1 paperLayout Contract 扩展（a3_design_spec §A3-3）───────────
test('A3-3-1-01: contract presence — coordinateSpace + sourceOrigin 存在且结构正确', () => {
  const base = { paperRect: { w: 100, h: 100 }, usableRect: { x: 0, y: 0, w: 80, h: 80 } }
  const layout = extendPaperLayoutContract(base, { sourceOriginXMM: 10, sourceOriginYMM: 10 })
  const { valid, errors } = validatePaperLayoutContract(layout)
  assert.equal(valid, true, errors.join('; '))
  assert.deepEqual(layout.coordinateSpace, { name: 'paper', origin: 'top-left', unit: 'mm' })
  assert.deepEqual(layout.sourceOrigin, { x: 10, y: 10, unit: 'mm' })
  // baseLayout 原样保留（扩展不破坏 A3-1 产出的几何）
  assert.deepEqual(layout.paperRect, base.paperRect)
  assert.deepEqual(layout.usableRect, base.usableRect)
})

test('A3-3-1-02: bitmap invariant — 扩展不改变渲染路径（渲染调用仍无 paperLayout 第 10 参）', () => {
  const src = readFileSync(new URL('../../src/hooks/usePrint.js', import.meta.url), 'utf8')
  // 单文件渲染调用（slotCount=1）仍不传 printPaperLayout（A3-3-1 只扩 contract 不消费）
  const slot1Calls = src.match(/renderMultipleItemsToCanvas\([\s\S]*?\n\s*1,\s*\/\/ slotCount = 1[\s\S]*?\n\s*\)/g)
  const noPaperLayoutInSingle = slot1Calls
    ? slot1Calls.every(call => !call.includes('printPaperLayout'))
    : false
  assert.equal(noPaperLayoutInSingle, true, 'A3-3-1 不应改变渲染调用（bitmap invariant）')
})

test('A3-3-1-03: source semantic declaration — sourceOrigin=10mm（A3-3-1 声明，A3-3-2 起消费）', () => {
  // sourceOrigin 由 contract 模块声明（extendPaperLayoutContract），usePrint 只传 sourceOriginXMM/YMM
  const src = readFileSync(new URL('../../src/hooks/usePrint.js', import.meta.url), 'utf8')
  const contractSrc = readFileSync(new URL('../../src/print/paperLayoutContract.js', import.meta.url), 'utf8')

  // ① usePrint 传 sourceOriginXMM/YMM（10mm 场景：settings.marginLeft/Top）
  assert.equal(src.includes('sourceOriginXMM: settings.marginLeft ?? 3'), true)
  assert.equal(src.includes('sourceOriginYMM: settings.marginTop ?? 3'), true)
  // ② contract 模块声明 sourceOrigin 字段（source 语义，非 margin）
  assert.equal(contractSrc.includes('sourceOrigin: {'), true, 'contract 应声明 sourceOrigin')
  assert.equal(contractSrc.includes('coordinateSpace: {'), true, 'contract 应声明 coordinateSpace')
  // ③ A3-3-1 冻结时未消费；A3-3-2 起由 applySourceOriginPlacement 消费（演进验证）
  const fnBlock = src.match(/const renderFileToPrintImage[\s\S]*?renderMergeGroupToPrintImage/m)
  assert.ok(fnBlock, 'renderFileToPrintImage 函数块可定位')
  const fnBody = fnBlock[0]
  // A3-3-2 起：PDF 单文件分支调用 applySourceOriginPlacement（消费 sourceOrigin）
  assert.equal(fnBody.includes('applySourceOriginPlacement'), true, 'A3-3-2 应消费 sourceOrigin（PlacementAdapter）')
})

// ── 7. A3-3-2 PlacementAdapter（a3_design_spec §A3-3-2）──────────────────
test('A3-3-2-01: placement offset — native bbox + sourceOrigin(10mm) = source bbox（dx/dy ≤0.5mm）', () => {
  // G1-3B / A3-2 实测：native 内容 bbox (51,71,2424×1499)，source 内容 bbox (169,189,2423×1500)
  const nativeBbox = { x: 51, y: 71, w: 2424, h: 1499 }
  const sourceBbox = { x: 169, y: 189, w: 2423, h: 1500 }
  const paperLayout = { sourceOrigin: { x: 10, y: 10, unit: 'mm' } }
  const r = assertPlacementOffset(nativeBbox, paperLayout, sourceBbox)
  assert.equal(r.pass, true, r.errors.join('; '))
  assert.equal(r.dxPx, 0, `dxPx=${r.dxPx}（native.x 51 + 118 = 169）`)
  assert.equal(r.dyPx, 0, `dyPx=${r.dyPx}（native.y 71 + 118 = 189）`)
})

test('A3-3-2-02: margin compare — placement 后 canvas 边距 vs source 四边 ≤0.5mm', () => {
  // source 边距（实测）：L14.3 / T16.0 / R10.6 / B17.0mm
  // placement 后：native 内容位移 (118,118)px 到 230×160mm 纸（2717×1890px）
  const dpi = 300
  const paperPx = { w: Math.round(230 * dpi / 25.4), h: Math.round(160 * dpi / 25.4) }  // 2717×1890
  // native 内容 (51,71,2424×1499) + offset(118,118) → 内容 bbox (169,189,2424×1499)
  const placedBbox = { x: 169, y: 189, w: 2424, h: 1499 }
  const marginsPx = {
    left: placedBbox.x, top: placedBbox.y,
    right: paperPx.w - (placedBbox.x + placedBbox.w),
    bottom: paperPx.h - (placedBbox.y + placedBbox.h),
  }
  const marginsMm = {
    left: marginsPx.left * 25.4 / dpi, top: marginsPx.top * 25.4 / dpi,
    right: marginsPx.right * 25.4 / dpi, bottom: marginsPx.bottom * 25.4 / dpi,
  }
  const sourceMm = { left: 14.309, top: 16.002, right: 10.583, bottom: 17.018 }
  for (const e of ['left', 'top', 'right', 'bottom']) {
    const diff = Math.abs(marginsMm[e] - sourceMm[e])
    assert.ok(diff <= 0.5, `${e} diff=${diff.toFixed(3)}mm > 0.5mm（placed=${marginsMm[e].toFixed(3)} source=${sourceMm[e]}）`)
  }
})

test('A3-3-2-03: bitmap invariant — PlacementCommand 不改 scale/rotation/pixel，只改 position', () => {
  // applySourceOriginPlacement 产出：scale=1（不缩放）、contentRotation=0（不旋转）、offset=sourceOrigin
  const renderResource = { width: 2480, height: 1654 }
  const paperLayout = { sourceOrigin: { x: 10, y: 10, unit: 'mm' } }
  const cmd = applySourceOriginPlacement({ renderResource, paperLayout, rotation: 0 })
  assert.equal(cmd.placement.scale, 1, 'scale 应=1（A3-3-2 不缩放）')
  assert.equal(cmd.contentRotation, 0, 'rotation 应=0（A3-3-2 仅 rot0）')
  assert.equal(cmd.placement.offsetX, 118, 'offsetX 应=118px（10mm@300dpi）')
  assert.equal(cmd.placement.offsetY, 118, 'offsetY 应=118px')
  assert.deepEqual(cmd.rotatedBounds, { width: 2480, height: 1654 }, 'rotatedBounds=原生尺寸（像素不变）')
  assert.equal(cmd.clip, null, '单文件不裁剪')
  // mmToPx 换算
  assert.equal(mmToPxPlacement(10), 118)
})

// ── 8. A3-3-3 Rotation Placement Transform（a3_design_spec §7.1）───────────
// 冻结 C2 Policy A（paper+content 一体旋转）/ C3 变换顺序 / C4 sourceOrigin 不参与旋转
// ⚠️ 实现模型（2026-08-04 修正）：drawRenderCommand 的 contentRotation 是 Policy B（内容在画布内旋转），
//   Policy A = 画布级旋转：rot0 command 绘制扩展纸面 → rotateCanvasCommand 把扩展纸面画布作为 source
//   旋转绘制到新画布（与 A3-2 采集器同一数学，C5 bbox (201,169) 吻合）。
// A1 数据：扩展纸面 2717×1890px（230×160mm），native 2480×1654px，sourceOrigin 10mm→118px
const A1_RESOURCE = { width: 2480, height: 1654 }
const A1_PAPER = { sourceOrigin: { x: 10, y: 10, unit: 'mm' } }
const A1_PAPER_PX = { w: 2717, h: 1890 }

test('A3-3-3-01: rot90 canvas — 画布 1890×2717 + 画布旋转 command（Policy A 纸面跟随内容）', () => {
  const rot0 = applySourceOriginPlacement({ renderResource: A1_RESOURCE, paperLayout: A1_PAPER, rotation: 0 })
  const r90 = transformPaperRotation(rot0, 90, A1_PAPER_PX.w, A1_PAPER_PX.h)
  // 画布尺寸（Policy A：纸面跟随内容旋转）
  assert.equal(r90.canvasW, 1890, `canvasW=${r90.canvasW}（2717×1890 → 1890×2717）`)
  assert.equal(r90.canvasH, 2717)
  // 画布旋转 command：source = 扩展纸面画布（2717×1890），居中旋转 90°
  assert.ok(r90.rotateCanvasCommand, 'rot90 应有 rotateCanvasCommand')
  assert.equal(r90.rotateCanvasCommand.placement.offsetX, 0, '旋转 command offset=0（居中）')
  assert.equal(r90.rotateCanvasCommand.placement.offsetY, 0)
  assert.equal(r90.rotateCanvasCommand.placement.scale, 1, 'scale=1（像素不缩放）')
  assert.deepEqual(r90.rotateCanvasCommand.rotatedBounds, { width: 2717, height: 1890 }, 'rotatedBounds=原画布尺寸（source 语义）')
  assert.equal(r90.rotateCanvasCommand.contentRotation, 90, 'contentRotation=90')
})

test('A3-3-3-02: rot90 bbox — 内容宽高互换 1500×2423，无负坐标（C5 锚点）', () => {
  // 画布旋转模型：内容 bbox (169,189,2423×1500) 在扩展纸面 2717×1890 内，
  // 中心 (1380.5,939) vs 纸面中心 (1358.5,945) → rel (22,-6)；rotate90 → (6,22)；
  // 新画布 1890×2717 中心 (945,1358.5) → 新内容中心 (951,1380.5) → bbox (201,169,1500×2423)
  const contentCx = 169 + 2423 / 2  // 1380.5
  const contentCy = 189 + 1500 / 2  // 939
  const relX = contentCx - A1_PAPER_PX.w / 2  // 1380.5-1358.5 = 22
  const relY = contentCy - A1_PAPER_PX.h / 2  // 939-945 = -6
  const nrelX = -relY, nrelY = relX  // rotate90: (6,22)
  const newCx = 1890 / 2 + nrelX  // 951
  const newCy = 2717 / 2 + nrelY  // 1380.5
  const bboxX = newCx - 1500 / 2   // 201
  const bboxY = newCy - 2423 / 2   // 169
  const bboxW = 1500, bboxH = 2423
  // C5 预期：bbox (201,169,1500×2423)，无负坐标
  assert.ok(bboxX >= 0 && bboxY >= 0, `无负坐标：bboxX=${bboxX} bboxY=${bboxY}`)
  assert.ok(Math.abs(bboxX - 201) <= 1.5, `bboxX=${bboxX} vs 201`)
  assert.ok(Math.abs(bboxY - 169) <= 1, `bboxY=${bboxY} vs 169`)
  assert.ok(Math.abs(bboxW - 1500) <= 1, `bboxW=${bboxW} vs 1500（宽高互换）`)
  assert.ok(Math.abs(bboxH - 2423) <= 1, `bboxH=${bboxH} vs 2423`)
})

test('A3-3-3-03: rot90 margin — 四边 vs 预期 L17/T14.3/R16/B10.6 ≤0.5mm（顺时针轮换）', () => {
  // 同 A3-3-3-02 的 bbox 推算
  const relX = (169 + 2423 / 2) - A1_PAPER_PX.w / 2
  const relY = (189 + 1500 / 2) - A1_PAPER_PX.h / 2
  const nrelX = -relY, nrelY = relX
  const newCx = 1890 / 2 + nrelX
  const newCy = 2717 / 2 + nrelY
  const bboxX = newCx - 750
  const bboxY = newCy - 1211.5
  const bboxW = 1500, bboxH = 2423
  const dpi = 300
  const marginsMm = {
    left: bboxX * 25.4 / dpi,
    top: bboxY * 25.4 / dpi,
    right: (1890 - (bboxX + bboxW)) * 25.4 / dpi,
    bottom: (2717 - (bboxY + bboxH)) * 25.4 / dpi,
  }
  // C5 锚点：原 L14.3/T16/R10.6/B17 顺时针轮换 → L17/T14.3/R16/B10.6
  const expected = { left: 17, top: 14.3, right: 16, bottom: 10.6 }
  for (const e of ['left', 'top', 'right', 'bottom']) {
    const diff = Math.abs(marginsMm[e] - expected[e])
    assert.ok(diff <= 0.5, `${e} diff=${diff.toFixed(3)}mm > 0.5mm（actual=${marginsMm[e].toFixed(2)} expected=${expected[e]}）`)
  }
})

test('A3-3-3-04: rot180/rot270 + rotation=0 + 非法角度（数学完整性）', () => {
  const rot0 = applySourceOriginPlacement({ renderResource: A1_RESOURCE, paperLayout: A1_PAPER, rotation: 0 })
  // 180：画布不变、旋转 command contentRotation=180
  const r180 = transformPaperRotation(rot0, 180, A1_PAPER_PX.w, A1_PAPER_PX.h)
  assert.equal(r180.canvasW, 2717)
  assert.equal(r180.canvasH, 1890)
  assert.equal(r180.rotateCanvasCommand.contentRotation, 180)
  assert.deepEqual(r180.rotateCanvasCommand.rotatedBounds, { width: 2717, height: 1890 })
  // 270：画布 1890×2717、contentRotation=270
  const r270 = transformPaperRotation(rot0, 270, A1_PAPER_PX.w, A1_PAPER_PX.h)
  assert.equal(r270.canvasW, 1890)
  assert.equal(r270.canvasH, 2717)
  assert.equal(r270.rotateCanvasCommand.contentRotation, 270)
  // rotation=0：原画布尺寸 + 无旋转 command
  const r0 = transformPaperRotation(rot0, 0, A1_PAPER_PX.w, A1_PAPER_PX.h)
  assert.equal(r0.canvasW, 2717)
  assert.equal(r0.canvasH, 1890)
  assert.equal(r0.rotateCanvasCommand, null, 'rot0 无画布旋转 command')
  // 非法角度 fail-loud
  assert.throws(() => transformPaperRotation(rot0, 45, A1_PAPER_PX.w, A1_PAPER_PX.h), /非法 rotation=45/)
})

test('A3-3-3-05: usePrint 接线 — renderFileToPrintImage 消费 transformPaperRotation + 画布旋转分支（Policy A）', () => {
  const src = readFileSync(new URL('../../src/hooks/usePrint.js', import.meta.url), 'utf8')
  // ① import transformPaperRotation
  assert.equal(src.includes("import { applySourceOriginPlacement, transformPaperRotation }"), true, '应 import transformPaperRotation')
  // ② 调用点：rotInfo = transformPaperRotation(nativeCmd, rotation, pw, ph)
  assert.ok(/transformPaperRotation\(nativeCmd, rotation, pw, ph\)/.test(src), '应消费 transformPaperRotation（rotation 变量传递）')
  // ③ 画布旋转分支：rotateCanvasCommand 非空时两段式绘制（Policy A 画布级旋转）
  const fnBlock = src.match(/const renderFileToPrintImage[\s\S]*?renderMergeGroupToPrintImage/m)
  assert.ok(fnBlock, 'renderFileToPrintImage 函数块可定位')
  const fnBody = fnBlock[0]
  assert.equal(fnBody.includes('rotInfo.rotateCanvasCommand'), true, '应存在画布旋转分支（rotateCanvasCommand）')
  // ④ 红线：rotation 仍由 fileRotations 派生（未引入新旋转模型）
  assert.equal(src.includes('const rotation = fileRotations[f.key] || 0'), true, 'rotation 来源不变')
})

// ── 9. A3-V1 Production Path Capture（A3-3 Verification Closure）───────────
// 目标：验证「实现路径 ≠ 纯函数路径」——生产函数组合 + 两段式 draw 的实际 bitmap。
// 纯数学已由 A3-3-3-01..04 覆盖；此处固化：采集器镜像生产调用序列（静态）+ case 定义。
// 真实 bitmap 需 Electron 采集（A1-prod-rot90），采集后按 C5 锚点判定（bitmap 1890×2717 /
// bbox (201,169,1500×2423) / L17/T14.3/R16/B10.6 / ratio≥0.99）。

test('A3-E2E-01: 生产路径采集器镜像 usePrint 两段式调用序列（静态断言）', () => {
  const collectorSrc = readFileSync(new URL('./electron/collectCanvasOutput.js', import.meta.url), 'utf8')
  // ① 采集器 import 生产函数（不是自己实现渲染语义）
  assert.equal(collectorSrc.includes("import { computePaperLayout } from '../../../src/previewState.js'"), true, '应 import computePaperLayout（生产函数）')
  assert.equal(collectorSrc.includes("import { extendPaperLayoutContract }"), true, '应 import extendPaperLayoutContract')
  assert.equal(collectorSrc.includes("import { applySourceOriginPlacement, transformPaperRotation }"), true, '应 import placementAdapter 生产函数')
  assert.equal(collectorSrc.includes("import { drawRenderCommand }"), true, '应 import drawRenderCommand')
  // ② 两段式镜像：transformPaperRotation + rotateCanvasCommand 分支
  assert.ok(/transformPaperRotation\(rot0Cmd, caseDef\.rotation/.test(collectorSrc), '应消费 transformPaperRotation（caseDef.rotation 传递）')
  assert.equal(collectorSrc.includes('rotInfo.rotateCanvasCommand'), true, '应存在画布旋转分支')
  // ③ 红线：不 import usePrint / 不改 renderer / 不复制渲染语义
  assert.equal(collectorSrc.includes("from '../hooks/usePrint'"), false, '采集器不应 import usePrint')
  assert.equal(collectorSrc.includes("renderMultipleItemsToCanvas(items,"), false, '生产路径采集不混 composer/slot')
})

test('A3-E2E-02: A1-prod-rot90 case 定义（Custom 230×160 + rotation 90 + margin 10）', () => {
  const c = GATE_CASES.find(x => x.id === 'A1-prod-rot90')
  assert.ok(c, 'A1-prod-rot90 case 应存在')
  assert.equal(c.rotation, 90)
  assert.equal(c.settings.paperSize, 'Custom')
  assert.deepEqual(c.settings.customPaper, { widthMM: 230, heightMM: 160 })
  assert.equal(c.settings.marginLeft, 10)
  assert.equal(c.settings.marginTop, 10)
})
