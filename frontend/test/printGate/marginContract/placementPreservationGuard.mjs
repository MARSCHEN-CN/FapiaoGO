#!/usr/bin/env node
/**
 * G-C2-S4-placement-preservation — C-2 Step 4-1（2026-08-10）
 *
 * 目标：防止未来有人再次把 Plan geometry 在 deriveSourcePrintJobs 映射时丢弃
 * （历史：toJob 只 return {...f, _jobKey, _round}，page.paper 与 slots[].placement 全丢）。
 *
 * 检查（authority handoff exists，不是值正确性）：
 *   1. deriveSourcePrintJobs.toJob 的 return 必须含 placement 字段（从 page.slots 搬运）
 *   2. 同 return 必须含 paper 字段（从 page.paper 搬运）
 *   3. 不得在 toJob 内重新调用 resolveContentPlacement / createPlacement（只搬运不计算）
 *   4. usePrint.printSingleSourceFile 必须消费 job.placement（f?.placement 优先）
 *   5. PrintService.buildPrintSettings 必须输出 executionPaper 独立字段（Plan truth 透传）
 *
 * 范围：frontend 数据链（source 轨）。electron 消费属 Step 4-2，不在本 guard。
 *
 * 用法: node printGate/placementPreservationGuard.mjs   （0 = PASS，1 = FAIL）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')

const DERIVE = path.join(REPO, 'frontend', 'src', 'print', 'deriveSourcePrintJobs.js')
const USEPRINT = path.join(REPO, 'frontend', 'src', 'hooks', 'usePrint.js')
const PRINTSVC = path.join(REPO, 'frontend', 'src', 'services', 'PrintService.js')

let fail = false

// ── 1+2: toJob return 含 placement + paper（authority handoff exists） ──
function checkDerive() {
  const src = fs.readFileSync(DERIVE, 'utf8')
  const m = src.match(/const toJob = \(page, round\) => \{[\s\S]*?\n  \}/)
  if (!m) { console.error('[S4-GUARD] FAIL: deriveSourcePrintJobs.toJob 未找到'); fail = true; return }
  const body = m[0]
  const hasPlacement = /\bplacement:\s*page\.slots\?\.\[0\]\?\.placement\s*\?\?\s*null/.test(body)
    || /\bplacement:/.test(body)
  const hasPaper = /\bpaper:\s*page\.paper\s*\|\|\s*null/.test(body)
  if (!hasPlacement) {
    fail = true
    console.error('[S4-GUARD] FAIL(1): toJob return 缺 placement 字段（Plan geometry 被丢弃）')
  } else {
    console.log('[S4-GUARD] ok(1): toJob 携带 placement（Plan truth handoff exists）')
  }
  if (!hasPaper) {
    fail = true
    console.error('[S4-GUARD] FAIL(2): toJob return 缺 paper 字段（Plan 纸几何被丢弃）')
  } else {
    console.log('[S4-GUARD] ok(2): toJob 携带 paper（Plan 纸几何 handoff exists）')
  }
  // 3: 禁重新计算（只搬运）
  if (/resolveContentPlacement|createPlacement|computePaperLayout/.test(body)) {
    fail = true
    console.error('[S4-GUARD] FAIL(3): toJob 内出现 geometry 计算调用（只搬运不计算）')
  } else {
    console.log('[S4-GUARD] ok(3): toJob 无 geometry 计算（纯搬运）')
  }
}

// ── 4: usePrint 消费 job.placement（f?.placement 优先） ──
function checkUsePrint() {
  const src = fs.readFileSync(USEPRINT, 'utf8')
  if (!/f\?\.placement\s*\?\?\s*placements\[f\.key\]/.test(src)) {
    fail = true
    console.error('[S4-GUARD] FAIL(4): printSingleSourceFile 未优先消费 job.placement（Plan truth）')
  } else {
    console.log('[S4-GUARD] ok(4): usePrint 优先消费 job.placement（fallback placements state）')
  }
}

// ── 5: PrintService 输出 executionPaper 独立字段 ──
function checkPrintService() {
  const src = fs.readFileSync(PRINTSVC, 'utf8')
  if (!/executionPaper:\s*executionPaper\s*\|\|\s*null/.test(src)) {
    fail = true
    console.error('[S4-GUARD] FAIL(5): buildPrintSettings 未输出 executionPaper 独立字段')
  } else {
    console.log('[S4-GUARD] ok(5): buildPrintSettings 输出 executionPaper（Plan truth 独立透传）')
  }
}

checkDerive()
checkUsePrint()
checkPrintService()

console.log(fail
  ? '[S4-GUARD] FAIL：Plan geometry handoff 被破坏，见上'
  : '[S4-GUARD] PASS：Plan → source job → IPC 的 geometry handoff 保持')
process.exit(fail ? 1 : 0)
