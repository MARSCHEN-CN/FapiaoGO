/**
 * 静态 Gate（Commit 2-H 审计）：同内容 + A5/A4/A3，验证 fit scale 是否被 `Math.min(...,1)` 错误封顶。
 * 运行：node test/_fitAudit.mjs
 */
import { resolveContentPlacement } from '../src/layout/RotationResolver.js'

// 一张"小横票"：物理尺寸 ~100×70mm（px@300 = 1180×825），模拟用户真实小发票
const content = { width: 1180, height: 825 }
const margins = { left: 10, right: 10, top: 10, bottom: 10 } // mm

const PAPERS = {
  A5: { widthMM: 148, heightMM: 210 },
  A4: { widthMM: 210, heightMM: 297 },
  A3: { widthMM: 297, heightMM: 420 },
}

const pxPerMm = 300 / 25.4
const hdr = (s) => `\n=== ${s} ===`
console.log(hdr('同内容(1180×825px@300) + 各纸张(10mm 边距)'))
console.log('paper | availableW×H(px) | avail/contentW | avail/contentH | scale(实际) | scale(应得,无上限) | 是否封顶')

for (const [name, paper] of Object.entries(PAPERS)) {
  const r = resolveContentPlacement({
    contentPhysicalSize: content,
    contentRotation: 0,
    paperSize: paper,
    paperOrientation: 'portrait',
    margins,
    dpi: 300,
  })
  const aW = r.availableRect.w
  const aH = r.availableRect.h
  const ratioW = aW / r.effectiveContentSize.width
  const ratioH = aH / r.effectiveContentSize.height
  const shouldBe = Math.min(ratioW, ratioH)
  const capped = r.scale < shouldBe - 1e-9
  console.log(
    `${name.padEnd(4)}  | ${aW}×${aH}`.padEnd(34),
    `| ${ratioW.toFixed(2)}×${ratioH.toFixed(2)}`.padEnd(22),
    `| ${r.scale.toFixed(3)}`.padEnd(18),
    `| ${shouldBe.toFixed(3)}`.padEnd(22),
    `| ${capped ? '❌ 被封顶' : '✅ 已放大'}`
  )
}

console.log(hdr('结论'))
console.log('若三行均显示"❌ 被封顶"且 scale(应得)>1 → 证明 Math.min(...,1) 阻止了放大（根因确认）')
console.log('修复后：scale = Math.min(availW/contentW, availH/contentH)（去掉 1 上限），三行应变"✅ 已放大"')
