import { createContext, useContext, useReducer, useCallback, useState, useMemo, useRef, useEffect, useSyncExternalStore } from 'react'
import { filterFiles, isMergeMode, getPreviousYearInfo } from '../utils'
import { buildDocumentViewModel, buildPageDuplicateInfo, buildDocumentDuplicateInfo } from '../utils/documentViewModel'
import { amountToChinese } from '../utils/amountConverter'
import { getActiveSessionId, getSession, subscribe, getDocumentVersion } from '../stores/ImportSessionStore'
import { getRegisteredDocIds, getDocument } from '../stores/DocumentStore'
import { getDocumentCacheIdentity } from '../utils/documentViewCacheIdentity'
import { resolveMaterializedInvoiceDocuments } from '../utils/resolveMaterializedInvoiceDocuments'
import { perfProbe } from '../perf/importPerfProbe'
import { createImportHistoryBatcher } from './importHistoryBatcher'
import { db } from '../db'

// ── P1：发票重复导入历史（advisory 旁路）工具 ──────────────────
// 号码归一化与后端 import_history.normalize_invoice_number 保持一致：trim → 去内部空白 → uppercase
function normalizeInvoiceNumber(raw) {
  if (raw == null) return null
  const s = String(raw).trim().replace(/\s+/g, '').toUpperCase()
  return s || null
}

