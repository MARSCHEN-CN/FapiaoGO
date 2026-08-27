'use strict'

// 自定义日志模块
const logger = require('./logger')

const { app, BrowserWindow, ipcMain, dialog, Menu, MenuItem, screen, session } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')

// ============================
// DP-2B Early Bootstrap — 统一数据根（DATA-PATH Contract v1.1）
// 必须在任何 app.getPath('userData') 之前执行：
//   · main.js 下方 settingsPath（模块加载期）
//   · ConfigService.js:14 CONFIG_DIR（main.js 稍后 require，模块加载期）
// 原则：DATA_ROOT/USERDATA_ROOT 恒 = EXE 同级（dev = 项目根）；
// 不可写 → 明确报错退出，绝不静默 fallback 到 %APPDATA%。
// ============================
const { ensureDataRoots } = require('./shared/data-root')
const dataRootCheck = ensureDataRoots()
if (!dataRootCheck.ok) {
  dialog.showErrorBox(
    'FapiaoGO 无法启动',
    '当前安装目录没有写入权限，无法创建数据目录。\n\n' +
    '请将程序安装/解压到可写目录（如 D:\\FapiaoGO），\n或以管理员权限运行。'
  )
  process.exit(1)
}
app.setPath('userData', dataRootCheck.userDataRoot)

const { extractMediaBoxAsync } = require('./shared/pdf-orientation')

// ============================
// 模块导入
// ============================
const { SUPPORTED_EXTENSIONS, FILE_DIALOG_FILTERS } = require('./constants')
const { init: initTempManager, cleanupAllTempFiles, TEMP_DIR } = require('./temp-manager')
const { registerFileOpsHandlers } = require('./ipc-file-ops')
const { registerRenameHandlers } = require('./ipc-rename')
const { registerPackHandlers } = require('./ipc-pack')
const { initArchivePaths } = require('./archive-utils')
const pdfMargin = require('./print-service/pdf-margin-processor')
// C-2 Step 4-2b-1：Plan placement 生产消费层（placement_bake 接线；无 placement 时零介入）
const placementBake = require('./print-service/placement-bake-processor')
// G1d / R6：Geometry Translator —— Truth {orientation, rotate} → apply_pdf 输入。
// 唯一 Rotation→Geometry 语义转换入口；不复用 print-settings.js:normalize()（其 swap 准则
// = requestedOrient!==naturalOrient，与 §9.4 的 rotate%180==90 不同，复用会再引入双重交换）。
const { translateGeometry } = require('./print-service/geometry-translator')
// G2-R2：32-case Execution Truth Resolver —— Execution Command 层唯一旋转权威。
// 替代旧 main.js 把 sourceRotation 当命令旋转的污染（G2-R2-3 已断），旧 16 表 resolver
// 仅适用直打模型、不适用 bake，本 Resolver 是 32 条真机实测的唯一真理。
const { resolveExecutionTruth } = require('./print-service/execution-truth-resolver')
const { getPaperShapeOrientation } = require('./print-service/print-settings')
const { initUpdateManager } = require('./services/Update/UpdateManager')
const { load: loadConfig } = require('./services/ConfigService')

// ⚠️ 预热已移至 app.whenReady() 内（见下方）：模块加载期不应产生副作用，
//    且彼时 logger 尚未 init()，日志会丢失。


// ============================
// 新打印管线 — OS Trust Delegation
// ============================
const { PrintService } = require('./print-service/PrintService')
const { OsLauncherBridge, preDetectDefaultPrinter } = require('./print-service/OsLauncherBridge')
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
    preDetectDefaultPrinter(window.webContents)
    console.log('[PIPELINE] Default printer pre-detection started (non-blocking)')
  }
}

// ============================
// 应用图标路径（兼容开发/生产模式）
// ============================
function resolveAppIconPath() {
  const candidates = [
    // 开发模式：resources/icon.ico（项目根目录）
    path.resolve(__dirname, '../resources/icon.ico'),
    // 生产模式：electron-builder 将 buildResources 打包到 process.resourcesPath
    process.resourcesPath ? path.join(process.resourcesPath, 'icon.ico') : null,
    // 兜底：PNG 原文件
    path.resolve(__dirname, '../frontend/public/icon/app.png'),
  ].filter(Boolean)
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p } catch {}
  }
  return null
}
const APP_ICON_PATH = resolveAppIconPath()
if (APP_ICON_PATH) console.log(`[main.js] 应用图标: ${APP_ICON_PATH}`)

// ============================
// Windows AppUserModelId — 任务栏/开始菜单/任务管理器图标绑定
// 必须在 app.whenReady() 之前设置，否则 Windows 会用 electron 默认图标分组
// ============================
if (process.platform === 'win32') {
  app.setAppUserModelId('com.FapiaoGO.app')
  console.log('[main.js] AppUserModelId: com.FapiaoGO.app')
}

// ============================
// 窗口状态
// ============================
let mainWindow
let settingsWindow
let calculatorWindow
// ✅ 使用 app.getPath('userData') 构建配置路径，避免依赖工作目录
const settingsPath = path.join(app.getPath('userData'), 'Settings.json')

let pendingFilesFromContextMenu = []

// 暂存 second-instance 事件中的文件，待窗口创建后处理
let pendingFilesFromSecondInstance = []

// 开发模式判断
const isDev = !app.isPackaged

// Windows 任务栏图标关联 ID — 避免通知栏图标显示为默认 Electron 图标
if (!isDev) {
  app.setAppUserModelId('com.fapiaogo.desktop')
}

