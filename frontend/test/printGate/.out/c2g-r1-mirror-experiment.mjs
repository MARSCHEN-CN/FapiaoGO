/**
 * G2-R1 镜像回归实验（零代码，只读生产函数）
 *
 * 目的：验证 C-2-G G2-1（commit c39ae14，仅 frontend/src/services/PrintService.js
 * buildPrintSettings 补传 paperOrientation）在「竖纸型 + 横向」镜像场景下的完整链路
 * 是否与「横纸型 + 纵向」(G2 主修复场景) 同样保持 Single Paper Truth。
 *
 * 不修改任何生产代码。直接 import 真实：
 *   - frontend/src/print/paperSpec.js  → resolvePaperSpec / requestedPaperOrientation
 *   - electron/print-service/print-settings.js → normalize (C-1 唯一解释层)
 *
 * 复现的 IPC 载荷与 buildPrintSettings(G2-1) 完全一致：
 *   { paper, landscape, paperOrientation: requestedPaperOrientation({landscape}) }
 *
 * 关键 invariant（用户裁决）：
 *   Plan.paper == normalize.paper  (宽高一致，误差 0)
 * 以及 G2-1 影响面：
 *   portrait-native + landscape 下，normalize 在「有/无 paperOrientation」应恒等
 *   (因为 landscape=true 早已让 normalize 走 'landscape' 分支) —— 证明 c39ae14 对该组合惰性。
 */
import { resolvePaperSpec, requestedPaperOrientation } from '../../../src/print/paperSpec.js'
import ps from '../../../../electron/print-service/print-settings.js'

const normalize = ps.normalize

const CASES = [
  { tag: 'PORTRAIT+NATIVE-PORTRAIT', paperSize: 'A4',        landscape: false },
  { tag: 'PORTRAIT+NATIVE-LANDSCAPE', paperSize: 'A4',        landscape: true  },
  { tag: 'LANDSCAPE+NATIVE-PORTRAIT', paperSize: 'PostScript', landscape: false },
  { tag: 'LANDSCAPE+NATIVE-LANDSCAPE', paperSize: 'PostScript', landscape: true  },
]

const STR = (o) => `${o.widthMM}×${o.heightMM} ${o.orientation}`

let allPass = true

console.log('══════════════════════════════════════════════════════════════')
console.log('G2-R1 MIRROR EXPERIMENT — Plan vs normalize vs G2-1 delta')
console.log('══════════════════════════════════════════════════════════════\n')

for (const c of CASES) {
  const userSettings = { paperSize: c.paperSize, landscape: c.landscape }
  // Plan：frontend 单一解析点（buildPrintExecutionPlan / Preview 共用）
  const plan = resolvePaperSpec(userSettings)
  // IPC 载荷：与 buildPrintSettings(G2-1) 同源（requestedPaperOrientation 是单一来源）
  const ipc = {
    paper: c.paperSize,
    landscape: c.landscape,
    paperOrientation: requestedPaperOrientation(userSettings),
  }
  const norm = normalize(ipc)
  // 无 paperOrientation（G2-1 之前）：验证 c39ae14 影响面
  const normLegacy = normalize({ paper: c.paperSize, landscape: c.landscape })

  const planW = plan.widthMM, planH = plan.heightMM
  const normW = norm.paper.widthMM, normH = norm.paper.heightMM
  const legacyW = normLegacy.paper.widthMM, legacyH = normLegacy.paper.heightMM

  const singleTruth = (planW === normW && planH === normH)
  const g21Inert = (normW === legacyW && normH === legacyH)

  console.log(`[${c.tag}]`)
  console.log(`  Plan(paperSpec)        : ${STR(plan)}`)
  console.log(`  IPC.paperOrientation   : ${ipc.paperOrientation}   landscape=${ipc.landscape}`)
  console.log(`  normalize(G2-1)        : ${normW}×${normH} ${norm.paper.orientation}`)
  console.log(`  normalize(legacy)      : ${legacyW}×${legacyH} ${normLegacy.paper.orientation}`)
  console.log(`  SinglePaperTruth(Plan==norm): ${singleTruth ? 'PASS ✅' : 'FAIL ❌'}`)
  console.log(`  G2-1 inert(legacy==norm)    : ${g21Inert ? 'YES (c39ae14 惰性) ✅' : 'NO (c39ae14 改变行为) ⚠️'}`)
  console.log('')

  if (!singleTruth) allPass = false
}

console.log('══════════════════════════════════════════════════════════════')
console.log(allPass ? 'RESULT: 全部象限 Plan==normalize Single Paper Truth PASS ✅'
                    : 'RESULT: 存在象限 Plan≠normalize ❌')
console.log('══════════════════════════════════════════════════════════════')

// 额外断言：LANDSCAPE+NATIVE-PORTRAIT 必须被 G2-1 修复（legacy 错，G2-1 对）
const landPort = CASES.find((c) => c.tag === 'LANDSCAPE+NATIVE-PORTRAIT')
const lpNorm = normalize({ paper: landPort.paperSize, landscape: landPort.landscape, paperOrientation: requestedPaperOrientation({ landscape: landPort.landscape }) })
const lpLegacy = normalize({ paper: landPort.paperSize, landscape: landPort.landscape })
console.log(`\nG2 主修复场景 LANDSCAPE+NATIVE-PORTRAIT:`)
console.log(`  legacy(240×140)  ❌ 应为 140×240`)
console.log(`  G2-1  (${lpNorm.paper.widthMM}×${lpNorm.paper.heightMM}) ${lpNorm.paper.widthMM === 140 && lpNorm.paper.heightMM === 240 ? '✅' : '❌'}`)
console.log(`  legacy 错 / G2-1 对 验证: ${lpLegacy.paper.widthMM === 240 && lpNorm.paper.widthMM === 140 ? 'PASS ✅' : 'FAIL ❌'}`)
