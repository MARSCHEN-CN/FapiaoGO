'use strict'

const logger = require('./logger')
const fs = require('fs')
const path = require('path')

// ============================
// 临时文件清理机制
// ============================

// 临时文件存放目录
const { app } = require('electron')
const TEMP_DIR = path.join(app.getPath('temp'), 'marsprint')

// 配置
const TEMP_FILES_MAX_SIZE = 5000 * 1024 * 1024  // 5000MB 上限
const MAX_FILE_AGE_MS = 24 * 60 * 60 * 1000      // 最大文件年龄：1天
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000       // 定时清理间隔：30分钟

// 内存中记录临时文件信息
const tempFiles = new Map()  // Map<filePath, { size: number, registeredAt: number }>

// 定时清理定时器
let cleanupTimer = null

/**
 * 确保临时目录存在
 */
async function ensureTempDir() {
  try {
    await fs.promises.mkdir(TEMP_DIR, { recursive: true })
  } catch {}
}

/**
 * 获取临时文件总大小
 */
function getTempFilesTotalSize() {
  let totalSize = 0
  for (const file of tempFiles.values()) {
    totalSize += file.size
  }
  return totalSize
}

/**
 * 清理最旧的临时文件以释放空间（异步）
 * @param {number} targetSize - 需要释放的目标大小（字节）
 */
async function cleanupOldestTempFiles(targetSize) {
  const entries = Array.from(tempFiles.entries())
  entries.sort((a, b) => a[1].registeredAt - b[1].registeredAt)

  let freedSize = 0
  for (const [filePath, fileInfo] of entries) {
    if (freedSize >= targetSize) break

    try {
      await fs.promises.unlink(filePath)
      freedSize += fileInfo.size
      tempFiles.delete(filePath)
      logger.log(`[temp-manager] 清理最旧临时文件: ${path.basename(filePath)} (${Math.round(fileInfo.size / 1024)}KB)`)
    } catch {
      tempFiles.delete(filePath)
    }
  }

  return freedSize
}

/**
 * 清理超过指定年龄的孤儿文件（不在内存 Map 中但存在于磁盘）
 * @param {number} maxAgeMs - 最大文件年龄（毫秒）
 */
async function cleanupOrphanTempFiles(maxAgeMs = MAX_FILE_AGE_MS) {
  const now = Date.now()
  let cleaned = 0
  let freed = 0

  // 递归扫描 TEMP_DIR（含子目录，如 print-merged-images 的 electron_merge_<ts> 临时目录），
  // 使崩溃遗留、落在子目录中的临时文件也能被回收。注册在内存 Map 中的文件会被跳过。
  async function scanDir(dir) {
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      try {
        if (entry.isDirectory()) {
          await scanDir(fullPath)
        } else if (entry.isFile()) {
          // 检查是否在内存中注册（已注册的文件由调用方负责清理，跳过）
          if (tempFiles.has(fullPath)) continue

          const stat = await fs.promises.stat(fullPath)
          // 检查文件年龄
          if (now - stat.mtimeMs > maxAgeMs) {
            await fs.promises.unlink(fullPath)
            cleaned++
            freed += stat.size
            logger.log(`[temp-manager] 清理孤儿临时文件: ${entry.name} (${Math.round(stat.size / 1024)}KB)`)
          }
        }
      } catch {}
    }
  }

  await scanDir(TEMP_DIR)

  if (cleaned > 0) {
    logger.log(`[temp-manager] 孤儿文件清理完成: ${cleaned} 个文件, ${Math.round(freed / 1024 / 1024)}MB`)
  }

  return { cleaned, freed }
}

/**
 * 生成临时文件路径
 * @param {string} prefix - 文件名前缀
 * @param {string} ext - 文件扩展名
 * @returns {string}
 */
async function createTempFilePath(prefix, ext) {
  await ensureTempDir()
  const timestamp = Date.now()
  const random = Math.random().toString(36).substr(2, 9)
  return path.join(TEMP_DIR, `${prefix}_${timestamp}_${random}${ext}`)
}

