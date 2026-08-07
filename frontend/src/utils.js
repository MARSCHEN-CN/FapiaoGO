// ============================
// 纯工具函数（无 React 依赖）
// ============================

export function isElectron() {
  return !!window.electronAPI
}

export function getElectronAPI() {
  if (window.electronAPI) return window.electronAPI
  try {
    if (window.require) {
      const electron = window.require('electron')
      return {
        ipcRenderer: electron.ipcRenderer,
        getFilePath: (file) => file.path || '',
      }
    }
  } catch (e) { /* 非 Electron 环境 */ }
  return null
}

export function getFilePath(file) {
  const api = getElectronAPI()
  if (api?.getFilePath) {
    try { return api.getFilePath(file) }
    catch (e) { console.error('[getFilePath] 获取路径失败:', e) }
  }
  return file.path || ''
}

/**
 * 获取文件名的小写扩展名（不含点号）
 * @param {string} filename - 文件名或路径
 * @returns {string} 小写扩展名，空字符串表示无扩展名
 */
export function getExtension(filename) {
  if (!filename) return ''
  const parts = filename.split('.')
  return parts.length > 1 ? parts.pop().toLowerCase() : ''
}

/**
 * 获取带点号的小写扩展名
 * @param {string} filename - 文件名或路径
 * @returns {string} 如 '.pdf'，空字符串表示无扩展名
 */
export function getExtensionWithDot(filename) {
  const ext = getExtension(filename)
  return ext ? '.' + ext : ''
}

export function getFileFormat(filename) {
  if (!filename) return 'pdf'
  const ext = getExtension(filename)
  if (ext === 'ofd') return 'ofd'
  if (['jpg', 'jpeg', 'png', 'bmp', 'tiff', 'tif'].includes(ext)) return 'image'
  return 'pdf'
}

/**
 * 根据文件扩展名获取 MIME 类型
 * @param {string} ext - 小写扩展名（不含点号）
 * @returns {string} MIME 类型字符串，未知扩展名默认返回 'application/pdf'
 */
export function getMimeType(ext) {
  const MAP = {
    'ofd': 'application/ofd',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'bmp': 'image/bmp',
    'tiff': 'image/tiff',
    'tif': 'image/tiff',
  }
  return MAP[ext] || 'application/pdf'
}

export function b64toBlob(b64Data, contentType = 'image/png') {
  try {
    // ★ 兼容带 data:image/png;base64, 前缀和纯 base64 两种格式
    let raw = b64Data
    if (raw && raw.startsWith('data:')) {
      raw = raw.split(',')[1] || ''
    }
    const byteChars = atob(raw)
    const len = byteChars.length
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
      bytes[i] = byteChars.charCodeAt(i)
    }
    return new Blob([bytes], { type: contentType })
  } catch (e) {
    console.error('[b64toBlob] base64 解码失败，数据长度:', b64Data?.length, e)
    return new Blob([], { type: contentType })
  }
}

export function naturalSort(a, b) {
  const ax = [], bx = []
  a.replace(/(\d+)|(\D+)/g, (_, $1, $2) => { ax.push([$1 || Infinity, $2 || '']) })
  b.replace(/(\d+)|(\D+)/g, (_, $1, $2) => { bx.push([$1 || Infinity, $2 || '']) })
  let i = 0
  while (i < ax.length && i < bx.length) {
    const an = ax[i], bn = bx[i]
    const nn = (an[0] - bn[0]) || an[1].localeCompare(bn[1])
    if (nn) return nn
    i++
  }
  return ax.length - bx.length
}

// ── 预计算排序键（P0 优化：将 O(n log n) 正则比较降为 O(n) 预计算 + O(1) 比较） ──

/**
 * 将文件名预分割为自然排序 token 数组，避免在 Array.sort 比较器中反复执行正则。
 * 300 条数据 → 约 5000 次比较 → 5000 次正则 → 优化为 1 次正则 + O(1) 数组比较。
 */
function tokenizeNaturalSort(str) {
  if (!str) return [[Infinity, '']]
  const tokens = []
  str.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
    tokens.push([$1 ? Number($1) : Infinity, $2 || ''])
  })
  return tokens
}

