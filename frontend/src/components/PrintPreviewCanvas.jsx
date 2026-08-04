/**
 * PrintPreviewCanvas — 打印确认弹窗的「打印布局预览」
 *
 * 消费 buildPrintPreviewModel 的输出：
 *   { valid, currentPageIndex, pages: [{ paper, orientation, paperSizeMM,
 *     slots: [{ x, y, width, height, source, rotation, thumbnailUrl, fileId, pageIndex }] }] }
 *
 * 渲染内容：
 *   - 纸张轮廓（SVG viewBox = mm，1:1 无换算误差）
 *   - 安全边距可视化（虚线框 + 边距值）
 *   - 发票缩略图（<image> 元素，支持旋转 transform）
 *   - 页码导航（复用展示区 PageNavigator：首页/上页/跳转/下页/末页）
 *
 * @module components/PrintPreviewCanvas
 */

import { memo, useState, useEffect } from 'react'
import { PageNavigator } from './PageNavigator'

const ORIENT_LABEL = { portrait: '纵向', landscape: '横向' }

/**
 * 单个发票缩略图槽位渲染（内部组件，方便管理加载状态）
 * 纯内容：缩略图 + 槽位边框；不叠加任何标签/序号信息（打印预览 = 现实打印内容）。
 */
const SlotImage = memo(({ slot }) => {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    setLoaded(false)
    setError(false)
  }, [slot.thumbnailUrl])

  const cx = slot.x + slot.width / 2
  const cy = slot.y + slot.height / 2
  const transform = slot.rotation
    ? `rotate(${slot.rotation} ${cx} ${cy})`
    : undefined

  const hasThumbnail = !!slot.thumbnailUrl && !error

  return (
    <g transform={transform}>
      {hasThumbnail ? (
        <>
          <image
            href={slot.thumbnailUrl}
            x={slot.x}
            y={slot.y}
            width={slot.width}
            height={slot.height}
            preserveAspectRatio="xMidYMid meet"
            style={{
              opacity: loaded ? 1 : 0,
              transition: 'opacity 0.2s ease-in',
            }}
            onLoad={() => setLoaded(true)}
            onError={() => {
              console.warn('[PrintPreviewCanvas] 缩略图加载失败:', slot.source)
              setError(true)
            }}
          />
          {!loaded && (
            <rect
              x={slot.x} y={slot.y} width={slot.width} height={slot.height}
              fill="var(--accent-soft)" fillOpacity="0.3"
              rx="0.5"
            />
          )}
        </>
      ) : (
        <rect
          x={slot.x} y={slot.y} width={slot.width} height={slot.height}
          fill="var(--accent-soft)" fillOpacity="0.2"
          rx="0.5"
        />
      )}

      {/* 槽位边框 */}
      <rect
        x={slot.x} y={slot.y} width={slot.width} height={slot.height}
        rx="0.8" fill="none"
        stroke="var(--accent)" strokeOpacity="0.5" strokeWidth="0.3"
      />
    </g>
  )
})

/**
 * 主预览画布
 */
const PrintPreviewCanvas = memo(({ preview, marginSettings }) => {
  const [current, setCurrent] = useState(0)

  const pages = preview && preview.valid ? preview.pages : []
  const total = pages.length

  // 当 preview 模型变化时（如纸张/合并模式切换），同步到目标页
  useEffect(() => {
    if (preview?.valid && typeof preview.currentPageIndex === 'number') {
      setCurrent(Math.min(preview.currentPageIndex, total - 1))
    } else {
      setCurrent(0)
    }
  }, [preview, total])

  if (total === 0) {
    return (
      <div className="pcm-preview-placeholder-text" style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="var(--text-4)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: '8px', opacity: 0.6 }}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
        <p>暂无预览数据</p>
        <span>请先选择纸张与合并模式</span>
      </div>
    )
  }

  const idx = Math.min(Math.max(current, 0), total - 1)
  const page = pages[idx]
  const { widthMM, heightMM } = page.paperSizeMM
  const slotCount = page.slots.length

  const margins = marginSettings || {}
  const hasMargins = margins.left > 0 || margins.right > 0 || margins.top > 0 || margins.bottom > 0

  return (
    <div className="pcm-preview-page">
      {/* 纸面 SVG 直接渲染（无固定宽度内层；白纸/圆角/阴影由 .pcm-preview-page svg 提供，
          宽度撑满容器、高度按 viewBox 比例自适应，纸面可贴近 body 边缘出血） */}
      <svg
        viewBox={`0 0 ${widthMM} ${heightMM}`}
        width="100%"
        role="img"
        aria-label={`打印预览：${page.paper} ${ORIENT_LABEL[page.orientation] || ''} ${slotCount} 票`}
      >
        {/* 纸张轮廓（无底色：viewBox 透明，纯粹显示打印内容 + 安全边距线条） */}
        <rect x="0" y="0" width={widthMM} height={heightMM} rx="1.5" fill="none" stroke="var(--border-light)" strokeWidth="0.6" />

        {/* 安全边距可视化 */}
        {hasMargins && (
          <rect
            x={margins.left || 0}
            y={margins.top || 0}
            width={Math.max(0, widthMM - (margins.left || 0) - (margins.right || 0))}
            height={Math.max(0, heightMM - (margins.top || 0) - (margins.bottom || 0))}
            fill="var(--accent)" fillOpacity="0.03"
            stroke="var(--accent)" strokeOpacity="0.25"
            strokeWidth="0.2"
            strokeDasharray="0.8 0.6"
          />
        )}

        {/* 边距标注 */}
        {hasMargins && (
          <>
            {margins.top > 0 && (
              <text x={widthMM / 2} y={(margins.top || 0) / 2 + 1} fontSize="2" fill="var(--text-3)" fillOpacity="0.6" textAnchor="middle">
                ↑{margins.top}mm
              </text>
            )}
            {margins.bottom > 0 && (
              <text x={widthMM / 2} y={heightMM - (margins.bottom || 0) / 2} fontSize="2" fill="var(--text-3)" fillOpacity="0.6" textAnchor="middle">
                ↓{margins.bottom}mm
              </text>
            )}
            {margins.left > 0 && (
              <text x={(margins.left || 0) / 2 + 1} y={heightMM / 2} fontSize="2" fill="var(--text-3)" fillOpacity="0.6" textAnchor="middle"
                transform={`rotate(-90 ${(margins.left || 0) / 2 + 1} ${heightMM / 2})`}>
                ←{margins.left}mm
              </text>
            )}
            {margins.right > 0 && (
              <text x={widthMM - (margins.right || 0) / 2} y={heightMM / 2} fontSize="2" fill="var(--text-3)" fillOpacity="0.6" textAnchor="middle"
                transform={`rotate(90 ${widthMM - (margins.right || 0) / 2} ${heightMM / 2})`}>
                {margins.right}mm→
              </text>
            )}
          </>
        )}

        {/* 发票缩略图槽位 */}
        {page.slots.map((slot, i) => (
          <SlotImage key={`${slot.fileId || 'slot'}-${slot.pageIndex}-${i}`} slot={slot} />
        ))}
      </svg>

      {/* 页码导航（多页时显示；复用展示区 PageNavigator，0-based 接口一致） */}
      {total > 1 && (
        <PageNavigator
          className="pcm-preview-navigator"
          currentPage={idx}
          totalPages={total}
          onPrev={() => setCurrent(idx - 1)}
          onNext={() => setCurrent(idx + 1)}
          onJump={(p) => setCurrent(p)}
        />
      )}
    </div>
  )
})

export default PrintPreviewCanvas
