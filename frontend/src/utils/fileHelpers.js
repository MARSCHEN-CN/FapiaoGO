/**
 * 文件对象构建与多页 PDF 处理
 */
import { BACKEND_URL } from '../config'
import { getFileFormat, buildSearchText } from '../utils'

/**
 * 生成唯一的文件 key
 * 使用 crypto.randomUUID() 避免在 React StrictMode 双渲染场景下的冲突
 */
export function generateFileKey(name) {
  return `${name}_${Date.now()}_${crypto.randomUUID()}`
}

// 构建文件对象
export function buildFileObj(file, name, path, previewImage = null, docId = null) {
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
    // 预计算 searchText，确保所有文件（含未解析或解析失败的）都能快速搜索
    searchText: buildSearchText({ name }),
  }
}

// 身份字段集合：合并 buildFileObj() 产出到列表项时，这些字段必须由占位项决定，
// 不能被新对象的身份字段覆盖（否则后续 parse 更新会因找不到 key 而静默丢失，见 Blocker 2）。
// 若将来身份字段增多（id / uuid / internalId），只改这里一处即可。
const IDENTITY_FIELDS = ['key']
export function stripIdentity(fileObj) {
  if (!fileObj) return fileObj
  const rest = { ...fileObj }
  for (const f of IDENTITY_FIELDS) delete rest[f]
  return rest
}

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

          const fileObj = buildFileObj(pageFile, pageName, getPathFn(file), page.preview_image, data.doc_id)
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
