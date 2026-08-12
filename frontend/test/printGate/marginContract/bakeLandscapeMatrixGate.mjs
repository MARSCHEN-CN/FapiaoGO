#!/usr/bin/env node
/**
 * Bake Landscape Matrix Gate — C-2-G 横向纸张 bake 路径 8 组合真实打印验证（2026-08-12）
 *
 * 目的：按已冻结 16-case 表，验证【生产 bake 路径 + Command Matrix rotate 注入】
 * 在横向纸张（landscape）全部 8 组合真实打印正确：
 *   横票 0/90/180/270 × 横纸 + 竖票 0/90/180/270 × 横纸
 *
 * ⚠️ 2026-08-12 实测修正（重要）：bake 路径 rotate 是【恒 90】，不是 16 表查表值！
 *   - 8 组合实测：resolver 查表（rotate=270 的 4 组合）全部倒置 FAIL；
 *     rotate=90 的 4 组合全部正向 PASS → 完美二分
 *   - 机制：Sumatra landscape 隐含旋转 = **-90°**（非 +90°）；bake 内容已烤进
 *     最终方向（Plan truth），只需 rotate=90 恒定抵消隐含旋转，保持 bake 内容原方向。
 *   - 16 表 rotate=270 是【直打模型】的适配值（源 PDF 未旋转内容），不适用于 bake。
 *   - 本 Gate 用【恒 rotate=90】验证 8 组合（生产接线同源：main.js 恒 90 注入）。
 *
 * 每 case：
 *   1. fitz 构造 bake 产物（等价 placement bake：MediaBox=240×140 横纸 /Rotate=0，
 *      内容按 contentRotation 旋转烤进，contain-fit 居中）
 *   2. 命令 landscape,rotate=90,noscale,paper=postscript（bake 路径恒补偿）
 *   3. Sumatra → Wondershare → artifact
 *   4. 断言：
 *      a) 纸 240×140 横
 *      b) 内容完整性：bbox 面积/纸面积 ≥ 15%
 *      c) **内容方向**：IoU 模板匹配（artifact vs bake 内容，0°/180°），IoU(0°) > IoU(180°)
 *
 * 用法: node bakeLandscapeMatrixGate.mjs [--only landscape-0]
 * 退出码：0 = 8/8 PASS；1 = 有 FAIL。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const PY = path.join(REPO, 'backend', 'venv', 'Scripts', 'python.exe')
const SUMATRA = path.join(REPO, 'resources', 'sumatra', 'SumatraPDF.exe')
const OUT = path.join(HERE, '.out', 'bake-landscape')
const W = 'C:/ProgramData/Wondershare/PDFelement10/PDFCreator'

const require = createRequire(import.meta.url)
const { resolveSumatraRotation } = require(
  path.join(REPO, 'electron', 'print-service', 'sumatra-command-resolver.js'))

const argv = process.argv.slice(2)
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const only = get('--only', '')

const PAPER_MM = { w: 240, h: 140 }  // PostScript 凭证纸 240×140 横（与生产一致）
const CONTENTS = [
  { key: 'landscape', file: path.join(REPO, 'test_fixtures', '25952000000127675627.pdf'), w: 210, h: 140 },   // 横票
  { key: 'portrait', file: path.join(HERE, '.out', 'a3v2_portrait_content.pdf'), w: 210, h: 297 },  // 竖票
]
const ROTS = [0, 90, 180, 270]

function sleep(ms) { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ms) }
function sh(cmd, args, timeout = 120000) { return execFileSync(cmd, args, { timeout }).toString() }

// 构造 bake 产物：240×140 横纸，内容按 rot 旋转烤进，contain-fit 居中，/Rotate=0
function makeBake(content, rot, tag) {
  const outPdf = path.join(OUT, `bake_${tag}.pdf`)
  const code = `
import fitz, json
src = fitz.open(r'${content.file.replace(/\\/g, '/')}')
MM = 72 / 25.4
pw, ph = ${PAPER_MM.w} * MM, ${PAPER_MM.h} * MM
doc = fitz.open()
page = doc.new_page(width=pw, height=ph)
sr = src[0].rect
sw, sh = sr.width / MM, sr.height / MM
rot = ${rot}
# 旋转后的内容宽高（mod 180）
cw0, ch0 = (sw, sh) if rot % 180 == 0 else (sh, sw)
scale = min(${PAPER_MM.w} / cw0, ${PAPER_MM.h} / ch0)
cw, ch = cw0 * scale, ch0 * scale
x0, y0 = (${PAPER_MM.w} - cw) / 2, (${PAPER_MM.h} - ch) / 2
rect = fitz.Rect(x0 * MM, y0 * MM, (x0 + cw) * MM, (y0 + ch) * MM)
page.show_pdf_page(rect, src, 0, rotate=rot)
doc.save(r'${outPdf.replace(/\\/g, '/')}')
print(json.dumps({'paperW': ${PAPER_MM.w}, 'paperH': ${PAPER_MM.h}, 'cw': round(cw,1), 'ch': round(ch,1)}))
doc.close(); src.close()
`
  const meta = JSON.parse(sh(PY, ['-c', code]).trim())
  return { outPdf, ...meta }
}

// probe：纸 + 内容 bbox + 内容裁剪图（PNG 临时文件，避免 stdout 缓冲溢出）
function probe(pdf, cropFile) {
  const code = `
import fitz, numpy as np, json
from PIL import Image
d = fitz.open(r'${pdf.replace(/\\/g, '/')}')
p = d[0]
pix = p.get_pixmap(dpi=300)
a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
gray = a[:,:,:3].mean(axis=2)
mask = gray < 250
mm = 25.4/300
ys, xs = np.where(mask)
info = {
  'rotate': p.rotation,
  'wMm': round(pix.width*mm,1), 'hMm': round(pix.height*mm,1),
  'visualOrient': 'landscape' if pix.width > pix.height else 'portrait',
  'bboxWmM': round((xs.max()-xs.min())*mm,1) if mask.sum() else 0,
  'bboxHmM': round((ys.max()-ys.min())*mm,1) if mask.sum() else 0,
  'areaMm2': round(mask.sum()*mm*mm,1),
}
if mask.sum():
    pad = 2
    crop = gray[max(ys.min()-pad,0):ys.max()+pad+1, max(xs.min()-pad,0):xs.max()+pad+1]
    Image.fromarray(crop.astype(np.uint8)).save(r'${cropFile.replace(/\\/g, '/')}')
d.close()
print(json.dumps(info))
`
  return JSON.parse(sh(PY, ['-c', code]).trim())
}

// IoU 模板匹配：artifact 内容 PNG vs bake 内容 PNG（0°/180°），PIL 归一化 + 二值
function iouCompare(bakeCropFile, artCropFile) {
  const code = `
import json, numpy as np
from PIL import Image
def load(p):
    arr = np.array(Image.open(p).convert('L').resize((400, 260), Image.LANCZOS))
    return (arr < 200).astype(bool)
B = load(r'''${bakeCropFile.replace(/\\/g, '/')}''')
A = load(r'''${artCropFile.replace(/\\/g, '/')}''')
def iou(a, b):
    inter = (a & b).sum(); union = (a | b).sum()
    return round(inter / union, 3) if union else 0
A180 = A[::-1, ::-1]
print(json.dumps({'iou0': iou(A, B), 'iou180': iou(A180, B)}))
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

function main() {
  fs.mkdirSync(OUT, { recursive: true })
  console.log('=== Bake Landscape Matrix Gate（横纸 8 组合真实打印）===')
  console.log(`纸: ${PAPER_MM.w}×${PAPER_MM.h}mm 横（PostScript） 命令: landscape,rotate=N,noscale,paper=postscript`)
  let allPass = true, total = 0, fail = []

  for (const c of CONTENTS) {
    for (const rot of ROTS) {
      const tag = `${c.key}-rot${rot}`
      if (only && only !== tag) continue
      total++
      // 1. bake 产物（旋转烤进）
      const bake = makeBake(c, rot, tag)
      // 2. bake 路径 rotate = 恒 90（Sumatra landscape 隐含 -90° 补偿；bake 内容已烤进最终方向）
      //    ⚠️ 非 16 表查表值（270 在 bake 路径会倒置，4/4 实测 FAIL；16 表 270 是直打模型适配值）
      const cmdRot = 90
      const cmd = `landscape,rotate=${cmdRot},noscale,paper=postscript`
      try {
        // 3. 打印 + grab
        const art = printAndGrab(bake.outPdf, cmd, tag)
        const bakeCrop = path.join(OUT, `crop_bake_${tag}.png`)
        const artCrop = path.join(OUT, `crop_art_${tag}.png`)
        const artProbe = probe(art, artCrop)
        const bakeProbe = probe(bake.outPdf, bakeCrop)
        // 4. 断言
        const paperOk = artProbe.visualOrient === 'landscape'
          && Math.abs(artProbe.wMm - 240) < 3 && Math.abs(artProbe.hMm - 140) < 3
        const areaRatio = artProbe.areaMm2 ? (artProbe.bboxWmM * artProbe.bboxHmM) / (artProbe.wMm * artProbe.hMm) : 0
        const complete = areaRatio >= 0.15
        const { iou0, iou180 } = iouCompare(bakeCrop, artCrop)
        const directionOk = iou0 > iou180
        const pass = paperOk && complete && directionOk
        if (!pass) { allPass = false; fail.push(tag) }
        console.log(`${pass ? '✅' : '❌'} ${tag}: cmd="${cmd}" 纸${artProbe.visualOrient}(${artProbe.wMm}×${artProbe.hMm}) 内容${artProbe.bboxWmM}×${artProbe.bboxHmM}(${(areaRatio*100).toFixed(0)}%) IoU(0°)=${iou0} IoU(180°)=${iou180} ${directionOk ? '正向' : '倒置'} ${pass ? '' : 'FAIL'}`)
      } catch (e) {
        allPass = false; fail.push(tag)
        console.log(`❌ ${tag}: ${e.message}`)
      }
    }
  }

  console.log(`\n${allPass ? `GATE PASS ✅ ${total}/${total} 横纸组合真实打印全过` : `GATE FAIL ❌ ${fail.join(', ')}`}`)
  process.exit(allPass ? 0 : 1)
}

main()
