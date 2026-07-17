/**
 * 文件对象构建与多页 PDF 处理
 */
import { BACKEND_URL } from '../config'
import { getFileFormat, buildSearchText } from '../utils'
import { stripIdentity } from './identity'

/**
 * 生成唯一的文件 key
 * 使用 crypto.randomUUID() 避免在 React StrictMode 双渲染场景下的冲突
 */
export function generateFileKey(name) {
  return `${name}_${Date.now()}_${crypto.randomUUID()}`
}

// 构建文件对象
export function buildFileObj(file, name, path, previewImage = null, docId = null, pageNum = null) {
  return {
    key: generateFileKey(name),
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
    // 多页 PDF 拆页后，每个分页项携带其在原文档中的真实页码。
    // 预览 URL 必须用它而非硬编码 1，否则所有分页都显示第 1 页（串线）。
    pageNum: pageNum || null,
    // 预计算 searchText，确保所有文件（含未解析或解析失败的）都能快速搜索
    searchText: buildSearchText({ name }),
  }
}

// stripIdentity 定义见 ./identity（零依赖，可独立单测）
export { stripIdentity }

// 每批处理的页数上限，防止大 PDF 导致内存溢出
const PDF_PAGES_BATCH_SIZE = 10

// 处理多页 PDF 拆分
export async function processPdfFile(file, getPathFn) {
  const toAdd = []
  const toParse = []

  try {
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

          const fileObj = buildFileObj(pageFile, pageName, getPathFn(file), page.preview_image, data.doc_id, page.page_index)
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
