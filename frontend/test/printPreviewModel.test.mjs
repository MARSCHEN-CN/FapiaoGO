/**
 * buildPrintPreviewModel 快照 / 几何锚点测试（Phase 3.5 Preview Skeleton）
 *
 * 目标：锁定「打印执行计划 → 打印预览描述」纯函数的输出结构：
 *   - single A4 portrait  → 1 page / 1 slot = 整页安全区（3mm 边距内缩）
 *   - merge2 (2 文件)      → 1 page / 2 slots 竖向等分（等高、末位收口）
 *   - merge4 (4 文件)      → 1 page / 4 slots 横向（强制 landscape，轴交换）
 *   - 一普二专            → extraPages 展开进 pages
 *   - custom 纸           → 尺寸来自 settings.customPaper
 *   - _deprecatedRotation → slot.rotation 兼容别名透传
 *   - 非法输入            → valid:false（未知纸张 / 边距超出）
 *
 * 数值锚点（与生产 computePaperLayout 公式同构的守卫）：
 *   A4 210×297mm @300dpi → 2480×3508px；3mm 边距 → 35px 内缩 → usableRect(35,35,2410,3438)。
 *   若 previewState.js 变更公式/DPI，此处锚点会红——两处须同步。
 *
 * 运行（frontend/ 目录）：
 *   node --test test/printPreviewModel.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPrintPreviewModel } from '../src/print/PrintPreviewModel.js'
import {
  buildPrintExecutionPlan,
  SOURCE_FILE_FILTER,
} from '../src/print/buildPrintExecutionPlan.js'

// 构造最小文件对象（与 printExecutionPlan.test.mjs 同款）
const mk = (key, over = {}) => ({
  key,
  name: `${key}.pdf`,
  status: 'parsed',
  printPath: `/tmp/${key}.pdf`,
  fileFormat: 'pdf',
  ...over,
})

const D = { widthMM: 204.05, heightMM: 291.08 } // A4 single 整页安全区 mm 锚点
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol

test('PM-01: single A4 portrait → 1 page / 1 slot = 整页安全区（mm 锚点）', () => {
  const files = [mk('A')]
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: {} })
  const m = buildPrintPreviewModel(plan, { files, settings: {} })
  assert.equal(m.valid, true)
  assert.equal(m.pages.length, 1)
  const p = m.pages[0]
  assert.equal(p.paper, 'A4')
  assert.equal(p.orientation, 'portrait')
  assert.ok(near(p.paperSizeMM.widthMM, 210), `widthMM=${p.paperSizeMM.widthMM} vs 210`)
  assert.ok(near(p.paperSizeMM.heightMM, 297), `heightMM=${p.paperSizeMM.heightMM} vs 297`)
  assert.equal(p.slots.length, 1)
  const s = p.slots[0]
  assert.ok(near(s.x, 2.96), `slot.x=${s.x} vs 2.96（3mm 左内缩）`)
  assert.ok(near(s.y, 2.96), `slot.y=${s.y} vs 2.96（3mm 上内缩）`)
  assert.ok(near(s.width, D.widthMM), `slot.width=${s.width} vs ${D.widthMM}`)
  assert.ok(near(s.height, D.heightMM), `slot.height=${s.height} vs ${D.heightMM}`)
  assert.equal(s.source, 'A.pdf', 'source=文件名（files 映射）')
  assert.equal(s._deprecatedRotation, 0)
})

test('PM-02: merge2 → 2 slots 竖向等分（等高、末位收口）', () => {
  const files = [mk('A'), mk('B')]
  const plan = buildPrintExecutionPlan(files, {
    filter: SOURCE_FILE_FILTER,
    settings: { mergeMode: 'merge2' },
  })
  const m = buildPrintPreviewModel(plan, { files, settings: { mergeMode: 'merge2' } })
  assert.equal(m.pages.length, 1)
  const p = m.pages[0]
  assert.equal(p.type, undefined) // PreviewModel 不暴露 plan 的 type 字段（无契约义务）——仅验证结构
  assert.equal(p.orientation, 'portrait')
  assert.equal(p.slots.length, 2)
  const [s0, s1] = p.slots
  assert.ok(near(s0.width, s1.width), `slot 宽相等 ${s0.width} vs ${s1.width}`)
  assert.ok(near(s0.height, s1.height, 0.1), `slot 高相等 ${s0.height} vs ${s1.height}`)
  assert.ok(near(s1.y - (s0.y + s0.height), 0, 0.05), `slot1.y=槽0 底边（连续）`)
  assert.ok(near(s0.y, 2.96) && near(s1.y, 148.51), `y0=${s0.y} y1=${s1.y}（竖向 1/2 处）`)
  assert.equal(s0.source, 'A.pdf')
  assert.equal(s1.source, 'B.pdf')
})

test('PM-03: merge4 → 1 page / 4 slots 横向（强制 landscape，物理可用区重算）', () => {
  const files = [mk('A'), mk('B'), mk('C'), mk('D')]
  const plan = buildPrintExecutionPlan(files, {
    filter: SOURCE_FILE_FILTER,
    settings: { mergeMode: 'merge4' },
  })
  const m = buildPrintPreviewModel(plan, { files, settings: { mergeMode: 'merge4' } })
  assert.equal(m.pages.length, 1)
  const p = m.pages[0]
  assert.equal(p.orientation, 'landscape')
  assert.ok(near(p.paperSizeMM.widthMM, 297), `landscape 宽=${p.paperSizeMM.widthMM} vs 297（交换后）`)
  assert.ok(near(p.paperSizeMM.heightMM, 210), `landscape 高=${p.paperSizeMM.heightMM} vs 210`)
  assert.equal(p.slots.length, 4)
  const s0 = p.slots[0]
  // 横向物理可用区（margins 属 Paper 坐标）：宽=297-6=291.08mm，高=210-6=204.05mm，竖向 4 等分
  assert.ok(near(s0.x, 2.96) && near(s0.y, 2.96), `slot0 原点 (${s0.x},${s0.y})`)
  assert.ok(near(s0.width, 291.08, 0.1), `slot0.width=${s0.width} vs 291.08（横向可用宽 297-6）`)
  assert.ok(near(s0.height, 51.01, 0.1), `slot0.height=${s0.height} vs 51.01（横向可用高 204.05 的 1/4）`)
  // 竖向排列：y 递增，x 不变（横向物理可用区内等分）
  for (let i = 1; i < 4; i++) {
    assert.ok(near(p.slots[i].y, p.slots[i - 1].y + p.slots[i - 1].height, 0.1), `slot${i}.y 连续`)
    assert.ok(near(p.slots[i].x, s0.x, 0.1), `slot${i}.x 与 slot0 同 x`)
    assert.ok(p.slots[i].x + p.slots[i].width <= p.paperSizeMM.widthMM + 0.1, `slot${i} 不溢出纸宽`)
  }
})

test('PM-11: 横向 + 非对称边距（左30mm）→ slot 不溢出纸面，内容区贴物理可用区', () => {
  const files = [mk('A')]
  const plan = buildPrintExecutionPlan(files, {
    filter: SOURCE_FILE_FILTER,
    settings: { landscape: true, marginLeft: 30 },
  })
  const m = buildPrintPreviewModel(plan, {
    files,
    settings: { landscape: true, marginLeft: 30 },
  })
  assert.equal(m.valid, true)
  const p = m.pages[0]
  const s = p.slots[0]
  // 横向物理可用区：x∈[30, 297-3] → 宽 264mm（margins 属 Paper 坐标，非轴交换）
  assert.ok(near(s.x, 30, 0.1), `slot.x=${s.x} vs 30（物理左边距）`)
  assert.ok(near(s.width, 264, 0.1), `slot.width=${s.width} vs 264（297-30-3）`)
  assert.ok(s.x + s.width <= p.paperSizeMM.widthMM + 0.1,
    `不溢出纸宽：x+w=${(s.x + s.width).toFixed(1)} vs ${p.paperSizeMM.widthMM}`)
  // 右下角 = 物理可用区右下角（fit 目标完整落在纸内）
  assert.ok(near(s.y + s.height, 210 - 3, 0.1), `y+h=${s.y + s.height} vs 207`)
})

test('PM-04: 一普二专 → extraPages 展开进 pages', () => {
  // ⚠️ 生产约定 invoiceType 为短值「专票」/「普票」（invoiceDocumentViewModel.test.js 同款），
  // 注意「增值税专用发票」不包含连续子串「专票」——用生产实际取值。
  const files = [mk('A', { invoiceType: '普票' }), mk('B', { invoiceType: '专票' })]
  const plan = buildPrintExecutionPlan(files, {
    filter: SOURCE_FILE_FILTER,
    settings: { extraSpecial: true },
  })
  assert.equal(plan.extraPages.length, 1, 'plan 应有 1 个 extraPage（专票第 2 轮）')
  const m = buildPrintPreviewModel(plan, { files, settings: { extraSpecial: true } })
  assert.equal(m.pages.length, 3, 'pages = 2 首轮 + 1 extra')
  assert.equal(m.pages[2].slots[0].source, 'B.pdf', 'extra 页 = 专票')
})

test('PM-05: custom 纸 → 尺寸来自 settings.customPaper', () => {
  const files = [mk('A')]
  const plan = buildPrintExecutionPlan(files, {
    filter: SOURCE_FILE_FILTER,
    settings: { paperSize: 'Custom', customPaper: { widthMM: 100, heightMM: 200 } },
  })
  const m = buildPrintPreviewModel(plan, {
    files,
    settings: { paperSize: 'Custom', customPaper: { widthMM: 100, heightMM: 200 } },
  })
  assert.equal(m.valid, true)
  assert.ok(near(m.pages[0].paperSizeMM.widthMM, 100), `widthMM=${m.pages[0].paperSizeMM.widthMM} vs 100`)
  assert.ok(near(m.pages[0].paperSizeMM.heightMM, 200), `heightMM=${m.pages[0].paperSizeMM.heightMM} vs 200`)
})

test('PM-06: rotation 透传', () => {
  const files = [mk('A')]
  const plan = buildPrintExecutionPlan(files, {
    filter: SOURCE_FILE_FILTER,
    settings: {},
    fileRotations: { A: 90 },
  })
  const m = buildPrintPreviewModel(plan, { files, settings: {}, fileRotations: { A: 90 } })
  assert.equal(m.pages[0].slots[0]._deprecatedRotation, 90)
})

test('PM-07: 非法输入 → valid:false（未知纸张 / 边距超出 / plan 缺失）', () => {
  const files = [mk('A')]
  // 未知纸张
  const p1 = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: { paperSize: 'NoSuch' } })
  const m1 = buildPrintPreviewModel(p1, { files, settings: { paperSize: 'NoSuch' } })
  assert.equal(m1.valid, false)
  assert.match(m1.reason, /未知纸张/)
  // 边距超出（A4 宽 210mm，左右边距各 200mm → 内缩后为负）
  const p2 = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: { marginLeft: 200, marginRight: 200 } })
  const m2 = buildPrintPreviewModel(p2, { files, settings: { marginLeft: 200, marginRight: 200 } })
  assert.equal(m2.valid, false)
  // plan 缺失
  const m3 = buildPrintPreviewModel(null)
  assert.equal(m3.valid, false)
})

test('PM-08: 数值锚点守卫 — A4 3mm 边距 → usableRect(35,35,2410,3438)px（与生产公式同构）', () => {
  const files = [mk('A')]
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: {} })
  const m = buildPrintPreviewModel(plan, { files, settings: {} })
  const s = m.pages[0].slots[0]
  // px 反推：slot mm → px 应与生产 computePaperLayout 的 usableRect 完全一致
  const toPx = (mm) => mm / 25.4 * 300
  assert.ok(Math.abs(toPx(s.x) - 35) <= 1, `左内缩 px=${toPx(s.x)} vs 35`)
  assert.ok(Math.abs(toPx(s.y) - 35) <= 1, `上内缩 px=${toPx(s.y)} vs 35`)
  assert.ok(Math.abs(toPx(s.width) - 2410) <= 1.5, `宽 px=${toPx(s.width)} vs 2410`)
  assert.ok(Math.abs(toPx(s.height) - 3438) <= 1.5, `高 px=${toPx(s.height)} vs 3438`)
})

test('PM-09: backendUrl 注入 + 多页展开 → thumbnailUrl 用 /thumbnail/{docId}?page=N（后端 1-based）', () => {
  const files = [mk('A', { docId: 'docA', pageCount: 2 })]
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: {} })
  const m = buildPrintPreviewModel(plan, {
    files,
    settings: {},
    backendUrl: 'http://localhost:5000',
  })
  assert.equal(m.pages.length, 2, '多页文档展开为 2 个预览页')
  assert.equal(m.pages[0].slots[0].thumbnailUrl, 'http://localhost:5000/thumbnail/docA?page=1')
  assert.equal(m.pages[1].slots[0].thumbnailUrl, 'http://localhost:5000/thumbnail/docA?page=2')
  // pageIndex 0-based 透传（消费端 +1 展示，核心原则 3）
  assert.equal(m.pages[0].slots[0].pageIndex, 0)
  assert.equal(m.pages[1].slots[0].pageIndex, 1)
})

test('PM-10: currentSelection 定位 → currentPageIndex 指向选中文件页', () => {
  const files = [mk('A', { docId: 'docA', pageCount: 2 }), mk('B')]
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: {} })
  const m = buildPrintPreviewModel(plan, {
    files,
    settings: {},
    currentSelection: { fileId: 'B', pageIndex: 0 },
  })
  // pages = [A-0, A-1, B] → 选中 B → index 2
  assert.equal(m.currentPageIndex, 2)
})

// ── Commit 2-F-1：px → mm 单位隔离（renderTransformMM） ──
// Resolver 输出 px@PREVIEW_DPI；PrintPreviewCanvas SVG viewBox 是 mm。
// PrintPreviewModel 在此一次性换算，Canvas 永不感知 DPI。
// 另：landscape 页 Resolver 收「显示方向」纸尺寸 → renderTransform 落在与 viewBox 一致的显示坐标系。
const mkDim = (key, w, h, over = {}) => mk(key, { _pdfPageWidth: w, _pdfPageHeight: h, ...over })
const normDeg = (d) => ((d % 360) + 360) % 360

test('PM-12 (Gate 1): 横票(609pt≈214.9×139mm)+A4竖 → renderTransformMM≈214.9×139mm, rotation≡-90, 居中安全区', () => {
  const files = [mkDim('LAND', 609, 394)]
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: {} })
  const m = buildPrintPreviewModel(plan, { files, settings: {} })
  const s = m.pages[0].slots[0]
  const t = s.placement.renderTransformMM
  assert.ok(t, 'placement.renderTransformMM 存在')
  assert.ok(near(t.contentBoxWidth, 214.9, 0.5), `contentBoxWidth=${t.contentBoxWidth} ≈214.9mm（609pt×25.4/72）`)
  assert.ok(near(t.contentBoxHeight, 139.0, 0.5), `contentBoxHeight=${t.contentBoxHeight} ≈139.0mm（394pt×25.4/72）`)
  assert.equal(normDeg(t.rotationDeg), 270, `rotationDeg=${t.rotationDeg} ≡ -90（逆时针90）`)
  // 居中：placedRect 中心(px) → mm 应≈纸中心(105,148.5)（对称边距）
  const pr = s.placement.placedRect
  const cx = (pr.x + pr.w / 2) * (25.4 / 300)
  const cy = (pr.y + pr.h / 2) * (25.4 / 300)
  assert.ok(near(cx, 105, 0.5) && near(cy, 148.5, 0.5), `中心(${cx.toFixed(1)},${cy.toFixed(1)})≈纸中心(105,148.5)`)
  // 数值应为 mm 量级（绝非 px 量级），证明单位隔离生效
  assert.ok(t.translateX < 210 && t.translateY < 297, `translate(${t.translateX},${t.translateY}) 在 A4 mm 视框内`)
})

test('PM-13 (Gate 2): 横票+A4横方向 → rotation=270(≡-90)（Commit 2-H v2：A4+landscape 即横纸型+横方向放倒，renderTransform 落在交换后的显示坐标系）', () => {
  const files = [mkDim('LAND', 609, 394)]
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: { landscape: true } })
  const m = buildPrintPreviewModel(plan, { files, settings: { landscape: true } })
  const t = m.pages[0].slots[0].placement.renderTransformMM
  assert.equal(normDeg(t.rotationDeg), 270, '横票+横方向 → fitRotation=-90(270) [Commit 2-H v2]')
  // 显示坐标系：landscape viewBox=297×210，translate 应落在 [0,297]×[0,210]
  assert.ok(t.translateX < 297 && t.translateY < 210, `translate(${t.translateX},${t.translateY}) 在 landscape mm 视框内`)
})

test('PM-14 (Gate 3): 用户旋转90 → thumbnail bake content_rotation=90，Canvas rotation=fitRotation（不含 contentRotation，无双旋转）', () => {
  const files = [mkDim('LAND', 609, 394, { docId: 'docL' })]
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: {}, fileRotations: { LAND: 90 } })
  const m = buildPrintPreviewModel(plan, { files, settings: {}, fileRotations: { LAND: 90 }, backendUrl: 'http://localhost:5000' })
  const s = m.pages[0].slots[0]
  assert.ok(s.thumbnailUrl.includes('content_rotation=90'), '缩略图 bake contentRotation=90')
  // 横票 contentRotation=90 → 有效内容变竖(portrait) → 竖纸 fit=0 → Canvas rotation=0（不重复 contentRotation）
  const t = s.placement.renderTransformMM
  assert.equal(normDeg(t.rotationDeg), 0, 'Canvas rotation=fitRotation=0（无双旋转）')
})

test('PM-15: 四案例旋转矩阵（renderTransformMM.rotationDeg 归一化）', () => {
  const build = (w, h, settings) => {
    const f = [mkDim('A', w, h)]
    return buildPrintPreviewModel(
      buildPrintExecutionPlan(f, { filter: SOURCE_FILE_FILTER, settings }),
      { files: f, settings },
    ).pages[0].slots[0].placement.renderTransformMM
  }
  // 案例1: 横票 + A4竖 + 竖 → 逆时针90 → 270
  assert.equal(normDeg(build(609, 394, {}).rotationDeg), 270, '横票+A4竖+竖 → 逆时针90')
  // 案例2: 横票 + A4横方向(landscape:true → 横纸型) + 横 → -90(270) [Commit 2-H v2：横纸型+横方向放倒]
  assert.equal(normDeg(build(609, 394, { landscape: true }).rotationDeg), 270, '横票+A4横方向 → -90(270) [Commit 2-H v2]')
  // 案例3: 竖票 + A4竖 + 横 → 顺时针90 → 90
  assert.equal(normDeg(build(394, 609, { landscape: true }).rotationDeg), 90, '竖票+A4竖+横 → 顺时针90')
  // 案例4: 横票 + 横纸型(240×140) + 纵 → 0（Commit 2-H：横向纸型下 orientationFit 恒为 0，用户纵不再补偿旋转）
  assert.equal(normDeg(build(609, 394, { paperSize: 'Custom', customPaper: { widthMM: 240, heightMM: 140 } }).rotationDeg), 0, '横票+横纸型+纵 → 0（Commit 2-H 修复）')
})

// ── Commit 2-G：fit scale 占满安全区（PDF points → px@dpi 归一化后量级正确） ──
test('PM-16 (Gate 1 修正): 小内容(160×100mm)→ scale>1 放大填充安全区，居中不越界', () => {
  // 模拟用户内容物理尺寸 160×100mm（PDF points = 160*72/25.4 ≈ 454）
  const files = [mkDim('SMALL', Math.round(160 * 72 / 25.4), Math.round(100 * 72 / 25.4))]
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: {} })
  const m = buildPrintPreviewModel(plan, { files, settings: {} })
  const s = m.pages[0].slots[0]
  const pl = s.placement
  // 排版对象语义：小内容放大填充安全区（旧版被 Math.min(...,1) 封顶=1，Commit 2-G-1 已修正）
  assert.ok(pl.scale > 1, `scale=${pl.scale} 应 >1（放大填充，非原尺寸）`)
  const cs = pl.canvasSize
  // 放大后不超出纸张
  assert.ok(pl.placedRect.x >= -1 && pl.placedRect.y >= -1, 'placedRect 不越纸左上')
  assert.ok(pl.placedRect.x + pl.placedRect.w <= cs.width + 1, 'placedRect 不越纸右')
  assert.ok(pl.placedRect.y + pl.placedRect.h <= cs.height + 1, 'placedRect 不越纸下')
  // 居中
  const cx = pl.placedRect.x + pl.placedRect.w / 2
  const cy = pl.placedRect.y + pl.placedRect.h / 2
  assert.ok(Math.abs(cx - cs.width / 2) <= 2, `水平居中 cx=${cx.toFixed(0)}≈${cs.width / 2}`)
  assert.ok(Math.abs(cy - cs.height / 2) <= 2, `垂直居中 cy=${cy.toFixed(0)}≈${cs.height / 2}`)
  // 放大填充：至少一维占满纸张 ≥85%
  const fill = Math.max(pl.placedRect.w / cs.width, pl.placedRect.h / cs.height)
  assert.ok(fill > 0.85, `放大填充比例=${fill.toFixed(2)} 应 >0.85`)
})

test('PM-17 (Gate 2 大内容): 大票(300×400mm)+10mm边距 → scale<1 等比缩小碰边停止', () => {
  const files = [mkDim('BIG', Math.round(300 * 72 / 25.4), Math.round(400 * 72 / 25.4))]
  const plan = buildPrintExecutionPlan(files, { filter: SOURCE_FILE_FILTER, settings: { marginLeft: 10, marginRight: 10, marginTop: 10, marginBottom: 10 } })
  const m = buildPrintPreviewModel(plan, { files, settings: { marginLeft: 10, marginRight: 10, marginTop: 10, marginBottom: 10 } })
  const s = m.pages[0].slots[0]
  const pl = s.placement
  assert.ok(pl.scale < 1, `scale=${pl.scale} 应 <1（内容超出安全区，等比缩小）`)
  const wMM = pl.placedRect.w * (25.4 / 300)
  const hMM = pl.placedRect.h * (25.4 / 300)
  // 可用区 190×277mm；300mm 宽内容 → scale=190/300=0.633 先触顶宽度边
  assert.ok(near(wMM, 190, 1), `缩放后碰边：w=${wMM.toFixed(1)}mm ≈ 190（可用宽）`)
})
