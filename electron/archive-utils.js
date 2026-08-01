'use strict'

const fs = require('fs')
const path = require('path')
const { execSync, execFile, execFileSync } = require('child_process')
const { TEMP_DIR } = require('./temp-manager')
const { formatCurrentDate } = require('./constants')
const { ZipArchive } = require('archiver')

// 已压缩/本身就是容器的文件扩展名 → ZIP 打包时不压缩（STORE），避免二次压缩浪费 CPU
// PDF/图片/OFD/Office 文档/压缩包 等内部已压缩，ZIP deflate 只会浪费时间且几乎无体积收益
const INCOMPRESSIBLE_EXTS = new Set([
  '.pdf', '.ofd',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.heic', '.heif',
  '.zip', '.7z', '.rar', '.cab', '.gz', '.bz2', '.xz',
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv',
  '.jar', '.apk', '.epub',
])

function isCompressible(filename) {
  const ext = path.extname(filename || '').toLowerCase()
  return !INCOMPRESSIBLE_EXTS.has(ext)
}

/**
 * 根据当前时间和设置生成压缩包文件名
 * @param {string} prefix - 自定义内容/前缀
 * @param {string} dateFormat - 日期格式（'none' 表示不加日期）
 * @param {string} archiveFormat - 压缩格式 (ZIP/RAR/7Z)
 * @param {string[]} fieldOrder - 字段顺序，如 ['prefix', 'date']
 * @param {string} separator - 字段间分隔符，默认 '_'
 * @returns {string}
 */
function generateArchiveName(prefix, dateFormat, archiveFormat, fieldOrder, separator) {
  const dateStr = dateFormat === 'none' ? '' : formatCurrentDate(dateFormat)
  const sep = (typeof separator === 'string') ? separator : '_'

  const ext = archiveFormat === 'RAR' ? '.rar' : archiveFormat === '7Z' ? '.7z' : '.zip'

  const order = fieldOrder && fieldOrder.length ? fieldOrder : ['prefix', 'date']
  const parts = order.map(type => {
    if (type === 'prefix') return prefix && prefix.trim() !== '' ? prefix : ''
    if (type === 'date') return dateStr
    return ''
  }).filter(Boolean)

  return parts.join(parts.length > 1 ? sep : '') + ext
}

/**
 * 处理压缩包内的文件名冲突（同步，无IO，纯内存计算）
 * @param {Array} files - [{ originalPath, targetName }]
 * @returns {Array} files with finalName
 */
function resolveArchiveFileNames(files) {
  const usedNames = new Set()
  const resolved = []
  for (const file of files) {
    let finalName = file.targetName
    let counter = 1
    const ext = path.extname(finalName)
    const baseName = path.basename(finalName, ext)
    while (usedNames.has(finalName)) {
      finalName = `${baseName}_${counter}${ext}`
      counter++
    }
    usedNames.add(finalName)
    resolved.push({ ...file, finalName })
  }
  return resolved
}

/**
 * 创建 ZIP 压缩包
 * 性能优化：
 *   1. 对 PDF/图片/Office 等已压缩格式使用 STORE（不压缩，直接打包），速度接近文件系统拷贝
 *   2. 流式写入，高水位线 1MB 平衡背压与吞吐
 *   3. 使用同步 stat 校验源文件存在，避免异步竞态
 *   4. 双重完成判定：同时监听 archive finalize 和 output close，确保异常场景下也能正确完成
 * @param {Array} files - [{ originalPath, targetName }]
 * @param {string} archivePath - 输出路径
 */
async function createZipArchive(files, archivePath) {
  return new Promise((resolve, reject) => {
    let anyCompressible = false
    for (const f of files) {
      if (isCompressible(f.targetName)) { anyCompressible = true; break }
    }

    let settled = false
    const settle = (err) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }

    const output = fs.createWriteStream(archivePath, { highWaterMark: 1024 * 1024 })
    const archive = new ZipArchive({
      zlib: { level: anyCompressible ? 1 : 0 },
      forceZip64: false,
    })

    let archiveFinalized = false
    let outputClosed = false

    const checkComplete = () => {
      if (archiveFinalized && outputClosed) settle(null)
    }

    output.on('close', () => {
      outputClosed = true
      checkComplete()
    })
    output.on('error', (err) => settle(err))

    archive.on('error', (err) => settle(err))
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn('[pack] archiver warning:', err)
      } else {
        settle(err)
      }
    })

    archive.on('finalize', () => {
      archiveFinalized = true
      checkComplete()
    })

    archive.pipe(output)

    const resolved = resolveArchiveFileNames(files)
    for (const file of resolved) {
      try {
        const st = fs.statSync(file.originalPath)
        if (!st.isFile()) continue
      } catch {
        continue
      }
      const compressionMethod = isCompressible(file.finalName) ? 'DEFLATE' : 'STORE'
      archive.file(file.originalPath, {
        name: file.finalName,
        compression: compressionMethod === 'STORE' ? 0 : 8,
        forceZip64: false,
      })
    }

    archive.finalize()
  })
}

