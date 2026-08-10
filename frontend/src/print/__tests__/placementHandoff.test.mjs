/**
 * C-2 Step 4-1 — Plan → source job → IPC 数据链透传测试（G-C2-S4）
 *
 * 运行: node --test frontend/src/print/__tests__/placementHandoff.test.mjs
 *
 * 验证（只检查「handoff exists」，不检查值正确性——值由 executionPlanPaperGeometry 负责）：
 *   G-C2-S4-1  deriveSourcePrintJobs.toJob 携带 placement（Plan truth 不丢）
 *   G-C2-S4-2  toJob 携带 paper（needSwap 后物理纸几何）
 *   G-C2-S4-3  toJob 不重新计算（placement 与 plan.slots[0].placement 引用相等）
 *   G-C2-S4-4  usePrint 优先消费 job.placement（f?.placement ?? placements[f.key]）
 *   G-C2-S4-5  buildPrintSettings 输出 executionPaper 独立字段（不混入用户 paper）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createPrintPlanInput, buildPrintExecutionPlan } from '../buildPrintExecutionPlan.js'
import { deriveSourcePrintJobs } from '../deriveSourcePrintJobs.js'
import { resolvePaperSpec } from '../paperSpec.js'
import { resolveContentPlacement } from '../../layout/RotationResolver.js'

const require = createRequire(import.meta.url)

const PREVIEW_DPI = 300

// ── fixture ──
function mkInvoice(key = 'f1', { wPt = 595.28, hPt = 841.89 } = {}) {
  return {
    key,
    name: `${key}.pdf`,
    fileFormat: 'pdf',
    status: 'parsed',
    printPath: `C:/tmp/${key}.pdf`,
    invoiceType: '普通发票',
    _pdfPageWidth: wPt,
    _pdfPageHeight: hPt,
    invoiceDocumentId: `doc-${key}`,
  }
}

// 模拟 usePrint placements useMemo（C-2 Step 1-B 同源：resolvePaperSpec → resolveContentPlacement）
function computePlacements(files, settings, fileRotations = {}) {
  const result = {}
  const paper = resolvePaperSpec(settings)
  const margins = {
    left: settings.marginLeft ?? 3,
    right: settings.marginRight ?? 3,
    top: settings.marginTop ?? 3,
    bottom: settings.marginBottom ?? 3,
  }
  for (const f of files) {
    const contentRotation = fileRotations[f.key] || 0
    const contentPhysicalSize = {
      width: f._pdfPageWidth * PREVIEW_DPI / 72,
      height: f._pdfPageHeight * PREVIEW_DPI / 72,
    }
    try {
      result[f.key] = resolveContentPlacement({
        contentPhysicalSize,
        contentRotation,
        physicalPaper: { widthMM: paper.widthMM, heightMM: paper.heightMM },
        margins,
        dpi: PREVIEW_DPI,
      })
    } catch { /* 边距超纸等情况跳过 */ }
  }
  return result
}

function makePlan(files, settings, placements) {
  const { files: planFiles, options } = createPrintPlanInput(files, settings, {}, placements || {})
  return buildPrintExecutionPlan(planFiles, options)
}

const BASE_SETTINGS = {
  paperSize: 'A4', landscape: false, mergeMode: 'none',
  marginLeft: 3, marginRight: 3, marginTop: 3, marginBottom: 3,
}

test('G-C2-S4-1: deriveSourcePrintJobs.toJob 携带 placement（Plan truth handoff exists）', () => {
  const files = [mkInvoice()]
  const placements = computePlacements(files, BASE_SETTINGS)
  const plan = makePlan(files, BASE_SETTINGS, placements)
  const job = deriveSourcePrintJobs(plan, files)[0]

  assert.ok(job, 'job 存在')
  assert.ok(job.placement, 'job.placement 非空')
  // 引用相等：纯搬运，不重新计算
  assert.equal(job.placement, plan.pages[0].slots[0].placement,
    'job.placement 必须是 plan.slots[0].placement 的同引用（只搬运）')
  assert.equal(job._round, 1)
  assert.equal(job._jobKey, 'f1')
})

