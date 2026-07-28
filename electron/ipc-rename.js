'use strict'

const { ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { buildNameParts } = require('./rename-utils')

function notifyBackendRename(renames) {
  return new Promise((resolve) => {
    if (!renames.length) {
      resolve({ updated: 0, notFound: [] })
      return
    }
    const postData = JSON.stringify({ renames })
    const req = http.request({
      host: '127.0.0.1',
      port: 5000,
      path: '/api/invoices/rename',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 5000,
    }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(body)
          resolve(json.data || { updated: 0, notFound: [] })
        } catch {
          resolve({ updated: 0, notFound: [] })
        }
      })
    })
    req.on('error', () => resolve({ updated: 0, notFound: [] }))
    req.on('timeout', () => { req.destroy(); resolve({ updated: 0, notFound: [] }) })
    req.write(postData)
    req.end()
  })
}

function registerRenameHandlers(ctx) {

  ipcMain.handle('rename-invoices', async (event, payload) => {
    const isLegacyFormat = Array.isArray(payload)
    const files = isLegacyFormat ? payload : (payload.files || [])
    const renameSettings = isLegacyFormat ? {} : (payload.renameSettings || {})

    const result = { success: true, renamed: 0, failed: 0, errors: [], renamedFiles: [] }
    const total = files.length

    const fields = renameSettings.fields || []
    const separator = renameSettings.separator || '_'
    const showIndex = renameSettings.showIndex ?? false
    const showPrefix = renameSettings.showPrefix ?? false
    const targetFolder = renameSettings.targetFolder || ''
    const keepOriginal = renameSettings.keepOriginal ?? false

    const useLegacyNaming = fields.length === 0

    function generateNewName(invoiceFields) {
      if (useLegacyNaming) {
        return invoiceFields?.fphm || '未知'
      }
      return buildNameParts(invoiceFields, fields, { separator, showIndex, showPrefix }) || '未命名'
    }

    async function unlinkWithRetry(filePath, maxRetries = 3) {
      let lastErr = null
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          fs.unlinkSync(filePath)
          return true
        } catch (e) {
          lastErr = e
          if (attempt < maxRetries) {
            const delay = attempt === 1 ? 100 : 300
            await new Promise(resolve => setTimeout(resolve, delay))
          }
        }
      }
      throw lastErr
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i]

      if (i % 5 === 0 || i === files.length - 1) {
        event.sender.send('rename-progress', { current: i + 1, total })
      }

      try {
        if (!file.originalPath) {
          result.failed++
          result.errors.push({ file: 'unknown', error: '缺少文件路径' })
          continue
        }

        let originalPath = file.originalPath
        if (!path.isAbsolute(originalPath)) {
          originalPath = path.resolve(originalPath)
        }

        const ext = path.extname(originalPath)
        const newBaseName = file.newBaseName || generateNewName(file.invoiceFields)
        const newName = `${newBaseName}${ext}`

        const outputDir = targetFolder || path.dirname(originalPath)

        if (targetFolder) {
          fs.mkdirSync(targetFolder, { recursive: true })
        }

        let newPath = path.join(outputDir, newName)

        let counter = 1
        while (fs.existsSync(newPath) && newPath !== originalPath) {
          newPath = path.join(outputDir, `${newBaseName}_${counter}${ext}`)
          counter++
        }

        if (newPath === originalPath) {
          result.renamed++
          result.renamedFiles.push({
            originalPath,
            newPath,
            newName: path.basename(newPath),
            oldName: path.basename(originalPath),
            partialSuccess: false,
          })
          continue
        }

        const sameDisk = path.parse(originalPath).root.toLowerCase() === path.parse(newPath).root.toLowerCase()

        let partialSuccess = false

        if (targetFolder && keepOriginal) {
          fs.copyFileSync(originalPath, newPath)
        } else if (targetFolder && !keepOriginal) {
          if (sameDisk) {
            fs.renameSync(originalPath, newPath)
          } else {
            fs.copyFileSync(originalPath, newPath)
            try {
              fs.unlinkSync(originalPath)
            } catch (unlinkErr) {
              try {
                await unlinkWithRetry(originalPath)
              } catch (retryErr) {
                console.warn(`[rename] ⚠️ 原文件删除失败（文件被占用），但新文件已复制成功: ${retryErr.message}`)
                partialSuccess = true
              }
            }
          }
        } else {
          fs.renameSync(originalPath, newPath)
        }

        result.renamed++
        result.renamedFiles.push({
          originalPath,
          newPath,
          newName: path.basename(newPath),
          oldName: path.basename(originalPath),
          partialSuccess,
        })
      } catch (error) {
        console.error('Rename failed:', file.invoiceFields?.fphm, error.message)
        result.failed++
        result.errors.push({ file: file.invoiceFields?.fphm || file.key || 'unknown', error: error.message })
      }
    }

    const renames = result.renamedFiles
      .filter(r => r.oldName && r.newName && r.oldName !== r.newName)
      .map(r => ({ oldName: r.oldName, newName: r.newName, newPath: r.newPath }))
    notifyBackendRename(renames).catch(() => {})

    return result
  })

  ipcMain.handle('preview-rename-names', async (_event, payload) => {
    const files = payload.files || []
    const renameSettings = payload.renameSettings || {}
    const fields = renameSettings.fields || []
    const separator = renameSettings.separator || '_'
    const showIndex = renameSettings.showIndex ?? false
    const showPrefix = renameSettings.showPrefix ?? false

    const previews = files.map((file) => {
      const newBaseName = file.newBaseName || buildNameParts(file.invoiceFields, fields, { separator, showIndex, showPrefix }) || '未命名'
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
