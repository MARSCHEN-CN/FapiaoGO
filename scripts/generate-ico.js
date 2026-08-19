/**
 * PNG → ICO 转换器
 * 将 app.png 转换为 Windows .ico 格式
 * 4 个尺寸条目（16/32/48/256）均指向同一份大图，由 Windows 自动缩放
 *
 * 用法：node scripts/generate-ico.js
 * 输出：resources/icon.ico
 */

const fs = require('fs')
const path = require('path')

function createIco(pngPath, outputPath) {
  const pngData = fs.readFileSync(pngPath)
  const entrySize = 16
  const numImages = 4
  const sizes = [16, 32, 48, 256]

  // ICO header (6 bytes)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)   // reserved
  header.writeUInt16LE(1, 2)   // type: 1 = icon
  header.writeUInt16LE(numImages, 4)

  // 所有条目共享同一份 PNG 数据
  const dataOffset = 6 + entrySize * numImages
  const entries = Buffer.alloc(entrySize * numImages)

  for (let i = 0; i < numImages; i++) {
    const size = sizes[i]
    const entry = Buffer.alloc(entrySize)
    entry.writeUInt8(size === 256 ? 0 : size, 0) // width (0 = 256)
    entry.writeUInt8(size === 256 ? 0 : size, 1) // height
    entry.writeUInt8(0, 2)                         // color count
    entry.writeUInt8(0, 3)                         // reserved
    entry.writeUInt16LE(1, 4)                      // color planes
    entry.writeUInt16LE(32, 6)                     // bits per pixel
    entry.writeUInt32LE(pngData.length, 8)         // image data size
    entry.writeUInt32LE(dataOffset, 12)            // image data offset (same for all)
    entries.set(entry, i * entrySize)
  }

  const finalIco = Buffer.concat([header, entries, pngData])

  const outDir = path.dirname(outputPath)
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(outputPath, finalIco)
  console.log(`[ICO] 已生成: ${outputPath} (${finalIco.length} bytes)`)
  console.log(`[ICO] 包含尺寸: ${sizes.join(', ')}`)
}

const inputPng = path.resolve(__dirname, '..', 'frontend', 'public', 'icon', 'app.png')
const outputIco = path.resolve(__dirname, '..', 'resources', 'icon.ico')
console.log(`[ICO] 输入: ${inputPng}`)
createIco(inputPng, outputIco)