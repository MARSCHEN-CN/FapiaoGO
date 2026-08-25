/**
 * R-4 Final Regression Snapshot — R-4 系列闭环回归基线（R-4.8 Closeout）
 *
 * 运行: node --test frontend/src/print/__tests__/r4FinalRegression.test.mjs
 *
 * 覆盖（用户裁决 2026-08-25）：
 *   R4-FINAL-01  PDF 单页 + 横向纸 + margin → placement bake contract（hasPlacement/spec 297×210 + Truth guard）
 *   R4-FINAL-02  PDF 多页 + 横向纸 + margin → pagePlacements[] 契约（20 页显式 pageIndex）
 *   R4-FINAL-03  OFD landscape → raster baked declaration（printImageAsPdf commandOrientation/commandRotate=0）
 *   R4-FINAL-04  Image landscape → raster baked declaration + Truth isolation（main.js guard 不注入）
 *
 * 冻结面：execution-truth-resolver / 32-case / Sumatra mapping / placement_bake.py /
 *          margin_contract.py / RotationResolver / PDF source path —— 本测试只断言契约，不改逻辑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const placementBake = require(path.join(REPO, 'electron', 'print-service', 'placement-bake-processor.js'))
const PrintServiceSrc = fs.readFileSync(path.join(REPO, 'frontend/src/services/PrintService.js'), 'utf8')
const mainJsSrc = fs.readFileSync(path.join(REPO, 'electron/main.js'), 'utf8')

// ── fixture（与 placementBakeV2Contract 同源）──
function mkPlacement(over = {}) {
  return {
    scale: 0.5,
    offset: { x: 35.4, y: 35.4 },
    placedRect: { x: 35.4, y: 35.4, w: 700, h: 500 },
    layoutRotation: 0,
    contentRotation: 0,
    canvasSize: { width: 2480, height: 3508 },
    ...over,
  }
}

function mkSettings({ landscape = true, placement = mkPlacement(), pagePlacements = null } = {}) {
  return {
    rotation: 0, sourceRotation: 0, paper: 'A4', paperkind: undefined, fit: 'contain',
    landscape, contentOrientation: 'portrait', duplex: false, grayscale: false, copies: 1,
    marginLeft: 3, marginRight: 3, marginTop: 3, marginBottom: 3, customPaper: undefined,
    placement, pagePlacements,
    executionPaper: {
      size: 'A4', orientation: landscape ? 'landscape' : 'portrait',
      widthMM: landscape ? 297 : 210, heightMM: landscape ? 210 : 297, customPaper: null,
    },
  }
}

test('R4-FINAL-01: PDF 单页 + 横向纸 + margin → placement bake contract（spec 297×210 + Truth guard 归零）', () => {
  const settings = mkSettings()
  assert.equal(placementBake.hasPlacement(settings, 'C:/tmp/invoice.pdf'), true,
    '单页 PDF + 横向纸 + placement → bake 判定通过')
  const spec = placementBake.buildBakeSpec('C:/tmp/invoice.pdf', settings, 'C:/tmp/out.pdf')
  assert.equal(spec.paper.widthMm, 297, 'executionPaper 横向 A4 → spec.paper.widthMm=297')
  assert.equal(spec.paper.heightMm, 210)
  assert.equal('pagePlacements' in spec, false, '单页（无 pagePlacements）→ spec 仅 placement（v1 兼容）')
  // Truth isolation：main.js guard 存在 → 已烘焙路径 commandOrientation 已设 → 不注入（commandRotate=0）
  assert.match(mainJsSrc, /if \(!printSettings\.commandOrientation\) \{/,
    'main.js 必须存在 !commandOrientation → 跳过 Truth 的 guard')
})

test('R4-FINAL-02: PDF 多页 + 横向纸 + margin → pagePlacements[] 契约（20 页显式 pageIndex）', () => {
  const pagePlacements = Array.from({ length: 20 }, (_, i) => ({
    pageIndex: i, placement: mkPlacement({ scale: 0.5 }),
  }))
  const settings = mkSettings({ pagePlacements })
  assert.equal(placementBake.hasPlacement(settings, 'C:/tmp/multi.pdf'), true,
    '20 页 pagePlacements + 横向纸 → bake 判定通过')
  const spec = placementBake.buildBakeSpec('C:/tmp/multi.pdf', settings, 'C:/tmp/out.pdf')
  assert.ok(Array.isArray(spec.pagePlacements) && spec.pagePlacements.length === 20, 'spec.pagePlacements 20 项')
  assert.equal(spec.pagePlacements[19].pageIndex, 19, 'pageIndex 显式携带（D3，不依赖数组位置）')
  assert.equal(spec.pagePlacements[0].placement.scale, 0.5)
})

test('R4-FINAL-03: OFD landscape → raster baked declaration（printImageAsPdf commandOrientation/commandRotate=0）', () => {
  // OFD 与 image 同走 printImageAsPdf（R-4.7 修复点）：临时 PDF 已由 /print_pdf 烘焙 → 执行层声明 baked
  assert.match(PrintServiceSrc, /ps\.commandOrientation = paperOrient/,
    'printImageAsPdf 必须预设 commandOrientation = requestedPaperOrientation')
  assert.match(PrintServiceSrc, /ps\.commandRotate = 0/,
    'printImageAsPdf 必须预设 commandRotate = 0（baked 产物，Truth 不介入）')
  assert.match(PrintServiceSrc, /print_pdf\/\$\{encodeURIComponent\(docId\)\}/,
    'raster 走 /print_pdf 烘焙端点（R-4.7 authority 链完整）')
})

test('R4-FINAL-04: Image landscape → raster baked declaration + Truth isolation（guard 不注入）', () => {
  // image 与 OFD 同一 baked contract（R4-FINAL-03 断言复用）
  assert.match(PrintServiceSrc, /ps\.commandRotate = 0/)
  // Truth isolation：raster 不再进入 32-case 推导（R-4.7 根因：{portrait,portrait,0,landscape}=180）
  assert.match(mainJsSrc, /injectExecutionTruth\(printSettings, printSettings, \{ baked: false \}\)/,
    'Truth 注入仍在 guard 内（commandOrientation 已设则跳过）')
  const guardBlock = mainJsSrc.slice(mainJsSrc.indexOf('if (!printSettings.commandOrientation)'))
  assert.ok(guardBlock.indexOf('injectExecutionTruth') > guardBlock.indexOf('{'),
    'injectExecutionTruth 必须在 guard 块内（Truth isolation 结构性约束）')
})