/**
 * 注册临时文件，在进程退出时自动清理
 * @param {string} filePath - 临时文件路径
 */
async function registerTempFile(filePath) {
  try {
    await ensureTempDir()

    const stats = await fs.promises.stat(filePath)
    const fileSize = stats.size

    // 检查是否超限
    const currentTotalSize = getTempFilesTotalSize()
    if (currentTotalSize + fileSize > TEMP_FILES_MAX_SIZE) {
      const needToFree = (currentTotalSize + fileSize) - TEMP_FILES_MAX_SIZE
      logger.warn(`[temp-manager] 临时文件超限 (${Math.round(currentTotalSize / 1024 / 1024)}MB + ${Math.round(fileSize / 1024 / 1024)}MB > 5000MB)，开始清理最旧文件`)
      const freedSize = await cleanupOldestTempFiles(needToFree)
      logger.log(`[temp-manager] 清理完成，释放了 ${Math.round(freedSize / 1024 / 1024)}MB`)
    }

    tempFiles.set(filePath, {
      size: fileSize,
      registeredAt: Date.now()
    })
  } catch (e) {
    logger.error('[temp-manager] 注册临时文件失败:', filePath, e.message)
  }
}

/**
 * 清理单个临时文件（异步）
 * @param {string} filePath - 临时文件路径
 */
async function cleanupTempFile(filePath) {
  try {
    await fs.promises.unlink(filePath)
    tempFiles.delete(filePath)
    logger.log('[temp-manager] 清理临时文件:', path.basename(filePath))
  } catch {
    tempFiles.delete(filePath)
  }
}

/**
 * 清理所有临时文件（异步，进程退出时调用）
 */
async function cleanupAllTempFiles() {
  logger.log('[temp-manager] 开始清理临时文件...')
  let cleanedCount = 0
  let totalSize = 0

  for (const [filePath, fileInfo] of tempFiles) {
    try {
      await fs.promises.unlink(filePath)
      cleanedCount++
      totalSize += fileInfo.size
    } catch {}
  }

  tempFiles.clear()
  logger.log(`[temp-manager] 临时文件清理完成: ${cleanedCount} 个文件, ${Math.round(totalSize / 1024 / 1024)}MB`)
}

/**
 * 启动定时清理任务
 */
function startCleanupTimer() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
  }

  cleanupTimer = setInterval(async () => {
    try {
      await cleanupOrphanTempFiles()
    } catch (e) {
      logger.error('[temp-manager] 定时清理失败:', e.message)
    }
  }, CLEANUP_INTERVAL_MS)

  logger.log(`[temp-manager] 定时清理任务已启动，间隔 ${CLEANUP_INTERVAL_MS / 60000} 分钟`)
}

/**
 * 停止定时清理任务
 */
function stopCleanupTimer() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
    logger.log('[temp-manager] 定时清理任务已停止')
  }
}

/**
 * 初始化临时文件管理器（启动时调用）
 */
async function init() {
  await ensureTempDir()
  logger.log(`[temp-manager] 临时目录: ${TEMP_DIR}`)

  // 清理上次崩溃留下的孤儿文件
  await cleanupOrphanTempFiles()

  // 启动定时清理
  startCleanupTimer()
}

// 注册进程退出时的清理（异步）
process.on('exit', async () => {
  stopCleanupTimer()
})

if (app && typeof app.on === 'function') {
  app.on('before-quit', async () => {
    stopCleanupTimer()
    // 轻量清理：只清理内存中记录的文件，不扫描目录
    await cleanupAllTempFiles()
  })
} else {
  process.on('SIGTERM', async () => {
    stopCleanupTimer()
    await cleanupAllTempFiles()
  })
  process.on('SIGINT', async () => {
    stopCleanupTimer()
    await cleanupAllTempFiles()
  })
}

module.exports = {
  init,
  registerTempFile,
  cleanupTempFile,
  cleanupAllTempFiles,
  createTempFilePath,
  TEMP_DIR
}