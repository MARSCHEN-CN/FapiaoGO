'use strict'

const { ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { buildNameParts } = require('./rename-utils')
const {
  generateArchiveName,
  createZipArchive,
  find7zPath,
  createArchiveWith7z,
  findWinRarPath,
  createRarWithWinRAR,
} = require('./archive-utils')

function registerPackHandlers(ctx) {

  ipcMain.handle('pack-invoices', async (event, payload) => {
    const isLegacyFormat = Array.isArray(payload)
    const files = isLegacyFormat ? payload : (payload.files || [])
    const packSettings = isLegacyFormat ? {} : (payload.packSettings || {})
    const renameSettings = isLegacyFormat ? {} : (payload.renameSettings || {})

    try {
      const mainWindow = ctx.getMainWindow()

      // 1. 确定输出目录
      let outputDir = packSettings.packTargetFolder || ''
      if (!outputDir) {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: '选择打包输出目录',
          properties: ['openDirectory', 'createDirectory']
        })
        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, error: '用户取消选择' }
        }
        outputDir = result.filePaths[0]
      }

      // 异步 mkdir（recursive 幂等）
      await fs.promises.mkdir(outputDir, { recursive: true })

      // 2. 解析打包设置
      const archiveFormat = (packSettings.packArchiveFormat || 'ZIP').toUpperCase()
      const renameBeforeArchive = packSettings.packRenameBeforeArchive ?? false
      const keepOriginal = packSettings.packKeepOriginal ?? false
      const archiveNamePrefix = packSettings.packArchiveNamePrefix ?? ''
      const archiveNameDateFormat = packSettings.packArchiveNameDateFormat || 'YYYY年MM月DD日'
      const fieldOrder = packSettings.packNameFieldOrder || ['prefix', 'date']
      const nameSeparator = packSettings.packArchiveNameSeparator ?? '_'

      // 3. 生成压缩包文件名（含用户自定义分隔符）
      const archiveName = generateArchiveName(archiveNamePrefix, archiveNameDateFormat, archiveFormat, fieldOrder, nameSeparator)
      let finalArchivePath = path.join(outputDir, archiveName)
      const archiveExt = path.extname(archiveName)
      const archiveBase = path.basename(archiveName, archiveExt)
      let counter = 1
      while (true) {
        try {
          await fs.promises.access(finalArchivePath)
          finalArchivePath = path.join(outputDir, `${archiveBase}_${counter}${archiveExt}`)
          counter++
        } catch {
          break  // 文件不存在，可以使用
        }
      }

      const packResult = { success: true, packed: 0, failed: 0, errors: [], outputDir, archivePath: finalArchivePath }
      const total = files.length

      // 4. 解析重命名设置
      const renameFields = renameSettings.fields || []
      const separator = renameSettings.separator || '_'
      const showIndex = renameSettings.showIndex ?? false
      const showPrefix = renameSettings.showPrefix ?? false
      const useLegacyNaming = renameFields.length === 0

      function generateNewName(invoiceFields, originalName) {
        if (!renameBeforeArchive) return originalName
        if (useLegacyNaming) {
          const ext = path.extname(originalName)
          return invoiceFields?.fphm ? `${invoiceFields.fphm}${ext}` : originalName
        }
        const result = buildNameParts(invoiceFields, renameFields, { separator, showIndex, showPrefix })
        const ext = path.extname(originalName)
        return result ? `${result}${ext}` : originalName
      }

      // 5. 同步遍历文件准备列表（避免 await 在循环中串行开销）
      //    同步 statSync/existsSync 比 Promise.all + await access 快得多
      event.sender.send('pack-progress', { current: 0, total: total + 1, stage: '准备文件' })

      const preparedFiles = []
      const PROGRESS_THROTTLE_MS = 100
      let lastProgressSentAt = 0

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const nowTs = Date.now()
        if (nowTs - lastProgressSentAt >= PROGRESS_THROTTLE_MS) {
          lastProgressSentAt = nowTs
          event.sender.send('pack-progress', { current: i + 1, total: total + 1, stage: '扫描文件' })
        }

        try {
          let originalPath = file.printPath || file.path
          if (!originalPath) {
            packResult.failed++
            packResult.errors.push({ file: file.name, error: '无文件路径' })
            continue
          }
          if (!path.isAbsolute(originalPath)) {
            originalPath = path.resolve(originalPath)
          }
          try {
            await fs.promises.access(originalPath)
          } catch {
            packResult.failed++
            packResult.errors.push({ file: file.name, error: '源文件不存在' })
            continue
          }
          const st = await fs.promises.stat(originalPath)
          if (!st.isFile()) {
            packResult.failed++
            packResult.errors.push({ file: file.name, error: '不是有效文件' })
            continue
          }

          const targetName = renameBeforeArchive
            ? generateNewName(file.invoiceFields, file.name)
            : file.name

          preparedFiles.push({
            originalPath,
            targetName,
            originalName: file.name,
          })
        } catch (error) {
          packResult.failed++
          packResult.errors.push({ file: file.name, error: error.message })
        }
      }

      if (preparedFiles.length === 0) {
        return { success: false, error: '没有可打包的文件' }
      }

      // 6. 创建压缩包
      event.sender.send('pack-progress', { current: total, total: total + 1, stage: '创建压缩包' })
      try {
        if (archiveFormat === 'ZIP') {
          await createZipArchive(preparedFiles, finalArchivePath)
        } else if (archiveFormat === 'RAR') {
          const rarPath = findWinRarPath()
          if (rarPath) {
            await createRarWithWinRAR(preparedFiles, finalArchivePath, rarPath)
          } else {
            console.warn('[pack] 未找到 WinRAR，RAR 格式降级为 ZIP')
            const zipPath = finalArchivePath.replace(/\.rar$/i, '.zip')
            await createZipArchive(preparedFiles, zipPath)
            packResult.archivePath = zipPath
            packResult.fallbackToZip = true
          }
        } else {
          const sevenZipPath = find7zPath()
          if (sevenZipPath) {
            await createArchiveWith7z(preparedFiles, finalArchivePath, sevenZipPath)
          } else {
            console.warn('[pack] 未找到 7z 命令行工具，7Z 格式降级为 ZIP')
            const zipPath = finalArchivePath.replace(/\.7z$/i, '.zip')
            await createZipArchive(preparedFiles, zipPath)
            packResult.archivePath = zipPath
            packResult.fallbackToZip = true
          }
        }
      } catch (archiveError) {
        console.error('[pack] 创建压缩包失败:', archiveError.message)
        return { success: false, error: `创建压缩包失败: ${archiveError.message}` }
      }

      // 7. 处理原件（不保留原件则并行删除；同步 unlink 在大量小文件时反而比 Promise.all 更快且无调度开销，
      //    但并行 unlink 可发挥 IO 队列深度，这里用 Promise.all）
      if (!keepOriginal) {
        event.sender.send('pack-progress', { current: total + 1, total: total + 1, stage: '清理原件' })
        await Promise.all(preparedFiles.map(async (pf) => {
          try {
            if (fs.existsSync(pf.originalPath)) {
              await fs.promises.unlink(pf.originalPath)
            }
          } catch (unlinkErr) {
            console.warn(`[pack] 删除原件失败: ${pf.originalPath}`, unlinkErr.message)
          }
        }))
      }

      packResult.packed = preparedFiles.length
      event.sender.send('pack-progress', { current: total + 1, total: total + 1, stage: '完成' })

      let resultMsg = `打包完成！成功 ${packResult.packed} 个，失败 ${packResult.failed} 个`
      if (packResult.fallbackToZip) {
        resultMsg += `\n\n⚠️ 未检测到 7-Zip/WinRAR，${archiveFormat} 格式已降级为 ZIP 格式`
      }

      return { ...packResult, message: resultMsg }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })
}

module.exports = { registerPackHandlers }
