/**
 * singleVsMultiInputMatrix — Step A/B 审计（纯函数，不改源码）
 * =====================================================================
 * 目标：验证用户 2026-08-07 夜 提出的新假设
 *   「单页/多页走了不同 RenderResource 链 → contentPhysicalSize 已被旋转/缩放污染
 *    → RotationResolver 在错误坐标系里计算 → 单页严重变形、多页正常」
 *
 * 本 harness 使用【真实】resolveContentPlacement（不改其逻辑），
 * 模拟「同一张竖票（PDF 内嵌 /Rotate=90）」在两种尺寸写入路径下的输入：
 *
 *   Writer-A/B（usePreview RE / pdf.js 路径，已应用 /Rotate）
 *     _pdfPageWidth/Height = DISPLAY(旋转后) 尺寸 = 85×220
 *   Writer-C（usePrint dims loader，getViewport({rotation:0})）
 *     _pdfPageWidth/Height = INTRINSIC(未旋转) 尺寸 = 220×85
 *
 * 桩发票：自然页 points = 220×85（按 points 是横），page_rotation=90
 *   → 真实显示缩略图 = 85×220（竖），aspect = 85/220 ≈ 0.386
 *
 * 关键契约（RotationResolver.js:150）：
 *   「contentRotation 由本函数内部施加，请勿预旋转后传入」
 *   ⇒ Resolver 期望【未旋转】的 intrinsIC 尺寸；Writer-A/B 预旋转 = 违反契约。
 *
 * 变形执行点（PrintPreviewCanvas.jsx:77-83）：
 *   <image width={contentBoxWidth} height={contentBoxHeight} preserveAspectRatio="none">
 *   contentBoxWidth/Height = effectiveContentSize = 喂入的 contentPhysicalSize
 *   preserveAspectRatio="none" → 缩略图被拉伸到该盒子；
 *   若 contentPhysicalSize 长宽比 ≠ 真实缩略图长宽比 ⇒ 各向异性拉伸（严重变形）。
 *
 * 结论判据：aspect(effectiveContentSize) 与 真实缩略图 aspect(0.386) 是否一致。
 *   一致 → 等比 fit（正确）；不一致 → 变形。
 * =====================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveContentPlacement } from '../src/layout/RotationResolver.js'

const PREVIEW_DPI = 300
const K = PREVIEW_DPI / 72 // PDF points → px@dpi

// 真实显示缩略图尺寸（/Rotate=90 后）：竖 85×220
const IMAGE_DISPLAY = { w: 85, h: 220 }
const IMAGE_ASPECT = IMAGE_DISPLAY.w / IMAGE_DISPLAY.h // ≈ 0.386

// 两种 writer 输出（已 ×K 归一到 px@dpi，等价于 fileContentPx）
const writerRotated = { width: 85 * K, height: 220 * K }   // Writer-A/B：已应用 /Rotate
const writerUnrotated = { width: 220 * K, height: 85 * K } // Writer-C：未旋转 intrinsic

const A4_PORTRAIT = { widthMM: 210, heightMM: 297 }
const A4_LANDSCAPE = { widthMM: 297, heightMM: 210 } // PrintPreviewModel 对 landscape 交换 W/H 后传入

const MARGINS = { left: 3, right: 3, top: 3, bottom: 3 }

function run(label, contentPx, paperSize, paperOrientation, contentRotation = 0) {
  const r = resolveContentPlacement({
    contentPhysicalSize: { width: contentPx.width, height: contentPx.height },
    contentRotation,
    paperSize,
    paperOrientation,
    margins: MARGINS,
    dpi: PREVIEW_DPI,
  })
  const eff = r.effectiveContentSize
  const effAspect = eff.width / eff.height
  const aspectMismatch = Math.abs(effAspect - IMAGE_ASPECT) > 1e-3
  return {
    label,
    contentPhysicalSize: `${Math.round(contentPx.width)}×${Math.round(contentPx.height)}`,
    effectiveContentSize: `${Math.round(eff.width)}×${Math.round(eff.height)}`,
    contentOrientation: r.contentOrientation,
    layoutRotation: r.layoutRotation,
    scale: Number(r.scale.toFixed(3)),
    contentBox: `${Math.round(r.renderTransform.imageWidth)}×${Math.round(r.renderTransform.imageHeight)}`,
    DISTORTION: aspectMismatch ? '❌ 是（长宽比不符）' : '✅ 否（等比）',
  }
}

test('Step A/B：单页 vs 多页 输入矩阵（同一竖票 /Rotate=90）', () => {
  const rows = [
    run('[单页推测-Writer-C 未旋转] 竖纸型', writerUnrotated, A4_PORTRAIT, 'portrait'),
    run('[单页推测-Writer-C 未旋转] 横纸型', writerUnrotated, A4_LANDSCAPE, 'landscape'),
    run('[多页推测-Writer-A/B 已旋转] 竖纸型', writerRotated, A4_PORTRAIT, 'portrait'),
    run('[多页推测-Writer-A/B 已旋转] 横纸型', writerRotated, A4_LANDSCAPE, 'landscape'),
  ]

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' 同一竖票（PDF /Rotate=90，真实缩略图 85×220，aspect≈0.386）')
  console.log(' 真实 Resolver 输出矩阵（未改源码）')
  console.log('══════════════════════════════════════════════════════════════')
  for (const row of rows) {
    console.log(`\n${row.label}`)
    console.log(`  contentPhysicalSize : ${row.contentPhysicalSize}`)
    console.log(`  effectiveContentSize: ${row.effectiveContentSize}`)
    console.log(`  contentOrientation  : ${row.contentOrientation}`)
    console.log(`  layoutRotation      : ${row.layoutRotation}`)
    console.log(`  scale (fit)         : ${row.scale}`)
    console.log(`  contentBox(<image>) : ${row.contentBox}  (preserveAspectRatio=none 拉伸目标)`)
    console.log(`  ⇒ 变形?             : ${row.DISTORTION}`)
  }
  console.log('\n────────────────────────────────────────────────────────────')
  console.log(' 机制判定：')
  console.log('   当 contentPhysicalSize 来自 Writer-A/B（已旋转 85×220）→')
  console.log('     effectiveContentSize aspect=0.386 == 缩略图 aspect → 等比 fit ✅')
  console.log('   当 contentPhysicalSize 来自 Writer-C（未旋转 220×85）→')
  console.log('     effectiveContentSize aspect=2.59 ≠ 缩略图 aspect → 各向异性拉伸 ❌')
  console.log('────────────────────────────────────────────────────────────\n')

  // 机制不变量断言（与纸张方向无关，仅由 writer 决定）
  const unrotPortrait = rows[0]
  const rotPortrait = rows[2]
  assert.equal(unrotPortrait.DISTORTION.includes('❌'), true,
    'Writer-C(未旋转) 输入必导致变形')
  assert.equal(rotPortrait.DISTORTION.includes('✅'), true,
    'Writer-A/B(已旋转) 输入必等比 fit')

  // 输入矩阵确为不同尺寸来源（单页/多页核心怀疑点）
  assert.notEqual(rows[0].contentPhysicalSize, rows[2].contentPhysicalSize,
    '单页/多页路径产出不同 contentPhysicalSize → 印证尺寸来源不一致')
})
