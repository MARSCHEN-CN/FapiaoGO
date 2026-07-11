'use strict'

// 自定义日志模块
const logger = require('./logger')

const { app, BrowserWindow, ipcMain, dialog, Menu, MenuItem, screen, session } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

// ============================
// 模块导入
// ============================
const { SUPPORTED_EXTENSIONS, FILE_DIALOG_FILTERS } = require('./constants')
const { cleanupAllTempFiles } = require('./temp-manager')
const { registerFileOpsHandlers } = require('./ipc-file-ops')
const { registerRenameHandlers } = require('./ipc-rename')
const { registerPackHandlers } = require('./ipc-pack')
const pdfMargin = require('./print-service/pdf-margin-processor')

// 启动时预热 Python 环境检测，避免首次打印等环境检查
pdfMargin.checkPythonEnv().catch(() => {})

// ============================
// PDF 方向检测
// ============================

/**
 * 提取 PDF 的 MediaBox 信息
 */
function extractMediaBox(pdfPath) {
  try {
    const fd = fs.openSync(pdfPath, 'r')
    const buffer = Buffer.alloc(8192)
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0)
    fs.closeSync(fd)

    const content = buffer.toString('latin1', 0, bytesRead)

    // 匹配 /MediaBox [left bottom right top]（任意 left/bottom，如加边距后为负值）
    const match = content.match(/\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/)
    if (match) {
      return { width: parseFloat(match[3]) - parseFloat(match[1]), height: parseFloat(match[4]) - parseFloat(match[2]) }
    }

    // 如果没找到 MediaBox，尝试找 /CropBox
    const cropMatch = content.match(/\/CropBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/)
    if (cropMatch) {
      return { width: parseFloat(cropMatch[3]) - parseFloat(cropMatch[1]), height: parseFloat(cropMatch[4]) - parseFloat(cropMatch[2]) }
    }

    return null
  } catch (err) {
    console.error(`[extractMediaBox] Failed: ${err.message}`)
    return null
  }
}

/**
 * 检测 PDF 的 MediaBox 方向
 * 读取 PDF 文件前 8KB，查找 /MediaBox [0 0 width height]
 */
function detectPdfOrientation(filePath) {
  try {
    // 读取前 8KB（足够覆盖 PNG IHDR 和 PDF MediaBox）
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(8192)
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0)
    fs.closeSync(fd)

    // ✅ PNG 检测：读取 IHDR 块中的宽高（字节 16-23）
    const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
    if (bytesRead >= 24 && PNG_SIG.every((b, i) => buffer[i] === b)) {
      const width = buffer.readUInt32BE(16)
      const height = buffer.readUInt32BE(20)
      const orientation = width > height ? 'landscape' : 'portrait'
      console.log(`[detectPdfOrientation] ${filePath}: PNG ${width}x${height}, ${orientation}`)
      return orientation
    }

    const content = buffer.toString('latin1', 0, bytesRead)

    // PDF: 匹配 /MediaBox [left bottom right top]（任意 left/bottom）
    const match = content.match(/\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/)
    if (match) {
      const width = parseFloat(match[3]) - parseFloat(match[1])
      const height = parseFloat(match[4]) - parseFloat(match[2])
      const orientation = width > height ? 'landscape' : 'portrait'
      console.log(`[detectPdfOrientation] ${filePath}: MediaBox=${width}x${height}, ${orientation}`)
      return orientation
    }

    // 如果没找到 MediaBox，尝试找 /CropBox 或 /ArtBox
    const cropMatch = content.match(/\/CropBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/)
    if (cropMatch) {
      const width = parseFloat(cropMatch[3]) - parseFloat(cropMatch[1])
      const height = parseFloat(cropMatch[4]) - parseFloat(cropMatch[2])
      const orientation = width > height ? 'landscape' : 'portrait'
      console.log(`[detectPdfOrientation] ${filePath}: CropBox=${width}x${height}, ${orientation}`)
      return orientation
    }

    console.log(`[detectPdfOrientation] ${filePath}: MediaBox not found, default to portrait`)
    return 'portrait'
  } catch (err) {
    console.error(`[detectPdfOrientation] Failed: ${err.message}`)
    return 'portrait' // 默认竖向
  }
}