// 将资源根路径经 process.env 传给 preload（app 模块在 preload/sandbox 上下文不可见，
// 只能由主进程计算后注入；渲染进程会继承主进程环境，preload 内 process.env 可读）。
// 生产: process.resourcesPath（指向 …/resources，cmaps/ 等已通过 extraResources 放此）；
// 开发: 空串 → renderers.js 回退到 Vite 的 /cmaps/ 等根相对静态资源。
process.env.FAPAIAO_RESOURCE_PATH = app.isPackaged ? process.resourcesPath : ''
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
    show: false,
    backgroundColor: '#f2f4f8',
    icon: APP_ICON_PATH || undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  setMainWindowForBridge(mainWindow)
  mainWindow.setMenuBarVisibility(false)

  // 页面加载完成后再显示窗口，避免白屏闪烁（与 settingsWindow/calculatorWindow 一致）
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  // 安全兜底：3秒后无论如何都显示窗口，防止页面加载异常时窗口永不出现
  // （开发模式下 Vite 未启动、或生产环境文件损坏等极端情况）
  const fallbackShowTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.warn('[main.js] ready-to-show 未触发，超时显示窗口')
      mainWindow.show()
    }
  }, 3000)
  mainWindow.once('closed', () => clearTimeout(fallbackShowTimer))

  // 根据运行模式加载不同的资源
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  // 外部链接在系统浏览器中打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      console.log(`[main.js] 外部链接，在浏览器中打开: ${url}`)
      require('electron').shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

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

  // 关闭主窗口时一并关闭子窗口
  mainWindow.on('closed', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.removeAllListeners('closed')  // 防止触发 settingsWindow.on('closed') 调用 mainWindow.webContents.send
      settingsWindow.close()
      settingsWindow = null
    }
    if (calculatorWindow && !calculatorWindow.isDestroyed()) {
      calculatorWindow.removeAllListeners('closed')
      calculatorWindow.close()
      calculatorWindow = null
    }
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
    minWidth: 750,
    minHeight: 600,
    show: false,
    frame: false,
    icon: APP_ICON_PATH || undefined,
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
    settingsWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: '/settings' })
  }

  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      console.log(`[main.js] 设置窗口外部链接，在浏览器中打开: ${url}`)
      require('electron').shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

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

