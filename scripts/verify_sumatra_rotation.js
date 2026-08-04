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
 *         但吐的是 PDF 文件而非纸张）。
 *
 * 捕获 writer 选型（2026-08-04 收敛结论，见用户复盘）：
 *   ✅ Wondershare PDFelement（推荐，A3-V2 唯一纳入的 capture writer）：
 *        - 用户已验证：可输出 PDF、可保存自定义纸、稳定静默落盘。
 *        - 230×160 异形纸：用户已在 Wondershare 里配置名为「PostScript」的 230×160 自定义纸型承接。
 *        - Sumatra 发生产命令 `paper=PostScript`（按纸名，非 custom 尺寸），由 Wondershare 按名字匹配其 230×160 纸型。
 *          这与生产线 buildPrintSettings 对非 A 系列、不在注册表的命名纸行为一致（paper=postscript）。
 *   ❌ PDF24（已证明不适合自动化）：把任务暂存为 .ps 到 %LOCALAPPDATA%\Temp\PDF24\ 并弹「保存助手」，
 *        -silent 下 Sumatra 返回但 PDF 不提交 → 必须手动启用静默自动保存，收益极低，已弃用。
 *   ❌ "Microsoft Print to PDF"：CLI 下弹保存框且不保自定义纸（自定义 230×160mm 实测被夹成 A4 210×297mm）。
 *
 * ⚠️ 验证环境变量必须提前收敛（本轮回溯核心）：writer 名称 + 输出目录 + 自定义纸型，三者缺一都会再烧一轮。
 *    Wondershare 输出目录请用 --search-dir 显式传入（脚本自动扫描目录有限，不保证覆盖）。
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
 *   node scripts/verify_sumatra_rotation.js --pdf <A4.pdf> --paper a4 --rotation 90 --dry-run
 *
 *   # V2-B：路由到 Wondershare PDFelement（推荐 capture writer），产出 artifact 并自动测量
 *   #   轨二 · 异形纸 230×160（真正的 A/B 判别器；Wondershare 已配名为「PostScript」的 230×160 纸型）
 *   #   命令按纸名发 paper=PostScript（与生产一致），Wondershare 按名匹配其 230×160 纸型。
 *   #   Wondershare 虚拟打印机本机实测默认落盘到 C:\Users\it01\Desktop（随机数字名），脚本已自动扫描；改了目录用 --search-dir。
 *   #   单行命令（rot90，V2-01 判别 Policy A/B）：
 *   node scripts/verify_sumatra_rotation.js --pdf test_fixtures/25952000000127675627.pdf --rotation 90 --printer "Wondershare PDFelement" --paper PostScript --out artifacts/sumatra_a1_rot90.pdf --search-dir "C:/Users/it01/Desktop" --python "C:/Program Files/Python312/python.exe"
 *   #   再跑一次 rot0（供 V2-02 边距 90°CW 置换参考），然后带 --rot0-out 复跑 rot90：
 *   node scripts/verify_sumatra_rotation.js --pdf test_fixtures/25952000000127675627.pdf --rotation 0 --printer "Wondershare PDFelement" --paper PostScript --out artifacts/sumatra_a1_rot0.pdf --search-dir "C:/Users/it01/Desktop" --python "C:/Program Files/Python312/python.exe"
 *   node scripts/verify_sumatra_rotation.js --pdf test_fixtures/25952000000127675627.pdf --rotation 90 --printer "Wondershare PDFelement" --paper PostScript --out artifacts/sumatra_a1_rot90.pdf --rot0-out artifacts/sumatra_a1_rot0.pdf --search-dir "C:/Users/it01/Desktop" --python "C:/Program Files/Python312/python.exe"
 *
 *   # --measure-only：跳过 Sumatra + writer 捕获，直接分析已落盘的 artifact（writer/env 解耦）
 *   #   适合：writer 弹了保存框、或想对同一次捕获反复跑 V2-01/02/03 而不重打。
 *   node scripts/verify_sumatra_rotation.js \
 *     --pdf test_fixtures/25952000000127675627.pdf --rotation 90 \
 *     --paper custom --custom-w 230 --custom-h 160 \
 *     --out "C:/Users/it01/Desktop/34646.pdf" --rot0-out artifacts/sumatra_a1_rot0.pdf \
 *     --measure-only --python "C:/Program Files/Python312/python.exe"
 *   #   轨一 · 常规纸 A4（验证旋转方向 V2-02；页尺寸无法区分 A/B → NONDISCRIM）
 *   node scripts/verify_sumatra_rotation.js \
 *     --pdf test_fixtures/a4_landscape_sample.pdf --paper a4 --rotation 90 \
 *     --printer "Wondershare PDFelement" --out artifacts/sumatra_a4_rot90.pdf \
 *     --rot0-out artifacts/sumatra_a4_rot0.pdf \
 *     --search-dir "C:/Users/it01/<Wondershare输出目录>" \
 *     --python "C:/Program Files/Python312/python.exe"
 *
 *   注意：SumatraPDF -print-to 不能指定输出路径，writer 落盘位置由驱动决定。
 *   若 writer 未保存到 --out，脚本自动扫描 --search-dir（默认另含输出目录/cwd/桌面/文档/下载/Wondershare候选）
 *   抓取最近 60s 内 .pdf 复制到 --out 再测量。Wondershare 输出目录务必用 --search-dir 显式传入（最稳）。
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
    } else if (paper.toLowerCase() === 'custom' && ps.customPaper) {
      // 显式 custom：直接发尺寸（WxHmm）
      const w = ps.customPaper.widthMM || 0, h = ps.customPaper.heightMM || 0
      if (w > 0 && h > 0) parts.push(`paper=${w}mm x ${h}mm`)
      else parts.push(`paper=custom`)
    } else {
      // 命名特种纸（如 Wondershare「PostScript」230×160）：按名字发，由驱动按名匹配其尺寸。
      // 与生产线 buildPrintSettings 对非 A 系列、不在注册表的命名纸行为一致（paper=postscript）。
      parts.push(`paper=${paper.toLowerCase()}`)
    }
  }
  return parts.join(',')
}

