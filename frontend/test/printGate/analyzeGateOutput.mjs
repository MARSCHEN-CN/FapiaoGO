/**
 * A2-G1-CANVAS-1 分析器（node 侧）：canvas vs source 边距对比报告
 *
 * 读取 frontend/test/printGate/artifacts/<case>/ 下的 source.json + canvas.json，
 * 用 assertSafeMarginAlignment 生成第一份 Canvas 测量报告。
 *
 * 用法：node analyzeGateOutput.mjs
 * 前置：canvas.json 已由 Electron 采集落盘（collectCanvasOutput.js 的 __GATE_WRITE__ 或手动复制）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSafeMarginAlignment, marginsToMm } from './measureMargins.mjs'
import { GATE_CASES } from './gateCases.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ARTIFACT_ROOT = path.join(__dirname, 'artifacts')

function readJson(caseId, name) {
  const p = path.join(ARTIFACT_ROOT, caseId, name)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8'))
}

/**
 * 生成 G1 测量报告
 * @returns {object} { cases: [{case, sourceMarginMm, canvasMarginMm, alignment|ofdSemantic, verdict}], summary }
 */
export function analyzeGateOutput(cases = GATE_CASES) {
  const rows = []
  for (const c of cases) {
    const source = readJson(c.id, 'source.json')
    const canvas = readJson(c.id, 'canvas.json')

    if (!source || !canvas) {
      rows.push({
        case: c.id, anchor: c.anchor, purpose: c.purpose,
        sourceAvailable: !!source, canvasAvailable: !!canvas,
        verdict: 'INCOMPLETE（缺 source 或 canvas artifact）',
      })
      continue
    }

    // OFD：特殊判定（§12.5）——canvas 边距 ≈ settings.margins 即补足成功，非与 source 对齐
    if (c.format === 'ofd') {
      const settings = c.settings
      const expected = {
        left: Number(settings.marginLeft) || 0,
        top: Number(settings.marginTop) || 0,
        right: Number(settings.marginRight) || 0,
        bottom: Number(settings.marginBottom) || 0,
      }
      const r = assertSafeMarginAlignment(canvas.marginMm, expected)
      rows.push({
        case: c.id, anchor: c.anchor, purpose: c.purpose,
        sourceAvailable: true, canvasAvailable: true,
        sourceMarginMm: source.marginMm,
        canvasMarginMm: canvas.marginMm,
        expectedMarginsMm: expected,
        maxDiffMm: r.maxDiffMm,
        verdict: r.pass ? 'PASS（Canvas 补足 OFD 边距语义）' : `FAIL（Canvas OFD 边距 ≠ settings.margins，diff=${r.maxDiffMm}mm）`,
      })
      continue
    }

    // PDF：普通对齐判定（§12.3）
    const r = assertSafeMarginAlignment(canvas.marginMm, source.marginMm)
    rows.push({
      case: c.id, anchor: c.anchor, purpose: c.purpose,
      sourceAvailable: true, canvasAvailable: true,
      sourceMarginMm: source.marginMm,
      canvasMarginMm: canvas.marginMm,
      diffsMm: r.diffs,
      maxDiffMm: r.maxDiffMm,
      verdict: r.pass ? 'PASS（对齐 ≤0.5mm）' : `FAIL（对齐差 ${r.maxDiffMm}mm > 0.5mm）`,
    })
  }

  const passCount = rows.filter(r => r.verdict.startsWith('PASS')).length
  return { cases: rows, summary: { total: rows.length, pass: passCount, fail: rows.length - passCount } }
}

/**
 * G1-CANVAS-3B native 对比：读 native.json（paperKey=null 渲染），对比内容尺寸与 bbox offset vs source
 * 判定（用户定稿）：
 *   - 内容尺寸 ratio ≈ 1.0（native 内容 = source 内容 2423×1500）→ 尺寸恢复
 *   - bbox offset 小（坐标系接近）→ native placement 接近 source
 */
