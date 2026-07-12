import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePaperLayout } from '../previewState.js'
import { buildRenderLayout } from './RenderLayoutFactory.js'
import { buildRenderSpec, appendRenderSpecToUrl, renderSpecSignature, normalizeRenderSpec } from './renderSpec.js'
import { getRenderEnginePreviewUrl } from '../utils/previewTarget.js'

function makeLayout({ paperSize = 'A4', margins = { top: 0, right: 0, bottom: 0, left: 0 }, pageSize = { w: 1240, h: 1754 }, pageOrientation = 'portrait', rotation = 0 } = {}) {
  const paperLayout = computePaperLayout({ paperSize, customPaper: null, margins })
  const documentState = { pageSize, pageOrientation, rotation }
  return buildRenderLayout(paperLayout, documentState)
}

test('buildRenderSpec → 纯 DTO，含解析后 placement/rotation/clip，不含 fitMode 等意图', () => {
  const rl = makeLayout()
  const spec = buildRenderSpec(rl, { docId: 'abc123', page: 2, dpi: 300, marginsMm: { top: 5, right: 5, bottom: 5, left: 5 } })
  assert.ok(spec)
  assert.equal(spec.docId, 'abc123')
  assert.equal(spec.page, 2)
  assert.equal(spec.dpi, 300)
  assert.equal(spec.paper.width, rl.paper.paperRect.w)
  assert.equal(spec.paper.height, rl.paper.paperRect.h)
  assert.ok('scale' in spec.placement && 'offsetX' in spec.placement && 'offsetY' in spec.placement)
  assert.equal(spec.rotation, 0)
  assert.deepEqual(spec.margin, { top: 5, right: 5, bottom: 5, left: 5 })
  assert.deepEqual(spec.clip, { x: rl.clip.x, y: rl.clip.y, width: rl.clip.width, height: rl.clip.height })
  // 关键：不携带 fitMode / alignment / paperKey 等推导意图
  assert.equal('fitMode' in spec, false)
  assert.equal('alignment' in spec, false)
})

test('buildRenderSpec → renderLayout 未就绪返回 null', () => {
  assert.equal(buildRenderSpec(null, { docId: 'x' }), null)
  assert.equal(buildRenderSpec({}, { docId: 'x' }), null)
})

test('appendRenderSpecToUrl → 保留 base 的 ?page=1，追加后端忽略的新字段', () => {
  const base = 'http://localhost:5000/preview/abc123?page=1'
  const rl = makeLayout({ pageSize: { w: 1240, h: 1754 } })
  const spec = buildRenderSpec(rl, { docId: 'abc123', page: 1, dpi: 300, marginsMm: { top: 3, right: 3, bottom: 3, left: 3 } })
  const url = appendRenderSpecToUrl(base, spec)
  assert.ok(url.startsWith(base + '&'), `应追加到 base 之后，实得 ${url}`)
  const u = new URL(url)
  assert.equal(u.searchParams.get('page'), '1')          // 原参数保留
  assert.equal(u.searchParams.get('paper_w'), String(rl.paper.paperRect.w))
  assert.equal(u.searchParams.get('paper_h'), String(rl.paper.paperRect.h))
  assert.equal(u.searchParams.get('scale'), String(rl.placement.scale))
  assert.equal(u.searchParams.get('ox'), String(rl.placement.offsetX))
  assert.equal(u.searchParams.get('oy'), String(rl.placement.offsetY))
  assert.equal(u.searchParams.get('clip_w'), String(rl.clip.width))
  assert.equal(u.searchParams.get('dpi'), '300')
  // 用户审核②：线路版本号随 RenderSpec 一起发送
  assert.equal(u.searchParams.get('spec'), 'v1')
  // 用户审核④：调试签名，与 renderSpecSignature(spec) 复现一致（后端 Step 4 可回显比对）
  assert.equal(u.searchParams.get('spec_sig'), renderSpecSignature(spec))
  // 不应出现后端已识别的、会即时改变渲染的字段
  assert.equal(u.searchParams.has('rotation') ? u.searchParams.get('rotation') : '0', '0')
  assert.equal(u.searchParams.has('paper'), false)        // 未发纸型 key
  assert.equal(u.searchParams.has('margin'), false)       // 未发旧 margin key
})

test('appendRenderSpecToUrl → spec 为 null 原样返回', () => {
  const base = 'http://localhost:5000/preview/abc123?page=1'
  assert.equal(appendRenderSpecToUrl(base, null), base)
})

