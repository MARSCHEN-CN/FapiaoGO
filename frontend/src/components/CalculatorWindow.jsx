import { useCallback } from 'react'
import { getElectronAPI } from '../utils'
import CalculatorModal from './CalculatorModal'

/**
 * 计算器独立窗口
 * - 无模态遮罩，直接渲染计算器面板
 * - 带窗口标题栏（最小化/关闭）
 */
export default function CalculatorWindow() {
  const electronAPI = getElectronAPI()

  const handleMinimize = useCallback(() => {
    electronAPI?.window?.minimize?.()
  }, [electronAPI])

  const handleClose = useCallback(() => {
    electronAPI?.window?.close?.()
  }, [electronAPI])

  return (
    <div className="calc-window-root">
      {/* 标题栏 */}
      <div className="calc-titlebar">
        <div className="calc-titlebar-left">
          <svg viewBox="0 0 1024 1024">
            <path d="M383.98 512.13h-63.92v63.92h63.92v-63.92z"/>
            <path d="M97.93 98.23V928.3H928V98.23H97.93zM864 255.95h-63.82v-93.73H864v93.73z m-191.85 0v-93.73h63.98v93.73h-63.98z m-64.05-93.72v93.73H161.93v-93.73H608.1zM161.93 864.29V320H864v544.3H161.93z"/>
            <path d="M256.05 448.21h192.04v63.92H256.05zM576.38 448.64h192.04v63.92H576.38zM576.38 678.52h192.04v63.92H576.38zM391.87 619.98l-45.3 45.3-45.29-45.3-45.2 45.2 45.3 45.3-45.3 45.29 45.2 45.2 45.29-45.3 45.3 45.3 45.2-45.2-45.3-45.29 45.3-45.3zM320.06 384.1h63.92v63.92h-63.92zM649.83 623.89h45.14v45.14h-45.14zM649.83 751.92h45.14v45.14h-45.14z"/>
          </svg>
          <span className="calc-titlebar-name">计算器</span>
        </div>
        <div className="calc-titlebar-controls">
          <button className="calc-titlebar-btn" onClick={handleMinimize} title="最小化">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
          <button className="calc-titlebar-btn calc-titlebar-close" onClick={handleClose} title="关闭">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18"/>
              <line x1="6" y1="18" x2="18" y2="6"/>
            </svg>
          </button>
        </div>
      </div>

      {/* 计算器主体 */}
      <div className="calc-window-body">
        <CalculatorModal embedded onClose={handleClose} />
      </div>
    </div>
  )
}