// ============================
// 新打印管线 — OS Trust Delegation
// ============================
const { PrintService } = require('./print-service/PrintService')
const { OsLauncherBridge } = require('./print-service/OsLauncherBridge')
const { setPrintService } = require('./print-service/DirectPrintHandler')
let printService = null
let osLauncherBridge = null
/** 初始化新打印管线 */
function initNewPrintPipeline() {
  try {
    printService = new PrintService()
    osLauncherBridge = new OsLauncherBridge(printService)
    printService.emitter = osLauncherBridge
    setPrintService(printService)
    console.log('[PIPELINE] Print pipeline: NEW')
    console.log('[PIPELINE] Bridge: SumatraPDF')
    console.log('[PIPELINE] PrintService initialized')
    console.log('[PIPELINE] OsLauncherBridge listening on PrintJob events')
    console.log('[PIPELINE] DirectPrintHandler initialized')
    console.log('[PIPELINE] ACTIVE = NEW')
    console.log('[PIPELINE] LEGACY = DISABLED')
  } catch (err) {
    console.error('[PIPELINE] Failed to initialize new pipeline:', err.message)
  }
}

/** 设置 OsLauncherBridge 的主窗口引用 */
function setMainWindowForBridge(window) {
  if (osLauncherBridge) {
    osLauncherBridge.setMainWindow(window)
    console.log('[PIPELINE] Main window set for OsLauncherBridge')
  }
}

// ============================
// 窗口状态
// ============================
let mainWindow
let settingsWindow
// ✅ 使用 app.getPath('userData') 构建配置路径，避免依赖工作目录
const settingsPath = path.join(app.getPath('userData'), 'Settings.json')

let pendingFilesFromContextMenu = []

// 暂存 second-instance 事件中的文件，待窗口创建后处理
let pendingFilesFromSecondInstance = []

// 开发模式判断
const isDev = !app.isPackaged
console.log(`[main.js] 运行模式: ${isDev ? '开发模式' : '生产模式'}`)
console.log(`[main.js] Electron version: ${process.versions.electron}`)
console.log(`[main.js] Chromium version: ${process.versions.chrome}`)
console.log(`[main.js] Node.js version: ${process.versions.node}`)

// 获取命令行参数中的文件路径（改造：支持多格式）
function getFilesFromCommandLine() {
  const files = []
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]
    // ✅ 忽略 macOS 下的特殊参数（-- 和 -psn_...）
    if (!arg || arg === '--' || arg.startsWith('-psn')) {
      continue
    }
    if (SUPPORTED_EXTENSIONS.some(ext => arg.toLowerCase().endsWith(ext))) {
      files.push(arg)
    }
  }
  return files
}

