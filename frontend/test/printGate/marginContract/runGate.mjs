/**
 * Margin Contract Gate — 运行器（DEV-only）
 *
 * 三种被测对象（--target）：
 *   production : 调用生产实现 scripts/add-pdf-margins.py（Gate 2 预期 RED，旧代码回归基线）
 *   phase1a    : 调用 Phase 1-A executor scripts/margin_contract.py（预期 GREEN）
 *   correct    : 用 makeFixture.py correct 生成的已知正确输出（Gate 基础设施自检，预期 GREEN）
 *
 * 用法:
 *   node runGate.mjs --target production
 *   node runGate.mjs --target correct
 *   node runGate.mjs --target phase1a
 *   node runGate.mjs --target phase1a --force-pending   # 连 pending 向量（如 V-04 rot90）也跑
 *   node runGate.mjs --target correct --only V-02-asym-tb
 *
 * 退出码：0 = 全部 active 向量通过；1 = 有失败。
 * ⚠️ 本运行器不改任何生产代码，只读 + 在 .out/ 写临时产物。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyOutput, CHECK_ORDER } from './marginContractGate.mjs'
import { GATE_DPI } from '../gateConfig.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const PY = path.join(REPO, 'backend', 'venv', 'Scripts', 'python.exe')
const VECTORS = path.join(REPO, 'docs', 'margin_contract_vectors.json')
const PROD_SCRIPT = path.join(REPO, 'scripts', 'add-pdf-margins.py')
const EXECUTOR = path.join(REPO, 'scripts', 'margin_contract.py')
const RASTERIZE = path.join(HERE, '..', 'rasterize_pdf.py')
const OUT = path.join(HERE, '.out')

const argv = process.argv.slice(2)
const getArg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const target = getArg('--target', 'production')
const only = getArg('--only', null)
const forcePending = argv.includes('--force-pending')

if (!['production', 'phase1a', 'correct'].includes(target)) {
  console.error('--target 必须是 production / phase1a / correct'); process.exit(2)
}
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, '.gitignore'), '*\n')

const doc = JSON.parse(fs.readFileSync(VECTORS, 'utf8'))
const ptToMm = (pt) => (pt * 25.4) / 72

function py(script, args) {
  const raw = execFileSync(PY, [script, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const line = raw.trim().split('\n').filter(Boolean).pop()
  return JSON.parse(line)
}

function rasterize(pdfPath, binPath) {
  const info = py(RASTERIZE, [pdfPath, String(GATE_DPI), binPath])
  if (!info.ok) throw new Error(`rasterize failed: ${JSON.stringify(info)}`)
  const pixels = fs.readFileSync(binPath)
  if (pixels.length !== info.width * info.height * 4) {
    throw new Error(`raster size mismatch: ${pixels.length} != ${info.width}*${info.height}*4`)
  }
  return { width: info.width, height: info.height, pixels }
}

const results = []
let pending = 0

for (const vec of doc.vectors) {
  if (only && vec.id !== only) continue
  if (vec.status !== 'active' && !(forcePending && target === 'phase1a')) {
    pending++
    results.push({ id: vec.id, status: 'PENDING', reason: vec.status, note: vec.notes ?? '' })
    continue
  }

  const srcPdf = path.join(OUT, `${vec.id}.src.pdf`)
  const outPdf = path.join(OUT, `${vec.id}.${target}.pdf`)
  const binPath = path.join(OUT, `${vec.id}.${target}.rgba.bin`)
  // 清陈旧产物：截断为 0 字节而非删除。
  // 理由：① 沙箱把 fs.rmSync 包成 safe-delete（走回收站，失败即抛），会淹没 Gate 输出；
  //      ② 截断同样杜绝「上一轮产物冒充本轮结果」；若生成失败，0 字节文件会在
  //         PDF_PARSE 层被诚实归因，而不是伪装成几何失败。
  for (const f of [outPdf, binPath]) if (fs.existsSync(f)) fs.writeFileSync(f, '')

  const rec = { id: vec.id, status: null, purpose: vec.purpose }
  try {
    // ① 源 PDF（确定性生成）
    const srcInfo = py(path.join(HERE, 'makeFixture.py'), ['source', '--vector', vec.id, '--out', srcPdf])
    if (!srcInfo.ok) throw new Error(`makeFixture source failed: ${srcInfo.error}`)
    rec.sourceRawMediaBox = srcInfo.info.rawMediaBox
    rec.sourcePageRotate = srcInfo.info.rotate

    // ② 产出被测 PDF
    if (target === 'production') {
      const m = vec.input.margin
      const out = py(PROD_SCRIPT, [
        '--input', srcPdf, '--output', outPdf,
        '--left', String(ptToMm(m.left)), '--right', String(ptToMm(m.right)),
        '--top', String(ptToMm(m.top)), '--bottom', String(ptToMm(m.bottom)),
      ])
      rec.productionReturn = out
    } else if (target === 'phase1a') {
      const m = vec.input.margin
      const p = vec.input.paper
      const rot = vec.input.spec?.contentRotation ?? 0
      const allowUp = vec.input.spec?.allowUpscale ?? false
      const args = [
        '--input', srcPdf, '--output', outPdf,
        '--paper-width-pt', String(p.widthPt), '--paper-height-pt', String(p.heightPt),
        '--left-pt', String(m.left), '--right-pt', String(m.right),
        '--top-pt', String(m.top), '--bottom-pt', String(m.bottom),
        '--content-rotation', String(rot),
      ]
      if (allowUp) args.push('--allow-upscale')
      const out = py(EXECUTOR, args)
      if (!out.success) throw new Error(`margin_contract failed: ${out.error}`)
      rec.executorInfo = out.info
    } else {
      const out = py(path.join(HERE, 'makeFixture.py'),
        ['correct', '--vector', vec.id, '--out', outPdf, '--src', srcPdf])
      if (!out.ok) throw new Error(`makeFixture correct failed: ${out.error}`)
    }

    // ③ 探针 + 光栅（探针失败不抛，交给判定层按优先级归因）
    const fileExists = fs.existsSync(outPdf)
    let probe = null
    let raster = null
    if (fileExists) {
      probe = py(path.join(HERE, 'probePdf.py'), [outPdf])
      // 只有在 MediaBox / Rotate 都可能通过时才值得光栅化；
      // 但为了报告完整性，只要能解析就栅格化（判定层仍按优先级短路）。
      if (probe.ok) {
        try { raster = rasterize(outPdf, binPath) } catch (e) { rec.rasterError = String(e.message) }
      }
    }

    const verdict = verifyOutput({ vector: vec, fileExists, probe, raster })
    rec.status = verdict.pass ? 'PASS' : 'FAIL'
    rec.failedCheck = verdict.failedCheck
    rec.checks = verdict.checks
    rec.measured = verdict.measured
    rec.expected = {
      mediaBox: vec.expected.mediaBox,
      scaleExact: vec.expected.scaleExact,
      pageRotate: vec.expected.pageRotate,
    }
  } catch (e) {
    rec.status = 'ERROR'
    rec.failedCheck = 'HARNESS'
    rec.error = String(e.message ?? e)
  }
  results.push(rec)
}

// ── 报告 ──────────────────────────────────────────────────────────
const pass = results.filter(r => r.status === 'PASS').length
const fail = results.filter(r => r.status === 'FAIL').length
const error = results.filter(r => r.status === 'ERROR').length

console.log('='.repeat(78))
console.log(`Margin Contract Gate  |  target=${target}  |  contract=${doc.contract}`)
console.log(`vectors=${doc.version}  dpi=${GATE_DPI}  失败优先级=${CHECK_ORDER.join(' > ')}`)
console.log('='.repeat(78))

for (const r of results) {
  if (r.status === 'PENDING') { console.log(`\n[PENDING] ${r.id}  (${r.reason})`); continue }
  const tag = r.status === 'PASS' ? 'PASS ' : (r.status === 'ERROR' ? 'ERROR' : 'FAIL ')
  console.log(`\n[${tag}] ${r.id}${r.failedCheck ? `   ← ${r.failedCheck}` : ''}`)
  if (r.status === 'ERROR') { console.log(`    harness error: ${r.error}`); continue }
  for (const c of r.checks) {
    const mark = c.status === 'pass' ? ' ok ' : (c.status === 'fail' ? 'FAIL' : ' -- ')
    console.log(`    [${mark}] ${c.id.padEnd(16)} ${c.detail}`)
  }
}

console.log('\n' + '-'.repeat(78))
console.log(`PASS=${pass}  FAIL=${fail}  ERROR=${error}  PENDING=${pending}`)
console.log('-'.repeat(78))

fs.writeFileSync(path.join(OUT, `report.${target}.json`),
  JSON.stringify({ target, contract: doc.contract, vectorsVersion: doc.version, dpi: GATE_DPI, results }, null, 2))
console.log(`report → ${path.join(OUT, `report.${target}.json`)}`)

process.exit(fail + error > 0 ? 1 : 0)
