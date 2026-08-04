#!/usr/bin/env node
/**
 * A3-V2 Sumatra 真机旋转语义验证（2026-08-04）
 *
 * 目标：确认 source/Sumatra 真实打印对「portrait/landscape 源 + 用户 rotation=90」
 *       遵循 Policy A（纸面跟随内容 → 1890×2717）还是 Policy B（内容在固定纸面内旋转）。
 *
 * 这是 A3 验收栈最后一层「Final canvas contract / Source Semantic Alignment」的唯一未证实点。
 * canvas 轨 Policy A 已自洽证明（A3-3-3）；用户真看到的是 Sumatra 打印输出，必须真机对证。
 *
 * 设计（见冻结文档 §14.24）：
 *   V2-A（确定性，本脚本 --dry-run 即可跑）：1:1 复刻 print-settings.js buildPrintSettings，
 *         输出生产代码实际发给 Sumatra 的 -print-settings 字符串。
 *   V2-B（真机，需 SumatraPDF + 可静默 PDF 虚拟打印机）：调 SumatraPDF 打印 → 量输出 PDF → 判 Policy A/B。
 *
 * 用法：
 *   # 仅复刻 -print-settings 字符串（V2-A，无需 Sumatra）
 *   node scripts/verify_sumatra_rotation.js --pdf test_fixtures/25952000000127675627.pdf --rotation 90 --dry-run
 *
 *   # 真机打印 + 自动测量（V2-B）
 *   node scripts/verify_sumatra_rotation.js \
 *     --pdf test_fixtures/25952000000127675627.pdf \
 *     --rotation 90 \
 *     --printer "PDF Writer" \
 *     --out artifacts/sumatra_a1_rot90.pdf \
 *     --python "C:/Program Files/Python312/python.exe"
 *
 * 注意：
 *   - SumatraPDF 路径默认 resources/sumatra/SumatraPDF.exe（相对 cwd）。可用 --sumatra 覆盖。
 *   - "Microsoft Print to PDF" 在 SumatraPDF CLI 下会弹保存框，无法静默；
 *     需配置可静默输出到 --out 的 PDF writer（如 Ghostscript PDF 打印机 / PDF24 / Bullzip 自动保存）。
 *   - contentOrientation 默认 landscape（A1 PDF MediaBox 595×397pt 已实测为 landscape）。
 *     其他 PDF 用 --content-orientation 指定，或脚本未来自动检测。
 */

const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ─── 1. 1:1 复刻 print-settings.js（electron/print-service/print-settings.js）───
// 纯 mapper，与生产代码逐字符一致，避免「测了一个不一样的 Sumatra 调用」。

