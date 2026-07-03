// 修复 ipc-print.js：将 pngToPdf 中的 contain 逻辑恢复为原始填满模式
const fs = require('fs')
const filePath = 'D:\\marsprint\\print605\\electron\\ipc-print.js'
let content = fs.readFileSync(filePath, 'utf8')

// 方案：找到 pngToPdf 函数内 contain 逻辑的起始注释行，
// 删除从该行到 `const contentLen` 之前的所有行，
// 插入原始的一行 contentCmd。
const lines = content.split('\n')
const newLines = []
let inPngToPdf = false
let skipContainLogic = false
let inserted = false

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]

  // 检测 pngToPdf 函数开始
  if (line.includes('function pngToPdf')) {
    inPngToPdf = true
  }

  // 在 pngToPdf 函数内，找到 contain 逻辑的开始（注释行）
  if (inPngToPdf && line.includes('内容流') && line.includes('contain')) {
    // 跳过整个 contain 逻辑块
    skipContainLogic = true
    // 插入原始版本（填满模式）
    newLines.push('  // ✅ 内容流：缩放图片填满整个页面')
    newLines.push('  const contentCmd = `q ${pageW} 0 0 ${pageH} 0 0 cm /Img Do Q`')
    inserted = true
    continue
  }

  // 如果正在跳过 contain 逻辑，检查是否到达 `const contentLen =`
  if (skipContainLogic) {
    if (line.includes('const contentLen = ')) {
      // 保留这一行（contentLen），停止跳过
      newLines.push(line)
      skipContainLogic = false
      continue
    }
    // 否则跳过此行（contain 逻辑的中间行）
    continue
  }

  // 正常保留此行
  newLines.push(line)
}

if (!inserted) {
  console.log('⚠️ 未找到 contain 逻辑，可能已修复或格式变化')
} else {
  const newContent = newLines.join('\n')
  fs.writeFileSync(filePath, newContent, 'utf8')
  console.log('✅ 替换完成：pngToPdf 恢复为原始填满模式')
}
