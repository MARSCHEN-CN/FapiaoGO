#!/usr/bin/env node
/**
 * PrintSpec Ownership Guard — Phase 1-C-1（G-C1-1）
 *
 * 目标：consumer 不得直接读取 legacy settings 字段（paperSize / landscape / fit / rotate），
 * 只允许从 PrintSpec（normalize 输出）消费。normalize（print-settings.js）是唯一解释层。
 *
 * 检查文件：
 *   ✅ 强制：electron/print-service/print-backend.js（buildPrintSettings 链，C-1-a 已收敛）
 *   ⏳ 白名单（到期移除）：electron/main.js（L551 settings.fit='none' → C-1-c 移除）
 *                        electron/print-service/DirectPrintHandler.js（L125/L156 → C-1-b 移除）
 *
 * 豁免：print-settings.js（normalize 所在，唯一允许读 legacy 字段）。
 *
 * 用法: node printSpecOwnershipGuard.mjs     （0 = PASS，1 = FAIL）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')

// 禁止模式：consumer 从 legacy settings 对象读取字段（settings.paperSize 等）。
// 精确到 settings/normalizedSettings 前缀——printJob 等 PrintSpec 流出对象的同名
// 字段（如 printJob.paperSize）不误报（G-C1-1 只约束「读 settings」的路径）。
const FORBIDDEN = [
  { name: 'settings.paperSize', re: /(?:settings|normalizedSettings)(?:\?\.|\.)paperSize\b/ },
  { name: 'settings.landscape', re: /(?:settings|normalizedSettings)(?:\?\.|\.)landscape\b/ },
  { name: 'settings.fit',       re: /(?:settings|normalizedSettings)(?:\?\.|\.)fit\b/ },
  { name: 'settings.rotate',    re: /(?:settings|normalizedSettings)(?:\?\.|\.)rotate\b/ },
]

// G-C1-C-2（C-1-c）：consumer 不得出现 scale 决策字面量（'noscale'/'fit'）。
// 决策只允许在 normalize 与 PrintSpec schema（print-settings.js，豁免）。
// 赋值 spec.scalePolicy 不含字面量，不会被误报。
const FORBIDDEN_SCALE = [
  { name: 'scale 决策字面量', re: /['"](?:noscale|fit)['"]/ },
]

// 强制检查（已收敛链）
const ENFORCED = [
  path.join(REPO, 'electron', 'print-service', 'print-backend.js'),
  path.join(REPO, 'electron', 'print-service', 'DirectPrintHandler.js'),
  path.join(REPO, 'electron', 'main.js'),
  // G-C2-1（C-2 Step 1）：ExecutionPlan builder 不得直接读 legacy 纸张/方向字段——
  // 统一走 paperSpec.resolvePaperSpec 解析点（frontend/src/print/paperSpec.js，豁免）。
  path.join(REPO, 'frontend', 'src', 'print', 'buildPrintExecutionPlan.js'),
]

// 白名单（遗留推断点，到期 commit 移除后从列表删除）
// C-1-c 后全部收敛：main.js / DirectPrintHandler 均已 0 hits，白名单为空。
// 注：OsLauncherBridge.decidePrintSpec（direct 轨 spec 构造点，等价 normalize 角色）
// 未列入——其 scale 字段收敛属 C-2。
const WHITELIST = []

function scan(file, patterns) {
  const src = fs.readFileSync(file, 'utf8')
  const lines = src.split(/\r?\n/)
  const hits = []
  for (const { name, re } of patterns) {
    lines.forEach((line, i) => {
      if (re.test(line)) hits.push({ line: i + 1, name, text: line.trim().slice(0, 90) })
    })
  }
  return hits
}

function main() {
  let fail = false

  for (const file of ENFORCED) {
    const hits = scan(file, FORBIDDEN)
    if (hits.length > 0) {
      fail = true
      console.error(`[SPEC-GUARD] FAIL: ${path.relative(REPO, file)} 直接读取 legacy 字段：`)
      for (const h of hits) {
        console.error(`    L${h.line} [${h.name}] ${h.text}`)
      }
    } else {
      console.log(`[SPEC-GUARD] ok: ${path.relative(REPO, file)} 0 hits（仅消费 PrintSpec）`)
    }
    // G-C1-C-2：scale 决策字面量检查（print-settings.js 豁免——normalize/schema 唯一决策处）
    const scaleHits = scan(file, FORBIDDEN_SCALE)
    if (scaleHits.length > 0) {
      fail = true
      console.error(`[SPEC-GUARD] FAIL(G-C1-C-2): ${path.relative(REPO, file)} 出现 scale 决策字面量：`)
      for (const h of scaleHits) {
        console.error(`    L${h.line} [${h.name}] ${h.text}`)
      }
    } else {
      console.log(`[SPEC-GUARD] ok(G-C1-C-2): ${path.relative(REPO, file)} 无 scale 决策字面量`)
    }
  }

  console.log(fail
    ? '[SPEC-GUARD] FAIL：consumer 直接读 legacy 字段或 scale 决策，见上'
    : '[SPEC-GUARD] PASS：consumer 仅消费 PrintSpec，scalePolicy 单一读取点')
  process.exit(fail ? 1 : 0)
}

main()