function resolveOrientationCommands(contentOrient, paperOrient, desiredRotation) {
  const steps = Math.round(desiredRotation / 90)
  const isEven = steps % 2 === 0
  //   content=横向: 偶数→landscape, 奇数→disable-auto-rotation
  //   content=竖向: 偶数→disable-auto-rotation, 奇数→landscape
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
  // fit
  const fit = ps.fit || 'contain'
  parts.push(fit === 'fill' ? 'stretch' : fit === 'none' ? 'noscale' : 'fit')
  // paper
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
const DPI = 300
const POLICY_A = { wMm: 160, hMm: 230, wPx: 1890, hPx: 2717, orient: 'portrait' }

// ─── 3. 主流程 ───
function main() {
  const argv = process.argv.slice(2)
  const get = (k, d) => {
    const i = argv.indexOf(k)
    return i >= 0 ? argv[i + 1] : d
  }
  const pdf = get('--pdf', 'test_fixtures/25952000000127675627.pdf')
  const rotation = parseInt(get('--rotation', '90'), 10)
  const dryRun = argv.includes('--dry-run')
  const printer = get('--printer', '')
  const out = get('--out', '')
  const sumatra = get('--sumatra', path.resolve('resources/sumatra/SumatraPDF.exe'))
  const python = get('--python', 'python3')
  const contentOrient = get('--content-orientation', 'landscape')
  const paperOrient = get('--paper-orientation', 'portrait')
  const fit = get('--fit', 'contain')

  if (!fs.existsSync(pdf)) {
    console.error(`❌ PDF 不存在: ${pdf}`)
    process.exit(2)
  }

  // A1 生产参数（见 gateCases.mjs A1-prod-rot90）
  const ps = {
    rotation,
    paper: 'Custom',
    customPaper: { widthMM: 230, heightMM: 160 },
    contentOrientation: contentOrient,
    paperOrientation: paperOrient,
    fit,
  }
  const printSettings = buildPrintSettings(ps)

  console.log('=== A3-V2 Sumatra 旋转语义验证 ===')
  console.log(`输入 PDF      : ${pdf}`)
  console.log(`contentOrient : ${contentOrient} (A1 MediaBox 595×397pt 实测 landscape)`)
  console.log(`paperOrient   : ${paperOrient}`)
  console.log(`rotation      : ${rotation}`)
  console.log(`纸张          : Custom 230×160mm`)
  console.log('')
  console.log(`▶ 生产 -print-settings: "${printSettings}"`)
  console.log(`▶ Policy A 预测输出   : ${POLICY_A.wPx}×${POLICY_A.hPx}px (${POLICY_A.wMm}×${POLICY_A.hMm}mm, ${POLICY_A.orient})`)
  console.log('')

  if (dryRun || !printer) {
    if (!printer) console.log('（未指定 --printer，仅输出 -print-settings 字符串。V2-B 需 --printer + --out）')
    return
  }

  // V2-B：真机打印
  if (!fs.existsSync(sumatra)) {
    console.error(`❌ SumatraPDF 不存在: ${sumatra}（用 --sumatra 指定）`)
    process.exit(2)
  }
  if (!out) {
    console.error('❌ V2-B 需 --out <输出PDF路径>（PDF writer 静默保存位置）')
    process.exit(2)
  }

  const args = ['-print-to', printer, '-print-settings', printSettings, '-silent', pdf]
  console.log(`▶ 调用 SumatraPDF: ${sumatra}`)
  console.log(`  args: ${args.join(' ')}`)
  console.log(`  输出目标: ${out}`)

  const t0 = Date.now()
  execFile(sumatra, args, { timeout: 120000 }, (err, stdout, stderr) => {
    const dur = Date.now() - t0
    if (err) {
      console.error(`❌ SumatraPDF 调用失败 (${dur}ms): ${err.message}`)
      if (stderr) console.error('  stderr:', stderr.slice(0, 300))
      process.exit(1)
    }
    console.log(`✅ SumatraPDF 返回 (${dur}ms)`)
    // 等待 PDF writer 落盘
    setTimeout(() => measure(out, python), 1500)
  })
}

function measure(outPdf, python) {
  if (!fs.existsSync(outPdf)) {
    console.error(`❌ 输出 PDF 未生成: ${outPdf}`)
    console.error('   确认 PDF writer 已配置静默保存到 --out 路径。')
    process.exit(1)
  }
  console.log(`\n▶ 测量输出 PDF: ${outPdf}`)
  const probe = path.resolve('scripts/probe_render_resource_fitz.py')
  if (!fs.existsSync(probe)) {
    console.error(`⚠️ 未找到 ${probe}，请手动运行：python ${probe} ${outPdf} 300`)
    return
  }
  execFile(python, [probe, outPdf, '300'], { timeout: 60000 }, (err, stdout) => {
    if (err) {
      console.error(`⚠️ 测量失败: ${err.message}`)
      return
    }
    let data
    try { data = JSON.parse(stdout) } catch { console.error('⚠️ 测量输出非 JSON'); console.log(stdout); return }
    const bbox = data.content_bbox_px
    const nat = data.native || data.pixmap_px || data.mediabox_px
    const wPx = nat ? nat[0] : (bbox ? bbox.x + bbox.w : null)
    const hPx = nat ? nat[1] : (bbox ? bbox.y + bbox.h : null)
    if (!wPx || !hPx) { console.error('⚠️ 无法解析输出尺寸'); console.log(stdout); return }

    const wMm = (wPx / DPI * 25.4)
    const hMm = (hPx / DPI * 25.4)
    const outOrient = wPx > hPx ? 'landscape' : 'portrait'

    console.log(`   输出尺寸 : ${wPx}×${hPx}px (${wMm.toFixed(1)}×${hMm.toFixed(1)}mm, ${outOrient})`)
    console.log(`   Policy A : ${POLICY_A.wPx}×${POLICY_A.hPx}px (${POLICY_A.wMm}×${POLICY_A.hMm}mm, ${POLICY_A.orient})`)

    const wMatch = Math.abs(wPx - POLICY_A.wPx) <= 30 && Math.abs(hPx - POLICY_A.hPx) <= 30
    console.log('')
    if (wMatch && outOrient === POLICY_A.orient) {
      console.log('✅ Policy A 吻合：纸面跟随内容旋转（canvas≈source 目标达成）')
      console.log('   → A3-C5 Source Semantic Alignment = PASS')
    } else if (wPx > hPx && outOrient === 'landscape') {
      console.log('⚠️ Policy B 倾向：纸面 landscape + 内容旋转在固定纸内')
      console.log('   → 需修订 rotation contract（冻结文档 §14.24.4 情况 B）')
    } else {
      console.log('🔴 异常输出，查 resolveOrientationCommands 映射或 PDF writer 行为')
    }
  })
}

main()
