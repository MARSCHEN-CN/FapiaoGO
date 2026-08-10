#!/usr/bin/env node
/**
 * Shell Geometry Guard — Phase 1-B Step 3-B（DEV-only 源码守卫）
 *
 * 目标：禁止 scripts/add-pdf-margins.py（compatibility shell）【重新】出现 geometry 算法。
 *
 * 背景：Phase 1-B 后 add-pdf-margins.py 已降级为兼容壳，全部几何转交
 * scripts/margin_contract.py（契约 §7.1：唯一 executor）。任何在 shell 内重现的
 * min/scale/translate/mediabox 赋值，都意味着 geometry 重新分叉（PDF 轨 vs Image 轨
 * 双语义的历史 bug 复燃），必须 0 matches。
 *
 * 检查范围【仅限 shell 单文件】——margin_contract.py 是唯一 contract 模块，
 * 不受本 guard 约束（其 scale=min 等是契约落点，见契约 §7.3 SG-2/SG-3）。
 *
 * 禁止关键词（用户裁决）：
 *   min(          —— 任何 min 调用（contain-fit 的 sx/sy 取小）
 *   scale =       —— 任何 scale 赋值
 *   translate =   —— 任何平移赋值
 *   mediabox =    —— 任何页面框赋值（INV-1 的 MediaBox 由 executor 唯一决定）
 *
 * 用法: node shellGeometryGuard.mjs     （0 = PASS，1 = FAIL）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const SHELL = path.join(REPO, 'scripts', 'add-pdf-margins.py')

const FORBIDDEN = [
  { name: 'min(',          re: /min\s*\(/ },
  { name: 'scale =',       re: /scale\s*=/ },
  { name: 'translate =',   re: /translate\s*=/ },
  { name: 'mediabox =',    re: /mediabox\s*=/i },
]

function main() {
  if (!fs.existsSync(SHELL)) {
    console.error(`[SHELL-GUARD] FAIL: shell 不存在 ${SHELL}`)
    process.exit(1)
  }
  const src = fs.readFileSync(SHELL, 'utf8')
  const lines = src.split(/\r?\n/)

  let fail = false
  for (const { name, re } of FORBIDDEN) {
    const hits = []
    lines.forEach((line, i) => { if (re.test(line)) hits.push(i + 1) })
    if (hits.length > 0) {
      fail = true
      console.error(`[SHELL-GUARD] FAIL: 关键词 "${name}" 命中 ${hits.length} 处（行 ${hits.join(', ')}）`)
      console.error('            shell 不得重新出现 geometry 算法；几何唯一来源 = margin_contract.py')
    } else {
      console.log(`[SHELL-GUARD] ok: "${name}" 0 matches`)
    }
  }

  console.log(fail
    ? '[SHELL-GUARD] FAIL：geometry 分叉风险，见上'
    : '[SHELL-GUARD] PASS：add-pdf-margins.py 保持 compatibility shell（零 geometry）')
  process.exit(fail ? 1 : 0)
}

main()
