// nodePolyfill.mjs — Gate 3-A 系列共享 Node 环境 polyfill（test-only infrastructure）。
//
// 在 plain Node 下加载前端 consumer 链（renderers.js → pdfjs-dist / document / Image / window）
// 所需的最小全局 polyfill。供 gate3A1SingleOfd.test.mjs / gate3A2Rotation.test.mjs 及后续
// 3-A.3+ harness 共用（避免每文件重复内联）。
//
// 覆盖：
//   · DOMMatrix      — pdfjs-dist ESM 顶层 `const SCALE_MATRIX = new DOMMatrix()`（pdf.mjs:10407）
//                      唯一顶层引用；OFD/image 路径不触发 PDF 矩阵运算，最小实现仅满足顶层求值。
//   · HTMLCanvasElement — _returnPoolCanvas 的 instanceof 判断（正常路径不触发，防御）。
//   · window         — renderers.js:61 `window.electronAPI?.resourcePath`（可选链，undefined 即可）。
//   · document       — _getPoolCanvas 的 document.createElement('canvas')。
//   · Image          — Phase 1 预加载 _previewImageUrl 用，按 MOCK_IMAGE_SIZES 查表给尺寸并触发 onload。
//   · OffscreenCanvas — **保持 undefined**：renderMultipleItemsToCanvas 依赖
//                      `typeof OffscreenCanvas === 'undefined'` 走 _renderDirect（主线程直渲）。
//
// MockCtx 记录 rotate / drawImage / clip 调用，供 rotation-once、bbox、无裁切断言使用。
// 几何（createLayout → _buildComposeCommands → createPlacement → drawRenderCommand）全部走真实生产代码。

export class FakeDOMMatrix {
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
export class MockCtx {
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

export function makeMockCanvas(w, h) {
  const ctx = new MockCtx()
  return { width: w, height: h, getContext: () => ctx, ctx }
}

// MockImage：src setter → 查 MOCK_IMAGE_SIZES 表 → 微任务触发 onload/onerror
export const MOCK_IMAGE_SIZES = new Map()
export class MockImage {
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

/**
 * 安装 Node 全局 polyfill。必须在动态 import 前端 consumer 链之前调用。
 */
export function installNodePolyfills() {
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
  // OffscreenCanvas 保持 undefined → renderMultipleItemsToCanvas 走 _renderDirect（主线程直渲）
}
