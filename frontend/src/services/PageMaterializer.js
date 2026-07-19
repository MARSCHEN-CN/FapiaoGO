import { BACKEND_URL } from '../config'
import { materializedFileStore } from './MaterializedFileStore'

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
  const file = new File([blob], `${descriptor.id}.pdf`, { type: 'application/pdf' })

  return materializedFileStore.acquire(sessionId, descriptor.id, file)
}

export function releaseMaterializedFile(handle) {
  materializedFileStore.release(handle)
}

export function cleanupSessionMaterialization(sessionId) {
  materializedFileStore.cleanup(sessionId)
}