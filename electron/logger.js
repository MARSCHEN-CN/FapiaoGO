// electron/logger.js
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const originalLog = console.log
const originalError = console.error
const originalWarn = console.warn

// 设置控制台编码为 UTF-8 (Windows)
try {
  if (process.platform === 'win32') {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore' })
  }
  if (process.stdout.isTTY) {
    process.stdout.setEncoding('utf8')
  }
} catch (e) {}

// 日志保留天数
const LOG_RETENTION_DAYS = 7

// 定时批量 flush 间隔（毫秒）
const FLUSH_INTERVAL_MS = 500
// 缓冲区达到该行数立即冲刷，避免内存无限增长
const FLUSH_THRESHOLD_LINES = 100

const LEVEL_RANK = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }

class Logger {
  constructor() {
    this.logFile = null
    this.enabled = true
    this.writeStream = null   // 常驻写入流，保持 fd 打开，避免每次 open-write-close
    this.buffer = []          // 内存写入缓冲
    this.flushTimer = null    // 定时 flush 定时器
    this.minLevel = this._resolveMinLevel()
  }

  // 生产环境默认收敛到 INFO，减少主线程文件 I/O；开发环境保留全部。
  // 可通过环境变量 MARSPRINT_LOG_LEVEL 覆盖（DEBUG/INFO/WARN/ERROR）。
  _resolveMinLevel() {
    const env = process.env.MARSPRINT_LOG_LEVEL
    if (env && LEVEL_RANK[env.toUpperCase()] !== undefined) {
      return env.toUpperCase()
    }
    if (process.env.NODE_ENV === 'production') return 'INFO'
    return 'DEBUG'
  }

  init() {
    if (this.logFile) return

    try {
      // 使用项目根目录下的 database/logs 文件夹
      // __dirname 是 electron 目录的绝对路径
      // 向上一级到达项目根目录
      let appRootPath = path.normalize(__dirname)
      appRootPath = path.join(appRootPath, '..')
      appRootPath = path.normalize(appRootPath)

      const logDir = path.join(appRootPath, 'database', 'logs')
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true })
      }

      // 清理旧日志
      this.cleanOldLogs(logDir)

      const date = new Date().toISOString().split('T')[0]
      this.logFile = path.join(logDir, `app-${date}.log`)

      // 常驻写入流：保持文件描述符打开，写入走 libuv 线程池（异步），
      // 不再每次 console.log 都同步 open-write-close 阻塞主线程。
      this.writeStream = fs.createWriteStream(this.logFile, { flags: 'a', encoding: 'utf8' })
      this.writeStream.on('error', (e) => {
        // 写入流异常不抛出，避免拖垮主流程；降级为同步写
        try {
          originalError('[Logger] 写入流错误:', e.message)
        } catch (_) {}
      })

      // 冲刷 init 之前已累积的缓冲
      this._flush()

      // 定时批量 flush，作为兜底保证日志不会长期滞留内存
      if (!this.flushTimer) {
        this.flushTimer = setInterval(() => this._flush(), FLUSH_INTERVAL_MS)
        if (this.flushTimer.unref) this.flushTimer.unref()
      }
    } catch (e) {
      originalError('[Logger] 初始化失败:', e.message)
    }
  }

  cleanOldLogs(logDir) {
    try {
      const files = fs.readdirSync(logDir)
      const now = Date.now()
      const retentionMs = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000

      let deletedCount = 0
      files.forEach(file => {
        const match = file.match(/^app-(\d{4})-(\d{2})-(\d{2})\.log$/)
        if (match) {
          const [, year, month, day] = match
          const fileDate = new Date(year, month - 1, day).getTime()
          if (now - fileDate > retentionMs) {
            const filePath = path.join(logDir, file)
            fs.unlinkSync(filePath)
            deletedCount++
          }
        }
      })

      if (deletedCount > 0) {
        originalLog(`[Logger] 清理了 ${deletedCount} 个过期日志文件`)
      }
    } catch (e) {
      originalError('[Logger] 清理旧日志失败:', e.message)
    }
  }

  formatArgs(args) {
    return args.map(arg => {
      if (arg instanceof Error) return arg.stack || arg.message
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2)
        } catch (e) {
          return String(arg)
        }
      }
      return String(arg)
    }).join(' ')
  }

  writeToFile(level, message) {
    if (!this.enabled) return
    // 日志级别过滤：生产环境默认丢弃 DEBUG，降低 I/O 量
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return

    try {
      const timestamp = new Date().toISOString()
      const logLine = `[${timestamp}] [${level}] ${message}\n`
      this.buffer.push(logLine)
      // 缓冲区积压较多时立即冲刷，避免内存无限增长
      if (this.buffer.length >= FLUSH_THRESHOLD_LINES) this._flush()
    } catch (e) {
      // 缓冲失败不影响主流程
      originalError('[Logger] 写入缓冲失败:', e.message)
    }
  }

  // 将内存缓冲异步写入常驻流；流未就绪时保留缓冲待 init 后冲刷
  _flush() {
    if (!this.buffer.length) return
    if (!this.writeStream || this.writeStream.destroyed) return
    const chunk = this.buffer.join('')
    this.buffer.length = 0
    // write 是异步的，背压时 libuv 内部缓存，无需额外处理
    this.writeStream.write(chunk)
  }

  // 强制落盘（应用退出前由 main.js 的 before-quit 调用）。
  // 退出场景用同步写兜底，确保缓冲全部落盘，不依赖异步流排空。
  flush() {
    if (this.buffer.length && this.logFile) {
      try {
        fs.appendFileSync(this.logFile, this.buffer.join(''), 'utf8')
      } catch (e) {
        try { originalError('[Logger] 退出冲刷失败:', e.message) } catch (_) {}
      }
      this.buffer.length = 0
    }
    if (this.writeStream && !this.writeStream.destroyed) {
      try { this.writeStream.end() } catch (_) {}
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  log(...args) {
    const message = this.formatArgs(args)

    // 输出到控制台
    if (process.platform === 'win32') {
      try {
        process.stdout.write(message + '\n')
      } catch (e) {
        originalLog.apply(console, args)
      }
    } else {
      originalLog.apply(console, args)
    }

    // 写入文件
    this.writeToFile('INFO', message)
  }

  error(...args) {
    const message = this.formatArgs(args)
    originalError.apply(console, args)
    this.writeToFile('ERROR', message)
  }

  warn(...args) {
    const message = this.formatArgs(args)
    originalWarn.apply(console, args)
    this.writeToFile('WARN', message)
  }

  info(...args) {
    this.log(...args)
  }

  debug(...args) {
    if (process.env.DEBUG) {
      const message = this.formatArgs(args)
      originalLog.apply(console, args)
      this.writeToFile('DEBUG', message)
    }
  }
}

const logger = new Logger()

// 不污染全局 console，导出 logger 实例
module.exports = logger