/**
 * DevDocumentViewerDemo — 展示区改造 Mock E2E 验证页
 *
 * 职责：
 *   用 mock 3页 Document 验证 Document/Page/Viewer 三层闭环。
 *   开发阶段使用，不进入生产构建。
 *
 * 验收清单：
 *   1. 打开第一页，底部横向显示3个缩略图
 *   2. 点击第二页，主图切换
 *   3. page1 zoom 200% + rotate 90° → 点击 page2 → zoom reset, pan reset, rotation=90 保留
 *   4. Ctrl+wheel 连续缩放正常
 *   5. 拖拽 pan 正常，边界 clamp 正常
 *   6. 双击恢复 fit
 *
 * 使用方式：
 *   在 App.jsx 中临时渲染 <DevDocumentViewerDemo />（或通过 URL ?dev=viewer 触发）
 *
 * @module components/DevDocumentViewerDemo
 */

import React, { useState, useRef, useEffect } from 'react'
import { ViewerViewport } from './ViewerViewport'
import { useViewerState } from '../hooks/useViewerState'
import { createDocument, createPageMeta, getPage } from '../models/InvoiceDocument'
import './DocumentViewer.css'

// ─── Mock Data ───
const MOCK_DOC_ID = 'test-3page'

const mockDocument = createDocument({
  docId: MOCK_DOC_ID,
  fileKey: 'dev-demo-file',
  sourceHash: 'mock-hash-000',
  pages: [
    createPageMeta({ docId: MOCK_DOC_ID, index: 0, width: 2480, height: 3508, sourceRotation: 0 }),
    createPageMeta({ docId: MOCK_DOC_ID, index: 1, width: 2480, height: 3508, sourceRotation: 0 }),
    createPageMeta({ docId: MOCK_DOC_ID, index: 2, width: 2480, height: 3508, sourceRotation: 0 }),
  ],
})

// Mock PreviewResourceResolver：返回本地 SVG 测试图
// 覆盖真实 resolver，避免依赖后端
const MOCK_URLS = [
  '/test/page1.svg',
  '/test/page2.svg',
  '/test/page3.svg',
]

/**
 * DevDocumentViewerDemo
 *
 * 独立渲染 DocumentViewer，使用 mock 数据。
 * 包含状态面板显示当前 ViewerState（zoom/pan/rotation/page）。
 */
export function DevDocumentViewerDemo() {
  const containerRef = useRef(null)
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 })

  // 测量容器尺寸
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      setContainerSize({ width, height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#f5f5f5' }}>
      {/* 标题栏 */}
      <div style={{
        padding: '8px 16px',
        background: '#1a1a2e',
        color: '#fff',
        fontSize: 13,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}>
        <strong>Display Refactor — Mock E2E</strong>
        <span style={{ opacity: 0.6 }}>docId: {MOCK_DOC_ID} | 3 pages | 2480×3508</span>
        <span style={{ opacity: 0.4, marginLeft: 'auto' }}>
          验收: 翻页/zoom/rotate/缩略图/pan/clamp
        </span>
      </div>

      {/* Viewer 区域 */}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <MockDocumentViewer
          document={mockDocument}
          containerSize={containerSize}
          mockUrls={MOCK_URLS}
        />
      </div>
    </div>
  )
}

/**
 * 内部 Viewer 包装：覆盖 previewUrl 为 mock SVG 路径。
 * 直接使用 useViewerState + ViewerViewport 组合，
 * 绕过 PreviewResourceResolver（因为 mock 不走后端）。
 */
function MockDocumentViewer({ document, containerSize, mockUrls }) {
  const { state, actions } = useViewerState({ document, containerSize })
  const currentPage = getPage(document, state.currentPage)
  const previewUrl = mockUrls[state.currentPage] || null

  return (
    <div className="document-viewer" style={{ height: '100%' }}>
      {/* 主视口（上方） */}
      <div className="document-viewer-main">
        <ViewerViewport
          page={currentPage}
          previewUrl={previewUrl}
          zoom={state.zoom}
          panX={state.panX}
          panY={state.panY}
          viewRotation={state.viewRotation}
          containerSize={containerSize}
          grayscale={false}
          loading={false}
          onWheelZoom={actions.wheelZoom}
          onPanChange={actions.setPan}
          onDoubleClick={actions.setFit}
        />

        {/* 页码指示器 */}
        <div className="document-viewer-page-indicator">
          {state.currentPage + 1} / {document.pageCount}
        </div>

        {/* 状态面板 */}
        <div style={{
          position: 'absolute',
          top: 8,
          left: 8,
          padding: '6px 10px',
          background: 'rgba(0,0,0,0.75)',
          color: '#0f0',
          fontSize: 11,
          fontFamily: 'monospace',
          borderRadius: 4,
          lineHeight: 1.6,
          zIndex: 100,
          pointerEvents: 'none',
        }}>
          <div>page: {state.currentPage}</div>
          <div>zoom: {state.zoom.toFixed(1)}%</div>
          <div>pan: ({state.panX.toFixed(0)}, {state.panY.toFixed(0)})</div>
          <div>viewRotation: {state.viewRotation}°</div>
          <div>effective: {((currentPage?.sourceRotation || 0) + state.viewRotation) % 360}°</div>
        </div>
      </div>

      {/* 缩略图横向导航栏（底部） */}
      <MockThumbnailStrip
        document={document}
        currentPage={state.currentPage}
        onPageSelect={actions.goToPage}
        mockUrls={mockUrls}
      />
    </div>
  )
}

/**
 * Mock 缩略图栏：使用本地 SVG 而非后端 URL。
 */
function MockThumbnailStrip({ document, currentPage, onPageSelect, mockUrls }) {
  if (!document || document.pageCount <= 1) return null

  return (
    <div className="viewer-thumbnail-bar" role="navigation" aria-label="页面缩略图">
      <div className="viewer-thumbnail-list">
        {document.pages.map((page, index) => (
          <div
            key={page.pageId}
            className={`thumbnail-item${index === currentPage ? ' thumbnail-item--active' : ''}`}
            onClick={() => onPageSelect(index)}
            role="button"
            tabIndex={0}
            aria-label={`第 ${index + 1} 页`}
          >
            <div className="thumbnail-frame">
              <img
                src={mockUrls[index]}
                alt=""
                draggable={false}
                className="thumbnail-img thumbnail-img--loaded"
              />
            </div>
            <span className="thumbnail-label">{index + 1}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
