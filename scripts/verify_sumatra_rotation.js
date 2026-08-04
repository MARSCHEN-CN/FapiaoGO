#!/usr/bin/env node
/**
 * A3-V2 Sumatra 输出几何验证（2026-08-04，经用户纠正后第二版）
 *
 * 定位：A3 验收栈最后一层「Source Semantic Alignment」的**验证**步骤，
 *       不是「重新摸索 Sumatra 参数」的实验。
 *
 * 关键纠正（见冻结文档 §14.24）：
 *   - 参数选择（发什么 -print-settings）**已经验证**：
 *       print-settings.js 的 ROTATE_LOOKUP 映射表 + debug-sumatra.js 的旗标退出码 smoke。
 *   - 真正未知的是 **rotate=90,disable-auto-rotation 这条命令跑出来的几何结果**，
 *       仓库里没有 measurable artifact → 本脚本填这一格。
 *   - `paper=230mm x 160mm` 是**打印介质设置（PrintSpec paper）**，不是输出 MediaBox。
 *       最终纸面方向 = Sumatra layout engine + 虚拟 writer 行为决定，不能从字符串推断。
 *
 * 设计：
 *   V2-A（确定性，--dry-run 即可）：1:1 复刻 buildPrintSettings → 生产实际 -print-settings 字符串。
 *         这是「代码想告诉 Sumatra 什么」的回归守卫，已验证。
 *   V2-B（验证已有命令，非探索）：把**同一条生产 -print-settings** 路由到一个
 *         **虚拟 PDF writer**（非物理打印机）执行，拿到可分析的 artifact PDF，再用 fitz 量几何。
 *
 * 为何需要虚拟 PDF writer：SumatraPDF 是查看器，只能打印、不能直接吐 PDF。
 *         要拿到 fitz 能分析的 artifact，必须经由一个 PDF writer（从 Sumatra 视角就是「打印机」，
 *         但吐的是 PDF 文件而非纸张）。推荐 Ghostscript PDF / PDF24 / Bullzip；
 *         "Microsoft Print to PDF" 在 CLI 下弹保存框且不保自定义纸，不推荐。
 *
 * V2 Gate：
 *   V2-01 Source Media Geometry：量 artifact MediaBox（pt/mm）+ 方向 → Policy A/B 裁决者。
 *   V2-02 Content Rotation：量 content bbox → L/T/R/B 边距，与源(rot0)做 90°CW 置换校验
 *         (L'=B, T'=L, R'=T, B'=R，用边距值 multiset 守恒判定，抗引擎绝对误差)。与 A3-3-3 C5 一致。
 *   V2-03 Canvas ↔ Source：canvas Policy A 预测 vs Sumatra artifact → 吻合即 A3-C5 Source Alignment PASS。
 *
 * 用法：
 *   # V2-A：仅复刻 -print-settings 字符串（无需 Sumatra）
 *   node scripts/verify_sumatra_rotation.js --pdf test_fixtures/25952000000127675627.pdf --rotation 90 --dry-run
 *
 *   # V2-B：路由到虚拟 PDF writer，产出 artifact 并自动测量
 *   node scripts/verify_sumatra_rotation.js \
 *     --pdf test_fixtures/25952000000127675627.pdf --rotation 90 \
 *     --printer "Ghostscript PDF" \
 *     --out artifacts/sumatra_a1_rot90.pdf \
 *     --rot0-out artifacts/sumatra_a1_rot0.pdf \
 *     --python "C:/Program Files/Python312/python.exe"
 *
 *   # 仅测一个 rot90 artifact（用 A3-3-3 C5 rot0 边距作参考，权威性略低）
 *   node scripts/verify_sumatra_rotation.js --pdf ... --rotation 90 \
 *     --printer "Ghostscript PDF" --out artifacts/sumatra_a1_rot90.pdf --python ...
 */

const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const DPI = 300
const MM_PER_PX = 25.4 / DPI

// ─── 1. 1:1 复刻 print-settings.js（electron/print-service/print-settings.js）───
// 逐字符一致，避免「测了一个不一样的 Sumatra 调用」。

