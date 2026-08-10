/**
 * Margin Contract Gate — 判定核心（纯函数，无 I/O）
 *
 * 契约：docs/print_margin_contract.md v1.1
 * 向量：docs/margin_contract_vectors.json
 *
 * ⚠️ Gate 2-A 强制约束：失败判定必须【固定优先级 + 短路】。
 *
 *   1. FILE_EXISTS      产物存在
 *   2. PDF_PARSE        可解析、页数 >= 1、UserUnit == 1（§1.5）
 *   3. INV_1_MEDIABOX   输出 MediaBox == 最终物理输出纸（§1.2 INV-1，容差 0.1pt）
 *   4. INV_R1_ROTATION  输出 /Rotate == 0（§2.2 R-1）
 *   5. GEOMETRY         四边有效边距在 0.5mm 内（§1.1 contain-fit 结果）
 *
 * 一旦某级失败，后续各级【不再求值】，统一标记 skipped。
 * 目的：根因不被污染。绝不允许出现
 *   "MediaBox wrong + bbox wrong + margin wrong" 然后报告说 "failed bbox"。
 */
import { findContentBBox, measureMarginsPx, marginsToMm } from '../measureMargins.mjs'
import { GATE_DPI, SAFE_MARGIN_TOLERANCE_MM } from '../gateConfig.mjs'

/** 失败优先级顺序（唯一真源，报告与断言都读它） */
export const CHECK_ORDER = Object.freeze([
  'FILE_EXISTS',
  'PDF_PARSE',
  'INV_1_MEDIABOX',
  'INV_R1_ROTATION',
  'GEOMETRY',
])

/** INV-1 / R-1 的解析容差（契约 §6 G-2） */
export const GUARD_TOLERANCE_PT = 0.1

export const ptToMm = (pt) => (pt * 25.4) / 72

/**
 * @param {object} args
 * @param {object} args.vector       向量（margin_contract_vectors.json 的一项）
 * @param {boolean} args.fileExists
 * @param {object|null} args.probe   probePdf.py 输出；null 表示未探测
 * @param {object|null} args.raster  {width,height,pixels} ；null 表示未光栅化
 * @returns {{pass:boolean, failedCheck:string|null, checks:Array, measured:object}}
 */
