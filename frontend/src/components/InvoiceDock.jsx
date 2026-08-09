/**
 * InvoiceDock — 右侧停靠式发票详情面板
 *
 * 职责：把 InvoiceDetail（弹窗版）的数据和样式迁移到右侧 Dock 侧边栏中，
 *   包含两个 Tab：「基础信息」和「项目明细」。
 *   复用 FIELD_LABELS / LINE_ITEM_FIELDS 及编辑/保存逻辑，
 *   视觉上从浮层弹窗改为停靠面板，与画布同处一行（挤压布局）。
 *
 * 数据来源：与 InvoiceDetail 一致，调用 /api/invoice/export-data，
 *   编辑保存走 /api/invoice/correct。
 *
 * 使用方式：由 App.jsx 通过眼睛按钮控制 open/close，
 *   数据文件 previewFile 作为 props 传入。
 *
 * @module components/InvoiceDock
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { BACKEND_URL } from '../config'
import { useFileContext } from '../contexts/FileContext'

const FIELD_LABELS = {
  invoiceType: '发票类型',
  invoiceNumber: '发票号码',
  invoiceDate: '开票日期',
  totalAmount: '总金额',
  buyerName: '购买方名称',
  buyerTaxNo: '购买方税号',
  sellerName: '销售方名称',
  sellerTaxNo: '销售方税号',
  amountWithoutTax: '税前金额',
  taxAmount: '总税额',
  issuer: '开票人',
  note: '备注',
}

const LINE_ITEM_FIELDS = [
  { key: 'xmmc', label: '项目名称', width: '22%' },
  { key: 'ggxh', label: '规格型号', width: '14%' },
  { key: 'dw', label: '单位', width: '10%' },
  { key: 'sl', label: '数量', width: '10%' },
  { key: 'dj', label: '单价', width: '16%' },
  { key: 'je', label: '金额', width: '10%' },
  { key: 'slv', label: '税率', width: '8%' },
  { key: 'se', label: '税额', width: '10%' },
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

/**
 * @param {Object} props
 * @param {Object} props.fileObj - 当前预览的文件对象（previewFile）
 * @param {boolean} props.open - 面板是否展开（控制动画的开关由父级布局负责）
 * @param {() => void} props.onClose - 关闭面板回调
 */
export default function InvoiceDock({ fileObj, onClose }) {
  const { files, setFiles } = useFileContext()

  const [activeTab, setActiveTab] = useState('basic') // 'basic' | 'items'
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

  // 加载发票导出数据
  useEffect(() => {
    if (!fileObj) {
      setLoading(false)
      return
    }
    const fileName = fileObj.originalName || fileObj.name || fileObj.fileName || fileObj.originalFilename || ''
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
  }, [fileObj?.key, fileObj?.name, fileObj?.fileName, fileObj?.originalFilename])

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
    const fileName = fileObj?.name || fileObj?.fileName || fileObj?.originalFilename || ''
    if (fileName) {
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
    }
    setEditMode(false)
    setDirty(false)
    setSaveResult(null)
  }, [backendInvoice, fileObj?.name, fileObj?.fileName, fileObj?.originalFilename])

  const handleSave = useCallback(async () => {
    if (!fileObj) return
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

  // 空状态：没有文件时
  if (!fileObj) {
    return (
      <div className="inv-dock">
        <div className="inv-dock-head">
          <span className="inv-dock-title">发票详情</span>
          <button className="inv-dock-close" onClick={onClose} title="关闭">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div className="inv-dock-empty">
          <span>请选择一个发票文件</span>
        </div>
      </div>
    )
  }

  return (
    <div className="inv-dock">
      {/* 头部：标题 + 编辑/关闭按钮 */}
      <div className="inv-dock-head">
        <span className="inv-dock-title">发票详情</span>
        <div className="inv-dock-head-actions">
          {!editMode ? (
            !loading && !loadError && (
              <button
                className="inv-dock-edit-btn"
                onClick={() => { setEditMode(true); setSaveResult(null) }}
                title="编辑"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
            )
          ) : (
            <>
              <button
                className="inv-dock-save-btn"
                onClick={handleSave}
                disabled={saving}
                title="保存"
              >
                {saving ? '...' : (
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </button>
              <button
                className="inv-dock-cancel-btn"
                onClick={handleCancel}
                disabled={saving}
                title="取消"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </>
          )}
          <button className="inv-dock-close" onClick={onClose} title="收起面板">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Tab 切换：基础信息 / 项目明细 */}
      <div className="inv-dock-tabs">
        <button
          className={`inv-dock-tab ${activeTab === 'basic' ? 'active' : ''}`}
          onClick={() => setActiveTab('basic')}
        >
          基础信息
        </button>
        <button
          className={`inv-dock-tab ${activeTab === 'items' ? 'active' : ''}`}
          onClick={() => setActiveTab('items')}
        >
          项目明细
          {lineItems.length > 0 && (
            <span className="inv-dock-tab-count">{lineItems.length}</span>
          )}
        </button>
      </div>

      {/* 保存结果提示条 */}
      {saveResult && (
        <div className={`inv-dock-alert inv-dock-alert-${saveResult.type}`}>
          {saveResult.message}
        </div>
      )}

      {/* 内容区 */}
      <div className="inv-dock-body">
        {loading && (
          <div className="inv-dock-loading">
            <svg className="inv-dock-spinner" viewBox="0 0 36 36" fill="none">
              <circle cx="18" cy="18" r="15" stroke="currentColor" strokeWidth="3"
                strokeDasharray="60 100" strokeLinecap="round" />
            </svg>
            <span>加载中...</span>
          </div>
        )}

        {!loading && loadError && (
          <div className="inv-dock-error">
            <span style={{ color: 'var(--danger)' }}>加载失败</span>
            <span style={{ fontSize: '11px', color: 'var(--text-3)', marginTop: '4px' }}>
              {loadError}
            </span>
          </div>
        )}

        {!loading && !loadError && activeTab === 'basic' && (
          <div className="inv-dock-fields">
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
                  <span className="id-field-value">
                    {fields[key] || <span className="id-empty">—</span>}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {!loading && !loadError && activeTab === 'items' && (
          <div className="inv-dock-items">
            {editMode && (
              <div className="inv-dock-items-toolbar">
                <button className="inv-dock-add-btn" onClick={addLineItem}>
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                  添加行
                </button>
              </div>
            )}
            {lineItems.length === 0 ? (
              <div className="id-empty-section">无明细行数据</div>
            ) : (
              <div className="id-line-items-table">
                <div className="id-table-header">
                  {LINE_ITEM_FIELDS.map(col => (
                    <div key={col.key} className="id-table-th" style={{ width: col.width }}>
                      {col.label}
                    </div>
                  ))}
                  {editMode && <div className="id-table-th" style={{ width: '36px' }}></div>}
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
                      <div className="id-table-td" style={{ width: '36px' }}>
                        <button
                          className="id-btn id-btn-danger-small"
                          onClick={() => removeLineItem(idx)}
                          title="删除"
                        >
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