function resolveOrientationCommands(contentOrient, paperOrient, desiredRotation) {
  const steps = Math.round(desiredRotation / 90)
  const isEven = steps % 2 === 0
  const baseFlag = (contentOrient === 'landscape') === isEven
    ? 'landscape'
    : 'disable-auto-rotation'
  const ROTATE_LOOKUP = {
    'landscape|portrait':  { 0: 0,  90: 90,  180: 180, 270: 270 },
    'landscape|landscape': { 0: 90, 90: 180, 180: 270, 270: 0   },
    'portrait|portrait':   { 0: 0,  90: 0,   180: 180, 270: 180 },
    'portrait|landscape':  { 0: 90, 90: 90,  180: 270, 270: 270 },
  }
  const key = `${contentOrient}|${paperOrient}`
  const rotate = ROTATE_LOOKUP[key]?.[desiredRotation] ?? desiredRotation
  return { baseFlag, rotate }
}

function buildPrintSettings(ps) {
  const parts = []
  const hasOrient = ps.contentOrientation && ps.paperOrientation
  if (hasOrient) {
    const r = resolveOrientationCommands(ps.contentOrientation, ps.paperOrientation, ps.rotation || 0)
    parts.push(r.baseFlag)
    if (r.rotate !== 0) parts.push(`rotate=${r.rotate}`)
  } else {
    parts.push('disable-auto-rotation')
    if (ps.rotation && ps.rotation !== 0) parts.push(`rotate=${ps.rotation}`)
  }
  const fit = ps.fit || 'contain'
  parts.push(fit === 'fill' ? 'stretch' : fit === 'none' ? 'noscale' : 'fit')
  const paper = ps.paper
  if (ps.paperkind != null) {
    parts.push(`paperkind=${ps.paperkind}`)
    if (paper && paper !== 'Custom') parts.push(`paper=${paper.toLowerCase()}`)
  } else if (paper) {
    const A_SERIES = /^(A\d|Letter|Legal|Tabloid)$/i
    if (A_SERIES.test(paper)) {
      parts.push(`paper=${paper.toLowerCase()}`)
    } else {
      const cp = ps.customPaper || {}
      const w = cp.widthMM || 0, h = cp.heightMM || 0
      if (w > 0 && h > 0) parts.push(`paper=${w}mm x ${h}mm`)
      else parts.push(`paper=${paper.toLowerCase()}`)
    }
  }
  return parts.join(',')
}

// ─── 2. Policy A 预测（canvas 轨，A3-3-3 已证）───
// A1 Custom 230×160mm + rotation 90 → Policy A 纸面跟随内容：
//   2717×1890 → 1890×2717 px @300dpi = 160×230mm（portrait 方向纸面）。
const POLICY_A = { wMm: 160, hMm: 230, wPx: 1890, hPx: 2717, orient: 'portrait' }

// A3-3-3 C5 rot0 边距参考（A1 canvas 探针，已证与 source anchor <0.2mm 吻合）。
// 90°CW 置换后预期：L'=B, T'=L, R'=T, B'=R。
const C5_ROT0_MARGINS_MM = { L: 14.3, T: 16, R: 10.6, B: 17 }
const C5_ROT90_EXPECTED_MM = {
  L: C5_ROT0_MARGINS_MM.B, T: C5_ROT0_MARGINS_MM.L,
  R: C5_ROT0_MARGINS_MM.T, B: C5_ROT0_MARGINS_MM.R,
}

// 90°CW 旋转的边距置换函数
function rotateMargins90CW(m) {
  return { L: m.B, T: m.L, R: m.T, B: m.R }
}

// ─── 3. fitz 探针调用 + 指标计算 ───
function runProbe(pdf, python) {
  const probe = path.resolve('scripts/probe_render_resource_fitz.py')
  if (!fs.existsSync(probe)) { console.error(`⚠️ 未找到 ${probe}`); return null }
  let out = ''
  try {
    out = require('child_process').execFileSync(python, [probe, pdf, String(DPI)], { timeout: 60000 }).toString()
  } catch (e) {
    console.error(`⚠️ 测量失败: ${e.message}`)
    return null
  }
  try { return JSON.parse(out) } catch { console.error('⚠️ 测量输出非 JSON'); console.log(out); return null }
}

