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
 *   - 页码控制（固定底部区域：上一页/页码指示器可输入跳转/下一页）
 *
 * @module components/PrintPreviewCanvas
 */

import { memo, useState, useEffect, useRef } from 'react'

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
 * 预览底部页码控制（固定区域，只关心页；样式参考展示区 .page-navigator）。
 *
 * 固定性（用户要求）：
 *   - 区域高度固定（.pcm-preview-nav-bar），单页/多页始终渲染，不塌陷不跳动；
 *   - 按钮尺寸统一 28px（page-nav-btn，不用 first/last 的 24px 变体），
 *     页码指示器 min-width 防抖（复用 page-nav-indicator 的 grid 布局）。
 */
const PreviewPageNav = ({ current, total, onPrev, onNext, onJump }) => {
  const [editing, setEditing] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef(null)

  const hasPrev = current > 0
  const hasNext = current < total - 1

  const startEdit = () => {
    setInputValue(String(current + 1))
    setEditing(true)
  }

  const commitEdit = () => {
    const page = parseInt(inputValue, 10)
    if (!isNaN(page) && page >= 1 && page <= total) {
      onJump?.(page - 1)
    }
    setEditing(false)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditing(false)
    }
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  return (
    <div className="pcm-preview-nav-bar" role="navigation" aria-label="页面导航">
      {/* 首页按钮 */}
      <button
        type="button"
        className="page-nav-btn page-nav-btn-first"
        onClick={() => onJump?.(0)}
        disabled={!hasPrev}
        aria-label="首页"
        title="首页"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M4 12V4M12 12L8 8L12 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* 上一页 */}
      <button
        type="button"
        className="page-nav-btn"
        onClick={onPrev}
        disabled={!hasPrev}
        aria-label="上一页"
        title="上一页 (←)"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      <span className="page-nav-indicator">
        {editing ? (
          <input
            ref={inputRef}
            className="page-nav-input"
            type="text"
            inputMode="numeric"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={handleKeyDown}
            onBlur={commitEdit}
            aria-label="输入页码"
          />
        ) : (
          <span
            className="page-nav-cur page-nav-clickable"
            onClick={startEdit}
            role="button"
            tabIndex={0}
            title="点击跳转页码"
          >
            {current + 1}
          </span>
        )}
        <span className="page-nav-sep">/</span>
        <span className="page-nav-total">{total}</span>
      </span>

      {/* 下一页 */}
      <button
        type="button"
        className="page-nav-btn"
        onClick={onNext}
        disabled={!hasNext}
        aria-label="下一页"
        title="下一页 (→)"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* 末页按钮 */}
      <button
        type="button"
        className="page-nav-btn page-nav-btn-last"
        onClick={() => onJump?.(total - 1)}
        disabled={!hasNext}
        aria-label="末页"
        title="末页"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M12 12V4M4 4L8 8L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </div>
  )
}

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
    // 无预览数据：优先展示模型 invalid 原因（如边距超出纸张尺寸）
    const reason = preview && !preview.valid ? preview.reason : null
    return (
      <div className="pcm-preview-placeholder-text" style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="var(--text-4)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: '8px', opacity: 0.6 }}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
        <p>{reason || '暂无预览数据'}</p>
        <span>{reason ? '请调整边距或纸张设置，确保打印内容有可用区域' : '请先选择纸张与合并模式'}</span>
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
    <div className="pcm-preview-stage">
      {/* 纸面区：占满 stage 剩余空间并居中（超高可滚动），高度随纸张方向变化
          但页码条在 stage 底部固定，不随纸面跳动 */}
      <div className="pcm-preview-page">
        {/* 纸面 SVG 直接渲染（无固定宽度内层；白纸/圆角/阴影由 .pcm-preview-page svg 提供，
            宽度撑满容器、高度按 viewBox 比例自适应，纸面可贴近 body 边缘出血） */}
        <svg
          viewBox={`0 0 ${widthMM} ${heightMM}`}
          width="100%"
          role="img"
          aria-label={`打印预览：${page.paper} ${ORIENT_LABEL[page.orientation] || ''} ${slotCount} 票`}
        >
          {/* 纸张背景（白底模拟纸面；viewBox 画布本身透明） */}
          <rect x="0" y="0" width={widthMM} height={heightMM} rx="1.5" fill="#fff" stroke="var(--border-light)" strokeWidth="0.6" />

          {/* 安全边距指示器（纯虚线边框，无底色填充） */}
          {hasMargins && (
            <rect
              x={margins.left || 0}
              y={margins.top || 0}
              width={Math.max(0, widthMM - (margins.left || 0) - (margins.right || 0))}
              height={Math.max(0, heightMM - (margins.top || 0) - (margins.bottom || 0))}
              fill="none"
              stroke="var(--accent)" strokeOpacity="0.35"
              strokeWidth="0.25"
              strokeDasharray="1 0.6"
            />
          )}

          {/* 发票缩略图槽位 */}
          {page.slots.map((slot, i) => (
            <SlotImage key={`${slot.fileId || 'slot'}-${slot.pageIndex}-${i}`} slot={slot} />
          ))}
        </svg>
      </div>

      {/* 页码控制（stage 底部固定：单页显示 1/1 禁用态，多页可翻页/输入跳转） */}
      <PreviewPageNav
        current={idx}
        total={total}
        onPrev={() => setCurrent(idx - 1)}
        onNext={() => setCurrent(idx + 1)}
        onJump={(p) => setCurrent(p)}
      />
    </div>
  )
})

export default PrintPreviewCanvas
