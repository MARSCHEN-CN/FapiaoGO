/**
 * Paper Orientation Semantic Audit — 冻结 Gate（Commit 0）
 *
 * 作用：把 2026-08-08 审计的两张表现存为「表征测试」，锁定**当前（含已知 bug 的）行为**。
 *
 * 为什么这样设计（bisect 纪律）：
 *   - 这是 P0-1/P0-2/P0-3 修复序列的**安全地基**。
 *   - Commit 1（纯语义改名）→ 本 Gate 必须仍全绿（证明行为零变化）。
 *   - Commit 2（修 swap：needSwap = requested !== shape）→ A4 行不变，Voucher 行「反了」必须变「OK」，
 *     届时在本文件更新 Voucher 行的期望值即 Commit 2 的验收动作。
 *   - Commit 4（UI orientation 打通到 Sumatra）→ 表 B 出现 UI 分化。
 *
 * 运行：
 *   node frontend/src/print/__tests__/paperOrientationFreezeGate.test.mjs
 *
 * 注意：本文件刻意不依赖 vitest/jest，纯 node:assert + process.exit，
 * 以便随时复跑、且能在 CI 之外作为「行为快照」手动验证。
 *
 * ⚠️ 当前锁定的 Voucher 行为（portrait→landscape、landscape→portrait）是**已知 bug 基线**，
 * 不是「正确值」。修 BLOCKER-1 时请同步更新表 A 的 Voucher 四行期望值。
 */

import assert from 'node:assert'
import { createRequire } from 'node:module'

// electron/print-service 是 CJS，用 createRequire 加载（与审计探针同构）
const require = createRequire(import.meta.url)
const { getPaperShapeOrientation, resolveOrientationCommands } = require(
  '../../../../electron/print-service/print-settings.js'
)

const { buildPrintPreviewModel } = await import('../PrintPreviewModel.js')
const { buildPrintExecutionPlan } = await import('../buildPrintExecutionPlan.js')

const PREVIEW_DPI = 300

// 横票：210mm x 99mm（典型增值税电子发票横票）
function mkLandscapeInvoice() {
  return {
    key: 'f1', name: '横票.pdf', status: 'parsed', printPath: 'x.pdf',
    _pdfPageWidth: 210 / 25.4 * 72,
    _pdfPageHeight: 99 / 25.4 * 72,
  }
}

function probePreview(paperSize, uiLandscape) {
  const file = mkLandscapeInvoice()
  const settings = {
    paperSize, landscape: uiLandscape, mergeMode: 'none',
    marginLeft: 3, marginRight: 3, marginTop: 3, marginBottom: 3,
  }
  // 屏蔽 PrintPreviewModel 内的 [DIAG-*] 噪音
  const origLog = console.log
  console.log = () => {}
  const plan = buildPrintExecutionPlan([file], { settings, fileRotations: {} })
  const m = buildPrintPreviewModel(plan, { files: [file], settings })
  console.log = origLog

  const p = m.pages[0]
  const s = p.slots[0]
  const geoW = p.paperSizeMM.widthMM
  const geoH = p.paperSizeMM.heightMM
  const geoOrient = geoW > geoH ? 'landscape' : 'portrait'
  return {
    paperSize,
    ui: uiLandscape ? 'landscape' : 'portrait',
    geoW, geoH,
    geoOrient,
    modelOrientation: p.requestedPaperOrientation,
    consistent: geoOrient === p.requestedPaperOrientation,
    layoutRotation: s.layoutRotation,
    scale: s.placement ? s.placement.scale : null,
  }
}

// ══════════════════════════════════════════════════════════════════
// 表 A — Preview / Print 链（buildPrintPreviewModel 输出）
// 锁定当前行为：A4 一致、Voucher 反转（已知 bug 基线）
// ══════════════════════════════════════════════════════════════════
const tableA = [
  // A4 — 基础纸型竖向，当前代码正确
  { paperSize: 'A4', ui: 'portrait',  geoW: 209.97, geoH: 297.01, geoOrient: 'portrait',  modelOrientation: 'portrait',  consistent: true,  layoutRotation: -90, scaleApprox: 1.386 },
  { paperSize: 'A4', ui: 'landscape', geoW: 297.01, geoH: 209.97, geoOrient: 'landscape', modelOrientation: 'landscape', consistent: true,  layoutRotation: 0,   scaleApprox: 1.386 },
  // Voucher240x140 — 基础纸型横向；Commit 2 修 B1 后 UI 与几何一致（反了→OK）
  { paperSize: 'Voucher240x140', ui: 'portrait',  geoW: 140.04, geoH: 240.03, geoOrient: 'portrait',  modelOrientation: 'portrait',  consistent: true, layoutRotation: -90, scaleApprox: 1.114 },
  { paperSize: 'Voucher240x140', ui: 'landscape', geoW: 240.03, geoH: 140.04, geoOrient: 'landscape', modelOrientation: 'landscape', consistent: true, layoutRotation: 0,   scaleApprox: 1.114 },
]

