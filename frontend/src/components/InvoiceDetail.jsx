import { useState, useCallback, useEffect } from 'react'
import { BACKEND_URL } from '../config'

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

// 后端返回的 export-data 字段名 → 编辑面板显示字段名
const EXPORT_TO_EDIT_MAP = {
  invoiceType: 'invoiceType',
  invoiceNumber: 'invoiceNumber',
  invoiceDate: 'invoiceDate',
  buyerName: 'buyerName',
  buyerTaxNo: 'buyerTaxNo',
  sellerName: 'sellerName',
  sellerTaxNo: 'sellerTaxNo',
  amountWithoutTax: 'amountWithoutTax',
  taxAmount: 'taxAmount',
  totalAmount: 'totalAmount',
  note: 'note',
  issuer: 'issuer',
}

export default function InvoiceDetail({ fileObj, onClose, files, setFiles }) {
  // 从后端获取导出数据（与 Excel 导出同一来源）
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [backendInvoice, setBackendInvoice] = useState(null)
  const [backendRows, setBackendRows] = useState([])

  const [editMode, setEditMode] = useState(false)
  const [fields, setFields] = useState({})
  const [lineItems, setLineItems] = useState([])
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState(null)
  const [dirty, setDirty] = useState(false)

  // 组件挂载时从后端拉取导出数据
  useEffect(() => {
    const fileName = fileObj.name || fileObj.fileName || fileObj.originalFilename || ''
    if (!fileName) {
      setLoadError('无法获取文件名')
      setLoading(false)
      return
    }
    fetch(`${BACKEND_URL}/api/invoice/export-data?file_name=${encodeURIComponent(fileName)}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          const inv = data.data.invoice || {}
          setBackendInvoice(inv)
          setBackendRows(data.data.rows || [])
          // 初始化编辑字段（取第一行的数据，这就是导出时的最终值）
          setFields(inv)
          const items = (data.data.rows || []).map(r => ({
            xmmc: r.xmmc || '',
            ggxh: r.ggxh || '',
            dw: r.unit || '',
            sl: r.quantity || String(r.quantity ?? ''),
            dj: r.unitPrice || '',
            je: r.lineAmount || '',
            slv: r.taxRate || '',
            se: r.lineTax || '',
          }))
          setLineItems(items.length > 0 ? items : [])
        } else {
          setLoadError(data.error || '获取数据失败')
        }
        setLoading(false)
      })
      .catch(err => {
        setLoadError(`网络错误: ${err.message}`)
        setLoading(false)
      })
  }, [fileObj.name, fileObj.fileName, fileObj.originalFilename])

  // 后续状态保持不变
  const [origFields, setOrigFields] = useState(null)

  useEffect(() => {
    if (backendInvoice && !origFields) {
      setOrigFields({ ...backendInvoice })
    }
  }, [backendInvoice, origFields])

  const handleFieldChange = (key, value) => {
    setFields(prev => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  const handleLineItemChange = (idx, key, value) => {
    setLineItems(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], [key]: value }
      return next
    })
    setDirty(true)
  }

  const addLineItem = () => {
    setLineItems(prev => [...prev, { xmmc: '', ggxh: '', dw: '', sl: '', dj: '', je: '', slv: '', se: '' }])
    setDirty(true)
  }

  const removeLineItem = (idx) => {
    setLineItems(prev => prev.filter((_, i) => i !== idx))
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveResult(null)

    // 构建修正字段（只传有变化的）
    const corrected = {}
    const orig = origFields || {}
    for (const key of Object.keys(FIELD_LABELS)) {
      if (String(fields[key] || '') !== String(orig[key] || '')) {
        corrected[key] = fields[key]
      }
    }

    const body = { corrected_fields: corrected }
    const origItemStr = JSON.stringify(origFields ? (backendRows || []).map(r => ({
      xmmc: r.xmmc || '', ggxh: r.ggxh || '', dw: r.unit || '',
      sl: r.quantity || '', dj: r.unitPrice || '', je: r.lineAmount || '',
      slv: r.taxRate || '', se: r.lineTax || '',
    })) : [])
    const newItemStr = JSON.stringify(lineItems)
    if (origItemStr !== newItemStr) {
      body.line_items = lineItems
    }

    try {
      const resp = await fetch(`${BACKEND_URL}/api/review-queue/resolve_manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_name: fileObj.name || fileObj.fileName || fileObj.originalFilename || '',
          ...body,
        }),
      })
      const data = await resp.json()
      if (data.success) {
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
  }

  // 加载中
  if (loading) {
    return (
      <div className="invoice-detail-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div className="invoice-detail-panel" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '200px' }}>
          <p style={{ color: '#999' }}>加载中...</p>
        </div>
      </div>
    )
  }

  // 加载失败
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

  const hasChanges = () => {
    if (!origFields) return false
    for (const key of Object.keys(FIELD_LABELS)) {
      if (String(fields[key] || '') !== String(origFields[key] || '')) return true
    }
    return false
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
                <button className="id-btn id-btn-success" onClick={handleSave} disabled={saving || !dirty}>
                  {saving ? '保存中...' : '保存修正'}
                </button>
                <button className="id-btn id-btn-ghost" onClick={() => { setEditMode(false); setFields(buildFieldMap(fileObj)); setDirty(false) }}>
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
            {saveResult.icon}{saveResult.message}
          </div>
        )}

        <div className="invoice-detail-body">
          {/* 文件名 */}
          <div className="id-field-row">
            <span className="id-field-label">文件名</span>
            <span className="id-field-value">{fileObj.name || fileObj.fileName || ''}</span>
          </div>

          {/* 发票级字段 */}
          {Object.entries(FIELD_LABELS).map(([key, label]) => (
            <div className="id-field-row" key={key}>
              <span className="id-field-label">{label}</span>
              {editMode ? (
                <input
                  className="id-field-input"
                  value={fields[key] || ''}
                  onChange={e => handleFieldChange(key, e.target.value)}
                />
              ) : (
                <span className="id-field-value">{fields[key] || <span className="id-empty">—</span>}</span>
              )}
            </div>
          ))}

          {/* 明细行 */}
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
        </div>
      </div>
    </div>
  )
}