/**
 * 比较两个预分割的自然排序 token 数组。
 * @returns {number} -1 / 0 / 1
 */
function compareNaturalTokens(aTokens, bTokens) {
  const len = Math.min(aTokens.length, bTokens.length)
  for (let i = 0; i < len; i++) {
    const an = aTokens[i], bn = bTokens[i]
    const diff = (an[0] - bn[0]) || an[1].localeCompare(bn[1])
    if (diff) return diff
  }
  return aTokens.length - bTokens.length
}

/**
 * 预计算排序键数组。对列表每个元素计算一次主排序值和兜底排序值。
 * @param {Array} list - 文件列表
 * @param {string} field - 排序字段
 * @returns {{ primary: Array, fallbackTokens: Array }}
 */
function precomputeSortKeys(list, field) {
  const n = list.length
  const primary = new Array(n)
  const fallbackTokens = new Array(n)

  for (let i = 0; i < n; i++) {
    const file = list[i]
    fallbackTokens[i] = tokenizeNaturalSort(file?.name || '')

    switch (field) {
      case 'invoiceType': {
        const t = file?.invoiceType
        primary[i] = t === '专票' ? 0 : t === '普票' ? 1 : 2
        break
      }
      case 'fileName': {
        primary[i] = fallbackTokens[i]
        break
      }
      case 'amount': {
        let val = NaN
        if (file?.amount) {
          const n = parseFloat(String(file.amount).replace(/[¥￥,\s]/g, ''))
          if (!isNaN(n)) val = n
        }
        primary[i] = val
        break
      }
      case 'invoiceDate': {
        const d = file?.invoiceDate && file.invoiceDate !== '未知日期' ? file.invoiceDate : ''
        primary[i] = d
        break
      }
      default:
        primary[i] = 0
    }
  }
  return { primary, fallbackTokens }
}
export function isMergeMode(mergeMode) {
  return ['merge2', 'merge3', 'merge4'].includes(mergeMode)
}

export function getMergeGroupStart(index, groupSize = 2) {
  return Math.floor(index / groupSize) * groupSize
}

export function getMergePair(files, clickedKey, groupSize = 2, indexMap) {
  // 使用全部文件（而非仅 parsed），确保新导入/解析中的文件也参与合并分组
  // indexMap 可选：传入则 O(1) 查找，否则 fallback O(n) findIndex
  const idx = indexMap
    ? indexMap.get(clickedKey)
    : files.findIndex(f => f.key === clickedKey)
  if (idx == null || idx < 0) return null
  const start = getMergeGroupStart(idx, groupSize)
  const result = []
  for (let i = 0; i < groupSize; i++) {
    if (files[start + i]) {
      result.push(files[start + i])
    }
  }
  return result
}

// ============================
// 重复发票检测
// ============================

/**
 * 检测重复发票（按发票号码）
 * @param {Array} files - 文件列表
 * @returns {Map} - 重复组映射，key为发票号码，value为文件数组
 */
export function detectDuplicateInvoices(files) {
  const duplicates = new Map()

  files.forEach(file => {
    // 只检查已解析且有发票号码的文件
    if (file.status !== 'parsed') return

    const invoiceNumber = file.invoiceNumber || ''
    
    // 核心规则：根据发票号码判定重复。无发票号的文件不参与重复判定。
    if (!invoiceNumber) return

    if (!duplicates.has(invoiceNumber)) {
      duplicates.set(invoiceNumber, [])
    }
    duplicates.get(invoiceNumber).push(file)
  })

  // 只保留有重复（数量>1）的组
  const result = new Map()
  duplicates.forEach((filesList, key) => {
    if (filesList.length > 1) {
      result.set(key, filesList)
    }
  })

  return result
}

/**
 * 获取文件的重复组信息
 * @deprecated D1 起重复检测以 document 为单位：请改用
 *   utils/documentViewModel 的 buildDocumentDuplicateInfo(duplicateGroups)。
 *   本函数按 page-level 记录建组，多页发票的同号页会被误判为重复，
 *   保留一个版本周期后删除。
 * @param {Array} files - 文件列表
 * @returns {Map} - key为文件key，value为{groupIndex, isFirst, total}的Map
 */
