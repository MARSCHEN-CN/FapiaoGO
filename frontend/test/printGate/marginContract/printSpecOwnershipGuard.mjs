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

// 禁止模式：consumer 直接读取 legacy 字段（settings.paperSize / .landscape / .fit / .rotate）
const FORBIDDEN = [
  { name: 'settings.paperSize', re: /\.paperSize\b/ },
  { name: 'settings.landscape', re: /\.landscape\b/ },
  { name: 'settings.fit',       re: /\.fit\b/ },
  { name: 'settings.rotate',    re: /\.rotate\b/ },
]

// 强制检查（已收敛链）
const ENFORCED = [
  path.join(REPO, 'electron', 'print-service', 'print-backend.js'),
]

// 白名单（遗留推断点，到期 commit 移除后从列表删除）
const WHITELIST = [
  {
    file: path.join(REPO, 'electron', 'main.js'),
    reason: 'L551 settings.fit=\'none\'（条件式 fit）→ C-1-c 移除',
    expire: 'C-1-c',
  },
  {
    file: path.join(REPO, 'electron', 'print-service', 'DirectPrintHandler.js'),
    reason: 'L125 settings.landscape / L156 settings.paperSize||\'A4\' → C-1-b 移除',
    expire: 'C-1-b',
  },
]

function scan(file) {
  const src = fs.readFileSync(file, 'utf8')
  const lines = src.split(/\r?\n/)
  const hits = []
  for (const { name, re } of FORBIDDEN) {
    lines.forEach((line, i) => {
      if (re.test(line)) hits.push({ line: i + 1, name, text: line.trim().slice(0, 90) })
    })
  }
  return hits
}

function main() {
  let fail = false
  let pending = 0

  for (const file of ENFORCED) {
    const hits = scan(file)
    if (hits.length > 0) {
      fail = true
      console.error(`[SPEC-GUARD] FAIL: ${path.relative(REPO, file)} 直接读取 legacy 字段：`)
      for (const h of hits) {
        console.error(`    L${h.line} [${h.name}] ${h.text}`)
      }
    } else {
      console.log(`[SPEC-GUARD] ok: ${path.relative(REPO, file)} 0 hits（仅消费 PrintSpec）`)
    }
  }

  for (const w of WHITELIST) {
    const rel = path.relative(REPO, w.file)
    const hits = scan(w.file)
    if (hits.length > 0) {
      pending++
      console.log(`[SPEC-GUARD] ⏳ 白名单（${w.expire} 到期）: ${rel} 命中 ${hits.length} 处 — ${w.reason}`)
    } else {
      console.log(`[SPEC-GUARD] ok: ${rel} 0 hits（白名单可移除）`)
    }
  }

  console.log(fail
    ? '[SPEC-GUARD] FAIL：consumer 直接读 legacy 字段，见上'
    : '[SPEC-GUARD] PASS（白名单待清理项计入 PENDING）')
  process.exit(fail ? 1 : 0)
}

main()