// ============================
// 窗口创建
// ============================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    resizable: true,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  setMainWindowForBridge(mainWindow)
  mainWindow.setMenuBarVisibility(false)

  // 根据运行模式加载不同的资源
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  // 阻止外部窗口打开
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // URL 白名单导航控制
  const allowedOrigins = ['http://localhost:5173', 'file://']
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = allowedOrigins.some(origin => url.startsWith(origin))
    if (!allowed) {
      console.log(`[main.js] 阻止导航到未授权 URL: ${url}`)
      event.preventDefault()
    }
  })

  mainWindow.webContents.on('input-event', (event, inputEvent) => {
    if (inputEvent.type === 'drop') {
      console.log('[main.js] 检测到拖拽事件')
    }
  })

  // 创建右键菜单（改造：支持多格式）
  const contextMenu = new Menu()
  contextMenu.append(new MenuItem({
    label: '添加文件',
    click: () => {
      dialog.showOpenDialog(mainWindow, {
        title: '选择发票文件',
        filters: FILE_DIALOG_FILTERS,
        properties: ['openFile', 'multiSelections']
      }).then(result => {
        if (!result.canceled && result.filePaths.length > 0) {
          const files = result.filePaths.map(filePath => ({
            name: path.basename(filePath),
            path: filePath
          }))
          mainWindow.webContents.send('context-menu-files', files)
        }
      }).catch(err => {
        console.error('[main.js] 打开文件对话框失败:', err)
      })
    }
  }))

  // 禁用右键菜单（用户需求：不希望通过右键点击添加文件）
  // mainWindow.webContents.on('context-menu', (event, params) => {
  //   contextMenu.popup({ window: mainWindow })
  // })

  mainWindow.webContents.on('did-finish-load', () => {
    // 发送从命令行启动时的文件
    if (pendingFilesFromContextMenu.length > 0) {
      console.log('[main.js] 窗口加载完成，发送待处理文件:', pendingFilesFromContextMenu)
      mainWindow.webContents.send('context-menu-files', pendingFilesFromContextMenu.map(f => ({
        name: path.basename(f),
        path: f
      })))
      pendingFilesFromContextMenu = []
    }

    // ✅ 发送从 second-instance 事件暂存的文件
    if (pendingFilesFromSecondInstance.length > 0) {
      console.log('[main.js] 窗口加载完成，发送 second-instance 文件:', pendingFilesFromSecondInstance)
      mainWindow.webContents.send('context-menu-files', pendingFilesFromSecondInstance.map(f => ({
        name: path.basename(f),
        path: f
      })))
      pendingFilesFromSecondInstance = []
    }

    // 根据屏幕分辨率设置缩放因子（以 2K=2560 为基准）
    const { width } = screen.getPrimaryDisplay().workAreaSize
    const zoomFactor = Math.max(0.85, Math.round((width / 2560) * 100) / 100)
    mainWindow.webContents.setZoomFactor(zoomFactor)
  })
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus()
    return
  }

  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize
  
  let width
  if (screenWidth >= 3840) {
    width = 1100
  } else if (screenWidth >= 2560) {
    width = 850
  } else {
    width = Math.min(850, Math.max(750, Math.round(screenWidth * 0.45)))
  }
  
  let height
  if (screenHeight >= 2160) {
    height = 1000
  } else if (screenHeight >= 1440) {
    height = 850
  } else {
    height = Math.min(850, Math.max(700, Math.round(screenHeight * 0.65)))
  }

  settingsWindow = new BrowserWindow({
    width,
    height,
    modal: false,
    resizable: true,
    minimizable: true,
    minWidth: 850,
    minHeight: 850,
    show: false,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  settingsWindow.setMenuBarVisibility(false)

  // 根据运行模式加载不同的资源
  if (isDev) {
    settingsWindow.loadURL('http://localhost:5173/#/settings')
  } else {
    settingsWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'settings' })
  }

  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // URL 白名单导航控制
  const allowedOrigins = ['http://localhost:5173', 'file://']
  settingsWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = allowedOrigins.some(origin => url.startsWith(origin))
    if (!allowed) {
      console.log(`[main.js] 设置窗口阻止导航到未授权 URL: ${url}`)
      event.preventDefault()
    }
  })

  settingsWindow.on('ready-to-show', () => {
    settingsWindow.show()
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
    if (mainWindow) {
      mainWindow.webContents.send('settings-window-closed')
    }
  })
}

// ============================
// 注册所有 IPC handlers
// ============================
const ctx = { getMainWindow: () => mainWindow }

registerFileOpsHandlers(ctx)
registerRenameHandlers(ctx)
registerPackHandlers(ctx)

// ── 新打印管线 IPC ──
ipcMain.handle('submit-print-job', async (_event, payload) => {
  if (!printService) {
    console.error('[submit-print-job] PrintService not initialized')
    return { jobCreated: false, error: 'PrintService not initialized' }
  }
  console.log('[submit-print-job] Received:', payload?.filePath)
  return await printService.submit(payload)
})

// ── 直接打印 IPC ──
const { DirectPrintHandler } = require('./print-service/DirectPrintHandler')
ipcMain.handle('print-file-direct', async (_event, { filePath, settings }) => {
  console.log('[print-file-direct] Received:', filePath)
  return await DirectPrintHandler.handle(filePath, settings)
})

// ── Canvas → PDF 生成 ──
const { generatePdfFromCanvas, pngToPdf, validatePdfStructure, validatePdfStructureAsync } = require('./print-service/pdf-generator')
const { PaperRegistryProvider } = require('./shared/PaperRegistryProvider')