// ══════════════════════════════════════════════════════════════════
// 表 B — Sumatra 链（print-backend.js:129 实际调用的 getPaperShapeOrientation）
// 锁定当前行为：UI orientation 完全未进入此链（BLOCKER-3 bug 基线，Commit 4 时改）
// ══════════════════════════════════════════════════════════════════
const tableB = []
for (const paper of ['A4', 'Voucher240x140']) {
  // 复刻 print-backend.js:129：getPaperShapeOrientation(paper, customPaper) 无 UI 入参
  const sent = getPaperShapeOrientation(paper, undefined)
  const r = resolveOrientationCommands('landscape', sent, 0)
  tableB.push({
    paper,
    // 当前：UI 选 portrait / landscape 送给 Sumatra 的值完全相同（UI 被丢弃）
    sentOrientation: sent,
    baseFlag: r.baseFlag,
    rotate: r.rotate,
    // 锁定「UI 无影响」：同一纸型两种 UI 都走同一 sent 值
    uiIndependent: true,
  })
}

// ───────────────────────── 执行断言 ─────────────────────────
let failed = 0
const fail = (msg) => { failed++; console.error('  ✗ ' + msg) }
const ok = (msg) => { console.log('  ✓ ' + msg) }

console.log('\n[Gate A] Preview / Print 链 — 锁定当前行为（含 Voucher 反转 bug）')
for (const c of tableA) {
  const r = probePreview(c.paperSize, c.ui === 'landscape')
  const tag = `${c.paperSize}/${c.ui}`
  // 物理几何（mm，±0.05 容差）
  if (Math.abs(r.geoW - c.geoW) > 0.05 || Math.abs(r.geoH - c.geoH) > 0.05) {
    fail(`${tag} 几何 ${r.geoW}x${r.geoH} ≠ 锁定 ${c.geoW}x${c.geoH}`)
  } else ok(`${tag} 几何 ${r.geoW.toFixed(2)}x${r.geoH.toFixed(2)}`)
  // 原生形状
  if (r.geoOrient !== c.geoOrient) fail(`${tag} 原生形状 ${r.geoOrient} ≠ ${c.geoOrient}`)
  // 标签（当前 = UI 标签，Voucher 下与几何相反）
  if (r.modelOrientation !== c.modelOrientation) {
    fail(`${tag} model.requestedPaperOrientation ${r.modelOrientation} ≠ 锁定 ${c.modelOrientation}`)
  } else ok(`${tag} model.orientation=${r.modelOrientation}`)
  // 一致性（A4=true / Voucher=false，这是 bug 基线的核心断言）
  if (r.consistent !== c.consistent) {
    fail(`${tag} 一致性 ${r.consistent} ≠ 锁定 ${c.consistent}（这是 bug 基线的核心）`)
  } else ok(`${tag} 一致?=${r.consistent}`)
  // layoutRotation（精确整数）
  if ((r.layoutRotation ?? 0) !== c.layoutRotation) {
    fail(`${tag} layoutRotation ${r.layoutRotation} ≠ 锁定 ${c.layoutRotation}`)
  } else ok(`${tag} layoutRotation=${r.layoutRotation}`)
  // scale（±0.01 容差）
  if (r.scale == null || Math.abs(r.scale - c.scaleApprox) > 0.01) {
    fail(`${tag} scale ${r.scale} ≠ 锁定≈${c.scaleApprox}`)
  } else ok(`${tag} scale=${r.scale.toFixed(3)}`)
}

console.log('\n[Gate B] Sumatra 链 — 锁定当前行为（UI orientation 未进入）')
for (const c of tableB) {
  const paper = c.paper
  const sent = getPaperShapeOrientation(paper, undefined)
  if (sent !== c.sentOrientation) {
    fail(`${paper} 送 Sumatra=${sent} ≠ 锁定 ${c.sentOrientation}`)
  } else ok(`${paper} 送 Sumatra=${sent}（与 UI 无关 = 当前 bug 基线）`)
  const r = resolveOrientationCommands('landscape', sent, 0)
  if (r.baseFlag !== c.baseFlag) fail(`${paper} baseFlag=${r.baseFlag} ≠ ${c.baseFlag}`)
  if (r.rotate !== c.rotate) fail(`${paper} rotate=${r.rotate} ≠ ${c.rotate}`)
}

console.log('')
if (failed > 0) {
  console.error(`\n❌ 冻结 Gate 失败：${failed} 项断言不符。当前行为已漂移，禁止继续 Commit 1/2 直到排查。`)
  process.exit(1)
} else {
  console.log('✅ 冻结 Gate 通过：当前行为已锁定（含 Voucher 反转 / Sumatra UI-丢弃 两个已知 bug 基线）。')
  console.log('   下一步：Commit 1 纯改名后本 Gate 必须仍全绿；Commit 2 修 swap 时同步更新表 A 的 Voucher 行。')
  process.exit(0)
}