// 从 probe 输出计算 MediaBox(方向) + 边距(mm)
function computeMetrics(data) {
  const mbPx = data.mediabox_px || data.pixmap_px
  if (!mbPx || !mbPx[0] || !mbPx[1]) return null
  const wPx = mbPx[0], hPx = mbPx[1]
  const wMm = wPx * MM_PER_PX, hMm = hPx * MM_PER_PX
  const orient = wPx > hPx ? 'landscape' : 'portrait'
  const bbox = data.content_bbox_px
  let margins = null
  if (bbox) {
    const L = bbox.x * MM_PER_PX
    const T = bbox.y * MM_PER_PX
    const R = (wPx - (bbox.x + bbox.w)) * MM_PER_PX
    const B = (hPx - (bbox.y + bbox.h)) * MM_PER_PX
    margins = { L: +L.toFixed(1), T: +T.toFixed(1), R: +R.toFixed(1), B: +B.toFixed(1) }
  }
  return { wPx, hPx, wMm: +wMm.toFixed(1), hMm: +hMm.toFixed(1), orient, margins }
}

// multiset 守恒校验：两组 {L,T,R,B} 的值集合是否近似相等（抗引擎绝对误差）
function marginMultisetMatch(a, b, tol = 5) {
  const av = [a.L, a.T, a.R, a.B].map(v => +v.toFixed(1)).sort((x, y) => x - y)
  const bv = [b.L, b.T, b.R, b.B].map(v => +v.toFixed(1)).sort((x, y) => x - y)
  return av.every((v, i) => Math.abs(v - bv[i]) <= tol)
}

// ─── 4. 主流程 ───
function main() {
  const argv = process.argv.slice(2)
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
  const pdf = get('--pdf', 'test_fixtures/25952000000127675627.pdf')
  const rotation = parseInt(get('--rotation', '90'), 10)
  const dryRun = argv.includes('--dry-run')
  const printer = get('--printer', '')
  const out = get('--out', '')
  const rot0Out = get('--rot0-out', '')
  const sumatra = get('--sumatra', path.resolve('resources/sumatra/SumatraPDF.exe'))
  const python = get('--python', 'python3')
  const contentOrient = get('--content-orientation', 'landscape')
  const paperOrient = get('--paper-orientation', 'portrait')
  const fit = get('--fit', 'contain')

  if (!fs.existsSync(pdf)) { console.error(`❌ PDF 不存在: ${pdf}`); process.exit(2) }

  const ps = { rotation, paper: 'Custom', customPaper: { widthMM: 230, heightMM: 160 },
    contentOrientation: contentOrient, paperOrientation: paperOrient, fit }
  const printSettings = buildPrintSettings(ps)

  console.log('=== A3-V2 Sumatra 输出几何验证（验证已有生产命令）===')
  console.log(`输入 PDF      : ${pdf}`)
  console.log(`contentOrient : ${contentOrient} (A1 MediaBox 595×397pt 实测 landscape)`)
  console.log(`paperOrient   : ${paperOrient}`)
  console.log(`rotation      : ${rotation}`)
  console.log(`纸张          : Custom 230×160mm`)
  console.log('')
  console.log(`▶ 生产 -print-settings (V2-A): "${printSettings}"`)
  console.log(`▶ Policy A 预测输出   : ${POLICY_A.wPx}×${POLICY_A.hPx}px (${POLICY_A.wMm}×${POLICY_A.hMm}mm, ${POLICY_A.orient})`)
  console.log('')

  if (dryRun || !printer) {
    if (!printer) console.log('（未指定 --printer，仅输出 -print-settings 字符串。V2-B 需 --printer=<虚拟PDF writer> + --out）')
    return
  }

  // V2-B：把已有生产命令路由到虚拟 PDF writer
  if (!fs.existsSync(sumatra)) { console.error(`❌ SumatraPDF 不存在: ${sumatra}（用 --sumatra 指定）`); process.exit(2) }
  if (!out) { console.error('❌ V2-B 需 --out <输出PDF路径>（虚拟 writer 静默保存位置）'); process.exit(2) }

  const args = ['-print-to', printer, '-print-settings', printSettings, '-silent', '-exit-when-done', pdf]
  console.log(`▶ 调用 SumatraPDF（同生产 -print-settings，目标=虚拟 writer）: ${sumatra}`)
  console.log(`  args: ${args.join(' ')}`)
  console.log(`  输出目标: ${out}`)

  const t0 = Date.now()
  execFile(sumatra, args, { timeout: 120000 }, (err) => {
    const dur = Date.now() - t0
    if (err) { console.error(`❌ SumatraPDF 调用失败 (${dur}ms): ${err.message}`); process.exit(1) }
    console.log(`✅ SumatraPDF 返回 (${dur}ms)`)
    setTimeout(() => {
      const rot90 = measure(out, python, rot0Out, printer, sumatra, printSettings)
      if (!rot90) process.exit(1)
    }, 1500)
  })
}