ipcMain.handle('generate-print-pdf', async (_event, { canvasBuffer, paperSize, orientation, customPaper }) => {
  console.log('[generate-print-pdf] paperSize=%s orientation=%s buffer=%d bytes customPaper=%j',
    paperSize, orientation, canvasBuffer?.byteLength || 0, customPaper || null)

  if (!canvasBuffer || canvasBuffer.byteLength === 0) {
    return { success: false, error: 'Empty canvas buffer' }
  }

  // Resolve paper dimensions from registry (handles Custom paper)
  let { widthMM, heightMM } = PaperRegistryProvider.resolvePaperDimensionsFromSettings({
    paperSize,
    customPaper: customPaper || null,
  })

  // Swap dimensions for landscape: PDF MediaBox must be landscape (w > h)
  const isLandscape = orientation === 'landscape'
  if (isLandscape) {
    ;[widthMM, heightMM] = [heightMM, widthMM]
  }

  try {
    const { pdfPath, size } = generatePdfFromCanvas({
      pngBuffer: Buffer.from(canvasBuffer),
      widthMM,
      heightMM,
      prefix: 'print',
    })
    return { success: true, pdfPath, size }
  } catch (err) {
    console.error('[generate-print-pdf] Failed:', err.message)
    return { success: false, error: err.message }
  }
})

// ── 源文件直通打印（新管线） ──
const { createBackend } = require('./print-service/print-backend')

ipcMain.handle('print-source-file', async (_event, { target, settings, pipeline }) => {
  console.log('[print-source-file] printer=%s file=%s format=%s',
    target?.printer, target?.filePath, target?.fileFormat)

  if (!target || !target.filePath) {
    return { success: false, exitCode: -1, message: 'PrintTarget.filePath is required' }
  }

  if (!target.printer) {
    return { success: false, exitCode: -1, message: 'Printer name is required' }
  }

  // 日志：完整 settings（含边距字段）
  console.log('[print-source-file] settings=%j', settings)

  // 安全边距预处理（仅对 PDF 或图片文件）
  const imgExts = ['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif']
  const fileExt = target.filePath ? path.extname(target.filePath).toLowerCase() : ''
  let printTarget = target
  const marginL = Number(settings?.marginLeft) || 0
  const marginR = Number(settings?.marginRight) || 0
  const marginT = Number(settings?.marginTop) || 0
  const marginB = Number(settings?.marginBottom) || 0
  console.log('[print-source-file] margin fields: left=%d right=%d top=%d bottom=%d', marginL, marginR, marginT, marginB)
  const hasMargins = pdfMargin.hasMargins(settings)
  console.log('[print-source-file] hasMargins=%s fileExt=%s', hasMargins, fileExt)
  if (hasMargins && imgExts.includes(fileExt)) {
    console.log('[print-source-file] Margins WILL be applied')
    const margins = pdfMargin.extractMargins(settings)
    const orient = settings.contentOrientation  // 'portrait'|'landscape'|undefined
    const isImage = fileExt !== '.pdf'
    const result = await pdfMargin.process(target.filePath, margins, isImage, orient)
    if (result.path !== target.filePath) {
      console.log('[print-source-file] Using margin-processed PDF:', result.path,
        'orientation:', result.orientation || '?')
      printTarget = { ...target, filePath: result.path }
      // 如果 Python 检测了方向且和当前 settings 不同，同步更新
      if (result.orientation && result.orientation !== settings.contentOrientation) {
        settings.contentOrientation = result.orientation
        console.log('[print-source-file] Updated contentOrientation to:', result.orientation)
      }
    } else {
      console.log('[print-source-file] Margin processing returned original file (no change or fallback)')
    }
  } else {
    console.log('[print-source-file] No margins to apply (reason: hasMargins=%s, ext=%s)', hasMargins, fileExt)
  }

  const backend = createBackend(pipeline?.backend || 'sumatra')
  console.log('[print-source-file] Using backend=%s', pipeline?.backend || 'sumatra')
  const result = await backend.print(printTarget, settings || {})
  console.log('[print-source-file] result=%j', result)

  return result
})

// ── 打印机能力查询 ──
const { PrinterCapabilityService } = require('./print-service/printer-capability')

