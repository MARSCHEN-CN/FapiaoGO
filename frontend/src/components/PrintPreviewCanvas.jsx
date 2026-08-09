/**
 * PrintPreviewCanvas — 打印确认弹窗的「打印布局预览」
 *
 * 消费 buildPrintPreviewModel 的输出：
 *   { valid, currentPageIndex, pages: [{ paper, orientation, paperSizeMM,
 *     slots: [{ x, y, width, height, source, rotation, contentRotation, fitRotation,
 *              placement, thumbnailUrl, fileId, pageIndex }] }] }
 *
 * 渲染内容：
 *   - 纸张轮廓（SVG viewBox = mm，1:1 无换算误差）
 *   - 安全边距可视化（虚线框 + 边距值）
 *   - 发票缩略图（<image> 元素）
 *   - 页码控制（固定底部区域：上一页/页码指示器可输入跳转/下一页）
 *
 * Commit 2-A→2-C（旋转架构迁移）：
 *   - 已删除 CSS transform:rotate() —— 旋转语义上移到 RotationResolver。
 *   - 缩略图直接填充槽位区域，不再自行计算旋转前 bounding box。
 *   - slot._deprecatedRotation 保留为 deprecated alias（= contentRotation + fitRotation），勿消费。
 *   - Commit 2-F-1：只消费 placement.renderTransformMM（mm 坐标系），Canvas 永不感知 DPI。
 *     原始 px 字段（renderTransform）仅供打印/导出，预览禁止消费。
 *
 * @module components/PrintPreviewCanvas
 */

import { memo, useState, useEffect, useRef } from 'react'

const ORIENT_LABEL = { portrait: '纵向', landscape: '横向' }

/**
 * 单个发票缩略图槽位渲染（内部组件，方便管理加载状态）
 * 纯内容：缩略图 + 槽位边框；不叠加任何标签/序号信息（打印预览 = 现实打印内容）。
 *
 * Commit 2-B→2-F-1: 消费 placement.renderTransformMM（PrintPreviewModel 已做 px→mm 隔离，mm 坐标系）。
 *   translate(ox,oy) → 定位到纸面坐标（mm）
 *   scale(s)         → fit 缩放（无量纲）
 *   rotate(deg,cx,cy)→ 绕内容中心旋转（cx/cy 为 mm）
 *   无 placement 时 fallback 到 slot fill（文件无尺寸数据时，slot.x/y/w/h 已是 mm）。
 */
