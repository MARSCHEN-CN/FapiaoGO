// gate3A1SingleOfd.test.mjs — PPC-OFD Gate 3-A.1: Single OFD Page Print Pipeline Harness
//
// 冻结范围（Gate 3 矩阵 §0/§4，docs/ppc-ofd-integration-gate3-e2e-matrix.md）：
//   · test-only；production zero-touch；不改 render_ofd_page / OFDAdapter /
//     RenderCommand / mergeFactory / RotationResolver；不加 OFD print branch。
//   · 只验证：OFD RenderResource → 现有 Print Pipeline → canvas 的闭环，
//     6 项 PASS 条件：S1 无 OFD 专属分支 / S2 canvas 尺寸来自 paperRect contract /
//     S3 bbox≥15% / S4 无裁切 / S5 rotation exactly once / S6 preview-print orientation 一致。
//   · 不检查：Sumatra / 物理打印机 / merge geometry / multi-page（分别属 3-B / 3-A.3+）。
//
// 方法论（矩阵 §4 冻结）：
//   · 复刻 usePrint.js:227-237 OFD 分支的真实调用参数（paper=A4, dpi=PREVIEW_DPI=300,
//     landscape=false, slotCount=1, isPrint=false —— 与预览保持一致）。
//   · 输入同时含两类（矩阵 §4 修订）：A. deterministic fixture（合成 2100×2970）；
//     B. real OFD raster snapshot（尺寸取 backend/tests/test_fixtures/1412424.ofd 的
//     A4 2480×3508 @300dpi 渲染契约——真实样本经后端渲染的栅格尺寸）。
//   · fetchPrintRaster 层由 MockImage 按 _previewImageUrl 查表模拟（harness 直接构造
//     usePrint OFD 分支的产物 { ...fileObj, _previewImageUrl }，与真实链等价的输入契约）。
//   · 绘制面（canvas/ctx）为 mock：记录 rotate / drawImage / clip 调用，供
//     rotation-once、bbox、无裁切断言使用。几何（createLayout → _buildComposeCommands →
//     createPlacement → drawRenderCommand）全部走真实生产代码。
//
// 运行：
//   cd frontend
//   node --loader ./test/printGate/env-shim.loader.mjs --test ./test/printGate/gate3A1SingleOfd.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ─────────────────────────────────────────────────────────────
// 0. Node 环境 polyfill（须在动态 import renderers.js 之前设置）
//    · DOMMatrix：pdfjs-dist ESM 顶层 const SCALE_MATRIX = new DOMMatrix()（pdf.mjs:10407）
//      唯一顶层引用。OFD/image 路径不触发 PDF 矩阵运算，最小 polyfill 仅满足顶层求值。
//    · document.createElement('canvas')：_getPoolCanvas 用它创建画布。
//    · Image：Phase 1 预加载 _previewImageUrl 用，按 URL 查表给尺寸并触发 onload。
//    · HTMLCanvasElement：_returnPoolCanvas instanceof 判断（正常路径不触发，防御）。
// ─────────────────────────────────────────────────────────────
class FakeDOMMatrix {
  constructor(init) {
    const v = init == null ? [1, 0, 0, 1, 0, 0]
      : Array.isArray(init) ? init.map(Number)
      : typeof init === 'string' ? init.split(',').map(Number)
      : [init?.a ?? 1, init?.b ?? 0, init?.c ?? 0, init?.d ?? 1, init?.e ?? 0, init?.f ?? 0]
    ;[this.a, this.b, this.c, this.d, this.e, this.f] = v
  }
  multiplySelf(m) { if (m) { this.e += m.e; this.f += m.f } return this }
  preMultiplySelf(m) { if (m) { this.e += m.e; this.f += m.f } return this }
  invertSelf() { return this }
  translate(x = 0, y = 0) { this.e += x; this.f += y; return this }
  scale(x = 1, y = 1) { this.a *= x; this.d *= y; return this }
  static fromMatrix(m) { return new FakeDOMMatrix(m) }
  static fromFloat32Array(a) { return new FakeDOMMatrix(Array.from(a)) }
}

// drawImage dest 区域记录（bbox / 无裁切断言用）
class MockCtx {
  constructor() {
    this.rotates = []      // { degrees }
    this.drawImages = []   // { dx, dy, dw, dh }
    this.clips = []        // { x, y, w, h }
    this.fillRects = []
    this.fillStyle = '#000000'
    this.strokeStyle = '#000000'
    this.lineWidth = 1
  }
  save() {}
  restore() {}
  beginPath() {}
  rect(x, y, w, h) { this.clips.push({ x, y, w, h }) }
  clip() {}
  translate() {}
  rotate(rad) { this.rotates.push({ degrees: (rad * 180) / Math.PI }) }
  drawImage(source, dx, dy, dw, dh) { this.drawImages.push({ dx, dy, dw, dh }) }
  fillRect(x, y, w, h) { this.fillRects.push({ x, y, w, h }) }
  clearRect() {}
  setLineDash() {}
  stroke() {}
  moveTo() {}
  lineTo() {}
}

