// P0 PoC: pdfjs + OffscreenCanvas 在 Worker 中的可行性验证
import * as pdfjsLib from 'pdfjs-dist'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// ⚠️ Worker 内无法创建嵌套 Worker（浏览器安全策略限制），
// pdfjs 自动降级为 fake worker（同线程模拟解析），不影响功能
// 显式赋值让 pdfjs 别反复重试
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker

self.onmessage = async (e) => {
  const { pdfData, pageNum = 1, scale = 300 / 72 } = e.data

  try {
    // 1. 加载 PDF
    // disableFontFace: Worker 中 FontFace API 不可用，pdfjs 用自己的字体解析器渲染
    // cMapUrl/standardFontDataUrl: 用绝对路径确保 Worker 中 fetch 正确
    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(pdfData),
      disableFontFace: true,
      cMapUrl: '/cmaps/',
      standardFontDataUrl: '/standard_fonts/',
    }).promise
    const page = await pdf.getPage(pageNum)

    // 2. 计算 viewport
    const viewport = page.getViewport({ scale })

    // 3. OffscreenCanvas 渲染
    const canvas = new OffscreenCanvas(viewport.width, viewport.height)
    const ctx = canvas.getContext('2d')

    await page.render({ canvasContext: ctx, viewport }).promise

    // 4. 零拷贝传出
    const bitmap = canvas.transferToImageBitmap()
    self.postMessage({ ok: true, bitmap, width: viewport.width, height: viewport.height }, [bitmap])

  } catch (err) {
    self.postMessage({ ok: false, error: err.message, stack: err.stack })
  }
}

// 通知主线程 Worker 已就绪（pdfjs 加载完成）
self.postMessage({ type: 'ready' })
