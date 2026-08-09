/**
 * useViewerState — Document Viewer 交互状态机
 *
 * 职责：
 *   管理 Viewer 的全部交互状态：currentPage / zoom / pan / viewRotation。
 *   提供离散/连续缩放、平移、旋转、翻页 actions。
 *   页切换时 reset zoom+pan，保留 viewRotation（document 级全局）。
 *
 * 所有权：
 *   由 DocumentViewer 组件调用。
 *   不依赖 usePreview / PreviewCanvas / 打印模块。
 *
 * Architecture Law D1：
 *   viewRotation 是用户临时查看旋转，与 PageMeta.sourceRotation 分离。
 *   effectiveRotation = sourceRotation + viewRotation。
 *
 * @module hooks/useViewerState
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { nextZoomStep } from './zoomStep.mjs'
import { applyWheelZoom } from './continuousZoom.mjs'
import { clampPan, computeFitScale, rotatedDimensions } from '../utils/viewerTransform'
import { effectiveRotation } from '../models/InvoiceDocument'

const ZOOM_STEPS = [25, 50, 75, 100, 125, 150, 200]
const ZOOM_MIN = 10
const ZOOM_MAX = 500

// D2-3：manual 模式的绝对 scale 夹取边界（渲染比例，非 fit 相对百分比）。
// 0.02 ≈ 自然尺寸的 2%，20 ≈ 2000%，覆盖从极小到极大的手动缩放。
const SCALE_MIN = 0.02
const SCALE_MAX = 20

/**
 * @typedef {Object} ViewerState
 * @property {number} currentPage - 当前显示页 index（0-based）
 * @property {number} zoom - ⚠️ legacy：fit 相对百分比（100=fit），仅供 dev demo 旧路径，新路径用 mode/scale
 * @property {'fit'|'manual'} mode - D2-3：缩放参考系。fit=渲染 scale 由 viewport 实时派生；manual=冻结绝对 scale
 * @property {number|null} scale - D2-3：manual 模式的绝对渲染 scale；fit 模式为 null
 * @property {number} fitScale - D2-4：authoritative fit scale（ViewerViewport 上抬，D2-1 唯一尺寸源）
 * @property {number} zoomPercent - D2-4：fit 相对缩放百分比（fit→100，manual→round(scale/fitScale×100)），供 ZoomToolbar 显示
 * @property {number} panX - 水平平移（px）
 * @property {number} panY - 垂直平移（px）
 * @property {number} viewRotation - 用户临时旋转（0/90/180/270）
 */

/**
 * @typedef {Object} ViewerActions
 * @property {() => void} zoomIn - D2-4：离散放大一档（nextZoomStep，fit→125；100≡fit）
 * @property {() => void} zoomOut - D2-4：离散缩小一档（落到 100 时回 fit 模式）
 * @property {(pct: number) => void} setScalePreset - D2-4：下拉档位直选（fit 相对百分比，100→fit，其余→manual）
 * @property {(fitScale: number) => void} reportFitScale - D2-4：ViewerViewport 上抬 authoritative fit scale
 * @property {() => void} setFit - ⚠️ legacy：适应窗口（zoom=100），供 dev demo 旧路径
 * @property {(scale: number) => void} enterManual - D2-3：进入 manual 模式并冻结绝对 scale（保留 pan）
 * @property {(scale: number) => void} setManualScale - D2-3：设置 manual 绝对 scale（语义同 enterManual）
 * @property {() => void} setFitMode - D2-3：回到 fit 模式（scale=null，pan 归零）
 * @property {(deltaY: number) => void} wheelZoom - 连续滚轮缩放
 * @property {() => void} rotateLeft - 逆时针旋转 90°
 * @property {() => void} rotateRight - 顺时针旋转 90°
 * @property {(index: number) => void} goToPage - 跳转到指定页
 * @property {() => void} nextPage - 下一页
 * @property {() => void} prevPage - 上一页
 * @property {(panX: number, panY: number) => void} setPan - 设置平移
 * @property {(deltaX: number, deltaY: number) => void} panBy - 增量平移
 * @property {() => void} resetView - 重置 zoom+pan（保留 viewRotation）
 * @property {() => void} resetForDocument - 6B-1.1：换文档（document.id 变化）时重置整个阅读环境
 *   （page=0 / mode=fit / zoom=100 / rotation=0 / pan=0,0）。与 goToPage 的区别：
 *   goToPage 保留 zoom/mode/rotation（同票连续阅读），resetForDocument 全部回默认（新文档从头开始）。
 */