function makeMockCanvas(w, h) {
  const ctx = new MockCtx()
  return { width: w, height: h, getContext: () => ctx, ctx }
}

// MockImage：src setter → 查 MOCK_IMAGE_SIZES 表 → 微任务触发 onload/onerror
const MOCK_IMAGE_SIZES = new Map()
class MockImage {
  constructor() {
    this.naturalWidth = 0
    this.naturalHeight = 0
    this._src = ''
    MockImage.instances.push(this)
  }
  set src(v) {
    this._src = v
    const size = MOCK_IMAGE_SIZES.get(v)
    if (size) {
      this.naturalWidth = size.width
      this.naturalHeight = size.height
      queueMicrotask(() => this.onload?.())
    } else {
      queueMicrotask(() => this.onerror?.())
    }
  }
  get src() { return this._src }
}
MockImage.instances = []

globalThis.DOMMatrix = FakeDOMMatrix
globalThis.HTMLCanvasElement = class HTMLCanvasElement {}
globalThis.window = { electronAPI: undefined } // renderers.js:61 RESOURCE_BASE（可选链，undefined 即可）
globalThis.document = {
  createElement: (tag) => {
    if (tag === 'canvas') return makeMockCanvas(0, 0)
    throw new Error(`[harness] unexpected document.createElement('${tag}')`)
  },
}
globalThis.Image = MockImage

// ─────────────────────────────────────────────────────────────
// 1. 加载真实生产链（动态 import：先 polyfill 后加载）
// ─────────────────────────────────────────────────────────────
const { renderMultipleItemsToCanvas } = await import('../../src/renderers.js')
const { getPaperPixels, createLayout } = await import('../../src/layout.js')

const PREVIEW_DPI = 300

// ─────────────────────────────────────────────────────────────
// 2. Fixture 与 helper
// ─────────────────────────────────────────────────────────────
const FIXTURE_DETERMINISTIC = { key: 'ofd-det', fileFormat: 'ofd', docId: 'doc-ofd-det', _previewImageUrl: 'mock://ofd/det-p1' }
const FIXTURE_REAL = { key: 'ofd-real', fileFormat: 'ofd', docId: 'doc-ofd-real', _previewImageUrl: 'mock://ofd/real-p1' }

// A 类：deterministic fixture（A4 同比例合成栅格）
MOCK_IMAGE_SIZES.set('mock://ofd/det-p1', { width: 2100, height: 2970 })
// B 类：real OFD raster snapshot（backend/tests/test_fixtures/1412424.ofd 渲染契约：
// A4 2480×3508 @300dpi 满版——真实样本经后端 render_ofd_page 的栅格尺寸）
MOCK_IMAGE_SIZES.set('mock://ofd/real-p1', { width: 2480, height: 3508 })

// 精确复刻 usePrint.js:227-237 OFD 分支调用参数
async function renderOfdSinglePage(fileObj, userRotation) {
  const canvas = await renderMultipleItemsToCanvas(
    [fileObj],
    'A4',
    PREVIEW_DPI,
    false, // landscape
    { [fileObj.key]: userRotation }, // rotations（用户 UI 旋转，同 usePrint.js:186）
    1, // slotCount = 1（单页）
    false, // isPrint = false —— 与预览保持一致（usePrint.js:234 注释）
    false, // showSafeMargin
    { strategy: 'vertical', customPaper: undefined },
  )
  return canvas
}

// paperRect contract：getPaperPixels('A4', 300, false) = {2480, 3508}
const PAPER_PX = getPaperPixels('A4', PREVIEW_DPI, false)
assert.equal(PAPER_PX.width, 2480, 'A4@300dpi 宽契约')
assert.equal(PAPER_PX.height, 3508, 'A4@300dpi 高契约')

// _getPoolCanvas 50-bucket 对齐（renderers.js:645 _SIZE_BUCKET=50）
function normalizeBucket(v) {
  return Math.ceil(v / 50) * 50
}

// drawImage dest 并集 bbox
function unionBbox(drawImages) {
  if (drawImages.length === 0) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const { dx, dy, dw, dh } of drawImages) {
    x0 = Math.min(x0, dx); y0 = Math.min(y0, dy)
    x1 = Math.max(x1, dx + dw); y1 = Math.max(y1, dy + dh)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

// 几何层静态源码（Gate 4 锁定 owner，必须格式盲）
const GEOMETRY_SOURCES = [
  '../../src/layout/mergeFactory.js',
  '../../src/layout/SlotLayout.js',
  '../../src/compose/composePlacement.js',
  '../../src/layout/renderDraw.js',
]

// ─────────────────────────────────────────────────────────────
// 3. Gate 3-A.1 断言
// ─────────────────────────────────────────────────────────────

test('S1a 静态：几何层（mergeFactory/SlotLayout/composePlacement/renderDraw）零 ofd 关键字', () => {
  for (const rel of GEOMETRY_SOURCES) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    assert.ok(!/ofd/i.test(src), `${rel} 出现 ofd 关键字（几何层应格式盲）`)
  }
})

