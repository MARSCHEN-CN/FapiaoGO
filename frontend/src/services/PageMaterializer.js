import { BACKEND_URL } from '../config'

export async function materializePage(descriptor, sessionId) {
  if (!descriptor || !descriptor.id) {
    throw new Error('PageDescriptor is required')
  }

  const resp = await fetch(
    `${BACKEND_URL}/split_pdf/page?page_id=${encodeURIComponent(descriptor.id)}`,
    {
      method: 'GET',
      headers: {
        'X-Import-Session-ID': sessionId || '',
      },
    }
  )

  if (!resp.ok) {
    if (resp.status === 400) {
      const error = await resp.json()
      throw new Error(error.error || '任务已取消')
    }
    throw new Error(`拉取页面失败: ${resp.status}`)
  }

  const blob = await resp.blob()
  return new File([blob], `${descriptor.id}.pdf`, { type: 'application/pdf' })
}