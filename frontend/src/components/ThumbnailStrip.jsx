/**
 * ThumbnailStrip — 缩略图垂直边栏（左侧）
 *
 * 职责：
 *   垂直显示文档所有页面缩略图，支持点击切页。
 *   Lazy 加载：当前页 ± 5 页加载真实缩略图，其余 placeholder。
 *   当前页高亮 + 自动垂直滚动到可视区。
 *
 * 布局：左侧缩略图边栏（200px）+ 右侧主预览区（ViewerViewport）。
 *

 * @module components/ThumbnailStrip
 */

import React, { useRef, useEffect, useMemo, useCallback } from 'react'
import { ThumbnailItem } from './ThumbnailItem'
import { resolveThumbnailUrl } from '../utils/previewResourceResolver'

const LAZY_RANGE = 5 // 当前页 ± 5 页加载真实缩略图

/**
 * @param {Object} props
 * @param {import('../models/InvoiceDocument').InvoiceDocument|null} props.document - 文档模型
 * @param {number} props.currentPage - 当前页索引（0-based）
 * @param {(index: number) => void} props.onPageSelect - 切页回调
 */
export function ThumbnailStrip({ document, currentPage, onPageSelect }) {
  const stripRef = useRef(null)
  const itemRefs = useRef(new Map())

  // 文档无效或单页时不渲染缩略图栏
  if (!document || document.pageCount <= 1) return null

  // 计算每页的缩略图 URL（通过 PreviewResourceResolver）
  const thumbnailUrls = useMemo(() => {
    if (!document?.pages) return []
    return document.pages.map((page) => resolveThumbnailUrl(page, document.docId))
  }, [document])

  // 判断某页是否应加载（当前页 ± LAZY_RANGE）
  const shouldLoadPage = useCallback((index) => {
    return Math.abs(index - currentPage) <= LAZY_RANGE
  }, [currentPage])

  // 当前页变化时自动滚动到可视区
  useEffect(() => {
    const el = itemRefs.current.get(currentPage)
    if (el && stripRef.current) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [currentPage])

  const handlePageSelect = useCallback((index) => {
    onPageSelect?.(index)
  }, [onPageSelect])

  // 收集 ref 的回调
  const setItemRef = useCallback((index, el) => {
    if (el) {
      itemRefs.current.set(index, el)
    } else {
      itemRefs.current.delete(index)
    }
  }, [])

  return (
    <div className="viewer-thumbnail-sidebar" role="navigation" aria-label="页面缩略图">
      {/* 顶部标题栏 */}
      <div className="thumbnail-sidebar-header">
        <span className="thumbnail-sidebar-title">页面预览</span>
        <span className="thumbnail-sidebar-count">{document.pageCount}页</span>
      </div>
      <div className="viewer-thumbnail-list" ref={stripRef}>
        {document.pages.map((page, index) => (
          <div key={page.pageId} ref={(el) => setItemRef(index, el)}>
            <ThumbnailItem
              index={index}
              thumbnailUrl={thumbnailUrls[index]}
              active={index === currentPage}
              shouldLoad={shouldLoadPage(index)}
              onClick={handlePageSelect}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
