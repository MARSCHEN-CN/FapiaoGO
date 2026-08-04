/**
 * PrintPreviewCanvas — 打印确认弹窗的「打印布局预览」（Phase 3.5 Preview Skeleton）
 *
 * 消费 buildPrintPreviewModel 的输出（{ valid, pages: [{ paper, orientation, paperSizeMM,
 * slots: [{ x, y, width, height, source, rotation }] }] }），只画：
 *   - 纸张比例（paperSizeMM → SVG viewBox，mm 即坐标，1:1 无换算误差）
 *   - 票据槽位框（slot rect，虚线 + 序号 + 来源文件名）
 *   - 页导航（上一页 / 下一页 / 第 x 页 / 共 n 页）
 *
 * 冻结边界（Phase 3.5）：
 *   - **不渲染 PDF 像素 / 不调 /thumbnail / 不接 PDF.js**——本组件只呈现「打印后纸张怎么摆」，
 *     内容渲染留给 A3-C5 通过后的 Phase 4（届时把 slot rect 替换为真实渲染位）。
 *   - 无数据 / 无效 → 简单占位，不显示假发票 SVG（旧静态占位已移除）。
 *
 * @module components/PrintPreviewCanvas
 */

import { memo, useState } from 'react'

const ORIENT_LABEL = { portrait: '纵向', landscape: '横向' }

const PrintPreviewCanvas = memo(({ preview }) => {
  const [current, setCurrent] = useState(0)

  const pages = preview && preview.valid ? preview.pages : []
  const total = pages.length
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
  const tag = `${page.paper} · ${ORIENT_LABEL[page.orientation] || page.orientation} · ${slotCount} 票`

  return (
    <div className="pcm-preview-page" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="pcm-preview-page-inner" style={{ flex: 1, minHeight: 0 }}>
        <svg
          viewBox={`0 0 ${widthMM} ${heightMM}`}
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`打印预览：${page.paper} ${ORIENT_LABEL[page.orientation] || ''} ${slotCount} 票`}
        >
          {/* 纸张轮廓（浅底 + 细描边） */}
          <rect x="0" y="0" width={widthMM} height={heightMM} rx="1.5" fill="#fff" stroke="var(--border-light)" strokeWidth="0.6" />
          {/* 槽位框（虚线，浅色填充，含序号） */}
          {page.slots.map((slot, i) => (
            <g key={i}>
              <rect
                x={slot.x} y={slot.y} width={slot.width} height={slot.height}
                rx="0.8" fill="var(--accent-soft)" fillOpacity="0.25"
                stroke="var(--accent)" strokeOpacity="0.55" strokeWidth="0.35" strokeDasharray="1.6 1.2"
              />
              <text
                x={slot.x + slot.width / 2} y={slot.y + slot.height / 2}
                textAnchor="middle" dominantBaseline="central"
                fontSize="4" fontWeight="600" fill="var(--accent)" fillOpacity="0.8"
              >
                {i + 1}
              </text>
              {slot.rotation !== 0 && (
                <text
                  x={slot.x + 1.2} y={slot.y + slot.height - 1.2}
                  fontSize="2.2" fill="var(--text-4)"
                >
                  ⟳{slot.rotation}°
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>

      {/* 页信息 + 来源清单 + 导航 */}
      <div className="pcm-preview-page-tag" style={{ marginTop: '6px' }}>
        {tag} · 第 {idx + 1} 页 / 共 {total} 页
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-4)', lineHeight: 1.5, minHeight: '22px' }}>
        {page.slots.map((s, i) => (
          <span key={i} style={{ marginRight: '10px', whiteSpace: 'nowrap' }}>
            {i + 1}. {s.source}{s.rotation !== 0 ? `（转${s.rotation}°）` : ''}
          </span>
        ))}
      </div>
      {total > 1 && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
          <button
            type="button"
            className="pcm-btn pcm-btn-cancel"
            style={{ padding: '2px 10px', fontSize: '12px' }}
            disabled={idx === 0}
            onClick={() => setCurrent(idx - 1)}
          >
            上一页
          </button>
          <button
            type="button"
            className="pcm-btn pcm-btn-confirm"
            style={{ padding: '2px 10px', fontSize: '12px' }}
            disabled={idx >= total - 1}
            onClick={() => setCurrent(idx + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  )
})

export default PrintPreviewCanvas
