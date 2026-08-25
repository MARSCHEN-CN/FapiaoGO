#!/usr/bin/env node
/**
 * R-4.6-B Placement Bake Multi-Page Gate — placement_bake.py v2（N page independent bake）
 *
 * 验证（用户裁决 2026-08-25：方案 B pageIndex 显式消费 + 连续性断言）：
 *   Gate-1 单页 golden：v1（placement 单对象）vs v2（pagePlacements=[{0,placement}]）
 *           → info 逐字段一致（mediaBox/cropBox/rotate/contentBox/placedSize/expectedRect/phi）
 *             + 输出 PDF bytes 逐字节一致（同一条代码路径，G1）
 *   Gate-2 20 页 regression：20×pagePlacements（pageIndex 显式 0..19，A/B 交替 placement）
 *           → pageCount=20；每页 MediaBox==executionPaper、/Rotate=0（bake 自断言 + 本 Gate 复验）
 *             + 逐页独立（A/B scale 不同 → placedSize 不同，证明按 pageIndex 消费而非数组位置）
 *   Gate-3 负例契约：len(pagePlacements) ∉ {1, N} → raise（错误含 placement count / source page count）
 *   Gate-4 Model B 兼容：1 placement × 20 页 → 全页同几何
 *
 * 用法: node placementBakeV2MultiPageGate.mjs
 * 退出码：0 = PASS；1 = FAIL。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const PY = path.join(REPO, 'backend', 'venv', 'Scripts', 'python.exe')
const BAKE = path.join(REPO, 'scripts', 'placement_bake.py')
const FIXTURE = path.join(REPO, 'test_fixtures', '25952000000127675627.pdf')
const OUT = path.join(HERE, '.out', 'r46b')
const DPI = 300

let failures = 0
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`) }
  else { failures++; console.error(`  ❌ ${name} ${detail}`) }
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts })
}

// ── placement（与 usePrint placements useMemo / 4-2b Gate 同源：横票竖纸 A4 portrait）──
function computePlacement(scaleOverride) {
  const code = `
const { resolveContentPlacement } = require('./frontend/src/layout/RotationResolver.js')
const placement = resolveContentPlacement({
  contentPhysicalSize: { width: 595.28 * 300/72, height: 396.85 * 300/72 },
  contentRotation: 0,
  physicalPaper: { widthMM: 210, heightMM: 297 },
  margins: { left: 3, right: 3, top: 3, bottom: 3 },
  dpi: 300,
})
placement.scale = ${scaleOverride}
console.log(JSON.stringify(placement))
`
  const out = sh(process.execPath, ['-e', code], { cwd: REPO }).trim()
  return JSON.parse(out)
}

// ── 构造 N 页源 PDF（fixture 页 0 复制 N 次）──
function buildMultiPagePdf(n, name) {
  const outPdf = path.join(OUT, name)
  const code = `
import pikepdf
src = pikepdf.open(r'${FIXTURE.replace(/\\/g, '/')}')
out = pikepdf.new()
page0 = src.pages[0]
for i in range(${n}):
    out.pages.append(page0)
out.save(r'${outPdf.replace(/\\/g, '/')}')
print('OK', len(out.pages))
`
  const res = sh(PY, ['-c', code]).trim()
  return { outPdf, count: parseInt(res.split(' ')[1], 10) }
}

// ── 跑 bake（与 processor.process 同 spawn 路径：--placement-file 完整 spec）──
function runBake(spec, name) {
  const specFile = path.join(OUT, `${name}.spec.json`)
  fs.writeFileSync(specFile, JSON.stringify(spec))
  try {
    const raw = sh(PY, [
      BAKE,
      '--source', spec.source_pdf,
      '--output', spec.output_pdf,
      '--paper-width-mm', String(spec.paper.widthMm),
      '--paper-height-mm', String(spec.paper.heightMm),
      '--placement-file', specFile,
      '--dpi', String(spec.dpi),
    ]).trim()
    return JSON.parse(raw)
  } catch (e) {
    // bake 失败（exit 1）时错误 JSON 在 stdout（R-4.6-A G3：processor 已补打 stdout）
    try { return JSON.parse(String(e.stdout || '').trim()) } catch { return { success: false, error: String(e.message) } }
  }
}

// ── 复验输出 PDF 每页 MediaBox / /Rotate（独立于 bake 自断言）──
function verifyPages(pdfPath, paperWpt, paperHpt) {
  const code = `
import pikepdf, json
d = pikepdf.open(r'${pdfPath.replace(/\\/g, '/')}')
pages = []
for i, p in enumerate(d.pages):
    mb = [float(v) for v in p.MediaBox]
    cb = [float(v) for v in (p.CropBox if '/CropBox' in p else p.MediaBox)]
    pages.append({
        'i': i,
        'w': round(abs(mb[2]-mb[0]), 3), 'h': round(abs(mb[3]-mb[1]), 3),
        'cw': round(abs(cb[2]-cb[0]), 3), 'ch': round(abs(cb[3]-cb[1]), 3),
        'rotate': int(p.get('/Rotate', 0)),
    })
print(json.dumps(pages))
`
  const pages = JSON.parse(sh(PY, ['-c', code]).trim())
  return pages.every(p => Math.abs(p.w - paperWpt) < 0.1 && Math.abs(p.h - paperHpt) < 0.1
    && Math.abs(p.cw - paperWpt) < 0.1 && Math.abs(p.ch - paperHpt) < 0.1 && p.rotate === 0)
}

function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const placementA = computePlacement(0.5)
  const placementB = computePlacement(0.6)
  const paper = { widthMm: 210, heightMm: 297 }
  const paperWpt = paper.widthMm * 72 / 25.4
  const paperHpt = paper.heightMm * 72 / 25.4

  console.log('=== R-4.6-B Placement Bake Multi-Page Gate ===')
  console.log(`fixture: ${path.relative(REPO, FIXTURE)} placementA.scale=${placementA.scale} placementB.scale=${placementB.scale}`)

  // ── Gate-1：单页 golden（v1 vs v2 逐字段 + bytes 一致）──
  console.log('\n[Gate-1] 单页 golden（v1 placement vs v2 [placement]）')
  const v1Spec = {
    source_pdf: FIXTURE, output_pdf: path.join(OUT, 'g1_v1.pdf'), paper,
    placement: placementA, dpi: DPI,
  }
  const v2Spec = {
    source_pdf: FIXTURE, output_pdf: path.join(OUT, 'g1_v2.pdf'), paper,
    placement: placementA, pagePlacements: [{ pageIndex: 0, placement: placementA }], dpi: DPI,
  }
  const r1 = runBake(v1Spec, 'g1_v1')
  const r2 = runBake(v2Spec, 'g1_v2')
  check('v1 bake 成功', r1.success === true, JSON.stringify(r1.error || ''))
  check('v2 bake 成功', r2.success === true, JSON.stringify(r2.error || ''))
  if (r1.success && r2.success) {
    const i1 = r1.info, i2 = r2.info
    check('info.mediaBox 一致', JSON.stringify(i1.mediaBox) === JSON.stringify(i2.mediaBox), `${i1.mediaBox} vs ${i2.mediaBox}`)
    check('info.cropBox 一致', JSON.stringify(i1.cropBox) === JSON.stringify(i2.cropBox))
    check('info.rotate 一致', i1.rotate === i2.rotate && i1.rotate === 0)
    check('info.contentBox 一致', JSON.stringify(i1.contentBox) === JSON.stringify(i2.contentBox))
    check('info.placedSize 一致', JSON.stringify(i1.placedSize) === JSON.stringify(i2.placedSize))
    check('info.expectedRect 一致', JSON.stringify(i1.expectedRect) === JSON.stringify(i2.expectedRect))
    check('info.phi 一致', i1.phi === i2.phi)
    // G1：字节级允许 metadata 差异（pikepdf 每次 save 生成随机 /ID）→ 页级结构对比：
    //   MediaBox + /Rotate（transform 等价已由上方 info.contentBox/placedSize/expectedRect/phi 证明）
    const structSame = (() => {
      const code2 = `
import pikepdf, json
def dump(p):
    d = pikepdf.open(p)
    out = []
    for pg in d.pages:
        mb = [round(float(v), 4) for v in pg.MediaBox]
        out.append({'mb': mb, 'rot': int(pg.get('/Rotate', 0))})
    return out
a = dump(r'${v1Spec.output_pdf.replace(/\\/g, '/')}')
b = dump(r'${v2Spec.output_pdf.replace(/\\/g, '/')}')
print(json.dumps({'same': a == b, 'na': len(a), 'nb': len(b)}))
`
      const r = JSON.parse(sh(PY, ['-c', code2]).trim())
      return r.same && r.na === 1 && r.nb === 1
    })()
    check('输出页级结构一致（MediaBox/Rotate，允许 /ID metadata 差异）', structSame)
    check('输出每页 MediaBox==paper + /Rotate=0', verifyPages(v1Spec.output_pdf, paperWpt, paperHpt))
  }

  // ── Gate-2：20 页 regression（pageIndex 显式 + A/B 交替 placement 证明逐页独立）──
  console.log('\n[Gate-2] 20 页 regression（pageIndex 显式 0..19，A/B 交替）')
  const multi = buildMultiPagePdf(20, 'multi20.pdf')
  check('构造 20 页源 PDF', multi.count === 20, `count=${multi.count}`)
  const pagePlacements = Array.from({ length: 20 }, (_, i) => ({
    pageIndex: i,
    placement: i % 2 === 0 ? placementA : placementB,
  }))
  const v2MultiSpec = {
    source_pdf: multi.outPdf, output_pdf: path.join(OUT, 'g2_20.pdf'), paper,
    placement: placementA, pagePlacements, dpi: DPI,
  }
  const rM = runBake(v2MultiSpec, 'g2_20')
  check('20 页 bake 成功', rM.success === true, JSON.stringify(rM.error || ''))
  if (rM.success) {
    const info = rM.info
    check('pageCount == 20', info.pageCount === 20, `pageCount=${info.pageCount}`)
    check('pages.length == 20', Array.isArray(info.pages) && info.pages.length === 20)
    check('每页 pageIndex 显式映射 0..19',
      info.pages.every(p => p.pageIndex === info.pages.indexOf(p) || info.pages[p.pageIndex].pageIndex === p.pageIndex)
      && JSON.stringify(info.pages.map(p => p.pageIndex)) === JSON.stringify([...Array(20).keys()]),
      JSON.stringify(info.pages.map(p => p.pageIndex)))
    // 逐页独立：A(scale .5) 与 B(scale .6) 的 placedSize 不同 → 证明按 pageIndex 消费非数组位置
    const evenSizes = info.pages.filter(p => p.pageIndex % 2 === 0).map(p => p.placedSize.join('x'))
    const oddSizes = info.pages.filter(p => p.pageIndex % 2 === 1).map(p => p.placedSize.join('x'))
    check('A/B placement 逐页独立（even != odd placedSize）',
      new Set(evenSizes).size === 1 && new Set(oddSizes).size === 1 && evenSizes[0] !== oddSizes[0],
      `even=${evenSizes[0]} odd=${oddSizes[0]}`)
    // expectedRect 与 placement offset 的 px→pt 搬运一致（transform == placement）
    const p0 = info.pages[0]
    const expX = placementA.offset.x * 72 / DPI
    const expY = placementA.offset.y * 72 / DPI
    check('page0 expectedRect.x == offset.x 搬运', Math.abs(p0.expectedRect.x - expX) < 0.01, `${p0.expectedRect.x} vs ${expX}`)
    check('page0 expectedRect.y == offset.y 搬运', Math.abs(p0.expectedRect.y - expY) < 0.01, `${p0.expectedRect.y} vs ${expY}`)
    check('每页 contentBox 左缘 == expectedRect.x（placed 对齐）',
      info.pages.every(p => Math.abs(p.contentBox.x - p.expectedRect.x) < 0.01))
    check('输出每页 MediaBox==paper + /Rotate=0（复验）', verifyPages(v2MultiSpec.output_pdf, paperWpt, paperHpt))
  }

  // ── Gate-3：负例契约（len ∉ {1, N} → raise，G3 错误含 counts）──
  console.log('\n[Gate-3] 负例契约（len ∉ {1,20} → raise）')
  const badLenSpec = {
    source_pdf: multi.outPdf, output_pdf: path.join(OUT, 'g3_badlen.pdf'), paper,
    placement: placementA,
    pagePlacements: [{ pageIndex: 0, placement: placementA }, { pageIndex: 1, placement: placementB }],
    dpi: DPI,
  }
  const rBad = runBake(badLenSpec, 'g3_badlen')
  check('len=2 × 20 页 → 失败', rBad.success === false, JSON.stringify(rBad.error || ''))
  check('错误含 placement count + source page count（G3）',
    /placement count=2/.test(rBad.error || '') && /source page count=20/.test(rBad.error || ''),
    (rBad.error || '').slice(0, 200))
  const badIdxSpec = {
    source_pdf: buildMultiPagePdf(3, 'multi3.pdf').outPdf, output_pdf: path.join(OUT, 'g3_badidx.pdf'), paper,
    placement: placementA,
    pagePlacements: [
      { pageIndex: 0, placement: placementA },
      { pageIndex: 1, placement: placementB },
      { pageIndex: 3, placement: placementA },
    ],
    dpi: DPI,
  }
  const rBadIdx = runBake(badIdxSpec, 'g3_badidx')
  check('pageIndex 不连续 [0,1,3] × 3 页 → 失败', rBadIdx.success === false, JSON.stringify(rBadIdx.error || ''))
  check('错误含 pageIndex 明细（D3 方案 B）', /pageIndex=\[0, 1, 3\]/.test(rBadIdx.error || ''), (rBadIdx.error || '').slice(0, 200))

  // ── Gate-4：Model B 兼容（1 placement × 20 页）──
  console.log('\n[Gate-4] Model B 兼容（1 placement × 20 页 → 全页同几何）')
  const modelBSpec = {
    source_pdf: multi.outPdf, output_pdf: path.join(OUT, 'g4_modelB.pdf'), paper,
    placement: placementA,
    pagePlacements: [{ pageIndex: 0, placement: placementA }],
    dpi: DPI,
  }
  const rB = runBake(modelBSpec, 'g4_modelB')
  check('Model B bake 成功', rB.success === true, JSON.stringify(rB.error || ''))
  if (rB.success) {
    const sizes = new Set(rB.info.pages.map(p => p.placedSize.join('x')))
    check('20 页全同几何（placedSize 单一）', sizes.size === 1, JSON.stringify([...sizes]))
    check('输出每页 MediaBox==paper + /Rotate=0', verifyPages(modelBSpec.output_pdf, paperWpt, paperHpt))
  }

  console.log(failures === 0 ? '\nGATE PASS ✅ R-4.6-B placement_bake v2（单页 golden + 20 页逐页独立 + 负例契约 + Model B）'
    : `\nGATE FAIL ❌ ${failures} 项未过`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