function createCalculatorWindow() {
  if (calculatorWindow) {
    calculatorWindow.focus()
    return
  }

  // 根据屏幕分辨率自适应窗口尺寸（2K 基准 420×680）
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize

  let width, height, minWidth, minHeight
  if (screenWidth >= 3840) {
    // 4K：放大 ~1.3×，按钮字号保持不变，显示区更宽敞
    width = 540
    height = 860
    minWidth = 480
    minHeight = 720
  } else if (screenWidth >= 2560) {
    // 2K：用户校准的基准尺寸
    width = 420
    height = 680
    minWidth = 400
    minHeight = 640
  } else {
    // 1080p 及以下：更紧凑，按钮通过 CSS 媒体查询自动缩小
    width = 360
    height = 580
    minWidth = 320
    minHeight = 520
  }

  calculatorWindow = new BrowserWindow({
    width,
    height,
    modal: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    minWidth,
    minHeight,
    show: false,
    frame: false,
    backgroundColor: '#ffffff',
    icon: APP_ICON_PATH || undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  calculatorWindow.setMenuBarVisibility(false)

  // 根据运行模式加载不同的资源
  if (isDev) {
    calculatorWindow.loadURL('http://localhost:5173/#/calculator')
  } else {
    calculatorWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: '/calculator' })
  }

  calculatorWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      console.log(`[main.js] 计算器窗口外部链接，在浏览器中打开: ${url}`)
      require('electron').shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

  // URL 白名单导航控制
  const allowedOrigins = ['http://localhost:5173', 'file://']
  calculatorWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = allowedOrigins.some(origin => url.startsWith(origin))
    if (!allowed) {
      console.log(`[main.js] 计算器窗口阻止导航到未授权 URL: ${url}`)
      event.preventDefault()
    }
  })

  calculatorWindow.on('ready-to-show', () => {
    calculatorWindow.show()
  })

  calculatorWindow.on('closed', () => {
    calculatorWindow = null
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

  // B1 修复：PDF MediaBox 必须反映「有效纸方向 = orientation」，
  // swap 基于 orientation ≠ 原生形状（避免 PostScript 等原生横向纸型 UI/几何恒相反）。
  const nativeLandscape = widthMM > heightMM
  const needSwap = (orientation === 'landscape') !== nativeLandscape
  if (needSwap) {
    ;[widthMM, heightMM] = [heightMM, widthMM]
  }

  try {
    const { pdfPath, size } = await generatePdfFromCanvas({
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

// G2-R2：从 settings 收集 32-case Execution Truth 的 4 个真值输入。
//   baked=true 表示走 placement-bake 路径：内容已烤入最终方向（Plan truth, /Rotate=0）
//     → userRotation=0（业务旋转已烤入内容）、invoiceOrientation=请求方向（baked 内容已对齐请求）。
//   baked=false 表示直打路径（margin / source）：内容未烤入，按真实输入解析。
function gatherTruthInputs(settings, { baked = false } = {}) {
  const paper = settings?.paper ?? settings?.paperSize;
  const naturalOrient = getPaperShapeOrientation(paper, settings?.customPaper);
  const requestedPaperOrientation =
    settings?.paperOrientation ?? (settings?.landscape ? 'landscape' : naturalOrient);
  const invoiceOrientation = baked ? requestedPaperOrientation : (settings?.contentOrientation || naturalOrient);
  const userRotation = baked ? 0 : (Number(settings?.sourceRotation) || Number(settings?.rotation) || 0);
  return { paperType: naturalOrient, invoiceOrientation, userRotation, requestedPaperOrientation };
}

// G2-R2：解析 32-case Execution Truth 并注入 commandOrientation/commandRotate 到 target（best-effort）。
// 失败时回退 buildPrintSettings 内置兜底解析（不抛，保证打印链路不中断）。
function injectExecutionTruth(target, settings, opts) {
  try {
    const truth = resolveExecutionTruth(gatherTruthInputs(settings, opts));
    target.commandOrientation = truth.paperOrientation;
    target.commandRotate = truth.rotate;
  } catch (e) {
    console.warn('[print-source-file] G2-R2 resolveExecutionTruth 失败，回退 buildPrintSettings 内置解析: %s', e.message);
  }
  return target;
}


ipcMain.handle('print-source-file', async (_event, { target, settings, pipeline }) => {
  const PRINT_TIMEOUT_MS = 180000

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Print operation timed out after ${PRINT_TIMEOUT_MS}ms`))
    }, PRINT_TIMEOUT_MS)
  })

  const printPromise = (async () => {
    console.log('[print-source-file] printer=%s file=%s format=%s',
      target?.printer, target?.filePath, target?.fileFormat)

    if (!target || !target.filePath) {
      return { success: false, exitCode: -1, message: 'PrintTarget.filePath is required' }
    }

    if (!target.printer) {
      return { success: false, exitCode: -1, message: 'Printer name is required' }
    }

    console.log('[print-source-file] settings=%j', settings)

    const imgExts = ['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif']
    const fileExt = target.filePath ? path.extname(target.filePath).toLowerCase() : ''
    let printTarget = target
    // 提升 printSettings 声明：旧代码在 margin if 块内声明、块外引用（TDZ，
    // OFD/无 margins 走 else 时 ReferenceError）。提升后默认值不变，零行为变化。
    let printSettings = settings || {}
    const marginL = Number(settings?.marginLeft) || 0
    const marginR = Number(settings?.marginRight) || 0
    const marginT = Number(settings?.marginTop) || 0
    const marginB = Number(settings?.marginBottom) || 0
    console.log('[print-source-file] margin fields: left=%d right=%d top=%d bottom=%d', marginL, marginR, marginT, marginB)
    const hasMargins = pdfMargin.hasMargins(settings)
    // C-2 Step 4-2b-1：Plan placement 生产接线判定（placement + executionPaper + PDF 源
    // + Sumatra 纸 == executionPaper；任一不满足 → false，走原路径）
    const bakeEnabled = placementBake.hasPlacement(settings, target.filePath)
    // PRINT-2（R4-P0-8-C）：bake 降级时若用户设置了安全边距 → 回落 margin 路径，
    // 不再静默退化为「原图打印」导致边距丢失（P1 根因之一）。
    let bakeDegraded = false
    console.log('[print-source-file] hasMargins=%s fileExt=%s bakeEnabled=%s', hasMargins, fileExt, bakeEnabled)
    if (bakeEnabled) {
      // 4-2b-1 接线 + 4-2b-2（D2）执行策略：
      //   - 4-2b-1 冻结：bake 优先并跳过 pdfMargin（expand_box 与 contain-fit 互斥，
      //     双重烘焙破坏源尺寸）；无 placement 旧路径零变化。
      //   - 4-2b-2b（本 commit）：bake 成功 → Sumatra 不再参与 layout（noscale）。
      //     bake 产物 MediaBox==paper /Rotate=0（4-2a 输出契约），noscale 与 fit
      //     在该条件下严格等价（4-2b-2a sumatraNoScaleGate 五 case 证明，drift≤0.16mm）。
      //     override 通过【新对象】{...settings, scalePolicy:'none'}，不 mutate settings
      //     （G-C1-C-1）。⚠️ noscale 只在 bake 成功路径；降级（bake 失败）→ 原路径 fit。
      console.log('[print-source-file] Plan placement detected → placement bake (4-2b-2: noscale)')
      const bakeResult = await placementBake.process(target.filePath, settings)
      if (bakeResult.path !== target.filePath) {
        printTarget = { ...target, filePath: bakeResult.path }
        printSettings = { ...(settings || {}), scalePolicy: 'none' }
        console.log('[print-source-file] Using placement-baked PDF:', bakeResult.path)
        console.log('[print-source-file] scalePolicy=none (noscale) — baked PDF, Sumatra pure executor')
        // ── G2-R2-3：移除旧污染（曾按 landscape 纸把 sourceRotation 强行设为 90 的注入）──
        // 该注入把 sourceRotation 当成命令旋转，与 32-case Truth 冲突，是 FAIL case 根因
        // （竖向纸+横向发票+0°+landscape 被错误加成 rotate=90）。现改为：经 32-case
        // Execution Truth Resolver 解析命令旋转（bake 语义：内容已烤入最终方向，
        //   userRotation=0 / invoiceOrientation=请求方向）。landscape 纸的 +90 executor 补偿
        // 由 Truth 表「横向纸+landscape 请求」对应格自然给出，不再手写字面量，且精炼了
        // 旧 16 表的 blanket-90 近似（如 横向纸+portrait 请求对应格为 rotate=90，见 Truth）。
        printSettings = injectExecutionTruth(printSettings, settings, { baked: true });
        console.log('[print-source-file] G2-R2 bake executor command: orient=%s rotate=%s',
          printSettings.commandOrientation, printSettings.commandRotate);
      } else {
        // PRINT-2：bake 降级 → 若 hasMargins 则回落 margin 路径（下方统一处理）
        bakeDegraded = true
        console.log('[print-source-file] Placement bake degraded → %s',
          hasMargins && imgExts.includes(fileExt) ? 'margin fallback (PRINT-2)' : 'print original (fit)')
      }
    }

    // margin 路径：直接命中（非 bake）或 PRINT-2 bake 降级回落
    if ((bakeDegraded || !bakeEnabled) && hasMargins && imgExts.includes(fileExt)) {
      console.log('[print-source-file] Margins WILL be applied')
      const margins = pdfMargin.extractMargins(settings)
      const orient = settings.contentOrientation
      const isImage = fileExt !== '.pdf'

      // ── G1b / G1d（Gate 2）：Truth → Geometry Translator → apply_pdf 输入 ──
      // Truth.orientation = settings.paperOrientation（最终期望输出纸方向，PrintService:79 已补传）
      // Truth.rotate      = settings.sourceRotation（用户原始旋转意图，PrintService:69）
      // baseDims          = resolvePaperMmFromSettings（物理纸尺寸 mm，orientation-agnostic，如 A4={width:210,height:297}）
      // Translator 是唯一 swap 权威（§9.4 R6）；paperW/H 必须来自 Translator 输出，
      //   绝不能把 requested orientation 对应的尺寸直接塞给 apply_pdf（否则双重交换）。
      const truthOrientation = settings.paperOrientation === 'landscape' || settings.paperOrientation === 'portrait'
        ? settings.paperOrientation
        : (settings.landscape ? 'landscape' : 'portrait')
      const truthRotate = Number(settings.sourceRotation) || 0
      const baseDims = pdfMargin.resolvePaperMmFromSettings(settings)
      let geoOpts = {}
      if (baseDims) {
        const geo = translateGeometry({ orientation: truthOrientation, rotate: truthRotate, baseDims })
        geoOpts = {
          paperW_mm: geo.nativePaperW_mm,
          paperH_mm: geo.nativePaperH_mm,
          contentRotation: geo.contentRotation,
        }
        console.log('[print-source-file] G1d Translator: orient=%s rotate=%s → native=%dx%dmm contentRotation=%s',
          truthOrientation, truthRotate, geo.nativePaperW_mm, geo.nativePaperH_mm, geo.contentRotation)
      } else {
        console.warn('[print-source-file] G1d: resolvePaperMmFromSettings 返回 null（纸型未知）→ 维持源 MediaBox 兜底（旧行为）')
      }

      const MARGIN_TIMEOUT_MS = 30000
      const marginTimeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Margin processing timed out after ${MARGIN_TIMEOUT_MS}ms`))
        }, MARGIN_TIMEOUT_MS)
      })

      const marginResult = await Promise.race([
        pdfMargin.process(target.filePath, margins, isImage, orient, geoOpts),
        marginTimeoutPromise
      ])

      // Phase 1-C-1-c：scalePolicy 单一来源。边距已 bake 进 PDF 时禁止 Sumatra 再
      // fit（二次缩放破坏边距精度）——override 通过【新对象】{...settings, scalePolicy:'none'}，
      // 不 mutate settings（G-C1-C-1：本文件不得再出现 legacy fit 字段读取）。
      if (marginResult.path !== target.filePath) {
        console.log('[print-source-file] Using margin-processed PDF:', marginResult.path,
          'orientation:', marginResult.orientation || '?')
        printTarget = { ...target, filePath: marginResult.path }
        if (marginResult.orientation && marginResult.orientation !== settings.contentOrientation) {
          settings.contentOrientation = marginResult.orientation
          console.log('[print-source-file] Updated contentOrientation to:', marginResult.orientation)
        }
        // ⚠️ contentOrientation 的 mutate 属方向域，C-2（PrintExecutionPlan 闭环）统一处理；
        // 本 commit 只收敛 scalePolicy。
        printSettings = { ...(settings || {}), scalePolicy: 'none' }
        console.log('[print-source-file] scalePolicy=none (noscale) since margins are baked in')
      } else {
        console.log('[print-source-file] Margin processing returned original file (no change or fallback)')
      }
    } else {
      console.log('[print-source-file] No margins to apply (reason: hasMargins=%s, ext=%s)', hasMargins, fileExt)
    }

    // G2-R2：直打路径（margin / source / bake 降级）统一在末端注入 32-case Execution Truth。
    // bake 成功路径已在上方注入（commandOrientation 已存在），此处 guard 跳过避免重复解析。
    if (!printSettings.commandOrientation) {
      printSettings = injectExecutionTruth(printSettings, printSettings, { baked: false });
      console.log('[print-source-file] G2-R2 direct command: orient=%s rotate=%s',
        printSettings.commandOrientation, printSettings.commandRotate);
    }

    const backend = createBackend(pipeline?.backend || 'sumatra')
    console.log('[print-source-file] Using backend=%s', pipeline?.backend || 'sumatra')
    const result = await backend.print(printTarget, printSettings)
    console.log('[print-source-file] result=%j', result)

    return result
  })()

  try {
    return await Promise.race([printPromise, timeoutPromise])
  } catch (e) {
    console.error('[print-source-file] timed out:', e.message)
    return {
      success: false,
      exitCode: -1,
      message: e.message.includes('MARGIN') ? '边距处理超时，请检查文件或重试' : '打印超时，请检查打印机连接',
      stderr: e.message,
    }
  }
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
  // 真实 TypedArray 视图：零拷贝引用底层 ArrayBuffer 批量构造（大图逐字节循环开销显著）
  if (raw && raw.buffer instanceof ArrayBuffer) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  }
  // 退化情形：structured clone 把 Uint8Array 变成普通对象 {0:..,1:..,length:N}
  // 此时无 .buffer，只能逐字节拷贝还原（保留原行为，确保任何情况下都能正确还原）。
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
      isStandalone: false,
    }
  }
  // 生产模式：独立 pdf_tool.exe（方案 A：不污染 server.exe）
  // 位置: resources/tools/pdf_tool/pdf_tool.exe
  const standaloneExe = path.join(process.resourcesPath, 'tools/pdf_tool/pdf_tool.exe')
  if (fs.existsSync(standaloneExe)) {
    return { exe: standaloneExe, args: [], isStandalone: true }
  }
  // 降级：如果 pdf_tool.exe 不存在，标记为不可用
  console.warn('[callPython] pdf_tool.exe 未找到，PNG→PDF 转换将失败')
  return null
}

