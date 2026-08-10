#!/usr/bin/env node
/**
 * A3-V2 Sumatra executor capability verification — 7-case 矩阵（2026-08-10）
 *
 * 定位：回答「Sumatra 在失去几何解释权后，能否成为纯 executor」（用户 A3-01~07 矩阵）。
 *       不是业务正确性验证，是 capability verification。
 *
 * 被测命令 = 生产 buildPrintSettings 的 1:1 复刻（与 verify_sumatra_rotation.js 同源，
 *       逐字符一致，避免测了一个不一样的 Sumatra 调用）。
 *
 * 测试矩阵（用户批准）：
 *   A3-01 portrait paper  + portrait content  → 原样输出（无 rotate、无 fit 干涉）
 *   A3-02 landscape paper + landscape content → 原样输出
 *   A3-03 landscape content + portrait paper  → 是否需要外部 placement rotation（纸内容方向冲突）
 *   A3-04 portrait content + landscape paper  → 同上（反向）
 *   A3-05 asymmetric margin                   → 是否保持 offset（边距不被 fit 抹平）
 *   A3-06 noscale                             → 是否关闭内部 fit（内容 1:1）
 *   A3-07 rotate 参数存在                      → 是否二次旋转（rotate=90 叠加时是否双转）
 *
 * 每 case 输出：
 *   - -print-settings（生产复刻）
 *   - artifact MediaBox（pt/mm）+ 方向（V2-01 语义）
 *   - content bbox 边距 L/T/R/B（V2-02 语义）
 *   - 结论标签：EXEC_AS_IS / NEEDS_PLACEMENT_ROT / SECONDARY_ROTATE / FIT_INTERFERED / OK
 *
 * 依赖：
 *   - E:/print706/resources/sumatra/SumatraPDF.exe（便携版）
 *   - capture writer: Wondershare PDFelement（默认打印机，已验证可静默落盘到 Desktop）
 *   - scripts/probe_render_resource_fitz.py（fitz 探针）
 *   - backend/venv/Scripts/python.exe
 *
 * 用法：
 *   # 全部 7 case（每个 case 依次 Sumatra→Wondershare→grab→probe）
 *   node scripts/verify_sumatra_capability.mjs --out-dir frontend/test/printGate/marginContract/.out/a3v2
 *   # 单 case
 *   node scripts/verify_sumatra_capability.mjs --only A3-06
 *   # 不调 Sumatra，直接分析已落盘 artifact（--measure-only，writer 解耦）
 *   node scripts/verify_sumatra_capability.mjs --measure-only --out-dir frontend/test/printGate/marginContract/.out/a3v2
 *   # dry-run：只打印 7 条 -print-settings（无需打印机）
 *   node scripts/verify_sumatra_capability.mjs --dry-run
 *
 * 退出码：0 = 全部 case 有 artifact 且无 SECONDARY_ROTATE/FIT_INTERFERED；1 = 有异常。
 * ⚠️ 本脚本不改任何生产代码；Wondershare 落盘位置未知时用 --search-dir 显式指定。
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const SUMATRA = path.resolve(REPO, 'resources', 'sumatra', 'SumatraPDF.exe')
const PYTHON = path.join(REPO, 'backend', 'venv', 'Scripts', 'python.exe')
const PROBE = path.resolve(REPO, 'scripts', 'probe_render_resource_fitz.py')
const DPI = 300
const MM_PER_PX = 25.4 / DPI

// ─── 1. 生产 buildPrintSettings（RG-3 起直接 require 生产模块——消除「复刻漂移」风险：
//     本脚本验证的是生产命令本身，不是一份可能过期的拷贝） ───
const { buildPrintSettings, resolveOrientationCommands } = require(path.join(REPO, 'electron', 'print-service', 'print-settings.js'))

// ─── 2. 7-case 矩阵定义 ───
// content = 内容 PDF 文件；paper = 目标纸；orientation 组合由 contentOrient/paperOrient 表达。
// expected 描述「Plan placement 语义下的预期 Sumatra 行为」。
const CASES = [
  {
    id: 'A3-01',
    name: 'portrait paper + portrait content',
    content: 'frontend/test/printGate/marginContract/.out/a3v2_portrait_content.pdf',
    paper: 'a4', paperOrient: 'portrait', contentOrient: 'portrait', rotation: 0, fit: 'contain',
    expected: 'EXEC_AS_IS — 内容方向==纸方向，无 rotate 旗标；artifact MediaBox ≈ A4 portrait 595×842pt，边距 ≈ 源内容位置',
    ask: ['原样输出'],
  },
  {
    id: 'A3-02',
    name: 'landscape paper + landscape content',
    content: 'test_fixtures/a4_landscape_sample.pdf',
    paper: 'a4', paperOrient: 'landscape', contentOrient: 'landscape', rotation: 0, fit: 'contain',
    expected: 'EXEC_AS_IS — 方向一致；artifact MediaBox ≈ A4 landscape 842×595pt',
    ask: ['原样输出'],
  },
  {
    id: 'A3-03',
    name: 'landscape content + portrait paper',
    content: 'test_fixtures/25952000000127675627.pdf',
    paper: 'a4', paperOrient: 'portrait', contentOrient: 'landscape', rotation: 0, fit: 'contain',
    expected: 'NEEDS_PLACEMENT_ROT — 横票竖纸：Sumatra 只能 fit 到竖纸（内容被转/缩放由 Sumatra 决定），真实打印若需「内容旋转后仍读得清」必须由外部 placement rotation 提供，Sumatra 侧 fit 会自行缩放',
    ask: ['是否需要外部 placement rotation'],
  },
  {
    id: 'A3-04',
    name: 'portrait content + landscape paper',
    content: 'frontend/test/printGate/marginContract/.out/a3v2_portrait_content.pdf',
    paper: 'a4', paperOrient: 'landscape', contentOrient: 'portrait', rotation: 0, fit: 'contain',
    expected: 'NEEDS_PLACEMENT_ROT — 竖票横纸：反向组合',
    ask: ['是否需要外部 placement rotation'],
  },
  {
    id: 'A3-05',
    name: 'asymmetric margin',
    content: 'frontend/test/printGate/marginContract/.out/a3v2_asym_margin.pdf',
    paper: 'a4', paperOrient: 'portrait', contentOrient: 'portrait', rotation: 0, fit: 'contain',
    expected: 'FIT_INTERFERED 风险 — margin 已 bake 进内容，Sumatra fit 到同尺寸纸时 offset 保持；若纸尺寸被改（如 writer 夹纸）则 offset 丢失',
    ask: ['是否保持 offset'],
  },
  {
    id: 'A3-06',
    name: 'noscale',
    content: 'frontend/test/printGate/marginContract/.out/a3v2_portrait_content.pdf',
    paper: 'a4', paperOrient: 'portrait', contentOrient: 'portrait', rotation: 0, fit: 'none',
    expected: 'OK — noscale 关闭内部 fit：内容 1:1 输出（源 A4 portrait → artifact 同尺寸同位置）',
    ask: ['是否关闭内部 fit'],
  },
  {
    id: 'A3-07',
    name: 'rotate=90 参数存在',
    content: 'frontend/test/printGate/marginContract/.out/a3v2_portrait_content.pdf',
    paper: 'a4', paperOrient: 'portrait', contentOrient: 'portrait', rotation: 90, fit: 'contain',
    expected: 'SECONDARY_ROTATE 风险 — rotate=90 由 resolveOrientationCommands 给出（portrait|portrait 90→0，实际不会发 rotate=90；若发了说明 ROTATE_LOOKUP 有洞）→ 验证 Sumatra 收到 rotate=N 是否二次旋转',
    ask: ['rotate 参数存在时是否二次旋转'],
  },
]

// ─── 3. 探针与测量（复用 verify_sumatra_rotation.js 语义） ───
function runProbe(pdf) {
  if (!fs.existsSync(PROBE)) { console.error(`⚠️ 未找到 probe: ${PROBE}`); return null }
  try {
    const out = execFileSync2(PYTHON, [PROBE, pdf, String(DPI)])
    return JSON.parse(out)
  } catch (e) {
    console.error(`⚠️ 测量失败: ${e.message}`)
    return null
  }
}

function execFileSync2(cmd, args) {
  return execFileSync(cmd, args, { timeout: 120000 }).toString()
}

function computeMetrics(data) {
  // ⚠️ 视觉方向判定必须用 /Rotate 归一后的尺寸（pixmap_px：get_pixmap 自动应用 /Rotate），
  // 不能用原始 mediabox_px——Sumatra 输出用 /Rotate 属性表达方向，MediaBox 恒为 595×842（A4 portrait 原始）。
  const mbPx = data.pixmap_px || data.mediabox_px
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

// ─── 4. 抓取 writer 落盘 ───
// Wondershare PDFCreator 保留原文件名 + `_N` 后缀（如 a3v2_portrait_content_3.pdf）。
// ⚠️ 2026-08-10 RG-3 修复：按 mtime 抓「最新任意 PDF」会在同内容多次打印时抓错
// （窗口内旧副本 mtime 也可能最新）——必须按内容文件名前缀匹配 + mtime 最新。
function grabOutput(outPdf, searchDirs, baseName, maxAgeMs = 120000) {
  const cutoff = Date.now() - maxAgeMs
  // ⚠️ 2026-08-10 修复：baseName 必须取裸文件名（Wondershare 落盘保留的是
  // 原文件名不含路径；传相对路径会导致 stem 含斜杠永远匹配不上）。
  const stem = path.basename(baseName).replace(/\.pdf$/i, '')
  let best = null
  for (const dir of searchDirs) {
    let names = []
    try { names = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf')) } catch { continue }
    for (const f of names) {
      // 匹配「原文件名」或「原文件名_N」（Wondershare 副本命名）
      if (!(f === stem + '.pdf' || new RegExp(`^${escapeReg(stem)}_\\d+\\.pdf$`).test(f))) continue
      const full = path.join(dir, f)
      let st
      try { st = fs.statSync(full) } catch { continue }
      if (st.mtimeMs >= cutoff && (!best || st.mtimeMs > best.mtimeMs)) best = { full, mtimeMs: st.mtimeMs }
    }
  }
  if (!best) return null
  try { fs.copyFileSync(best.full, outPdf) } catch (e) { console.error(`⚠️ 抓取失败: ${e.message}`); return null }
  console.log(`   ▶ 抓取 writer 输出: ${best.full} → ${outPdf}`)
  return outPdf
}

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// ─── 5. 主流程 ───
function main() {
  const argv = process.argv.slice(2)
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
  const outDir = get('--out-dir', path.join(REPO, 'frontend/test/printGate/marginContract/.out/a3v2'))
  const only = get('--only', '')
  const dryRun = argv.includes('--dry-run')
  const measureOnly = argv.includes('--measure-only')
  const printer = get('--printer', 'Wondershare PDFelement')
  const searchDir = get('--search-dir', '')

  fs.mkdirSync(outDir, { recursive: true })

  const userDir = process.env.USERPROFILE || process.env.HOME
  const searchDirs = []
  if (searchDir) searchDirs.push(...searchDir.split(',').map(s => s.trim()).filter(Boolean).map(s => path.resolve(s)))
  searchDirs.push(outDir, process.cwd())
  if (userDir) searchDirs.push(
    path.join(userDir, 'Desktop'),
    path.join(userDir, 'Documents'),
    path.join(userDir, 'Downloads'),
    path.join(userDir, 'Documents', 'PDFelement'),
    path.join(userDir, 'PDFelement'),
  )
  // Wondershare PDFCreator 实测落盘目录（保留原文件名 + _N 后缀；2026-08-10 实测）
  searchDirs.push('C:/ProgramData/Wondershare/PDFelement10/PDFCreator')
  const uniqDirs = [...new Set(searchDirs)].filter(d => fs.existsSync(d))

  const active = CASES.filter(c => !only || c.id === only)
  if (!active.length) { console.error('❌ 无匹配 case'); process.exit(2) }

  console.log('=== A3-V2 Sumatra executor capability verification（7-case）===')
  console.log(`Sumatra: ${SUMATRA}`)
  console.log(`printer: ${printer}`)
  console.log(`out-dir: ${outDir}`)
  console.log('')

  let allOk = true
  const summary = []

  for (const c of active) {
    // RG-3 两通道：纸向（paperOrientation=case 请求方向）+ 内容旋转（contentRotation=case rotation）
    const oc = resolveOrientationCommands({ paperOrientation: c.paperOrient, contentRotation: c.rotation })
    const ps = {
      rotation: c.rotation, paper: c.paper, paperOrientation: c.paperOrient,
      contentOrientation: c.contentOrient, fit: c.fit,
      customPaper: c.paper === 'custom' ? { widthMM: 210, heightMM: 297 } : undefined,
    }
    const printSettings = buildPrintSettings(ps)
    const contentPath = path.resolve(REPO, c.content)

    console.log(`── ${c.id} ${c.name} ──`)
    console.log(`  content: ${c.content} (${fs.existsSync(contentPath) ? 'ok' : 'MISSING'})`)
    console.log(`  -print-settings: "${printSettings}"`)
    console.log(`  paperOrient=${oc.paperOrientation} contentRotation=${oc.contentRotation} fit=${c.fit}`)

    if (!fs.existsSync(contentPath)) { console.error('  ❌ 内容 PDF 缺失，跳过'); allOk = false; continue }

    if (dryRun) {
      console.log(`  (dry-run) 预期: ${c.expected}`)
      console.log('')
      continue
    }

    const outPdf = path.join(outDir, `${c.id}.pdf`)

    if (!measureOnly) {
      if (!fs.existsSync(SUMATRA)) { console.error(`  ❌ SumatraPDF 不存在: ${SUMATRA}`); allOk = false; continue }
      const args = ['-print-to', printer, '-print-settings', printSettings, '-silent', '-exit-when-done', contentPath]
      try {
        execFileSync2(SUMATRA, args)
      } catch (e) {
        console.error(`  ❌ Sumatra 调用失败: ${e.message}`)
        allOk = false
        continue
      }
      // 等待 writer 落盘（轮询抓取：按内容文件名匹配 + mtime 最新，最晚 30s）
      const baseName = path.basename(contentPath)
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        // ⚠️ 必须检查「非空」而非「存在」——空文件（上一轮残留）会跳过 grab 导致读到 0 字节
        if (fs.existsSync(outPdf) && fs.statSync(outPdf).size > 0) break
        if (grabOutput(outPdf, uniqDirs, baseName, 120000)) break
        awaitSleep(1500)
      }
    }

    if (!fs.existsSync(outPdf)) {
      console.error(`  ❌ artifact 未生成: ${outPdf}`)
      allOk = false
      continue
    }

    const d = runProbe(outPdf)
    if (!d) { console.error('  ❌ probe 失败'); allOk = false; continue }
    const m = computeMetrics(d)
    if (!m) { console.error('  ❌ 无法解析 MediaBox'); allOk = false; continue }

    console.log(`  artifact 视觉尺寸: ${m.wMm}×${m.hMm}mm (${m.orient}) | ${m.wPx}×${m.hPx}px | /Rotate=${d.rotation ?? '?'}`)
    if (m.margins) {
      console.log(`  content 边距(视觉坐标): L${m.margins.L} T${m.margins.T} R${m.margins.R} B${m.margins.B} mm`)
    }

    // ── case 判定（RG-3 语义：纸向=命令决定，内容=rotate=N）──
    // 核心机制（A3-V2 + RG-3 对照实验实测）：
    //   Sumatra 忠实执行命令：disable-auto-rotation → 视觉竖纸（/Rotate=0）；
    //   landscape → 视觉横纸（/Rotate=90）；rotate=N → 旋转烤进内容。
    //   内容方向不参与纸向决策（RG-3-A 两通道，rotationAuthorityGuard 锁定）。
    let verdict = 'OK'
    let flag = false
    if (c.id === 'A3-01') {
      // 竖纸竖内容：disable-auto-rotation + 无 rotate → 原样输出
      const ok = m.orient === 'portrait' && (d.rotation ?? 0) === 0
      verdict = ok ? 'EXEC_AS_IS ✓（原样输出，无旋转无缩放）' : '⚠️ 有干涉'
      flag = !ok
    } else if (c.id === 'A3-02') {
      // 横纸横内容：RG-3 后命令 = landscape（rotate=90 消失——旧 ROTATE_LOOKUP 混合副产物）
      // 纸向=landscape 由 Plan/请求方向决定，Sumatra 忠实输出横纸
      const ok = m.orient === 'landscape' && (d.rotation ?? 0) !== 0
      verdict = ok
        ? 'EXEC_AS_IS ✓（纸向=landscape（Plan authority），Sumatra 输出横纸 /Rotate=90；rotate=90 已按 RG-3-C 降级移除）'
        : '⚠️ 方向不一致'
      flag = !ok
    } else if (c.id === 'A3-03') {
      // 横票竖纸：RG-3 后命令 = disable-auto-rotation（纸向=竖，Plan authority）→
      // 实测必须竖纸（旧 landscape,fit 是内容劫持纸向 = SELF_ORIENT 违反 C2-R2）
      const paperOk = m.orient === 'portrait' && (d.rotation ?? 0) === 0
      verdict = paperOk
        ? 'PAPER_ORIENT_OK ✓（纸向=竖由 disable-auto-rotation 决定，内容不劫持纸向——C2-R2 达成）'
        : 'SELF_ORIENT ⚠️（纸向仍被内容劫持，违反 C2-R2）'
      flag = !paperOk
    } else if (c.id === 'A3-04') {
      // 竖票横纸：RG-3 后命令 = landscape（纸向=横）→ Sumatra 输出横纸 /Rotate=90
      const ok = m.orient === 'landscape' && (d.rotation ?? 0) !== 0
      verdict = ok
        ? 'PAPER_ORIENT_OK ✓（纸向=landscape（Plan authority），Sumatra 输出横纸）'
        : '⚠️ 纸向未按命令输出'
      flag = !ok
    } else if (c.id === 'A3-05') {
      // 非对称 margin：内容已 bake margin，Sumatra fit 到同纸应保持 offset
      const ok = m.margins && Math.abs(m.margins.L - m.margins.R) > 1
      verdict = ok ? 'OFFSET_PRESERVED ✓（非对称 offset 保持，fit 同尺寸纸不抹边距）' : 'FIT_INTERFERED ⚠️（offset 丢失/抹平）'
      flag = !ok
    } else if (c.id === 'A3-06') {
      // noscale：内容 1:1，边距应与源内容一致（源内容从 30mm 起）
      const ok = m.margins && Math.abs(m.margins.L - 30) < 2 && Math.abs(m.margins.T - 30) < 2
      verdict = ok ? 'NOSCALE_OK ✓（1:1 输出，内部 fit 关闭，位置保持）' : 'FIT_ACTIVE ⚠️（noscale 未生效）'
      flag = !ok
    } else if (c.id === 'A3-07') {
      // rotation=90（业务旋转）：RG-3 后命令 = disable-auto-rotation,rotate=90（纸向=竖 + 内容转 90）
      // 实测视觉竖纸 + /Rotate=0 + 内容居中：旋转烤进内容（content transform executor）
      const ok = m.orient === 'portrait' && (d.rotation ?? 0) === 0 && m.margins
        && Math.abs(m.margins.L - m.margins.R) < 2 && Math.abs(m.margins.T - m.margins.B) < 2
      verdict = ok
        ? 'ROTATE_EXECUTED ✓（rotate=90 直通 contentRotation，Sumatra 烤进内容；纸向=竖）'
        : '⚠️ rotate 执行异常'
      flag = !ok
    }

    console.log(`  判定: ${verdict}`)
    if (flag) allOk = false
    summary.push({ id: c.id, verdict, mediaBox: `${m.wMm}×${m.hMm}mm`, settings: printSettings })
    console.log('')
  }

  console.log('── 汇总 ──')
  for (const s of summary) console.log(`  ${s.id}: ${s.verdict} (${s.mediaBox})`)
  console.log(allOk ? 'ALL CASES OK' : 'HAS ABNORMAL CASES（见上）')
  process.exit(allOk ? 0 : 1)
}

function awaitSleep(ms) {
  // 同步 sleep（无 execSync hack）：Atomics.wait 在主线程可用
  const sab = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sab, 0, 0, ms)
}

main()
