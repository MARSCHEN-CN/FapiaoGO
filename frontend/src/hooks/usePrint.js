import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { PREVIEW_DPI, PRINT_PIPELINE, PRINT_SETTINGS_DEFAULTS, BACKEND_URL } from '../config'
import {
  isMergeMode, previewImageToBlob, getExtension, isImageLikeFormat,
} from '../utils'
import { getForcedLandscape } from '../utils/mergeMode'
import { renderPrintContent } from '../utils/printRenderer'
import { buildRenderModel } from '../utils/renderModelBuilder'
import { validateRenderModel } from '../utils/renderModelValidator'
import { detectDocumentOrientation } from '../utils/detectOrientation'
import { printSingleSourceFile as printSingleSource, printMergedImages, printImageAsPdf } from '../services/PrintService'
import { runMergedPrintTasks } from '../runners/printRunner'
import { computePaperLayout } from '../previewState'
import { extendPaperLayoutContract } from '../print/paperLayoutContract'
import { applySourceOriginPlacement, transformPaperRotation } from '../print/placementAdapter'
import { resolveContentPlacement } from '../layout/RotationResolver'
import { resolvePaperSpec } from '../print/paperSpec'
import { fileContentPx } from '../print/PrintPreviewModel'
import { renderMergeFinalArtifact, loadMergePrintItems, getMergeArtifactInputSignature } from '../print/mergeFinalArtifact'
import { resolveMergeModeContract } from '../print/mergeModeContract'
import { createGenerationGuard } from '../print/mergeGenerationGuard'
import { fetchPrintRaster, buildPrintJobItem } from '../utils/printAdapter'
// A1/A1.5：已证等价的 Plan 事实来源 + 影子比较 helper（Commit 2 source / Commit 3 merge 分支消费）
import { buildPrintExecutionPlan, createPrintPlanInput } from '../print/buildPrintExecutionPlan'
// Phase 3.5 Preview Skeleton：Plan → 打印预览描述（纯函数，供 PrintConfirmModal 消费）
import { buildPrintPreviewModel } from '../print/PrintPreviewModel'
import {
  compareLegacyPlan,
  printPlanCompareEnabled,
} from '../print/compareLegacyPlan'
import { deriveSourcePrintJobs } from '../print/deriveSourcePrintJobs'
import { deriveMergePrintJobs } from '../print/deriveMergePrintJobs'
import { buildLegacyPrintPlan } from '../print/buildLegacyPrintPlan'

// ✅ 懒加载 PDF 渲染模块，避免首屏加载 1.4 MB 的 pdfjs-dist + react-pdf
let _printRenderers = null
async function getPrintRenderers() {
  if (!_printRenderers) {
    _printRenderers = await import('../renderers')
  }
  return _printRenderers
}

// 打印队列配置
const PRINT_BATCH_SIZE = 3  // 并发渲染数量

// 直接打印支持的文件扩展名
const DIRECT_PRINT_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif']

function canDirectPrint(filePath) {
  if (!filePath) return false
  const ext = getExtension(filePath)
  return DIRECT_PRINT_EXTENSIONS.includes('.' + ext)
}

// ==========================================
// 辅助函数：Canvas → Uint8Array（PNG 格式）
// 替换 toDataURL：避免 base64 33% 膨胀 + 内存翻倍
// 返回 Uint8Array 供 IPC 传输（Electron 结构化克隆原生支持）
// ==========================================
async function canvasToUint8Array(canvas) {
  if (!canvas) return null
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 1.0))
  if (!blob || blob.size === 0) return null
  const buffer = await blob.arrayBuffer()
  return new Uint8Array(buffer)
}

// ==========================================
// Blob URL 管理工具（在本地作用域内管理，避免泄漏）
// ==========================================
function createAndTrackBlobUrl(blob, ref) {
  const url = URL.createObjectURL(blob)
  ref.push(url)
  return url
}

function revokeBlobUrl(url, ref) {
  if (!url) return
  try {
    URL.revokeObjectURL(url)
  } catch (e) { /* ignore already revoked */ }
  const idx = ref.indexOf(url)
  if (idx > -1) ref.splice(idx, 1)
}

function revokeBlobUrls(urls, ref) {
  urls.forEach(url => revokeBlobUrl(url, ref))
}

