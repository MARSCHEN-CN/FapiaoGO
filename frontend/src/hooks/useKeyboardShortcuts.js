import { useEffect, useRef } from 'react'

/**
 * 键盘快捷键 Hook
 * @param {Object} options
 * @param {Function} options.onPrevFile - 上一个文件
 * @param {Function} options.onNextFile - 下一个文件
 * @param {Function} options.onPrint - 批量打印
 * @param {Function} options.onDelete - 删除选中文件
 * @param {Function} options.onEscape - 取消选择/关闭弹窗
 * @param {boolean} options.enabled - 是否启用快捷键
 * @param {boolean} options.allowInInput - 是否允许在输入框中触发
 */
export function useKeyboardShortcuts({
  onPrevFile,
  onNextFile,
  onPrint,
  onDelete,
  onEscape,
  enabled = true,
  allowInInput = false,
}) {
  // ── 使用 ref 持有最新回调，避免频繁重新注册事件监听器 ──
  const callbacksRef = useRef({
    onPrevFile,
    onNextFile,
    onPrint,
    onDelete,
    onEscape,
  })

  // 每次渲染时更新 ref，确保读取到最新回调
  callbacksRef.current = {
    onPrevFile,
    onNextFile,
    onPrint,
    onDelete,
    onEscape,
  }

  // 仅在 enabled 或 allowInInput 变化时重新注册监听器
  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (e) => {
      // 如果在输入框内且不允许触发，则跳过
      const target = e.target
      const isInputField = target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable

      if (isInputField && !allowInInput) {
        return
      }

      // 从 ref 获取最新回调
      const { onPrevFile, onNextFile, onPrint, onDelete, onEscape } = callbacksRef.current

      // Ctrl+P: 打印
      if (e.ctrlKey && e.key === 'p') {
        e.preventDefault()
        onPrint?.()
        return
      }

      // Delete: 删除选中文件
      if (e.key === 'Delete' && !isInputField) {
        e.preventDefault()
        onDelete?.()
        return
      }

      // Backspace: 删除选中文件 (macOS 风格)
      if (e.key === 'Backspace' && !isInputField) {
        e.preventDefault()
        onDelete?.()
        return
      }

      // Escape: 取消选择/关闭弹窗
      if (e.key === 'Escape') {
        e.preventDefault()
        onEscape?.()
        return
      }

      // 左右箭头: 切换文件
      if (e.key === 'ArrowLeft' && !isInputField) {
        e.preventDefault()
        onPrevFile?.()
        return
      }
      if (e.key === 'ArrowRight' && !isInputField) {
        e.preventDefault()
        onNextFile?.()
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, allowInInput])
}

/**
 * 快捷键配置说明
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    键盘快捷键一览表                          │
 * ├──────────────┬────────────┬─────────────────────────────────┤
 * │ 功能         │ 快捷键     │ 说明                            │
 * ├──────────────┼────────────┼─────────────────────────────────┤
 * │ 打印         │ Ctrl+P    │ 批量打印选中文件                 │
 * │ 删除         │ Delete    │ 删除选中的文件                   │
 * │ 上一个       │ ← 左箭头  │ 切换到上一个文件                 │
 * │ 下一个       │ → 右箭头  │ 切换到下一个文件                 │
 * │ 取消         │ Escape    │ 取消选择或关闭弹窗              │
 * └──────────────┴────────────┴─────────────────────────────────┘
 */