export function getDuplicateGroupInfo(files) {
  const duplicates = detectDuplicateInvoices(files)
  const fileInfo = new Map()

  let groupIndex = 0
  duplicates.forEach((dupFiles, key) => {
    groupIndex++
    dupFiles.forEach((file, idx) => {
      fileInfo.set(file.key, {
        groupIndex,
        isFirst: idx === 0,
        total: dupFiles.length,
        groupKey: key
      })
    })
  })

  return fileInfo
}

// ============================
// 往年发票检测（derived flag，不污染 File 数据结构）
// ============================

/**
 * 从发票日期字符串中提取 4 位年份。
 * 支持格式：2024-01-01 / 2024年01月01日 / 2024/01/01 / 2024.01.01 / 未知日期 / 空。
 * @param {string|null|undefined} invoiceDate
 * @returns {number|null} 提取到的年份，无法识别时返回 null
 */
export function extractInvoiceYear(invoiceDate) {
  if (!invoiceDate || typeof invoiceDate !== 'string' || invoiceDate === '未知日期') return null
  const m = invoiceDate.match(/(?:19|20)\d{2}/)
  return m ? parseInt(m[0], 10) : null
}

/**
 * 判断单文件是否为往年发票（已解析且开票年份早于当前年）。
 * @param {Object} file - 文件对象
 * @param {number} [currentYear] - 当前年份，默认取系统年（便于测试注入）
 * @returns {boolean}
 */
export function isPreviousYearFile(file, currentYear = new Date().getFullYear()) {
  if (!file || file.status !== 'parsed') return false
  const y = extractInvoiceYear(file.invoiceDate)
  return y != null && y < currentYear
}

/**
 * 获取文件列表的往年发票信息（与 getDuplicateGroupInfo 同构，返回 Map）。
 * 仅已解析文件参与判定；未解析/无年份文件语义干净（year:null, isPreviousYear:false）。
 * @param {Array} files - 文件列表
 * @param {number} [currentYear] - 当前年份，默认取系统年（便于测试注入）
 * @returns {Map} key为文件key，value为 { year, isPreviousYear }
 */
export function getPreviousYearInfo(files, currentYear = new Date().getFullYear()) {
  const map = new Map()
  for (const f of (files || [])) {
    if (f.status !== 'parsed') {
      map.set(f.key, { year: null, isPreviousYear: false })
      continue
    }
    const y = extractInvoiceYear(f.invoiceDate)
    map.set(f.key, { year: y, isPreviousYear: y != null && y < currentYear })
  }
  return map
}

// ============================
// 侧栏告警优先级（解析失败 > 重复组 > 往年发票）
// ============================

/**
 * 告警优先级（从高到低）。后续扩展（红冲/作废/缺税号/金额异常）追加到此数组即可。
 */
export const FILE_ALERT_PRIORITY = [
  'failed',
  'duplicate',
  'previousYear',
]

/**
 * 解析侧栏统计区应展示的告警模式。
 * @param {{ hasFailed: boolean, previousYearCount: number, duplicateCount: number }} args
 * @returns {'failed'|'previousYear'|'duplicate'|'normal'}
 */
export function resolveStatsMode({ hasFailed, previousYearCount, duplicateCount }) {
  if (hasFailed) return 'failed'
  if (duplicateCount) return 'duplicate'
  if (previousYearCount) return 'previousYear'
  return 'normal'
}

/**
 * 检查文件是否解析失败
 */
export function isFailedFile(file) {
  if (file.status === 'error') return true
  if (file.failedFields?.length > 0) return true
  if (file.parseMethod?.includes('数据缺失')) return true
  if (file.parseMethod?.includes('缺失')) return true
  return false
}

