import { useRef, useCallback, memo, useEffect } from 'react'

export default memo(function PreviewCanvas({ previewFile, previewCanvas, previewUrl, grayscale, previewRenderVersion, paperLayout, contentLayout, previewRotation }) {
  const canvasRef = useRef(null)
  const imgRef = useRef(null)

  // ── 容器尺寸：从 ContentLayout.paperDisplayRect 读取（含 zoom），fallback PaperLayout ──
  const containerW = contentLayout?.paperDisplayRect?.w || paperLayout?.displayRect?.w || 0
  const containerH = contentLayout?.paperDisplayRect?.h || paperLayout?.displayRect?.h || 0
  const contentReady = contentLayout?.ready
  const imgRect = contentLayout?.imageRect

  // ⚠️ DIAGNOSTIC — 调试完删除。测量实际渲染尺寸，排查 data 正确但视觉异常的问题。
  useEffect(() => {
    if (window.__PREVIEW_DIAG__ && imgRef.current) {
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
  }, [previewUrl, contentLayout])

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
  if (previewUrl && contentReady && containerW > 0) {
    // 旋转走 CSS transform：容器尺寸从 PaperLayout 取（交换后的宽高），
    // <img> 以自然显示尺寸绝对居中后 rotate，贴合包围盒
    const angle = (previewRotation || 0) % 360
    const swapped = (angle % 180 !== 0)
    const imgW = swapped ? containerH : containerW
    const imgH = swapped ? containerW : containerH
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
    </div>
  )
})
