import { useState, useCallback, useRef, useEffect } from 'react'
// 显式 .js 扩展名：与 documentViewModel.js 等模块保持一致，
// 并使本模块可被 node --test 原生 ESM 直接加载（无需 vite 解析）。
import { groupFilesByDocument } from '../utils/groupDocuments.js'
import { buildDocumentPageNames, dedupeExportNames, getDocumentPages } from '../layout/docFacts.js'

function buildInvoiceFields(f) {
  // 兼容两种命名：invoiceFields（驼峰）和 invoice_fields（下划线）
  // 顶层字段（invoiceType/invoiceNumber/invoiceDate）也作为回退
  const inv = f.invoiceFields || f.invoice_fields || {}
  return {
    type: f.invoiceType || inv.type || '',
    fphm: f.invoiceNumber || inv.fphm || '',
    kprq: f.invoiceDate || inv.kprq || '',
    gmfmc: inv.gmfmc || f.buyerName || '',
    gmfsh: inv.gmfsh || f.buyerTaxNo || '',
    xsfmc: inv.xsfmc || f.sellerName || '',
    xsfsh: inv.xsfsh || f.sellerTaxNo || '',
    amountJe: inv.amountJe || f.amountWithoutTax || '',
    amountSe: inv.amountSe ?? f.taxAmount ?? '',
    amountHj: inv.amountHj || f.amount || f.totalAmount || '',
    amountHjDx: inv.amountHjDx || '',
    note: inv.note || '',
    skr: inv.skr || '',
    fhr: inv.fhr || '',
    kpr: inv.kpr || f.issuer || '',
  }
}

/**
 * 选择重命名的作用单位 = InvoiceDocument（业务实体），而非 File/Page。
 *
 * 为什么不再由本域自行 group：
 *   旧实现 collectDocumentLevelFiles 调 groupFilesByDocument(files)，按 f.docId 归组。
 *   但 hydrateChunk 会把每页 docId 改写成各自的物理内容哈希（为修预览 URL 而加，
 *   不应回滚），于是同票多页在 Rename 域裂成 N 条，且每条携带各自页的 amount
 *   （首页 1000 / 末页 300）——这正是「文件列表 1 条、重命名预览 2 条且金额不同」
 *   的直接成因。装配阶段产出的 InvoiceDocument 用 _pageKeys 记录页成员（强身份），
 *   是唯一可信的文档边界来源。
 *
 * documentRows 来自 FileContext.documentView.documents，与侧栏 / 预览 / Excel 导出
 * 同源，从结构上杜绝 Rename 域再次与展示域漂移。
 *
 * 为什么不用 App 的 displayFiles：displayFiles 在搜索态会退回 page-level
 * filteredFiles。重命名的作用域是全量文档，不应被搜索框缩小或降级。
 *
 * fallback：仅当装配结果不可用（历史 session / 装配未完成）时退回旧分组，
 * 使 groupFilesByDocument 从主流程降级为兼容路径。
 *
 * @param {Object[]|null} documentRows - document 级条目（documentView.documents）
 * @param {Object[]} files - page-level fileObj 数组（仅 fallback 时使用）
 * @returns {Object[]} 已解析的 document 级条目
 */
export function selectRenameDocuments(documentRows, files) {
  const rows = Array.isArray(documentRows) && documentRows.length > 0
    ? documentRows
    : groupFilesByDocument(files || [])
  return rows.filter(f => f?.status === 'parsed')
}

/**
 * 收集打包目标：以 InvoiceDocument 为单位，展开为「文档 → 页面清单」。
 *
 * 为什么不直接用 selectRenameDocuments：
 *   打包的产物是**物理文件**，必须逐页落盘；而 document 条目只代表业务实体。
 *   若只打包 document 的代表页，多页发票会真的丢页。
 *
 * 孤儿页兜底（关键护栏）：
 *   若某个已解析页面不属于任何 InvoiceDocument（装配未覆盖 / 历史 session /
 *   装配异常），它仍会作为单页目标补入。
 *   不变式：**输出的页面总数 ≥ 旧实现 files.filter(parsed) 的数量**，
 *   即引入 document 聚合不会让任何文件从压缩包里消失。
 *
 * @param {Object[]|null} documentRows
 * @param {Object[]} files
 * @returns {Array<{doc:Object, pages:Object[], orphan?:boolean}>}
 */