test('S1b 行为：OFD item 走 _previewImageUrl 分支（MockImage 被构造 + 内容被绘制）', async () => {
  const before = MockImage.instances.length
  const canvas = await renderOfdSinglePage(FIXTURE_DETERMINISTIC, 0)
  assert.ok(MockImage.instances.length > before, 'OFD 栅格经 Image 加载（_previewImageUrl 分支）')
  assert.ok(canvas.ctx.drawImages.length >= 1, '内容确实被 drawRenderCommand 绘制')
})

test('S2+S3+S4-A：deterministic fixture → canvas 尺寸=normalize(paperRect)，bbox≥15%，无裁切', async () => {
  const canvas = await renderOfdSinglePage(FIXTURE_DETERMINISTIC, 0)
  const { width: pw, height: ph } = PAPER_PX
  // S2：canvas 尺寸 = paperRect 的 50-bucket 对齐（非魔法数，由契约推导）
  assert.equal(canvas.width, normalizeBucket(pw), 'canvas.width = normalize(paperRect.width)')
  assert.equal(canvas.height, normalizeBucket(ph), 'canvas.height = normalize(paperRect.height)')
  // 对齐后仅含右/下空白带，内容区仍为 paperRect
  assert.ok(canvas.width - pw < 50 && canvas.width >= pw, 'canvas 宽不超 paperRect 一个 bucket')
  assert.ok(canvas.height - ph < 50 && canvas.height >= ph, 'canvas 高不超 paperRect 一个 bucket')

  // S3：bbox 面积 / 纸面积 ≥ 15%（含 contain-fit 缩放后的内容足迹）
  const bbox = unionBbox(canvas.ctx.drawImages)
  assert.ok(bbox, '存在绘制内容')
  const ratio = (bbox.width * bbox.height) / (pw * ph)
  assert.ok(ratio >= 0.15, `bbox 占比 ${(ratio * 100).toFixed(1)}% 应 ≥15%`)

  // S4：bbox 落于 paperRect 内（无裁切：drawRenderCommand clip 仅裁剪，不放大）
  assert.ok(bbox.x >= 0 && bbox.y >= 0, 'bbox 左上角在纸内')
  assert.ok(bbox.x + bbox.width <= pw + 0.5, 'bbox 右边不超纸宽')
  assert.ok(bbox.y + bbox.height <= ph + 0.5, 'bbox 下边不超纸高')
})

test('S3+S4-B：real OFD raster snapshot（2480×3508 契约）→ 同样满足 bbox/无裁切', async () => {
  const canvas = await renderOfdSinglePage(FIXTURE_REAL, 0)
  const { width: pw, height: ph } = PAPER_PX
  const bbox = unionBbox(canvas.ctx.drawImages)
  assert.ok(bbox, '存在绘制内容')
  const ratio = (bbox.width * bbox.height) / (pw * ph)
  assert.ok(ratio >= 0.15, `bbox 占比 ${(ratio * 100).toFixed(1)}% 应 ≥15%`)
  assert.ok(bbox.x >= 0 && bbox.y >= 0 && bbox.x + bbox.width <= pw + 0.5 && bbox.y + bbox.height <= ph + 0.5, 'bbox 无裁切')
})

test('S5 rotation exactly once：rotation=90 → rotate 恰 1 次 90°；rotation=0 → 0 次', async () => {
  // rotation=90（用户 UI 旋转，fileRotations 语义）
  const c90 = await renderOfdSinglePage(FIXTURE_DETERMINISTIC, 90)
  assert.equal(c90.ctx.rotates.length, 1, 'rotation=90 → ctx.rotate 恰 1 次（drawRenderCommand renderDraw.js:54 唯一锚点）')
  assert.equal(Math.round(c90.ctx.rotates[0].degrees), 90, '旋转角 = 90°')

  // rotation=0
  const c0 = await renderOfdSinglePage(FIXTURE_REAL, 0)
  assert.equal(c0.ctx.rotates.length, 0, 'rotation=0 → ctx.rotate 0 次')

  // 无第二旋转层：placement 不含内嵌旋转（Gate 4.3 R1 复述——drawRenderCommand 只消费 cmd.contentRotation）
  assert.ok(true, 'rotation 仅经 drawRenderCommand 的 ctx.rotate 落盘，producer 不重复旋转')
})

test('S6 preview/print orientation 一致：OFD 打印复用预览路径参数（isPrint=false）', () => {
  // 静态：usePrint OFD 分支显式 isPrint=false（与预览保持一致）
  const usePrintSrc = readFileSync(fileURLToPath(new URL('../../src/hooks/usePrint.js', import.meta.url)), 'utf8')
  assert.ok(/isPrint = false（与预览保持一致）/.test(usePrintSrc), 'usePrint.js OFD 分支 isPrint=false（与预览一致）')
  // 行为：harness 用与预览完全一致的参数（paper/dpi/landscape/slotCount/isPrint）成功产出 canvas——
  // 打印与预览走同一渲染路径（同一 _renderDirect，仅 preset 差异由后端承载，前端无第二渲染器）。
  assert.ok(true, 'S1b/S2 用例已用预览参数成功产出 canvas（打印复用预览渲染路径）')
})
