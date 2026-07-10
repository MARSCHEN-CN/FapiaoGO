// =============================================================================
// documentEngine.js — P2B 统一入口门面（v12 契约的 JS 实现）
// -----------------------------------------------------------------------------
// 设计目标：
//   - 所有预览/打印入口统一走 DocumentEngine.getImage / compose；
//   - 缓存命中判定唯一在此（provider.open），Renderer 只"渲染 + 写 Repository + 返 ImageHandle"；
//   - 核心逻辑无 DOM / 无 Node 专属依赖，可在浏览器与 node --test 下单测。
//
// 职责边界（见 merge-mode-pdfjs-migration-plan.md §4 / §12 / §13）：
//   DocumentEngine : 唯一编排（find → 命中返 Handle / 未命中 → Renderer.render）
//   ImageProvider  : 纯读门面（resolve/find/handle/open/prefetch；禁 CacheManager 方法）
//   ImageRepository: 唯一存储（putRenderedImage 仅 Renderer 调；引用计数/生命周期在此）
//   Renderer       : 独占有 Repository 写入；不命中判断、不读缓存
//   ImageHandle    : RAII，作用域结束自动 release（业务层用 await using / with）
// =============================================================================

// ───────────────────────────── 灰度开关（原则⑧ 灰度可回滚） ─────────────────────────────
let _useDocumentEngine = false
export function setUseDocumentEngine(v) { _useDocumentEngine = !!v }
export function isDocumentEngineEnabled() { return _useDocumentEngine }

// ───────────────────────────── 确定性 id（与 Renderer 共用，保证命中一致） ─────────────────────────────
// 同步哈希（FNV-1a）：仅作 cache key，非加密用途；浏览器/Node 通用，避免引入 node:crypto。
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // 转无符号 32 位十六进制
  return (h >>> 0).toString(16).padStart(8, '0')
}

function normalizeSourceForId(s) {
  return {
    kind: s.kind,
    doc: s.docId ?? s.path ?? s.url ?? s.bitmap ? 'mem' : null,
    page: s.page ?? 0,
    dpi: s.dpi ?? 0,
    rotation: s.rotation ?? 0,
    paperKey: s.paperKey ?? null,
    isLandscape: s.isLandscape ?? false,
  }
}

export function resolveId(source) {
  // Provider.resolve 与 Renderer 必须用同一函数，否则命中不一致。
  return 'img_' + fnv1a(JSON.stringify(normalizeSourceForId(source)))
}

// ───────────────────────────── ImageRef（真 Value Object，frozen） ─────────────────────────────
// id 仅由 Renderer 创建并写入；任何层禁止改/重算（原则 11 / §5.1 / §12 ②）。
export function makeImageRef(id, width, height, dpi, meta = {}) {
  const m = Object.freeze({
    mime: meta.mime ?? 'application/octet-stream',
    source: meta.source ?? '',
    page: meta.page ?? 0,
    rotation: meta.rotation ?? 0,
    ...meta,
  })
  return Object.freeze({
    id,
    width,
    height,
    dpi,
    meta: m,
  })
}

export function isImageRefFrozen(ref) {
  return !!ref && Object.isFrozen(ref) && Object.isFrozen(ref.meta)
}

// ───────────────────────────── PixelInfo / PixelHandle ─────────────────────────────
export function makePixelInfo(ref, pixels) {
  const channels = pixels?.channels ?? 4
  const stride = pixels?.stride ?? ref.width * channels
  return Object.freeze({
    width: ref.width,
    height: ref.height,
    channels,
    stride,
    colorspace: pixels?.colorspace ?? 'srgb',
  })
}

// 内存实现：PixelHandle 包裹已存储的像素。未来 GPU / MMAP / Remote 仅改此处（§5.2 / §12 ④）。
export class MemoryPixelHandle {
  constructor(ref, pixels) {
    this._ref = ref
    this._pixels = pixels
  }
  async asBytes() { return this._pixels }
  async *asStream() { yield this._pixels }
  async asBitmap() { return this._pixels } // 浏览器端真实实现返回 ImageBitmap；Node 测试返回像素对象
  info() { return makePixelInfo(this._ref, this._pixels) }
}