// 7z 路径缓存
let _7zPathCache = undefined
function find7zPath() {
  if (_7zPathCache !== undefined) return _7zPathCache

  const commonPaths = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', '7-Zip', '7z.exe'),
  ]

  for (const p of commonPaths) {
    try {
      if (fs.existsSync(p)) {
        _7zPathCache = p
        return _7zPathCache
      }
    } catch {}
  }

  try {
    const result = execFileSync('where.exe', ['7z'], { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const first = result.split(/\r?\n/)[0].trim()
    if (first && fs.existsSync(first)) {
      _7zPathCache = first
      return _7zPathCache
    }
  } catch (e) {}

  _7zPathCache = null
  return _7zPathCache
}

let _rarPathCache = undefined

/**
 * 硬链接优先 → 回退拷贝
 * 硬链接是文件系统级元数据操作（O(1)），零数据拷贝，比 copyFileSync 快数个量级
 */
function linkOrCopy(src, dest) {
  try {
    fs.linkSync(src, dest)
  } catch (err) {
    if (err.code === 'EXDEV' || err.code === 'EPERM' || err.code === 'EACCES') {
      fs.copyFileSync(src, dest)
    } else {
      throw err
    }
  }
}

/**
 * 用 7z 创建压缩包
 * 优化：
 *   1. 硬链接临时目录（零数据拷贝）
 *   2. -mx=1 最快压缩（PDF/图片等本身已压缩，mx=1 实际为 STORE 等价快速路径）
 *   3. -mmt=on 多线程
 *   4. -ms=off 关闭固实模式（加快速度，牺牲一点压缩率）
 */
async function createArchiveWith7z(files, archivePath, sevenZipPath) {
  const tempDir = path.join(TEMP_DIR, `mars_pack_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`)
  fs.mkdirSync(tempDir, { recursive: true })

  try {
    const resolved = resolveArchiveFileNames(files)
    for (const file of resolved) {
      const destPath = path.join(tempDir, file.finalName)
      const destDir = path.dirname(destPath)
      if (destDir !== tempDir) {
        fs.mkdirSync(destDir, { recursive: true })
      }
      linkOrCopy(file.originalPath, destPath)
    }

    await new Promise((resolve, reject) => {
      const args = ['a', '-t7z', '-mx=1', '-mmt=on', '-ms=off', '-y', archivePath, '*']
      const child = execFile(sevenZipPath, args, {
        cwd: tempDir,
        timeout: 300000,
        maxBuffer: 1024 * 1024,
      }, (error) => {
        if (error) {
          reject(new Error(`7z 创建失败: ${error.message}`))
        } else {
          resolve()
        }
      })
      child.stderr && child.stderr.on('data', () => {})
    })
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (e) {}
  }
}

function findWinRarPath() {
  if (_rarPathCache !== undefined) return _rarPathCache

  const commonPaths = [
    'C:\\Program Files\\WinRAR\\rar.exe',
    'C:\\Program Files (x86)\\WinRAR\\rar.exe',
    path.join(process.env.LOCALAPPDATA || '', 'WinRAR', 'rar.exe'),
  ]
  for (const p of commonPaths) {
    try {
      if (fs.existsSync(p)) {
        _rarPathCache = p
        return _rarPathCache
      }
    } catch {}
  }

  try {
    const result = execFileSync('where.exe', ['rar'], { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const first = result.split(/\r?\n/)[0].trim()
    if (first && fs.existsSync(first)) {
      _rarPathCache = first
      return _rarPathCache
    }
  } catch (e) {}

  _rarPathCache = null
  return _rarPathCache
}

/**
 * 用 WinRAR 创建 RAR 压缩包
 * -m1 最快压缩
 */
async function createRarWithWinRAR(files, archivePath, rarPath) {
  const tempDir = path.join(TEMP_DIR, `mars_pack_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`)
  fs.mkdirSync(tempDir, { recursive: true })

  try {
    const resolved = resolveArchiveFileNames(files)
    for (const file of resolved) {
      const destPath = path.join(tempDir, file.finalName)
      const destDir = path.dirname(destPath)
      if (destDir !== tempDir) {
        fs.mkdirSync(destDir, { recursive: true })
      }
      linkOrCopy(file.originalPath, destPath)
    }

    await new Promise((resolve, reject) => {
      const args = ['a', '-m1', '-y', archivePath, '*']
      execFile(rarPath, args, {
        cwd: tempDir,
        timeout: 300000,
        maxBuffer: 1024 * 1024,
      }, (error) => {
        if (error) {
          reject(new Error(`WinRAR 创建失败: ${error.message}`))
        } else {
          resolve()
        }
      })
    })
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch (e) {}
  }
}

module.exports = {
  generateArchiveName,
  createZipArchive,
  find7zPath,
  createArchiveWith7z,
  findWinRarPath,
  createRarWithWinRAR,
}
