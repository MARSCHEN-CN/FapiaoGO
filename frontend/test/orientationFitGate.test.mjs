/**
 * OrientationFit Gate（Commit 2-H v2，2026-08-07）
 *
 * 横向纸型 orientationFit 明确表（覆盖 0da69e1 的 blanket=0 过度屏蔽）：
 *   | 内容 | 纸型  | 用户方向 | orientationFit | fitRotation |
 *   | 横票 | 横纸  | 横向   | -90             | -90         |  ← 放倒到横向纸张坐标系
 *   | 横票 | 横纸  | 纵向   | 0               | 0           |
 *   | 横票 | A4竖 | 横向   | 90              | 0           |  ← 竖向纸型保持现状
 *   | 横票 | A4竖 | 纵向   | 0               | -90         |  ← 竖向纸型保持现状
 *   | 竖票 | 横纸  | 横向   | 0               | 90          |  ← 待现有规则（computeLayoutRotation）
 *   | 竖票 | 横纸  | 纵向   | -90             | 0           |  ← 待现有规则
 *   | 竖票 | A4竖 | 横向   | 90              | 90          |  ← 竖向纸型保持现状
 *   | 竖票 | A4竖 | 纵向   | 0               | 0           |  ← 竖向纸型保持现状
 *
 * 关键约束：竖向纸型(3/4/7/8)结果必须与上轮修复前完全一致；只修横向纸型(1/2/5/6)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveContentPlacement } from '../src/layout/RotationResolver.js'

const A4 = { widthMM: 210, heightMM: 297 }   // portrait 物理形状
const LAND = { widthMM: 297, heightMM: 210 } // landscape 物理形状
const LAND_CONTENT = { width: 1500, height: 1000 } // 横票
const PORT_CONTENT = { width: 1000, height: 1500 } // 竖票

function resolve(content, paper, orient) {
  return resolveContentPlacement({
    contentPhysicalSize: content,
    contentRotation: 0,
    paperSize: paper,
    paperOrientation: orient,
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
    dpi: 300,
  })
}

test('M1 横票+横纸+横向 → fitRotation=-90（orientationFit=-90，放倒到横向纸张坐标系）', () => {
  const r = resolve(LAND_CONTENT, LAND, 'landscape')
  assert.equal(r.shapeFitRotation, 0)
  assert.equal(r.orientationFitRotation, -90)
  assert.equal(r.fitRotation, -90)
})

test('M2 横票+横纸+纵向 → fitRotation=0（orientationFit=0，不旋转）', () => {
  const r = resolve(LAND_CONTENT, LAND, 'portrait')
  assert.equal(r.shapeFitRotation, 0)
  assert.equal(r.orientationFitRotation, 0)
  assert.equal(r.fitRotation, 0)
})

test('M3 横票+A4竖+横向 → fitRotation=0（竖向纸型保持现状：shapeFit=-90, orientFit=90）', () => {
  const r = resolve(LAND_CONTENT, A4, 'landscape')
  assert.equal(r.shapeFitRotation, -90)
  assert.equal(r.orientationFitRotation, 90)
  assert.equal(r.fitRotation, 0)
})

test('M4 横票+A4竖+纵向 → fitRotation=-90（竖向纸型保持现状：shapeFit=-90, orientFit=0）', () => {
  const r = resolve(LAND_CONTENT, A4, 'portrait')
  assert.equal(r.shapeFitRotation, -90)
  assert.equal(r.orientationFitRotation, 0)
  assert.equal(r.fitRotation, -90)
})

test('M5 竖票+横纸+横向 → fitRotation=90（待现有规则：shapeFit=90, orientFit=0）', () => {
  const r = resolve(PORT_CONTENT, LAND, 'landscape')
  assert.equal(r.shapeFitRotation, 90)
  assert.equal(r.orientationFitRotation, 0)
  assert.equal(r.fitRotation, 90)
})

test('M6 竖票+横纸+纵向 → fitRotation=0（待现有规则：shapeFit=90, orientFit=-90）', () => {
  const r = resolve(PORT_CONTENT, LAND, 'portrait')
  assert.equal(r.shapeFitRotation, 90)
  assert.equal(r.orientationFitRotation, -90)
  assert.equal(r.fitRotation, 0)
})

test('M7 竖票+A4竖+横向 → fitRotation=90（竖向纸型保持现状：shapeFit=0, orientFit=90）', () => {
  const r = resolve(PORT_CONTENT, A4, 'landscape')
  assert.equal(r.shapeFitRotation, 0)
  assert.equal(r.orientationFitRotation, 90)
  assert.equal(r.fitRotation, 90)
})

test('M8 竖票+A4竖+纵向 → fitRotation=0（竖向纸型保持现状：shapeFit=0, orientFit=0）', () => {
  const r = resolve(PORT_CONTENT, A4, 'portrait')
  assert.equal(r.shapeFitRotation, 0)
  assert.equal(r.orientationFitRotation, 0)
  assert.equal(r.fitRotation, 0)
})

test('回归守卫：横向纸型 orientationFit 精确匹配明确表（无 blanket 屏蔽）', () => {
  const table = {
    'landscape|landscape': -90,
    'landscape|portrait': 0,
    'portrait|landscape': 0,
    'portrait|portrait': -90,
  }
  for (const [content, paper] of [[LAND_CONTENT, LAND], [PORT_CONTENT, LAND]]) {
    const co = content.width > content.height ? 'landscape' : 'portrait'
    for (const orient of ['landscape', 'portrait']) {
      const r = resolve(content, paper, orient)
      assert.equal(
        r.orientationFitRotation,
        table[`${co}|${orient}`],
        `横纸+${co}+${orient} 应匹配明确表`,
      )
    }
  }
})

test('回归守卫：竖向纸型(A4) orientationFit 行为与横向纸型修正前完全一致', () => {
  // 竖向纸型不走明确表，仍用原 computeLayoutRotation(paperShape=portrait, paperOrientation)
  const portrait = resolve(LAND_CONTENT, A4, 'portrait')
  assert.equal(portrait.orientationFitRotation, 0) // 横票+A4竖+纵
  const landscape = resolve(LAND_CONTENT, A4, 'landscape')
  assert.equal(landscape.orientationFitRotation, 90) // 横票+A4竖+横
  const keep1 = resolve(PORT_CONTENT, A4, 'portrait')
  assert.equal(keep1.orientationFitRotation, 0) // 竖票+A4竖+纵
  const keep2 = resolve(PORT_CONTENT, A4, 'landscape')
  assert.equal(keep2.orientationFitRotation, 90) // 竖票+A4竖+横
})