async function callPython(args, timeoutMs = 30000) {
  const paths = _getPythonPaths()
  if (!paths) {
    return { success: false, error: 'pdf_tool.exe 未找到，PNG→PDF 转换不可用' }
  }
  const { exe, script, isStandalone } = paths
  const spawnArgs = isStandalone ? [...args] : [script, ...args]
  return new Promise((resolve, reject) => {
    const child = spawn(exe, spawnArgs, {
      windowsHide: true,
      timeout: timeoutMs,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      }
    })
    // 用 Buffer 数组收集，最后一次性 concat，避免每次 'data' 都重新拷贝整段字符串（大输出 O(n²)）；
    // 同时避免逐块 Buffer.toString() 在 UTF-8 多字节跨块边界时被截断成乱码。
    const outChunks = []
    const errChunks = []
    child.stdout.on('data', d => outChunks.push(d))
    child.stderr.on('data', d => errChunks.push(d))
    const timer = setTimeout(() => { child.kill(); reject(new Error('Python 超时')) }, timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      const stdout = Buffer.concat(outChunks).toString('utf-8')
      const stderr = Buffer.concat(errChunks).toString('utf-8')
      if (code !== 0) reject(new Error(stderr.slice(0, 500) || `退出码 ${code}`))
      else resolve(JSON.parse(stdout))
    })
    child.on('error', reject)
  })
}

