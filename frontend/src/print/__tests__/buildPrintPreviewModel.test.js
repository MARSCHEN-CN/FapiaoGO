/**
 * buildPrintPreviewModel.test — 聚合 source 预览展开回归测试
 *
 * 测试目标（Bug A）：
 *   同票多页发票（如 A 两页 + B 一页）导入后，打印预览总页数应 = 3，
 *   但此前 buildPrintPreviewModel 的「聚合 source → 物理预览页展开」只读
 *   f.pageCount（聚合 source 默认恒为 1），导致 A 被塌缩为 1 页，最终只显示 2。
 *
 *   真实物理页数由 normalizePrintSources 写入的 _aggregatedPageCount 表达，
 *   因此展开应优先读该字段。
 *
 * 设计原则：
 *   - 走真实管线 createPrintPlanInput → buildPrintExecutionPlan → buildPrintPreviewModel，
 *     保证 slot.fileId ↔ file.key ↔ _aggregatedPageCount 的接线与生产一致（不手搓 plan）。
 *   - 纯 node（node:test），不依赖 vite / config.js（backendUrl 注入 ''）。
 *   - 不验证几何/placement，只验证「页数聚合正确性」这唯一的被修复维度。
 *
 * @module print/__tests__/buildPrintPreviewModel
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrintPreviewModel } from '../PrintPreviewModel.js'
import { createPrintPlanInput, buildPrintExecutionPlan } from '../buildPrintExecutionPlan.js'

// 与 normalizePrintSources 分组要求对齐的最小 mock 页级文件。
// 关键：拆分页默认 pageCount=1（buildFileObj 默认），不设置真正的多页计数 —— 这正是 Bug 根源。
function makePage({ key, instanceId = '', sourceDocId, pageNum = 0, totalPages = 1, docId, printPath = '/p', name }) {
  return {
    key,
    instanceId,
    sourceDocId,
    pageNum,
    totalPages,
    docId,
    printPath,
    fileFormat: 'pdf',
    status: 'parsed',
    name: name || key,
    pageCount: 1,
  }
}

// 用真实管线构造 plan + files，忠实复刻用户导入场景
function buildModelForFiles(rawFiles, settings = { paperSize: 'A4' }) {
  const { files, options } = createPrintPlanInput(rawFiles, { landscape: false, ...settings })
  const plan = buildPrintExecutionPlan(files, options)
  return buildPrintPreviewModel(plan, { files, settings, backendUrl: '' })
}

test('Bug A: A(2页聚合源) + B(1页) 应展开为 3 预览页', () => {
  const files = [
    makePage({ key: 'A_p1', instanceId: 'inst-A', sourceDocId: 'docA', pageNum: 0, totalPages: 2, docId: 'docA', name: 'A-1' }),
    makePage({ key: 'A_p2', instanceId: 'inst-A', sourceDocId: 'docA', pageNum: 1, totalPages: 2, docId: 'docA', name: 'A-2' }),
    makePage({ key: 'B', sourceDocId: 'docB', pageNum: 0, totalPages: 1, docId: 'docB', name: 'B' }),
  ]
  const model = buildModelForFiles(files)

  assert.equal(model.valid, true, '预览模型应有效')
  assert.equal(model.pages.length, 3, 'A(2页)+B(1页) 应展开为 3 预览页，实得: ' + model.pages.length)

  const aPages = model.pages.filter((p) => p.slots[0].fileId.startsWith('__source_'))
  const bPages = model.pages.filter((p) => p.slots[0].fileId === 'B')
  assert.equal(aPages.length, 2, '聚合 source A 应展开为 2 预览页')
  assert.equal(bPages.length, 1, 'B 应保持 1 预览页')

  // A 两页对应 page=1 / page=2（后端缩略图端点 page 参数 1-based）
  const aUrls = aPages.map((p) => p.slots[0].thumbnailUrl).sort()
  assert.ok(aUrls[0].includes('docA?page=1'), 'A 第1页缩略图应为 page=1，实得: ' + aUrls[0])
  assert.ok(aUrls[1].includes('docA?page=2'), 'A 第2页缩略图应为 page=2，实得: ' + aUrls[1])
  assert.ok(bPages[0].slots[0].thumbnailUrl.includes('docB?page=1'), 'B 缩略图应为 page=1')
})

test('普通单页文件 → 保持 1 预览页（不变）', () => {
  const files = [makePage({ key: 'B', sourceDocId: 'docB', pageNum: 0, totalPages: 1, docId: 'docB' })]
  const model = buildModelForFiles(files)
  assert.equal(model.pages.length, 1, '单页文件应仍为 1 预览页')
  assert.ok(model.pages[0].slots[0].thumbnailUrl.includes('docB?page=1'))
})

test('普通多页（pageCount 分支）保持不变：单文件 3 页应展开为 3', () => {
  // 直接构造未聚合的单文件对象（带 pageCount:3），验证 || pageCount 兜底仍生效，
  // 确保修复不会破坏原本依赖 pageCount 的展开路径。
  const multiFile = { key: 'M', docId: 'docM', pageCount: 3, totalPages: 3, name: 'M' }
  const plan = {
    pages: [{
      type: 'single',
      paper: { size: 'A4' },
      orientation: 'portrait',
      slots: [{ fileId: 'M', contentRotation: 0, rotation: 0, placement: null }],
    }],
  }
  const model = buildPrintPreviewModel(plan, { files: [multiFile], settings: { paperSize: 'A4' }, backendUrl: '' })
  assert.equal(model.pages.length, 3, 'pageCount=3 的单文件应展开为 3 预览页（pageCount 分支保持）')
})
