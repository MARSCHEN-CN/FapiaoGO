import { useState, useCallback } from 'react'

/**
 * Alert 队列管理 Hook
 *
 * 集中管理弹窗队列的 enqueue/dequeue，替代 App 组件内内联的 alertQueue 状态。
 * 支持按 source 去重，防止同一来源重复弹窗。
 */
export function useAlertQueue() {
  const [alertQueue, setAlertQueue] = useState([])

  const currentAlert = alertQueue[0] || null

  const showAlert = useCallback((message, title = '提示', type = 'warning', onClose, source) => {
    setAlertQueue(prev => {
      if (prev.some(a => a.source === source)) return prev
      return [...prev, { id: Date.now(), message, title, type, onClose, source }]
    })
  }, [])

  const dismissAlert = useCallback(() => {
    setAlertQueue(prev => {
      const current = prev[0]
      if (current?.onClose) {
        // onClose 由调用方控制，这里只管理队列状态
      }
      return prev.slice(1)
    })
  }, [])

  const dismissWithCleanup = useCallback(() => {
    setAlertQueue(prev => {
      const [current, ...rest] = prev
      current?.onClose?.()
      return rest
    })
  }, [])

  return {
    currentAlert,
    alertQueue,
    showAlert,
    dismissAlert,
    dismissWithCleanup,
    setAlertQueue,
  }
}