ipcMain.handle('get-printer-capabilities', async (_event, printerName) => {
  console.log('[get-printer-capabilities] printer=%s', printerName)
  try {
    const service = PrinterCapabilityService.getInstance()
    const result = await service.getCapabilities(printerName)
    return result
  } catch (e) {
    console.error('[get-printer-capabilities] error:', e.message)
    return { error: e.message }
  }
})

// ── 合并打印 IPC ──
const { spawn } = require('child_process')
/**
 * 将 IPC 传入的图片数据转换为 Buffer。
 * Uint8Array 经过 contextBridge + structured clone 后可能变为普通对象 {0:..,1:..,length:N}，
 * 用 Buffer.allocUnsafe + 逐字节索引赋值确保任何情况下都能正确还原。
 */
function toImageBuffer(raw) {
  if (Buffer.isBuffer(raw)) return raw
  const len = raw.length
  if (typeof len !== 'number' || len === 0) {
    throw new Error(`toImageBuffer: 无效数据, typeof=${typeof raw}, keys=${Object.keys(raw || {}).slice(0, 5)}`)
  }
  const buf = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) {
    buf[i] = raw[i]
  }
  return buf
}

// ── Python 子进程调用（img2pdf + pikepdf） ──────────────────────

const _isDev = !app || !app.isPackaged

function _getPythonPaths() {
  if (_isDev) {
    return {
      exe: path.join(__dirname, '../backend/venv/Scripts/python.exe'),
      script: path.join(__dirname, '../pyscripts/pdf_tool.py'),
    }
  }
  return {
    exe: path.join(process.resourcesPath, 'backend/venv/Scripts/python.exe'),
    script: path.join(process.resourcesPath, 'pyscripts/pdf_tool.py'),
  }
}

async function callPython(args, timeoutMs = 30000) {
  const { exe, script } = _getPythonPaths()
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [script, ...args], {
      windowsHide: true,
      timeout: timeoutMs,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => stdout += d)
    child.stderr.on('data', d => stderr += d)
    const timer = setTimeout(() => { child.kill(); reject(new Error('Python 超时')) }, timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(stderr.slice(0, 500) || `退出码 ${code}`))
      else resolve(JSON.parse(stdout))
    })
    child.on('error', reject)
  })
}

