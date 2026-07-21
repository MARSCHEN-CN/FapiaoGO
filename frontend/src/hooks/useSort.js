import { useState, useCallback, useEffect, useRef } from 'react'
import { applySort, getPreviousYearInfo } from '../utils'
import { buildDocumentViewModel, buildPageDuplicateInfo } from '../utils/documentViewModel'

export function useSort(setFiles, files) {
  const [sortBy, setSortBy] = useState(() => {
    try { return localStorage.getItem('invoiceSortBy') || 'fileName' }
    catch { return 'fileName' }
  })
  const [sortOrder, setSortOrder] = useState(() => {
    try { return localStorage.getItem('invoiceSortOrder') || 'asc' }
    catch { return 'asc' }
  })

  const sortByRef = useRef(sortBy)
  const sortOrderRef = useRef(sortOrder)

  useEffect(() => { sortByRef.current = sortBy }, [sortBy])
  useEffect(() => { sortOrderRef.current = sortOrder }, [sortOrder])

  const toggleSort = useCallback((field) => {
    if (sortBy === field) {
      const newOrder = sortOrder === 'asc' ? 'desc' : 'asc'
      setSortOrder(newOrder)
      try { localStorage.setItem('invoiceSortOrder', newOrder) } catch {}
    } else {
      setSortBy(field)
      setSortOrder('asc')
      try {
        localStorage.setItem('invoiceSortBy', field)
        localStorage.setItem('invoiceSortOrder', 'asc')
      } catch {}
    }
  }, [sortBy, sortOrder])

  const duplicateInfo = useRef(null)
  const previousYearInfo = useRef(null)
  useEffect(() => {
    if (!files || files.length === 0) {
      duplicateInfo.current = null
      previousYearInfo.current = null
      return
    }
    // D1：重复检测以 document 为单位，再投影到页 key 供 applySort 分区
    //    （同一 document 的所有页共享组索引，排序后拆分页仍相邻）
    const { duplicateGroups } = buildDocumentViewModel(files)
    duplicateInfo.current = buildPageDuplicateInfo(duplicateGroups)
    previousYearInfo.current = getPreviousYearInfo(files)
  }, [files])

  useEffect(() => {
    setFiles(current => {
      if (current.length <= 1) return current
      return applySort(current, sortBy, sortOrder, duplicateInfo.current, previousYearInfo.current)
    })
  }, [sortBy, sortOrder, setFiles])

  return {
    sortBy, sortOrder,
    toggleSort,
    sortByRef, sortOrderRef,
  }
}
