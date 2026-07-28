import { useState, useCallback, useRef, useEffect } from 'react'
import { groupFilesByDocument } from '../utils/groupDocuments'

function buildInvoiceFields(f) {
  if (f.invoiceFields && Object.keys(f.invoiceFields).length > 0) {
    return f.invoiceFields
  }
  return {
    type: f.invoiceType || '',
    fphm: f.invoiceNumber || '',
    kprq: f.invoiceDate || '',
    gmfmc: f.invoiceFields?.gmfmc || '',
    gmfsh: f.invoiceFields?.gmfsh || '',
    xsfmc: f.invoiceFields?.xsfmc || '',
    xsfsh: f.invoiceFields?.xsfsh || '',
    amountJe: f.invoiceFields?.amountJe || '',
    amountSe: f.invoiceFields?.amountSe || '',
    amountHj: f.invoiceFields?.amountHj || f.amount || '',
    amountHjDx: f.invoiceFields?.amountHjDx || '',
    note: f.invoiceFields?.note || '',
    skr: f.invoiceFields?.skr || '',
    fhr: f.invoiceFields?.fhr || '',
    kpr: f.invoiceFields?.kpr || '',
  }
}

function collectDocumentLevelFiles(files) {
  const documentFiles = groupFilesByDocument(files)
  return documentFiles.filter(f => f.status === 'parsed')
}

export function useRenamePack({ files, settings, setFiles, parseFiles, parseProgress, electronAPIRef }) {
  const [packing, setPacking] = useState(false)
  const [packProgress, setPackProgress] = useState({ current: 0, total: 0 })
  const [packResult, setPackResult] = useState(null)
  const [renamePreviewVisible, setRenamePreviewVisible] = useState(false)
  const [renamePreviewFiles, setRenamePreviewFiles] = useState([])
  const [renameResult, setRenameResult] = useState(null)
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
  useEffect(() => { latestFilesRef.current = files }, [files])
  useEffect(() => { latestSettingsRef.current = settings }, [settings])

  const buildPreviewFilesFromDocuments = useCallback((documentFiles, previews) => {
    const fileMap = new Map(documentFiles.map(f => [f.key, f]))
    const previewFiles = previews.map(p => {
      const f = fileMap.get(p.key)
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
        gmfmc: f?.invoiceFields?.gmfmc || '',
        xsfmc: f?.invoiceFields?.xsfmc || '',
        xmmc: f?.invoiceFields?.xmmc || '',
        note: f?.invoiceFields?.note || '',
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

    const documentFiles = collectDocumentLevelFiles(curFiles)
    if (documentFiles.length === 0) return false

    const renameSettings = curSettings.renameSettings || {}
    const fields = renameSettings.fields || []
    if (fields.length === 0) return false

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
    computedNamesRef.current = {}
    previewDocumentMapRef.current = new Map()
    generatePreviewInner()
  }, [generatePreviewInner])


  const handleRename = useCallback(async () => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return

    const curFiles = latestFilesRef.current
    const curSettings = latestSettingsRef.current
    const documentFiles = collectDocumentLevelFiles(curFiles)

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
      setRenameResult({ success: false, error: '重命名规则未设置，请到设置中设置重命名规则' })
      setRenamePreviewVisible(true)
      return
    }

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

        if (doc._isDocumentGroup && Array.isArray(doc._pages) && doc._pages.length > 1) {
          const pages = [...doc._pages].sort((a, b) => (a.pageNum || 1) - (b.pageNum || 1))
          for (let i = 0; i < pages.length; i++) {
            const page = pages[i]
            const originalPath = page.printPath || page.path || ''
            if (!originalPath.match(/^[a-zA-Z]:\\|^\\\\/)) continue
            const isFirstPage = i === 0
            const pageSuffix = isFirstPage ? '' : `_p${page.pageNum || (i + 1)}`
            const pageBaseName = newBaseName + pageSuffix
            allFilesToRename.push({
              key: page.key,
              originalPath,
              newBaseName: pageBaseName,
            })
            fileKeyToOriginalPath.set(originalPath.toLowerCase().replace(/\\/g, '/'), page.key)
          }
        } else {
          const originalPath = doc.printPath || doc.path || ''
          if (!originalPath.match(/^[a-zA-Z]:\\|^\\\\/)) continue
          allFilesToRename.push({
            key: doc.key,
            originalPath,
            newBaseName,
          })
          fileKeyToOriginalPath.set(originalPath.toLowerCase().replace(/\\/g, '/'), doc.key)
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

    const parsedFiles = files.filter(f => f.status === 'parsed')
    if (parsedFiles.length === 0) {
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
    setPackProgress({ current: 0, total: parsedFiles.length, stage: '准备中', currentFile: '' })

    const onProgress = (event, progress) => {
      setPackProgress(prev => ({ ...prev, ...progress, stage: progress.stage || prev.stage || '' }))
    }
    ipc.on('pack-progress', onProgress)

    try {
      const filesToPack = parsedFiles.map(f => ({
        name: f.name, path: f.path, printPath: f.printPath, newName: f.newName,
        invoiceFields: buildInvoiceFields(f),
      }))

      const packSettings = settings.packSettings || {}
      const renameSettings = settings.renameSettings || {}

      const result = await ipc.invoke('pack-invoices', {
        files: filesToPack,
        packSettings,
        renameSettings,
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
      setPackResult({ success: false, error: error.message })
    }
  }, [files, settings, electronAPIRef, setFiles])

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
    alertModal, closeAlert,
    renamedPreviewKey,
    handleRename, handleRenameConfirm, handlePack,
    refreshRenamePreview,
  }
}