test('G-C2-S4-2: toJob 携带 paper（needSwap 后物理纸几何）', () => {
  const files = [mkInvoice()]
  const placements = computePlacements(files, BASE_SETTINGS)
  const plan = makePlan(files, BASE_SETTINGS, placements)
  const job = deriveSourcePrintJobs(plan, files)[0]

  assert.ok(job.paper, 'job.paper 非空')
  assert.equal(job.paper, plan.pages[0].paper, 'job.paper 是 plan.page.paper 同引用')
  assert.equal(job.paper.size, 'A4')
  assert.equal(job.paper.orientation, 'portrait')
  assert.equal(job.paper.widthMM, 210)
  assert.equal(job.paper.heightMM, 297)
})

test('G-C2-S4-3: toJob 不重新计算（与 plan 同引用，无独立派生）', () => {
  const files = [mkInvoice('f1'), mkInvoice('f2', { wPt: 841.89, hPt: 595.28 })]
  const placements = computePlacements(files, BASE_SETTINGS)
  const plan = makePlan(files, BASE_SETTINGS, placements)
  const jobs = deriveSourcePrintJobs(plan, files)

  assert.equal(jobs.length, 2)
  for (let i = 0; i < jobs.length; i++) {
    assert.equal(jobs[i].placement, plan.pages[i].slots[0].placement,
      `job[${i}].placement 与 plan 同引用`)
    assert.equal(jobs[i].paper, plan.pages[i].paper, `job[${i}].paper 与 plan 同引用`)
  }
})

test('G-C2-S4-4: 横打请求（landscape:true）→ job.paper.orientation=landscape + W/H 交换', () => {
  const files = [mkInvoice()]
  const ls = { ...BASE_SETTINGS, landscape: true }
  const placements = computePlacements(files, ls)
  const plan = makePlan(files, ls, placements)
  const job = deriveSourcePrintJobs(plan, files)[0]

  assert.equal(job.paper.orientation, 'landscape')
  assert.equal(job.paper.widthMM, 297)  // needSwap：A4 横打 = 297×210
  assert.equal(job.paper.heightMM, 210)
})

test('G-C2-S4-5: buildPrintSettings 输出 executionPaper 独立字段（源码契约级断言）', () => {
  // PrintService.js 依赖 frontend/src/config（vite import.meta.env），node 测试无法直接加载。
  // 契约断言改为源码级（配合 placementPreservationGuard 静态检查）：
  //   printSingleSourceFile / buildPrintSettings 签名含 executionPaper + 输出独立字段。
  const fs = require('node:fs')
  const path = require('node:path')
  const srcPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../services/PrintService.js')
  const src = fs.readFileSync(srcPath, 'utf8')

  // 1. printSingleSourceFile 签名含 executionPaper 参数（第 7 参）
  assert.match(src, /printSingleSourceFile\([^)]*placement, executionPaper\)/,
    'printSingleSourceFile 签名应含 executionPaper 参数')
  // 2. buildPrintSettings 签名含 executionPaper
  assert.match(src, /buildPrintSettings\([^)]*placement, executionPaper\)/,
    'buildPrintSettings 签名应含 executionPaper 参数')
  // 3. 输出 executionPaper 独立字段（不混入用户 paper）
  assert.match(src, /executionPaper:\s*executionPaper\s*\|\|\s*null/,
    'buildPrintSettings 应输出 executionPaper 独立字段')
  // 4. 生命周期分离：用户 paper 字段保持独立
  assert.match(src, /paper:\s*userSettings\.paperSize/,
    '用户 paper 字段保持独立（不混入 executionPaper）')
})

test('G-C2-S4-6: resolvePaperSpec 与 plan.paper 一致性（几何同源）', () => {
  const files = [mkInvoice()]
  const placements = computePlacements(files, BASE_SETTINGS)
  const plan = makePlan(files, BASE_SETTINGS, placements)
  const spec = resolvePaperSpec(BASE_SETTINGS)
  assert.equal(plan.pages[0].paper.orientation, spec.orientation)
  assert.equal(plan.pages[0].paper.widthMM, spec.widthMM)
  assert.equal(plan.pages[0].paper.heightMM, spec.heightMM)
})
