import { useState, useCallback, useRef, useEffect } from 'react'
import { getFileFormat } from '../utils'
import { generateFileKey } from '../utils/fileHelpers'

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
  // 重命名完成后，供 App 重新导入（预览）该发票：记录首个重命名文件的 key，
  // App 用它在最新 files 状态里找到带 docId 的解析后对象，避免拿到无 docId 的本地占位对象
  // （无 docId 会让 Render Engine 预览 URL 缺失，回退 Canvas 路径，重演 Canvas/RE 视觉不一致）。
  const [renamedPreviewKey, setRenamedPreviewKey] = useState(null)
  // 缓存预览阶段算好的文件名，重命名时直接复用，避免后端重复计算
  const computedNamesRef = useRef({})  // { [key]: newBaseName }

  // 重导入期间同步 parseProgress → reimportProgress
  const reimportingRef = useRef(false)
  useEffect(() => {
    if (!reimportingRef.current) return
    if (parseProgress.total > 0 && parseProgress.current !== undefined) {
      setReimportProgress(
        Math.round((parseProgress.current / parseProgress.total) * 100)
      )
    }
  }, [parseProgress])

  // ============================
  // 重命名
  // ============================
  const handleRename = useCallback(async () => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return

    const filesToRename = files.filter(f => f.status === 'parsed')
    if (filesToRename.length === 0) {
      setAlertModal({
        visible: true,
        title: '提示',
        message: '没有可重命名的发票，请先解析完成',
        type: 'warning',
      })
      return
    }

    // 生成新文件名
    const renameSettings = settings.renameSettings || {}
    const fields = renameSettings.fields || []
    const separator = renameSettings.separator || '_'
    const showIndex = renameSettings.showIndex ?? false
    const showPrefix = renameSettings.showPrefix ?? false

    if (fields.length === 0) {
      setRenameResult({ success: false, error: '重命名规则未设置，请到设置中设置重命名规则' })
      setRenamePreviewVisible(true)
      return
    }

    // 调用后端生成预览文件名（与真实重命名共用 buildNameParts，保证一致）
    const filesForPreview = filesToRename.map(f => ({
      key: f.key,
      name: f.name,
      originalPath: f.printPath || f.path || '',
      invoiceFields: (f.invoiceFields && Object.keys(f.invoiceFields).length) ? f.invoiceFields : {
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
      },
    }))

    let previews
    try {
      const result = await ipc.invoke('preview-rename-names', {
        files: filesForPreview,
        renameSettings,
      })
      previews = result.previews || []
    } catch (e) {
      console.error('[rename] Preview failed, falling back to frontend:', e.message)
      // 预览失败时回退到最简单的显示
      previews = filesToRename.map(f => ({
        key: f.key,
        originalName: f.name,
        newName: f.name,
      }))
    }

    // 构建索引，避免 N 个文件 × M 次 find 的 O(N²) 遍历
    const fileMap = new Map(filesToRename.map(f => [f.key, f]))
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
      }
    })


    // 检测文件名冲突
    const nameCount = {}
    previewFiles.forEach(file => {
      nameCount[file.newName] = (nameCount[file.newName] || 0) + 1
    })
    
    // 标记冲突文件
    previewFiles.forEach(file => {
      if (nameCount[file.newName] > 1) {
        file.conflict = true
      }
    })

    setRenamePreviewFiles(previewFiles)
    // 缓存预览结果中的文件名，重命名时直接复用
    const nameMap = {}
    for (const p of previewFiles) {
      const base = p.newName.replace(/\.\w+$/, '')
      nameMap[p.key] = base
    }
    computedNamesRef.current = nameMap
    setRenamePreviewVisible(true)
  }, [files, settings, electronAPIRef])

  const handleRenameConfirm = useCallback(async (selectedKeys) => {
    const ipc = electronAPIRef.current?.ipcRenderer
    if (!ipc) return

    setPacking(true)
    setPackProgress({ current: 0, total: selectedKeys.length })

    const onProgress = (event, progress) => { setPackProgress(progress) }
    ipc.on('rename-progress', onProgress)

    try {
      const filesToRename = files.filter(f => selectedKeys.includes(f.key) && f.status === 'parsed')
      const filesWithValidPath = filesToRename.filter(f => {
        const p = f.printPath || f.path || ''
        return p.match(/^[a-zA-Z]:\\|^\\\\/)
      })
      const invalidPathFiles = filesToRename.filter(f => {
        const p = f.printPath || f.path || ''
        return !p.match(/^[a-zA-Z]:\\|^\\\\/)
      })

      if (invalidPathFiles.length > 0) {
        setAlertModal({
          visible: true,
          title: '路径错误',
          message: `有 ${invalidPathFiles.length} 个文件无法获取真实路径：\n${invalidPathFiles.map(f => f.name).join('\n')}`,
          type: 'warning',
        })
      }
      if (filesWithValidPath.length === 0) { setPacking(false); return }

      const filesToRenameWithPath = filesWithValidPath.map(f => {
        const cachedName = computedNamesRef.current[f.key]
        return {
          key: f.key,
          originalPath: f.printPath || f.path,
          // 传入预览阶段已算好的文件名，后端直接复用不再跑 buildNameParts
          // 未缓存时（用户跳过预览直接重命名）不传此字段，后端自动回退到 generateNewName
          ...(cachedName ? { newBaseName: cachedName } : {}),
          invoiceFields: f.invoiceFields || {
          type: f.invoiceType || '',
          fphm: f.invoiceNumber || '',
          kprq: f.invoiceDate || '',
          gmfmc: '',
          gmfsh: '',
          xsfmc: '',
          xsfsh: '',
          amountJe: '',
          amountSe: '',
          amountHj: f.amount || '',
          amountHjDx: '',
          note: '',
          skr: '',
          fhr: '',
          kpr: '',
        },
      }
    })

      const renameSettings = settings.renameSettings || {}
      const result = await ipc.invoke('rename-invoices', {
        files: filesToRenameWithPath,
        renameSettings,
      })
      ipc.removeListener('rename-progress', onProgress)
      setPacking(false)

      if (result.success) {
        if (result.renamedFiles && result.renamedFiles.length > 0) {
          // 用 originalPath 建立索引，替代顺序索引，避免跳过文件导致索引偏移
          const pathToFileMap = new Map(filesToRenameWithPath.map(f => [f.originalPath, f]))

          const newFiles = result.renamedFiles.map((file, i) => {
            const original = pathToFileMap.get(file.originalPath)
            return {
              key: generateFileKey(`${file.newName}_${i}`),
              name: file.newName, path: file.newPath, printPath: file.newPath,
              status: 'parsing', invoiceType: '', invoiceNumber: '', amount: '',
              invoiceDate: '', newName: '', parseMethod: '',
              fileFormat: getFileFormat(file.newName), previewImage: null,
              invoiceFields: null,
              originalPath: original?.originalPath || file.originalPath,
            }
          })

          // 记录首个重命名文件 key，供 App 在重命名完成后重新导入其预览
          setRenamedPreviewKey(newFiles[0]?.key || null)

          // 构建本地事务追踪：记录本次操作创建的文件 key 和已搬移的旧路径
          // 使用局部变量而非 React state 标记，避免并发调用时标记串扰
          const transactionKeys = new Set(newFiles.map(f => f.key))
          // 直接用 result.renamedFiles 中的 originalPath，不再依赖顺序索引
          const succeededOldPaths = new Set(
            result.renamedFiles
              .filter(f => !f.partialSuccess)
              .map(f => f.originalPath)
          )

          // 先添加新文件，等待解析完成后再删除旧文件
          setFiles(prev => [...prev, ...newFiles])

          // 等待解析完成
          try {
            reimportingRef.current = true
            setReimporting(true)
            setReimportProgress(0)
            await parseFiles(newFiles)
            setReimporting(false)
            setReimportProgress(null)
            reimportingRef.current = false

            // 解析成功后，原子性删除本次重命名的旧文件引用
            // 预处理 succeededOldPaths：统一小写并正斜杠化，放入 Set 实现 O(1) 查找
            const normalizedOldPaths = new Set(
              [...succeededOldPaths].map(p => p.replace(/\\/g, '/').toLowerCase())
            )
            setFiles(prev => prev.filter(f => {
              const fp = (f.path || '').replace(/\\/g, '/').toLowerCase()
              const fpp = (f.printPath || '').replace(/\\/g, '/').toLowerCase()
              return !normalizedOldPaths.has(fp) && !normalizedOldPaths.has(fpp)
            }))
          } catch (parseError) {
            console.error('重命名后解析失败:', parseError)
            setReimporting(false)
            setReimportProgress(null)
            reimportingRef.current = false
            // 精准回滚：仅移除本次事务创建的新文件，保留所有旧文件
            // 使用 transactionKeys（局部变量）精确定位，替代之前依赖 originalPath 字段的方式
            setFiles(prev => prev.filter(f => !transactionKeys.has(f.key)))
          }
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
  }, [files, parseFiles, settings, setFiles, electronAPIRef])

  // ============================
  // 打包
  // ============================
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
        invoiceFields: f.invoiceFields || {
          type: f.invoiceType || '',
          fphm: f.invoiceNumber || '', kprq: f.invoiceDate || '',
          gmfmc: '', gmfsh: '', xsfmc: '', xsfsh: '',
          amountJe: '', amountSe: '',
          amountHj: f.amount || '', amountHjDx: '',
          note: '', skr: '', fhr: '', kpr: '',
        },
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

        // 打包成功且不保留原件时，清除当前列表
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
  }, [files, settings, electronAPIRef])

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
  }
}
