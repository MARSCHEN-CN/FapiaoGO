'use strict'

const fs = require('fs')
const path = require('path')
const { execSync, execFile } = require('child_process')
const { TEMP_DIR } = require('./temp-manager')
const { formatCurrentDate } = require('./constants')
// ✅ archiver 移至模块顶部：避免在 createZipArchive 每次调用时重复 require（已确认 ZipArchive 为合法命名导出）
const { ZipArchive } = require('archiver')

/**
 * 根据当前时间和设置生成压缩包文件名
 * @param {string} prefix - 自定义内容/前缀
 * @param {string} dateFormat - 日期格式
 * @param {string} archiveFormat - 压缩格式 (ZIP/RAR/7Z)
 * @param {string[]} fieldOrder - 字段顺序，如 ['prefix', 'date'] 或 ['date', 'prefix']
 * @returns {string}
 */
function generateArchiveName(prefix, dateFormat, archiveFormat, fieldOrder) {
  const dateStr = formatCurrentDate(dateFormat)

  const ext = archiveFormat === 'RAR' ? '.rar' : archiveFormat === '7Z' ? '.7z' : '.zip'

  // 根据 fieldOrder 决定顺序
  const order = fieldOrder || ['prefix', 'date']
  const parts = order.map(type => {
    if (type === 'prefix') return prefix && prefix.trim() !== '' ? prefix : ''
    if (type === 'date') return dateStr
    return ''
  }).filter(Boolean)

  // 只有一个字段时不使用分隔符
  const sep = parts.length > 1 ? '_' : ''
  return parts.join(sep) + ext
}

/**
 * 处理压缩包内的文件名冲突
 * @param {Array} files - [{ originalPath, targetName }]
 * @param {Function} nameExtractor - 从 file 对象获取 targetName 的函数
 * @returns {Map} usedNames Set + 最终名称列表
 */
function resolveArchiveFileNames(files) {
  const usedNames = new Set()
  const resolved = []

  for (const file of files) {
    let targetName = file.targetName
    let finalName = targetName
    let counter = 1
    const ext = path.extname(targetName)
    const baseName = path.basename(targetName, ext)
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
 * @param {Array} files - [{ originalPath, targetName }]
 * @param {string} archivePath - 输出路径
 */
async function createZipArchive(files, archivePath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(archivePath)
    const archive = new ZipArchive()

    output.on('close', () => {
      console.log(`[pack] ZIP 创建完成: ${archivePath} (${archive.pointer()} bytes)`)
      resolve()
    })

    archive.on('error', (err) => reject(err))
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn('[pack] archiver warning:', err)
      } else {
        reject(err)
      }
    })

    archive.pipe(output)

    const resolved = resolveArchiveFileNames(files)
    for (const file of resolved) {
      archive.file(file.originalPath, { name: file.finalName })
    }

    archive.finalize()
  })
}

/**
 * 查找系统中的 7z 命令行工具路径
 * ✅ 结果模块级缓存：避免每次打包都同步 execSync('where 7z') 阻塞主线程；
 *    7-Zip 安装状态在会话内不会变化，缓存安全（含「未找到」结果）。
 * @returns {string|null}
 */
let _7zPathCache = undefined // undefined=未探测；string|null=已探测结果
function find7zPath() {
  if (_7zPathCache !== undefined) return _7zPathCache

  // 常见安装路径
  const commonPaths = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', '7-Zip', '7z.exe'),
  ]

  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      _7zPathCache = p
      return _7zPathCache
    }
  }

  // 尝试 PATH 中查找：用 execFileSync 直接调 where.exe，避免 execSync 额外拉起 shell
  try {
    const result = execFileSync('where.exe', ['7z'], { encoding: 'utf-8', timeout: 3000 }).trim()
    const first = result.split('\n')[0].trim()
    if (first && fs.existsSync(first)) {
      _7zPathCache = first
      return _7zPathCache
    }
  } catch (e) {}

  _7zPathCache = null
  return _7zPathCache
}

