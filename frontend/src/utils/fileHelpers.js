/**
 * 文件对象构建与多页 PDF 处理
 */
import { BACKEND_URL } from '../config'
import { getFileFormat, buildSearchText } from '../utils'
import { stripIdentity, resolveIdentity } from './identity'

/**
 * 生成唯一的文件 key
 * 使用 crypto.randomUUID() 避免在 React StrictMode 双渲染场景下的冲突
 */
export function generateFileKey(name) {
  return `${name}_${Date.now()}_${crypto.randomUUID()}`
}

// 构建文件对象
// instanceId（IS-4.2 Phase 2 Step 1，producer-only）：文档实例身份。
//   - 单文件（图片/OFD/单页 PDF）：默认取 key（导入实例唯一）。
//   - 多页 PDF：由 processPdfFile 传入拆分时生成的共享 UUID，使同一次导入的
//     所有拆分页归属同一业务文档实例。
//   与 key（页面/UI 实例身份）、docId（内容哈希 = Render Identity）三者分离：
//   同内容 A/B 导入 → docId 相同、instanceId 不同 → 不再被误并为一个 Document。
export function buildFileObj(file, name, path, previewImage = null, docId = null, pageNum = null, contentHash = null, instanceId = null) {
  const key = generateFileKey(name)
  // Stage 4.1.3：注入统一身份出口（Identity Contract v1.1）。
  // 纯透传 docId/contentHash/pageNum；哈希计算权属 backend registry，前端不计算。
  // 无 docId 文件得到 partial identity（docId:'' / sourceHash:''），属允许状态。
  const identity = resolveIdentity({ key, docId, contentHash, pageNum })
  return {
    key,
    name,
    path,
    file,
    status: 'parsing',
    invoiceType: '',
    invoiceNumber: '',
    amount: '',
    invoiceDate: '',
    newName: '',
    parseMethod: '',
    fileFormat: getFileFormat(name),
    previewImage: previewImage ? `data:image/jpeg;base64,${previewImage}` : null,
    printPath: path,
    docId: docId || null,
    // IS-4.2：文档实例身份。单文件默认 = key；多页 PDF 由 processPdfFile 传入共享 UUID。
    // Step 1 仅生产、暂不消费；消费端迁移（DocumentStore/addDocument/PRS）在后续步骤接入。
    instanceId: instanceId || key,
    // 多页 PDF 拆页后，每个分页项携带其在原文档中的真实页码。
    // 预览 URL 必须用它而非硬编码 1，否则所有分页都显示第 1 页（串线）。
    pageNum: pageNum || null,
    identity,
    // 预计算 searchText，确保所有文件（含未解析或解析失败的）都能快速搜索
    searchText: buildSearchText({ name }),
    // ── V2: InvoiceDocument 多页支持 ──
    pageCount: 1,
    pages: [{ index: 0, previewUrl: null, width: 0, height: 0, rotation: 0 }],
    currentPage: 0,
  }
}

// stripIdentity 定义见 ./identity（零依赖，可独立单测）
export { stripIdentity }

// 每批处理的页数上限，防止大 PDF 导致内存溢出
const PDF_PAGES_BATCH_SIZE = 10

// ── Step 5F-1：pdfjs 预检 PDF 页数（单页跳过 /split_pdf）──
// 懒加载 pdfjs-dist（与 usePreview 同策略，避免首屏加载 1.4MB）。
// 只取 numPages，不 getPage 不 render（页数判断的最小成本）。
// workerSrc 由 renderers.js 模块顶层全局设置（pdf.worker.min.mjs）；兜底 Vite new URL。
let _pdfjsPromise = null
async function getPdfPageCount(file) {
  const pdfjsLib = await (_pdfjsPromise ||= import('pdfjs-dist'))
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString()
  }
  const data = file instanceof Blob ? await file.arrayBuffer() : file
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const count = pdf.numPages
  try { pdf.destroy() } catch (_) { /* 释放失败不阻塞 */ }
  return count
}

