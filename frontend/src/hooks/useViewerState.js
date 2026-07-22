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
export function useViewerState({ document, containerSize, initialPage = 0 }) {
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

  // ─── D2-4：离散档位缩放（toolbar +/−/下拉）───

  // 当前 fit 相对档位（供 ZoomToolbar 显示 + 档位高亮 + nextZoomStep 起点）：
  //   fit 模式 → 100（≡ 自适应基准）；manual → round(scale/fitScale×100)。
  //   fitScale 缺失（≤0，尺寸未知）回退 100，避免除零。
  const zoomPercent = (mode === 'manual' && scale != null && fitScale > 0)
    ? Math.round((scale / fitScale) * 100)
    : 100

  // 应用离散档位：100 ≡ fit 模式（自适应）；其余 → manual 绝对 scale = fitScale × step/100。
  // 离散缩放重置 pan（沿用 legacy UX，与 wheel 保留 pan 区分）；fitScale 缺失时无法换算，忽略。
  const applyZoomStep = useCallback((step) => {
    if (step === 100) {
      setFitMode()
      return
    }
    if (fitScale <= 0) return
    const absScale = fitScale * (step / 100)
    const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, absScale))
    setMode('manual')
    setScale(clamped)
    setPanX(0)
    setPanY(0)
  }, [fitScale, setFitMode])

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
    if (!document) return
    const clamped = Math.min(document.pageCount - 1, Math.max(0, index))
    setCurrentPage(clamped)
    // 页切换：回 fit 模式（D2-3）+ reset pan，保留 viewRotation
    setMode('fit')
    setScale(null)
    setZoom(100)
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
    // D2-3：manual 用冻结的绝对 scale，fit 用 fitScale，clamp 与实际渲染一致。
    const renderScale = (mode === 'manual' && scale != null) ? scale : fitScale
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
      wheelZoom,
      rotateLeft,
      rotateRight,
      goToPage,
      nextPage,
      prevPage,
      setPan,
      panBy,
      resetView,
    },
  }
}
