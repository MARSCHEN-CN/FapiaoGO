/**
 * mergeGenerationGuard.test.mjs — F4/F5 真实回归
 *
 * 两层防护：
 *   (A) 单元层：直接 import 真实 createGenerationGuard，验证 ownership 原语
 *       —— begin() 唯一递增、isCurrent() 仅放行最新 generation、被覆盖的旧 generation 被拒。
 *   (B) 集成层：用真实 guard 复刻 usePrint.prepareMergeArtifacts 的 commit 契约
 *       （empty / normal / error 三个 commit 点 + setMergeGenerating 同 fence），
 *       覆盖 F4/F5 全部验收场景；并静态校验 usePrint.js 确实把 commit 委托给该 guard
 *       （含「无旧 mergeGenerationRef 残留」），防止有人把 hook 改回内联 ref 或绕过 fence。
 *
 * 运行：node frontend/src/print/__tests__/mergeGenerationGuard.test.mjs
 */
import assert from 'node:assert/strict'
import { createGenerationGuard } from '../mergeGenerationGuard.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
const fail = (m) => { failed++; console.error('  ✗ ' + m) }
const ok = (m) => console.log('  ✓ ' + m)

// ───────────────────────── (A) 单元层：guard 原语 ─────────────────────────
console.log('\n[A] GenerationGuard 原语 — 真实模块')
{
  const g = createGenerationGuard()
  const g1 = g.begin()
  const g2 = g.begin()
  if (g1 !== 1 || g2 !== 2) fail(`begin() 未唯一递增：got ${g1},${g2}`); else ok('begin() 每次返回唯一递增 id')
  if (!g.isCurrent(g2)) fail('isCurrent(最新) 应为 true'); else ok('isCurrent(最新 generation) = true')
  if (g.isCurrent(g1)) fail('isCurrent(被覆盖的旧 generation) 不应为 true'); else ok('isCurrent(旧 generation) = false（被拒）')
  if (g.current !== 2) fail(`guard.current 应=2，got ${g.current}`); else ok('guard.current 只读最新值')
  // 旧 generation 之后再来一个，确认链式递增
  const g3 = g.begin()
  if (g3 !== 3 || !g.isCurrent(g3) || g.isCurrent(g2)) fail('链式 begin/isCurrent 异常'); else ok('链式 begin/isCurrent 正确')
}

// ───────────────── 集成层 harness（用真实 guard 复刻 commit 契约）─────────────────
function makeHarness(initialArt = null) {
  const guard = createGenerationGuard()
  let art = initialArt
  let generating = false
  const setArt = (v) => { art = v }
  const setGen = (v) => { generating = v }
  async function prepare(tag, workMs, opts = {}) {
    if (opts.notMerge) return // 模拟 !isMergeMode 提前 return（不取号、不动 flag）
    const myGen = guard.begin()
    setGen(true) // ✅ F5：取号后即标记在飞
    if (opts.empty) {
      if (guard.isCurrent(myGen)) { setArt([]); setGen(false) }
      return
    }
    if (opts.throw) {
      await delay(workMs)
      if (guard.isCurrent(myGen)) { setArt(null); setGen(false) }
      return
    }
    const result = await (async () => { await delay(workMs); return 'A_' + tag })()
    if (!guard.isCurrent(myGen)) return // 被拒：不动任何 state
    setArt(result)
    setGen(false) // ✅ F5：仅 latest 可清 loading
  }
  return {
    prepare,
    get art() { return art },
    get gen() { return generating },
  }
}

