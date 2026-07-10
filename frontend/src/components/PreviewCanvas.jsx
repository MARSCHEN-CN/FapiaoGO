import { useRef, useCallback, memo, useEffect } from 'react'

export default memo(function PreviewCanvas({ previewFile, displayInfo, previewCanvas, previewUrl, grayscale, previewRenderVersion }) {
  const canvasRef = useRef(null)
  const imgRef = useRef(null)

  // ⚠️ DIAGNOSTIC — 调试完删除。测量实际渲染尺寸，排查 data 正确但视觉异常的问题。
  useEffect(() => {
    if (window.__PREVIEW_DIAG__ && imgRef.current && displayInfo) {
      const img = imgRef.current
      const rect = img.getBoundingClientRect()
      console.log('[diag:canvas] img rendered', {
        src_tail: img.src.slice(-56),
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        clientWidth: img.clientWidth,
        clientHeight: img.clientHeight,
        boundingRect: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        parentRect: `${Math.round(img.parentElement?.getBoundingClientRect().width)}x${Math.round(img.parentElement?.getBoundingClientRect().height)}`,
        inlineStyle: img.style.cssText,
      })
    }
  }, [previewUrl, displayInfo])

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
    const tag = previewCanvas.__fileKey || 'SINGLETON'
    console.log('[DIAG] PreviewCanvas cb tag=', tag, 'v=', previewRenderVersion)
    // L1 命中：同一 DOM 节点 + 同 source canvas + 同滤镜 + 同版本 → 内容还在，跳过
    if (lastNodeRef.current === node &&
        lastSourceRef.current === previewCanvas &&
        lastGrayscaleRef.current === grayscale &&
        lastVersionRef.current === previewRenderVersion) {
      console.log('[DIAG] PreviewCanvas SKIP tag=', tag,
        'srcEq?', lastSourceRef.current === previewCanvas,
        'vEq?', lastVersionRef.current === previewRenderVersion)
      return
    }
    lastNodeRef.current = node
    lastSourceRef.current = previewCanvas
    lastGrayscaleRef.current = grayscale
    lastVersionRef.current = previewRenderVersion
    const ctx = node.getContext('2d')
    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height)
    ctx.filter = grayscale ? 'grayscale(100%)' : 'none'
    console.log('[DIAG] PreviewCanvas DREW tag=', tag, 'v=', previewRenderVersion)
    ctx.drawImage(previewCanvas, 0, 0)
  }, [previewCanvas, grayscale, previewRenderVersion])

  // ── Render Engine <img> 路径 ──
  if (previewUrl && displayInfo) {
    // ✅ 旋转走 CSS transform：容器尺寸已在 displayInfo 按旋转交换宽高，
    //    <img> 以自然显示尺寸绝对居中后 rotate，正好贴合包围盒（90/270 不裁切）
    const angle = displayInfo.angle || 0
    const swapped = displayInfo.swapped
    const imgW = swapped ? displayInfo.displayHeight : displayInfo.displayWidth
    const imgH = swapped ? displayInfo.displayWidth : displayInfo.displayHeight
    return (
      <div className="paper" style={{
        width: displayInfo.displayWidth,
        height: displayInfo.displayHeight,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // 移除 width/height transition：旋转时容器尺寸瞬变避免 overflow:hidden 中途裁剪，
        // 旋转动画完全由 <img> 的 transform transition 承担
      }}>
        <img
          ref={imgRef}
          src={previewUrl}
          alt=""
          draggable={false}
          loading="eager"
          decoding="async"
          style={{
            width: `${imgW}px`,
            height: `${imgH}px`,
            transform: `rotate(${angle}deg)`,
            transformOrigin: 'center center',
            objectFit: 'contain',
            transition: 'transform 0.2s ease',
            filter: grayscale ? 'grayscale(100%)' : 'none',
            flexShrink: 0,
          }}
        />
      </div>
    )
  }

  // ── 骨架屏：高清未就绪时显示纸张轮廓+加载态 ──
  //    不显示旧内容（无模糊/中间态），符合"始终高清"约束
  if (!displayInfo || !previewCanvas) {
    if (previewFile) {
      return (
        <div className="preview-skeleton">
          <div className="preview-skeleton-paper">
            <div className="preview-skeleton-shimmer" />
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
    </div>
  )
})