export function applySort(list, field, order, duplicateInfo = null, previousYearInfo = null) {
  const dir = order === 'desc' ? -1 : 1
  const n = list.length
  if (n <= 1) return list

  // 单次遍历分区 + 预计算排序键
  const failedFiles = []
  const duplicateGroups = new Map()
  const previousYearFiles = []
  const normalFiles = []

  for (let i = 0; i < n; i++) {
    const file = list[i]
    if (isFailedFile(file)) {
      failedFiles.push(file)
    } else if (duplicateInfo && duplicateInfo.has(file.key)) {
      const groupIndex = duplicateInfo.get(file.key).groupIndex
      if (!duplicateGroups.has(groupIndex)) {
        duplicateGroups.set(groupIndex, [])
      }
      duplicateGroups.get(groupIndex).push(file)
    } else if (previousYearInfo && previousYearInfo.get(file.key)?.isPreviousYear) {
      previousYearFiles.push(file)
    } else {
      normalFiles.push(file)
    }
  }

  // 为每个分区独立预计算排序键
  function sortPartition(arr) {
    if (arr.length <= 1) return arr
    const { primary, fallbackTokens } = precomputeSortKeys(arr, field)

    const sortFn = (ai, bi) => {
      let result = 0
      const aVal = primary[ai], bVal = primary[bi]

      switch (field) {
        case 'fileName':
          result = compareNaturalTokens(aVal, bVal) * dir
          break
        case 'amount': {
          const aNaN = isNaN(aVal), bNaN = isNaN(bVal)
          if (aNaN && bNaN) result = 0
          else if (aNaN) result = 1
          else if (bNaN) result = -1
          else result = (aVal - bVal) * dir
          break
        }
        case 'invoiceDate': {
          if (!aVal && !bVal) result = 0
          else if (!aVal) result = 1
          else if (!bVal) result = -1
          else result = aVal.localeCompare(bVal) * dir
          break
        }
        case 'invoiceType':
        default:
          result = (aVal - bVal) * dir
      }

      if (result !== 0) return result
      // 兜底：按文件名自然排序保证稳定性
      return compareNaturalTokens(fallbackTokens[ai], fallbackTokens[bi])
    }

    // 使用索引数组排序，避免移动对象
    const indices = arr.map((_, i) => i)
    indices.sort(sortFn)
    return indices.map(i => arr[i])
  }

  // 分别对各分区应用排序
  const sortedFailed = sortPartition(failedFiles)
  const sortedPreviousYear = sortPartition(previousYearFiles)

  // 重复组：先按组索引升序排列组，组内按用户选定字段排序
  const sortedDuplicateGroups = []
  const sortedGroupIndices = [...duplicateGroups.keys()].sort((a, b) => a - b)
  for (const groupIndex of sortedGroupIndices) {
    const groupFiles = duplicateGroups.get(groupIndex)
    const sortedGroup = sortPartition(groupFiles)
    sortedDuplicateGroups.push(...sortedGroup)
  }

  const sortedNormal = sortPartition(normalFiles)

  // 合并：失败文件在前，然后是重复组，然后是往年发票，最后是非重复文件
  return [...sortedFailed, ...sortedDuplicateGroups, ...sortedPreviousYear, ...sortedNormal]
}

// ============================
// 文件搜索过滤（前端执行，避免 HTTP 往返）
// ============================

/**
 * 构建搜索文本（提前小写化，用于快速搜索）
 * @param {Object} file - 文件对象
 * @returns {string} - 拼接好的搜索文本
 */
export function buildSearchText(file) {
  const fields = [
    file.name,
    file.invoiceNumber,
    file.invoiceType,
    file.amount,
    file.invoiceDate,
    file.invoice_fields?.gmfmc,
    file.invoice_fields?.xsfmc,
    file.invoice_fields?.note,
    file.invoice_fields?.xmmc,
    file.rawText,
  ]
  return fields.filter(f => typeof f === 'string' && f).join('|').toLowerCase()
}

/**
 * 在文件列表中搜索匹配的文件（前端执行，无网络开销）
 * @param {Array} files - 文件对象数组
 * @param {string} query - 搜索关键词
 * @returns {Array} 匹配的文件列表
 */