export function analyzeNativeOutput(caseId = 'A1-native') {
  const native = readJson(caseId, 'native.json')
  const source = readJson(caseId, 'source.json')
  if (!native || !source) {
    return { case: caseId, verdict: 'INCOMPLETE（缺 native.json 或 source.json）', nativeAvailable: !!native }
  }
  const nb = native.bboxPx, sb = source.bbox
  const sourceSize = { w: sb.right - sb.left, h: sb.bottom - sb.top }
  const ratio = nb ? { w: Math.round(nb.w / sourceSize.w * 1000) / 1000, h: Math.round(nb.h / sourceSize.h * 1000) / 1000 } : null
  const offset = native.bboxOffsetVsSourcePx
  const sizeOk = ratio && Math.abs(ratio.w - 1) < 0.02 && Math.abs(ratio.h - 1) < 0.02
  return {
    case: caseId,
    nativeBitmapPx: native.paperActualPx,
    sourceBitmapPx: source.paperActualPx,
    nativeBboxPx: nb,
    sourceBboxPx: sb,
    contentSizeRatio: ratio,
    bboxOffsetVsSourcePx: offset,
    sizeOk,
    verdict: sizeOk
      ? 'PASS（native 内容尺寸 = source 内容尺寸 ±2%）— 尺寸恢复'
      : `FAIL（native 内容尺寸 ratio ${JSON.stringify(ratio)} ≠ 1）`,
  }
}

// CLI 入口（Windows：argv[1] 是反斜杠路径，url pathname 是正斜杠；用 basename 比对）
const _isCli = process.argv[1] && path.basename(process.argv[1]) === 'analyzeGateOutput.mjs'
if (_isCli) {
  const report = analyzeGateOutput()
  for (const r of report.cases) {
    console.log(`\n=== ${r.case} (${r.anchor}) ===`)
    console.log(`  purpose: ${r.purpose}`)
    if (r.sourceMarginMm) console.log(`  source marginMm: L${r.sourceMarginMm.left} T${r.sourceMarginMm.top} R${r.sourceMarginMm.right} B${r.sourceMarginMm.bottom}`)
    if (r.canvasMarginMm) console.log(`  canvas marginMm: L${r.canvasMarginMm.left} T${r.canvasMarginMm.top} R${r.canvasMarginMm.right} B${r.canvasMarginMm.bottom}`)
    if (r.diffsMm) console.log(`  diffsMm: L${r.diffsMm.left} T${r.diffsMm.top} R${r.diffsMm.right} B${r.diffsMm.bottom}  max=${r.maxDiffMm}`)
    if (r.expectedMarginsMm) console.log(`  expected(settings): L${r.expectedMarginsMm.left} T${r.expectedMarginsMm.top} R${r.expectedMarginsMm.right} B${r.expectedMarginsMm.bottom}`)
    console.log(`  verdict: ${r.verdict}`)
  }
  // G1-CANVAS-3B native 对比（单独输出）
  const native = analyzeNativeOutput()
  console.log(`\n=== ${native.case} (3B native) ===`)
  if (native.nativeBitmapPx) console.log(`  native bitmap: ${native.nativeBitmapPx.w}x${native.nativeBitmapPx.h}  source bitmap: ${native.sourceBitmapPx.w}x${native.sourceBitmapPx.h}`)
  if (native.contentSizeRatio) console.log(`  content size ratio: w=${native.contentSizeRatio.w} h=${native.contentSizeRatio.h}`)
  if (native.bboxOffsetVsSourcePx) console.log(`  bbox offset vs source: dx=${native.bboxOffsetVsSourcePx.dx} dy=${native.bboxOffsetVsSourcePx.dy}px`)
  console.log(`  verdict: ${native.verdict}`)
  console.log(`\n===== SUMMARY: ${report.summary.pass}/${report.summary.total} PASS =====`)
}

export { marginsToMm }
