#!/usr/bin/env node
/**
 * 对已生成的 16 个 cmd-matrix artifact 做 L2 客观属性判定（probe-only，不重打）。
 * 判据（方向无关，不猜内容方向）：
 *   a) 纸视觉方向 == paperOrientation
 *   b) 内容存在（bbox 宽高 > 0）
 *   c) 完整性防线：内容 bbox 面积 / 纸面积 ≥ 15%
 *      （检测严重缩放/裁切异常——历史异常样本 postscript 36×59 = 11% 级别；
 *        发票线框墨水面积天然小，不能用 mask.sum() 当完整性指标）
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const PY = path.join(REPO, 'backend', 'venv', 'Scripts', 'python.exe')
const OUT = path.join(HERE, 'cmd-matrix')

// 纸尺寸（paper=a4）：portrait 210×297 / landscape 297×210
const PAPER = { portrait: { w: 210, h: 297 }, landscape: { w: 297, h: 210 } }
const FLOOR_RATIO = 0.15  // bbox面积 / 纸面积 防线

function probe(pdf) {
  const code = `
import fitz, numpy as np, json
d = fitz.open(r'${pdf.replace(/\\/g, '/')}')
p = d[0]
pix = p.get_pixmap(dpi=300)
a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
mask = a[:,:,:3].mean(axis=2) < 250
mm = 25.4/300
ys, xs = np.where(mask)
print(json.dumps({
  'rotate': p.rotation,
  'wMm': round(pix.width*mm,1), 'hMm': round(pix.height*mm,1),
  'visualOrient': 'landscape' if pix.width > pix.height else 'portrait',
  'bboxWmM': round((xs.max()-xs.min())*mm,1) if mask.sum() else 0,
  'bboxHmM': round((ys.max()-ys.min())*mm,1) if mask.sum() else 0,
  'areaMm2': round(mask.sum()*mm*mm,1),
}))
d.close()
`
  return JSON.parse(execFileSync(PY, ['-c', code], { timeout: 60000 }).toString().trim())
}

function expectedArea(paperKey) {
  return PAPER[paperKey].w * PAPER[paperKey].h
}

let allPass = true
let pass = 0, fail = 0
console.log('=== L2 客观属性判定（probe-only，16 artifact）===')
for (const contentKey of ['landscape', 'portrait']) {
  for (const rot of [0, 90, 180, 270]) {
    for (const paperKey of ['portrait', 'landscape']) {
      const tag = `${contentKey}-rot${rot}-${paperKey}`
      const f = path.join(OUT, `art_${tag}.pdf`)
      if (!fs.existsSync(f)) { console.log(`❌ ${tag}: artifact 缺失`); allPass = false; fail++; continue }
      const m = probe(f)
      const paperOk = m.visualOrient === paperKey
      const bboxArea = m.bboxWmM * m.bboxHmM
      const exists = m.bboxWmM > 0 && m.bboxHmM > 0
      const floor = expectedArea(paperKey) * FLOOR_RATIO
      const complete = bboxArea >= floor
      const ok = paperOk && exists && complete
      if (ok) pass++; else { fail++; allPass = false }
      console.log(`${ok ? '✅' : '❌'} ${tag}: 纸${m.visualOrient}(${m.wMm}×${m.hMm}) 内容bbox ${m.bboxWmM}×${m.bboxHmM}(面积${bboxArea.toFixed(0)}mm²=纸${(bboxArea / (PAPER[paperKey].w * PAPER[paperKey].h) * 100).toFixed(0)}% ≥${(FLOOR_RATIO * 100).toFixed(0)}%) ${ok ? '' : 'FAIL'}  /Rotate=${m.rotate}`)
    }
  }
}
console.log(`\nL2: ${pass}/${pass + fail} PASS${allPass ? ' ✅' : ' ❌'}`)
process.exit(allPass ? 0 : 1)