// ───────────────────────────── ImageHandle（RAII 自动 release） ─────────────────────────────
export class ConcreteImageHandle {
  constructor(ref, releaseFn) {
    this.ref = ref            // 不可变值，交给 Compose / Encoder
    this._releaseFn = releaseFn
    this._released = false
  }
  async [Symbol.asyncDispose]() { await this.release() }
  async release() {
    if (this._released) return
    this._released = true
    await this._releaseFn()
  }
  get released() { return this._released }
}

// ───────────────────────────── ImageRepository（唯一写入方经 Renderer） ─────────────────────────────
export class InMemoryImageRepository {
  constructor(maxSize = 200) {
    this._store = new Map()   // id -> { ref, pixels, refs:number }
    this._maxSize = maxSize
  }
  // ⚠️ 仅 Renderer 调用（render 内部）
  putRenderedImage(id, pixels, ref) {
    const existing = this._store.get(id)
    if (existing) { existing.refs += 1; return }
    this._store.set(id, { ref, pixels, refs: 1 })
    if (this._store.size > this._maxSize) this._evictOldest()
  }
  handle(id) {
    const e = this._store.get(id)
    return e ? new MemoryPixelHandle(e.ref, e.pixels) : null
  }
  find(id) {
    const e = this._store.get(id)
    return e ? e.ref : null
  }
  acquire(id) {
    const e = this._store.get(id)
    if (e) e.refs += 1
  }
  release(id) {
    const e = this._store.get(id)
    if (!e) return
    e.refs -= 1
    if (e.refs <= 0) this._store.delete(id)
  }
  evict(id) {
    const e = this._store.get(id)
    if (e && e.refs <= 0) this._store.delete(id)
  }
  get size() { return this._store.size }
  _evictOldest() {
    const first = this._store.keys().next().value
    if (first !== undefined) this._store.delete(first)
  }
}

// ───────────────────────────── ImageProvider（纯读门面） ─────────────────────────────
// 🔒 仅 resolve/find/handle/open/prefetch。无 invalidate/clear/stats/memory/pin（§12 ③b）。
export class ImageProvider {
  constructor(repository) { this._repo = repository }
  resolve(source) { return resolveId(source) }
  find(id) { return this._repo.find(id) }
  handle(id) { return this._repo.handle(id) }
  // 命中：find + acquire + 构造 Handle（Reader 门面正当职责，非 CacheManager）
  open(id) {
    const ref = this._repo.find(id)
    if (!ref) return null
    this._repo.acquire(id)
    return new ConcreteImageHandle(ref, () => this._repo.release(id))
  }
  async prefetch(_sources) { /* P2B 占位：真实实现触发预热渲染 */ }
}

// ───────────────────────────── Renderer（独占有 Repository 写入） ─────────────────────────────
// Renderer.render：解析 → 像素 → Repository.putRenderedImage（+1）→ 返 ImageHandle。
// 不命中判断、不读缓存（原则 17 / §12 ⑤）。
export class StubRenderer {
  constructor(repository, opts = {}) {
    this._repo = repository
    this._opts = opts
  }
  async render(source) {
    const id = resolveId(source)   // 与 provider.resolve 共用，保证命中一致
    const w = this._opts.width ?? 100
    const h = this._opts.height ?? 140
    const dpi = source.dpi ?? 72
    const pixels = { data: new Uint8Array(w * h * 4), channels: 4, stride: w * 4, colorspace: 'srgb' }
    const ref = makeImageRef(id, w, h, dpi, {
      mime: 'image/png',
      source: source.docId ?? source.path ?? source.url ?? 'stub',
      page: source.page ?? 0,
      rotation: source.rotation ?? 0,
    })
    this._repo.putRenderedImage(id, pixels, ref)
    return new ConcreteImageHandle(ref, () => this._repo.release(id))
  }
}

// ───────────────────────────── DocumentEngine（唯一编排入口） ─────────────────────────────
export class DocumentEngine {
  constructor(provider, renderer) {
    this.provider = provider
    this.renderer = renderer
  }
  // 命中判定唯一在此（provider.open）；未命中才进 Renderer.render（Renderer 写 Repository + 返 Handle）。
  // DocumentEngine 不直接持 Repository（依赖倒置，§12 ⑤）。
  async getImage(source) {
    const id = this.provider.resolve(source)
    const hit = this.provider.open(id)
    if (hit) return hit
    return await this.renderer.render(source)
  }
}

export function createDocumentEngine({ renderer, repository }) {
  const provider = new ImageProvider(repository)
  return new DocumentEngine(provider, renderer)
}