/**
 * 用硬链接代替整文件拷贝：打包前不再把 PDF 数据冗余复制到临时目录（硬链接仅复制元数据，O(1)），
 * 归档结构（finalName 等）与原拷贝方案完全一致。跨文件系统（EXDEV）或权限不足（EPERM/EACCES）
 * 时自动回退到 copyFileSync，行为不退化。
 * @param {string} src - 源文件路径
 * @param {string} dest - 临时目录中的目标路径（即归档内文件名）
 */
function linkOrCopy(src, dest) {
  try {
    fs.linkSync(src, dest)
  } catch (err) {
    if (err.code === 'EXDEV' || err.code === 'EPERM' || err.code === 'EACCES') {
      fs.copyFileSync(src, dest) // 回退：跨盘或权限受限时仍拷贝
    } else {
      throw err
    }
  }
}

/**
 * 使用 7z 命令行工具创建 7Z 压缩包
 * @param {Array} files - [{ originalPath, targetName }]
 * @param {string} archivePath - 输出路径
 * @param {string} sevenZipPath - 7z 可执行文件路径
 */
async function createArchiveWith7z(files, archivePath, sevenZipPath) {
  // 先将文件以硬链接方式放入临时目录（零数据拷贝），再打包
  // 统一到 temp-manager 受管根目录（TEMP_DIR），纳入其孤儿/定时/启动清理，
  // 避免崩溃时 os.tmpdir() 下的临时目录永久泄漏。本函数 finally 的显式清理仍保留为快路径。
  const tempDir = path.join(TEMP_DIR, `mars_pack_${Date.now()}`)
  await fs.promises.mkdir(tempDir, { recursive: true })

  try {
    const resolved = resolveArchiveFileNames(files)
    for (const file of resolved) {
      const destPath = path.join(tempDir, file.finalName)
      linkOrCopy(file.originalPath, destPath)
    }

    await new Promise((resolve, reject) => {
      const args = ['a', '-t7z', '-mx=5', archivePath, '*']
      execFile(sevenZipPath, args, {
        cwd: tempDir,
        timeout: 120000,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`7z 创建失败: ${error.message}`))
        } else {
          resolve()
        }
      })
    })
  } finally {
    // 清理临时目录
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true })
    } catch (e) {}
  }
}

/**
 * 查找 WinRAR 路径
 * @returns {string|null}
 */
function findWinRarPath() {
  const commonPaths = [
    'C:\\Program Files\\WinRAR\\rar.exe',
    'C:\\Program Files (x86)\\WinRAR\\rar.exe',
  ]
  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * 使用 WinRAR 创建 RAR 压缩包
 * @param {Array} files - [{ originalPath, targetName }]
 * @param {string} archivePath - 输出路径
 * @param {string} rarPath - rar 可执行文件路径
 */
async function createRarWithWinRAR(files, archivePath, rarPath) {
  // 统一到 temp-manager 受管根目录（TEMP_DIR），纳入其孤儿/定时/启动清理，
  // 避免崩溃时 os.tmpdir() 下的临时目录永久泄漏。本函数 finally 的显式清理仍保留为快路径。
  const tempDir = path.join(TEMP_DIR, `mars_pack_${Date.now()}`)
  await fs.promises.mkdir(tempDir, { recursive: true })

  try {
    const resolved = resolveArchiveFileNames(files)
    for (const file of resolved) {
      const destPath = path.join(tempDir, file.finalName)
      linkOrCopy(file.originalPath, destPath)
    }

    await new Promise((resolve, reject) => {
      const args = ['a', '-m3', archivePath, '*']
      execFile(rarPath, args, {
        cwd: tempDir,
        timeout: 120000,
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`WinRAR 创建失败: ${error.message}`))
        } else {
          resolve()
        }
      })
    })
  } finally {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true })
    } catch (e) {}
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
