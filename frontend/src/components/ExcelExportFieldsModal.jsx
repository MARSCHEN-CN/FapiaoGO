import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { EXCEL_COLUMNS, ALL_KEYS, visibleColumns, INVOICE_LEVEL_KEYS } from '../export/excelColumns.js'
import { computeTotals, countInvoices } from '../export/excelTotals.js'
import { groupInvoiceRows } from '../export/invoiceIdentity.js'
import { BACKEND_URL } from '../config'

/**
 * 「导出为 Excel」字段确认弹窗
 *
 * 职责：字段选择 + 实时预览 + 合计显示 + confirm callback，**内部不触发导出**。
 * 预览数据来自后端 `/api/export-excel-rows`（与最终导出同一 `_db_record_to_export`
 * 输出），保证「预览 = 导出数据源」。
 *
 * 边界（v2.1）：
 *   - Commit 4B 已接 Settings 持久化：弹窗打开时以持久化勾选为准，否则默认 23/23 全选。
 *     勾选变化经 onPersist 防抖写回 Settings.json.excelExport.columns。
 *
 * Props:
 *   visible:        boolean            是否渲染
 *   files:          Array              已选文件列表（用于推导 fileNames 拉取预览行）
 *   initialColumns: Set<string> | null 已持久化的勾选 keys；null/undefined 时回落默认全选
 *   onPersist:      (keys: Set) => void 勾选变化时防抖持久化
 *   onConfirm:      (columns) => void   确认导出，columns 含 {key,label,width,virtual}
 *   onCancel:       () => void          取消
 */
