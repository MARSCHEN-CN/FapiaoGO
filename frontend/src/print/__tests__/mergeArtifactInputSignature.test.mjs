/**
 * mergeArtifactInputSignature.test.mjs — F1/F2 真实回归
 *
 * 目标：锁定 getMergeArtifactInputSignature 的「输入矩阵覆盖」契约：
 *   - 仅覆盖影响 Final Artifact 的输入（paperSize/customPaper/mergeMode/marginL/R/T/B/fileRotations）
 *   - 不覆盖非 Artifact 输入（landscape/grayscale/copies/printer/collate/extraSpecial/doubleSided）
 *   - 确定性（同输入 → 同字符串）
 *   - 任意受覆盖输入变化 → signature 变化
 *   - 稳定格式（5 段标识 paper=/custom=/mode=/margin=/rot=）
 *
 * 这是 F2「每个 artifact 绑定 inputSignature、且复用同一 Helper，禁止另造一套字符串」的回归护盾：
 * 未来若有人把 landscape/grayscale 等塞进 signature，或漏掉某受覆盖输入，本测试立即红灯。
 *
 * 运行：node frontend/src/print/__tests__/mergeArtifactInputSignature.test.mjs
 */
import assert from 'node:assert/strict'
import { getMergeArtifactInputSignature } from '../mergeArtifactSignature.js'

const baseSettings = {
  paperSize: 'A4',
  mergeMode: 'merge2',
  marginLeft: 3, marginRight: 3, marginTop: 3, marginBottom: 3,
}
const baseFiles = [{ key: 'f1' }, { key: 'f2' }]
const baseRotations = { f1: 0, f2: 0 }

let failed = 0
const fail = (m) => { failed++; console.error('  ✗ ' + m) }
const ok = (m) => console.log('  ✓ ' + m)

function sig(over = {}) {
  const { settings = {}, files = baseFiles, fileRotations = baseRotations } = over
  return getMergeArtifactInputSignature({ files, settings: { ...baseSettings, ...settings }, fileRotations })
}

console.log('\n[F1] 输入矩阵覆盖 — 受覆盖输入变化必须改变 signature')
{
  const a = sig()
  const bPaper = sig({ settings: { paperSize: 'A5' } })
  const bCustom = sig({ settings: { customPaper: { widthMM: 100, heightMM: 200 } } })
  const bMode = sig({ settings: { mergeMode: 'merge4' } })
  const bML = sig({ settings: { marginLeft: 5 } })
  const bMR = sig({ settings: { marginRight: 5 } })
  const bMT = sig({ settings: { marginTop: 5 } })
  const bMB = sig({ settings: { marginBottom: 5 } })
  const bRot = sig({ fileRotations: { f1: 90, f2: 0 } })

  if (bPaper === a) fail('paperSize 变化未改变 signature'); else ok('paperSize 变化 → signature 变化')
  if (bCustom === a) fail('customPaper 变化未改变 signature'); else ok('customPaper 变化 → signature 变化')
  if (bMode === a) fail('mergeMode 变化未改变 signature'); else ok('mergeMode 变化 → signature 变化')
  if (bML === a) fail('marginLeft 变化未改变 signature'); else ok('marginLeft 变化 → signature 变化')
  if (bMR === a) fail('marginRight 变化未改变 signature'); else ok('marginRight 变化 → signature 变化')
  if (bMT === a) fail('marginTop 变化未改变 signature'); else ok('marginTop 变化 → signature 变化')
  if (bMB === a) fail('marginBottom 变化未改变 signature'); else ok('marginBottom 变化 → signature 变化')
  if (bRot === a) fail('fileRotations 变化未改变 signature'); else ok('fileRotations 变化 → signature 变化')
}

console.log('\n[F1-exclude] 非 Artifact 输入必须不影响 signature')
{
  const a = sig()
  const nonArtifact = ['landscape', 'grayscale', 'copies', 'printer', 'collate', 'extraSpecial', 'doubleSided']
  let allSame = true
  for (const k of nonArtifact) {
    const val = k === 'copies' ? 2 : (k === 'landscape' ? true : 'X')
    const b = sig({ settings: { [k]: val } })
    if (b !== a) { allSame = false; fail(`${k} 不应影响 signature 却改变了它`) }
  }
  if (allSame) ok('landscape/grayscale/copies/printer/collate/extraSpecial/doubleSided 均不影响 signature')
}

console.log('\n[F2] 确定性 — 同输入 → 同字符串')
{
  const a = sig()
  const b = sig()
  if (a !== b) fail('同输入两次调用结果不一致'); else ok('同输入两次调用结果一致')
  const rotated = sig({ fileRotations: { f1: 90, f2: 180 } })
  const rotated2 = sig({ fileRotations: { f1: 90, f2: 180 } })
  if (rotated !== rotated2) fail('同样的 rotation 两次调用不一致'); else ok('同样 rotation 两次调用一致')
}

console.log('\n[F2] 默认回退 — 缺失字段不抛错且回退稳定')
{
  const empty = getMergeArtifactInputSignature()
  if (typeof empty !== 'string' || empty.length === 0) fail('空输入未返回稳定字符串'); else ok('空输入返回稳定字符串: ' + empty)
  const partial = getMergeArtifactInputSignature({ files: [{ key: 'x' }] })
  if (typeof partial !== 'string') fail('仅 files 输入未返回字符串'); else ok('仅 files 输入返回字符串: ' + partial)
}

console.log('\n[F1-format] signature 必须含并能定位 5 段标识')
{
  const s = sig()
  for (const tag of ['paper=', 'custom=', 'mode=', 'margin=', 'rot=']) {
    if (!s.includes(tag)) fail(`signature 缺少段标识 ${tag}`); else ok(`signature 含 ${tag}`)
  }
}

console.log('')
if (failed > 0) {
  console.error(`\n❌ mergeArtifactInputSignature 测试失败：${failed} 项。`)
  process.exit(1)
} else {
  console.log('✅ mergeArtifactInputSignature 测试通过：F1 输入矩阵覆盖 / F2 确定性 已锁定。')
  process.exit(0)
}
