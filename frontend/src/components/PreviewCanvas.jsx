import { useRef, useCallback, memo } from 'react'

export default memo(function PreviewCanvas({ previewFile, displayInfo, previewCanvas, grayscale, previewRenderVersion }) {
  const canvasRef = useRef(null)

  // ✅ L1 缓存：跟踪 DOM canvas 上次绘制的内容
  //    仅当同一 DOM canvas + 同 source canvas + 同滤镜 + 同版本时跳过重绘
  const lastNodeRef = useRef(null)
  const lastSourceRef = useRef(null)
  const lastGrayscaleRef = useRef(null)
  const lastVersionRef = useRef(null)

  // ✅ 唯一的重绘入口：callback ref 在挂载和 re-render（ref identity 变化）时都会触发
  const canvasCallbackRef = useCallback((node) => {
    canvasRef.current = node
    if (!node || !previewCanvas) return
    // L1 命中：同一 DOM 节点 + 同 source canvas + 同滤镜 + 同版本 → 内容还在，跳过
    if (lastNodeRef.current === node &&
        lastSourceRef.current === previewCanvas &&
        lastGrayscaleRef.current === grayscale &&
        lastVersionRef.current === previewRenderVersion) return
    lastNodeRef.current = node
    lastSourceRef.current = previewCanvas
    lastGrayscaleRef.current = grayscale
    lastVersionRef.current = previewRenderVersion
    const ctx = node.getContext('2d')
    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height)
    ctx.filter = grayscale ? 'grayscale(100%)' : 'none'
    ctx.drawImage(previewCanvas, 0, 0)
  }, [previewCanvas, grayscale, previewRenderVersion])

  // ── 骨架屏：高清未就绪时显示纸张轮廓+加载态 ──
  //    不显示旧内容（无模糊/中间态），符合"始终高清"约束
  if (!displayInfo || !previewCanvas) {
    if (previewFile) {
      return (
        <div className="preview-skeleton">
          <div className="preview-skeleton-paper">
            <div className="preview-skeleton-shimmer" />
            <div className="preview-skeleton-loader">
              <div className="ps-loader-dots">
                <span className="ps-dot" />
                <span className="ps-dot" />
                <span className="ps-dot" />
              </div>
              <span className="ps-loader-text">高清渲染中</span>
            </div>
          </div>
        </div>
      )
    }
    return null
  }

  return (
    <div className="paper" style={{
      width: displayInfo.displayWidth,
      height: displayInfo.displayHeight,
      transition: 'width 0.2s ease, height 0.2s ease',
    }}>
      <canvas
        ref={canvasCallbackRef}
        width={previewCanvas.width}
        height={previewCanvas.height}
        style={{
          width: '100%',
          height: '100%',
          imageRendering: 'crisp-edges',
        }}
      />
    </div>
  )
})
