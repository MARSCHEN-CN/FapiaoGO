import { createContext, useContext, useReducer, useCallback, useState, useMemo, useRef, useSyncExternalStore } from 'react'
import { filterFiles, isMergeMode, getPreviousYearInfo } from '../utils'
import { buildDocumentViewModel, buildPageDuplicateInfo, buildDocumentDuplicateInfo } from '../utils/documentViewModel'
import { amountToChinese } from '../utils/amountConverter'
import { getActiveSessionId, getSession, subscribe, getDocumentVersion } from '../stores/ImportSessionStore'

// ── Reducer ──────────────────────────────────────────────────

function fileReducer(state, action) {
  switch (action.type) {
    case 'SET_FILES':
      return {
        ...state,
        files: typeof action.payload === 'function'
          ? action.payload(state.files)
          : action.payload,
      }
    default:
      return state
  }
}

const INITIAL_STATE = { files: [] }

// ── Context ──────────────────────────────────────────────────

const FileContext = createContext(null)

export function FileProvider({ children }) {
  const [state, dispatch] = useReducer(fileReducer, INITIAL_STATE)
  const [searchQuery, setSearchQuery] = useState('')
  const [mergeMode, setMergeMode] = useState(null)

  // 兼容现有所有 setFiles 调用（直接值 + updater 函数）
  const setFiles = useCallback((arg) => {
    dispatch({ type: 'SET_FILES', payload: arg })
  }, [])

  const files = state.files

  // 搜索过滤。filterFiles 是纯 O(n) 遍历，对预期数据量（几千条以内）开销可忽略，
  // 因此查询直接同步，不使用 useDeferredValue——后者在本场景无可证收益却引入时序复杂度。
  // 若未来列表膨胀到 5000+ 且输入掉帧，再考虑 useDeferredValue / useTransition / Web Worker。
  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return files
    return filterFiles(files, searchQuery)
  }, [files, searchQuery])

  const isSearching = searchQuery.trim() !== ''

  // ── 文件统计（D1：统计单位 = Document，打印计数保持 Page 级） ──
  // Document 视图模型统一出口：Sidebar / FileList / 排序 / 重复删除共用同一份派生结果，
  // 不再各自消费原始 page-level files（多页发票 = 一个发票，金额/计数不按页累加）。

  // ── E-2.2：从 ImportSessionStore 获取 InvoiceDocument，注入视图模型 ──
  // useSyncExternalStore 保证 documents 变化时 React 重渲染
  // 快照 = sessionId + documentVersion，确保 addDocument 时触发重渲染
  const storeSnap = useSyncExternalStore(
    subscribe,
    () => `${getActiveSessionId()}:${getDocumentVersion()}`,
    () => null,
  )
  const sessionId = storeSnap ? storeSnap.split(':')[0] : null
  const invoiceDocs = useMemo(() => {
    if (!sessionId) return null
    const session = getSession(sessionId)
    // 修复：如果 session 不存在（被 TTL 回收或其他原因），必须返回 null
    // 防止引用已删除的 session.documents 导致文档分组丢失
    if (!session) return null
    return session.documents?.length > 0 ? session.documents : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, storeSnap])

  const documentView = useMemo(
    () => buildDocumentViewModel(files, invoiceDocs),
    [files, invoiceDocs],
  )

  // ── P1-A: 稳定派生数据引用（排序仅改变顺序时复用旧 Map 引用，减少 FileCardRow 重渲染） ──
  // 当排序只改变文件顺序（不改变内容）时，previousYearInfo / duplicatePageInfo /
  // duplicateDocumentInfo 的内容完全相同。通过内容签名检测是否真正变化，复用旧引用。
  const derivedCache = useRef({ sig: '', previousYearInfo: null, duplicatePageInfo: null, duplicateDocumentInfo: null })

  const { previousYearInfo, duplicatePageInfo, duplicateDocumentInfo } = useMemo(() => {
    // 构建 order-invariant 签名：文件内容 + duplicateGroups 内容
    const fileSig = files.length
      ? files.map(f => `${f.key}|${f.status}|${f.invoiceDate || ''}|${f.docId || ''}`).sort().join('‖')
      : ''
    const dupSig = documentView.duplicateGroups.size
      ? Array.from(documentView.duplicateGroups.entries())
          .map(([k, docs]) => `${k}:${docs.map(d => d.key).sort().join(',')}`)
          .sort().join('§')
      : ''
    const combinedSig = fileSig + '#' + dupSig

    if (combinedSig === derivedCache.current.sig) {
      return {
        previousYearInfo: derivedCache.current.previousYearInfo,
        duplicatePageInfo: derivedCache.current.duplicatePageInfo,
        duplicateDocumentInfo: derivedCache.current.duplicateDocumentInfo,
      }
    }

    const prevYear = getPreviousYearInfo(files)
    const pageDup = buildPageDuplicateInfo(documentView.duplicateGroups)
    const docDup = buildDocumentDuplicateInfo(documentView.duplicateGroups)

    derivedCache.current = { sig: combinedSig, previousYearInfo: prevYear, duplicatePageInfo: pageDup, duplicateDocumentInfo: docDup }
    return { previousYearInfo: prevYear, duplicatePageInfo: pageDup, duplicateDocumentInfo: docDup }
  }, [files, documentView.duplicateGroups])

  const fileStats = useMemo(() => {
    // 可打印计数：Print Pipeline 域，打印以页为单位，保持 page 级
    let printableCount = 0
    for (const f of files) {
      if (f.printPath && (f.status === 'parsed' || f.status === 'error')) {
        // OFD：docId（Render Contract）或 previewImage（旧 session 兜底）任一即可打印
        if (!((f.fileFormat === 'ofd') && !f.docId && !f.previewImage)) {
          printableCount++
        }
      }
    }

    // mergeMode 下 printableCount 按合并数量取整
    if (isMergeMode(mergeMode)) {
      const mergeSize = parseInt(mergeMode?.replace('merge', '')) || 2
      printableCount = Math.ceil(printableCount / mergeSize)
    }

    return {
      totalAmount: documentView.totalAmount,
      printableCount,
      hasFailedFiles: documentView.failedCount > 0,
      failedFilesCount: documentView.failedCount,
    }
  }, [files, mergeMode, documentView])

  const { totalAmount, printableCount, hasFailedFiles, failedFilesCount } = fileStats

  // 金额格式化
  const totalAmountStr = totalAmount.toFixed(2)
  const totalAmountInt = totalAmountStr.split('.')[0]
  const totalAmountDecimal = totalAmountStr.split('.')[1]

  // 中文大写金额（本地计算，无需 HTTP 请求）
  const chineseAmount = useMemo(() => {
    return amountToChinese(totalAmount)
  }, [totalAmount])

  // ── Context value ──

  const value = useMemo(() => ({
    files,
    setFiles,
    searchQuery,
    setSearchQuery,
    filteredFiles,
    isSearching,
    // merge 模式（由 AppContent 通过 setMergeMode 同步）
    mergeMode,
    setMergeMode,
    // Document 视图模型（D1 统一出口：统计/重复/列表聚合的唯一数据源）
    documentView,
    // P0-2: 集中计算的派生数据（排序/展示共用，避免重复 O(n)）
    previousYearInfo,
    duplicatePageInfo,
    duplicateDocumentInfo,
    // 文件统计
    totalAmount,
    printableCount,
    hasFailedFiles,
    failedFilesCount,
    totalAmountInt,
    totalAmountDecimal,
    chineseAmount,
  }), [
    files, setFiles, searchQuery, filteredFiles, isSearching,
    mergeMode,
    documentView,
    previousYearInfo, duplicatePageInfo, duplicateDocumentInfo,
    totalAmount, printableCount, hasFailedFiles, failedFilesCount,
    totalAmountInt, totalAmountDecimal, chineseAmount,
  ])

  return (
    <FileContext.Provider value={value}>
      {children}
    </FileContext.Provider>
  )
}

export function useFileContext() {
  const ctx = useContext(FileContext)
  if (!ctx) throw new Error('useFileContext must be used within FileProvider')
  return ctx
}