export function verifyOutput({ vector, fileExists, probe, raster }) {
  const exp = vector.expected
  const checks = []
  const measured = {}
  let failedCheck = null

  const push = (id, pass, detail) => { checks.push({ id, status: pass ? 'pass' : 'fail', detail }) }
  const skipRest = (fromIdx) => {
    for (let i = fromIdx; i < CHECK_ORDER.length; i++) {
      checks.push({ id: CHECK_ORDER[i], status: 'skipped', detail: '前置不变量已失败，短路跳过（Gate 2-A）' })
    }
  }

  // ── 1. FILE_EXISTS ──────────────────────────────────────────────
  if (!fileExists) {
    push('FILE_EXISTS', false, '输出文件不存在')
    skipRest(1)
    return { pass: false, failedCheck: 'FILE_EXISTS', checks, measured }
  }
  push('FILE_EXISTS', true, 'ok')

  // ── 2. PDF_PARSE ────────────────────────────────────────────────
  if (!probe || probe.ok !== true) {
    push('PDF_PARSE', false, `无法解析：${probe?.error ?? 'probe 未执行'}`)
    skipRest(2)
    return { pass: false, failedCheck: 'PDF_PARSE', checks, measured }
  }
  if (!(probe.pages >= 1)) {
    push('PDF_PARSE', false, `页数 ${probe.pages} < 1`)
    skipRest(2)
    return { pass: false, failedCheck: 'PDF_PARSE', checks, measured }
  }
  if (Math.abs(probe.page0.userUnit - 1) > 1e-9) {
    // §1.5：UserUnit != 1 时 pt 运算前提失效，Guard 直接拒绝
    push('PDF_PARSE', false, `UserUnit=${probe.page0.userUnit} != 1（§1.5 拒绝）`)
    skipRest(2)
    return { pass: false, failedCheck: 'PDF_PARSE', checks, measured }
  }
  push('PDF_PARSE', true, `pages=${probe.pages}, userUnit=1`)

  // ── 3. INV_1_MEDIABOX ───────────────────────────────────────────
  const mb = probe.page0.mediaBox
  measured.mediaBox = { widthPt: mb.widthPt, heightPt: mb.heightPt }
  const dW = Math.abs(mb.widthPt - exp.mediaBox.widthPt)
  const dH = Math.abs(mb.heightPt - exp.mediaBox.heightPt)
  measured.mediaBoxDeltaPt = { widthPt: round4(dW), heightPt: round4(dH) }
  if (dW > GUARD_TOLERANCE_PT || dH > GUARD_TOLERANCE_PT) {
    push('INV_1_MEDIABOX', false,
      `actual ${fmt(mb.widthPt)} x ${fmt(mb.heightPt)} pt` +
      ` != expected ${fmt(exp.mediaBox.widthPt)} x ${fmt(exp.mediaBox.heightPt)} pt` +
      ` (Δ ${fmt(dW)} / ${fmt(dH)} pt, 容差 ${GUARD_TOLERANCE_PT})`)
    skipRest(3)
    return { pass: false, failedCheck: 'INV_1_MEDIABOX', checks, measured }
  }
  push('INV_1_MEDIABOX', true, `${fmt(mb.widthPt)} x ${fmt(mb.heightPt)} pt`)

  // ── 4. INV_R1_ROTATION ──────────────────────────────────────────
  measured.rotate = probe.page0.rotate
  if (probe.page0.rotate !== (exp.pageRotate ?? 0)) {
    push('INV_R1_ROTATION', false,
      `/Rotate=${probe.page0.rotate} != expected ${exp.pageRotate ?? 0}（R-1：输出恒 0）`)
    skipRest(4)
    return { pass: false, failedCheck: 'INV_R1_ROTATION', checks, measured }
  }
  push('INV_R1_ROTATION', true, `/Rotate=${probe.page0.rotate}`)

  // ── 5. GEOMETRY ─────────────────────────────────────────────────
  if (!raster) {
    push('GEOMETRY', false, '光栅化结果缺失')
    return { pass: false, failedCheck: 'GEOMETRY', checks, measured }
  }
  const bbox = findContentBBox(raster.pixels, raster.width, raster.height)
  if (!bbox) {
    push('GEOMETRY', false, '内容 bbox 为空（整页无墨）')
    return { pass: false, failedCheck: 'GEOMETRY', checks, measured }
  }
  const marginsPx = measureMarginsPx(bbox, { w: raster.width, h: raster.height })
  const actualMm = marginsToMm(marginsPx, GATE_DPI)
  const expectedMm = {
    left: round3(ptToMm(exp.effectiveMargins.left)),
    right: round3(ptToMm(exp.effectiveMargins.right)),
    top: round3(ptToMm(exp.effectiveMargins.top)),
    bottom: round3(ptToMm(exp.effectiveMargins.bottom)),
  }
  const diffs = {}
  let maxDiff = 0
  for (const e of ['left', 'right', 'top', 'bottom']) {
    const d = Math.abs(actualMm[e] - expectedMm[e])
    diffs[e] = round3(d)
    if (d > maxDiff) maxDiff = d
  }
  measured.bboxPx = bbox
  measured.marginsMm = actualMm
  measured.expectedMarginsMm = expectedMm
  measured.marginDiffsMm = diffs
  measured.maxMarginDiffMm = round3(maxDiff)

  if (maxDiff > SAFE_MARGIN_TOLERANCE_MM) {
    push('GEOMETRY', false,
      `边距最大偏差 ${round3(maxDiff)}mm > ${SAFE_MARGIN_TOLERANCE_MM}mm` +
      ` | actual ${fmtM(actualMm)} vs expected ${fmtM(expectedMm)}`)
    return { pass: false, failedCheck: 'GEOMETRY', checks, measured }
  }
  push('GEOMETRY', true, `maxΔ ${round3(maxDiff)}mm <= ${SAFE_MARGIN_TOLERANCE_MM}mm`)

  return { pass: true, failedCheck, checks, measured }
}

const fmt = (n) => Number(n).toFixed(4)
const fmtM = (m) => `L${m.left}/R${m.right}/T${m.top}/B${m.bottom}`
const round3 = (n) => Math.round(n * 1000) / 1000
const round4 = (n) => Math.round(n * 10000) / 10000