ipcMain.handle('print-merged-images', async (_event, { images, settings }) => {
  console.log('[print-merged-images] images=%d, settings=%j', images?.length || 0, settings)

  if (!images || images.length === 0) {
    return { success: false, error: 'No images to print' }
  }

  // 创建临时目录
  const tempDir = path.join(os.tmpdir(), 'electron_merge_' + Date.now())
  const filePaths = []
  // 诊断校验的 Promise 集合：在 finally 清理临时文件前必须 await，避免文件已删导致 stat 失败
  let validationPromises = []

  try {
    fs.mkdirSync(tempDir, { recursive: true })

    // 1. 并行写入临时 PNG 文件（异步 I/O，避免主线程同步阻塞）
    //    PNG 魔数校验在写入前于内存中完成；异步写入失败会以 reject 暴露，等价于原同步写入的异常路径。
    //    原每文件 fs.statSync 仅用于日志，已移除——writeFile 成功即保证磁盘内容==buf。
    const writeTasks = images.map(async (img, i) => {
      const buf = toImageBuffer(img)

      // ✅ PNG 完整性校验：前 8 字节必须是 PNG 魔数
      const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
      if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
        const head = buf.subarray(0, 16).toString('hex')
        throw new Error(`图片 ${i + 1} PNG 魔数不匹配（数据损坏），前16字节: ${head}`)
      }

      const filePath = path.join(tempDir, `page_${i + 1}.png`)
      await fs.promises.writeFile(filePath, buf)
      return {
        filePath,
        size: buf.length,
        rawType: Object.prototype.toString.call(img),
        rawLen: img?.length,
        header: buf.subarray(0, 8).toString('hex'),
      }
    })

    const written = await Promise.all(writeTasks)
    for (const w of written) filePaths.push(w.filePath)

    written.forEach((w, i) => {
      console.log('[print-merged-images] PNG %d: buf=%d bytes, rawType=%s, rawLen=%d, header=%s',
        i + 1, w.size, w.rawType, w.rawLen, w.header)
    })
    console.log('[print-merged-images] 已写入 %d 个 PNG 到 %s', filePaths.length, tempDir)

    // 2. ✅ 批量 PNG → PDF 转换（一次 Python 进程处理全部，节省 spawn 开销）
    const margins = pdfMargin.extractMargins(settings)
    const pdfPaths = filePaths.map((_, i) => path.join(tempDir, `page_${i + 1}.pdf`))
    const batchFiles = filePaths.map((png, i) => ({ png, pdf: pdfPaths[i] }))

    const batchResult = await callPython([
      'batch-png-to-pdf',
      JSON.stringify({ files: batchFiles, margins, dpi: 300 }),
    ])

    if (!batchResult.success) {
      throw new Error(`批量 PDF 转换失败: ${batchResult.error}`)
    }

    for (let i = 0; i < pdfPaths.length; i++) {
      const result = batchResult.results?.[i]
      if (result && !result.success) {
        console.warn(`[print-merged-images] PNG ${i + 1} 转换警告:`, result.error)
      }
    }

    // 3. 并行、异步地做 PDF 结构校验与 MediaBox 提取（诊断日志，不阻塞打印管线）
    //    校验仅产生告警/日志，不影响控制流；用异步 I/O 避免主线程同步读取整个 PDF。
    //    收集为 Promise，在 finally 清理临时文件前 await，确保日志完整且文件尚在。
    validationPromises = pdfPaths.map((p, i) =>
      (async () => {
        const validation = await validatePdfStructureAsync(p)
        if (!validation.valid) {
          console.warn(`[print-merged-images] PDF ${i + 1} validation issues:`, validation.issues)
        }
        const mediaBox = extractMediaBox(p)
        console.log(`[print-merged-images] PNG ${i + 1} → PDF: ${p}, MediaBox=${JSON.stringify(mediaBox)}`)
      })()
    )

    // 4. 走 DirectPrintHandler 打印每个 PDF（与非合并模式相同的管线）
    //    复用其 SumatraPDF 参数构建、spawn、超时、清理逻辑
    for (let i = 0; i < pdfPaths.length; i++) {
      const result = await DirectPrintHandler.handle(pdfPaths[i], settings)
      if (!result.success) {
        throw new Error(`PDF ${i + 1} 打印失败: ${result.error}`)
      }
    }

    console.log('[print-merged-images] 打印完成')
    return { success: true }

  } catch (error) {
    console.error('[print-merged-images] 失败:', error.message)
    return { success: false, error: error.message }
  } finally {
    // 等诊断校验完成再删临时文件（避免文件已删导致 stat 失败、日志丢失）
    try { await Promise.allSettled(validationPromises) } catch (e) { /* 忽略 */ }
    // 6. 清理临时文件（PNG + PDF 都在 tempDir 内）
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
  }
})

// --- 窗口控制（通用：通过 sender 获取当前窗口，同时支持主窗口和设置窗口） ---
ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    win.minimize()
  }
})

ipcMain.on('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  }
})

ipcMain.on('window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    win.close()
  }
})

ipcMain.handle('window-is-maximized', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    return win.isMaximized()
  }
  return false
})

// --- 窗口拖动 ---
let dragStartScreenPos = { x: 0, y: 0 }
let dragStartWinPos = { x: 0, y: 0 }

ipcMain.on('window-drag-start', (event, { screenX, screenY }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    dragStartScreenPos = { x: screenX, y: screenY }
    const [winX, winY] = win.getPosition()
    dragStartWinPos = { x: winX, y: winY }
  }
})

ipcMain.on('window-drag-move', (event, { screenX, screenY }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    const deltaX = screenX - dragStartScreenPos.x
    const deltaY = screenY - dragStartScreenPos.y
    const newX = dragStartWinPos.x + deltaX
    const newY = dragStartWinPos.y + deltaY
    win.setPosition(newX, newY)
  }
})

ipcMain.on('window-drag-end', () => {
  // 拖动结束，清理状态（如果需要的话）
})

// --- 打开/关闭设置窗口 ---
ipcMain.on('open-settings-window', () => {
  createSettingsWindow()
})

ipcMain.on('close-settings-window', () => {
  if (settingsWindow) {
    settingsWindow.close()
    settingsWindow = null
  }
})

