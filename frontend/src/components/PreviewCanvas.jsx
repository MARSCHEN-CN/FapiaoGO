import { useRef, useCallback, memo, useEffect } from 'react'

export default memo(function PreviewCanvas({ previewFile, previewCanvas, previewUrl, grayscale, previewRenderVersion, paperLayout, contentLayout, previewRotation, previewLoading }) {
  const canvasRef = useRef(null)
  const imgRef = useRef(null)

  // ── 容器尺寸：从 ContentLayout.paperDisplayRect 读取（含 zoom），fallback PaperLayout ──
  const containerW = contentLayout?.paperDisplayRect?.w || paperLayout?.displayRect?.w || 0
  const containerH = contentLayout?.paperDisplayRect?.h || paperLayout?.displayRect?.h || 0
  const contentReady = contentLayout?.ready
  const imgRect = contentLayout?.imageRect

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
        lastVersionRef.current === previewRenderVersion) {
      return
    }
    lastNodeRef.current = node
    lastSourceRef.current = previewCanvas
    lastGrayscaleRef.current = grayscale
    lastVersionRef.current = previewRenderVersion
    const ctx = node.getContext('2d')
    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height)
    ctx.filter = grayscale ? 'grayscale(100%)' : 'none'
    ctx.drawImage(previewCanvas, 0, 0)
  }, [previewCanvas, grayscale, previewRenderVersion])

  // ── Render Engine <img> 路径 ──
  if (previewUrl && contentReady && containerW > 0) {
    // 🆕 V17：RE 已按 paperLandscape 输出正确方向图，内容永远 natural，无需 CSS rotate。
    // 容器方向由 usePreview 依 paperLandscape 计算（containerW/H 已是有效纸张尺寸），
    // 此处 <img> 直接以容器尺寸 contain 显示，彻底移除 rotate/swap/angle。
    return (
      <div className="paper" style={{
        width: containerW,
        height: containerH,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <img
          ref={imgRef}
          src={previewUrl}
          alt=""
          draggable={false}
          loading="eager"
          decoding="async"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            filter: grayscale ? 'grayscale(100%)' : 'none',
            flexShrink: 0,
          }}
        />
        {/* ✅ Stage 0.8：加载中 overlay，叠在已提交的旧帧之上，pointer-events:none 不拦截交互 */}
        {previewLoading && (
          <div className="preview-loading-overlay" aria-hidden="true">
            <span className="plo-spinner" />
          </div>
        )}
      </div>
    )
  }

  // ── 骨架屏：高清未就绪时显示纸张轮廓+加载态 ──
  if (!contentReady || !previewCanvas) {
    if (previewFile && containerW > 0) {
      return (
        <div className="preview-skeleton">
          <div className="preview-skeleton-paper" style={{ width: containerW, height: containerH }}>
            <div className="preview-skeleton-shimmer" />
          </div>
        </div>
      )
    }
    return null
  }

  return (
    <div className="paper" style={{
      width: containerW,
      height: containerH,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
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
      {/* ✅ Stage 0.8：加载中 overlay，叠在已提交的旧帧之上，pointer-events:none 不拦截交互 */}
      {previewLoading && (
        <div className="preview-loading-overlay" aria-hidden="true">
          <span className="plo-spinner" />
        </div>
      )}
    </div>
  )
})
