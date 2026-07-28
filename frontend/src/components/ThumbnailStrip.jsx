/**
 * ThumbnailStrip — 缩略图垂直边栏（左侧）
 *
 * 职责：
 *   垂直显示文档所有页面缩略图，支持点击切页。
 *   性能：当前页 ± LAZY_RANGE 页加载真实缩略图，其余灰色骨架
 *   （企业发票场景：30/100/300 页，避免一次性拉取全部栅格）。
 *   当前页高亮 + 自动垂直滚动到可视区。
 *
 * 布局：左侧缩略图边栏（120px）+ 右侧主预览区（ViewerViewport）。
 *
 * 来源：13-C Viewer Layout 从 left-thumbnail-layout 资产级迁移。
 *   左栏结构取自该分支；lazy 加载（±5）取自 V16 HEAD 既有性能决策，
 *   二者合并，不恢复其旧 print / 旧 base64 预览图路径。
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

  // 计算每页的缩略图 URL（通过 PreviewResourceResolver）
  const thumbnailUrls = useMemo(() => {
    if (!document?.pages) return []
    return document.pages.map((page) => resolveThumbnailUrl(page, document.docId))
  }, [document])

  // 计算每页的宽高比（用于缩略图动态 aspect-ratio）
  const aspectRatios = useMemo(() => {
    if (!document?.pages) return []
    return document.pages.map((page) => {
      if (page.width && page.height) return page.width / page.height
      return null
    })
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

  // 文档无效或单页时不渲染缩略图栏。
  // ⚠️ 必须在所有 hooks 之后执行：多页↔单页切换时若提前 return，
  // 本次 render 的 hooks 数量会少于上次，React 报 "Rendered fewer hooks than expected"。
  if (!document || document.pageCount <= 1) return null

  return (
    <div className="viewer-thumbnail-sidebar" role="navigation" aria-label="页面缩略图">
      <div className="viewer-thumbnail-list" ref={stripRef}>
        {document.pages.map((page, index) => (
          <div key={page.pageId} ref={(el) => setItemRef(index, el)}>
            <ThumbnailItem
              index={index}
              thumbnailUrl={thumbnailUrls[index]}
              active={index === currentPage}
              shouldLoad={shouldLoadPage(index)}
              aspectRatio={aspectRatios[index]}
              onClick={handlePageSelect}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