/**
 * Document Viewer 交互状态 hook。
 *
 * @param {Object} opts
 * @param {import('../models/InvoiceDocument').InvoiceDocument|null} opts.document - 当前文档
 * @param {{ width: number, height: number }} opts.containerSize - 视口容器尺寸
 * @param {number} [opts.initialPage=0] - 初始页 index（0-based，来自 fileObj.pageNum - 1）
 * @returns {{ state: ViewerState, actions: ViewerActions }}
 */
export function useViewerState({ document, containerSize, initialPage = 0, contentRotation }) {
  // Architecture Law D1：容错 null document（双 Buffer 文件切换期间）。
  // max 为 0 时 currentPage clamp 到 0，后续 document 就绪后由 goToPageRef 导航。
  const [currentPage, setCurrentPage] = useState(() => {
    const max = document ? document.pageCount - 1 : 0
    return Math.min(max, Math.max(0, initialPage))
  })
  const [zoom, setZoom] = useState(100)
  // D2-3：fit/manual 缩放参考系分离。
  //   mode='fit'    → 渲染 scale 由 viewport 实时 fit 计算派生，scale 为 null。
  //   mode='manual' → 渲染 scale = 用户冻结的绝对 scale（resize 不重算，只 re-clamp pan）。
  const [mode, setMode] = useState('fit')
  const [scale, setScale] = useState(null)
  // D2-4：authoritative fit scale，由 ViewerViewport 经 reportFitScale 上抬（D2-1 唯一尺寸源）。
  // 供离散档位缩放换算 step↔绝对 scale，及 fit 相对显示 zoomPercent 派生。
  const [fitScale, setFitScale] = useState(0)
  const [panX, setPanX] = useState(0)
  const [panY, setPanY] = useState(0)
  const [viewRotation, setViewRotation] = useState(0)

  // Commit 3 fix: 同步 fileRotations[fileKey] → Viewer viewRotation
  useEffect(() => {
    const cr = contentRotation ?? 0
    setViewRotation(cr)
  }, [contentRotation])

  // 用 ref 追踪容器尺寸，避免闭包陈旧
  const containerRef = useRef(containerSize)
  containerRef.current = containerSize

  // 当前页 PageMeta
  const page = document?.pages?.[currentPage] || null

  // 计算当前页有效尺寸（考虑旋转）
  const getPageDimensions = useCallback(() => {
    if (!page) return { width: 0, height: 0 }
    const effRotation = effectiveRotation(page, viewRotation)
    return rotatedDimensions(page.width || 0, page.height || 0, effRotation)
  }, [page, viewRotation])

  // ─── D2-4：authoritative fit scale 上抬 ───
  // ViewerViewport 把 measuredSize 派生的 fit scale 上报到此（D2-1 唯一尺寸源）。
  // reportFitScale 带相等短路，避免 fitScale 未变时触发重渲染（防 ViewerViewport↔hook 循环）。
  const reportFitScale = useCallback((fs) => {
    setFitScale((prev) => (prev === fs ? prev : fs))
  }, [])

  // ─── D2-3：fit/manual 参考系分离 actions ───

  // 进入 manual 模式并冻结绝对 scale（Ctrl+wheel 触发）。
  // 保留 pan：滚轮缩放不应让视图跳位，只改变比例。
  const enterManual = useCallback((nextScale) => {
    const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, nextScale))
    setMode('manual')
    setScale(clamped)
  }, [])

  // 设置 manual 绝对 scale（已在 manual 模式时的后续调整，语义同 enterManual）。
  // ⚠️ D2-3 起为绝对 scale 语义（旧版为 zoom 百分比，无消费方，已替换）。
  const setManualScale = useCallback((nextScale) => {
    const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, nextScale))
    setMode('manual')
    setScale(clamped)
  }, [])

  // 回到 fit 模式（双击适应触发）：scale 派生回 null，pan 归零。
  const setFitMode = useCallback(() => {
    setMode('fit')
    setScale(null)
    setPanX(0)
    setPanY(0)
  }, [])

  // ─── 6B-1：Fit Width / Actual Size 模式 ───
  // Fit Width（适应宽度）：横向铺满视口（scale = viewportW / pageW），
  // 高度超出部分靠 pan/拖拽查看（ViewerViewport 实时派生 fitWidthScale）。
  const setFitWidth = useCallback(() => {
    setMode('fitWidth')
    setScale(null)
    setPanX(0)
    setPanY(0)
  }, [])

  // Actual Size（实际大小）：100% = 原始像素（renderScale = 1）。
  // PageMeta.width/height 为 img 自然像素（handleNaturalSize 回填），
  // scale=1 时 wrapper = 自然像素 → 1 CSS px = 1 render px（150dpi WebP）。
  const setActual = useCallback(() => {
    setMode('actual')
    setScale(null)
    setPanX(0)
    setPanY(0)
  }, [])

  // ─── D2-4：离散档位缩放（toolbar +/−/下拉）───

  // 当前 fit 相对档位（供 ZoomToolbar 显示 + 档位高亮 + nextZoomStep 起点）：
  //   fit 模式 → 100（≡ 自适应基准）；manual → round(scale/fitScale×100)。
  //   fitScale 缺失（≤0，尺寸未知）回退 100，避免除零。
  const zoomPercent = (mode === 'manual' && scale != null && fitScale > 0)
    ? Math.round((scale / fitScale) * 100)
    : 100

  // 应用离散档位：100 ≡ Actual Size（6B-1 语义：100% = 原始像素，非 fit）；
  // 其余 → manual 绝对 scale = fitScale × step/100。fit 仅由 setFitMode（自适应按钮/双击）。
  // 离散缩放重置 pan（沿用 legacy UX，与 wheel 保留 pan 区分）；fitScale 缺失时无法换算，忽略。
  const applyZoomStep = useCallback((step) => {
    if (step === 100) {
      setActual()
      return
    }
    if (fitScale <= 0) return
    const absScale = fitScale * (step / 100)
    const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, absScale))
    setMode('manual')
    setScale(clamped)
    setPanX(0)
    setPanY(0)
  }, [fitScale, setActual])

  const zoomIn = useCallback(() => {
    applyZoomStep(nextZoomStep(zoomPercent, 'in', ZOOM_STEPS))
  }, [applyZoomStep, zoomPercent])

  const zoomOut = useCallback(() => {
    applyZoomStep(nextZoomStep(zoomPercent, 'out', ZOOM_STEPS))
  }, [applyZoomStep, zoomPercent])

  // 下拉档位直选：pct 为 fit 相对百分比（∈ ZOOM_STEPS）。100 → fit，其余 → manual。
  // 取代旧 setManualScale(绝对 scale) 的误用风险（下拉传百分比，旧语义会 clamp 到 SCALE_MAX）。
  const setScalePreset = useCallback((pct) => {
    applyZoomStep(pct)
  }, [applyZoomStep])

  // ─── legacy zoom actions（仅供 DevDemo 旧 zoom 模型，Step 13 随 PreviewCanvas 移除）───

  const setFit = useCallback(() => {
    setZoom(100)
    setPanX(0)
    setPanY(0)
  }, [])

  const wheelZoom = useCallback((deltaY) => {
    setZoom((z) => applyWheelZoom(z, deltaY, { min: ZOOM_MIN, max: ZOOM_MAX }))
  }, [])

  // ─── Rotation Actions ───

  const rotateLeft = useCallback(() => {
    setViewRotation((r) => (r + 270) % 360)
    setPanX(0)
    setPanY(0)
  }, [])

  const rotateRight = useCallback(() => {
    setViewRotation((r) => (r + 90) % 360)
    setPanX(0)
    setPanY(0)
  }, [])

  // ─── Page Navigation ───

  const goToPage = useCallback((index) => {
    if (!document || document.pageCount <= 0) return
    const clamped = Math.min(document.pageCount - 1, Math.max(0, index))
    setCurrentPage(clamped)
    // 6B-1：切页保留 zoom/mode/rotation（Viewer 状态独立于 Page）。
    // fit/fitWidth/actual 由 ViewerViewport 对新页实时重算（fitScale 依赖当前页尺寸）；
    // manual 保留冻结 scale。pan 归零（旧页 pan 坐标对新页无意义）。
    setPanX(0)
    setPanY(0)
  }, [document])

  // ─── initialPage 导航（拆分页切换 / 换文档定位） ───
  // 同一多页 PDF 的拆分页共享同一 Document 实例：在侧栏切换不同 fileObj
  // 时只有 initialPage 变化，useState 初值不会重跑，必须由 effect 导航。
  // 依赖 [initialPage, docId]：
  //   - initialPage 变化 → 定位到目标拆分页（验收用例：点 [2] 显示 pageNum=2）
  //   - docId 变化 → 切换到另一文档时重新定位
  // 不依赖 goToPage / document 身份：同 docId 的 document 对象更新
  // （如图片加载后的尺寸回填 patchPageMeta）不得把用户当前页 snap 回初始页。
  const goToPageRef = useRef(goToPage)
  goToPageRef.current = goToPage
  useEffect(() => {
    goToPageRef.current(initialPage)
  }, [initialPage, document?.docId])

  const nextPage = useCallback(() => {
    goToPage(currentPage + 1)
  }, [currentPage, goToPage])

  const prevPage = useCallback(() => {
    goToPage(currentPage - 1)
  }, [currentPage, goToPage])

  // ─── Pan Actions ───

  const setPan = useCallback((newPanX, newPanY) => {
    const dims = getPageDimensions()
    const container = containerRef.current
    if (!dims.width || !container?.width) {
      setPanX(newPanX)
      setPanY(newPanY)
      return
    }
    const fitScale = computeFitScale(dims.width, dims.height, container.width, container.height)
    // 6B-1：fitWidth/actual 也纳入 clamp（渲染 scale 与 clamp 一致，避免 pan 范围算错）。
    const renderScale = (mode === 'manual' && scale != null) ? scale
      : (mode === 'fitWidth') ? (container.width / dims.width)
      : (mode === 'actual') ? 1
      : fitScale
    const displayW = dims.width * renderScale
    const displayH = dims.height * renderScale
    const clamped = clampPan(newPanX, newPanY, displayW, displayH, container.width, container.height)
    setPanX(clamped.panX)
    setPanY(clamped.panY)
  }, [getPageDimensions, mode, scale])

  const panBy = useCallback((deltaX, deltaY) => {
    setPanX((x) => x + deltaX)
    setPanY((y) => y + deltaY)
    // clamp 在下一帧由 setPan 处理，这里先增量
  }, [])

  const resetView = useCallback(() => {
    setZoom(100)
    setPanX(0)
    setPanY(0)
  }, [])

  // ─── 6B-1.1：换文档边界（document.id 变化） ───
  // 两级语义分离：
  //   同票翻页（goToPage）→ 保留 zoom/mode/rotation，pan 归零（连续阅读）。
  //   换文档（resetForDocument）→ 全部回默认：page=0 / fit / zoom=100 / pan=0,0
  //     （打开一份新文件，与 Edge/Adobe 桌面阅读器行为一致）。
  // 🔧 修复（2026-08-09）：**不再重置 viewRotation**。viewRotation 的唯一权威来源是
  //   contentRotation（= previewRotation = fileRotations[file.key]），由上方 L101-105 的
  //   同步 effect 全权管理。若此处 setViewRotation(0)，React effect 按注册顺序执行：
  //   同步 effect（setViewRotation(cr)）先跑 → resetForDocument（setViewRotation(0)）后跑
  //   → 切文件时 viewRotation 恒被重置为 0 → 旋转 A 90° 后切 B 再切回 A，展示区回到 0°
  //   （验收场景失败）。移除后：切文件由 contentRotation 同步恢复正确旋转。
  // 6B-4.3：不重置 fitScale。resetForDocument 在 useEffect 中执行，晚于
  //   ViewerViewport 的 onFitScaleChange effect（child→parent 顺序）。
  //   若清零 fitScale，会覆写 ViewerViewport 刚上报的正确值，且因本地 fitScale
  //   未变导致 onFitScaleChange 不再触发，useViewerState.fitScale 永久停滞在 0。
  //   fitScale 由 ViewerViewport 通过 reportFitScale 自然上报，无需手动清零。
  const resetForDocument = useCallback(() => {
    setCurrentPage(0)
    setMode('fit')
    setScale(null)
    setZoom(100)
    setPanX(0)
    setPanY(0)
    // setViewRotation(0) 已移除：见上方修复说明，viewRotation 由 contentRotation 同步管理
  }, [])

  return {
    state: {
      currentPage,
      zoom,
      mode,
      scale,
      fitScale,
      zoomPercent,
      panX,
      panY,
      viewRotation,
    },
    actions: {
      zoomIn,
      zoomOut,
      setScalePreset,
      reportFitScale,
      setFit,
      enterManual,
      setManualScale,
      setFitMode,
      setFitWidth,
      setActual,
      wheelZoom,
      rotateLeft,
      rotateRight,
      goToPage,
      nextPage,
      prevPage,
      setPan,
      panBy,
      resetView,
      resetForDocument,
    },
  }
}