// ─── 2. Policy A/B 预测（canvas 轨，A3-3-3 已证）───
// Policy A = 纸面跟随内容旋转：输出纸面方向 = 内容旋转后方向，尺寸 = 请求纸在该方向下的尺寸。
// Policy B = 内容在固定纸内旋转：输出纸面 = 请求纸原样（不随内容旋转交换方向）。
// 关键：标准命名纸(a4/a5)下，生产 -print-settings 要么带 landscape/portrait 旗标(钉死页方向)，
//   要么内容旋转后方向与请求纸方向恰巧一致 → 页尺寸无法区分 A/B。
//   唯一干净的 A/B 判别器是「disable-auto-rotation + 显式 landscape-spec 自定义纸(如 230×160)」组合（A1 场景）。
//   因此 A4/A5 验证的是「Sumatra 忠实执行生产命令 + 旋转方向(V2-02)」；230×160(Wondershare)才是 A/B 判别器。
function computePolicy(opts) {
  const DPI = 300, MM = 25.4
  let pw, ph
  if (opts.paper === 'a4') { pw = 210; ph = 297 }
  else if (opts.paper === 'a5') { pw = 148; ph = 210 }
  else { pw = opts.customW; ph = opts.customH }
  const paperOrient = pw > ph ? 'landscape' : 'portrait'
  const steps = ((Math.round(opts.rotation / 90) % 4) + 4) % 4
  const contentLand = opts.contentOrient === 'landscape'
  const contentPostLand = steps % 2 === 1 ? !contentLand : contentLand
  const contentPostOrient = contentPostLand ? 'landscape' : 'portrait'
  let paW, paH
  if (contentPostOrient === paperOrient) { paW = pw; paH = ph }
  else { paW = ph; paH = pw }
  const px = (mm) => Math.round(mm * DPI / MM)
  const policyA = { wMm: paW, hMm: paH, wPx: px(paW), hPx: px(paH), orient: paW > paH ? 'landscape' : 'portrait' }
  const policyB = { wMm: pw, hMm: ph, wPx: px(pw), hPx: px(ph), orient: paperOrient }
  const discriminant = (policyA.wMm !== policyB.wMm) || (policyA.hMm !== policyB.hMm)
  return { policyA, policyB, discriminant, paperOrient }
}

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