// ── Flask 后端进程管理 ──────────────────────────────────────────
let backendProcess = null

function _getBackendPaths() {
  if (isDev) {
    return {
      // 开发模式：手动启动 python backend/app.py
      exe: path.join(__dirname, '../backend/venv/Scripts/python.exe'),
      args: [path.join(__dirname, '../backend/app.py')],
      cwd: path.join(__dirname, '../backend'),
      modelDir: path.join(__dirname, '../resources/models'),
    }
  }
  // 生产模式：PyInstaller 打包的 server.exe（独立运行，无需 venv）
  return {
    exe: path.join(process.resourcesPath, 'backend/server/server.exe'),
    args: [],  // server.exe 内置 Flask，无需额外参数
    cwd: path.join(process.resourcesPath, 'backend/server'),
    modelDir: path.join(process.resourcesPath, 'models'),
  }
}

/**
 * 轮询后端 /health 直至就绪（或超时）。
 * 解决「Electron spawn 后端后前端立即调用 → 后端仍在加载 → 连接被拒」的竞态。
 * 使用 127.0.0.1 而非 localhost，避免 Chromium 优先解析 ::1(IPv6) 导致首跳被拒。
 */
function waitForBackendReady(timeoutMs = 30000, intervalMs = 250) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    let settled = false
    const finish = (err) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }
    const probe = () => {
      const req = http.get({ host: '127.0.0.1', port: 5000, path: '/health', timeout: 2000 }, (res) => {
        res.resume()
        if (res.statusCode === 200) finish(null)
        else if (Date.now() < deadline) setTimeout(probe, intervalMs)
        else finish(new Error('[BACKEND] 等待后端就绪超时 (/health 非 200)'))
      })
      req.on('error', () => {
        if (Date.now() < deadline) setTimeout(probe, intervalMs)
        else finish(new Error('[BACKEND] 等待后端就绪超时 (连接被拒)'))
      })
      req.on('timeout', () => {
        req.destroy()
        if (Date.now() < deadline) setTimeout(probe, intervalMs)
        else finish(new Error('[BACKEND] 等待后端就绪超时'))
      })
    }
    probe()
  })
}

async function startBackendServer() {
  // 开发模式下假定后端由开发者手动启动
  if (isDev) {
    console.log('[BACKEND] 开发模式：跳过自动启动，假定手动运行 Flask')
    return
  }
  const { exe, args, cwd, modelDir } = _getBackendPaths()
  console.log(`[BACKEND] 启动后端: ${exe} ${args.length ? args.join(' ') : '(无参数)'}`)
  console.log(`[BACKEND] 工作目录: ${cwd}`)
  console.log(`[BACKEND] OCR 模型目录: ${modelDir}`)
  backendProcess = spawn(exe, args, {
    windowsHide: true,
    cwd: cwd,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      FLASK_PORT: '5000',
      OCR_MODEL_DIR: modelDir,
      // 数据库路径：Electron 自身也用 userData，保持一致
      FAPIAOGO_DB_PATH: path.join(app.getPath('userData'), '.fapiaogo'),
    },
  })
  backendProcess.stdout?.on('data', d => {
    const lines = d.toString().trim().split('\n')
    for (const line of lines) {
      if (line) console.log(`[BACKEND stdout] ${line}`)
    }
  })
  backendProcess.stderr?.on('data', d => {
    const lines = d.toString().trim().split('\n')
    for (const line of lines) {
      if (line) console.log(`[BACKEND stderr] ${line}`)
    }
  })
  backendProcess.on('error', err => {
    console.error('[BACKEND] 启动失败:', err.message)
  })
  backendProcess.on('exit', (code, signal) => {
    console.log(`[BACKEND] 进程退出: code=${code}, signal=${signal}`)
  })

  // ✅ 后端就绪握手：等待 /health 返回 200 再放行渲染进程，消除启动竞态
  console.log('[BACKEND] 等待后端就绪 (GET /health)...')
  await waitForBackendReady()
  console.log('[BACKEND] 就绪，继续创建窗口')
}

