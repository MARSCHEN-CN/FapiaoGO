import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { applySort } from '../utils'

/**
 * useSort — 文件列表排序 Hook
 *
 * P0-2 优化：duplicatePageInfo 和 previousYearInfo 改为从外部传入（由 FileContext 集中计算），
 * 避免在排序时重复执行 O(n) 的 buildDocumentViewModel + getPreviousYearInfo。
 *
 * P1-B 优化：合并排序触发逻辑，同时监听 sortBy/sortOrder 变化和 files 内容变化。
 * useFileOps 不再内联排序——导入完成后由本 Hook 自动处理，消除双重计算。
 *
 * @param {Function} setFiles - FileContext 的 setFiles
 * @param {Array} files - 当前文件列表
 * @param {Map} duplicatePageInfo - buildPageDuplicateInfo(documentView.duplicateGroups) 结果
 * @param {Map} previousYearInfo - getPreviousYearInfo(files) 结果
 * @param {Map} importHistoryInfo - 重复报销历史 Map（异步查询填充，key=file.key，value={exists,...}）
 */
export function useSort(setFiles, files, duplicatePageInfo, previousYearInfo, importHistoryInfo) {
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

  // 使用从 FileContext 传入的已计算数据，不再重复计算
  const duplicateInfoRef = useRef(null)
  const previousYearInfoRef = useRef(null)
  const importHistoryInfoRef = useRef(null)

  useEffect(() => {
    duplicateInfoRef.current = duplicatePageInfo
    previousYearInfoRef.current = previousYearInfo
    importHistoryInfoRef.current = importHistoryInfo
  }, [duplicatePageInfo, previousYearInfo, importHistoryInfo])

  // P1-B: order-invariant 排序键签名（仅包含影响排序的字段：key 用于检测增删，其余字段影响排序结果）
  // 注意：status 不包含在内——解析期间的 status 更新不应触发多余排序
  const sortSig = useMemo(() => {
    if (!files.length) return ''
    return files.map(f => {
      const key = f.key
      const date = f.invoiceDate || ''
      const type = f.invoiceType || ''
      const amount = f.amount || ''
      const name = f.name || ''
      return `${key}|${date}|${type}|${amount}|${name}`
    }).sort().join('‖')
  }, [files])

  // 重复报销 Map 异步填充（300ms debounce 查询）：引用/内容变化须触发重排，否则不置顶
  const importHistorySig = useMemo(() => {
    if (!importHistoryInfo || importHistoryInfo.size === 0) return ''
    return Array.from(importHistoryInfo.keys()).sort().join('|')
  }, [importHistoryInfo])

  // 上次已完成排序的签名（防止对同一组数据重复排序）
  const lastSortedSigRef = useRef('')

  // 统一排序触发：sortBy/sortOrder 变化 或 排序相关字段变化（新文件导入/删除/字段修改/重复报销返回）
  useEffect(() => {
    // 文件列表清空时重置签名，防止清空后重新导入相同文件时签名匹配导致跳过排序
    if (!files.length) {
      lastSortedSigRef.current = ''
      return
    }
    const combinedSig = `${sortBy}|${sortOrder}|${sortSig}|ih:${importHistorySig}`
    if (!sortSig || combinedSig === lastSortedSigRef.current) return

    lastSortedSigRef.current = combinedSig
    setFiles(current => {
      if (current.length <= 1) return current
      return applySort(current, sortByRef.current, sortOrderRef.current, duplicateInfoRef.current, previousYearInfoRef.current, importHistoryInfoRef.current)
    })
  }, [sortBy, sortOrder, sortSig, importHistorySig, setFiles])

  return {
    sortBy, sortOrder,
    toggleSort,
    sortByRef, sortOrderRef,
  }
}