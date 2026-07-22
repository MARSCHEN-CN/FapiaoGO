import { memo, useRef, useState, useEffect, useMemo } from 'react'
import { List } from 'react-window'
import { isMergeMode, getMergeGroupStart, isFailedFile } from '../utils'
import { documentIdentityKey } from '../utils/documentViewModel'

const ROW_HEIGHT = 64
const OVERSCAN = 5

// ─── FileCard 行组件 ─────────────────────────────────────────────
const FileCardRow = memo(({ index, style, files, previewFileKey, previewFileDocId, mergeActive, mergeCount, duplicateInfo, previousYearInfo, fileRotations, onPreview, onRemove, onRotate, onHoverFile }) => {
  const fileObj = files?.[index]
  if (!fileObj) return null

  const mergeGroupStart = mergeActive ? getMergeGroupStart(index, mergeCount) : -1
  const isGroupFirst = mergeActive && index === mergeGroupStart
  const isGroupLast = mergeActive && index === mergeGroupStart + mergeCount - 1

  const dupInfo = duplicateInfo.get(documentIdentityKey(fileObj))
  const isDuplicate = !!dupInfo
  const isDupFirst = dupInfo?.isFirst
  const dupGroupIndex = dupInfo?.groupIndex

  // 往年发票（derived flag，优先级低于失败、高于重复）
  const prevInfo = previousYearInfo?.get(fileObj.key)
  const isPrevYear = !!prevInfo?.isPreviousYear
  const hasFailed = fileObj.failedFields?.length > 0
  const showPrevYear = !hasFailed && isPrevYear
  const showDuplicate = !hasFailed && !showPrevYear && isDuplicate

  const handleClick = () => {
    if (typeof onPreview === 'function') onPreview(fileObj)
  }
  const handleRemove = (e) => {
    e.stopPropagation()
    // document-level 聚合条目：删除所有分页
    if (fileObj._isDocumentGroup && fileObj._pages) {
      for (const page of fileObj._pages) onRemove(page.key)
    } else {
      onRemove(fileObj.key)
    }
  }
  const handleRotate = (e) => {
    e.stopPropagation()
    // document-level 聚合条目：旋转所有分页
    if (fileObj._isDocumentGroup && fileObj._pages) {
      for (const page of fileObj._pages) onRotate(page.key)
    } else {
      onRotate(fileObj.key)
    }
  }
  const handleMouseEnter = () => {
    // 只对已解析的文件触发预加载
    if (fileObj.status === 'parsed' && typeof onHoverFile === 'function') {
      onHoverFile(fileObj)
    }
  }

  let statusDotClass = 'pending'
  if (fileObj.status === 'parsed') {
    if (hasFailed) statusDotClass = 'failed'
    else if (showPrevYear) statusDotClass = 'prevyear'
    else if (isDuplicate) statusDotClass = 'duplicate'
    else statusDotClass = 'ready'
  }

  let typeClass = 'elec'
  let typeText = '其他'
  if (fileObj.invoiceType?.includes('专票')) { typeClass = 'zp'; typeText = '专票' }
  if (fileObj.invoiceType?.includes('普票')) { typeClass = 'pp'; typeText = '普票' }

  // 高亮：直接 key 匹配，或 document 聚合条目的 _pages 包含预览页
  // （不按 docId 匹配：相同内容重复导入共享 docId，会误亮另一实例的行）
  const isActive = previewFileKey === fileObj.key ||
    (fileObj._isDocumentGroup && Array.isArray(fileObj._pages) && fileObj._pages.some(p => p.key === previewFileKey))
  const isMultipage = fileObj._isDocumentGroup && fileObj._pageCount > 1

  return (
    <div
      style={style}
      className={`file-card ${isActive ? 'active' : ''} ${isGroupFirst ? 'merge-group-first' : ''} ${isGroupLast ? 'merge-group-last' : ''} ${fileObj.failedFields?.length > 0 ? 'has-failed' : ''} ${fileObj.status === 'parsing' ? 'parsing' : ''} ${showDuplicate ? 'duplicate' : ''} ${showPrevYear ? 'previous-year' : ''} ${isMultipage ? 'multipage' : ''}`}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
    >
      {showPrevYear && (
        <>
          <div className="prev-year-bar"></div>
          <div className="prev-year-label">往年发票</div>
        </>
      )}
      {showDuplicate && isDupFirst && <div className="duplicate-bar"></div>}
      {showDuplicate && <div className="duplicate-label">重复组 {dupGroupIndex}</div>}
      {isMultipage && <div className="multipage-label">共{fileObj._pageCount}页</div>}
      {isGroupFirst && mergeActive && <div className="merge-group-label">合并组 {Math.floor(index / mergeCount) + 1}</div>}

      <button className="file-card-rotate" onClick={handleRotate} title={`旋转 (${fileRotations?.[fileObj.key] || 0}°)`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 11-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
          <path d="M21 3v5h-5"/>
        </svg>
      </button>

      <button className="file-card-close" onClick={handleRemove} title="移除出列表">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>

      <div className="fc-row-top">
        <span className={`fc-type ${typeClass}`}>{typeText}</span>
        <span className="fc-name" title={fileObj.name}>{fileObj.name}</span>
        <span className={`fc-dot ${statusDotClass}`}></span>
      </div>

      <div className="fc-row-bottom">
        <span className={`fc-invoice-no${isFailedFile(fileObj) ? ' fc-failed-reason' : ''}`}
              title={isFailedFile(fileObj) ? fileObj.failedFields?.join('；') : ''}>
          {(() => {
            if (fileObj.status === 'parsing') return '解析中...'
            if (isFailedFile(fileObj)) {
              const FIELD_REASON_MAP = {
                'fphm': '发票号码为空',
                'kprq': '开票日期为空',
                'gmfmc': '购买方名称为空',
                'gmfsh': '购买方税号为空',
                'xsfmc': '销售方名称为空',
                'xsfsh': '销售方税号为空',
                'invoiceNumber': '发票号码为空',
                'invoiceDate': '开票日期为空',
                'amount': '金额为空',
                'amountHj': '金额为空',
              }
              const fields = fileObj.failedFields || []
              const reasons = fields.map(f => FIELD_REASON_MAP[f] || f).filter(Boolean)
              if (reasons.length === 0) return '解析失败'
              const fphmMissing = fields.includes('fphm') || fields.includes('invoiceNumber')
              const kprqMissing = fields.includes('kprq') || fields.includes('invoiceDate')
              const amountMissing = fields.includes('amount') || fields.includes('amountHj')
              if (fphmMissing && kprqMissing && amountMissing && !fileObj.invoiceNumber && !fileObj.invoiceDate && !fileObj.amount) {
                return '非发票文件，请检查'
              }
              return reasons.join('；')
            }
            return fileObj.invoiceDate && fileObj.invoiceDate !== '未知日期' ? fileObj.invoiceDate : '未知日期'
          })()}
        </span>
        {(() => {
          if (fileObj.status === 'parsing') return null
          if (isFailedFile(fileObj)) return <span className="fc-amount fc-failed">解析失败</span>
          if (!fileObj.amount) return null
          const num = parseFloat((fileObj.amount || '').replace(/[¥￥,\s]/g, ''))
          if (isNaN(num) || num === 0) return null
          return <span className="fc-amount">¥{num.toLocaleString()}</span>
        })()}
      </div>

      {fileObj.status === 'parsing' && (
        <div className="fc-progress-bar">
          <div className="fc-progress-fill"></div>
        </div>
      )}
    </div>
  )
  // 自定义 memo 比较：只在自己索引的文件对象引用变化时才重渲染
}, (prev, next) => {
  if (prev.index !== next.index) return false
  if (prev.style?.top !== next.style?.top || prev.style?.height !== next.style?.height) return false
  if (prev.files?.[prev.index] !== next.files?.[next.index]) return false
  if (prev.onPreview !== next.onPreview) return false
  if (prev.onRemove !== next.onRemove) return false
  if (prev.onRotate !== next.onRotate) return false
  if (prev.onHoverFile !== next.onHoverFile) return false
  if (prev.previewFileKey !== next.previewFileKey) return false
  if (prev.previewFileDocId !== next.previewFileDocId) return false
  if (prev.mergeActive !== next.mergeActive || prev.mergeCount !== next.mergeCount) return false
  if (prev.duplicateInfo !== next.duplicateInfo) return false
  if (prev.previousYearInfo !== next.previousYearInfo) return false
  if (prev.fileRotations !== next.fileRotations) return false
  return true
})

// ─── FileList 主组件 ────────────────────────────────────────────
export default memo(function FileList({
  files,
  previewFile,
  paperSize,
  duplicateInfo,
  previousYearInfo,
  fileRotations,
  onPreview,
  onRemove,
  onRotate,
  onHoverFile,
}) {
  const mergeActive = isMergeMode(paperSize)
  const mergeCount = mergeActive ? parseInt(paperSize.replace('merge', ''), 10) : 2
  const previewFileKey = previewFile?.key || null
  const previewFileDocId = previewFile?.docId || null
  const listRef = useRef(null)

  // ⚠ 警告：不要删除下面 rowProps 中的 `files` 键，即使 FileCardRow 未直接使用它。
  // react-window v2 内部用 Object.values(rowProps) 做 useMemo deps（react-window.js:456），
  // keys 数量必须恒定，且其中至少要有一个「值」随行数据变化而变。`files` 数组引用在
  // 搜索过滤/排序重排时变化 → Object.values() 检测到 → 内部 memo 失效 → 屏幕刷新。
  // 若改用 ref 间接访问（旧 filesRef 方案），即使 .current 变了，Object.values() 看到的
  // 仍是同一 ref 对象 → 永不变 → react-window 不重渲染 → "需要点击才更新"的 Bug。
  const rowProps = useMemo(() => ({
    files,           // Do NOT remove: react-window v2 memoizes Object.values(rowProps)
    previewFileKey,
    previewFileDocId,
    mergeActive,
    mergeCount,
    duplicateInfo,
    previousYearInfo,
    fileRotations,
    onPreview,
    onRemove,
    onRotate,
    onHoverFile,
  }), [files, previewFileKey, previewFileDocId, mergeActive, mergeCount, duplicateInfo, previousYearInfo, fileRotations, onPreview, onRemove, onRotate, onHoverFile])

  // 选中文件自动滚动（react-window v2 API：scrollToRow({ index, align })）
  useEffect(() => {
    if (!previewFileKey || !listRef.current) return
    let index = files.findIndex(f => f.key === previewFileKey)
    // document 聚合条目：回退按「预览页归属于该 document 的 _pages」匹配
    // （不按 docId：相同内容重复导入共享 docId，会滚动到另一实例的行）
    if (index === -1) {
      index = files.findIndex(f => f._isDocumentGroup && Array.isArray(f._pages) && f._pages.some(p => p.key === previewFileKey))
    }
    if (index !== -1) {
      listRef.current.scrollToRow({ index, align: 'smart' })
    }
  }, [previewFileKey, files])

  if (files.length === 0) {
    return (
      <div className="sb-files-scrollable" style={{ minHeight: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="file-list-empty"><span>暂无文件</span></div>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <List
        listRef={listRef}
        className="sb-files-scrollable"
        defaultHeight={500}
        rowCount={files.length}
        rowHeight={ROW_HEIGHT}
        rowComponent={FileCardRow}
        rowProps={rowProps}
        overscanCount={OVERSCAN}
        style={{ flex: 1 }}
      />
    </div>
  )
})
