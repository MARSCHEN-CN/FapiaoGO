import { resolveContentPlacement } from '../src/layout/RotationResolver.js'
const PX_TO_MM = 25.4 / 300
const PAPERS = {
  portrait: { widthMM: 210, heightMM: 297, orientation: 'portrait' },
  landscape: { widthMM: 297, heightMM: 210, orientation: 'landscape' },
}
const MARGIN = { left: 8, right: 8, top: 8, bottom: 8 }
// 假设（用户模型）：contentPx 是错的（intrinsic 被交换 85x220），
// 真实缩略图是 220x85（landscape，因 /Rotate 已烤入渲染）
const CONTENT_PX = { width: 85, height: 220 }
const THUMB_NATURAL = { width: 220, height: 85 }

function run(label, paperKey) {
  const paper = PAPERS[paperKey]
  const r = resolveContentPlacement({
    contentPhysicalSize: CONTENT_PX,
    contentRotation: 0,
    paperSize: { widthMM: paper.widthMM, heightMM: paper.heightMM },
    paperOrientation: paper.orientation,
    margins: MARGIN,
    dpi: 300,
  })
  const cbW = r.renderTransform.imageWidth * PX_TO_MM
  const cbH = r.renderTransform.imageHeight * PX_TO_MM
  const deg = ((r.renderTransform.rotationDeg % 360) + 360) % 360
  const rotated = deg === 90 || deg === 270
  // SVG 旋转后盒子显示朝向（rotate(±90) 交换 W/H）
  const dispW = rotated ? cbH : cbW
  const dispH = rotated ? cbW : cbH
  const cbAspect = cbW / cbH
  const thumbAspect = THUMB_NATURAL.width / THUMB_NATURAL.height
  const aspectMismatch = Math.abs(cbAspect - thumbAspect) > 0.02
  console.log(`[${label}] paper=${paperKey} layoutRotation=${r.layoutRotation} rotationDeg=${deg}`)
  console.log(`  contentBox(mm)=${cbW.toFixed(1)}x${cbH.toFixed(1)} aspect=${cbAspect.toFixed(3)}`)
  console.log(`  thumbNatural=${THUMB_NATURAL.width}x${THUMB_NATURAL.height} aspect=${thumbAspect.toFixed(3)}`)
  console.log(`  显示后盒子=${dispW.toFixed(1)}x${dispH.toFixed(1)} 朝向匹配缩略图=${!aspectMismatch} 但内部被拉伸=${aspectMismatch}`)
}
console.log('=== 假设 contentPx=85x220(错) vs 真实缩略图=220x85 ===')
run('竖纸型', 'portrait')
run('横纸型', 'landscape')
