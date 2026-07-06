import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * 自动保存提示组件
 * 当有设置变更并保存后，显示"✓ 已自动保存"的提示，2秒后自动消失
 * 
 * @param {boolean} visible - 是否显示提示
 * @param {function} onHidden - 隐藏后的回调（可选）
 */
export default function AutoSaveToast({ visible, onHidden }) {
  const [shouldRender, setShouldRender] = useState(false)
  const [isAnimatingOut, setIsAnimatingOut] = useState(false)
  const isDark = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark'

  useEffect(() => {
    if (visible) {
      setShouldRender(true)
      setIsAnimatingOut(false)
      
      // 1.5秒后开始淡出动画
      const timer1 = setTimeout(() => {
        setIsAnimatingOut(true)
      }, 1500)
      
      // 2秒后完全隐藏
      const timer2 = setTimeout(() => {
        setShouldRender(false)
        setIsAnimatingOut(false)
        if (onHidden) onHidden()
      }, 2000)
      
      return () => {
        clearTimeout(timer1)
        clearTimeout(timer2)
      }
    }
  }, [visible, onHidden])

  if (!shouldRender) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '24px',
        left: '50%',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 18px',
        background: isDark ? 'rgba(30, 32, 44, 0.85)' : 'rgba(255, 255, 255, 0.85)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderRadius: 'var(--r-md)',
        border: isDark ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid rgba(255, 255, 255, 0.5)',
        boxShadow: isDark
          ? '0 4px 20px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(255, 255, 255, 0.03)'
          : '0 4px 20px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.02)',
        fontSize: '13px',
        color: 'var(--text-2)',
        zIndex: 1000,
        opacity: isAnimatingOut ? 0 : 1,
        transform: `translateX(-50%) ${isAnimatingOut ? 'translateY(8px)' : 'translateY(0)'}`,
        transition: 'opacity 0.3s ease, transform 0.3s ease',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {/* 绿色对勾图标 */}
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
      >
        <circle cx="12" cy="12" r="10" fill="#10b981" />
        <path
          d="M7 12.5L10.5 16L17 8.5"
          stroke="white"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      
      <span style={{ fontWeight: 500 }}>已自动保存</span>
    </div>
  )
}

/**
 * 自定义 Hook：用于触发自动保存提示
 * 返回一个 [visible, trigger, onHidden] 元组
 * - visible: 是否显示提示
 * - trigger: 触发保存提示的函数
 * - onHidden: 隐藏后的回调函数
 */
export function useAutoSaveToast() {
  const [visible, setVisible] = useState(false)
  const lastTriggerTime = useRef(0)
  
  const trigger = useCallback(() => {
    const now = Date.now()
    // 防抖：500ms 内只触发一次
    if (now - lastTriggerTime.current < 500) return
    lastTriggerTime.current = now
    
    // 先隐藏再显示，确保动画重新触发
    setVisible(false)
    requestAnimationFrame(() => {
      setVisible(true)
    })
  }, [])
  
  const onHidden = useCallback(() => {
    setVisible(false)
  }, [])
  
  return { visible, trigger, onHidden }
}
