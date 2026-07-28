import { useState, useCallback, useEffect, useRef } from 'react'
import { BACKEND_URL } from '../config'
import { useFileContext } from '../contexts/FileContext'

const FIELD_LABELS = {
  invoiceType: '发票类型',
  invoiceNumber: '发票号码',
  invoiceDate: '开票日期',
  totalAmount: '价税合计',
  buyerName: '购买方名称',
  buyerTaxNo: '购买方税号',
  sellerName: '销售方名称',
  sellerTaxNo: '销售方税号',
  amountWithoutTax: '金额（不含税）',
  taxAmount: '税额',
  issuer: '开票人',
  note: '备注',
}

const LINE_ITEM_FIELDS = [
  { key: 'xmmc', label: '项目名称', width: '25%' },
  { key: 'ggxh', label: '规格型号', width: '15%' },
  { key: 'dw', label: '单位', width: '8%' },
  { key: 'sl', label: '数量', width: '10%' },
  { key: 'dj', label: '单价', width: '17%' },
  { key: 'je', label: '金额', width: '10%' },
  { key: 'slv', label: '税率', width: '7%' },
  { key: 'se', label: '税额', width: '7%' },
]

const ROW_TO_EDIT_KEY = {
  unit: 'dw', quantity: 'sl', unitPrice: 'dj', lineAmount: 'je',
  taxRate: 'slv', lineTax: 'se', xmmc: 'xmmc', ggxh: 'ggxh',
}

const EMPTY_LINE_ITEM = { xmmc: '', ggxh: '', dw: '', sl: '', dj: '', je: '', slv: '', se: '' }

function rowToEditItem(r) {
  const item = { ...EMPTY_LINE_ITEM }
  for (const [rowKey, editKey] of Object.entries(ROW_TO_EDIT_KEY)) {
    const v = r[rowKey]
    if (v !== undefined && v !== null) item[editKey] = String(v)
  }
  return item
}

function emptyItem(item) {
  return Object.values(item || {}).every(v => !v || String(v).trim() === '')
}