test('getRenderEnginePreviewUrl → 带 spec 追加参数；非 http 返回 null；2 参时行为不变', () => {
  const rl = makeLayout()
  const spec = buildRenderSpec(rl, { docId: 'abc123', page: 1, dpi: 300 })
  const httpFile = { _previewImageUrl: 'http://localhost:5000/preview/abc123?page=1' }
  const withSpec = getRenderEnginePreviewUrl(httpFile, true, spec)
  assert.ok(withSpec.includes('paper_w='), '应追加 spec 参数')
  assert.ok(withSpec.startsWith('http://localhost:5000/preview/abc123?page=1&'), 'base 不变')
  assert.equal(new URL(withSpec).searchParams.get('spec'), 'v1', '应带线路版本号')
  // 2 参旧契约：不带 spec 时原样返回（既有单测不受影响）
  assert.equal(getRenderEnginePreviewUrl(httpFile, true), 'http://localhost:5000/preview/abc123?page=1')
  // 非 http → null
  assert.equal(getRenderEnginePreviewUrl({ _previewImageUrl: 'blob:http://x/abc' }, true, spec), null)
  assert.equal(getRenderEnginePreviewUrl(httpFile, false, spec), null)
})

test('renderSpecSignature → 与字段插入顺序无关（建议一：stable serialization）', () => {
  const value = {
    docId: 'abc123', page: 2, dpi: 300,
    paper: { width: 1240, height: 1754 },
    margin: { top: 5, right: 5, bottom: 5, left: 5 },
    placement: { scale: 0.5, offsetX: 10, offsetY: 20 },
    rotation: 0,
    clip: { x: 0, y: 0, width: 1240, height: 1754 },
  }
  // 打乱插入顺序（含嵌套对象），值完全相同
  const scrambled = {
    rotation: 0,
    clip: { width: 1240, height: 1754, x: 0, y: 0 },
    placement: { offsetY: 20, scale: 0.5, offsetX: 10 },
    margin: { left: 5, top: 5, bottom: 5, right: 5 },
    dpi: 300, page: 2, paper: { height: 1754, width: 1240 }, docId: 'abc123',
  }
  assert.equal(renderSpecSignature(scrambled), renderSpecSignature(value),
    '字段顺序不同但值相同，签名必须一致')
})

test('renderSpecSignature → 浮点抖动不影响签名（建议一：round to 6 位）', () => {
  const base = {
    rotation: 0, clip: { x: 0, y: 0, width: 1240, height: 1754 },
    placement: { scale: 0.3333334, offsetX: 10, offsetY: 20 },
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    dpi: 300, page: 1, paper: { width: 1240, height: 1754 }, docId: 'x',
  }
  const jittered = JSON.parse(JSON.stringify(base))
  jittered.placement.scale = 0.33333341 // 第 8 位差异，6 位内应被抹平
  assert.equal(renderSpecSignature(jittered), renderSpecSignature(base),
    '6 位小数内的浮点抖动不应改变签名')
  // 明显不同的布局应产生不同签名（确保不是恒等）
  const different = JSON.parse(JSON.stringify(base))
  different.placement.scale = 0.9
  assert.notEqual(renderSpecSignature(different), renderSpecSignature(base))
})

test('normalizeRenderSpec → key 排序且浮点四舍五入到 6 位，且不修改入参', () => {
  const input = { b: 2, a: { z: 0.123456789, y: 1 } }
  assert.deepEqual(normalizeRenderSpec(input), { a: { y: 1, z: 0.123457 }, b: 2 })
  assert.deepEqual(input, { b: 2, a: { z: 0.123456789, y: 1 } }, '不修改入参')
})

test('renderSpecSignature → 跨语言共享常量锁定（与后端 render_spec_sig.py 一致）', () => {
  // 与 backend/tests/fixtures/render_spec_sample.json 同结构。
  // 任何一端改动归一化/序列化都必须同步另一端并重算此常量（Commit A 核心约束）。
  const spec = {
    docId: 'doc-abc-123', page: 1, dpi: 300,
    paper: { width: 1240, height: 1754 },
    margin: { top: 5, right: 5, bottom: 5, left: 5 },
    placement: { scale: 0.4999999, offsetX: 10.25, offsetY: 20.5 },
    rotation: 0,
    clip: { x: 0, y: 0, width: 1240, height: 1754 },
  }
  assert.equal(renderSpecSignature(spec), '30df8bd0')
})