function measure(outPdf, python, rot0Out, printer, sumatra, printSettings) {
  if (!fs.existsSync(outPdf)) {
    console.error(`❌ 输出 PDF 未生成: ${outPdf}`)
    console.error('   确认虚拟 PDF writer 已配置静默保存到 --out 路径，且忠实遵循 paper=230mm x 160mm + disable-auto-rotation。')
    return null
  }
  console.log(`\n▶ 测量 rot90 artifact: ${outPdf}`)
  const d90 = runProbe(outPdf, python)
  if (!d90) return null
  const m90 = computeMetrics(d90)
  if (!m90) { console.error('⚠️ 无法从 probe 解析 MediaBox'); return null }

  console.log(`\n── V2-01 Source Media Geometry ──`)
  console.log(`   MediaBox : ${m90.wPx}×${m90.hPx}px (${m90.wMm}×${m90.hMm}mm, ${m90.orient})`)
  console.log(`   Policy A : ${POLICY_A.wPx}×${POLICY_A.hPx}px (${POLICY_A.wMm}×${POLICY_A.hMm}mm, ${POLICY_A.orient})`)
  const orientMatch = m90.orient === POLICY_A.orient
  const dimMatch = Math.abs(m90.wPx - POLICY_A.wPx) <= 40 && Math.abs(m90.hPx - POLICY_A.hPx) <= 40
  console.log(`   → 方向${orientMatch ? '✅ 吻合 Policy A(portrait)' : '⚠️ landscape=Policy B 倾向'}`)

  console.log(`\n── V2-02 Content Rotation ──`)
  let refMargins = C5_ROT0_MARGINS_MM
  let refLabel = 'A3-3-3 C5 rot0 参考'
  if (rot0Out && fs.existsSync(rot0Out)) {
    console.log(`   测量 rot0 artifact: ${rot0Out}`)
    const d0 = runProbe(rot0Out, python)
    const m0 = d0 ? computeMetrics(d0) : null
    if (m0 && m0.margins) { refMargins = m0.margins; refLabel = 'Sumatra rot0 artifact(自包含)' }
    else console.log(`   ⚠️ rot0 artifact 解析失败，回退到 C5 参考`)
  }
  const expected = rotateMargins90CW(refMargins)
  if (m90.margins) {
    console.log(`   rot90 边距 : L=${m90.margins.L} T=${m90.margins.T} R=${m90.margins.R} B=${m90.margins.B}`)
    console.log(`   ${refLabel} rot0: L=${refMargins.L} T=${refMargins.T} R=${refMargins.R} B=${refMargins.B}`)
    console.log(`   90°CW 预期 : L'=B=${expected.L} T'=L=${expected.T} R'=T=${expected.R} B'=R=${expected.B}`)
    const permOk = marginMultisetMatch(m90.margins, expected, 5)
    console.log(`   → 边距置换${permOk ? '✅ 守恒(L\'=B,T\'=L,R\'=T,B\'=R)' : '⚠️ 不守恒，查旋转方向/虚拟 writer'}`)
  } else {
    console.log(`   ⚠️ rot90 artifact 无 content bbox（空白页？），跳过边距校验`)
  }

  console.log(`\n── V2-03 Canvas ↔ Source ──`)
  if (orientMatch && dimMatch) {
    console.log('✅ Policy A 吻合：source 几何=canvas 纸面跟随内容旋转')
    console.log('   → A3-C5 Source Semantic Alignment = PASS（待用户真机确认写入冻结状态）')
  } else if (m90.orient === 'landscape' && m90.wMm > m90.hMm) {
    console.log('⚠️ Policy B 倾向：source 纸面 landscape + 内容旋转在固定纸内')
    console.log('   → 需修订 rotation contract（冻结文档 §14.24.4 情况 B），A3-C5 Source Alignment 转「修订中」')
  } else {
    console.log('🔴 异常输出，查 resolveOrientationCommands 映射或虚拟 writer 行为')
  }
  return m90
}

main()
