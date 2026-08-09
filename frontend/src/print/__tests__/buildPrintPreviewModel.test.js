/**
 * buildPrintPreviewModel.test — 聚合 source 预览展开回归测试
 *
 * 测试目标：
 *   Bug A 计数（已在 a474d863 修复）+ Bug A-2（缩略图正确 docId）
 *   + Bug A-3a（模型层 currentSelection 可解析聚合页 identity）。
 *
 *   同票两页（A）+ 单页（B）导入后，打印预览应 = 3 页，
 *   且 A 两页各自使用正确的物理页 docId（而非聚合代表页 docId + page=2）。
 *   currentSelection 应能按每页的真实 identity（pageFile.key）定位。
 *
 * 设计原则：
 *   - 走真实管线 createPrintPlanInput → buildPrintExecutionPlan → buildPrintPreviewModel。
 *   - 拆分页使用不同 docId（docA_p1 / docA_p2），才能暴露 A-2 bug。
 *   - 纯 node:test，不依赖 vite。
 *   - 不验证几何/placement。
 *
 * @module print/__tests__/buildPrintPreviewModel
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrintPreviewModel } from '../PrintPreviewModel.js'
import { createPrintPlanInput, buildPrintExecutionPlan } from '../buildPrintExecutionPlan.js'

// ── helpers ──

function makePage({ key, instanceId = '', sourceDocId, pageNum = 0, totalPages = 1, docId, printPath = '/p', name }) {
  return {
    key, instanceId, sourceDocId, pageNum, totalPages,
    docId, printPath, fileFormat: 'pdf', status: 'parsed',
    name: name || key, pageCount: 1,
  }
}

function buildModelForFiles(rawFiles, settings = { paperSize: 'A4' }) {
  const { files, options } = createPrintPlanInput(rawFiles, { landscape: false, ...settings })
  const plan = buildPrintExecutionPlan(files, options)
  return buildPrintPreviewModel(plan, { files, settings, backendUrl: '' })
}

function buildModelForFilesWithSelection(rawFiles, selection, settings = { paperSize: 'A4' }) {
  const { files, options } = createPrintPlanInput(rawFiles, { landscape: false, ...settings })
  const plan = buildPrintExecutionPlan(files, options)
  return buildPrintPreviewModel(plan, { files, settings, currentSelection: selection, backendUrl: '' })
}

// ── fixtures ──
// 拆分页使用不同 docId（真实场景：拆分后的每页独立 sha256）
const A_P1 = makePage({ key: 'A_p1', instanceId: 'inst-A', sourceDocId: 'docA', pageNum: 0, totalPages: 2, docId: 'docA_p1', name: 'A-1' })
const A_P2 = makePage({ key: 'A_p2', instanceId: 'inst-A', sourceDocId: 'docA', pageNum: 1, totalPages: 2, docId: 'docA_p2', name: 'A-2' })
const B    = makePage({ key: 'B', sourceDocId: 'docB', pageNum: 0, totalPages: 1, docId: 'docB', name: 'B' })

// ── Case 1: 计数 & 页序 ──

test('Case 1: A(2页聚合) + B(1页) → 3 预览页，顺序 A-A-B', () => {
  const model = buildModelForFiles([A_P1, A_P2, B])

  assert.equal(model.valid, true)
  assert.equal(model.pages.length, 3, '总页数应为 3')

  // 顺序：前两页是 A（docA 前缀），最后一页是 B（docB）
  assert.ok(model.pages[0].slots[0].thumbnailUrl.includes('docA'), '第 1 页应为 A 的页')
  assert.ok(model.pages[1].slots[0].thumbnailUrl.includes('docA'), '第 2 页应为 A 的页')
  assert.ok(model.pages[2].slots[0].thumbnailUrl.includes('docB'), '第 3 页应为 B 的页')
})

// ── Case 2: A-2 — 第二页缩略图使用正确 page docId ──

test('Case 2 (Bug A-2): 聚合源第二页应使用 A_p2.docId?page=1', () => {
  const model = buildModelForFiles([A_P1, A_P2, B])

  // A 两页的 thumbnailUrl（按文件列表顺序展开，不排序）
  const aPages = model.pages.filter((p) => p.slots[0].thumbnailUrl.includes('docA'))
  assert.equal(aPages.length, 2)

  // 第一页：docA_p1?page=1
  assert.ok(aPages[0].slots[0].thumbnailUrl.includes('docA_p1') &&
             aPages[0].slots[0].thumbnailUrl.includes('?page=1'),
    'A 第1页应为 docA_p1?page=1，实得: ' + aPages[0].slots[0].thumbnailUrl)

  // 第二页：docA_p2?page=1（每个物理页文件都是单页，page 参数恒为 1）
  assert.ok(aPages[1].slots[0].thumbnailUrl.includes('docA_p2') &&
             aPages[1].slots[0].thumbnailUrl.includes('?page=1'),
    'A 第2页应为 docA_p2?page=1，实得: ' + aPages[1].slots[0].thumbnailUrl)
})

// ── Case 3: A-3a — currentSelection 解析 A_p1 → expandedPages[0] ──

test('Case 3 (Bug A-3a): currentSelection=A_p1.key → currentPageIndex=0', () => {
  const model = buildModelForFilesWithSelection(
    [A_P1, A_P2, B],
    { fileId: A_P1.key, pageIndex: A_P1.pageNum },
  )
  assert.equal(model.currentPageIndex, 0, 'A_p1 应对应 expandedPages[0]')
})

// ── Case 4: A-3a — currentSelection 解析 A_p2 → expandedPages[1] ──

test('Case 4 (Bug A-3a): currentSelection=A_p2.key → currentPageIndex=1', () => {
  const model = buildModelForFilesWithSelection(
    [A_P1, A_P2, B],
    { fileId: A_P2.key, pageIndex: A_P2.pageNum },
  )
  assert.equal(model.currentPageIndex, 1, 'A_p2 应对应 expandedPages[1]（不在 0）')
})

// ── Case 5: A-3a — currentSelection 解析 B → expandedPages[2] ──

test('Case 5 (Bug A-3a): currentSelection=B.key → currentPageIndex=2', () => {
  const model = buildModelForFilesWithSelection(
    [A_P1, A_P2, B],
    { fileId: B.key, pageIndex: B.pageNum ?? 0 },
  )
  assert.equal(model.currentPageIndex, 2, 'B 应对应 expandedPages[2]（非聚合文件保序可用）')
})

// ── Case 6: pageCount 分支未被破坏 ──

test('Case 6: 普通多页（pageCount 分支）单文件 3 页 → 3 预览页', () => {
  const multiFile = { key: 'M', docId: 'docM', pageCount: 3, totalPages: 3, name: 'M' }
  const plan = {
    pages: [{
      type: 'single', paper: { size: 'A4' }, orientation: 'portrait',
      slots: [{ fileId: 'M', contentRotation: 0, rotation: 0, placement: null }],
    }],
  }
  const model = buildPrintPreviewModel(plan, { files: [multiFile], settings: { paperSize: 'A4' }, backendUrl: '' })
  assert.equal(model.pages.length, 3, 'pageCount=3 应展开为 3 预览页')

  // 普通多页 fileId 不变，各页 page 参数 1/2/3
  for (let i = 0; i < 3; i++) {
    const slot = model.pages[i].slots[0]
    assert.equal(slot.fileId, 'M', `第${i + 1}页 fileId 应为 M`)
    assert.ok(slot.thumbnailUrl.includes(`docM?page=${i + 1}`),
      `第${i + 1}页缩略图应为 docM?page=${i + 1}，实得: ${slot.thumbnailUrl}`)
  }
})

// ── Case 7: 普通单页不变 ──

test('Case 7: 普通单页文件 → 保持 1 预览页', () => {
  const one = makePage({ key: 'X', sourceDocId: 'docX', pageNum: 0, totalPages: 1, docId: 'docX' })
  const model = buildModelForFiles([one])
  assert.equal(model.pages.length, 1)
  assert.ok(model.pages[0].slots[0].thumbnailUrl.includes('docX?page=1'))
})