export function collectPackTargets(documentRows, files) {
  const documents = selectRenameDocuments(documentRows, files)
  const covered = new Set()
  const targets = []

  for (const doc of documents) {
    const pages = getDocumentPages(doc).filter(Boolean)
    if (pages.length === 0) continue
    targets.push({ doc, pages })
    for (const p of pages) {
      if (p?.key) covered.add(p.key)
    }
  }

  for (const f of files || []) {
    if (f?.status !== 'parsed' || !f.key || covered.has(f.key)) continue
    targets.push({ doc: f, pages: [f], orphan: true })
    covered.add(f.key)
  }

  return targets
}

export function useRenamePack({ files, documentRows, settings, setFiles, parseFiles, parseProgress, electronAPIRef }) {
  const [packing, setPacking] = useState(false)
  const [packProgress, setPackProgress] = useState({ current: 0, total: 0 })
  const [packResult, setPackResult] = useState(null)
  const [renamePreviewVisible, setRenamePreviewVisible] = useState(false)
  const [renamePreviewFiles, setRenamePreviewFiles] = useState([])
  const [renameResult, setRenameResult] = useState(null)
  const [renameRulesWarning, setRenameRulesWarning] = useState(null)
  const [alertModal, setAlertModal] = useState(null)
  const [reimporting, setReimporting] = useState(false)
  const [reimportProgress, setReimportProgress] = useState(null)
  const [renamedPreviewKey, setRenamedPreviewKey] = useState(null)
  const computedNamesRef = useRef({})
  const previewDocumentMapRef = useRef(new Map())

  const reimportingRef = useRef(false)
  useEffect(() => {
    if (!reimportingRef.current) return
    if (parseProgress.total > 0 && parseProgress.current !== undefined) {
      setReimportProgress(
        Math.round((parseProgress.current / parseProgress.total) * 100)
      )
    }
  }, [parseProgress])

  const latestFilesRef = useRef(files)
  const latestSettingsRef = useRef(settings)
  // documentRows 与 files 一样走 ref：generatePreviewInner / handleRename 的
  // useCallback 依赖列表刻意不含数据，靠 ref 读取最新值以避免回调身份频繁变化。
  const latestDocumentRowsRef = useRef(documentRows)
  useEffect(() => { latestFilesRef.current = files }, [files])
  useEffect(() => { latestSettingsRef.current = settings }, [settings])
  useEffect(() => { latestDocumentRowsRef.current = documentRows }, [documentRows])

  const buildPreviewFilesFromDocuments = useCallback((documentFiles, previews) => {
    const fileMap = new Map(documentFiles.map(f => [f.key, f]))
    const previewFiles = previews.map(p => {
      const f = fileMap.get(p.key)
      const inv = f?.invoiceFields || f?.invoice_fields || {}
      return {
        key: p.key,
        originalName: p.originalName,
        newName: p.newName,
        conflict: false,
        fileFormat: f?.fileFormat || 'pdf',
        invoiceNumber: f?.invoiceNumber || '',
        invoiceType: f?.invoiceType || '',
        amount: f?.amount || '',
        invoiceDate: f?.invoiceDate || '',
        rawText: f?.rawText || '',
        gmfmc: inv.gmfmc || f?.buyerName || '',
        xsfmc: inv.xsfmc || f?.sellerName || '',
        xmmc: inv.xmmc || '',
        note: inv.note || '',
        _pageCount: f?._pageCount || 1,
      }
    })

    const nameCount = new Map()
    for (const file of previewFiles) {
      nameCount.set(file.newName, (nameCount.get(file.newName) || 0) + 1)
    }
    for (const file of previewFiles) {
      if (nameCount.get(file.newName) > 1) file.conflict = true
    }

    const nameMap = {}
    const docMap = new Map()
    for (let i = 0; i < previewFiles.length; i++) {
      const p = previewFiles[i]
      const doc = documentFiles[i]
      const base = p.newName.replace(/\.\w+$/, '')
      nameMap[p.key] = base
      docMap.set(p.key, doc)
    }
    computedNamesRef.current = nameMap
    previewDocumentMapRef.current = docMap

    return previewFiles
  }, [])

  const generatePreviewInner = useCallback(async () => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return false
    const curFiles = latestFilesRef.current
    const curSettings = latestSettingsRef.current

    const documentFiles = selectRenameDocuments(latestDocumentRowsRef.current, curFiles)
    if (documentFiles.length === 0) return false

    const renameSettings = curSettings.renameSettings || {}
    const fields = renameSettings.fields || []
    if (fields.length === 0) {
      const previews = documentFiles.map(f => ({
        key: f.key,
        originalName: f.name,
        newName: f.name,
      }))
      const previewFiles = buildPreviewFilesFromDocuments(documentFiles, previews)
      setRenamePreviewFiles(previewFiles)
      setRenameRulesWarning('重命名规则未设置，请到设置中设置重命名规则')
      return false
    }

    setRenameRulesWarning(null)

    const filesForPreview = documentFiles.map(f => ({
      key: f.key,
      name: f.name,
      originalPath: f.printPath || f.path || '',
      invoiceFields: buildInvoiceFields(f),
    }))

    let previews
    try {
      const result = await ipc.invoke('preview-rename-names', {
        files: filesForPreview,
        renameSettings,
      })
      previews = result.previews || []
    } catch (e) {
      console.error('[rename] Preview refresh failed:', e.message)
      previews = documentFiles.map(f => ({
        key: f.key,
        originalName: f.name,
        newName: f.name,
      }))
    }

    const previewFiles = buildPreviewFilesFromDocuments(documentFiles, previews)
    setRenamePreviewFiles(previewFiles)
    return true
  }, [electronAPIRef, buildPreviewFilesFromDocuments])

  const refreshRenamePreview = useCallback(() => {
    setRenameResult(null)
    setRenameRulesWarning(null)
    computedNamesRef.current = {}
    previewDocumentMapRef.current = new Map()
    generatePreviewInner()
  }, [generatePreviewInner])


  const handleRename = useCallback(async () => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return

    const curFiles = latestFilesRef.current
    const curSettings = latestSettingsRef.current
    const documentFiles = selectRenameDocuments(latestDocumentRowsRef.current, curFiles)

    if (documentFiles.length === 0) {
      setAlertModal({
        visible: true,
        title: '提示',
        message: '没有可重命名的发票，请先解析完成',
        type: 'warning',
      })
      return
    }

    const renameSettings = curSettings.renameSettings || {}
    const fields = renameSettings.fields || []
    if (fields.length === 0) {
      const previews = documentFiles.map(f => ({
        key: f.key,
        originalName: f.name,
        newName: f.name,
      }))
      const previewFiles = buildPreviewFilesFromDocuments(documentFiles, previews)
      setRenamePreviewFiles(previewFiles)
      setRenameRulesWarning('重命名规则未设置，请到设置中设置重命名规则')
      setRenameResult(null)
      setRenamePreviewVisible(true)
      return
    }

    setRenameRulesWarning(null)

    const cachedNames = computedNamesRef.current
    const hasValidCache = cachedNames && Object.keys(cachedNames).length > 0 &&
      documentFiles.every(f => cachedNames[f.key] !== undefined)

    let previews
    if (hasValidCache) {
      previews = documentFiles.map(f => {
        const ext = (f.name || '').match(/\.\w+$/)?.[0] || '.pdf'
        return {
          key: f.key,
          originalName: f.name,
          newName: cachedNames[f.key] + ext,
        }
      })
    } else {
      const filesForPreview = documentFiles.map(f => ({
        key: f.key,
        name: f.name,
        originalPath: f.printPath || f.path || '',
        invoiceFields: buildInvoiceFields(f),
      }))

      try {
        const result = await ipc.invoke('preview-rename-names', {
          files: filesForPreview,
          renameSettings,
        })
        previews = result.previews || []
      } catch (e) {
        console.error('[rename] Preview failed, falling back:', e.message)
        previews = documentFiles.map(f => ({
          key: f.key,
          originalName: f.name,
          newName: f.name,
        }))
      }
    }

    const previewFiles = buildPreviewFilesFromDocuments(documentFiles, previews)
    setRenamePreviewFiles(previewFiles)
    setRenamePreviewVisible(true)
  }, [electronAPIRef, buildPreviewFilesFromDocuments])

  const handleRenameConfirm = useCallback(async (selectedKeys) => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return

    setPacking(true)
    setPackProgress({ current: 0, total: selectedKeys.length })

    const onProgress = (event, progress) => { setPackProgress(progress) }
    ipc.on('rename-progress', onProgress)

    try {
      const curFiles = latestFilesRef.current
      const curSettings = latestSettingsRef.current
      const renameSettings = curSettings.renameSettings || {}

      const cachedNames = computedNamesRef.current
      const docMap = previewDocumentMapRef.current

      const allFilesToRename = []
      const fileKeyToOriginalPath = new Map()

      for (const key of selectedKeys) {
        const doc = docMap.get(key)
        if (!doc) continue

        const newBaseName = cachedNames[key]
        if (!newBaseName) continue

        // 单页 / 多页走同一条路径：buildDocumentPageNames 对单页文档返回单元素、
        // 无后缀，行为与旧的 else 分支等价。页码后缀规则集中在 docFacts，
        // 与 Pack 域共用同一函数，杜绝「Rename 叫 _p2 / Pack 叫 _1」的漂移。
        for (const pn of buildDocumentPageNames(doc, newBaseName)) {
          if (!pn.originalPath.match(/^[a-zA-Z]:\\|^\\\\/)) continue
          allFilesToRename.push({
            key: pn.key,
            originalPath: pn.originalPath,
            newBaseName: pn.targetBaseName,
          })
          fileKeyToOriginalPath.set(pn.originalPath.toLowerCase().replace(/\\/g, '/'), pn.key)
        }
      }

      if (allFilesToRename.length === 0) {
        setAlertModal({
          visible: true,
          title: '路径错误',
          message: '没有可重命名的有效文件',
          type: 'warning',
        })
        setPacking(false)
        ipc.removeListener('rename-progress', onProgress)
        return
      }

      const result = await ipc.invoke('rename-invoices', {
        files: allFilesToRename,
        renameSettings,
      })
      ipc.removeListener('rename-progress', onProgress)
      setPacking(false)

      if (result.success) {
        if (result.renamedFiles && result.renamedFiles.length > 0) {
          const renamedByKey = new Map()
          for (const rf of result.renamedFiles) {
            if (rf.partialSuccess) continue
            const normalizedOrig = rf.originalPath.toLowerCase().replace(/\\/g, '/')
            const fkey = fileKeyToOriginalPath.get(normalizedOrig)
            if (fkey) {
              renamedByKey.set(fkey, rf)
            }
          }

          setFiles(prev => prev.map(f => {
            const renamed = renamedByKey.get(f.key)
            if (!renamed) return f
            return {
              ...f,
              name: renamed.newName,
              // 查询主键同步：重命名后 DB file_name = newName（后端 rename_invoices_by_filename 已更新），
              // originalName 必须同步为新名，否则 InvoiceDetail/InvoiceDock/导出确认页用旧名查后端 → 404/空 rows。
              originalName: renamed.newName,
              path: renamed.newPath,
              printPath: renamed.newPath,
              newName: renamed.newName,
              searchText: f.searchText,
            }
          }))

          const firstRenamedKey = allFilesToRename[0]?.key || null
          setRenamedPreviewKey(firstRenamedKey)
        }
        const partialFiles = (result.renamedFiles || []).filter(f => f.partialSuccess)
        setRenameResult({
          success: true,
          renamed: result.renamed,
          failed: result.failed,
          partialCount: partialFiles.length,
        })
      } else {
        setRenameResult({ success: false, error: result.error })
      }
    } catch (error) {
      ipc.removeListener('rename-progress', onProgress)
      setPacking(false)
      setRenameResult({ success: false, error: error.message })
    }
  }, [electronAPIRef, setFiles])

  const handlePack = useCallback(async () => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return

    const curFiles = latestFilesRef.current
    const curSettings = latestSettingsRef.current

    // 以 InvoiceDocument 为单位收集，再展开到页；孤儿页由 collectPackTargets 兜底补入。
    const targets = collectPackTargets(latestDocumentRowsRef.current, curFiles)
    const totalPages = targets.reduce((n, t) => n + t.pages.length, 0)
    if (totalPages === 0) {
      setAlertModal({
        visible: true,
        title: '提示',
        message: '没有可打包的文件',
        type: 'warning',
      })
      return
    }

    setPacking(true)
    setPackResult(null)
    setPackProgress({ current: 0, total: totalPages, stage: '准备中', currentFile: '' })

    const onProgress = (event, progress) => {
      setPackProgress(prev => ({ ...prev, ...progress, stage: progress.stage || prev.stage || '' }))
    }
    ipc.on('pack-progress', onProgress)

    try {
      const packSettings = curSettings.packSettings || {}
      const renameSettings = curSettings.renameSettings || {}
      const renameBeforeArchive = packSettings.packRenameBeforeArchive ?? false

      // ── 文件名由 Document 域生成，主进程不再自行猜名 ──
      // 只在需要重命名时才请求 base name；preview-rename-names 是纯计算、无副作用，
      // 与重命名预览走同一套规则，保证「预览看到什么、压缩包里就是什么」。
      let baseNames = []
      if (renameBeforeArchive) {
        const previewInput = targets.map((t, i) => ({
          key: `pack_${i}`,
          name: t.doc.name,
          originalPath: t.doc.printPath || t.doc.path || '',
          invoiceFields: buildInvoiceFields(t.doc),
        }))
        try {
          const previewResult = await ipc.invoke('preview-rename-names', {
            files: previewInput,
            renameSettings,
          })
          const byKey = new Map((previewResult?.previews || []).map(p => [p.key, p.newName]))
          baseNames = targets.map((_, i) => {
            const newName = byKey.get(`pack_${i}`)
            return newName ? newName.replace(/\.\w+$/, '') : null
          })
        } catch (e) {
          // 取名失败不应导致打包失败：降级为保留原文件名（不重命名）。
          console.error('[pack] 生成文件名失败，降级为原名打包:', e.message)
          baseNames = []
        }
      }

      let filesToPack = []
      targets.forEach((t, i) => {
        const base = baseNames[i]
        if (base) {
          for (const pn of buildDocumentPageNames(t.doc, base)) {
            filesToPack.push({
              name: pn.originalName,
              printPath: pn.originalPath,
              targetName: pn.targetName,
            })
          }
        } else {
          // 不重命名（或取名失败）→ 原样打包，逐页保留各自原文件名
          for (const page of t.pages) {
            filesToPack.push({
              name: page.name,
              path: page.path,
              printPath: page.printPath,
              targetName: page.name,
            })
          }
        }
      })

      // 业务层跨文档消歧：仅当「由我们生成文件名」时做。
      // 此时 zip 内若仍重名（如规则字段全空回退「未命名发票」），属于真正的命名缺陷，
      // 由 dedupeExportNames 兜底成唯一名，严格模式不会误伤整批；
      // 非重命名场景保留源文件原名（可能跨文件夹同名），交给 archive 层 lenient 去重，
      // 这是用户明确认可的合法用例，不应强制改名。
      if (renameBeforeArchive) {
        filesToPack = dedupeExportNames(filesToPack)
      }

      const result = await ipc.invoke('pack-invoices', {
        files: filesToPack,
        packSettings,
        renameSettings,
        // 仅「重命名打包」场景声明 targetName 已由 Document 域算好并保证唯一：
        // 主进程据此启用严格模式，出现重名直接失败，让上游命名缺陷立刻暴露。
        // 非重命名场景 namesResolved=false → lenient 模式，跨文件夹同名可接受。
        namesResolved: renameBeforeArchive,
      })
      ipc.removeListener('pack-progress', onProgress)

      if (result.success || result.error === '用户取消选择') {
        const keepOriginal = packSettings.packKeepOriginal ?? true
        const newResult = { ...result, success: result.success || false, keepOriginal }
        setPackResult(newResult)
        setPacking(false)

        if (result.success && !keepOriginal) {
          setFiles([])
        }
      } else {
        setPackResult({ ...result, success: false })
      }
    } catch (error) {
      ipc.removeListener('pack-progress', onProgress)
      // setPacking(false) 原先缺失：异常后打包按钮会永久 disabled。
      // 严格命名模式使主进程抛错成为可达路径，此处必须复位。
      setPacking(false)
      setPackResult({ success: false, error: error.message })
    }
    // files / settings / documentRows 均通过 ref 读取最新值，
    // 不进依赖列表，保持回调身份稳定（与 handleRename 一致）。
  }, [electronAPIRef, setFiles])

  const closeAlert = useCallback(() => setAlertModal(null), [])

  return {
    packing, setPacking,
    packProgress, setPackProgress,
    packResult, setPackResult,
    reimporting,
    reimportProgress,
    renamePreviewVisible, setRenamePreviewVisible,
    renamePreviewFiles, setRenamePreviewFiles,
    renameResult, setRenameResult,
    renameRulesWarning, setRenameRulesWarning,
    alertModal, closeAlert,
    renamedPreviewKey,
    handleRename, handleRenameConfirm, handlePack,
    refreshRenamePreview,
  }
}