const SlotImage = memo(({ slot }) => {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const imgRef = useRef(null)
  const loadedRef = useRef(false)
  const errorRef = useRef(false)

  // Keep refs in sync with state (for rAF closure capture)
  useEffect(() => { loadedRef.current = loaded }, [loaded])
  useEffect(() => { errorRef.current = error }, [error])

  // BugB fix (A+B): 快速切页/切方向时 thumbnailUrl 变化，React 复用同一 SVG <image>
  // 节点、仅改 href 属性 → Chromium 不可靠重发 fetch → onLoad 永不触发 → 内容 opacity:0。
  // A: 给 <image> 加 key={thumbnailUrl} 强制 remount，保证新节点新 href 必发请求；
  // B: 通过 ref 原生 addEventListener 监听 load/error（绕过 React 合成事件在
  //    disk-cache/webp 场下的时序丢失）；另加 rAF 兜底缓存瞬时命中。
  useEffect(() => {
    setLoaded(false)
    setError(false)
    const el = imgRef.current
    if (!el) return

    const onLoad = () => { console.log('[DIAG-15 thumb natural] loaded via native listener'); setLoaded(true) }
    const onError = () => { setError(true) }

    el.addEventListener('load', onLoad)
    el.addEventListener('error', onError)

    // rAF 兜底：disk cache 可能在 addEventListener 之前就已 resolve
    const id = requestAnimationFrame(() => {
      // SVGImageElement 无 .complete/.naturalWidth（那是 HTMLImageElement 的），
      // 所以用「已注册 listener 但未触发」作为缓存命中信号
      if (!loadedRef.current && !errorRef.current) {
        // 请求已返回 200（Network 面板可证）但 load 事件丢失 → 直接标记可见
        setLoaded(true)
      }
    })

    return () => {
      el.removeEventListener('load', onLoad)
      el.removeEventListener('error', onError)
      cancelAnimationFrame(id)
    }
  }, [slot.thumbnailUrl])

  const hasThumbnail = !!slot.thumbnailUrl && !error
  // Commit 2-F-1：只消费 mm 坐标系的 renderTransformMM，Canvas 不感知 DPI。
  const t = slot.placement?.renderTransformMM

  // 三段式 SVG transform 字符串（Commit 2-B）
  const svgTransform = t
    ? `translate(${t.translateX},${t.translateY}) scale(${t.scale}) rotate(${t.rotationDeg},${t.rotationCx},${t.rotationCy})`
    : null

  // [DIAG-13] SVG renderTransform 消费（无条件：rotationDeg=0 也打印，便于确认无旋转分支）
  if (t) {
    console.log('[DIAG-13 slotImage SVG] rotationDeg=%d svgTransform=%s slotRotation=%d',
      t.rotationDeg, svgTransform, slot._deprecatedRotation)
  }

  return (
    <g>
      {/* 槽位边框：纸张布局（始终在 slot.x/y/w/h，不受内容旋转影响） */}
      <rect
        x={slot.x} y={slot.y} width={slot.width} height={slot.height}
        rx="0.8" fill="none"
        stroke="var(--accent)" strokeOpacity="0.5" strokeWidth="0.3"
      />

      {t ? (
        /* Commit 2-B: renderTransform 管控内容放置 */
        <g transform={svgTransform}>
          {hasThumbnail ? (
            <>
              <image
                key={slot.thumbnailUrl}
                ref={imgRef}
                href={slot.thumbnailUrl}
                x="0"
                y="0"
                width={t.contentBoxWidth}
                height={t.contentBoxHeight}
                preserveAspectRatio="none"
                style={{
                  opacity: loaded ? 1 : 0,
                  transition: 'opacity 0.2s ease-in',
                }}
                onLoad={(e) => {
                  setLoaded(true)
                  const nw = e?.target?.naturalWidth, nh = e?.target?.naturalHeight
                  if (nw && nh) console.log('[DIAG-15 thumb natural] w=%d h=%d fileKey=%s', nw, nh, (slot.fileId || '').slice(-20))
                }}
                onError={() => {
                  console.warn('[PrintPreviewCanvas] 缩略图加载失败:', slot.source)
                  setError(true)
                }}
              />
              {!loaded && (
                <rect
                  x="0" y="0" width={t.contentBoxWidth} height={t.contentBoxHeight}
                  fill="var(--accent-soft)" fillOpacity="0.3"
                  rx="0.5"
                />
              )}
            </>
          ) : (
            <rect
              x="0" y="0" width={t.contentBoxWidth} height={t.contentBoxHeight}
              fill="var(--accent-soft)" fillOpacity="0.2"
              rx="0.5"
            />
          )}
        </g>
      ) : (
        /* fallback：无 placement 时直接填充槽位（文件无尺寸数据） */
        <>
          {hasThumbnail ? (
            <>
              <image
                key={slot.thumbnailUrl}
                ref={imgRef}
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
        </>
      )}
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
  const initialized = useRef(false)

  const pages = preview && preview.valid ? preview.pages : []
  const total = pages.length

  // Bug A-3b: 模型重建时（如切换纸张方向）保留用户当前预览页，
  // 不无条件回退到 preview.currentPageIndex（后者固定于初始 previewFile）。
  // 仅首次有效模型加载时同步；后续重建若当前页在新 page 范围内则保持，否则 fallback。
  useEffect(() => {
    if (preview?.valid && total > 0) {
      if (!initialized.current) {
        // 首次进入预览：从模型定位（previewFile 决定的 currentSelection）
        setCurrent(Math.min(preview.currentPageIndex, total - 1))
        initialized.current = true
      } else {
        // 纸张/合并模式切换重建：保持用户翻到的当前页
        setCurrent((prev) => {
          if (prev >= 0 && prev < total) return prev
          return Math.min(preview.currentPageIndex, total - 1)
        })
      }
    } else {
      setCurrent(0)
      initialized.current = false
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
          aria-label={`打印预览：${page.paper} ${ORIENT_LABEL[page.requestedPaperOrientation] || ''} ${slotCount} 票`}
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