console.log('\n[B] 集成层 — 复刻 prepareMergeArtifacts commit 契约（真实 guard 驱动）')
{
  const h = makeHarness()
  await Promise.all([h.prepare('A', 40), h.prepare('B', 5)])
  if (h.art === 'A_B' && h.gen === false) ok('S1 G2(更新,先完成) commit；迟到 G1 被拒(不覆盖/不清 loading)')
  else fail(`S1 失败 art=${h.art} gen=${h.gen}`)
}
{
  const h = makeHarness()
  await Promise.all([h.prepare('A', 5), h.prepare('B', 40)])
  if (h.art === 'A_B' && h.gen === false) ok('S2 旧 G1 先完成仍被拒；G2 后完成 commit')
  else fail(`S2 失败 art=${h.art} gen=${h.gen}`)
}
{
  const h = makeHarness('OLD_A')
  const p = h.prepare('B', 30)
  if (h.gen === true && h.art === 'OLD_A') ok('S3 重新生成期间: flag=true 且旧 A 保留为视觉背景(未清空)')
  else fail(`S3 飞行态失败 art=${h.art} gen=${h.gen}`)
  await p
  if (h.art === 'A_B' && h.gen === false) ok('S3b G2 完成: 切 B, loading 消失')
  else fail(`S3b 失败 art=${h.art} gen=${h.gen}`)
}
{
  const h = makeHarness()
  await Promise.all([h.prepare('A', 20), h.prepare('B', 15), h.prepare('C', 5)])
  if (h.art === 'A_C' && h.gen === false) ok('S4 连续改 3 次: 仅最新 generation(=C) 结束 loading')
  else fail(`S4 失败 art=${h.art} gen=${h.gen}`)
}
{
  const h = makeHarness()
  h.prepare('X', 5, { notMerge: true })
  if (h.art === null && h.gen === false) ok('S5 Normal 模式: 提前 return, generating/artifact 完全不受影响')
  else fail(`S5 失败 art=${h.art} gen=${h.gen}`)
}
{
  const h = makeHarness()
  await Promise.all([h.prepare('A', 30, { throw: true }), h.prepare('B', 5)])
  if (h.art === 'A_B' && h.gen === false) ok('S6 旧 generation 异常不得清掉新结果/loading(null 不覆盖)')
  else fail(`S6 失败 art=${h.art} gen=${h.gen}`)
}
{
  const h = makeHarness()
  const p = h.prepare('B', 50)
  if (h.gen === true) ok('S7 首次打开 G1 在飞: flag=true(loading 显示)')
  else fail('S7 飞行态未置 flag')
  await p
  if (h.art === 'A_B' && h.gen === false) ok('S7b 首次完成: 显示 B, loading 消失')
  else fail(`S7b 失败 art=${h.art} gen=${h.gen}`)
}

// ───────────────── (C) 静态校验：usePrint.js 确实委托给真实 guard ─────────────────
console.log('\n[C] 静态契约 — usePrint.js 把 commit 委托给 mergeGenerationGuard')
{
  const usePrintPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../hooks/usePrint.js')
  const src = readFileSync(usePrintPath, 'utf8')

  const hasImport = /import \{ createGenerationGuard \} from '\.\.\/print\/mergeGenerationGuard'/.test(src)
  if (!hasImport) fail('usePrint.js 未 import createGenerationGuard'); else ok('usePrint.js import createGenerationGuard')

  const hasBegin = /mergeGenerationGuardRef\.current\.begin\(\)/.test(src)
  if (!hasBegin) fail('usePrint.js 未在取号处调用 guard.begin()'); else ok('usePrint.js 取号调用 guard.begin()')

  const isCurrentCount = (src.match(/mergeGenerationGuardRef\.current\.isCurrent\(myGeneration\)/g) || []).length
  // 三个 commit 点（empty/normal/error）共用 isCurrent；normal 用 !isCurrent 形式，故总出现 >=3 次
  if (isCurrentCount < 3) fail(`usePrint.js 中 isCurrent 出现 ${isCurrentCount} 次（期望 ≥3）`); else ok(`usePrint.js 三处 commit 均经 guard.isCurrent（出现 ${isCurrentCount} 次）`)

  const hasNegGuard = /if \(!mergeGenerationGuardRef\.current\.isCurrent\(myGeneration\)\) return/.test(src)
  if (!hasNegGuard) fail('usePrint.js 正常 commit 前未用 !isCurrent 守卫'); else ok('usePrint.js 正常 commit 前用 !isCurrent 守卫')

  const residualOld = /mergeGenerationRef\b/.test(src)
  if (residualOld) fail('usePrint.js 仍残留旧 mergeGenerationRef（应全部迁到 guard）'); else ok('usePrint.js 无旧 mergeGenerationRef 残留')
}

console.log('')
if (failed > 0) {
  console.error(`\n❌ mergeGenerationGuard 测试失败：${failed} 项。`)
  process.exit(1)
} else {
  console.log('✅ mergeGenerationGuard 测试通过：F4 generation ownership / F5 generation-aware loading 已锁定（真实模块 + usePrint 委托校验）。')
  process.exit(0)
}
