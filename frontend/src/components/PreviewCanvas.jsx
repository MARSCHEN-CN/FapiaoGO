import { useRef, useCallback, memo } from 'react'

export default memo(function PreviewCanvas({ previewFile, displayInfo, previewCanvas, grayscale }) {
  const canvasRef = useRef(null)

  // ✅ L1 缓存：跟踪 DOM canvas 上次绘制的内容，同 canvas 再次展示时跳过 drawImage
  //    切回已预览文件时 DOM 缓冲未清空，直接跳过可节省 5~15ms pixel copy
  const lastDrawnRef = useRef(null)
  const lastGrayscaleRef = useRef(null)

  // ✅ 唯一的重绘入口：callback ref 在挂载和 re-render（ref identity 变化）时都会触发
  //    移除冗余的 useEffect，避免同一帧内两次 drawImage（~35MB pixel copy x2）
  const canvasCallbackRef = useCallback((node) => {
    canvasRef.current = node
    if (!node || !previewCanvas) return
    // L1 命中：同 canvas + 同滤镜 → DOM canvas 已有正确内容，跳过重绘
    if (lastDrawnRef.current === previewCanvas && lastGrayscaleRef.current === grayscale) return
    lastDrawnRef.current = previewCanvas
    lastGrayscaleRef.current = grayscale
    const ctx = node.getContext('2d')
    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height)
    ctx.filter = grayscale ? 'grayscale(100%)' : 'none'
    ctx.drawImage(previewCanvas, 0, 0)
  }, [previewCanvas, grayscale])

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