// 处理多页 PDF 拆分
export async function processPdfFile(file, getPathFn) {
  const toAdd = []
  const toParse = []

  try {
    // ── Step 5F-1：单页 PDF 跳过 /split_pdf（消除 131× 往返结构性浪费 ≈9s）──
    // 预检失败（损坏/异常 PDF）时回退 /split_pdf（后端 fitz 兜底，行为不变）。
    let pageCount = null
    try {
      pageCount = await getPdfPageCount(file.file || file)
    } catch (err) {
      console.warn(`[App] pdfjs 页数预检失败（回退 /split_pdf）: ${file.name}`, err)
    }
    if (pageCount !== null && pageCount <= 1) {
      console.log(`[App] PDF ${file.name} 单页（${pageCount}），跳过 split 直接处理`)
      const fileObj = buildFileObj(file.file || file, file.name, getPathFn(file))
      toAdd.push(fileObj)
      toParse.push(fileObj)
      return { toAdd, toParse, isMultiPage: false }
    }
    // 多页或预检失败 → 走 /split_pdf（现有逻辑；TEMP(V17) guard 保留作防御）
    const formData = new FormData()
    formData.append('file', file.file || file)
    const resp = await fetch(`${BACKEND_URL}/split_pdf`, { method: 'POST', body: formData })
    const data = await resp.json()

    if (data.success && data.pages) {
      const pages = data.pages
      const totalPages = pages.length
      console.log(`[App] 检测到 PDF: ${file.name}, ${totalPages} 页`)

      // TEMP(V17): Guard against single-page PDFs entering the split pipeline.
      // The long-term fix is to move the pageCount decision to the import
      // dispatcher so processPdfFile() only handles multi-page PDFs.
      // When upstream dispatcher is in place, change this to assert(totalPages > 1).
      if (totalPages <= 1) {
        console.log(`[App] PDF ${file.name} 仅 ${totalPages} 页，无需拆分，按原文件处理`)
        const fileObj = buildFileObj(file.file || file, file.name, getPathFn(file))
        toAdd.push(fileObj)
        toParse.push(fileObj)
        return { toAdd, toParse, isMultiPage: false }
      }

      // IS-4.2：本次导入的共享文档实例身份。多页 PDF 的所有拆分页共享同一 instanceId，
      // 使后端 assembly / 前端 DocumentStore 按实例（而非内容哈希）归组——
      // 同内容 A.pdf/B.pdf 得到不同 instanceId，不再被误并为一个 Document。
      const instanceId = crypto.randomUUID()

      for (let i = 0; i < totalPages; i += PDF_PAGES_BATCH_SIZE) {
        const batch = pages.slice(i, i + PDF_PAGES_BATCH_SIZE)
        console.log(`[App] 处理 PDF 批次: ${i + 1}-${Math.min(i + batch.length, totalPages)} / ${totalPages}`)

        for (const page of batch) {
          const binaryStr = atob(page.page_bytes)
          const bytes = new Uint8Array(binaryStr.length)
          for (let j = 0; j < binaryStr.length; j++) {
            bytes[j] = binaryStr.charCodeAt(j)
          }
          const blob = new Blob([bytes], { type: 'application/pdf' })
          const pageName = file.name.replace('.pdf', `_p${page.page_index}.pdf`)
          const pageFile = new File([blob], pageName, { type: 'application/pdf' })

          const fileObj = buildFileObj(pageFile, pageName, getPathFn(file), null, data.doc_id, page.page_index, null, instanceId)
          // [Identity Bridge] 透传父 PDF 物理身份，供批量导入路径携带 source_doc_id，
          // 使后端 assembly 能将同票多页归入同一 doc（修复同票多页被拆成独立发票）。
          if (data.doc_id) {
            fileObj.sourceDocId = data.doc_id
            fileObj.totalPages = totalPages
          }
          toAdd.push(fileObj)
          toParse.push(fileObj)
        }

        // 每批处理完后让出事件循环，避免阻塞 UI
        if (i + PDF_PAGES_BATCH_SIZE < totalPages) {
          await new Promise(resolve => setTimeout(resolve, 0))
        }
      }
      return { toAdd, toParse, isMultiPage: true }
    }
  } catch (err) {
    console.error('[App] PDF 拆分失败:', err)
  }

  // 拆分失败或非 PDF
  const fileObj = buildFileObj(file.file || file, file.name, getPathFn(file))
  toAdd.push(fileObj)
  toParse.push(fileObj)
  return { toAdd, toParse, isMultiPage: false }
}
