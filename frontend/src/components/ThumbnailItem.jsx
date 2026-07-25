/**
 * ThumbnailItem — 单个缩略图
 *
 * 职责：
 *   渲染单页缩略图，支持 lazy 加载（由父级 shouldLoad 控制）。
 *   根据页面真实宽高比展示缩略图（通过 aspectRatio prop）。
 *   未加载时显示灰色骨架 placeholder。
 *
 * 来源：13-C Viewer Layout 资产级迁移（left-thumbnail-layout）。
 *   aspectRatio 取自该分支；shouldLoad 懒加载门控取自 V16 HEAD 性能决策。
 *
 * @module components/ThumbnailItem
 */

import React, { useRef, useState, useEffect, memo } from 'react'

/**
 * @param {Object} props
 * @param {number} props.index - 页索引（0-based）
 * @param {string} props.thumbnailUrl - 缩略图 URL
 * @param {boolean} props.active - 是否当前页
 * @param {boolean} props.shouldLoad - 是否应加载（当前页±LAZY_RANGE，由 ThumbnailStrip 计算）
 * @param {number} [props.aspectRatio] - 页面宽高比（width/height），用于适配缩略图比例
 * @param {(index: number) => void} props.onClick - 点击回调
 */
function ThumbnailItemInner({ index, thumbnailUrl, active, shouldLoad, aspectRatio, onClick }) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const imgRef = useRef(null)

  // 重置状态当 URL 变化
  useEffect(() => {
    setLoaded(false)
    setError(false)
  }, [thumbnailUrl])

  const handleClick = () => {
    onClick?.(index)
  }

  return (
    <div
      className={`thumbnail-item${active ? ' thumbnail-item--active' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      aria-label={`第 ${index + 1} 页`}
      aria-current={active ? 'true' : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
    >
      <div className="thumbnail-frame" style={aspectRatio ? { aspectRatio: `${aspectRatio}` } : undefined}>
        {shouldLoad && thumbnailUrl && !error ? (
          <img
            ref={imgRef}
            src={thumbnailUrl}
            alt=""
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
            className={`thumbnail-img${loaded ? ' thumbnail-img--loaded' : ''}`}
          />
        ) : (
          <div className="thumbnail-placeholder" />
        )}
      </div>
      <span className="thumbnail-label">{index + 1}</span>
    </div>
  )
}

export const ThumbnailItem = memo(ThumbnailItemInner)
