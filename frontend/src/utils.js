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
export function isMergeMode(mergeMode) {
  return ['merge2', 'merge3', 'merge4'].includes(mergeMode)
}

export function getMergeGroupStart(index, groupSize = 2) {
  return Math.floor(index / groupSize) * groupSize
}

export function getMergePair(files, clickedKey, groupSize = 2) {
  // 使用全部文件（而非仅 parsed），确保新导入/解析中的文件也参与合并分组
  const idx = files.findIndex(f => f.key === clickedKey)
  if (idx === -1) return null
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

    // 需要有有效的发票号码才进行分组
    if (!invoiceNumber) return

    // 使用发票号码作为分组key（数电票20位号码已是唯一标识）
    const key = invoiceNumber

    if (!duplicates.has(key)) {
      duplicates.set(key, [])
    }
    duplicates.get(key).push(file)
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

export function applySort(list, field, order) {
  const dir = order === 'desc' ? -1 : 1

  // 单次遍历分区：将失败文件与正常文件分开
  // 避免先 sort 再 filter 导致的多次 isFailedFile 调用
  const failedFiles = []
  const normalFiles = []
  for (let i = 0; i < list.length; i++) {
    if (isFailedFile(list[i])) {
      failedFiles.push(list[i])
    } else {
      normalFiles.push(list[i])
    }
  }

  // 在失败的文件内部，以及正常的文件之间应用排序规则

  // 对失败文件内部应用排序规则
  const sortFn = (a, b) => {
    switch (field) {
      case 'invoiceType': {
        const typeOrder = (t) => {
          if (t === '专票') return 0
          if (t === '普票') return 1
          return 2
        }
        return (typeOrder(a.invoiceType) - typeOrder(b.invoiceType)) * dir
      }
      case 'fileName':
        return naturalSort(a.name, b.name) * dir
      case 'amount': {
        const parseAmt = (s) => {
          if (!s) return NaN
          const n = parseFloat(String(s).replace(/[¥￥,\s]/g, ''))
          return isNaN(n) ? NaN : n
        }
        const amtA = parseAmt(a.amount)
        const amtB = parseAmt(b.amount)
        if (isNaN(amtA) && isNaN(amtB)) return 0
        if (isNaN(amtA)) return 1
        if (isNaN(amtB)) return -1
        return (amtA - amtB) * dir
      }
      case 'invoiceDate': {
        const dateA = a.invoiceDate && a.invoiceDate !== '未知日期' ? a.invoiceDate : ''
        const dateB = b.invoiceDate && b.invoiceDate !== '未知日期' ? b.invoiceDate : ''
        if (!dateA && !dateB) return 0
        if (!dateA) return 1
        if (!dateB) return -1
        return dateA.localeCompare(dateB) * dir
      }
      default:
        return 0
    }
  }

  // 分别对失败文件和正常文件应用排序
  failedFiles.sort(sortFn)
  normalFiles.sort(sortFn)

  // 合并：失败文件在前，正常文件在后
  return [...failedFiles, ...normalFiles]
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