// 从源 PDF MediaBox 自动判定内容方向（避免手动传 --content-orientation）
function detectContentOrient(pdf, python) {
  const d = runProbe(pdf, python)
  if (!d || !d.mediabox_px || !d.mediabox_px[0]) return null
  const [w, h] = d.mediabox_px
  return w > h ? 'landscape' : 'portrait'
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

// ─── 3.5 抓取 writer 实际落盘的文件（writer-agnostic 安全网）───
// SumatraPDF -print-to 不能指定输出路径，文件落在 writer 驱动自己决定的位置。
// 若 --out 不存在，扫描 searchDirs 找最近 maxAgeMs 内生成的 .pdf，复制到 --out。
function grabOutput(outPdf, searchDirs, maxAgeMs = 60000) {
  const cutoff = Date.now() - maxAgeMs
  let best = null
  for (const dir of searchDirs) {
    let names = []
    try { names = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf')) } catch { continue }
    for (const f of names) {
      const full = path.join(dir, f)
      let st
      try { st = fs.statSync(full) } catch { continue }
      if (st.mtimeMs >= cutoff && (!best || st.mtimeMs > best.mtimeMs)) best = { full, mtimeMs: st.mtimeMs }
    }
  }
  if (!best) return null
  try { fs.copyFileSync(best.full, outPdf) } catch (e) { console.error(`⚠️ 抓取失败(复制 ${best.full} -> ${outPdf}): ${e.message}`); return null }
  console.log(`▶ 抓取 writer 输出: ${best.full} -> ${outPdf}`)
  return outPdf
}

// 检测 PDF24 是否已接收任务但仅暂存为 .ps（未生成 PDF）——说明助手对话框在等用户保存。
function detectPdf24Staging() {
  const userDir = process.env.USERPROFILE || process.env.HOME
  const cand = []
  if (userDir) cand.push(path.join(userDir, 'AppData', 'Local', 'Temp', 'PDF24'))
  cand.push(path.join(os.tmpdir(), 'PDF24'))
  const cutoff = Date.now() - 120000
  const found = []
  for (const d of cand) {
    let names = []
    try { names = fs.readdirSync(d).filter(f => f.toLowerCase().endsWith('.ps')) } catch { continue }
    for (const f of names) {
      const full = path.join(d, f)
      let st
      try { st = fs.statSync(full) } catch { continue }
      if (st.mtimeMs >= cutoff) found.push(full)
    }
  }
  return found
}

// ─── 4. 主流程 ───
function main() {
  const argv = process.argv.slice(2)
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
  const pdf = get('--pdf', 'test_fixtures/25952000000127675627.pdf')
  const rotation = parseInt(get('--rotation', '90'), 10)
  const dryRun = argv.includes('--dry-run')
  const measureOnly = argv.includes('--measure-only')
  const printer = get('--printer', '')
  const out = get('--out', '')
  const rot0Out = get('--rot0-out', '')
  const searchDir = get('--search-dir', '')
  const sumatra = get('--sumatra', path.resolve('resources/sumatra/SumatraPDF.exe'))
  const python = get('--python', 'python3')
  const contentOrientRaw = get('--content-orientation', '')
  const detectedOrient = contentOrientRaw ? null : detectContentOrient(pdf, python)
  let contentOrient = contentOrientRaw || detectedOrient || 'landscape'
  const paperOrient = get('--paper-orientation', 'portrait')
  const fit = get('--fit', 'contain')

  if (!fs.existsSync(pdf)) { console.error(`❌ PDF 不存在: ${pdf}`); process.exit(2) }

  const paper = get('--paper', 'custom')
  const customW = parseFloat(get('--custom-w', '230'))
  const customH = parseFloat(get('--custom-h', '160'))
  // 仅当 paper=custom 时注入尺寸；命名特种纸（如 Wondershare「PostScript」）按名字发，不塞尺寸。
  const customPaper = paper === 'custom' ? { widthMM: customW, heightMM: customH } : undefined
  const ps = { rotation, paper, customPaper,
    contentOrientation: contentOrient, paperOrientation: paperOrient, fit }
  const printSettings = buildPrintSettings(ps)
  const oc = resolveOrientationCommands(contentOrient, paperOrient, rotation)
  const pol = computePolicy({ paper, customW, customH, rotation, contentOrient })
  const paperLabel = paper === 'custom' ? `Custom ${customW}×${customH}mm` : paper.toUpperCase()

  console.log('=== A3-V2 Sumatra 输出几何验证（验证已有生产命令）===')
  console.log(`输入 PDF      : ${pdf}`)
  console.log(`contentOrient : ${contentOrient}${contentOrientRaw ? '' : (detectedOrient ? ' (auto-detected)' : ' (detect failed, default landscape)')}`)

  console.log(`paperOrient   : ${paperOrient}`)
  console.log(`rotation      : ${rotation}`)
  console.log(`纸张          : ${paperLabel}`)
  console.log(`baseFlag      : ${oc.baseFlag}${oc.rotate ? `, rotate=${oc.rotate}` : ''}`)
  console.log('')
  console.log(`▶ 生产 -print-settings (V2-A): "${printSettings}"`)
  console.log(`▶ Policy A 预测输出   : ${pol.policyA.wPx}×${pol.policyA.hPx}px (${pol.policyA.wMm}×${pol.policyA.hMm}mm, ${pol.policyA.orient})`)
  if (!pol.discriminant) {
    console.log(`   ⚠️ 此组合页尺寸无法区分 A/B（标准纸常见：方向被旗标钉死或恰巧一致）`)
    console.log(`      真正的 A/B 判别器 = 230×160 + disable-auto-rotation（需 Wondershare 自定义纸）。旋转方向见 V2-02。`)
  }
  console.log('')

  if ((dryRun || !printer) && !measureOnly) {
    if (!printer) console.log('（未指定 --printer，仅输出 -print-settings 字符串。V2-B 需 --printer=<虚拟PDF writer> + --out）')
    return
  }

  // V2-B：把已有生产命令路由到虚拟 PDF writer
  if (!fs.existsSync(sumatra)) { console.error(`❌ SumatraPDF 不存在: ${sumatra}（用 --sumatra 指定）`); process.exit(2) }
  if (!out) { console.error('❌ V2-B 需 --out <输出PDF路径>（脚本期望 writer 静默保存到此处；SumatraPDF -print-to 本身不能指定路径）'); process.exit(2) }

  // 确保输出目录存在（writer 若配置保存到此处需要目录）
  const outDir = path.dirname(path.resolve(out))
  try { fs.mkdirSync(outDir, { recursive: true }) } catch {}

  // 抓取目录：用户指定(--search-dir)优先 + 输出目录 + cwd + 常见用户目录 + Wondershare 候选
  const searchDirs = []
  if (searchDir) searchDirs.push(...searchDir.split(',').map(s => s.trim()).filter(Boolean).map(s => path.resolve(s)))
  searchDirs.push(outDir, process.cwd())
  const userDir = process.env.USERPROFILE || process.env.HOME
  if (userDir) searchDirs.push(
    path.join(userDir, 'Desktop'),                                // Wondershare 虚拟打印机本机实测默认落盘目录
    path.join(userDir, 'Documents'),
    path.join(userDir, 'Downloads'),
    path.join(userDir, 'PDF24'),                                // PDF24 静默自动保存默认目录（已弃用，仅兜底）
    path.join(userDir, 'AppData', 'Local', 'Temp', 'PDF24'),    // PDF24 任务暂存(.ps)目录
    // Wondershare 候选输出目录（本机实测默认落到 Desktop；不确定时务必用 --search-dir 显式传入）
    path.join(userDir, 'Documents', 'PDFelement'),
    path.join(userDir, 'PDFelement'),
    path.join(userDir, 'AppData', 'Roaming', 'Wondershare', 'PDFelement10', 'Output')
  )
  const uniqDirs = [...new Set(searchDirs)].filter(d => fs.existsSync(d))

  // ── --measure-only：跳过 Sumatra 调用与 writer 捕获，直接分析已落盘的 artifact ──
  // 这就是把「虚拟打印机 env 适配」(writer 落盘/对话框) 与「rotation contract 验证」(V2-01/02/03) 解耦的开关。
  // 用法：先用 --printer 跑一次拿到 writer 输出文件，再以此模式 + --out <该文件> 复跑分析，无需重打。
  if (measureOnly) {
    console.log('（--measure-only：跳过 Sumatra 调用与 writer 捕获，直接对 --out 做 V2-01/02/03 分析）')
    const r = measure(out, python, rot0Out, pol, oc.baseFlag, uniqDirs)
    process.exit(r ? 0 : 1)
  }

  const args = ['-print-to', printer, '-print-settings', printSettings, '-silent', '-exit-when-done', pdf]
  console.log(`▶ 调用 SumatraPDF（同生产 -print-settings，目标=虚拟 writer）: ${sumatra}`)
  console.log(`  args: ${args.join(' ')}`)
  console.log(`  期望输出: ${out}（SumatraPDF -print-to 不能指定路径；writer 落到此或下方搜索目录）`)
  console.log(`  搜索目录: ${uniqDirs.join(' | ')}`)

  const t0 = Date.now()
  execFile(sumatra, args, { timeout: 120000 }, (err) => {
    const dur = Date.now() - t0
    if (err) {
      console.error(`❌ SumatraPDF 调用失败 (${dur}ms): ${err.message}`)
      if (err.stderr) console.error(`   stderr: ${String(err.stderr).trim()}`)
      if (err.stdout) console.error(`   stdout: ${String(err.stdout).trim()}`)
      process.exit(1)
    }
    console.log(`✅ SumatraPDF 返回 (${dur}ms)`)
    setTimeout(() => {
      const rot90 = measure(out, python, rot0Out, pol, oc.baseFlag, uniqDirs)
      if (!rot90) process.exit(1)
    }, 2500)
  })
}

function measure(outPdf, python, rot0Out, pol, baseFlag, searchDirs = []) {
  if (!fs.existsSync(outPdf)) {
    const grabbed = grabOutput(outPdf, searchDirs)
    if (!grabbed) {
      const staging = detectPdf24Staging()
      console.error(`❌ 输出 PDF 未生成: ${outPdf}`)
      console.error('   原因: SumatraPDF -print-to 不能指定输出路径，文件落在虚拟 writer 自己决定的位置。')
      if (staging.length) {
        console.error(`   ⚠️ 检测到 PDF24 已把任务暂存为 .ps（${staging.join('; ')}）但未生成 PDF。`)
        console.error('      PDF24 不适合自动化验证（已弃用），请改用 Wondershare PDFelement。')
      }
      console.error('   解决: 用 --search-dir <Wondershare实际输出目录> 显式指定（最稳）；')
      console.error('         并确认 Wondershare 已配置静默保存到该目录、且 230×160 用「PostScript」自定义纸型。')
      return null
    }
    outPdf = grabbed
  }
  console.log(`\n▶ 测量 rot90 artifact: ${outPdf}`)
  const d90 = runProbe(outPdf, python)
  if (!d90) return null
  const m90 = computeMetrics(d90)
  if (!m90) { console.error('⚠️ 无法从 probe 解析 MediaBox'); return null }

  console.log(`\n── V2-01 Source Media Geometry ──`)
  console.log(`   MediaBox : ${m90.wPx}×${m90.hPx}px (${m90.wMm}×${m90.hMm}mm, ${m90.orient})`)
  const A = pol.policyA, B = pol.policyB
  console.log(`   Policy A : ${A.wPx}×${A.hPx}px (${A.wMm}×${A.hMm}mm, ${A.orient}) [纸面跟随内容]`)
  console.log(`   Policy B : ${B.wPx}×${B.hPx}px (${B.wMm}×${B.hMm}mm, ${B.orient}) [内容在固定纸内]`)
  const TOL_MM = 8
  const nearA = Math.abs(m90.wMm - A.wMm) <= TOL_MM && Math.abs(m90.hMm - A.hMm) <= TOL_MM
  const nearB = Math.abs(m90.wMm - B.wMm) <= TOL_MM && Math.abs(m90.hMm - B.hMm) <= TOL_MM
  // 判别有效性：仅当「disable-auto-rotation + 页尺寸确有差异」时，V2-01 才能裁决 A/B。
  // 标准纸常因 landscape/portrait 旗标钉死方向 → 页尺寸无法区分，此时 V2-01 只报告实测值。
  const canDiscriminate = pol.discriminant && baseFlag === 'disable-auto-rotation'
  let paperVerdict = 'INVALID'
  if (canDiscriminate && nearA) {
    paperVerdict = 'A'
    console.log(`   → ✅ 尺寸+方向吻合 Policy A (${A.wMm}×${A.hMm}mm ${A.orient})`)
  } else if (canDiscriminate && nearB) {
    paperVerdict = 'B'
    console.log(`   → ⚠️ 吻合 Policy B (${B.wMm}×${B.hMm}mm ${B.orient})，需修订 rotation contract`)
  } else if (canDiscriminate) {
    console.log(`   → 🔴 纸尺寸 ${m90.wMm}×${m90.hMm}mm 既非 Policy A 也非 Policy B`)
    console.log(`      疑似虚拟 writer 把自定义纸夹成标准纸。该 artifact 对 Policy A/B 裁决无效。`)
    console.log(`      解决: 换忠实自定义纸的 writer (Wondershare 配置 230×160 自定义纸)`)
  } else {
    console.log(`   → ℹ️ 此纸型/旗标组合页尺寸无法区分 A/B（实测 ${m90.wMm}×${m90.hMm}mm ${m90.orient}）`)
    console.log(`      旋转方向正确性见 V2-02；A/B 判别需 230×160 + disable-auto-rotation(Wondershare)。`)
    paperVerdict = 'NONDISCRIM'
  }

  console.log(`\n── V2-02 Content Rotation ──`)
  // V2-02 边距参考：非 A1 自定义纸时，A1 的 C5 边距参考不适用，必须用同纸型 rot0 artifact。
  const isA1Custom = Math.abs(customW - 230) < 1 && Math.abs(customH - 160) < 1
  let refMargins = C5_ROT0_MARGINS_MM
  let refLabel = 'A3-3-3 C5 rot0 参考(A1)'
  let refUsable = isA1Custom
  if (rot0Out && fs.existsSync(rot0Out)) {
    console.log(`   测量 rot0 artifact: ${rot0Out}`)
    const d0 = runProbe(rot0Out, python)
    const m0 = d0 ? computeMetrics(d0) : null
    if (m0 && m0.margins) { refMargins = m0.margins; refLabel = '同纸型 Sumatra rot0 artifact(自包含)'; refUsable = true }
    else console.log(`   ⚠️ rot0 artifact 解析失败`)
  } else if (!isA1Custom) {
    console.log(`   ⚠️ 未提供 --rot0-out，且当前非 A1 自定义纸 → A1 的 C5 边距参考不适用，跳过边距校验`)
    console.log(`      如需 V2-02，请先用同纸型 rot0 跑一次并传 --rot0-out`)
  }
  const expected = rotateMargins90CW(refMargins)
  if (m90.margins && refUsable) {
    console.log(`   rot90 边距 : L=${m90.margins.L} T=${m90.margins.T} R=${m90.margins.R} B=${m90.margins.B}`)
    console.log(`   ${refLabel} rot0: L=${refMargins.L} T=${refMargins.T} R=${refMargins.R} B=${refMargins.B}`)
    console.log(`   90°CW 预期 : L'=B=${expected.L} T'=L=${expected.T} R'=T=${expected.R} B'=R=${expected.B}`)
    const permOk = marginMultisetMatch(m90.margins, expected, 5)
    console.log(`   → 边距置换${permOk ? '✅ 守恒(L\'=B,T\'=L,R\'=T,B\'=R)' : '⚠️ 不守恒，查旋转方向/虚拟 writer'}`)
  } else if (m90.margins) {
    console.log(`   rot90 边距 : L=${m90.margins.L} T=${m90.margins.T} R=${m90.margins.R} B=${m90.margins.B}（参考缺失，未校验）`)
  } else {
    console.log(`   ⚠️ rot90 artifact 无 content bbox（空白页？），跳过边距校验`)
  }

  console.log(`\n── V2-03 Canvas ↔ Source ──`)
  if (paperVerdict === 'A') {
    console.log('✅ Policy A 吻合：source 几何=canvas 纸面跟随内容旋转')
    console.log('   → A3-C5 Source Semantic Alignment = PASS（待用户真机确认写入冻结状态）')
  } else if (paperVerdict === 'B') {
    console.log('⚠️ Policy B 倾向：source 纸面固定 + 内容旋转在内')
    console.log('   → 需修订 rotation contract（冻结文档 §14.24.4 情况 B），A3-C5 Source Alignment 转「修订中」')
  } else if (paperVerdict === 'NONDISCRIM') {
    console.log('ℹ️ 非 A/B 判别组合：页尺寸已记录，旋转方向见 V2-02。')
    console.log('   A3-C5 Source Alignment 的 A/B 判别仍依赖 230×160(Wondershare) artifact。')
  } else {
    console.log('🔴 无法裁决：artifact 纸面被 clamp，V2-01 无效。换忠实自定义纸的 writer 后重跑。')
  }
  return m90
}

main()
