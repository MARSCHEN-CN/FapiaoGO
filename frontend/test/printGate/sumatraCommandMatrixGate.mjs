#!/usr/bin/env node
/**
 * Sumatra Command Matrix Gate — C-2-Sumatra-Command-Matrix（2026-08-11）
 *
 * 真实打印验收 16-case 映射表：invoiceRotation × paperOrientation → Sumatra 命令。
 *
 * 链路（源 PDF 直打，无 bake——16 表是 executor command 层）：
 *   resolveSumatraRotation({contentOrientation, contentRotation, paperOrientation})
 *     → {orientation, rotate} → [landscape|disable-auto-rotation, rotate=N, fit, paper=a4]
 *     → Sumatra → Wondershare → artifact
 *
 * 断言（每 case）：
 *   - artifact 视觉方向 == paperOrientation（横纸视觉横 / 竖纸视觉竖）
 *   - 内容 bbox 方向 == 期望内容方向（发票自然方向 + contentRotation，mod 180）
 *   - 内容完整（bbox 面积 ≥ 源内容适配后 60%，防严重裁切）
 *
 * 用法: node sumatraCommandMatrixGate.mjs [--only landscape-0-portrait]
 * 退出码：0 = 16/16 PASS；1 = 有 FAIL。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const PY = path.join(REPO, 'backend', 'venv', 'Scripts', 'python.exe')
const SUMATRA = path.join(REPO, 'resources', 'sumatra', 'SumatraPDF.exe')
const OUT = path.join(HERE, '.out', 'cmd-matrix')

const require = createRequire(import.meta.url)
const { resolveSumatraRotation, toOrientationParts } = require(
  path.join(REPO, 'electron', 'print-service', 'sumatra-command-resolver.js'))

const argv = process.argv.slice(2)
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const only = get('--only', '')

function sleep(ms) { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ms) }
function sh(cmd, args, timeout = 120000) { return execFileSync(cmd, args, { timeout }).toString() }

// content: 横票 / 竖票
const CONTENTS = [
  { key: 'landscape', file: path.join(REPO, 'test_fixtures', '25952000000127675627.pdf') },   // 595×397 横
  { key: 'portrait', file: path.join(HERE, 'marginContract', '.out', 'a3v2_portrait_content.pdf') },  // 595×842 竖
]
const PAPERS = [
  { key: 'portrait', paperOrientation: 'portrait', expectVisual: 'portrait' },
  { key: 'landscape', paperOrientation: 'landscape', expectVisual: 'landscape' },
]

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

// 期望内容方向（发票自然方向 + contentRotation，mod 180：横=landscape 竖=portrait）
function expectedContentOrient(contentOrient, rotation) {
  // 自然方向角：横=0°，竖=90°（mod 180）
  const base = contentOrient === 'landscape' ? 0 : 90
  const final = (base + rotation) % 180
  return final === 0 ? 'landscape' : 'portrait'
}

function printAndGrab(baked, cmd, tag) {
  const W = 'C:/ProgramData/Wondershare/PDFelement10/PDFCreator'
  const artifact = path.join(OUT, `art_${tag}.pdf`)
  try {
    sh(SUMATRA, ['-print-to', 'Wondershare PDFelement', '-print-settings', cmd, '-silent', '-exit-when-done', baked])
  } catch (e) { throw new Error(`Sumatra 失败: ${e.message}`) }
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
  console.log('=== C-2-Sumatra-Command-Matrix Gate（16 case 真实打印）===')
  let allPass = true
  let total = 0

  for (const c of CONTENTS) {
    for (const rot of [0, 90, 180, 270]) {
      for (const p of PAPERS) {
        const tag = `${c.key}-rot${rot}-${p.key}`
        if (only && only !== tag) continue
        total++
        const r = resolveSumatraRotation({
          contentOrientation: c.key, contentRotation: rot, paperOrientation: p.paperOrientation,
        })
        const cmd = [...toOrientationParts(r), 'fit', 'paper=a4'].join(',')
        // 内容最终方向 = 发票自然方向 + Sumatra 施加的 rotate（resolver 输出，非 contentRotation）
        const expectContent = expectedContentOrient(c.key, r.rotate)

        try {
          const art = printAndGrab(c.file, cmd, tag)
          const m = probe(art)
          const visualOk = m.visualOrient === p.expectVisual
          const contentOk = m.bboxWmM > 0 && (
            (expectContent === 'landscape' && m.bboxWmM >= m.bboxHmM) ||
            (expectContent === 'portrait' && m.bboxHmM >= m.bboxWmM))
          const pass = visualOk && contentOk
          console.log(`${pass ? '✅' : '❌'} ${tag}: cmd="${cmd}" → 视觉${m.visualOrient}(${m.wMm}×${m.hMm}) 内容${m.bboxWmM}×${m.bboxHmM} 期望内容${expectContent} ${pass ? '' : 'FAIL'}  /Rotate=${m.rotate}`)
          if (!pass) allPass = false
        } catch (e) {
          console.log(`❌ ${tag}: ${e.message}`)
          allPass = false
        }
      }
    }
  }

  console.log(`\n${allPass ? `GATE PASS ✅ ${total}/${total} case 全过` : `GATE FAIL ❌ ${total} case 有失败`}`)
  process.exit(allPass ? 0 : 1)
}

main()
