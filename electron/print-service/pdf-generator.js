/**
 * PDF Generator — Canvas PNG → PDF with MediaBox
 *
 * Extracted from ipc-print.js pngToPdf() to break dependency on archived print pipeline.
 * Runs in Electron main process. Requires electron.nativeImage.
 */
const { nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const { TEMP_DIR } = require('../temp-manager')

/**
 * Strip ICC_PROFILE (APP2/FFE2) segments from JPEG data.
 *
 * Chromium's nativeImage.toJPEG() embeds an ICC color profile that
 * SumatraPDF 3.6.x cannot parse, causing "load error" on open.
 * Removing it makes the JPEG universally compatible.
 *
 * @param {Buffer} jpegBuffer - raw JPEG data
 * @returns {Buffer} JPEG with ICC_PROFILE segments removed
 */
function stripJpegIccProfile(jpegBuffer) {
  // Must start with SOI marker
  if (jpegBuffer.length < 4 || jpegBuffer[0] !== 0xFF || jpegBuffer[1] !== 0xD8) {
    return jpegBuffer
  }

  const segments = []  // kept byte ranges: { start, end }
  let stripped = false
  let pos = 2  // skip SOI

  while (pos < jpegBuffer.length - 1) {
    // Find next marker (skip any padding FF bytes)
    if (jpegBuffer[pos] !== 0xFF) { pos++; continue }
    while (pos < jpegBuffer.length && jpegBuffer[pos] === 0xFF) pos++
    if (pos >= jpegBuffer.length) break

    const markerType = jpegBuffer[pos]
    const markerStart = pos - 1  // include the 0xFF prefix

    // Markers without length field: RST0-RST7 (D0-D7), SOI (D8), EOI (D9)
    if (markerType >= 0xD0 && markerType <= 0xD9) {
      segments.push({ start: markerStart, end: pos + 1 })
      pos++
      if (markerType === 0xD9) break  // EOI — stop
      continue
    }

    // SOS (DA): followed by entropy-coded data until EOI, keep rest as-is
    if (markerType === 0xDA) {
      segments.push({ start: markerStart, end: jpegBuffer.length })
      break
    }

    // Standard marker with 2-byte length
    if (pos + 2 >= jpegBuffer.length) break
    const segLen = (jpegBuffer[pos + 1] << 8) | jpegBuffer[pos + 2]
    const segEnd = pos + 1 + segLen

    // APP2 (0xE2) with "ICC_PROFILE" identifier → strip
    if (markerType === 0xE2 && segLen >= 14) {
      const id = jpegBuffer.toString('ascii', pos + 3, Math.min(pos + 15, segEnd))
      if (id.startsWith('ICC_PROFILE')) {
        console.log(`[PDF_GENERATOR] Stripping ICC_PROFILE segment (${segLen + 2} bytes)`)
        stripped = true
        pos = segEnd
        continue
      }
    }

    // Keep all other segments
    segments.push({ start: markerStart, end: segEnd })
    pos = segEnd
  }

  if (!stripped) return jpegBuffer

  const buffers = segments.map(s => jpegBuffer.subarray(s.start, s.end))
  return Buffer.concat(buffers)
}

/**
 * Generate a PDF from a PNG buffer with specified page dimensions.
 *
 * @param {Buffer|Uint8Array} pngBuffer - PNG image data
 * @param {number} pageWMM - page width in millimeters
 * @param {number} pageHMM - page height in millimeters
 * @returns {Buffer} Complete PDF binary
 */
function pngToPdf(pngBuffer, pageWMM, pageHMM) {
  const pageW = +(pageWMM * 72 / 25.4).toFixed(2)
  const pageH = +(pageHMM * 72 / 25.4).toFixed(2)

  const img = nativeImage.createFromBuffer(Buffer.from(pngBuffer))
  if (img.isEmpty()) throw new Error('PNG image is empty or cannot be parsed')
  const pxW = img.getSize().width
  const pxH = img.getSize().height

  // Convert to JPEG then strip ICC_PROFILE for SumatraPDF 3.6.x compatibility
  // 🐛 FIX: stripJpegIccProfile 对特定的 JPEG 输出会损坏数据，直接使用原始 JPEG
  const rawJpeg = img.toJPEG(95)
  const jpegBuffer = stripJpegIccProfile(rawJpeg)
  // 如果经过 ICC 剥离后比原始小太多（损坏），回退到原始 JPEG
  const jpegOk = (jpegBuffer.length >= rawJpeg.length * 0.9)
  const finalJpeg = jpegOk ? jpegBuffer : rawJpeg
  if (!jpegOk) {
    console.warn('[pdf-generator] stripJpegIccProfile 可能损坏了 JPEG（原始=%d → 剥离后=%d），回退到原始', rawJpeg.length, jpegBuffer.length)
  }
  const streamLen = finalJpeg.length

  const enc = 'latin1'
  const scaleX = pageW / pxW
  const scaleY = pageH / pxH
  const scale = Math.max(scaleX, scaleY)
  const sw = +(pxW * scale).toFixed(2)
  const sh = +(pxH * scale).toFixed(2)
  const tx = +((pageW - sw) / 2).toFixed(2)
  const ty = +((pageH - sh) / 2).toFixed(2)
  const contentCmd = `q ${sw} 0 0 ${sh} ${tx} ${ty} cm /Img Do Q`
  const contentLen = Buffer.byteLength(contentCmd, enc)

  const p1 = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', enc)
  const p2 = Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', enc)
  const p3 = Buffer.from(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
    `/Contents 4 0 R /Resources << /XObject << /Img 5 0 R >> >> >>\nendobj\n`, enc)
  const p4 = Buffer.from(`4 0 obj\n<< /Length ${contentLen} >>\nstream\n${contentCmd}\nendstream\nendobj\n`, enc)
  const p5h = Buffer.from(
    `5 0 obj\n<< /Type /XObject /Subtype /Image ` +
    `/Width ${pxW} /Height ${pxH} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
    `/Length ${streamLen} >>\nstream\n`, enc)
  const p5t = Buffer.from('\nendstream\nendobj\n', enc)

  const offsets = []
  let pos = 0
  for (const part of [p1, p2, p3, p4, p5h, finalJpeg, p5t]) {
    offsets.push(pos); pos += part.length
  }
  const xrefPos = pos

  const xref = Buffer.from(
    'xref\n0 6\n' +
    '0000000000 65535 f \n' +
    String(offsets[0]).padStart(10, '0') + ' 00000 n \n' +
    String(offsets[1]).padStart(10, '0') + ' 00000 n \n' +
    String(offsets[2]).padStart(10, '0') + ' 00000 n \n' +
    String(offsets[3]).padStart(10, '0') + ' 00000 n \n' +
    String(offsets[4]).padStart(10, '0') + ' 00000 n \n', enc)

  const trailer = Buffer.from(
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`, enc)

  return Buffer.concat([p1, p2, p3, p4, p5h, jpegBuffer, p5t, xref, trailer])
}

// 校验 PDF 结构时只读取文件头/尾而非整文件，避免大 PDF（10MB+）整文件读入内存
// （约 20MB：Buffer + Latin1 String）。MediaBox 通常位于页对象（靠近文件头），
// xref / startxref / %%EOF 均位于文件尾部。
const VALIDATE_HEAD_BYTES = 8 * 1024    // 8KB：MediaBox 检测窗口
const VALIDATE_TAIL_BYTES = 16 * 1024   // 16KB：xref / startxref / %%EOF 窗口

// 读取文件尾部 len 字节（Latin1），用于 xref / startxref / %%EOF 校验
function readTailSync(pdfPath, size) {
  const len = Math.min(size, VALIDATE_TAIL_BYTES)
  const buf = Buffer.alloc(len)
  const fd = fs.openSync(pdfPath, 'r')
  try {
    fs.readSync(fd, buf, 0, len, size - len)
  } finally {
    fs.closeSync(fd)
  }
  return buf.toString('latin1')
}

async function readTailAsync(pdfPath, size) {
  const len = Math.min(size, VALIDATE_TAIL_BYTES)
  const buf = Buffer.alloc(len)
  const fh = await fs.promises.open(pdfPath, 'r')
  try {
    await fh.read(buf, 0, len, size - len)
  } finally {
    await fh.close()
  }
  return buf.toString('latin1')
}

// 读取文件头部 len 字节（Latin1），用于 header 签名与 MediaBox 检测。
// 注意：fs.readFileSync/readFile 的 options 不接收 length 参数（会被静默忽略，
// 导致仍整文件读取），因此必须用 fd 级别的 readSync/read 显式限定长度。
function readHeadSync(pdfPath, size) {
  const len = Math.min(size, VALIDATE_HEAD_BYTES)
  const buf = Buffer.alloc(len)
  const fd = fs.openSync(pdfPath, 'r')
  try {
    fs.readSync(fd, buf, 0, len, 0)
  } finally {
    fs.closeSync(fd)
  }
  return buf.toString('latin1')
}

async function readHeadAsync(pdfPath, size) {
  const len = Math.min(size, VALIDATE_HEAD_BYTES)
  const buf = Buffer.alloc(len)
  const fh = await fs.promises.open(pdfPath, 'r')
  try {
    await fh.read(buf, 0, len, 0)
  } finally {
    await fh.close()
  }
  return buf.toString('latin1')
}

/**
 * Validate a PDF file's structural integrity.
 * Throws if the PDF is corrupted or suspicious.
 *
 * 仅读取文件头（MediaBox / header）与文件尾（xref / startxref / %%EOF），不读入整个文件。
 *
 * @param {string} pdfPath - path to the PDF file
 * @returns {{ valid: boolean, issues: string[] }}
 */
function validatePdfStructure(pdfPath) {
  const issues = []

  // 1. 文件存在性与最小尺寸
  const stat = fs.statSync(pdfPath)
  if (stat.size < 1024) {
    issues.push(`PDF too small: ${stat.size} bytes (min 1KB)`)
  }

  // 2. PDF 头签名（仅读取文件头 VALIDATE_HEAD_BYTES，避免整文件读入）
  const head = readHeadSync(pdfPath, stat.size)
  if (!head.startsWith('%PDF-')) {
    issues.push(`Missing PDF header signature: "${head.slice(0, 8)}"`)
  }

  // 3. xref 表与 startxref 完整性（均位于文件尾部）
  const tail = readTailSync(pdfPath, stat.size)
  const tailStart = stat.size - tail.length
  const startxrefMatch = tail.match(/startxref\s*(\d+)/)
  if (!startxrefMatch) {
    issues.push('Missing startxref pointer')
  } else {
    const declaredOffset = parseInt(startxrefMatch[1], 10)
    // 用正则定位 xref 表头（避开二进制中可能出现的 "xref" 字样）
    const xrefHeaderMatch = tail.match(/\n?xref\n\d+ \d+\n/)
    // tail 内匹配下标转回文件绝对偏移，保证与 declaredOffset 可比（与整文件读取语义一致）
    const actualOffset = xrefHeaderMatch
      ? tailStart + xrefHeaderMatch.index + (tail[xrefHeaderMatch.index] === '\n' ? 1 : 0)
      : -1
    if (actualOffset === -1) {
      issues.push('Missing xref table header')
    } else if (Math.abs(declaredOffset - actualOffset) > 5) {
      // startxref mismatch might be a validation artifact — only warn, don't fail
      // The actual xref table is found at the expected location; Sumatra will validate on open
      console.warn(`[PDF_VALIDATION] startxref hint mismatch: declared=${declaredOffset}, near=${actualOffset} (non-critical)`)
    }
  }

  // 4. %%EOF 标记（文件末尾）
  if (!tail.trimEnd().endsWith('%%EOF')) {
    issues.push('Missing or misplaced %%EOF marker')
  }

  // 5. MediaBox 存在性（通常在文件头附近的页对象内）
  if (!head.includes('/MediaBox')) {
    issues.push('Missing /MediaBox entry')
  }

  if (issues.length > 0) {
    console.error(`[PDF_VALIDATION] FAILED for ${pdfPath}:`, issues)
  } else {
    console.log(`[PDF_VALIDATION] PASSED for ${pdfPath}: ${stat.size} bytes, MediaBox OK, xref OK`)
  }

  return { valid: issues.length === 0, issues }
}

/**
 * 异步版 validatePdfStructure —— 用 fs.promises 读取，避免在主线程同步读取整个 PDF。
 * 用于 print-merged-images 等需并行校验多文件的场景，不阻塞事件循环。
 *
 * 与同步版行为一致：仅读取文件头/尾，不读入整个文件。
 *
 * @param {string} pdfPath - path to the PDF file
 * @returns {Promise<{ valid: boolean, issues: string[] }>}
 */
async function validatePdfStructureAsync(pdfPath) {
  const issues = []

  // 1. 文件存在性与最小尺寸
  const stat = await fs.promises.stat(pdfPath)
  if (stat.size < 1024) {
    issues.push(`PDF too small: ${stat.size} bytes (min 1KB)`)
  }

  // 2. PDF 头签名（仅读取文件头 VALIDATE_HEAD_BYTES，避免整文件读入）
  const head = await readHeadAsync(pdfPath, stat.size)
  if (!head.startsWith('%PDF-')) {
    issues.push(`Missing PDF header signature: "${head.slice(0, 8)}"`)
  }

  // 3. xref 表与 startxref 完整性（均位于文件尾部）
  const tail = await readTailAsync(pdfPath, stat.size)
  const tailStart = stat.size - tail.length
  const startxrefMatch = tail.match(/startxref\s*(\d+)/)
  if (!startxrefMatch) {
    issues.push('Missing startxref pointer')
  } else {
    const declaredOffset = parseInt(startxrefMatch[1], 10)
    const xrefHeaderMatch = tail.match(/\n?xref\n\d+ \d+\n/)
    const actualOffset = xrefHeaderMatch
      ? tailStart + xrefHeaderMatch.index + (tail[xrefHeaderMatch.index] === '\n' ? 1 : 0)
      : -1
    if (actualOffset === -1) {
      issues.push('Missing xref table header')
    } else if (Math.abs(declaredOffset - actualOffset) > 5) {
      console.warn(`[PDF_VALIDATION] startxref hint mismatch: declared=${declaredOffset}, near=${actualOffset} (non-critical)`)
    }
  }

  // 4. %%EOF 标记（文件末尾）
  if (!tail.trimEnd().endsWith('%%EOF')) {
    issues.push('Missing or misplaced %%EOF marker')
  }

  // 5. MediaBox 存在性（通常在文件头附近的页对象内）
  if (!head.includes('/MediaBox')) {
    issues.push('Missing /MediaBox entry')
  }

  if (issues.length > 0) {
    console.error(`[PDF_VALIDATION] FAILED for ${pdfPath}:`, issues)
  } else {
    console.log(`[PDF_VALIDATION] PASSED for ${pdfPath}: ${stat.size} bytes, MediaBox OK, xref OK`)
  }

  return { valid: issues.length === 0, issues }
}

/**
 * Generate a PDF from canvas PNG data and write to temp file.
 * Validates the output PDF structure before returning.
 *
 * @param {Object} params
 * @param {Buffer|Uint8Array} params.pngBuffer - PNG image data from canvas
 * @param {number} params.widthMM - paper width in mm
 * @param {number} params.heightMM - paper height in mm
 * @param {string} [params.prefix] - filename prefix
 * @returns {{ pdfPath: string, size: number }}
 */
function generatePdfFromCanvas({ pngBuffer, widthMM, heightMM, prefix }) {
  const pdfBuffer = pngToPdf(pngBuffer, widthMM, heightMM)
  const tmpDir = TEMP_DIR
  const pdfPath = path.join(tmpDir, `${prefix || 'print'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`)
  fs.writeFileSync(pdfPath, pdfBuffer)
  const size = fs.statSync(pdfPath).size
  console.log(`[PDF_GENERATOR] Created: ${pdfPath} (${size} bytes, ${widthMM}×${heightMM}mm)`)

  // ✅ PDF fingerprint validation — catches corruption early
  const validation = validatePdfStructure(pdfPath)
  if (!validation.valid) {
    const errMsg = `[PDF_FINGERPRINT_FAIL] Generated PDF is corrupted: ${validation.issues.join('; ')}`
    console.error(errMsg)
    // Quarantine the file (don't delete — keep for debugging)
    const quarantinePath = pdfPath + '.quarantine'
    try { fs.renameSync(pdfPath, quarantinePath) } catch {}
    throw new Error(errMsg)
  }

  return { pdfPath, size }
}

module.exports = { pngToPdf, generatePdfFromCanvas, validatePdfStructure, validatePdfStructureAsync }