function stopBackendServer() {
  if (backendProcess && !backendProcess.killed) {
    console.log('[BACKEND] 停止后端进程 (server.exe)')
    backendProcess.kill()
    backendProcess = null
  }
}

ipcMain.handle('print-merged-images', async (_event, { images, settings }) => {
  console.log('[print-merged-images] images=%d, settings=%j', images?.length || 0, settings)

  if (!images || images.length === 0) {
    return { success: false, error: 'No images to print' }
  }

  // 创建临时目录
  const tempDir = path.join(TEMP_DIR, 'electron_merge_' + Date.now())
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
        const mediaBox = await extractMediaBoxAsync(p)
        console.log(`[print-merged-images] PNG ${i + 1} → PDF: ${p}, MediaBox=${JSON.stringify(mediaBox)}`)
      })()
    )

    // 4. 复用单票通道（SumatraBackend.print → buildPrintSettings），与 print-source-file
    //    同源，方向由 buildPrintSettings 解析。merge 内容是前端已烘焙好的合成位图
    //    （RG-3：contentRotation=0），方向由 mergeModeContract.forcedLandscape 决定
    //    （透传自 settings.landscape），因此显式声明 commandOrientation / commandRotate=0：
    //    · 修复 OsLauncherBridge.decidePrintSpec 丢弃 job.orientation、导致 merge4
    //      强制横向丢失 → 纵向纸打印 → 上下大留白的问题；
    //    · 同时避免走 Truth resolver — 预烘焙的合成内容不应再被按原始发票方向误加 rotate
    //      （如 {portrait,portrait,0,landscape} 会查到 rotate=180，把已摆正内容转倒）。
    //    边距已在 batch-png-to-pdf 阶段烤入 PDF，此处不再二次处理。
    const backend = createBackend('sumatra')
    for (let i = 0; i < pdfPaths.length; i++) {
      const mergedSettings = {
        ...settings,
        commandOrientation: settings.landscape ? 'landscape' : 'portrait',
        commandRotate: 0,
      }
      const target = { filePath: pdfPaths[i], printer: settings.printerName || '', fileFormat: 'pdf' }
      const result = await backend.print(target, mergedSettings)
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

// --- 检查应用更新 ---
ipcMain.handle('check-app-update', async () => {
  console.log('[check-app-update] 收到检查更新请求')
  try {
    const { checkForUpdates } = require('./services/Update/GithubApiChecker')
    const config = loadConfig()
    const currentVersion = app.getVersion()
    console.log(`[check-app-update] 当前版本: ${currentVersion}, GitHub: ${config.githubOwner}/${config.githubRepo}`)
    const result = await checkForUpdates({
      owner: config.githubOwner,
      repo: config.githubRepo,
      currentVersion,
    })
    console.log(`[check-app-update] 检查结果: available=${result.available}, version=${result.version || 'N/A'}`)
    return result
  } catch (err) {
    console.error('[check-app-update] 检查更新失败:', err.message)
    return { available: false, reason: 'check_failed', error: err.message }
  }
})

// --- 下载应用更新 ---
ipcMain.handle('download-update', async () => {
  console.log('[download-update] 收到下载更新请求')
  try {
    // 开发模式：打开 GitHub Release 页面
    if (!app.isPackaged) {
      const config = loadConfig()
      const releaseUrl = `https://github.com/${config.githubOwner}/${config.githubRepo}/releases/latest`
      const { shell } = require('electron')
      shell.openExternal(releaseUrl)
      return { success: true, mode: 'dev', redirectUrl: releaseUrl }
    }

    // 生产模式：使用 electron-updater 下载
    const { autoUpdater } = require('electron-updater')
    const config = loadConfig()

    // 设置 GitHub 更新源
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: config.githubOwner,
      repo: config.githubRepo,
    })

    // 监听下载进度并推送给前端
    autoUpdater.on('download-progress', (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-download-progress', {
          percent: Math.round(progress.percent),
          bytesPerSecond: progress.bytesPerSecond,
        })
      }
    })

    autoUpdater.on('update-downloaded', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-downloaded')
      }
    })

    autoUpdater.on('error', (err) => {
      console.error('[download-update] electron-updater 错误:', err.message)
    })

    await autoUpdater.downloadUpdate()
    console.log('[download-update] 下载完成')
    return { success: true, mode: 'production' }
  } catch (err) {
    console.error('[download-update] 下载更新失败:', err.message)
    return { success: false, error: err.message }
  }
})

// --- 安装应用更新 ---
ipcMain.handle('install-update', async () => {
  console.log('[install-update] 收到安装更新请求')
  try {
    if (!app.isPackaged) {
      // 开发模式：打开 GitHub Release 页面
      const config = loadConfig()
      const releaseUrl = `https://github.com/${config.githubOwner}/${config.githubRepo}/releases/latest`
      const { shell } = require('electron')
      shell.openExternal(releaseUrl)
      return { success: true, mode: 'dev', redirectUrl: releaseUrl }
    }

    // 生产模式：退出并安装
    const { autoUpdater } = require('electron-updater')
    autoUpdater.quitAndInstall(false, true)
    return { success: true }
  } catch (err) {
    console.error('[install-update] 安装更新失败:', err.message)
    return { success: false, error: err.message }
  }
})
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

