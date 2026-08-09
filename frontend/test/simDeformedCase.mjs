import { resolveContentPlacement } from '../src/layout/RotationResolver.js'
import { computeLayoutRotation } from '../src/layout/RotationResolver.js'

const PX_TO_MM = 25.4 / 300
// A4 纸：竖纸型 = portrait(210x297)，横纸型 = landscape(297x210)
const PAPERS = {
  portrait: { widthMM: 210, heightMM: 297, orientation: 'portrait' },
  landscape: { widthMM: 297, heightMM: 210, orientation: 'landscape' },
}
const MARGIN = { left: 8, right: 8, top: 8, bottom: 8 }

// 真实 DIAG 数据
const SINGLE = { contentPx: { width: 2538, height: 1642 }, contentRotation: 90 } // raw 609x394 landscape 页, 用户转 90
const MULTI = { contentPx: { width: 2479, height: 3508 }, contentRotation: 0 } // raw 595x842 A4 portrait 页

function run(label, file, paperKey) {
  const paper = PAPERS[paperKey]
  const r = resolveContentPlacement({
    contentPhysicalSize: file.contentPx,
    contentRotation: file.contentRotation,
    // Commit 3：Resolver 只收 physicalPaper；paper.orientation 恒等于 paper 的几何形状，丢弃标签零变化
    physicalPaper: { widthMM: paper.widthMM, heightMM: paper.heightMM },
    margins: MARGIN,
    dpi: 300,
  })
  const cb = r.renderTransform
  // 缩略图真实朝向 = contentPx 经 contentRotation 烤入；contentBox 朝向 = effectiveContentSize
  const eff = r.effectiveContentSize
  const cbAspect = (eff.width / eff.height)
  const thumbAspect = (file.contentPx.width / file.contentPx.height) // 未旋转原始；烤入 rotation 后取倒数当 90/270
  const rotated = (file.contentRotation % 180) !== 0
  const realThumbAspect = rotated ? 1 / thumbAspect : thumbAspect
  const aspectMatch = Math.abs(cbAspect - realThumbAspect) < 0.02
  console.log(
    `[${label}] paper=${paperKey} cr=${file.contentRotation}\n` +
    `  layoutRotation=${r.layoutRotation} rotationDeg=${cb.rotationDeg}\n` +
    `  contentBox(mm)=${r.renderTransform.imageWidth*PX_TO_MM|0}x${r.renderTransform.imageHeight*PX_TO_MM|0}` +
    `  effPx=${Math.round(eff.width)}x${Math.round(eff.height)} aspect=${cbAspect.toFixed(3)}\n` +
    `  thumbAspect(烤入cr)=${realThumbAspect.toFixed(3)} aspectMatch=${aspectMatch}\n` +
    `  scale=${cb.scale.toFixed(4)} placedRect=${Math.round(r.placedRect.width)}x${Math.round(r.placedRect.height)}`
  )
}

console.log('=== 单页文件 (contentPx landscape 2538x1642, cr=90) ===')
run('单页/竖纸型', SINGLE, 'portrait')
run('单页/横纸型', SINGLE, 'landscape')
console.log('=== 多页文件 (contentPx portrait 2479x3508, cr=0) ===')
run('多页/竖纸型', MULTI, 'portrait')
run('多页/横纸型', MULTI, 'landscape')
