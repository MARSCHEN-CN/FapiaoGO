import { createContext, useContext, useReducer, useCallback, useState, useMemo, useEffect } from 'react'
import { filterFiles, isFailedFile, isMergeMode } from '../utils'
import { BACKEND_URL } from '../config'

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

  // ── 文件统计（从 useFileStats 移入 Context，Sidebar / ActionBar 直接消费） ──

  const fileStats = useMemo(() => {
    let totalAmount = 0
    let printableCount = 0
    let hasFailedFiles = false
    let failedFilesCount = 0

    for (const f of files) {
      const amountStr = (f.amount || '').replace(/[¥￥,]/g, '')
      totalAmount += parseFloat(amountStr) || 0

      if (f.printPath && (f.status === 'parsed' || f.status === 'error')) {
        if (!((f.fileFormat === 'ofd') && !f.previewImage)) {
          printableCount++
        }
      }

      if (isFailedFile(f)) {
        hasFailedFiles = true
        failedFilesCount++
      }
    }

    // mergeMode 下 printableCount 按合并数量取整
    if (isMergeMode(mergeMode)) {
      const mergeSize = parseInt(mergeMode?.replace('merge', '')) || 2
      printableCount = Math.ceil(printableCount / mergeSize)
    }

    return { totalAmount, printableCount, hasFailedFiles, failedFilesCount }
  }, [files, mergeMode])

  const { totalAmount, printableCount, hasFailedFiles, failedFilesCount } = fileStats

  // 金额格式化
  const totalAmountStr = totalAmount.toFixed(2)
  const totalAmountInt = totalAmountStr.split('.')[0]
  const totalAmountDecimal = totalAmountStr.split('.')[1]

  // 中文大写金额
  const [chineseAmount, setChineseAmount] = useState('零元整')

  useEffect(() => {
    if (totalAmount === 0) {
      setChineseAmount('零元整')
      return
    }
    let cancelled = false
    fetch(`${BACKEND_URL}/api/to_chinese_amount`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: totalAmount }),
    })
      .then((r) => r.json())
      .then((data) => { if (!cancelled && data.success) setChineseAmount(data.chinese) })
      .catch(() => {})
    return () => { cancelled = true }
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
