// preload.js
const { contextBridge, ipcRenderer, webUtils } = require('electron')

// IPC 通道白名单（精确匹配 — 仅保留前缀匹配无法覆盖的通道）
const ALLOWED_SEND = ['open-settings-window', 'close-settings-window', 'window-minimize', 'window-maximize', 'window-close', 'window-drag-start', 'window-drag-move', 'window-drag-end', 'settings-changed']
const ALLOWED_INVOKE = [
  // 前缀匹配无法覆盖的精确通道写在这里
  // 大部分已被 ALLOWED_INVOKE_PREFIXES 覆盖，无需重复
]

// IPC 通道前缀白名单（前缀匹配）
// 添加新 IPC handler 时只需确保 channel 名以某个前缀开头即可，无需手动加精确匹配
// 安全模型：所有 IPC handler 由主进程 ipcMain.handle() 注册，预加载仅做第一道防线
const ALLOWED_INVOKE_PREFIXES = [
  'print-',    // print-source-file, print-file-direct, print-merged-images
  'preview-',  // preview-rename-names
  'get-',      // get-printers, get-file-stats, get-printer-capabilities
  'load-',     // load-print-settings
  'save-',     // save-print-settings
  'rename-',   // rename-invoices
  'pack-',     // pack-invoices
  'generate-', // generate-print-pdf
  'open-',     // open-file-dialog, open-folder-dialog
  'select-',   // select-folder, select-save-path
  'window-',   // window-is-maximized
  'resize-',   // resize-settings-window
  'scan-',     // scan-dropped-paths
  'read-',     // read-file
  'submit-',   // submit-print-job
]

const ALLOWED_ON = ['print-progress', 'settings-window-closed', 'context-menu-files', 'rename-progress', 'pack-progress', 'excel-progress', 'settings-changed', 'print-job-completed', 'print-job-failed']

/** 检查通道是否允许（精确匹配或前缀匹配） */
function isAllowedInvoke(channel) {
  if (ALLOWED_INVOKE.includes(channel)) return true
  return ALLOWED_INVOKE_PREFIXES.some(prefix => channel.startsWith(prefix))
}

contextBridge.exposeInMainWorld('electronAPI', {
  // 核心：使用 webUtils 获取真实路径
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch (e) {
      console.error('[preload] getFilePath error:', e)
      return ''
    }
  },

  // 打印 API（新管线）
  submitPrintJob: (payload) => {
    return ipcRenderer.invoke('submit-print-job', payload)
  },

  // Canvas → PDF → Print
  generatePdfFromCanvas: (canvasBuffer, paperSize, orientation, customPaper) => {
    return ipcRenderer.invoke('generate-print-pdf', { canvasBuffer, paperSize, orientation, customPaper })
  },

  ipcRenderer: {
    send: (channel, data) => {
      if (ALLOWED_SEND.includes(channel)) {
        ipcRenderer.send(channel, data)
      } else {
        console.warn(`[preload] Blocked send to unallowed channel: ${channel}`)
      }
    },
    on: (channel, func) => {
      if (ALLOWED_ON.includes(channel)) {
        ipcRenderer.on(channel, (event, ...args) => func(event, ...args))
      } else {
        console.warn(`[preload] Blocked on unallowed channel: ${channel}`)
      }
    },
    invoke: (channel, ...args) => {
      if (isAllowedInvoke(channel)) {
        return ipcRenderer.invoke(channel, ...args)
      } else {
        console.warn(`[preload] Blocked invoke to unallowed channel: ${channel}`)
        return Promise.reject(new Error(`Channel not allowed: ${channel}`))
      }
    },
    removeListener: (channel, func) => {
      ipcRenderer.removeListener(channel, func)
    }
  },

  // 窗口控制 API
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  },

  // 进程内存信息（用于调试 Task Manager 内存增长）
  getProcessMemoryInfo: () => process.getProcessMemoryInfo(),

  // 版本信息（用于验证 Electron 版本）
  getVersions: () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }),
})
