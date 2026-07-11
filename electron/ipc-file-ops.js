'use strict'

const { ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { FILE_DIALOG_FILTERS, SUPPORTED_EXTENSIONS } = require('./constants')

// 文件扫描配置
const MAX_SCAN_FILES = 3000
const MAX_SCAN_DEPTH = 5

// 并发限制配置
const MAX_STAT_CONCURRENCY = 50

/**
 * 限制并发的 map 函数
 * @param {Array} items - 要处理的数组
 * @param {number} limit - 最大并发数
 * @param {Function} worker - 处理函数
 * @returns {Promise<Array>}
 */
async function mapLimit(items, limit, worker) {
  const results = []
  let index = 0

  async function run() {
    while (index < items.length) {
      const current = index++
      results[current] = await worker(items[current])
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, run)
  await Promise.all(workers)
  return results
}

/**
 * 异步递归扫描文件夹中所有支持的发票文件
 * @param {string} dirPath - 目录路径
 * @param {number} depth - 当前递归深度
 * @param {Array} results - 结果数组
 * @returns {Promise<Array>}
 */
async function scanInvoiceFilesAsync(dirPath, depth = 0, results = []) {
  if (depth > MAX_SCAN_DEPTH) return results
  if (results.length >= MAX_SCAN_FILES) return results

  let entries
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    if (results.length >= MAX_SCAN_FILES) break

    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await scanInvoiceFilesAsync(fullPath, depth + 1, results)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        results.push({ name: entry.name, path: fullPath })
      }
    }
  }

  return results
}

/**
 * 注册文件操作相关的 IPC handlers
 * @param {Object} ctx
 * @param {Function} ctx.getMainWindow - 获取主窗口引用的函数
 */
function registerFileOpsHandlers(ctx) {
  // 文件大小限制: 50MB
  const MAX_FILE_SIZE = 50 * 1024 * 1024

  // ==========================================
  // ✅ 读取文件内容（异步 + 大小限制）
  // ==========================================
  ipcMain.handle('read-file', async (event, filePath) => {
    try {
      // 检查文件是否存在
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在' }
      }

      // 检查文件大小
      const stat = fs.statSync(filePath)
      if (stat.size > MAX_FILE_SIZE) {
        return {
          success: false,
          error: `文件超过 ${MAX_FILE_SIZE / 1024 / 1024}MB 限制 (当前: ${(stat.size / 1024 / 1024).toFixed(1)}MB)`
        }
      }

      // 使用异步读取，避免阻塞主进程
      const buffer = await fs.promises.readFile(filePath)
      return { success: true, data: buffer }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ==========================================
  // ✅ 获取文件创建时间（异步 + 限制并发）
  // ==========================================
  ipcMain.handle('get-file-stats', async (event, filePaths) => {
    try {
      // 限制并发获取文件状态，避免 IO 峰值
      const stats = await mapLimit(filePaths, MAX_STAT_CONCURRENCY, async (filePath) => {
        try {
          const stat = await fs.promises.stat(filePath)
          return {
            path: filePath,
            birthtime: stat.birthtimeMs,
            mtime: stat.mtimeMs,
          }
        } catch {
          return {
            path: filePath,
            birthtime: 0,
            mtime: 0,
          }
        }
      })
      return { success: true, stats }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ==========================================
  // ✅ 打开文件对话框获取文件路径
  // ==========================================
  ipcMain.handle('open-file-dialog', async () => {
    try {
      const mainWindow = ctx.getMainWindow()
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: FILE_DIALOG_FILTERS,
        title: '选择发票文件'
      })

      if (result.canceled) {
        return { success: true, files: [] }
      }

      const files = result.filePaths.map(filePath => ({
        name: path.basename(filePath),
        path: filePath
      }))

      return { success: true, files }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ==========================================
  // ✅ 文件夹选择（用于重命名目标文件夹设置）
  // ==========================================
  ipcMain.handle('select-folder', async () => {
    try {
      const mainWindow = ctx.getMainWindow()
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        title: '选择输出目标文件夹'
      })

      if (result.canceled) {
        return { success: true, folder: '' }
      }

      return { success: true, folder: result.filePaths[0] }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ==========================================
  // ✅ 打开文件夹并扫描其中所有发票文件（异步）
  // ==========================================
  ipcMain.handle('open-folder-dialog', async () => {
    try {
      const mainWindow = ctx.getMainWindow()
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: '选择包含发票文件的文件夹'
      })

      if (result.canceled) {
        return { success: true, files: [] }
      }

      const files = await scanInvoiceFilesAsync(result.filePaths[0])
      const truncated = files.length >= MAX_SCAN_FILES
      return { success: true, files, truncated, maxFiles: MAX_SCAN_FILES }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // ==========================================
  // ✅ 扫描拖拽路径（支持文件和文件夹）
  // ==========================================
  ipcMain.handle('scan-dropped-paths', async (event, { paths }) => {
    try {
      const files = []
      const seenPaths = new Set()

      // 支持的扩展名（不含点）
      const supportedExts = ['pdf', 'ofd', 'jpg', 'jpeg', 'png', 'bmp', 'tiff', 'tif']

      const isInvoiceFile = (filename) => {
        const ext = filename.toLowerCase().split('.').pop()
        return supportedExts.includes(ext)
      }

      const processPath = async (p) => {
        if (seenPaths.has(p)) return
        seenPaths.add(p) // 同步登记，避免并发重复处理同一路径

        let stat
        try {
          stat = await fs.promises.stat(p)
        } catch {
          return // 路径不存在或不可访问
        }

        if (stat.isDirectory()) {
          // 扫描顶层文件（不递归子文件夹）；readdir withFileTypes 免去逐文件 stat
          let entries
          try {
            entries = await fs.promises.readdir(p, { withFileTypes: true })
          } catch {
            return // 跳过无法读取的文件夹
          }
          for (const entry of entries) {
            if (entry.isFile() && isInvoiceFile(entry.name)) {
              const fullPath = path.join(p, entry.name)
              if (!seenPaths.has(fullPath)) {
                seenPaths.add(fullPath)
                files.push({ name: entry.name, path: fullPath })
              }
            }
          }
        } else if (stat.isFile() && isInvoiceFile(p)) {
          files.push({ name: path.basename(p), path: p })
        }
      }

      // 复用本模块已有的并发控制工具，避免主线程同步 I/O 阻塞
      await mapLimit(paths, MAX_STAT_CONCURRENCY, (p) => processPath(p))

      return { success: true, files }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })
}

module.exports = { registerFileOpsHandlers }
