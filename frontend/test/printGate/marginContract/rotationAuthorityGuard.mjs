#!/usr/bin/env node
/**
 * RG-3 Rotation Authority Guard（2026-08-10）
 *
 * 检查 rotate/纸向决策链的语义分离（RG-3-A/B/C 冻结）：
 *
 * G-RG3-1 paper authority：
 *   resolveOrientationCommands 不得用 contentOrient 决定 paperCommand（纸向唯一来自
 *   paperOrientation——A3-03 SELF_ORIENT 修复）。即 print-settings.js 中该函数
 *   体内不得出现 `contentOrient` 参与方向旗标计算。
 *
 * G-RG3-2 rotation separation：
 *   方向决策输出必须是两通道结构 {paperOrientation, contentRotation}，不得是
 *   单字段 {rotate} 承载纸向+内容双重语义。即 resolveOrientationCommands 的
 *   return 必须含 paperOrientation 字段（检查函数体）。
 *
 * G-RG3-3 dual-track consistency：
 *   source 轨（print-backend.js）与 direct 轨（OsLauncherBridge.js）必须都经过
 *   print-settings.js 的 resolveOrientationCommands（同一语义函数），不得各自
 *   内联 ROTATE_LOOKUP/方向决策。即两文件不得出现内联 ROTATE_LOOKUP 表或
 *   独立的 rotate 决策字面量表。
 *
 * G-RG3-C（RG-3-C 验证 guard）：
 *   禁止新增 paper.orientation + content orientation + rotate 三者混合解释的
 *   查表（防止 ROTATE_LOOKUP 复活）。即 electron/ 下不得出现 `'landscape|'`
 *   这类二维查表 key 模式。
 *
 * 用法: node printGate/rotationAuthorityGuard.mjs   （0 = PASS，1 = FAIL）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')

const PRINT_SETTINGS = path.join(REPO, 'electron', 'print-service', 'print-settings.js')
const PRINT_BACKEND = path.join(REPO, 'electron', 'print-service', 'print-backend.js')
const OS_LAUNCHER = path.join(REPO, 'electron', 'print-service', 'OsLauncherBridge.js')

let fail = false

// ── G-RG3-1：resolveOrientationCommands 体内不得用 contentOrient 决定纸向 ──
function gRg31() {
  const src = fs.readFileSync(PRINT_SETTINGS, 'utf8')
  // 提取 resolveOrientationCommands 函数体
  const m = src.match(/function resolveOrientationCommands\([\s\S]*?\n\}/)
  if (!m) { console.error('[RG3-GUARD] FAIL: resolveOrientationCommands 未找到'); fail = true; return }
  const body = m[0]
  // 纸向计算（paperOrientation）行不得引用 contentOrient/contentOrientation
  const paperLines = body.split(/\r?\n/).filter(l => /paperOrientation\s*=/.test(l))
  for (const l of paperLines) {
    if (/contentOrient/i.test(l)) {
      fail = true
      console.error(`[RG3-GUARD] FAIL(G-RG3-1): 纸向计算引用内容方向 → ${l.trim()}`)
    }
  }
  // 参数列表不得含 contentOrient（三混输入禁止）
  if (/contentOrient/.test(body.match(/function resolveOrientationCommands\([^)]*\)/)[0])) {
    fail = true
    console.error('[RG3-GUARD] FAIL(G-RG3-1): resolveOrientationCommands 参数含 contentOrient（三混输入残留）')
  }
  console.log(fail ? '' : '[RG3-GUARD] ok(G-RG3-1): 纸向唯一来自 paperOrientation')
}

// ── G-RG3-2：输出两通道 {paperOrientation, contentRotation}，无单字段 rotate 决策 ──
function gRg32() {
  const src = fs.readFileSync(PRINT_SETTINGS, 'utf8')
  const m = src.match(/function resolveOrientationCommands\([\s\S]*?\n\}/)
  const body = m ? m[0] : ''
  const hasPaperOrient = /return\s*\{[\s\S]*?paperOrientation/.test(body)
  const hasContentRot = /return\s*\{[\s\S]*?contentRotation/.test(body)
  if (!hasPaperOrient || !hasContentRot) {
    fail = true
    console.error('[RG3-GUARD] FAIL(G-RG3-2): 输出须为 {paperOrientation, contentRotation} 两通道')
  } else {
    console.log('[RG3-GUARD] ok(G-RG3-2): 输出两通道分离')
  }
}

// ── G-RG3-3：双轨同源（两文件不得内联方向决策表） ──
function gRg33() {
  for (const [file, name] of [[PRINT_BACKEND, 'print-backend'], [OS_LAUNCHER, 'OsLauncherBridge']]) {
    const src = fs.readFileSync(file, 'utf8')
    // 禁止内联 ROTATE_LOOKUP 或 landscape|portrait 二维查表 key
    const inlineTable = /'landscape\|\w+'|ROTATE_LOOKUP\s*=\s*\{/.test(src)
    if (inlineTable) {
      fail = true
      console.error(`[RG3-GUARD] FAIL(G-RG3-3): ${name}.js 含内联方向查表（须走 print-settings.resolveOrientationCommands）`)
    } else {
      console.log(`[RG3-GUARD] ok(G-RG3-3): ${name}.js 无内联方向查表`)
    }
    // 必须引用 resolveOrientationCommands（同源）
    if (!/resolveOrientationCommands/.test(src)) {
      fail = true
      console.error(`[RG3-GUARD] FAIL(G-RG3-3): ${name}.js 未引用 resolveOrientationCommands（决策源分离）`)
    } else {
      console.log(`[RG3-GUARD] ok(G-RG3-3): ${name}.js 引用同一 resolveOrientationCommands`)
    }
  }
}

// ── G-RG3-C：禁止 ROTATE_LOOKUP 复活（三混查表） ──
function gRg3c() {
  const src = fs.readFileSync(PRINT_SETTINGS, 'utf8')
  if (/ROTATE_LOOKUP\s*=\s*\{/.test(src) || /'landscape\|\w+'\s*:/.test(src)) {
    fail = true
    console.error('[RG3-GUARD] FAIL(G-RG3-C): ROTATE_LOOKUP 三混查表复活')
  } else {
    console.log('[RG3-GUARD] ok(G-RG3-C): 无 ROTATE_LOOKUP 复活')
  }
}

gRg31()
gRg32()
gRg33()
gRg3c()

console.log(fail ? '[RG3-GUARD] FAIL：rotation authority 语义分离被破坏，见上' : '[RG3-GUARD] PASS：纸向/内容旋转两通道分离，双轨同源')
process.exit(fail ? 1 : 0)
