#!/usr/bin/env node
/**
 * Sumatra Command Matrix Gate — C-2-Sumatra-Command-Matrix（2026-08-11, v2）
 *
 * ⚠️ 本 Gate 是【16-case 实测表的规范验收】，不是理论推导。
 *
 * 数据来源（唯一 truth source）：用户 2026-08-11 在 Wondershare PDFelement
 * 真实打印的 16-case 实测矩阵。该表本身就是 specification——resolver 的
 * 输出必须与表逐项完全一致，不得用任何公式推导（方向 oracle 已废弃，
 * 历史教训：自造的 expectedContentOrient 公式曾误判 4 case）。
 *
 * 两层验收：
 *   L1 — Command Exact Match（核心，纯函数，不需打印机）：
 *        对每个 case，resolveSumatraRotation 输出 {orientation, rotate}
 *        == 16-case spec 表逐项完全一致（16/16 必须全对）。
 *   L2 — Real Print 客观属性（真实打印，只验实测可定义的客观条件）：
 *        a) artifact 可生成
 *        b) 纸视觉方向 == paperOrientation（横纸视觉横 / 竖纸视觉竖）
 *        c) 内容存在（bbox 面积 > 0）
 *        d) 内容完整性：内容 bbox 面积 ≥ 源内容 contain-fit 进纸后期望面积的 50%
 *           （方向无关——旋转不改变面积；只防严重裁切/缩放异常）
 *        ⚠️ 不再使用 invoiceOrientation + rotate 推导内容方向——内容最终
 *           bbox 方向受 fit/驱动布局影响，非命令的直接计算量。
 *
 * 用法: node sumatraCommandMatrixGate.mjs [--skip-print] [--only landscape-0-portrait]
 * 退出码：0 = L1 16/16 + L2 全过；1 = 有 FAIL。
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
const skipPrint = argv.includes('--skip-print')
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const only = get('--only', '')

function sleep(ms) { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ms) }
function sh(cmd, args, timeout = 120000) { return execFileSync(cmd, args, { timeout }).toString() }

// ── content: 横票 / 竖票（源 MediaBox 尺寸，固定 fixture）──
// 横票 595×397pt = 210×140mm；竖票 595×842pt = 210×297mm
const CONTENTS = [
  { key: 'landscape', file: path.join(REPO, 'test_fixtures', '25952000000127675627.pdf'),
    srcWmm: 210, srcHmm: 140 },
  { key: 'portrait', file: path.join(HERE, 'marginContract', '.out', 'a3v2_portrait_content.pdf'),
    srcWmm: 210, srcHmm: 297 },
]
const PAPERS = [
  { key: 'portrait', paperOrientation: 'portrait', paperWmm: 210, paperHmm: 297 },
  { key: 'landscape', paperOrientation: 'landscape', paperWmm: 297, paperHmm: 210 },
]

// ── 16-case spec 表（用户 2026-08-11 实测，唯一 truth source；勿改）──
// [contentOrientation][contentRotation][paperOrientation] = rotate
const SPEC = {
  landscape: {          // 横发票
    landscape: { 0: 90, 90: 90, 180: 270, 270: 270 },   // 横纸
    portrait:  { 0: 90, 90: 270, 180: 270, 270: 90 },   // 竖纸
  },
  portrait: {           // 竖发票
    landscape: { 0: 270, 90: 90, 180: 90, 270: 270 },   // 横纸
    portrait:  { 0: 90, 90: 90, 180: 270, 270: 270 },   // 竖纸
  },
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
  'rotate': p.rotation,
  'wMm': round(pix.width*mm,1), 'hMm': round(pix.height*mm,1),
  'visualOrient': 'landscape' if pix.width > pix.height else 'portrait',
  'bboxWmM': round((xs.max()-xs.min())*mm,1) if mask.sum() else 0,
  'bboxHmM': round((ys.max()-ys.min())*mm,1) if mask.sum() else 0,
  'areaMm2': round(mask.sum()*mm*mm,1),
}))
d.close()
`
  return JSON.parse(sh(PY, ['-c', code]).trim())
}

// 方向无关的内容完整性基准：源内容 contain-fit 进纸后的期望面积
function expectedContentAreaMm2(srcWmm, srcHmm, paperWmm, paperHmm) {
  const scale = Math.min(paperWmm / srcWmm, paperHmm / srcHmm)
  return srcWmm * scale * srcHmm * scale
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
  console.log('=== C-2-Sumatra-Command-Matrix Gate v2（16-case spec 验收）===')

  // ── L1: Command Exact Match（纯函数，16/16 硬性）──
  let l1AllPass = true
  let l1Total = 0
  let l1Mismatch = []
  console.log('\n--- L1: Command Exact Match（resolver 输出 vs 16-case spec 表）---')
  for (const c of CONTENTS) {
    for (const rot of [0, 90, 180, 270]) {
      for (const p of PAPERS) {
        l1Total++
        const expectedRotate = SPEC[c.key][p.paperOrientation][rot]
        const got = resolveSumatraRotation({
          contentOrientation: c.key, contentRotation: rot, paperOrientation: p.paperOrientation,
        })
        const match = got.rotate === expectedRotate && got.orientation === p.paperOrientation
        if (!match) { l1AllPass = false; l1Mismatch.push(`${c.key}-rot${rot}-${p.key}`) }
        const cmd = [...toOrientationParts(got), 'fit', 'paper=a4'].join(',')
        console.log(`${match ? '✅' : '❌'} ${c.key}-rot${rot}-${p.key}: spec rotate=${expectedRotate} resolver=${got.rotate} cmd="${cmd}"`)
      }
    }
  }
  console.log(`L1: ${l1AllPass ? '16/16 PASS ✅' : `FAIL（${l1Mismatch.join(', ')}）`}`)

  // ── L2: Real Print 客观属性（仅验客观条件，不猜内容方向）──
  if (skipPrint) {
    console.log('\n（--skip-print：跳过 L2 真实打印，L1 command match 已验）')
    console.log(l1AllPass ? '\nGATE PASS ✅（L1 16/16）' : '\nGATE FAIL ❌（L1 偏离 spec）')
    process.exit(l1AllPass ? 0 : 1)
  }
  if (!fs.existsSync(SUMATRA)) {
    console.error(`❌ SumatraPDF 不存在: ${SUMATRA}`)
    process.exit(1)
  }
  let l2AllPass = true
  let l2Total = 0
  let l2Fail = []
  console.log('\n--- L2: Real Print 客观属性（纸方向 / 内容存在 / 完整性≥50%）---')
  for (const c of CONTENTS) {
    for (const rot of [0, 90, 180, 270]) {
      for (const p of PAPERS) {
        const tag = `${c.key}-rot${rot}-${p.key}`
        if (only && only !== tag) continue
        l2Total++
        const r = resolveSumatraRotation({
          contentOrientation: c.key, contentRotation: rot, paperOrientation: p.paperOrientation,
        })
        const cmd = [...toOrientationParts(r), 'fit', 'paper=a4'].join(',')
        const expectArea = expectedContentAreaMm2(c.srcWmm, c.srcHmm, p.paperWmm, p.paperHmm)
        const areaFloor = expectArea * 0.5
        try {
          const art = printAndGrab(c.file, cmd, tag)
          const m = probe(art)
          const paperOk = m.visualOrient === p.paperOrientation
          const contentExists = m.areaMm2 > 0
          const complete = m.areaMm2 >= areaFloor
          const pass = paperOk && contentExists && complete
          if (!pass) { l2AllPass = false; l2Fail.push(tag) }
          console.log(`${pass ? '✅' : '❌'} ${tag}: 纸${m.visualOrient}(${m.wMm}×${m.hMm}) 内容bbox ${m.bboxWmM}×${m.bboxHmM} 面积${m.areaMm2}mm²(基准≥${areaFloor.toFixed(0)}) ${pass ? '' : 'FAIL'}  /Rotate=${m.rotate}`)
        } catch (e) {
          l2AllPass = false; l2Fail.push(tag)
          console.log(`❌ ${tag}: ${e.message}`)
        }
      }
    }
  }
  console.log(`\nL2: ${l2AllPass ? `${l2Total}/${l2Total} PASS ✅` : `FAIL：${l2Fail.join(', ')}`}`)
  const allPass = l1AllPass && l2AllPass
  console.log(allPass ? '\nGATE PASS ✅（L1 16/16 + L2 客观属性全过）' : '\nGATE FAIL ❌')
  process.exit(allPass ? 0 : 1)
}

main()