export function filterFiles(files, query) {
  const q = query?.trim?.()?.toLowerCase() || ''

  if (!q) return files

  return files.filter(file => {
    // 文件一旦创建即预计算 searchText（buildFileObj 中设置），解析成功后更新为全字段搜索文本
    if (file.searchText) {
      return file.searchText.includes(q)
    }
    // 兜底：极低概率的边界情况（如外部注入的文件对象）
    return file.name?.toLowerCase()?.includes(q)
  })
}

/**
 * debounce 函数
 * @param {Function} func - 要执行的函数
 * @param {number} wait - 等待时间（毫秒）
 * @returns {Function} - debounced 函数
 */
export function debounce(func, wait = 200) {
  let timeout = null
  return function(...args) {
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => func(...args), wait)
  }
}

// ============================
// 优先级队列（用于文件解析优先级管理）
// ============================

/**
 * 优先级队列 - 支持高优先级任务插队
 */
export class PriorityQueue {
  constructor() {
    this.highPriority = []  // 高优先级队列（用户点击的文件）
    this.normalPriority = [] // 普通优先级队列
    this.processing = new Set() // 正在处理的文件key
    this.completed = new Set()  // 已完成的文件key
  }

  /**
   * 添加普通优先级任务
   */
  enqueue(item) {
    if (!this.completed.has(item.key) && !this.processing.has(item.key)) {
      this.normalPriority.push(item)
    }
  }

  /**
   * 添加高优先级任务（插队到前面）
   */
  enqueueHighPriority(item) {
    if (!this.completed.has(item.key) && !this.processing.has(item.key)) {
      // 从普通队列中移除（如果存在）
      const idx = this.normalPriority.findIndex(i => i.key === item.key)
      if (idx !== -1) {
        this.normalPriority.splice(idx, 1)
      }
      this.highPriority.unshift(item)
    }
  }

  /**
   * 获取下一个任务
   */
  dequeue() {
    // 优先处理高优先级队列
    if (this.highPriority.length > 0) {
      const item = this.highPriority.shift()
      this.processing.add(item.key)
      return item
    }
    // 然后处理普通队列
    if (this.normalPriority.length > 0) {
      const item = this.normalPriority.shift()
      this.processing.add(item.key)
      return item
    }
    return null
  }

  /**
   * 标记任务完成
   */
  complete(key) {
    this.processing.delete(key)
    this.completed.add(key)
    // 防止长期运行时 completed 集合无限增长导致内存泄漏
    if (this.completed.size > 2000) {
      this.completed.clear()
      this.completed.add(key)
    }
  }

  /**
   * 获取队列总长度
   */
  get length() {
    return this.highPriority.length + this.normalPriority.length + this.processing.size
  }

  /**
   * 获取待处理数量（不含正在处理）
   */
  get pendingCount() {
    return this.highPriority.length + this.normalPriority.length
  }

  /**
   * 清空队列
   */
  clear() {
    this.highPriority = []
    this.normalPriority = []
    this.processing.clear()
    this.completed.clear()
  }
}

// ============================
// 批量处理工具函数
// ============================

/**
 * 将数组分块，支持并发限制
 * @param {Array} array - 要分块的数组
 * @param {number} concurrencyLimit - 并发限制数
 * @returns {Array<Array>} 分块后的数组
 */
export function chunkedFiles(array, concurrencyLimit = 5) {
  const chunks = []
  for (let i = 0; i < array.length; i += concurrencyLimit) {
    chunks.push(array.slice(i, i + concurrencyLimit))
  }
  return chunks
}

/**
 * 并发执行器（流式：有完成立即开始下一个，不等整批）
 * 相比分块模式，当后端支持多线程时吞吐量更高
 */
export async function concurrentBatch(items, handler, concurrency = 5) {
  const results = new Array(items.length)
  let cursor = 0

  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++
      try {
        results[idx] = await handler(items[idx], idx)
      } catch (error) {
        results[idx] = { error, item: items[idx] }
      }
    }
  }

  // 启动 N 个并发 worker，共享同一个 cursor
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  )
  await Promise.all(workers)
  return results
}