export function usePrint({ files, settings, fileRotations, setFiles, electronAPIRef, submitPrintIntent, previewFile, setSettings }) {
  const [printing, setPrinting] = useState(false)
  const [printProgress, setPrintProgress] = useState({})
  const [printFiles, setPrintFiles] = useState([])
  const [alertModal, setAlertModal] = useState(null)
  const [dimsVersion, setDimsVersion] = useState(0)
  // 当前直接打印的 jobId
  const [currentJobId, setCurrentJobId] = useState(null)
  // 打印确认弹窗
  const [printConfirmModal, setPrintConfirmModal] = useState(false)
  const [triggerPrint, setTriggerPrint] = useState(false)
  // 打印队列状态
  const [printQueueStatus, setPrintQueueStatus] = useState({
    pending: 0,
    printing: 0,
    completed: 0,
    failed: 0,
  })

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      // 取消所有进行中的操作
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      // 清除超时定时器
      if (printTimeoutRef.current) {
        clearTimeout(printTimeoutRef.current)
      }
      // 释放所有未释放的 blob URLs
      pendingBlobUrlsRef.current.forEach(url => {
        try {
          URL.revokeObjectURL(url)
        } catch (e) { /* ignore */ }
      })
      pendingBlobUrlsRef.current = []
    }
  }, [])

  const printTimeoutRef = useRef(null)
  const printFilesRef = useRef([])
  // URL 内存泄漏修复：追踪所有创建的 blob URL
  const pendingBlobUrlsRef = useRef([])
  // 打印队列 refs
  const printQueueRef = useRef({
    pending: [],    // 待处理
    printing: [],   // 处理中
    completed: [],  // 完成
    failed: [],     // 失败
  })
  // ✅ 打印队列状态 ref（用于同步）
  const printQueueStatusRef = useRef({
    pending: 0,
    printing: 0,
    completed: 0,
    failed: 0,
  })
  const isPrintingRef = useRef(false)
  const abortControllerRef = useRef(null)
  const nextTaskIdRef = useRef(0)

  // 同步 printFilesRef
  // 通过在 setter 中同步来保持一致
  const setPrintFilesAndRef = useCallback((value) => {
    setPrintFiles(prev => {
      const next = typeof value === 'function' ? value(prev) : value
      printFilesRef.current = next
      return next
    })
  }, [])

  const clearPrintState = useCallback(() => {
    setPrintProgress({})
  }, [])

  // ── 更新队列状态 ──
  const updateQueueStatus = useCallback(() => {
    const queue = printQueueRef.current
    const status = {
      pending: queue.pending.length,
      printing: queue.printing.length,
      completed: queue.completed.length,
      failed: queue.failed.length,
    }
    // ✅ 同步到 ref
    printQueueStatusRef.current = status
    setPrintQueueStatus(status)
  }, [])

  // ✅ renderImageBlobToCanvas 已移除，现在统一使用 renderMultipleItemsToCanvas 以支持安全边距

  // ── 单个文件渲染为打印图片 ──
  // ✅ 改为使用 renderMultipleItemsToCanvas，以支持打印安全边距
  const renderFileToPrintImage = useCallback(async (f, ipc) => {
    const rotation = fileRotations[f.key] || 0
    const localBlobUrls = []
    
    try {
      // ✅ 加载文件数据，构建 items 数组
      const items = []
      
      if (f.fileFormat === 'pdf' || (!f.fileFormat && !f.previewImage)) {
        // PDF 文件
        const fileData = await ipc.invoke('read-file', f.printPath)
        if (fileData.success) {
          items.push({ ...f, _pdfData: new Uint8Array(fileData.data) })
        } else {
          console.error('[usePrint] 读取 PDF 文件失败:', f.printPath)
          return null
        }
      } else if (isImageLikeFormat(f.fileFormat)) {
        // ── OFD 多页：经 buildPrintJobItem().pages 逐页取栅格（13-B.5.1a 契约，823d99c 误删恢复）──
        // VirtualImageSource 层能力：OFD 是 1 个 document-level fileObj + N 个 metadata pages，
        // 必须把 document pages materialize 成 N 个物理页 buffer，而非只取第 1 页。
        if (f.fileFormat === 'ofd' && f.docId) {
          const job = buildPrintJobItem(f)
          const pages = job.pages || []
          if (pages.length > 0) {
            const { renderMultipleItemsToCanvas } = await getPrintRenderers()
            const buffers = []
            for (const page of pages) {
              let blob = null
              try {
                blob = await fetchPrintRaster(job.docId, page.index + 1)
              } catch (e) {
                console.warn('[usePrint] OFD 逐页栅格获取失败 page=%d:', page.index + 1, job.docId, e?.message)
              }
              if (!blob && f.previewImage) {
                blob = previewImageToBlob(f.previewImage)
                console.warn('[usePrint] OFD 第 %d 页使用 previewImage 兜底（旧 session 无 docId）:', page.index + 1, f.name)
              }
              if (!blob) {
                console.error('[usePrint] OFD 第 %d 页无栅格且无兜底，无法打印:', page.index + 1, f.name)
                return null
              }
              const blobUrl = createAndTrackBlobUrl(blob, localBlobUrls)
              const pageItem = { ...f, _previewImageUrl: blobUrl }
              const canvas = await renderMultipleItemsToCanvas(
                [pageItem],
                settings.paperSize || 'A4',
                PREVIEW_DPI,
                settings.landscape,
                { [f.key]: rotation },  // D-B: 文件级旋转整文件共用，不引入页面级旋转
                1,  // slotCount = 1（单页）
                false,  // ✅ isPrint = false（与预览保持一致）
                false,  // showSafeMargin
                { strategy: 'vertical', customPaper: settings.customPaper },
              )
              if (!canvas) {
                console.warn('[usePrint] OFD 第 %d 页渲染失败:', page.index + 1, f.name)
                return null
              }
              const data = await canvasToUint8Array(canvas)
              if (data) buffers.push(data)
            }
            if (buffers.length === 0) return null
            // data 为页 buffer 数组：runMergedPrintTasks 展开为 N 张物理页
            return { key: f.key, name: f.name, data: buffers, printPath: f.printPath }
          }
          // D-E: docId 存在但 Document 缺失 → pages 为空 → 降级单页，显式记录便于定位
          console.debug('[usePrint] OFD print page identity unavailable, fallback single page:', f.name, f.docId)
        }
        // IMAGE + OFD 单页兜底：获取图片 blob → 创建 blob URL → push items
        // OFD: 通过 backend fetchPrintRaster 栅格化获取
        // Image: 通过 read-file 直接读取（保留原图分辨率）
        let blob = null
        if (f.fileFormat === 'ofd') {
          if (f.docId) {
            try {
              blob = await fetchPrintRaster(f.docId, 1)
            } catch (e) {
              console.warn('[usePrint] OFD docId 栅格获取失败，回退 previewImage:', f.docId, e?.message)
            }
          }
        } else {
          const fileData = await ipc.invoke('read-file', f.printPath)
          if (fileData.success) {
            blob = new Blob([fileData.data])
          }
        }
        // 统一兜底：previewImage（旧 session）
        if (!blob && f.previewImage) {
          blob = previewImageToBlob(f.previewImage)
        }
        if (!blob) {
          console.error('[usePrint] 加载 %s 文件数据失败:', f.fileFormat?.toUpperCase(), f.name)
          return null
        }
        const blobUrl = createAndTrackBlobUrl(blob, localBlobUrls)
        items.push({ ...f, _previewImageUrl: blobUrl })
      } else {
        console.error('[usePrint] 未知文件格式:', f.fileFormat)
        return null
      }
      
      if (items.length === 0) {
        console.warn('[usePrint] 没有成功加载任何文件数据')
        return null
      }
      
      // ✅ 使用 renderMultipleItemsToCanvas 渲染（支持安全边距）
      const { renderMultipleItemsToCanvas, renderPDFPageRaw } = await getPrintRenderers()

      // ── A3-3-2：PDF 单文件走 native + PlacementAdapter（不进 renderMultipleItemsToCanvas）──
      // 冻结（a3_design_spec §A3-3）：验证「native resource + placement」，不混 composer/slot 语义。
      // 唯一变量：native bitmap + sourceOrigin 位移（rot0；rotation 属 A3-3-3）。
      // 前提：paperLayout 已构造（下方 A3-1/3-1 段），此处先渲染 native + 生成 PlacementCommand。
      const pdfItem = items.find(i => i._pdfData)
      const isSinglePdfNative = items.length === 1 && !!pdfItem && (f.fileFormat === 'pdf' || (!f.fileFormat && !f.previewImage))
      let nativePlacedCanvas = null
      let nativeCmd = null
      if (isSinglePdfNative) {
        const baseLayout0 = computePaperLayout({
          paperSize: settings.paperSize,
          customPaper: settings.customPaper,
          margins: {
            left: settings.marginLeft ?? 3, right: settings.marginRight ?? 3,
            top: settings.marginTop ?? 3, bottom: settings.marginBottom ?? 3,
          },
        })
        const paperLayout0 = extendPaperLayoutContract(baseLayout0, {
          sourceOriginXMM: settings.marginLeft ?? 3,
          sourceOriginYMM: settings.marginTop ?? 3,
        })
        const nativeRes = await renderPDFPageRaw(pdfItem._pdfData, PREVIEW_DPI, pdfItem.key, null, false)
        if (nativeRes) {
          nativeCmd = applySourceOriginPlacement({
            renderResource: nativeRes,
            paperLayout: paperLayout0,
            rotation: 0,  // A3-3-2：rot0 基础 command（sourceOrigin 施加；rotation 属 A3-3-3）
          })
          const pw = paperLayout0.paperRect?.w || nativeRes.width
          const ph = paperLayout0.paperRect?.h || nativeRes.height
          // ── A3-3-3：Policy A 画布级旋转（a3_design_spec §7.1）──
          // drawRenderCommand 的 contentRotation 是 Policy B（内容在画布内旋转），Policy A 需画布级旋转：
          // rot0 command 先绘制扩展纸面 → transformPaperRotation 产画布旋转 command →
          // 把扩展纸面画布作为 source 旋转绘制到新画布（与 A3-2 采集器同一数学，C5 已验证）。
          // sourceOrigin 是 paper-space 属性，旋转阶段不参与（C4）。
          const rotInfo = transformPaperRotation(nativeCmd, rotation, pw, ph)
          nativePlacedCanvas = document.createElement('canvas')
          nativePlacedCanvas.width = rotInfo.canvasW
          nativePlacedCanvas.height = rotInfo.canvasH
          const nctx = nativePlacedCanvas.getContext('2d')
          nctx.fillStyle = '#ffffff'
          nctx.fillRect(0, 0, rotInfo.canvasW, rotInfo.canvasH)
          // 绘制：native bitmap 位移到 (offsetX, offsetY)，scale=1（drawRenderCommand 同款几何）
          const { drawRenderCommand } = await import('../layout/renderDraw.js')
          if (rotInfo.rotateCanvasCommand) {
            // rotation≠0：两段式——先画扩展纸面到临时画布，再整体旋转绘制到最终画布（Policy A）
            const tmpCanvas = document.createElement('canvas')
            tmpCanvas.width = pw
            tmpCanvas.height = ph
            const tctx = tmpCanvas.getContext('2d')
            tctx.fillStyle = '#ffffff'
            tctx.fillRect(0, 0, pw, ph)
            drawRenderCommand(tctx, nativeCmd, nativeRes.canvas, nativeRes.width, nativeRes.height)
            drawRenderCommand(nctx, rotInfo.rotateCanvasCommand, tmpCanvas, pw, ph)
          } else {
            drawRenderCommand(nctx, nativeCmd, nativeRes.canvas, nativeRes.width, nativeRes.height)
          }
        } else {
          console.warn('[usePrint] native render 返回 null，回退 renderMultipleItemsToCanvas')
        }
      }

      let canvas = nativePlacedCanvas
      if (!canvas) {
        canvas = await renderMultipleItemsToCanvas(
          items,
          settings.paperSize || 'A4',
          PREVIEW_DPI,
          settings.landscape,
          { [f.key]: rotation },  // rotations
          1,  // slotCount = 1（单个文件）
          false,  // ✅ isPrint = false（与预览保持一致）
          false,  // showSafeMargin
          { strategy: 'vertical', customPaper: settings.customPaper }
        )
      }
      
      if (!canvas) {
        console.warn('[usePrint] renderMultipleItemsToCanvas 返回 null')
        return null
      }

      // ✅ 返回 Uint8Array
      const data = await canvasToUint8Array(canvas)
      if (!data) return null

      // ── A3-1 (Render Contract 接线层)：构造统一纸面几何，携带不生效 ──
      // 与 merge 轨 renderMergeGroupToPrintImage 同款 computePaperLayout（L382-389）。
      // 目标：证明生产 canvas 单文件路径能构造 paperLayout（数据链路贯通），
      // 且不改变 bitmap（paperLayout 只附加到返回 job，不进渲染调用——渲染路径 A3-2/3 再接）。
      // 冻结（a3_design_spec §8）：A3-1 不允许改变最终 bitmap。
      // A3-3-1：extendPaperLayoutContract 附加 coordinateSpace/sourceOrigin（声明性，不消费）。
      const baseLayout = computePaperLayout({
        paperSize: settings.paperSize,
        customPaper: settings.customPaper,
        margins: {
          left: settings.marginLeft ?? 3, right: settings.marginRight ?? 3,
          top: settings.marginTop ?? 3, bottom: settings.marginBottom ?? 3,
        },
      })
      const paperLayout = extendPaperLayoutContract(baseLayout, {
        // sourceOrigin = source 语义偏移（原始 PDF 内容相对扩展纸面的偏移），非 margin（布局约束）。
        sourceOriginXMM: settings.marginLeft ?? 3,
        sourceOriginYMM: settings.marginTop ?? 3,
      })
      return { key: f.key, name: f.name, data, printPath: f.printPath, paperLayout }
      
    } catch (error) {
      console.error('[usePrint] renderFileToPrintImage 异常:', error)
      return null
    } finally {
      // 所有路径（包括异常）都必须释放本地 blob URL
      revokeBlobUrls(localBlobUrls, pendingBlobUrlsRef.current)
    }
  }, [fileRotations, settings.paperSize, settings.landscape])

  // ── M3-1：合并渲染降级为 Artifact → PNG adapter ──
  // 不再 loadMergePrintItems / renderMergeFinalArtifact：该步已由 prepareMergeArtifacts 在
  // 弹窗打开时完成，结果存入 mergeArtifacts（同一份被 Preview 与 Print 消费）。
  // 此处只把已生成的 Final Artifact.canvas 编码为 PNG bytes，保持原返回结构
  // { key, names, data }，下游 PDF / Sumatra 链路零改动。groupSize 自然消失（不再计算布局）。
  const renderMergeGroupToPrintImage = useCallback(async (artifact, group, jobKey) => {
    const _groupId = jobKey || (group || []).map(f => f.key).join('+')
    if (!artifact || !artifact.canvas) {
      console.warn('[M3-1] group=%s artifact 缺失（canvas 为空）⇒ return null', _groupId)
      return null
    }
    const canvas = artifact.canvas
    try {
      // ✅ 复用 M2-2 已生成的 Final Artifact，禁止二次 render
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png', 1.0))
      if (!blob) {
        console.warn('[M3-1][PNG] group=%s blob=NULL（编码失败）', _groupId)
        return null
      }
      const pngBytes = new Uint8Array(await blob.arrayBuffer())
      return {
        key: _groupId,
        names: (group || []).map(f => f.name),
        data: pngBytes,
      }
    } catch (e) {
      console.error('[M3-1][PNG] group=%s 编码异常:', _groupId, e)
      return null
    }
  }, [])


  const handlePrintClose = useCallback(() => {
    setPrinting(false); setPrintProgress({})
    setFiles((prev) => prev.map((f) => f.status === 'printing' ? { ...f, status: 'parsed' } : f))
  }, [setFiles])

  // ── 打印会话上下文 → Plan 输入（Preview 与 Execute 唯一共享入口）──
  // Commit 1（derived preview）：预览描述不再存 state 快照，而是从打印会话上下文
  // 派生（useMemo）；settings/files/fileRotations 一变即重建，杜绝「打开时快照过期」。
  // 与 doPrint/executePrint 共用 createPrintPlanInput → filter 同源，plan 即唯一事实源。

  // C-2 Step 1-B：修复 placements 死代码（Gap G3）。
  //   1. contentPhysicalSize 传【原始尺寸】，contentRotation 由 Resolver 内部施加
  //      （原传 contentSize 违反契约 → 恒抛错 → placements 恒 {}）
  //   2. physicalPaper 走 paperSpec.resolvePaperSpec —— needSwap 归一化后（请求方向），
  //      与 Preview（PrintPreviewModel.pageToModel L180-196）同一纸张事实源。
  //   3. 与 Preview 共用 resolveContentPlacement（唯一 layout resolver，禁两套算法）。
  const placements = useMemo(() => {
    const result = {}
    if (!settings?.paperSize) return result
    const paper = resolvePaperSpec(settings)
    const physicalPaper = { widthMM: paper.widthMM, heightMM: paper.heightMM }
    const margins = {
      left: settings.marginLeft ?? 3,
      right: settings.marginRight ?? 3,
      top: settings.marginTop ?? 3,
      bottom: settings.marginBottom ?? 3,
    }
    for (const f of files) {
      // C-2 Step 2（G-C2-4 抓出）：contentPhysicalSize 必须 px@PREVIEW_DPI（Resolver 契约）——
      // 用 fileContentPx（PDF points × dpi/72 归一，与 Preview pageToModel 同源），
      // 不能直接传 getContentDimensions 的 PDF points（单位错 → scale 差 dpi/72 倍）。
      const dims = fileContentPx(f)
      if (!dims) continue
      const contentRotation = fileRotations[f.key] || 0
      try {
        result[f.key] = resolveContentPlacement({
          contentPhysicalSize: dims,
          contentRotation,
          physicalPaper,
          margins,
          dpi: PREVIEW_DPI,
        })
      } catch (_) {
        // 边距超纸等情况，跳过该文件的 placement 计算
      }
    }
    return result
  }, [files, settings, fileRotations])

  const printPlanInput = useMemo(
    () => createPrintPlanInput(files, settings, fileRotations, placements),
    [files, settings, fileRotations, placements],
  )

  // Phase 3.5：打印预览描述（derived state，非快照；null = 构建失败）
  const printPreviewModel = useMemo(() => {
    try {
      const plan = buildPrintExecutionPlan(printPlanInput.files, printPlanInput.options)
      // 当前选中页定位（用于预览从当前选中页开始）。
      // previewFile.pageNum 是 1-based source transport（/split_pdf.page_index），
      // 而 slot.pageIndex 在模型内为 0-based → 在此归一化。
      const currentSelection = previewFile
        ? { fileId: previewFile.key, pageIndex: (previewFile.pageNum ?? 1) - 1 }
        : null
      return buildPrintPreviewModel(plan, {
        files: printPlanInput.files,
        settings: printPlanInput.options.settings,
        currentSelection,
        backendUrl: BACKEND_URL,
      })
    } catch (err) {
      console.error('[usePrint] 构建打印预览描述失败:', err)
      return null
    }
  }, [printPlanInput, previewFile, dimsVersion])

  // Commit 3 fix (extended): PrintPreview placement needs file dimensions.
  // PDF: load via pdf.js (existing behavior).
  // Images: load via backend /metadata/{doc_id} (Pillow dimensions).
  // Both sets _pdfPageWidth/_pdfPageHeight (PDF) or _imageWidth/_imageHeight (image).
  useEffect(() => {
    const pdfFiles = files.filter(f =>
      f && f.printPath && (f.fileFormat === 'pdf' || (!f.fileFormat && !f.previewImage))
      && !(f._pdfPageWidth > 0 && f._pdfPageHeight > 0)
    )
    const imgFiles = files.filter(f =>
      f && f.docId && isImageLikeFormat(f.fileFormat)
      && !(f._imageWidth > 0 && f._imageHeight > 0)
    )
    if (pdfFiles.length === 0 && imgFiles.length === 0) return

    let cancelled = false
    const load = async () => {
      const ipc = electronAPIRef.current?.ipcRenderer

      // ── PDF files: load dimensions via pdf.js ──
      for (const f of pdfFiles) {
        if (cancelled) break
        if (!ipc) break
        try {
          const fd = await ipc.invoke('read-file', f.printPath)
          if (cancelled || !fd?.success) continue
          const { getOrLoadPdfDocument } = await import('../renderers.js')
          const pdfDoc = await getOrLoadPdfDocument(new Uint8Array(fd.data))
          if (cancelled || !pdfDoc) continue
          const page = await pdfDoc.getPage(1)
          const vp = page.getViewport({ scale: 1, rotation: 0 })
          f._pdfPageWidth = Math.round(vp.width)
          f._pdfPageHeight = Math.round(vp.height)
          await page.cleanup()
          console.log('[usePrint dims loaded] PDF fileKey=%s size=%dx%d', f.key?.slice(-20), f._pdfPageWidth, f._pdfPageHeight)
        } catch (_) {}
      }

      // ── Image + OFD files: load dimensions via backend metadata ──
      if (imgFiles.length > 0) {
        try {
          const { fetchDocumentMetadata } = await import('../services/renderDocument.js')
          for (const f of imgFiles) {
            if (cancelled) break
            try {
              const meta = await fetchDocumentMetadata(f.docId)
              const p = meta?.pages?.[0]
              if (p && p.width > 0 && p.height > 0) {
                f._imageWidth = p.width
                f._imageHeight = p.height
                console.log('[usePrint dims loaded] %s fileKey=%s size=%dx%d',
                  f.fileFormat?.toUpperCase() || 'IMAGE', f.key?.slice(-20), f._imageWidth, f._imageHeight)
              }
            } catch (_) {}
          }
        } catch (_) {}
      }

      if (!cancelled) setDimsVersion(v => v + 1)
    }
    load()
    return () => { cancelled = true }
  }, [files, electronAPIRef, setDimsVersion])

  // ✅ M2-2：Merge-only Final Artifact 生命周期 state（仅 Merge 模式使用，
  // 不进入公共 printPreviewModel）。Preview 与 M3 Print 消费同一份。
  const [mergeArtifacts, setMergeArtifacts] = useState(null)
  // ✅ M3-1：用 ref 透出最新 mergeArtifacts。doPrint 是 useCallback 且其依赖未含 mergeArtifacts，
  // 若直接读闭包变量会在打印点击时拿到旧（null）值。render 时同步 .current，调用时读最新，Normal 路径不受影响。
  const mergeArtifactsRef = useRef(null)
  mergeArtifactsRef.current = mergeArtifacts

  // ✅ F3：Modal 开闭守卫 ref。freshness watcher 的依赖严格只含「影响 Final Artifact 的输入」，
  // 故意不含 printConfirmModal 本身——否则 Modal 打开（false→true）会触发一次多余的重生成。
  // 用 ref 读取最新开闭态：关闭时即使输入变化也不生成 Artifact（F3-E）。
  const printConfirmModalRef = useRef(false)
  printConfirmModalRef.current = printConfirmModal

  // ✅ F4：Generation Ownership 守卫（提取为纯模块，单一权威源）。
  // prepareMergeArtifacts 每次「真实 generation」调用 guard.begin() 取唯一 myGeneration；
  // 仅 guard.isCurrent(myGeneration) 为 true（仍最新）才允许 commit mergeArtifacts，
  // 旧 generation 即使晚完成也被拒，防止异步竞态下旧 render 覆盖新 Artifact（F4-A/B/C）。
  // 不依赖 React state；覆盖整个 async 生命周期（入口取号 → commit 前校验）。
  const mergeGenerationGuardRef = useRef(null)
  if (!mergeGenerationGuardRef.current) mergeGenerationGuardRef.current = createGenerationGuard()

  // ✅ M2-2：Merge 打印确认预览打开前，提前生成 Final Artifact（替代“打印时才生成”）。
  // 仅服务 Merge；Normal 模式不调用。artifact 一旦生成即自包含（canvas/dataURL），
  // 加载产生的 blob URL 在渲染完成后立即回收（canvas 已栅格化，无需保留）。
  const prepareMergeArtifacts = useCallback(async () => {
    if (!isMergeMode(settings.mergeMode)) return
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc || typeof ipc.invoke !== 'function') return
    // ✅ F4：本 generation 取得唯一 id（原子自增）。放在真实渲染入口之后、try 之前，
    // 仅真实 generation 消耗序号；myGeneration 为闭包局部常量，贯穿整个 async 生命周期。
    const myGeneration = mergeGenerationGuardRef.current.begin()
    try {
      const { files: planFiles, options: planOptions } = createPrintPlanInput(files, settings, fileRotations)
      const plan = buildPrintExecutionPlan(planFiles, planOptions)
      const mergeJobs = deriveMergePrintJobs(plan, files)
      if (!mergeJobs.length) {
        // ✅ F4：空结果同样受 generation 守卫约束——旧 generation 的空结果不得覆盖新结果（F4-C）。
        if (mergeGenerationGuardRef.current.isCurrent(myGeneration)) { setMergeArtifacts([]) }
        return
      }
      // ✅ R2.3-A.1：Virtual Paper topology 由 MergeMode Contract 决定（slotCount 与文件数彻底分离）。
      //    groupSize 不再是 mergeJobs[0].files.length（=实际文件数）——那会导致 merge3+2文件 退化成一页两票。
      //    缺失文件 → EMPTY Virtual Paper（composer sourceIndex=-1，区域保留不绘制）。
      const mergeContract = resolveMergeModeContract(settings.mergeMode)
      const groupSize = mergeContract.slotCount
      const forcedLandscape = mergeContract.forcedLandscape
      const printPaperLayout = computePaperLayout({
        paperSize: settings.paperSize,
        customPaper: settings.customPaper,
        margins: {
          left: settings.marginLeft ?? 3, right: settings.marginRight ?? 3,
          top: settings.marginTop ?? 3, bottom: settings.marginBottom ?? 3,
        },
      })
      const results = []
      for (const job of mergeJobs) {
        const loaded = await loadMergePrintItems(job.files, ipc)
        if (!loaded.validItems.length) {
          loaded.blobUrls.forEach(u => URL.revokeObjectURL(u))
          continue
        }
        const artifact = await renderMergeFinalArtifact(loaded.validItems, {
          paperSize: settings.paperSize || 'A4',
          dpi: PREVIEW_DPI,
          mergeMode: settings.mergeMode,
          forcedLandscape,
          fileRotations,
          groupSize,
          paperLayout: printPaperLayout,
          layoutOptions: { strategy: mergeContract.strategy, gridCols: mergeContract.gridCols, gridRows: mergeContract.gridRows, customPaper: settings.customPaper },
        })
        // 渲染完成即栅格化，blob URL 可回收
        loaded.blobUrls.forEach(u => URL.revokeObjectURL(u))
        if (artifact) {
          // ✅ F2：为每个 Artifact 绑定其生成输入的 inputSignature（复用同一
          // getMergeArtifactInputSignature，禁止另造一套字符串），供 F3 freshness 比较。
          // jobKey 公式保持不变：files.map(f => f.key).join('+')。
          const sig = getMergeArtifactInputSignature({ files: job.files, settings, fileRotations })
          results.push({ key: job.files.map(f => f.key).join('+'), signature: sig, artifact })
        }
      }
      // ✅ F4：commit 前校验仍为最新 generation，否则丢弃本 generation 全部结果（F4-B/C）。
      if (!mergeGenerationGuardRef.current.isCurrent(myGeneration)) return
      setMergeArtifacts(results)
    } catch (err) {
      console.error('[usePrint] M2-2 生成 Merge Artifact 失败:', err)
      // ✅ F4：异常时同样仅当本 generation 最新才 commit null，避免旧 generation 异常覆盖新结果（F4-C）。
      if (mergeGenerationGuardRef.current.isCurrent(myGeneration)) { setMergeArtifacts(null) }
    }
  }, [files, settings, fileRotations])

  // ✅ F3：freshness trigger（signature-driven）。仅当「影响 Final Artifact 的输入」变化且
  // Modal 已打开时，重新生成同一生产者 prepareMergeArtifacts()。
  // 依赖严格限定 F1 矩阵（paperSize/customPaper/mergeMode/marginL/R/T/B/fileRotations），
  // 不含 printConfirmModal（避免打开时重复生成），Modal 开闭用 printConfirmModalRef 守卫（F3-E）。
  // 不另造 producer、不改 jobKey、不碰 Normal Preview / renderer / PrintPreviewModel（F3-G/H）。
  useEffect(() => {
    if (!printConfirmModalRef.current) return
    if (!isMergeMode(settings.mergeMode)) return
    prepareMergeArtifacts()
  }, [
    settings.paperSize, settings.customPaper, settings.mergeMode,
    settings.marginLeft, settings.marginRight, settings.marginTop, settings.marginBottom,
    fileRotations, prepareMergeArtifacts,
  ])

  // ── 打印前确认弹窗 ──
  const handlePrintShowConfirm = useCallback(async () => {
    if (previewFile) {
      const detectedOrient = detectDocumentOrientation(previewFile)
      const shouldLandscape = detectedOrient === 'landscape'
      setSettings(prev => (prev.landscape !== shouldLandscape ? { ...prev, landscape: shouldLandscape } : prev))
    }
    // ✅ M2-2：Merge 模式提前生成 Final Artifact（Preview 与 M3 Print 共用同一份），
    // 生成完成再打开弹窗，避免预览首帧空白。Normal 模式跳过。
    if (isMergeMode(settings.mergeMode)) {
      await prepareMergeArtifacts()
    }
    setPrintConfirmModal(true)
  }, [previewFile, setSettings, settings.mergeMode, prepareMergeArtifacts])

  const handlePrintConfirm = useCallback(() => {
    setPrintConfirmModal(false)
    // ⛔ Step 3.1: setTriggerPrint(true) 已移除
    // handlePrintConfirm 仅关闭弹窗，不再间接触发 doPrint()
    // Legacy 打印由 App.jsx 通过 executeLegacyPrint() 显式调用
  }, [])

  const handlePrintCancel = useCallback(() => {
    setPrintConfirmModal(false)
  }, [])

  // ── 离线队列打印系统 ──
  const doPrint = useCallback(async () => {
    // 防重入：已在打印中，忽略重复点击
    if (isPrintingRef.current) return

    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc || typeof ipc.invoke !== 'function') {
      setAlertModal({
        visible: true,
        title: '环境限制',
        message: '打印功能仅在 Electron 桌面端可用',
        type: 'warning',
      })
      return
    }

    // 创建新的取消控制器
    const abortController = new AbortController()
    abortControllerRef.current = abortController
    const { signal } = abortController

    // 支持已解析和解析失败的文件（只要有 printPath 就能打印）
    const parsedFiles = files.filter(f => {
      if (!f.printPath) return false
      if (f.status !== 'parsed' && f.status !== 'error') return false
      // OFD 允许 docId（Render Contract）或 previewImage（旧 session）任一即打印
      if ((f.fileFormat === 'ofd') && !f.docId && !f.previewImage) return false
      return true
    })
    if (parsedFiles.length === 0) {
      setAlertModal({
        visible: true,
        title: '提示',
        message: '没有可打印的文件',
        type: 'warning',
      })
      return
    }

    // 初始化打印队列
    printQueueRef.current = {
      pending: [],
      printing: [],
      completed: [],
      failed: [],
    }
    setPrintProgress({})
    setPrinting(true)
    isPrintingRef.current = true

    setFiles((prev) =>
      prev.map((f) =>
        parsedFiles.some((pf) => pf.key === f.key) ? { ...f, status: 'printing' } : f
      )
    )

    // 给每个任务分配唯一 ID
    const assignTaskId = (data) => ({ id: nextTaskIdRef.current++, data })

    // 准备队列任务
    const mergeMode = settings.mergeMode || 'none'
    const isMerge = isMergeMode(mergeMode)
    const groupSize = parseInt(mergeMode.replace('merge', '')) || 2
    // ✅ 合并模式强制方向：merge4=横向，其他=竖向
    const forcedLandscape = isMerge ? getForcedLandscape(mergeMode, settings.landscape) : settings.landscape
    if (isMerge) {
      // 合并模式：消费已证等价的 MERGE Plan（A1.5 投影性质）→ deriveMergePrintJobs
      // Commit 1：与 Preview 共用 createPrintPlanInput（merge 模式 → MERGE_FILE_FILTER），
      // 保证「预览显示什么 = 确认后打印什么」的文件集合一致。
      const { files: planFiles, options: planOptions } = createPrintPlanInput(files, settings, fileRotations)
      const plan = buildPrintExecutionPlan(planFiles, planOptions)
      const mergeJobs = deriveMergePrintJobs(plan, files)
      // [P0] 探针 A：合并 job 派生证据（证伪 H3 job 派生层）
      // 仅诊断，不改任何行为；复现 merge2/3/4 打印失败后据此判断是否进入 P1。
      console.log('[P0][JOB] mergeMode=%s groupSize=%d jobCount=%d',
        mergeMode, groupSize, mergeJobs.length)
      mergeJobs.forEach((j, gi) => {
        const fs = j.files || []
        console.log('[P0][JOB] groupIndex=%d fileCount=%d fileKeys=%s',
          gi, fs.length, fs.map(f => f.key).join(','))
      })
      // 开发期影子比对（DEV + localStorage 开关，绝不进 production）：新 plan vs Legacy Oracle
      if (printPlanCompareEnabled()) {
        compareLegacyPlan(plan, { files, settings, fileRotations })
      }
      // 队列任务 = 每组文件对象数组（与旧 parsedFiles.slice 滑窗分组逐组等价）
      printQueueRef.current.pending = mergeJobs.map((j) => assignTaskId(j.files))
      setPrintFilesAndRef(mergeJobs.map((j) => ({
        key: j.files.map((f) => f.key).join('+'),
        name: j.files.map((f) => f.name).join(' + '),
      })))
    } else {
      // 普通模式：单文件
      printQueueRef.current.pending = parsedFiles.map(f => assignTaskId(f))
      setPrintFilesAndRef(parsedFiles.map(f => ({ key: f.key, printPath: f.printPath, name: f.name })))
    }

    // ✅ M3-1-A：按 job.key 消费 M2-2 已生成的同一份 mergeArtifacts（禁止二次 render）。
    // key 公式与 prepareMergeArtifacts 一致：files.map(f => f.key).join('+')。
    const artifactByKey = isMerge
      ? new Map((mergeArtifactsRef.current || []).map(item => [item.key, item.artifact]))
      : null

    updateQueueStatus()

    // 超时保护
    if (printTimeoutRef.current) clearTimeout(printTimeoutRef.current)
    printTimeoutRef.current = setTimeout(() => {
      abortController.abort()
      isPrintingRef.current = false
      setPrinting(false)
      setPrintProgress({})
      printQueueRef.current = { pending: [], printing: [], completed: [], failed: [] }
      setFiles((prev) => prev.map((f) => f.status === 'printing' ? { ...f, status: 'parsed' } : f))
    }, 120000) // 2分钟超时

    // ── 队列处理循环（通过 PrintRunner 编排执行） ──
    const processQueue = async () => {
      const queue = printQueueRef.current
      // 包装渲染函数（与 React state 解耦的纯执行）
      const renderFn = async (task) => {
        if (signal.aborted) return null
        try {
          if (isMerge) {
            const group = task.data || task
            const jobKey = (group || []).map(f => f.key).join('+')
            const artifact = artifactByKey?.get(jobKey)
            if (!artifact) {
              console.warn('[M3-1] jobKey=%s 无对应 Artifact（Prepare 未生成？）⇒ return null', jobKey)
              return null
            }
            // ✅ M3-1：消费 M2-2 同一份 Artifact，不再二次 render
            return await renderMergeGroupToPrintImage(artifact, group, jobKey)
          }
          return await renderFileToPrintImage(task.data || task, ipc)
        } catch (error) {
          console.error('渲染失败:', task.name || task.data?.name, error)
          return null
        }
      }
      // 包装合并打印函数
      const mergedPrintFn = async (images, ctx) => {
        const printOptions = { ...settings, landscape: forcedLandscape }
        return await printMergedImages(images, ipc, printOptions)
      }

      // 委托给 PrintRunner 执行
      const { results, mergedResult } = await runMergedPrintTasks(
        queue.pending,
        renderFn,
        mergedPrintFn,
        { signal, batchSize: PRINT_BATCH_SIZE }
      )

      if (signal.aborted) return

      // 处理结果 → React 状态
      const completed = results.filter(r => r.success)
      const failed = results.filter(r => !r.success)
      queue.completed = completed
      queue.failed = failed

      // 队列完成
      if (printTimeoutRef.current) clearTimeout(printTimeoutRef.current)
      isPrintingRef.current = false
      setPrinting(false)
      setPrintProgress({})

      // 更新文件状态
      setFiles((prev) => prev.map((f) => {
        if (f.status === 'printing') {
          return { ...f, status: 'parsed' }
        }
        return f
      }))

      // 显示结果摘要
      const compLen = queue.completed ? queue.completed.length : 0
      const failLen = queue.failed ? queue.failed.length : 0
      if (failLen > 0) {
        setAlertModal({
          visible: true,
          title: '打印完成（部分失败）',
          message: `成功: ${compLen} 个，失败: ${failLen} 个`,
          type: 'warning',
        })
      } else if (completed.length > 0) {
        setAlertModal({
          visible: true,
          title: '打印完成',
          message: `已发送 ${completed.length} 个文件到打印队列`,
          type: 'success',
        })
      }
    }

    processQueue()
  }, [files, settings, setAlertModal, setPrintProgress, setPrinting, setFiles, setPrintFilesAndRef, updateQueueStatus, renderFileToPrintImage, renderMergeGroupToPrintImage])

  // 触发打印：仅当 PRINT_PIPELINE_V2=false 时生效（legacy fallback）
  // V2 模式下此 effect 永不触发，doPrint 只能通过 executeLegacyPrint 显式调用
  useEffect(() => {
    if (triggerPrint) {
      setTriggerPrint(false)
      if (!PRINT_PIPELINE_V2) {
        console.log('[PRINT] Legacy triggerPrint → doPrint()')
        doPrint()
      }
    }
  }, [triggerPrint, doPrint])


  /**
   * 打印单个源文件（调用 IPC 直通 Sumatra，不管理全局进度）
   * 用于批量场景中逐文件调用
   */
  const printSingleSourceFile = useCallback(async (f, printSettings) => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return { success: false, error: 'IPC 不可用' }

    // IMAGE + OFD PIPELINE (2026-08-21 Fix): 图片/OFD → 后端 /print_pdf → 临时 PDF → SumatraPDF。
    // OFD 转换为图片后本质就是图片，统一走图片管线保证行为一致。
    // 原因：SumatraPDF 原生直送图片文件时不做方向判断，横向发票可能按竖向打印。
    // 通过后端 /print_pdf 端点，用 PrintAutoRotationPolicy 决定旋转后嵌入 A4 PDF，
    // 再将 PDF 直送 SumatraPDF，获得与 PDF 管线一致的旋转行为。
    if (isImageLikeFormat(f.fileFormat)) {
      const userSettings = { ...settings, ...(printSettings || {}) }
      const contentRotation = fileRotations[f.key] || 0
      const r = await printImageAsPdf(f, ipc, userSettings, contentRotation)
      return { success: !!r?.success, message: r?.error || '', error: r?.error || null }
    }

    // 合并 settings + printSettings 作为 userSettings
    const userSettings = { ...settings, ...(printSettings || {}) }
    // C-2 Step 4-1：优先消费 job 携带的 Plan truth（deriveSourcePrintJobs 从 plan 搬运）；
    // placements[f.key]（useMemo 独立计算）仅作非 plan 路径回退——Plan 是唯一 geometry authority。
    const filePlacement = f?.placement ?? placements[f.key] ?? null
    const executionPaper = f?.paper ?? null

    const result = await printSingleSource(f, ipc, userSettings, fileRotations, detectDocumentOrientation, filePlacement, executionPaper)

    return {
      success: result.success,
      message: result.error || '',
      error: result.error || null,
    }
  }, [settings, fileRotations, electronAPIRef, detectDocumentOrientation, placements, printImageAsPdf])

  /**
   * 批量打印（source 管线），管理总进度
   */
  const printAllSourceFiles = useCallback(async (filesToPrint, printSettings) => {
    if (filesToPrint.length === 0) return
    const completed = []
    const failed = []

    setPrinting(true)
    setPrintFilesAndRef(filesToPrint.map(f => ({ key: f._jobKey || f.key, name: f.name })))
    const init = {}
    for (const f of filesToPrint) {
      const trackKey = f._jobKey || f.key
      init[trackKey] = { status: 'waiting' }
    }
    setPrintProgress(init)

    for (const f of filesToPrint) {
      const trackKey = f._jobKey || f.key
      setPrintProgress(prev => ({ ...prev, [trackKey]: { status: 'printing' } }))
      try {
        const result = await printSingleSourceFile(f, printSettings)
        if (result?.success) {
          setPrintProgress(prev => ({ ...prev, [trackKey]: { status: 'done' } }))
          completed.push(f)
        } else {
          const msg = result?.message || result?.error || '打印失败'
          setPrintProgress(prev => ({ ...prev, [trackKey]: { status: 'error', error: msg } }))
          failed.push(f)
        }
      } catch (err) {
        setPrintProgress(prev => ({ ...prev, [trackKey]: { status: 'error', error: err?.message || '未知异常' } }))
        failed.push(f)
      }
    }

    setPrinting(false)

    // ✅ 打印完成，释放 L2 缓存（~1GB 峰值），保留 L1 加速下次预览重建
    try {
      const renderers = await getPrintRenderers()
      if (renderers.clearRenderCache) renderers.clearRenderCache()
      console.log('[Cache] L2 cleared after print.')
    } catch (_) {}

    return { completed: completed.length, failed: failed.length }
  }, [printSingleSourceFile])

  /**
   * 显示打印完成摘要
   */
  const showPrintSummary = useCallback((completed, failed) => {
    if (failed > 0) {
      setAlertModal({
        visible: true, title: '打印完成（部分失败）',
        message: `成功: ${completed} 个，失败: ${failed} 个`, type: 'warning',
      })
    } else {
      setAlertModal({
        visible: true, title: '打印完成',
        message: `已发送 ${completed} 个文件到打印队列`, type: 'success',
      })
    }
  }, [setAlertModal])

  // ═══════════════════════════════════════════════════════════
  // executePrint — 唯一打印执行入口 (Step 3.2)
  // V2 orchestration: load → render (pure) → submit
  // ═══════════════════════════════════════════════════════════
  const executePrint = useCallback(async (previewFile, printSettings) => {
    // ✅ 合并模式：委托给 doPrint()
    const mergeMode = settings.mergeMode || 'none'
    if (isMergeMode(mergeMode)) {
      console.log('[PRINT] Merge mode detected → doPrint()')
      return doPrint()
    }

    const allParsed = files.filter(f => f.status === 'parsed' && (f.printPath || f.path))
    if (allParsed.length === 0) return

    // ── Source 管线：批量打印所有已解析文件 ──
    if (PRINT_PIPELINE.mode === 'source') {
      // A1/A1.5：buildPrintExecutionPlan 已证与旧逻辑等价，作为本分支唯一事实来源。
      // 旧 source 消费逻辑（allParsed / specialFiles / mergedJobs）已固化为
      // buildLegacyPrintPlan（Legacy Oracle），不在此重复、不删除（待 Commit 3 + A2 Gate 前清理）。
      // Commit 1：与 Preview 共用 createPrintPlanInput（非 merge 模式 → SOURCE_FILE_FILTER）
      const { files: planFiles, options: planOptions } = createPrintPlanInput(files, settings, fileRotations)
      const plan = buildPrintExecutionPlan(planFiles, planOptions)

      // 影子比较（仅 DEV + 手动开关；绝不进 production）：
      //  1) 模型等价：新 plan vs Legacy Oracle（buildLegacyPrintPlan）
      //  2) 消费序列等价：plan 派生的 job _jobKey 序列 vs Legacy 派生序列
      //     —— 防止 executor 漏消费 plan 字段（即使 plan 等价，映射成 job 仍可能错位）
      if (printPlanCompareEnabled()) {
        compareLegacyPlan(plan, { files, settings, fileRotations })
        const legacyPlan = buildLegacyPrintPlan(files, { settings, fileRotations })
        const planKeys = deriveSourcePrintJobs(plan, files).map(j => j._jobKey)
        const legacyKeys = deriveSourcePrintJobs(legacyPlan, files).map(j => j._jobKey)
        if (JSON.stringify(planKeys) !== JSON.stringify(legacyKeys)) {
          console.warn('[PRINT PLAN COMPARE] executor job sequence mismatch',
            '\nplan  :', planKeys, '\nlegacy:', legacyKeys)
        }
      }

      // 新消费路径：从 plan 派生真实执行 jobs（替代旧 mergedJobs / allParsed 直传）。
      const planJobs = deriveSourcePrintJobs(plan, files)
      if (settings.extraSpecial) {
        console.log('[PRINT] 一普二专(plan): %d 个任务（第1轮%d + 第2轮%d）',
          planJobs.length, plan.pages.length, plan.extraPages.length)
      } else {
        console.log('[PRINT] Source(plan) → 批量打印 %d 个文件', plan.pages.length)
      }
      const r = await printAllSourceFiles(planJobs, printSettings)
      showPrintSummary(r.completed, r.failed)
      return
    }

  // Legacy V2 pipeline (PRINT_PIPELINE.mode === 'legacy')
  console.log('[PRINT] Legacy V2 router → orchestrate')

    // ── 1. Locate file ──
    if (!previewFile) return
    const file = files.find(f => f.key === previewFile.key)
    if (!file) {
      console.error('[print] File not found in files[]:', previewFile.key)
      return
    }

    // ── Show progress bar ──
    setPrinting(true)
    setPrintFilesAndRef([{ key: file.key, name: file.name }])
    setPrintProgress({ [file.key]: { status: 'printing' } })

    const failProgress = (errorMsg) => {
      setPrintProgress(prev => ({
        ...prev,
        [file.key]: { status: 'error', error: errorMsg },
      }))
    }

    try {
      // ── 2. Direct print check ──
      const filePath = file.printPath || file.path
      if (canDirectPrint(filePath)) {
        console.log('[PRINT] Direct print mode for:', filePath)
        const ipc = electronAPIRef.current
        const result = await ipc.ipcRenderer.invoke('print-file-direct', {
          filePath,
          settings: printSettings,
        })

        if (!result?.success) {
          console.error('[print] Direct print failed:', result?.message)
          failProgress(result?.message || '直接打印失败')
          return
        }

        console.log('[PRINT] Direct print submitted, jobId:', result.jobId)
          setCurrentJobId(result.jobId)
          // 等待事件通知完成/失败
          return
      }

      // ── 3. Load binary via IPC ──
      const ipc = electronAPIRef.current
      const fileData = await ipc.ipcRenderer.invoke('read-file', filePath)
        if (!fileData?.success) {
          console.error('[print] Failed to read file:', file.printPath)
          failProgress('文件读取失败')
          return
        }

        // ── 3. Build DTO items (clean, no underscore prefixes) ──
        const dtoItems = []
        if (file.fileFormat === 'pdf' || (!file.fileFormat && !file.previewImage)) {
          dtoItems.push({ key: file.key, name: file.name, fileFormat: 'pdf', pdfData: new Uint8Array(fileData.data) })
        } else {
          const blob = new Blob([fileData.data])
          const blobUrl = URL.createObjectURL(blob)
          dtoItems.push({ key: file.key, name: file.name, fileFormat: file.fileFormat || 'image', imageUrl: blobUrl })
        }

        // ── 4. Build RenderModel (contract layer) ──
        const renderModel = buildRenderModel(
          { items: dtoItems },
          {
            paperSize: printSettings.paperSize || 'A4',
            landscape: printSettings.landscape || false,
            rotations: { [file.key]: fileRotations[file.key] || 0 },
            slotCount: 1,
          }
        )
        if (!renderModel) {
          console.error('[print] buildRenderModel returned null')
          failProgress('渲染模型构建失败')
          return
        }

        // ── 4.1 Validate RenderModel (fail fast) ──
        const validation = validateRenderModel(renderModel)
        if (!validation.valid) {
          console.error('[print] RenderModel validation failed:', validation.errors)
          failProgress('渲染校验失败: ' + (validation.errors?.join('; ') || '未知'))
          return
        }

        // ── 5. Pure render (printRenderer.js) ──
        const canvasBuffer = await renderPrintContent(renderModel)
        if (!canvasBuffer) {
          console.error('[print] renderPrintContent returned null')
          failProgress('渲染失败')
          return
        }

        // ── 6. Submit via print pipeline ──
        const result = await submitPrintIntent({
          canvasBuffer,
          paperSize: printSettings.paperSize,
          orientation: printSettings.landscape ? 'landscape' : 'portrait',
          printerName: printSettings.printerName,
          customPaper: printSettings.customPaper,
        })

        if (result?.success) {
          setPrintProgress(prev => ({
            ...prev,
            [file.key]: { status: 'done' },
          }))
          setTimeout(() => {
            setPrinting(false)
            setPrintProgress({})
            setAlertModal({ visible: true, title: '打印成功', message: '已发送至打印机队列', type: 'success' })
          }, 1200)
        } else {
          failProgress(result?.message || '打印失败')
        }
      } catch (err) {
        console.error('[print] executePrint V2 error:', err)
        failProgress(err?.message || '未知异常')
      }
  }, [files, fileRotations, settings, electronAPIRef, submitPrintIntent, doPrint])

  const cancelPrint = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    isPrintingRef.current = false
    setPrinting(false)
    setPrintProgress({})
    printQueueRef.current = { pending: [], printing: [], completed: [], failed: [] }
    setFiles((prev) => prev.map((f) => f.status === 'printing' ? { ...f, status: 'parsed' } : f))
    if (printTimeoutRef.current) {
      clearTimeout(printTimeoutRef.current)
      printTimeoutRef.current = null
    }
  }, [setFiles])

  const closeAlert = useCallback(() => setAlertModal(null), [])

  // ── 监听直接打印结果事件 ──
  useEffect(() => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return

    const handlePrintCompleted = (event, { jobId }) => {
      console.log('[PRINT] Direct print completed, jobId:', jobId)
      if (jobId === currentJobId) {
        setPrintProgress(prev => {
          const keys = Object.keys(prev)
          if (keys.length > 0) {
            return { ...prev, [keys[0]]: { status: 'done' } }
          }
          return prev
        })
        setCurrentJobId(null)
        setTimeout(() => {
          setPrinting(false)
          setPrintProgress({})
          setAlertModal({ visible: true, title: '打印成功', message: '已发送至打印机队列', type: 'success' })
        }, 1200)
      }
    }

    const handlePrintFailed = (event, { jobId, message }) => {
      console.error('[PRINT] Direct print failed, jobId:', jobId, 'message:', message)
      if (jobId === currentJobId) {
        setPrintProgress(prev => {
          const keys = Object.keys(prev)
          if (keys.length > 0) {
            return { ...prev, [keys[0]]: { status: 'error', error: message } }
          }
          return prev
        })
        setCurrentJobId(null)
      }
    }

    ipc.on('print-job-completed', handlePrintCompleted)
    ipc.on('print-job-failed', handlePrintFailed)

    return () => {
      ipc.removeListener('print-job-completed', handlePrintCompleted)
      ipc.removeListener('print-job-failed', handlePrintFailed)
    }
  }, [electronAPIRef, currentJobId])

  // ── 组件卸载清理（内存泄漏修复） ──
  useEffect(() => {
    return () => {
      // 清理所有未释放的 blob URL
      pendingBlobUrlsRef.current.forEach(url => {
        try {
          URL.revokeObjectURL(url)
        } catch (e) {
          // 忽略已失效的 URL
        }
      })
      pendingBlobUrlsRef.current = []
    }
  }, [])

  return {
    printing, setPrinting,
    printProgress, setPrintProgress,
    printFiles, setPrintFiles: setPrintFilesAndRef,
    printTimeoutRef, printFilesRef,
    printQueueStatus,
    alertModal, closeAlert,
    printConfirmModal,
    printPreviewModel,
    mergeArtifacts,  // ✅ M2-2：Merge-only Final Artifact（仅 Merge 模式非空；Normal 恒 null）
    handlePrint: handlePrintShowConfirm, handlePrintConfirm, handlePrintCancel,
    handlePrintClose, clearPrintState,
    cancelPrint,
    executePrint,  // Step 3.2: 唯一打印执行入口
  }
}
