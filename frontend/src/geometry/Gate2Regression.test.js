/**
 * Gate 2 Regression Gate — 验证 Gate 2 Step 4 接线未引入回归。
 *
 * 范围冻结：本文件 ONLY 新增回归测试，不修改任何生产代码
 * （renderCommand / RotationResolver / Policy / detectOrientation.js / documentState rotation 语义均不动）。
 *
 * 覆盖：G2-R1 cache identity / G2-R2 snapshot·writeback / G2-R3 userRotation 叠加。
 * G2-R4（RenderCommand 边界）为静态审计，见 commit message。
 *
 * 隔离策略：paper 方向是 Gate 2 的外部输入（usePreview 用同一 paperOrient 串喂新旧两路），
 * Gate 2 只改 content 侧（detectDocumentOrientation → extractContentPx）。故本测试：
 *   - 直接以 usePreview 实际会传入的 paperOrient 字符串喂新旧两路对比（不引 resolvePaper/config 技术债）；
 *   - 额外断言 extractContentPx 与 detectDocumentOrientation 的 content 方向完全等价（核心改动面）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPreviewGeometry } from './PreviewGeometryBuilder.js'
import { extractContentPx } from './extractContentPx.js'
import { detectDocumentOrientation } from '../utils/detectOrientation.js'

// 旧算法 content 侧：detectDocumentOrientation 返回的 orientation
function legacyContentIsLandscape(file) {
  return detectDocumentOrientation(file) === 'landscape'
}
// 新算法 content 侧：extractContentPx 提取的 px 宽 > 高
function newContentIsLandscape(file) {
  const { widthPx, heightPx } = extractContentPx(file)
  return widthPx > heightPx
}

// 旧算法完整 isLandscape（content orientation !== paper orientation）
function legacyIsLandscape(file, paperOrient) {
  return legacyContentIsLandscape(file) !== (paperOrient === 'landscape')
}
// 新算法完整 orientationMismatch（sourceContentLandscape !== paperLandscape）
function newOrientationMismatch(file, paperOrient) {
  return buildPreviewGeometry({
    rawDocumentGeometry: extractContentPx(file),
    requestedPaperGeometry: { orientation: paperOrient },
    userRotation: { degrees: 0 },
  }).orientationMismatch
}

const PORTRAIT = 'portrait'
const LANDSCAPE = 'landscape'

// 三种 px 源（PDF / 图片 / OFD），均与 detectDocumentOrientation 同源
const SOURCES = {
  PDF: (w, h) => ({ _pdfPageWidth: w, _pdfPageHeight: h }),
  image: (w, h) => ({ _imageWidth: w, _imageHeight: h }),
  OFD: (w, h) => ({ _imageWidth: w, _imageHeight: h, previewWidth: w, previewHeight: h, _fileFormat: 'ofd' }),
}

// G2-R1 — Cache Identity Stability：旧 isLandscape 必须等于新 orientationMismatch
test('G2-R1: old isLandscape === new orientationMismatch（4 格 × 3 源，缓存键身份不变）', () => {
  const cells = [
    { name: 'A 横内容+竖纸', w: 3508, h: 2480, paperOrient: PORTRAIT, expected: true },
    { name: 'B 竖内容+横纸', w: 2480, h: 3508, paperOrient: LANDSCAPE, expected: true },
    { name: 'C 竖内容+竖纸', w: 2480, h: 3508, paperOrient: PORTRAIT, expected: false },
    { name: 'D 横内容+横纸', w: 3508, h: 2480, paperOrient: LANDSCAPE, expected: false },
  ]
  for (const srcName of Object.keys(SOURCES)) {
    const make = SOURCES[srcName]
    for (const cell of cells) {
      const file = make(cell.w, cell.h)
      // 核心改动面：extractContentPx 与 detectDocumentOrientation 的 content 方向必须完全一致
      assert.equal(
        newContentIsLandscape(file),
        legacyContentIsLandscape(file),
        `[${srcName}] ${cell.name}: extractContentPx ≡ detectDocumentOrientation（content 方向）`,
      )
      const legacy = legacyIsLandscape(file, cell.paperOrient)
      const next = newOrientationMismatch(file, cell.paperOrient)
      assert.equal(legacy, cell.expected, `[${srcName}] ${cell.name}: 旧值正确`)
      assert.equal(next, cell.expected, `[${srcName}] ${cell.name}: 新值正确`)
      assert.equal(legacy, next, `[${srcName}] ${cell.name}: 旧 === 新（缓存键不漂移）`)
    }
  }
})

// G2-R1 附加：同一文件重复 build → 输出稳定（无随机 / 无副作用）
test('G2-R1: 同一文件两次 build 输出 orientationMismatch 完全一致', () => {
  const file = SOURCES.PDF(3508, 2480)
  const a = newOrientationMismatch(file, PORTRAIT)
  const b = newOrientationMismatch(file, PORTRAIT)
  assert.equal(a, b)
})

// G2-R2 — Preview Snapshot 不污染：Builder 纯函数，绝不反向写入/不改输入
test('G2-R2: buildPreviewGeometry 不修改入参（source geometry / file 均不可变）', () => {
  const file = SOURCES.PDF(3508, 2480)
  const source = extractContentPx(file)
  const sourceBefore = { ...source }
  const fileBefore = { ...file }
  const out = buildPreviewGeometry({
    rawDocumentGeometry: source,
    requestedPaperGeometry: { orientation: PORTRAIT },
    userRotation: { degrees: 0 },
  })
  assert.deepEqual(source, sourceBefore, 'rawDocumentGeometry 未被改动')
  assert.deepEqual(file, fileBefore, '源文件对象未被改动')
  assert.notEqual(out.effectiveContentGeometry, source, 'effectiveContentGeometry 是新对象，非入参引用')
  // 旋转前输入尺寸必须保持 3508×2480，不得因 auto-rotation 回流成 2480×3508
  assert.equal(out.sourceContentGeometry.widthPx, 3508)
  assert.equal(out.sourceContentGeometry.heightPx, 2480)
})

// G2-R3 — User Rotation 语义保留：用户旋转仍是 canonical 叠加，不被 autoRotation 覆盖/清除
test('G2-R3: 横内容+竖纸+userRotation 90 → effectiveRotation=0（叠加，非覆盖）', () => {
  // 用户给的基准：autoRotation=270（横+竖），userRotation=90 → effectiveRotation=normalize(270+90)=0
  const out = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 },
    requestedPaperGeometry: { orientation: PORTRAIT },
    userRotation: { degrees: 90 },
  })
  assert.equal(out.effectiveRotation, 0, 'effectiveRotation = normalize(270 + 90) = 0')

  // 对比基线：若无 userRotation，effectiveRotation 应为 auto 基线 270。
  // 此处 0（≠ 270）证明 userRotation 真正参与了叠加，而非被清零/忽略。
  const withoutUser = buildPreviewGeometry({
    rawDocumentGeometry: { widthPx: 3508, heightPx: 2480 },
    requestedPaperGeometry: { orientation: PORTRAIT },
    userRotation: { degrees: 0 },
  })
  assert.equal(withoutUser.effectiveRotation, 270, '无 userRotation → effectiveRotation=270（auto 基线）')
  assert.notEqual(out.effectiveRotation, withoutUser.effectiveRotation, 'userRotation 改变了结果（被消费）')

  // effectiveRotation=0 → 内容净不交换 → 仍为 3508×2480（landscape）；effectiveContentGeometry 与 effectiveRotation 一致
  assert.equal(out.effectiveContentGeometry.widthPx, 3508, 'effectiveRotation=0 → 内容净尺寸不交换')
  assert.equal(out.effectiveContentGeometry.heightPx, 2480)
})