// 并发受限执行器：保持 concurrency 个在途 Promise
function runPool(items, concurrency, worker) {
  let i = 0
  const exec = () => {
    if (i >= items.length) return
    const cur = i++
    Promise.resolve(worker(items[cur])).finally(exec)
  }
  const n = Math.min(concurrency, items.length)
  for (let c = 0; c < n; c++) exec()
}

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
    perfProbe.count('setFiles')   // 导入期间 files 状态更新次数（渲染风暴指标）
    dispatch({ type: 'SET_FILES', payload: arg })
  }, [])

  const files = state.files

  // ── P1：发票重复导入历史（advisory 旁路，纯风险呈现，不拦截导入） ──
  const [importHistoryInfo, setImportHistoryInfo] = useState(() => new Map())

  // ── P1-A：importHistory publication batching ──
  // 目标：把「每条响应 → 立即发布新 Map state」（454 响应 = 454 次 Map 重建 +
  // 454 次 Context value identity 变化 → 行级 memo 被击穿）改为
  // 「响应合入 pending → 短 debounce(50ms) 单 flush → 至多一次发布」。
  // 工厂自持 current Map（唯一写者），publish 即同步给 React —— 所有写入口收敛到工厂：
  //   enqueue（响应命中）/ prune（files 变化剔除）/ dispose（卸载）。
  // 内容无实际变化时工厂不调用 publish → React state 零更新（noop），
  // 切断「热路径重复查询 → 无意义 Context 更新」的 churn。
  // React state 仅在工厂 publish 时被写 → 与工厂 current 恒一致（initial 对齐初始值）。
  const importHistoryBatcherRef = useRef(null)
  if (importHistoryBatcherRef.current === null) {
    importHistoryBatcherRef.current = createImportHistoryBatcher({
      debounceMs: 50,
      initial: importHistoryInfo,
      publish: (next) => setImportHistoryInfo(next),
      onPublish: () => perfProbe.count('importHistoryPublish'),
      onNoop: () => perfProbe.count('importHistoryNoop'),
    })
  }
  useEffect(() => {
    return () => {
      importHistoryBatcherRef.current?.dispose()
      importHistoryBatcherRef.current = null   // StrictMode remount → 条件重建（initial=当前 state）
    }
  }, [])

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
  // files 的 key 集合签名：删除/新增文件时驱动持久源恢复重算（S5 membership），
  // 排序/内容更新不触发（保持轻量，与 documentView fileSig 思路一致但只取 key）
  const fileKeysSig = files.length
    ? files.map(f => f.key).sort().join('‖')
    : ''
  const invoiceDocs = useMemo(() => {
    // Candidate 1-R：Persistent Document View Source（INV-S1，2026-08-23 冻结）
    //   ImportSession.documents 不再是 Display 唯一 InvoiceDocument 来源。
    //   - session 存在（导入过渡态）→ 优先用 session.documents（最新装配结果）
    //   - session 被 TTL 清理 → 从 DocumentStore（持久注册的 canonical docs）恢复，
    //     按当前 files membership 过滤——已 materialize 的文档不随 session 消失。
    //   files 是展示 membership 唯一 truth；DocumentStore 只补 identity，不决定显示哪些文件。
    const registeredDocs = getRegisteredDocIds()
      .map((id) => getDocument(id))
      .filter(Boolean)
    // 持久源恢复（session 不存在 / 悬空 / 无 documents 三个分支共用，业务语义与
    // 既有代码逐字节等价：registeredDocs 空 → null，否则按 files membership 恢复）
    const restoreFromRegistered = () => {
      if (registeredDocs.length === 0) return null
      return resolveMaterializedInvoiceDocuments(files, null, registeredDocs)
    }
    let result
    if (!sessionId) {
      // session 不存在（未导入 / 已被 TTL 回收）：从持久 DocumentStore 恢复已 materialize 文档
      result = restoreFromRegistered()
    } else {
      const session = getSession(sessionId)
      if (!session) {
        // session 悬空指针（getSession 找不到）：同样从持久源恢复
        result = restoreFromRegistered()
      } else {
        const docs = session.documents?.length > 0 ? session.documents : null
        if (docs) {
          result = docs
        } else {
          // session 存在但无 documents：尝试从持久源恢复（防御）
          result = restoreFromRegistered()
        }
      }
    }
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, storeSnap, fileKeysSig])

  // ── P1-C: documentView 内容签名缓存 ──
  // 排序仅改变 files 数组顺序时，buildDocumentViewModel 的输出内容完全相同
  // （duplicateGroups 以 invoiceNumber 为键，统计值与顺序无关）。
  // 通过 order-invariant 签名跳过重复计算，消除第二轮渲染中的 O(n) 重建。
  const documentViewCache = useRef({ sig: '', result: null })

  const documentView = useMemo(() => {
    const fileSig = files.length
      ? files.map(f =>
          [f.key, f.status, f.invoiceDate || '', f.amount || '',
           f.invoiceNumber || '', f.docId || '', f.totalPages || '', f.pageNum || '',
           f.name || '']
          .join('|')
        ).sort().join('‖')
      : ''
    const docsSig = Array.isArray(invoiceDocs) && invoiceDocs.length
      ? invoiceDocs.map(getDocumentCacheIdentity).sort().join('‖')
      : ''
    const combinedSig = fileSig + '#' + docsSig

    if (combinedSig === documentViewCache.current.sig) {
      return documentViewCache.current.result
    }

    const _endDerive = perfProbe.begin('buildDocumentViewModel')
    const result = buildDocumentViewModel(files, invoiceDocs)
    _endDerive()
    documentViewCache.current = { sig: combinedSig, result }
    return result
  }, [files, invoiceDocs])

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

  // ── P1：发票重复导入历史查询（advisory，fire-and-forget，绝不作为导入 pipeline 的 dependency） ──
  // 竞态防护：
  //  - importHistoryReqIdRef：每轮查询自增令牌，过期回写直接丢弃（防旧请求回写）
  //  - firedSigRef：签名去重避免同集合重复查询；cleanup 重置 → StrictMode remount 不会错误跳过查询
  //  - liveKeys 快照：回写/剔除只对当前仍存活的 file.key 生效（防结果晚于文件生命周期）
  //  - 同号去重：归一化号 → fileKey[]，一次 GET 广播到多个 file.key
  //  - 失败静默：dbError / 抛错均忽略，不影响正常导入
  const importHistoryReqIdRef = useRef(0)
  const firedSigRef = useRef('')
  const importHistoryTimerRef = useRef(null)
  useEffect(() => {
    // 仅关注已解析且带发票号码的文件
    const liveKeys = new Set(files.map(f => f.key))
    // 同步最新存活集合 → flush 时用最新 liveKeys 过滤（防删除竞态下旧快照复活已删文件）
    importHistoryBatcherRef.current?.setLiveKeys(liveKeys)
    // 主动清理残留：importHistoryInfo 是异步旁路缓存，若文件已被移除而新查询
    //    未命中（exists=false / importCount<2 / __error），旧条目不会被剔除 →
    //    sb-stats 的 importHistoryCount 残留计数。此处不依赖查询结果，liveKeys 构建后
    //    立即剔除，与 previousYearInfo 同步派生语义对齐（往年发票移除即刷新）。
    //    原 :218 剔除 + :238 无目标清理收敛到工厂 prune（无剔除 → 不发布）。
    importHistoryBatcherRef.current?.prune(liveKeys)
    const byNumber = new Map()
    for (const f of files) {
      if (f.status !== 'parsed' || !f.invoiceNumber) continue
      const norm = normalizeInvoiceNumber(f.invoiceNumber)
      if (!norm) continue
      if (!byNumber.has(norm)) byNumber.set(norm, [])
      byNumber.get(norm).push(f.key)
    }
    if (byNumber.size === 0) {
      return  // 无查询目标（残留清理已由上方 prune 完成）
    }

    const sig = Array.from(byNumber.keys()).sort().join('|')
    if (firedSigRef.current === sig) return  // 同集合已查过，跳过（StrictMode 双调用靠 cleanup 重置）

    if (importHistoryTimerRef.current) clearTimeout(importHistoryTimerRef.current)
    importHistoryTimerRef.current = setTimeout(() => {
      importHistoryTimerRef.current = null
      const myReq = ++importHistoryReqIdRef.current
      firedSigRef.current = sig
      const entries = Array.from(byNumber.entries())
      perfProbe.count('importHistoryQuery', entries.length)
      runPool(entries, 6, ([norm, fileKeys]) =>
        db.getImportHistory(norm).then(res => {
          if (myReq !== importHistoryReqIdRef.current) return  // 已被新轮换取代
          if (res && res.__error) return                       // 静默失败
          if (!res || res.exists !== true) return             // 未命中
          // 🔴 首次导入不算重复报销：历史记录由本次导入创建（count 含本次），
          //    仅当 count>=2 才说明本次之前已导入过（=重复报销）；count==1 是首次导入。
          if ((res.importCount ?? 0) < 2) return
          // P1-A：不再逐条发布新 Map state —— 合入 pending，短 debounce 单 flush 发布。
          //   importHistoryResponse = 命中条数（= 旧 importHistoryWrite 语义，改名避混淆）；
          //   importHistoryPublish / importHistoryNoop 由工厂 flush 处计数。
          // 广播语义不变：同号 fileKeys 由 flush 统一写入同一 value 引用。
          perfProbe.count('importHistoryResponse')
          importHistoryBatcherRef.current?.enqueue({
            fileKeys,
            value: {
              exists: true,
              invoiceDate: res.invoiceDate,
              firstImportedAt: res.firstImportedAt,
              importCount: res.importCount,
              dateMismatchCount: res.dateMismatchCount,
            },
          })
        }).catch(() => { /* 静默降级 */ })
      )
    }, 300)

    return () => {
      if (importHistoryTimerRef.current) {
        clearTimeout(importHistoryTimerRef.current)
        importHistoryTimerRef.current = null
      }
      firedSigRef.current = ''  // StrictMode remount 后允许重新查询
    }
  }, [files])

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
    importHistoryInfo,
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
    importHistoryInfo,
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
