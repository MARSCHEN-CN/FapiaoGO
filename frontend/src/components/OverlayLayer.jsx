/**
 * OverlayLayer — OCR / 字段 / 搜索高亮覆盖层
 *
 * 职责：
 *   在 Viewer 图片之上渲染归一化坐标的 Overlay 框。
 *   与 <img> 共享同一个 transform wrapper，一起 scale/rotate/translate。
 *   纯 DOM 渲染，零重绘（图像是固定 raster，不因 overlay 重渲染）。
 *
 * 坐标契约（来自 image-viewer-plan.md §4）：
 *   OverlayBox 的 x/y/w/h 是归一化坐标（0..1），相对 natural image。
 *   OverlayLayer 负责 × naturalSize 转换为像素定位。
 *
 * 后端契约（R1）：
 *   raster 与 OCR 必须基于同一张位图（同 crop、同分辨率）。
 *   后端 bbox_data 已满足此契约。
 *
 * Architecture Law D1：
 *   Overlay 只消费归一化坐标，不碰纸张/边距/打印。
 *
 * @module components/OverlayLayer
 */

import React, { memo } from 'react'

/**
 * @typedef {Object} OverlayBox
 * @property {string} id - 唯一标识
 * @property {number} x - 归一化 x（0..1，相对 natural image 左上角）
 * @property {number} y - 归一化 y（0..1）
 * @property {number} w - 归一化宽度（0..1）
 * @property {number} h - 归一化高度（0..1）
 * @property {'ocr'|'field'|'search'|'redaction'} kind - 类型
 * @property {string} [label] - 显示标签
 * @property {*} [payload] - 附加数据
 */

const KIND_STYLES = {
  ocr: { borderColor: 'rgba(74, 144, 217, 0.6)', bgColor: 'rgba(74, 144, 217, 0.08)' },
  field: { borderColor: 'rgba(82, 196, 26, 0.7)', bgColor: 'rgba(82, 196, 26, 0.1)' },
  search: { borderColor: 'rgba(250, 173, 20, 0.8)', bgColor: 'rgba(250, 173, 20, 0.15)' },
  redaction: { borderColor: 'rgba(0, 0, 0, 0.8)', bgColor: 'rgba(0, 0, 0, 0.9)' },
}

/**
 * @param {Object} props
 * @param {OverlayBox[]} props.boxes - Overlay 框数组
 * @param {number} props.naturalWidth - 图片自然宽度（px）
 * @param {number} props.naturalHeight - 图片自然高度（px）
 * @param {boolean} [props.visible=true] - 是否显示
 * @param {(box: OverlayBox) => void} [props.onBoxClick] - 点击框回调
 * @param {string|null} [props.activeBoxId] - 当前高亮的框 ID
 */
function OverlayLayerInner({ boxes, naturalWidth, naturalHeight, visible = true, onBoxClick, activeBoxId }) {
  if (!visible || !boxes || boxes.length === 0) return null
  if (!naturalWidth || !naturalHeight) return null

  return (
    <div className="overlay-layer" aria-hidden="true">
      {boxes.map((box) => {
        const style = KIND_STYLES[box.kind] || KIND_STYLES.ocr
        const isActive = box.id === activeBoxId

        return (
          <div
            key={box.id}
            className={`overlay-box overlay-box--${box.kind}${isActive ? ' overlay-box--active' : ''}`}
            style={{
              left: `${box.x * naturalWidth}px`,
              top: `${box.y * naturalHeight}px`,
              width: `${box.w * naturalWidth}px`,
              height: `${box.h * naturalHeight}px`,
              borderColor: style.borderColor,
              backgroundColor: isActive ? style.bgColor.replace(/[\d.]+\)$/, '0.25)') : style.bgColor,
            }}
            onClick={(e) => {
              e.stopPropagation()
              onBoxClick?.(box)
            }}
            title={box.label || ''}
          >
            {box.label && (
              <span className="overlay-box-label">{box.label}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

export const OverlayLayer = memo(OverlayLayerInner)

/**
 * 从后端 bbox_data 转换为 OverlayBox[]。
 *
 * 后端 bbox_data 格式（预期）：
 *   [{ field: 'invoiceNumber', bbox: [x0, y0, x1, y1], page: 0 }]
 *   其中 bbox 是像素坐标，需要归一化。
 *
 * @param {Array} bboxData - 后端 bbox_data 数组
 * @param {number} imgWidth - 图片自然宽度
 * @param {number} imgHeight - 图片自然高度
 * @param {number} [pageIndex=0] - 当前页索引（只取该页的框）
 * @returns {OverlayBox[]}
 */
export function bboxDataToOverlayBoxes(bboxData, imgWidth, imgHeight, pageIndex = 0) {
  if (!bboxData || !Array.isArray(bboxData) || !imgWidth || !imgHeight) return []

  return bboxData
    .filter((item) => (item.page ?? 0) === pageIndex)
    .map((item, idx) => {
      const [x0, y0, x1, y1] = item.bbox || [0, 0, 0, 0]
      return {
        id: `bbox_${item.field || idx}_${pageIndex}`,
        x: x0 / imgWidth,
        y: y0 / imgHeight,
        w: (x1 - x0) / imgWidth,
        h: (y1 - y0) / imgHeight,
        kind: 'field',
        label: item.field || '',
        payload: item,
      }
    })
    .filter((box) => box.w > 0 && box.h > 0)
}