// --- 调整设置窗口大小 ---
ipcMain.handle('resize-settings-window', async (event, { width, height }) => {
  try {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      const [currentWidth, currentHeight] = settingsWindow.getSize()
      const newWidth = width || currentWidth
      const newHeight = height || currentHeight

      const finalWidth = Math.max(newWidth, 850)
      const finalHeight = Math.max(newHeight, 850)

      settingsWindow.setSize(finalWidth, finalHeight)
      return { success: true }
    }
    return { success: false, error: '设置窗口不存在' }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// --- 打印设置加载与保存 ---
ipcMain.handle('save-print-settings', async (event, settings) => {
  try {
    console.log('保存打印设置:', settings)
    // 确保目录存在
    const settingsDir = path.dirname(settingsPath)
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true })
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
    // ✅ 立即通知主窗口设置已变化（尤其是 mergeMode）
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings-changed', settings)
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('load-print-settings', async () => {
  try {
    if (!fs.existsSync(settingsPath)) return {}
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
  } catch (error) {
    return {}
  }
})

ipcMain.handle('get-printers', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return []
  // ✅ 移除无意义的 500ms 延迟，直接获取打印机列表
  try {
    const printers = await mainWindow.webContents.getPrintersAsync()
    return printers.map(p => p.name)
  } catch (e) {
    console.error('get-printers error:', e)
    return []
  }
})

// ============================
// 文件保存对话框（供前端获取保存路径）
// ============================
ipcMain.handle('select-save-path', async (event, options) => {
  try {
    const { defaultName = 'export', filters = [] } = options || {}
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出文件',
      defaultPath: `${defaultName}.xlsx`,
      filters: filters.length > 0 ? filters : [
        { name: 'Excel 文件', extensions: ['xlsx'] },
        { name: 'CSV 文件', extensions: ['csv'] },
      ]
    })
    if (result.canceled || !result.filePath) {
      return { canceled: true }
    }
    return { canceled: false, filePath: result.filePath }
  } catch (error) {
    console.error('[main.js] select-save-path error:', error)
    return { canceled: true, error: error.message }
  }
})

// ============================
// 单实例模式
// ============================
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  console.log('[main.js] 应用已在运行，退出当前实例')
  app.quit()
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    console.log('[main.js] 检测到第二个实例启动，参数:', commandLine)

    // 改造：支持多格式文件
    const files = []
    for (let i = 1; i < commandLine.length; i++) {
      const arg = commandLine[i]
      // ✅ 忽略 macOS 下的特殊参数
      if (!arg || arg === '--' || arg.startsWith('-psn')) {
        continue
      }
      if (SUPPORTED_EXTENSIONS.some(ext => arg.toLowerCase().endsWith(ext))) {
        files.push(arg)
      }
    }

    // ✅ 若 mainWindow 不存在，暂存文件到队列
    if (files.length > 0) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[main.js] 发送文件到主窗口:', files)
        mainWindow.webContents.send('context-menu-files', files.map(f => ({
          name: path.basename(f),
          path: f
        })))

        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      } else {
        console.log('[main.js] 主窗口未创建，暂存文件:', files)
        pendingFilesFromSecondInstance = [...pendingFilesFromSecondInstance, ...files]
      }
    }
  })

  app.whenReady().then(async () => {
    logger.init()  // 初始化日志模块

    // ✅ 初始化新打印管线
    initNewPrintPipeline()

    // ✅ 初始化纸张注册表（加载用户自定义纸张）
    try {
      const { PaperRegistryProvider } = require('./shared/PaperRegistryProvider')
      await PaperRegistryProvider.initialize()
    } catch (err) {
      console.error('[BOOT] PaperRegistryProvider initialization failed:', err.message)
    }

    createWindow()

    app.on('before-quit', () => {
      // ✅ 清理临时文件
      cleanupAllTempFiles()
      // ✅ 刷新日志（如果 logger 支持）
      if (typeof logger.flush === 'function') {
        logger.flush()
      }
    })

    const startupFiles = getFilesFromCommandLine()
    if (startupFiles.length > 0) {
      logger.log('[main.js] 启动时接收到文件:', startupFiles)
      pendingFilesFromContextMenu = startupFiles
    }
  })
}