export default function InvoiceDetail({ fileObj, onClose }) {
  const { files, setFiles } = useFileContext()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [backendInvoice, setBackendInvoice] = useState(null)

  const [editMode, setEditMode] = useState(false)
  const [fields, setFields] = useState({})
  const [lineItems, setLineItems] = useState([])
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState(null)
  const [dirty, setDirty] = useState(false)

  const abortRef = useRef(null)
  const loadedNameRef = useRef('')

  useEffect(() => {
    const fileName = fileObj.name || fileObj.fileName || fileObj.originalFilename || ''
    if (!fileName) {
      setLoadError('无法获取文件名')
      setLoading(false)
      return
    }
    if (abortRef.current) abortRef.current.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    setLoadError(null)
    setEditMode(false)
    setSaveResult(null)
    setDirty(false)

    fetch(`${BACKEND_URL}/api/invoice/export-data?file_name=${encodeURIComponent(fileName)}`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(data => {
        if (ctrl.signal.aborted) return
        if (data.success) {
          const inv = data.data.invoice || {}
          setBackendInvoice(inv)
          setFields({ ...inv })
          const rows = data.data.rows || []
          const items = rows.length > 0 ? rows.map(rowToEditItem) : []
          setLineItems(items)
          loadedNameRef.current = fileName
        } else {
          setLoadError(data.error || '获取数据失败')
        }
        setLoading(false)
      })
      .catch(err => {
        if (ctrl.signal.aborted) return
        setLoadError(`网络错误: ${err.message}`)
        setLoading(false)
      })

    return () => { ctrl.abort() }
  }, [fileObj.name, fileObj.fileName, fileObj.originalFilename])

  const handleFieldChange = useCallback((key, value) => {
    setFields(prev => ({ ...prev, [key]: value }))
    setDirty(true)
  }, [])

  const handleLineItemChange = useCallback((idx, key, value) => {
    setLineItems(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], [key]: value }
      return next
    })
    setDirty(true)
  }, [])

  const addLineItem = useCallback(() => {
    setLineItems(prev => [...prev, { ...EMPTY_LINE_ITEM }])
    setDirty(true)
  }, [])

  const removeLineItem = useCallback((idx) => {
    setLineItems(prev => prev.filter((_, i) => i !== idx))
    setDirty(true)
  }, [])

  const handleCancel = useCallback(() => {
    if (backendInvoice) {
      setFields({ ...backendInvoice })
    }
    const fileName = fileObj.name || fileObj.fileName || fileObj.originalFilename || ''
    fetch(`${BACKEND_URL}/api/invoice/export-data?file_name=${encodeURIComponent(fileName)}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          const inv = data.data.invoice || {}
          setBackendInvoice(inv)
          setFields({ ...inv })
          setLineItems((data.data.rows || []).map(rowToEditItem))
        }
      })
      .catch(() => {})
    setEditMode(false)
    setDirty(false)
    setSaveResult(null)
  }, [backendInvoice, fileObj.name, fileObj.fileName, fileObj.originalFilename])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaveResult(null)
    const fileName = fileObj.name || fileObj.fileName || fileObj.originalFilename || ''

    const corrected = {}
    const orig = backendInvoice || {}
    for (const key of Object.keys(FIELD_LABELS)) {
      const newV = fields[key]
      const origV = orig[key]
      if (String(newV ?? '') !== String(origV ?? '')) {
        corrected[key] = newV ?? ''
      }
    }

    const cleanItems = lineItems.filter(it => !emptyItem(it))

    const body = { file_name: fileName }
    if (Object.keys(corrected).length > 0) body.corrected_fields = corrected
    body.line_items = cleanItems

    try {
      const resp = await fetch(`${BACKEND_URL}/api/invoice/correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await resp.json()
      if (data.success) {
        const updatedInvoice = { ...backendInvoice, ...corrected }
        setBackendInvoice(updatedInvoice)
        setFields({ ...updatedInvoice })
        setLineItems(cleanItems.length > 0 ? cleanItems.map(it => ({ ...it })) : [])

        setFiles(prev => prev.map(f => {
          const fName = f.name || f.fileName || f.originalFilename || ''
          if (fName !== fileName && f.name !== fileName) return f
          const invFields = { ...(f.invoiceFields || {}) }
          const directMap = {
            invoiceNumber: ['invoiceNumber', 'fphm'],
            invoiceDate: ['invoiceDate', 'kprq'],
            invoiceType: ['invoiceType', 'type'],
            buyerName: ['gmfmc'],
            buyerTaxNo: ['gmfsh'],
            sellerName: ['xsfmc'],
            sellerTaxNo: ['xsfsh'],
            totalAmount: ['amountHj', 'amount'],
            amountWithoutTax: ['amountJe'],
            taxAmount: ['amountSe'],
            note: ['note'],
            issuer: ['kpr'],
          }
          for (const [corrKey, targetKeys] of Object.entries(directMap)) {
            if (corrected[corrKey] !== undefined) {
              for (const tk of targetKeys) invFields[tk] = corrected[corrKey]
            }
          }
          if (corrected.invoiceNumber !== undefined) f.invoiceNumber = corrected.invoiceNumber
          if (corrected.invoiceDate !== undefined) f.invoiceDate = corrected.invoiceDate
          if (corrected.invoiceType !== undefined) f.invoiceType = corrected.invoiceType
          if (corrected.totalAmount !== undefined) f.amount = corrected.totalAmount
          return { ...f, invoiceFields: invFields }
        }))

        setSaveResult({ type: 'success', message: data.message || '保存成功' })
        setDirty(false)
        setEditMode(false)
      } else {
        setSaveResult({ type: 'error', message: data.error || '保存失败' })
      }
    } catch (err) {
      setSaveResult({ type: 'error', message: `网络错误: ${err.message}` })
    } finally {
      setSaving(false)
    }
  }, [fields, lineItems, backendInvoice, fileObj, setFiles])

  if (loading) {
    return (
      <div className="invoice-detail-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div className="invoice-detail-panel" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '200px' }}>
          <p style={{ color: '#999' }}>加载中...</p>
        </div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="invoice-detail-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div className="invoice-detail-panel">
          <div className="invoice-detail-header">
            <h2>发票详情</h2>
            <button className="id-btn id-btn-close" onClick={onClose}>×</button>
          </div>
          <div className="invoice-detail-body">
            <div className="id-alert id-alert-error">加载失败: {loadError}</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="invoice-detail-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="invoice-detail-panel">
        <div className="invoice-detail-header">
          <h2>发票详情（导出数据）</h2>
          <div className="invoice-detail-header-actions">
            {!editMode ? (
              <button className="id-btn id-btn-primary" onClick={() => { setEditMode(true); setSaveResult(null) }}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                编辑
              </button>
            ) : (
              <>
                <button className="id-btn id-btn-success" onClick={handleSave} disabled={saving}>
                  {saving ? '保存中...' : '保存修正'}
                </button>
                <button className="id-btn id-btn-ghost" onClick={handleCancel} disabled={saving}>
                  取消
                </button>
              </>
            )}
            <button className="id-btn id-btn-close" onClick={onClose} title="关闭">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        {saveResult && (
          <div className={`id-alert id-alert-${saveResult.type}`}>
            {saveResult.message}
          </div>
        )}

        <div className="invoice-detail-body">
          <div className="id-field-row">
            <span className="id-field-label">文件名</span>
            <span className="id-field-value">{fileObj.name || fileObj.fileName || ''}</span>
          </div>

          {Object.entries(FIELD_LABELS).map(([key, label]) => (
            <div className="id-field-row" key={key}>
              <span className="id-field-label">{label}</span>
              {editMode ? (
                <input
                  className="id-field-input"
                  value={fields[key] ?? ''}
                  onChange={e => handleFieldChange(key, e.target.value)}
                />
              ) : (
                <span className="id-field-value">{fields[key] || <span className="id-empty">—</span>}</span>
              )}
            </div>
          ))}

          <div className="id-section-title">
            <span>明细行（{lineItems.length} 条）</span>
            {editMode && (
              <button className="id-btn id-btn-small" onClick={addLineItem}>+ 添加</button>
            )}
          </div>

          {lineItems.length === 0 ? (
            <div className="id-empty-section">无明细行数据</div>
          ) : (
            <div className="id-line-items-table">
              <div className="id-table-header">
                {LINE_ITEM_FIELDS.map(col => (
                  <div key={col.key} className="id-table-th" style={{ width: col.width }}>{col.label}</div>
                ))}
                {editMode && <div className="id-table-th" style={{ width: '40px' }}>操作</div>}
              </div>
              {lineItems.map((item, idx) => (
                <div className="id-table-row" key={idx}>
                  {LINE_ITEM_FIELDS.map(col => (
                    <div key={col.key} className="id-table-td" style={{ width: col.width }}>
                      {editMode ? (
                        <input
                          className="id-cell-input"
                          value={item[col.key] || ''}
                          onChange={e => handleLineItemChange(idx, col.key, e.target.value)}
                        />
                      ) : (
                        item[col.key] || ''
                      )}
                    </div>
                  ))}
                  {editMode && (
                    <div className="id-table-td" style={{ width: '40px' }}>
                      <button className="id-btn id-btn-danger-small" onClick={() => removeLineItem(idx)} title="删除">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ padding: '12px 0', fontSize: '11px', color: 'var(--text-4)', lineHeight: '1.6' }}>
            提示：保存的修正会立即作用于后续 Excel/PDF 导出。
          </div>
        </div>
      </div>
    </div>
  )
}
