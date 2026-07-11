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

/**
 * 注册打包相关的 IPC handlers
 * @param {Object} ctx
 * @param {Function} ctx.getMainWindow - 获取主窗口引用的函数
 */
/**
 * 异步判断路径是否存在（Node 无 fs.promises.exists，用 access 容错）
 */
async function pathExists(p) {
  try {
    await fs.promises.access(p)
    return true
  } catch {
    return false
  }
}

function registerPackHandlers(ctx) {

  // ==========================================
  // ✅ 一键打包（支持 ZIP/RAR/7Z 压缩包 + 命名规则 + 重命名）
  // ==========================================
  ipcMain.handle('pack-invoices', async (event, payload) => {
    // 兼容旧版纯数组调用和新版对象调用
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

      // 目录存在则 mkdir(recursive) 为 no-op，行为与「existsSync 守卫 + mkdirSync」等价
      await fs.promises.mkdir(outputDir, { recursive: true })

      // 2. 解析打包设置
      const archiveFormat = (packSettings.packArchiveFormat || 'ZIP').toUpperCase()
      const renameBeforeArchive = packSettings.packRenameBeforeArchive ?? false
      const keepOriginal = packSettings.packKeepOriginal ?? false
      const archiveNamePrefix = packSettings.packArchiveNamePrefix ?? ''
      const archiveNameDateFormat = packSettings.packArchiveNameDateFormat || 'YYYY年MM月DD日'
      const fieldOrder = packSettings.packNameFieldOrder || ['prefix', 'date']

      // 3. 生成压缩包文件名：根据 fieldOrder 决定顺序
      const archiveName = generateArchiveName(archiveNamePrefix, archiveNameDateFormat, archiveFormat, fieldOrder)
      const archivePath = path.join(outputDir, archiveName)

      // 处理文件名冲突
      let finalArchivePath = archivePath
      let counter = 1
      const archiveExt = path.extname(archiveName)
      const archiveBase = path.basename(archiveName, archiveExt)
      while (await pathExists(finalArchivePath)) {
        finalArchivePath = path.join(outputDir, `${archiveBase}_${counter}${archiveExt}`)
        counter++
      }

      const packResult = { success: true, packed: 0, failed: 0, errors: [], outputDir, archivePath: finalArchivePath }
      const total = files.length

      // 4. 解析重命名设置
      const renameFields = renameSettings.fields || []
      const separator = renameSettings.separator || '_'
      const showIndex = renameSettings.showIndex ?? false
      const showPrefix = renameSettings.showPrefix ?? false
      const useLegacyNaming = renameFields.length === 0

      /**
       * 生成压缩包内的文件名
       */
      function generateNewName(invoiceFields, originalName) {
        if (!renameBeforeArchive) {
          // 未勾选"打包前重命名"：使用原名
          return originalName
        }
        if (useLegacyNaming) {
          // 勾选了重命名但未配置字段：使用发票号码命名作为降级
          const ext = path.extname(originalName)
          return invoiceFields?.fphm ? `${invoiceFields.fphm}${ext}` : originalName
        }

        const result = buildNameParts(invoiceFields, renameFields, { separator, showIndex, showPrefix })
        const ext = path.extname(originalName)
        return result ? `${result}${ext}` : originalName
      }

      // 5. 遍历文件，准备列表
      const preparedFiles = []

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        event.sender.send('pack-progress', { current: i + 1, total: total + 1 })  // +1 是压缩步骤

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

          if (!(await pathExists(originalPath))) {
            packResult.failed++
            packResult.errors.push({ file: file.name, error: '源文件不存在' })
            continue
          }

          // 决定在压缩包内的文件名
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
      try {
        if (archiveFormat === 'ZIP') {
          await createZipArchive(preparedFiles, finalArchivePath)
        } else if (archiveFormat === 'RAR') {
          // RAR 是专有格式，需要 WinRAR
          const rarPath = findWinRarPath()
          if (rarPath) {
            await createRarWithWinRAR(preparedFiles, finalArchivePath, rarPath)
          } else {
            // 降级为 ZIP
            console.warn('[pack] 未找到 WinRAR，RAR 格式降级为 ZIP')
            const zipPath = finalArchivePath.replace(/\.rar$/i, '.zip')
            await createZipArchive(preparedFiles, zipPath)
            packResult.archivePath = zipPath
            packResult.fallbackToZip = true
          }
        } else {
          // 7Z 格式
          const sevenZipPath = find7zPath()
          if (sevenZipPath) {
            await createArchiveWith7z(preparedFiles, finalArchivePath, sevenZipPath)
          } else {
            // 降级为 ZIP
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

      // 7. 处理原件（不保留原件则删除；各文件独立，并行删除避免逐个 await 累积延迟）
      if (!keepOriginal) {
        await Promise.all(preparedFiles.map(async (pf) => {
          try {
            if (await pathExists(pf.originalPath)) {
              await fs.promises.unlink(pf.originalPath)
            }
          } catch (unlinkErr) {
            console.warn(`[pack] 删除原件失败: ${pf.originalPath}`, unlinkErr.message)
          }
        }))
      }

      packResult.packed = preparedFiles.length
      event.sender.send('pack-progress', { current: total + 1, total: total + 1 })

      let resultMsg = `打包完成！成功 ${packResult.packed} 个，失败 ${packResult.failed} 个`
      if (packResult.fallbackToZip) {
        resultMsg += `\n\n⚠️ 未检测到 7-Zip，${archiveFormat} 格式已降级为 ZIP 格式`
      }

      return { ...packResult, message: resultMsg }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })
}

module.exports = { registerPackHandlers }
