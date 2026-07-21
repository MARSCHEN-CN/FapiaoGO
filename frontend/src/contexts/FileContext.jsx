import { createContext, useContext, useReducer, useCallback, useState, useMemo } from 'react'
import { filterFiles, isMergeMode } from '../utils'
import { buildDocumentViewModel } from '../utils/documentViewModel'
import { amountToChinese } from '../utils/amountConverter'

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

  const documentView = useMemo(() => buildDocumentViewModel(files), [files])

  const fileStats = useMemo(() => {
    // 可打印计数：Print Pipeline 域，打印以页为单位，保持 page 级
    let printableCount = 0
    for (const f of files) {
      if (f.printPath && (f.status === 'parsed' || f.status === 'error')) {
        if (!((f.fileFormat === 'ofd') && !f.previewImage)) {
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
