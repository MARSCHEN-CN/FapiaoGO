/**
 * OrientationFit Gate（Commit 2-H，2026-08-07）
 *
 * 锁定「横向纸型下 orientationFit 权限边界」：
 *   - orientationFit 仅作用于【竖向纸型】；横向纸型（landscape paperShape）下恒为 0。
 *   - 触发条件不是 paperShapeOrientation != paperOrientation，否则横纸+用户纵向会误补偿 -90。
 *
 * 矩阵（修复横纸 orientationFit 反相 bug）：
 *   | 内容 | 纸型  | 用户方向 | 期望 fitRotation |
 *   | 横票 | A4竖 | 纵向   | -90              |
 *   | 横票 | A4竖 | 横向   | 0                |
 *   | 横票 | 横纸  | 横向   | 0                |
 *   | 横票 | 横纸  | 纵向   | 0                |  ← 本次修复点
 *   | 竖票 | 横纸  | 横向   | 90（Stage1 保持） |
 *   | 竖票 | 横纸  | 纵向   | 90（Stage1 保持） |
 *
 * 前两个竖纸 case 必须保持现状（不动 Fit Engine）。
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

test('Gate-1 横票+A4竖+用户纵向 → fitRotation=-90（Stage1 生效，orientFit=0）', () => {
  const r = resolve(LAND_CONTENT, A4, 'portrait')
  assert.equal(r.shapeFitRotation, -90)
  assert.equal(r.orientationFitRotation, 0)
  assert.equal(r.fitRotation, -90)
})

test('Gate-2 横票+A4竖+用户横向 → fitRotation=0（Stage1+Stage2 抵消）', () => {
  const r = resolve(LAND_CONTENT, A4, 'landscape')
  assert.equal(r.shapeFitRotation, -90)
  assert.equal(r.orientationFitRotation, 90)
  assert.equal(r.fitRotation, 0)
})

test('Gate-3 横票+横纸+用户横向 → fitRotation=0（Stage1=0，orientFit 被横纸边界归零）', () => {
  const r = resolve(LAND_CONTENT, LAND, 'landscape')
  assert.equal(r.shapeFitRotation, 0)
  assert.equal(r.orientationFitRotation, 0)
  assert.equal(r.fitRotation, 0)
})

test('Gate-4 横票+横纸+用户纵向 → fitRotation=0（★修复点：orientFit 必须=0，不得补偿-90）', () => {
  const r = resolve(LAND_CONTENT, LAND, 'portrait')
  assert.equal(r.shapeFitRotation, 0)
  assert.equal(r.orientationFitRotation, 0)
  assert.equal(r.fitRotation, 0)
})

test('Gate-5 竖票+横纸+用户横向 → fitRotation=90（Stage1 保持，orientFit=0）', () => {
  const r = resolve(PORT_CONTENT, LAND, 'landscape')
  assert.equal(r.shapeFitRotation, 90)
  assert.equal(r.orientationFitRotation, 0)
  assert.equal(r.fitRotation, 90)
})

test('Gate-6 竖票+横纸+用户纵向 → fitRotation=90（Stage1 保持，orientFit=0，不影响竖票逻辑）', () => {
  const r = resolve(PORT_CONTENT, LAND, 'portrait')
  assert.equal(r.shapeFitRotation, 90)
  assert.equal(r.orientationFitRotation, 0)
  assert.equal(r.fitRotation, 90)
})

test('回归守卫：任意用户方向 + 横向纸型 → orientationFitRotation 恒为 0', () => {
  for (const orient of ['portrait', 'landscape']) {
    for (const content of [LAND_CONTENT, PORT_CONTENT]) {
      const r = resolve(content, LAND, orient)
      assert.equal(
        r.orientationFitRotation,
        0,
        `横纸+${orient}+${content.width > content.height ? '横票' : '竖票'} 应使 orientFit=0`,
      )
    }
  }
})

test('回归守卫：竖向纸型（A4）保持原有 orientFit 行为（不被横纸边界影响）', () => {
  const portrait = resolve(LAND_CONTENT, A4, 'portrait')
  assert.equal(portrait.orientationFitRotation, 0) // 横纸型逻辑不污染 A4
  const landscape = resolve(LAND_CONTENT, A4, 'landscape')
  assert.equal(landscape.orientationFitRotation, 90) // 横纸型逻辑不污染 A4
})