const ExcelExportFieldsModal = ({
  visible,
  files = [],
  initialColumns,
  onPersist,
  onConfirm,
  onCancel,
}) => {
  // 默认 23/23 全选（保持现有导出结果）；若已持久化则弹窗打开时以持久化为准
  const [selected, setSelected] = useState(() => new Set(ALL_KEYS))
  const selectedRef = useRef(selected)
  // 每次打开只初始化一次：以持久化勾选为准，避免覆盖用户会话内的勾选
  const initRef = useRef(false)
  useEffect(() => {
    if (visible && !initRef.current) {
      setSelected(initialColumns ? new Set(initialColumns) : new Set(ALL_KEYS))
      initRef.current = true
    } else if (!visible) {
      initRef.current = false
    }
  }, [visible, initialColumns])

  // 保持 selectedRef 与渲染态同步（initRef 经 setSelected 改值后亦需同步，避免 toggle 基于旧值计算）
  useEffect(() => {
    selectedRef.current = selected
  }, [selected])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // 由 files 推导后端需要的 fileNames
  const fileNames = useMemo(
    () => (files || []).map((f) => f.name || f.path || f.fileName || '').filter(Boolean),
    [files],
  )

  // ── 挂载拉取同源预览行 ──
  useEffect(() => {
    if (!visible) return
    if (fileNames.length === 0) {
      setRows([])
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    fetch(`${BACKEND_URL}/api/export-excel-rows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileNames }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}))
          throw new Error(errBody.error || `服务器返回 ${res.status}`)
        }
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        if (data.success) setRows(data.rows || [])
        else setError(data.error || '获取预览数据失败')
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled || e.name === 'AbortError') return
        setError(e.message || '获取预览数据失败')
        setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [visible, fileNames])

  // 当前勾选列定义（顺序 = EXCEL_COLUMNS 规范序；取消再勾回规范位置）
  const visibleCols = useMemo(() => visibleColumns(selected), [selected])

  // 按发票身份分组（与后端 write_summary_sheet 同序：首现顺序）。
  // 组内多行明细时，发票级列在下方 tbody 渲染为 rowspan 合并，与导出单元格合并一致。
  const groups = useMemo(() => groupInvoiceRows(rows), [rows])

  const totals = useMemo(() => computeTotals(rows, visibleCols), [rows, visibleCols])
  const invoiceCount = useMemo(() => countInvoices(rows), [rows])

  // 同步更新 state + ref 并触发持久化（Commit 4B）
  const applySelection = useCallback((next) => {
    selectedRef.current = next
    setSelected(next)
    if (onPersist) onPersist(next)
  }, [onPersist])

  const toggleKey = useCallback((key) => {
    const prev = selectedRef.current
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    applySelection(next)
  }, [applySelection])

  const selectAll = useCallback(() => applySelection(new Set(ALL_KEYS)), [applySelection])
  const clearAll = useCallback(() => applySelection(new Set()), [applySelection])

  const handleConfirm = useCallback(() => {
    if (visibleCols.length === 0) return
    // ⚠️ 必须带 virtual，否则后端不识虚拟列（serialNo 会 KeyError）
    onConfirm(
      visibleCols.map(({ key, label, width, virtual }) => ({ key, label, width, virtual })),
    )
  }, [visibleCols, onConfirm])

  if (!visible) return null

  const canConfirm = visibleCols.length > 0 && !loading && !error

  return (
    <div className="modal-overlay xec-overlay">
      <div className="xec-panel">
        {/* ── 标题 ── */}
        <div className="xec-header">
          <div className="xec-header-left">
            <h3 className="xec-title">导出为 Excel</h3>
            <span className="xec-subtitle">选择导出字段</span>
          </div>
          <span className="xec-file-count">已选择 {files.length} 个文件</span>
        </div>

        {/* ── 主体 ── */}
        <div className="xec-body">
          {/* 可选字段 */}
          <div className="xec-section">
            <div className="xec-section-head">
              <span className="xec-section-label">可选字段</span>
              <div className="xec-section-actions">
                <button type="button" className="xec-link-btn" onClick={selectAll}>
                  全选
                </button>
                <button type="button" className="xec-link-btn" onClick={clearAll}>
                  取消全选
                </button>
              </div>
            </div>
            <div className="xec-fields">
              {EXCEL_COLUMNS.map((c) => (
                <label key={c.key} className="xec-field">
                  <input
                    type="checkbox"
                    checked={selected.has(c.key)}
                    onChange={() => toggleKey(c.key)}
                  />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* 动态预览 */}
          <div className="xec-section xec-preview-section">
            <div className="xec-section-head">
              <span className="xec-section-label">预览</span>
              {loading && <span className="xec-loading">加载中…</span>}
              {error && <span className="xec-error">{error}</span>}
            </div>
            <div className="xec-table-wrap">
              <table className="xec-table">
                <thead>
                  <tr>
                    {visibleCols.map((c) => (
                      <th key={c.key}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group, gi) => {
                    const serial = gi + 1
                    return group.map((r, ri) => {
                      const isFirst = ri === 0
                      // 发票级列在非首行不渲染（由首行 rowspan 覆盖），实现与导出一致的合并
                      const cells = visibleCols.filter(
                        (c) => !(INVOICE_LEVEL_KEYS.has(c.key) && !isFirst),
                      )
                      return (
                        <tr key={`${gi}-${ri}`}>
                          {cells.map((c) => (
                            <td
                              key={c.key}
                              rowSpan={INVOICE_LEVEL_KEYS.has(c.key) ? group.length : undefined}
                              className={c.money ? 'xec-money' : undefined}
                              title={r[c.key] ?? ''}
                            >
                              {c.key === 'serialNo'
                                ? serial
                                : (r[c.key] ?? '')}
                            </td>
                          ))}
                        </tr>
                      )
                    })
                  })}
                </tbody>
                {visibleCols.length > 0 && (
                  <tfoot>
                    <tr className="xec-total-row">
                      {visibleCols.map((c, idx) => (
                        <td
                          key={c.key}
                          className={c.money ? 'xec-money' : undefined}
                        >
                          {idx === 0 ? '合计' : (c.total ? (totals[c.key] ?? '') : '')}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
              {!loading && rows.length === 0 && (
                <div className="xec-empty">暂无数据可预览</div>
              )}
            </div>
            <div className="xec-count">共 {invoiceCount} 张发票</div>
          </div>
        </div>

        {/* ── 底部 ── */}
        <div className="xec-footer">
          <button type="button" className="pc-btn outline" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="pc-btn solid"
            onClick={handleConfirm}
            disabled={!canConfirm}
            title={visibleCols.length === 0 ? '请至少选择一个字段' : ''}
          >
            确认导出
          </button>
        </div>
      </div>
    </div>
  )
}

export default ExcelExportFieldsModal