// --- 打开计算器窗口 ---
ipcMain.on('open-calculator-window', () => {
  createCalculatorWindow()
})

// --- 主题切换广播：任意窗口切换主题，主进程转发给其他所有窗口 ---
ipcMain.on('theme-changed', (event, theme) => {
  const sender = event.sender
  const targets = [mainWindow, settingsWindow, calculatorWindow].filter(
    w => w && !w.isDestroyed() && w.webContents !== sender
  )
  for (const w of targets) {
    w.webContents.send('theme-changed', theme)
  }
})

// --- 调整设置窗口大小 ---
ipcMain.handle('resize-settings-window', async (event, { width, height }) => {
  try {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      const [currentWidth, currentHeight] = settingsWindow.getSize()
      const newWidth = width || currentWidth
      const newHeight = height || currentHeight

      const finalWidth = Math.max(newWidth, 750)
      const finalHeight = Math.max(newHeight, 600)

      settingsWindow.setSize(finalWidth, finalHeight)
      return { success: true }
    }
    return { success: false, error: '设置窗口不存在' }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// 配置落盘：save-print-settings 与 load 时修复写回共用同一路径，保证写入格式一致
async function writeSettingsFile(settings) {
  const settingsDir = path.dirname(settingsPath)
  await fs.promises.mkdir(settingsDir, { recursive: true })
  await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
}

// 安全读取 Settings.json（文件不存在/解析失败返回 {}），供合并写回使用
async function readSettingsFileSafe() {
  try {
    const data = await fs.promises.readFile(settingsPath, 'utf-8')
    const parsed = JSON.parse(data)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

// --- 打印设置加载与保存 ---
ipcMain.handle('save-print-settings', async (event, settings) => {
  try {
    console.log('保存打印设置:', settings)
    // read-modify-write：合并而非整体覆盖，避免清掉其它子配置（如 excelExport.columns）
    const existing = await readSettingsFileSafe()
    const merged = { ...existing, ...settings }
    await writeSettingsFile(merged)
    // ✅ 立即通知主窗口设置已变化（尤其是 mergeMode）
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('settings-changed', merged)
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// 配置层边界校验（V16 架构职责）：PaperSpec 是 Fact，进入 Render DAG 前必须合法。
// 非法边距（如 marginLeft=210mm > A5 纸宽 148mm）曾导致 contentRect.w=0 → 预览静默卡死。
// 修正 Fact 属于配置层（margin-sanitizer），Derived 层 computePaperLayout 只标记无效、不修正。
const { sanitizeMargins, resolvePaperDims } = require('./shared/margin-sanitizer')
let _warnedInvalidMargins = false
ipcMain.handle('load-print-settings', async () => {
  try {
    const data = await fs.promises.readFile(settingsPath, 'utf-8')
    const parsed = JSON.parse(data)
    if (parsed && typeof parsed === 'object') {
      const { settings, changed, original } = sanitizeMargins(parsed)
      if (changed) {
        // 配置迁移：把修复后的合法 Fact 永久写回磁盘，避免每次启动重复 sanitize/warn。
        // 写回后下次启动读取到的就是合法文件，changed=false，warn 自然不再出现（写一次、warn 一次）。
        try {
          await writeSettingsFile(settings)
        } catch (e) {
          console.error('[V16] Failed to persist recovered print settings:', e)
        }
        if (!_warnedInvalidMargins) {
          _warnedInvalidMargins = true
          const dims = resolvePaperDims(settings)
          console.warn(
            '[V16 WARN] Recovered invalid margins in Settings.json (paper=' + dims.widthMM + 'x' + dims.heightMM + 'mm) and rewrote file with sanitized values.\n' +
            '  Original:  left=' + original.marginLeft + ' right=' + original.marginRight + ' top=' + original.marginTop + ' bottom=' + original.marginBottom + '\n' +
            '  Sanitized: left=' + settings.marginLeft + ' right=' + settings.marginRight + ' top=' + settings.marginTop + ' bottom=' + settings.marginBottom + '\n' +
            '  This warning should not reappear on next launch.'
          )
        }
      }
      return settings
    }
    return parsed
  } catch (error) {
    return {}
  }
})

// ============================
// Excel 导出字段选择持久化（Commit 4B）
// 挂在 Settings.json.excelExport.columns 下（string[]）。read-modify-write 避免覆盖打印等其它子配置。
// ============================
ipcMain.handle('save-excel-export-columns', async (event, columns) => {
  try {
    if (!Array.isArray(columns)) return { success: false, error: 'columns must be an array' }
    const existing = await readSettingsFileSafe()
    existing.excelExport = { ...(existing.excelExport || {}), columns }
    await writeSettingsFile(existing)
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('load-excel-export-columns', async () => {
  try {
    const existing = await readSettingsFileSafe()
    if (existing.excelExport && Array.isArray(existing.excelExport.columns)) {
      return existing.excelExport.columns
    }
    return null
  } catch (error) {
    return null
  }
})

// ============================
// 文档方向 Fact 持久化（Commit C）：per doc_id 的纸张方向 + 内容旋转
// 落盘到 userData/DocFacts.json（map: factKey -> {requestedPaperOrientation, contentRotation}）
// factKey = docId(内容哈希) || path(图片落盘路径)
// "自动" = 持久层无该 factKey 记录。
// 🔧 2026-08-09 产品决策：旋转/纸张方向**不跨重启保留**——
//   app.whenReady() 启动时清空本文件（见上方 BOOT 段），每次启动从 auto 推导开始；
//   本 IPC 仅服务**会话内**（切换文件恢复 / L2 缓存键一致）。
// ============================
const docFactsPath = path.join(app.getPath('userData'), 'DocFacts.json')

async function readDocFacts() {
  try {
    const data = await fs.promises.readFile(docFactsPath, 'utf-8')
    const parsed = JSON.parse(data)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

async function writeDocFacts(map) {
  const dir = path.dirname(docFactsPath)
  await fs.promises.mkdir(dir, { recursive: true })
  await fs.promises.writeFile(docFactsPath, JSON.stringify(map, null, 2), 'utf-8')
}

function normalizeDocRotation(deg) {
  const r = Math.round(Number(deg) || 0) % 360
  return r < 0 ? r + 360 : r
}

ipcMain.handle('load-doc-facts', async (event, factKey) => {
  if (!factKey) return null
  const map = await readDocFacts()
  const rec = map[factKey]
  if (!rec) return null
  return {
    requestedPaperOrientation: (rec.requestedPaperOrientation ?? rec.paperOrientation) === 'landscape' ? 'landscape' : 'portrait',
    contentRotation: normalizeDocRotation(rec.contentRotation || 0),
  }
})

ipcMain.handle('save-doc-facts', async (event, factKey, facts) => {
  if (!factKey || !facts) return { success: false, error: 'invalid args' }
  const map = await readDocFacts()
  map[factKey] = {
    requestedPaperOrientation: (facts.requestedPaperOrientation ?? facts.paperOrientation) === 'landscape' ? 'landscape' : 'portrait',
    contentRotation: normalizeDocRotation(facts.contentRotation || 0),
  }
  await writeDocFacts(map)
  return { success: true }
})

ipcMain.handle('clear-doc-facts', async (event, factKey) => {
  if (!factKey) return { success: false, error: 'invalid args' }
  const map = await readDocFacts()
  if (factKey in map) delete map[factKey]
  await writeDocFacts(map)
  return { success: true }
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
// 导出文件夹选择对话框（PDF 导出用）
// ============================
ipcMain.handle('select-export-folder', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择导出文件夹',
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths?.length) {
      return { canceled: true }
    }
    return { canceled: false, folderPath: result.filePaths[0] }
  } catch (error) {
    console.error('[main.js] select-export-folder error:', error)
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

    // R4-P0-8-B：受控诊断开关。FAPAIAO_CONSOLE_REDIRECT=1 时把 console.* 双写到
    // %APPDATA%\FapiaoGO\logs\（现场抓打印链）。正式 Release 默认不启用。
    if (process.env.FAPAIAO_CONSOLE_REDIRECT === '1') {
      logger.redirectConsole()
    }

    // 🔧 产品决策（2026-08-09）：旋转 / 纸张方向选择不跨重启保留。
    // 启动时清空 DocFacts.json（旋转/纸张方向持久层），每次启动从 auto 推导开始
    // （contentRotation=0, requestedPaperOrientation=文档自然方向）。
    // 会话内旋转/方向仍有效（内存 fileRotations 驱动展示区），重启后回到默认。
    // ENOENT（首次启动无文件）静默忽略；其余失败仅告警不阻塞启动。
    try {
      await fs.promises.unlink(docFactsPath)
      console.log('[BOOT] DocFacts.json cleared: rotation/orientation not persisted across restarts')
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[BOOT] clear DocFacts.json failed:', err.message)
    }

    // 预热 Python 环境检测（移至 app ready 后）：fire-and-forget，不阻塞窗口创建
    pdfMargin.checkPythonEnv().catch(() => {})

    // 初始化新打印管线（同步，轻量）
    initNewPrintPipeline()

    // ── 启动窗口：立即创建，不等后端/磁盘扫描就绪 ──
    // 生产模式下 spawn Python Flask 后端、扫描临时目录清理孤儿文件、加载用户纸张配置等操作
    // 均在窗口创建后于后台异步执行，消除启动白屏等待。前端首屏不依赖 Flask API（设置/打印机均走 IPC），
    // 后端在用户首次触发导入/预览前（通常1-2秒后）必然就绪。
    createWindow()

    // ── 以下为非关键初始化，全部后台异步执行，不阻塞窗口显示 ──
    // 轻量启动：仅创建临时目录 + 启动清理定时器；孤儿文件扫描延后到窗口显示后
    void initTempManager().catch((err) => {
      console.error('[BOOT] initTempManager failed:', err.message)
    })

    // 异步预缓存 7z / WinRAR 路径（不阻塞主进程）
    void initArchivePaths().catch(() => {})

    // 加载配置 + 初始化自动更新（可能触发网络检查，延后）
    const config = loadConfig()
    setTimeout(() => {
      try {
        initUpdateManager(config)
      } catch (err) {
        console.error('[BOOT] initUpdateManager failed:', err.message)
      }
    }, 500)

    // 纸张注册表（加载用户自定义纸张）— 带 system-only fallback，延后无害
    setTimeout(() => {
      const { PaperRegistryProvider } = require('./shared/PaperRegistryProvider')
      PaperRegistryProvider.initialize().catch((err) => {
        console.error('[BOOT] PaperRegistryProvider initialization failed:', err.message)
      })
    }, 300)

    // 启动 Flask 后端（生产模式下 spawn Python + 等待 /health 就绪；开发模式 no-op）
    // 后端就绪前用户的 API 调用会自然失败重试；后端通常 1-2 秒内启动完成
    void startBackendServer().catch((err) => {
      console.error('[BOOT] 后端启动失败（窗口已显示，功能将在后端就绪后可用）:', err.message)
    })

    app.on('before-quit', () => {
      // ✅ 停止后端 Flask 进程
      stopBackendServer()
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
