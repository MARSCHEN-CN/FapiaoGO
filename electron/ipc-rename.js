'use strict'

const { ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { buildNameParts } = require('./rename-utils')

/**
 * 注册重命名相关的 IPC handlers
 * @param {Object} ctx
 * @param {Function} ctx.getMainWindow - 获取主窗口引用的函数
 */
function registerRenameHandlers(ctx) {

  // ==========================================
  // ✅ 一键重命名（支持自定义命名规则）
  // ==========================================
  ipcMain.handle('rename-invoices', async (event, payload) => {
    // 兼容旧版纯数组调用和新版对象调用
    const isLegacyFormat = Array.isArray(payload)
    const files = isLegacyFormat ? payload : (payload.files || [])
    const renameSettings = isLegacyFormat ? {} : (payload.renameSettings || {})

    const result = { success: true, renamed: 0, failed: 0, errors: [], renamedFiles: [] }
    const total = files.length

    // 解析 renameSettings
    const fields = renameSettings.fields || []  // [{ key, dateFormat?, customText? }]
    const separator = renameSettings.separator || '_'
    const showIndex = renameSettings.showIndex ?? false
    const showPrefix = renameSettings.showPrefix ?? false
    const targetFolder = renameSettings.targetFolder || ''
    const keepOriginal = renameSettings.keepOriginal ?? false

    // 如果没有配置任何字段，使用旧版默认逻辑（发票号码命名）
    const useLegacyNaming = fields.length === 0

    /**
     * 根据发票字段和命名规则生成新文件名（不含扩展名）
     */
    function generateNewName(invoiceFields) {
      if (useLegacyNaming) {
        return invoiceFields?.fphm || '未知'
      }
      return buildNameParts(invoiceFields, fields, { separator, showIndex, showPrefix }) || '未命名'
    }

    // 带重试的 unlink（解决 EBUSY: resource busy or locked）
    // 使用 async + setTimeout 让出事件循环，避免 CPU 自旋锁冻结主线程
    async function unlinkWithRetry(filePath, maxRetries = 3) {
      let lastErr = null
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await fs.promises.unlink(filePath)
          return true
        } catch (e) {
          lastErr = e
          if (attempt < maxRetries) {
            // 递增延迟: 200ms, 500ms，使用 setTimeout 让出事件循环而非忙等
            const delay = attempt === 1 ? 200 : 500
            console.log(`[rename] unlink 重试 ${attempt}/${maxRetries}，等待 ${delay}ms: ${e.message}`)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        }
      }
      throw lastErr
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i]

      event.sender.send('rename-progress', { current: i + 1, total })

      // 调试日志：输出传入的发票字段数据
      console.log(`[rename] file #${i + 1}:`, JSON.stringify({
        originalPath: file.originalPath,
        invoiceFields: file.invoiceFields,
      }))

      try {
        if (!file.originalPath) {
          console.log('Missing path:', file)
          result.failed++
          result.errors.push({ file: 'unknown', error: '缺少文件路径' })
          continue
        }

        let originalPath = file.originalPath
        if (!path.isAbsolute(originalPath)) {
          originalPath = path.resolve(originalPath)
        }

        const ext = path.extname(originalPath)
        // 优先使用前端传入的预计算名称（预览结果已算好，直接复用）
        const newBaseName = file.newBaseName || generateNewName(file.invoiceFields)
        const newName = `${newBaseName}${ext}`
        console.log(`[rename] generated name: "${newBaseName}" from fields:`, JSON.stringify(file.invoiceFields))

        // 确定目标目录
        const outputDir = targetFolder || path.dirname(originalPath)

        // 确保目标目录存在
        if (targetFolder && !fs.existsSync(targetFolder)) {
          fs.mkdirSync(targetFolder, { recursive: true })
        }

        let newPath = path.join(outputDir, newName)

        // 处理文件名冲突
        let counter = 1
        while (fs.existsSync(newPath) && newPath !== originalPath) {
          const conflictName = `${newBaseName}_${counter}${ext}`
          newPath = path.join(outputDir, conflictName)
          counter++
        }

        // 执行重命名/复制（支持跨磁盘操作）
        // 如果新路径与原路径相同，跳过（文件本身就是目标名，无需操作）
        if (newPath === originalPath) {
          result.renamed++
          console.log('[rename] Skipped (same name):', originalPath)
          continue
        }

        const sameDisk = path.parse(originalPath).root.toLowerCase() === path.parse(newPath).root.toLowerCase()

        let unlinkSucceeded = true
        let partialSuccess = false  // 复制成功但原文件未删除

        if (targetFolder && keepOriginal) {
          // 复制到目标文件夹，保留原件
          fs.copyFileSync(originalPath, newPath)
        } else if (targetFolder && !keepOriginal) {
          // 剪切到目标文件夹（跨磁盘用 copy+delete）
          if (sameDisk) {
            fs.renameSync(originalPath, newPath)
          } else {
            fs.copyFileSync(originalPath, newPath)
            try {
              await unlinkWithRetry(originalPath)
            } catch (unlinkErr) {
              // unlink 失败不算完全失败 — 文件已复制成功
              console.warn(`[rename] ⚠️ 原文件删除失败（文件被占用），但新文件已复制成功: ${unlinkErr.message}`)
              unlinkSucceeded = false
              partialSuccess = true
            }
          }
        } else {
          // 没有目标文件夹，就地重命名（同盘不会出问题）
          if (newPath !== originalPath) {
            fs.renameSync(originalPath, newPath)
          } else {
            // 文件名与原名相同，无需操作
            console.log('[rename] Skipped (same name):', originalPath)
          }
        }

        result.renamed++
        result.renamedFiles.push({
          originalPath: originalPath,
          newPath: newPath,
          newName: path.basename(newPath),
          partialSuccess: partialSuccess,  // 标记部分成功
        })
        if (partialSuccess) {
          console.log('Renamed (partial):', originalPath, '->', newPath, '(原文件仍保留)')
        } else {
          console.log('Renamed:', originalPath, '->', newPath)
        }
      } catch (error) {
        console.error('Rename failed:', file.invoiceFields?.fphm, error.message)
        result.failed++
        result.errors.push({ file: file.invoiceFields?.fphm || 'unknown', error: error.message })
      }
    }

    return result
  })

  // ==========================================
  // ✅ 重命名预览（复用后端的 buildNameParts，保证结果与真实重命名一致）
  // ==========================================
  ipcMain.handle('preview-rename-names', async (_event, payload) => {
    const files = payload.files || []
    const renameSettings = payload.renameSettings || {}
    const fields = renameSettings.fields || []
    const separator = renameSettings.separator || '_'
    const showIndex = renameSettings.showIndex ?? false
    const showPrefix = renameSettings.showPrefix ?? false

    const previews = files.map((file, index) => {
      const newBaseName = buildNameParts(file.invoiceFields, fields, { separator, showIndex, showPrefix }) || '未命名'
      const ext = path.extname(file.originalPath || file.name || '.pdf')
      const newName = `${newBaseName}${ext}`
      return {
        key: file.key,
        originalName: file.name || path.basename(file.originalPath || ''),
        newName,
      }
    })

    return { success: true, previews }
  })
}

module.exports = { registerRenameHandlers }
