#!/usr/bin/env node
/**
 * 生产横向 bake 打印 命令级对照（2026-08-11 17:50）
 *
 * 目的：用户实测生产日志 `landscape,noscale,paper=postscript,monochrome`
 * 横向纸张失败。不讨论 Form 理论（C-2-E 已关），只做命令级对照：
 *   同一 bake 等价物（240×140 横，内容居中）→ 4 条命令变体 → Wondershare
 *   → probe 纸/内容，逐字符比较命令差异的 artifact 影响。
 *
 * 对照矩阵：
 *   C1 生产 1:1：landscape,noscale,paper=postscript,monochrome
 *   C2 去灰度：landscape,noscale,paper=postscript
 *   C3 驱动纸名：landscape,noscale,paper=凭证纸
 *   C4 无 paper：landscape,noscale（驱动默认=凭证纸 240×140）
 *
 * 唯一文件名 + mtime 排序 + 抓后改名（防串台）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const PY = path.join(REPO, 'backend', 'venv', 'Scripts', 'python.exe')
const SUMATRA = path.join(REPO, 'resources', 'sumatra', 'SumatraPDF.exe')
const OUT = path.join(HERE, 'cmd-compare')
const W = 'C:/ProgramData/Wondershare/PDFelement10/PDFCreator'
const SRC = path.join(REPO, 'test_fixtures', '25952000000127675627.pdf')  // 横票 210×140

const cmds = [
  ['P1-prod-baseline',  'landscape,noscale,paper=postscript'],
  ['P2-16case-fit-r90', 'landscape,rotate=90,fit,paper=postscript'],
  ['P3-16case-fit-r270', 'landscape,rotate=270,fit,paper=postscript'],
  ['P4-16case-noscale-r90', 'landscape,rotate=90,noscale,paper=postscript'],
  ['P5-fit-r90-cn',     'landscape,rotate=90,fit,paper=凭证纸'],
]

// 真实生产 bake 产物（用户日志 17:41，temp 未清理）
const REAL_BAKE = 'C:/Users/it01/AppData/Local/Temp/placement_bake_1786441296107_uh3pxs.pdf'

function sleep(ms) { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ms) }
function sh(cmd, args, timeout = 120000) { return execFileSync(cmd, args, { timeout }).toString() }

// 1. 生成 bake 等价物：240×140mm 横纸，横票内容 fit 居中（等价生产 placement_bake 产物）
function makeBakeEquiv() {
  const code = `
import fitz
src = fitz.open(r'${SRC.replace(/\\/g, '/')}')
MM = 72 / 25.4
w, h = 240 * MM, 140 * MM
doc = fitz.open()
page = doc.new_page(width=w, height=h)
# 源页面 rect（横票 210×140mm）
sr = src[0].rect
sw, shh = sr.width / MM, sr.height / MM          # mm
# contain-fit 居中：scale = min(240/210, 140/140) = 1.0
scale = min(240 / sw, 140 / shh)
cw, chh = sw * scale, shh * scale                # mm
x0 = (240 - cw) / 2; y0 = (140 - chh) / 2
rect = fitz.Rect(x0 * MM, y0 * MM, (x0 + cw) * MM, (y0 + chh) * MM)
page.show_pdf_page(rect, src, 0)
doc.save(r'${OUT.replace(/\\/g, '/')}/bake_eq_240x140.pdf')
print('bake_eq: 240x140mm, content', round(cw,1), 'x', round(chh,1), 'mm at', round(x0,1), ',', round(y0,1))
doc.close(); src.close()
`
  console.log(sh(PY, ['-c', code]).trim())
}

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
  'rotate': p.rotation, 'wMm': round(pix.width*mm,1), 'hMm': round(pix.height*mm,1),
  'visualOrient': 'landscape' if pix.width > pix.height else 'portrait',
  'bboxWmM': round((xs.max()-xs.min())*mm,1) if mask.sum() else 0,
  'bboxHmM': round((ys.max()-ys.min())*mm,1) if mask.sum() else 0,
}))
d.close()
`
  return JSON.parse(sh(PY, ['-c', code]).trim())
}

function printAndGrab(baked, cmd, tag) {
  const artifact = path.join(OUT, `art_${tag}.pdf`)
  sh(SUMATRA, ['-print-to', 'Wondershare PDFelement', '-print-settings', cmd, '-silent', '-exit-when-done', baked])
  const stem = path.basename(baked).replace(/\.pdf$/i, '')
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    sleep(2000)
    try {
      const names = fs.readdirSync(W).filter(f => f === stem + '.pdf' || new RegExp(`^${stem}_\\d+\\.pdf$`).test(f))
      if (!names.length) continue
      const full = names.map(f => ({ f, m: fs.statSync(path.join(W, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0].f
      const fullPath = path.join(W, full)
      if (fs.statSync(fullPath).size > 0) {
        fs.copyFileSync(fullPath, artifact)
        try { fs.renameSync(fullPath, path.join(W, `grabbed_${tag}.pdf`)) } catch {}
        return artifact
      }
    } catch {}
  }
  throw new Error(`未抓到 artifact: ${stem}`)
}

fs.mkdirSync(OUT, { recursive: true })
console.log('=== 生产 bake P1-P5 决定性对照（同一真实 bake 产物）===')
console.log('bake: ' + REAL_BAKE)
if (!fs.existsSync(REAL_BAKE)) { console.error('❌ 真实 bake 产物不存在'); process.exit(1) }
for (const [tag, cmd] of cmds) {
  try {
    const art = printAndGrab(REAL_BAKE, cmd, tag)
    const m = probe(art)
    const bboxArea = m.bboxWmM * m.bboxHmM
    const paperArea = m.wMm * m.hMm
    const ratio = (bboxArea / paperArea * 100).toFixed(0)
    console.log(`${tag}: cmd="${cmd}" → 纸${m.visualOrient}(${m.wMm}×${m.hMm}) /Rotate=${m.rotate} 内容${m.bboxWmM}×${m.bboxHmM}(${ratio}%)`)
  } catch (e) {
    console.log(`${tag}: ${e.message}`)
  }
}
console.log('DONE')
