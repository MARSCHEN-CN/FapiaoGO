/**
 * PageNavigator — 底部页码控制栏
 *
 * 职责（单一）：
 *   显示当前页/总页数，提供翻页导航和快速跳转。
 *   支持：首页/末页、上一页/下一页、点击页码直接跳转。
 *
 * Architecture Law D1：
 *   PageNavigator 是纯导航控件，与 ViewerViewport 完全平级分离。
 *   展示区布局结构：
 *
 *     DocumentViewer
 *         |
 *         +-- ViewerViewport（flex: 1，占满）
 *         |
 *         +-- PageNavigator（固定高度，底部）
 *
 * @module components/PageNavigator
 */

import React, { memo, useState, useRef, useCallback, useEffect } from 'react'

/**
 * @param {Object} props
 * @param {number} props.currentPage - 当前页 index（0-based）
 * @param {number} props.totalPages - 总页数
 * @param {() => void} props.onPrev - 上一页
 * @param {() => void} props.onNext - 下一页
 * @param {(page: number) => void} props.onJump - 跳转到指定页（0-based）
 * @param {string} [props.className] - 覆盖默认定位类 'page-navigator'（absolute 居中）。
 *   容器内嵌使用（如打印预览）时传入自定义类，如 'pcm-preview-navigator'（static 流式布局）。
 */
export const PageNavigator = memo(function PageNavigator({
  currentPage,
  totalPages,
  onPrev,
  onNext,
  onJump,
  className,
}) {
  const [editing, setEditing] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const inputRef = useRef(null)

  const hasPrev = currentPage > 0
  const hasNext = currentPage < totalPages - 1

  const handleFirst = useCallback(() => {
    if (currentPage > 0) onJump?.(0)
  }, [currentPage, onJump])

  const handleLast = useCallback(() => {
    if (currentPage < totalPages - 1) onJump?.(totalPages - 1)
  }, [currentPage, totalPages, onJump])

  const handlePrev = useCallback(() => {
    if (currentPage > 0) onPrev?.()
  }, [currentPage, onPrev])

  const handleNext = useCallback(() => {
    if (currentPage < totalPages - 1) onNext?.()
  }, [currentPage, totalPages, onNext])

  const startEdit = useCallback(() => {
    setInputValue(String(currentPage + 1))
    setEditing(true)
  }, [currentPage])

  const commitEdit = useCallback(() => {
    const page = parseInt(inputValue, 10)
    if (!isNaN(page) && page >= 1 && page <= totalPages) {
      onJump?.(page - 1)
    }
    setEditing(false)
  }, [inputValue, totalPages, onJump])

  const cancelEdit = useCallback(() => {
    setEditing(false)
  }, [])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    }
  }, [commitEdit, cancelEdit])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  if (totalPages <= 1) return null

  return (
    <div className={className || 'page-navigator'} role="navigation" aria-label="页面导航">
      {/* 首页按钮 */}
      <button
        className="page-nav-btn page-nav-btn-first"
        onClick={handleFirst}
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
        className="page-nav-btn"
        onClick={handlePrev}
        disabled={!hasPrev}
        aria-label="上一页"
        title="上一页 (←)"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* 页码指示器 - 可点击跳转 */}
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
            {currentPage + 1}
          </span>
        )}
        <span className="page-nav-sep">/</span>
        <span className="page-nav-total">{totalPages}</span>
      </span>

      {/* 下一页 */}
      <button
        className="page-nav-btn"
        onClick={handleNext}
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
        className="page-nav-btn page-nav-btn-last"
        onClick={handleLast}
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
})
