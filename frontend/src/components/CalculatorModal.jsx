import { useState, useRef, useEffect, useCallback, memo } from 'react'
import { amountToChinese } from '../utils/amountConverter'

/**
 * CalculatorModal — 计算器弹窗
 * 支持键盘输入、实时预览、中文大写金额、历史记录
 */
const CalculatorModal = memo(function CalculatorModal({ visible, onClose, embedded = false }) {
  const [expression, setExpression] = useState('')
  const [lastExpr, setLastExpr] = useState('')
  const [lastResult, setLastResult] = useState('')
  const [history, setHistory] = useState([]) // oldest first
  const [justEvaluated, setJustEvaluated] = useState(false)

  const exprElRef = useRef(null)
  const resultElRef = useRef(null)
  const chineseElRef = useRef(null)
  const historyElRef = useRef(null)
  const measurerRef = useRef(null)

  // Font size constants — 根据窗口宽度动态缩放，匹配 CSS 媒体查询
  // 基准：401-499px（2K 默认）；≤400px（1080p 紧凑）；≥500px（4K 大按钮）
  const getScale = (w) => w >= 500 ? 1.22 : w <= 400 ? 0.83 : 1
  const [fontScale, setFontScale] = useState(() => getScale(typeof window !== 'undefined' ? window.innerWidth : 420))
  useEffect(() => {
    const updateScale = () => setFontScale(getScale(window.innerWidth))
    window.addEventListener('resize', updateScale)
    return () => window.removeEventListener('resize', updateScale)
  }, [])
  const EXPR_MAX = Math.round(46 * fontScale), EXPR_MIN = 10
  const RES_MAX = Math.round(24 * fontScale), RES_MIN = 10
  const CHN_MAX = Math.round(15 * fontScale), CHN_MIN = 10
  const CHN_BOLD_MAX = Math.round(17 * fontScale)

  

  // ========== Number Formatting ==========
  const numberToString = useCallback((num) => {
    if (typeof num !== 'number' || isNaN(num)) return String(num)
    if (!isFinite(num)) return num > 0 ? '∞' : '-∞'
    if (num === 0) return '0'
    const str = String(num)
    if (str.indexOf('e') === -1 && str.indexOf('E') === -1) return str
    const match = str.match(/^(-?)(\d+(?:\.\d+)?)[eE]([+-]?\d+)$/)
    if (!match) return str
    const sign = match[1], mantissa = match[2].replace('.', ''), exponent = parseInt(match[3], 10)
    const decimalPos = match[2].indexOf('.')
    const totalDigits = mantissa.length
    let originalDecimalOffset = decimalPos === -1 ? totalDigits : decimalPos
    let newDecimalOffset = originalDecimalOffset + exponent
    let result
    if (newDecimalOffset <= 0) result = sign + '0.' + '0'.repeat(-newDecimalOffset) + mantissa
    else if (newDecimalOffset >= totalDigits) result = sign + mantissa + '0'.repeat(newDecimalOffset - totalDigits)
    else result = sign + mantissa.slice(0, newDecimalOffset) + '.' + mantissa.slice(newDecimalOffset)
    result = result.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    return result
  }, [])

  const formatNumber = useCallback((numStr) => {
    if (!numStr) return numStr
    if (numStr.indexOf('e') === -1 && numStr.indexOf('E') === -1) {
      const parts = numStr.split('.')
      const intPart = parts[0]
      let decPart = parts[1] || ''
      if (decPart.length > 10) decPart = decPart.slice(0, 10).replace(/0+$/, '')
      const sign = intPart.startsWith('-') ? '-' : ''
      const intAbs = sign ? intPart.slice(1) : intPart
      const formattedInt = intAbs.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      return sign + formattedInt + (decPart ? '.' + decPart : '')
    }
    const num = parseFloat(numStr)
    if (!isFinite(num)) return numStr
    const fullStr = numberToString(num)
    const digitsOnly = fullStr.replace(/[-.]/g, '')
    if (digitsOnly.length > 30) {
      const expStr = numStr.split(/[eE]/)
      if (expStr.length === 2) {
        const m = parseFloat(expStr[0]).toPrecision(10).replace(/\.?0+$/, '')
        return m + 'e' + expStr[1]
      }
      return numStr
    }
    return formatNumber(fullStr)
  }, [numberToString])

  const evaluateExpression = useCallback((expr) => {
    if (!expr) return 0
    try {
      // Normalize operators: ×→*, ÷→/, −(U+2212)→-
      let src = expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
      src = src.replace(/[+\-*/]$/, '')
      if (!src) return 0

      // Safe recursive descent parser (no eval/Function, CSP-compliant)
      let pos = 0
      const len = src.length

      function skipSpaces() {
        while (pos < len && src[pos] === ' ') pos++
      }

      function peek() { skipSpaces(); return pos < len ? src[pos] : null }

      function consume(ch) {
        skipSpaces()
        if (pos < len && src[pos] === ch) { pos++; return true }
        return false
      }

      // parseNumber: read a numeric literal (integer or decimal)
      function parseNumber() {
        skipSpaces()
        const start = pos
        if (peek() === '-') { pos++; skipSpaces() } // handle leading minus (shouldn't happen at top-level, but safe)
        while (pos < len && /[0-9.]/.test(src[pos])) pos++
        const numStr = src.slice(start, pos)
        const n = parseFloat(numStr)
        if (isNaN(n)) throw new Error('bad number: ' + numStr)
        return n
      }

      // parseUnary: handles unary minus and parenthesized sub-expressions
      function parseUnary() {
        if (consume('-')) return -parseUnary()
        if (consume('+')) return parseUnary()
        if (consume('(')) {
          const v = parseExpr()
          if (!consume(')')) throw new Error('missing )')
          return v
        }
        return parseNumber()
      }

      // parseMulDiv: * and / (left-associative, higher precedence)
      function parseMulDiv() {
        let v = parseUnary()
        while (true) {
          skipSpaces()
          if (consume('*')) v = v * parseUnary()
          else if (consume('/')) {
            const d = parseUnary()
            if (d === 0) throw new Error('div by zero')
            v = v / d
          } else break
        }
        return v
      }

      // parseExpr: + and - (left-associative, lower precedence)
      function parseExpr() {
        let v = parseMulDiv()
        while (true) {
          skipSpaces()
          if (consume('+')) v = v + parseMulDiv()
          else if (consume('-')) v = v - parseMulDiv()
          else break
        }
        return v
      }

      const result = parseExpr()
      skipSpaces()
      if (pos < len) throw new Error('unexpected: ' + src[pos])

      if (!isFinite(result)) return NaN

      // Use toPrecision(12) to eliminate floating-point artifacts
      // (e.g. 0.1+0.2=0.30000000000000004 → 0.3) while preserving
      // reasonable precision for division (10÷3 ≈ 3.33333333333).
      return parseFloat(result.toPrecision(12))
    } catch (e) { return NaN }
  }, [])

  const getCurrentNumber = useCallback(() => {
    const match = expression.match(/[^+\-×÷−]*$/)
    return match ? match[0] : ''
  }, [expression])

  // ========== Font Size Auto-fit ==========
  const syncMeasurerStyles = useCallback((el) => {
    const m = measurerRef.current
    if (!m) return
    const cs = window.getComputedStyle(el)
    m.style.fontFamily = cs.fontFamily
    m.style.fontWeight = cs.fontWeight
    m.style.fontStyle = cs.fontStyle
    m.style.fontVariantNumeric = cs.fontVariantNumeric || 'normal'
    m.style.letterSpacing = cs.letterSpacing || 'normal'
    m.style.fontKerning = cs.fontKerning || 'auto'
    m.style.fontFeatureSettings = cs.fontFeatureSettings || 'normal'
    m.style.lineHeight = 'normal'
  }, [])

  const getAvailWidth = useCallback(() => {
    const parent = exprElRef.current?.parentElement
    if (!parent) return 360
    // Display area has 24px horizontal padding on each side
    return parent.clientWidth - 48
  }, [])

  const fitFontSize = useCallback((el, text, maxFont, minFont, allowScroll) => {
    if (!el) return
    if (!text || text.length === 0) {
      el.style.fontSize = ''
      el.classList.remove('calc-hscroll')
      el.style.overflowX = ''
      el.scrollLeft = 0
      return
    }
    const m = measurerRef.current
    if (!m) return
    syncMeasurerStyles(el)
    const availW = getAvailWidth()
    if (availW <= 0) return
    let lo = minFont, hi = maxFont, best = minFont
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      m.style.fontSize = mid + 'px'
      m.textContent = text
      if (m.scrollWidth <= availW) { best = mid; lo = mid + 1 }
      else { hi = mid - 1 }
    }
    el.style.fontSize = best + 'px'
    m.style.fontSize = minFont + 'px'
    m.textContent = text
    const overflows = m.scrollWidth > availW
    if (allowScroll && overflows && best === minFont) {
      el.style.overflowX = 'auto'
      el.style.overflowY = 'hidden'
      el.classList.add('calc-hscroll')
      requestAnimationFrame(() => { requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth }) })
    } else {
      el.classList.remove('calc-hscroll')
      el.style.overflowX = ''
      el.style.overflowY = ''
      el.scrollLeft = 0
    }
  }, [syncMeasurerStyles, getAvailWidth])

  // ========== Actions ==========
  // All handlers match the design-version logic exactly for consistent UX.
  const inputNumber = useCallback((num) => {
    let newExpr = expression
    if (justEvaluated) {
      newExpr = ''
      setLastExpr('')
      setLastResult('')
      setJustEvaluated(false)
    } else {
      const currentNum = newExpr.match(/[^+\-×÷−]*$/)?.[0] || ''
      if (currentNum === '0' && num !== '.') {
        newExpr = newExpr.slice(0, -1) + num
        setExpression(newExpr)
        return
      }
    }
    setExpression(newExpr + num)
  }, [expression, justEvaluated])

  const inputDecimal = useCallback(() => {
    let newExpr = expression
    if (justEvaluated) {
      newExpr = '0'
      setLastExpr('')
      setLastResult('')
      setJustEvaluated(false)
    } else {
      const currentNum = newExpr.match(/[^+\-×÷−]*$/)?.[0] || ''
      if (currentNum === '') { setExpression(newExpr + '0.'); return }
      if (currentNum.includes('.')) return
    }
    setExpression(newExpr + '.')
  }, [expression, justEvaluated])

  const inputOperator = useCallback((op) => {
    let newExpr = expression
    if (justEvaluated) {
      // Continue calculation from previous result: "50" → "50−"
      newExpr = lastResult || expression
      setLastExpr('')
      setLastResult('')
      setJustEvaluated(false)
    }
    if (newExpr === '' && op !== '−') return
    if (/[+\-×÷−]$/.test(newExpr)) {
      newExpr = newExpr.slice(0, -1) + op
    } else {
      newExpr += op
    }
    setExpression(newExpr)
  }, [expression, justEvaluated, lastResult])

  const inputPercent = useCallback(() => {
    if (expression === '') return
    const currentNum = expression.match(/[^+\-×÷−]*$/)?.[0] || ''
    if (currentNum === '' || currentNum === '-' || currentNum === '−') return
    const num = parseFloat(currentNum.replace(/−/g, '-'))
    if (isNaN(num)) return
    const res = num / 100
    const resStr = String(res)
    const lastOpIdx = Math.max(
      expression.lastIndexOf('+'), expression.lastIndexOf('-'),
      expression.lastIndexOf('×'), expression.lastIndexOf('÷'), expression.lastIndexOf('−')
    )
    let newExpr
    if (lastOpIdx === -1) newExpr = resStr
    else newExpr = expression.slice(0, lastOpIdx + 1) + resStr
    if (justEvaluated) { setLastExpr(''); setLastResult(''); setJustEvaluated(false) }
    setExpression(newExpr)
  }, [expression, justEvaluated])

  const backspace = useCallback(() => {
    if (justEvaluated) {
      setExpression('')
      setLastExpr('')
      setLastResult('')
      setHistory([])
      setJustEvaluated(false)
      return
    }
    setExpression(prev => prev.slice(0, -1))
  }, [justEvaluated])

  const clearAll = useCallback(() => {
    setExpression('')
    setLastExpr('')
    setLastResult('')
    setHistory([])
    setJustEvaluated(false)
  }, [])

  const calculate = useCallback(() => {
    if (expression === '') return
    const evalExpr = expression.replace(/[+\-×÷−]$/, '')
    if (!evalExpr) return
    const result = evaluateExpression(evalExpr)
    if (isNaN(result)) {
      setExpression('Error')
      setJustEvaluated(true)
      return
    }
    const resultStr = numberToString(result)
    setHistory(prev => {
      const next = [...prev, { expr: evalExpr + '=', result: resultStr }]
      if (next.length > 10) next.shift()
      return next
    })
    setLastExpr(evalExpr)
    setLastResult(resultStr)
    setExpression(resultStr)
    setJustEvaluated(true)
  }, [expression, evaluateExpression, numberToString])

  const reuseHistory = useCallback((index) => {
    const item = history[index]
    if (!item) return
    // History stores expr as "31+2="; strip trailing "=" for secondary row display
    const exprOnly = item.expr.replace(/=$/, '')
    setLastResult(item.result)
    setLastExpr(exprOnly)
    setExpression(item.result)
    setJustEvaluated(true)
  }, [history])

  // ========== Keyboard Support ==========
  useEffect(() => {
    if (!embedded && !visible) return
    const handleKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const key = e.key
      if (key >= '0' && key <= '9') { e.preventDefault(); inputNumber(key) }
      else if (key === '.') { e.preventDefault(); inputDecimal() }
      else if (key === '+') { e.preventDefault(); inputOperator('+') }
      else if (key === '-') { e.preventDefault(); inputOperator('−') }
      else if (key === '*') { e.preventDefault(); inputOperator('×') }
      else if (key === '/') { e.preventDefault(); inputOperator('÷') }
      else if (key === 'Enter' || key === '=') { e.preventDefault(); calculate() }
      else if (key === 'Backspace') { e.preventDefault(); backspace() }
      else if (key === 'Escape') { e.preventDefault(); onClose?.() }
      else if (key === '%') { e.preventDefault(); inputPercent() }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [embedded, visible, inputNumber, inputDecimal, inputOperator, inputPercent, calculate, backspace, onClose])

  // Reset when opened
  useEffect(() => {
    if (visible) {
      setExpression('')
      setLastExpr('')
      setLastResult('')
      setJustEvaluated(false)
    }
  }, [visible])

  // ========== Render Logic ==========
  const isError = expression === 'Error'
  let exprText, resultText, chineseText, inResultMode = false

  if (justEvaluated && !isError && lastExpr) {
    // Result mode (after pressing =):
    // - Upper row (calc-expr, process position): shows original expression — becomes smaller/lighter
    // - Lower row (calc-result, answer position): shows answer — becomes large/bold/dark
    // - Chinese row: shows amount — becomes larger/bolder
    inResultMode = true
    exprText = lastExpr                                   // "31+2"  过程在上行（变小变浅）
    resultText = '= ' + formatNumber(lastResult)          // "= 33" 答案在下行（变大加粗）
    const resultNum = parseFloat(lastResult)
    chineseText = (isFinite(resultNum) && Math.abs(resultNum) < 1e20) ? amountToChinese(resultNum) : ''
  } else {
    // Input mode (typing):
    // - Upper row (calc-expr): large bold expression being typed
    // - Lower row (calc-result): smaller "= preview"
    // - Chinese row: lighter preview
    exprText = expression || '0'

    // Always show live preview whenever there is a valid non-empty expression,
    // even for a single number (e.g. typing "4" → "= 4", "4+" → keeps showing "= 4").
    // Don't show preview when expression is just a bare operator (e.g. leading "−").
    let showLive = false, liveResult = null
    if (!isError && expression && expression !== '0') {
      const computable = expression.replace(/[+\-×÷−]+$/, '').replace(/^[−-]/, '')
      if (computable) {
        const val = evaluateExpression(expression)
        if (!isNaN(val)) {
          showLive = true; liveResult = val
        }
      }
    }

    resultText = showLive ? '= ' + formatNumber(numberToString(liveResult)) : ''
    chineseText = (showLive && isFinite(liveResult) && Math.abs(liveResult) < 1e20) ? amountToChinese(liveResult) : ''

    if (isError) {
      exprText = 'Error'; resultText = ''; chineseText = ''
    }
  }

  // Apply font sizing after render
  useEffect(() => {
    if (!embedded && !visible) return
    requestAnimationFrame(() => {
      if (inResultMode) {
        // Result mode: upper row (expr=process) becomes small/light, lower row (result=answer) becomes big/bold
        fitFontSize(exprElRef.current, exprText, RES_MAX, RES_MIN, false)
        fitFontSize(resultElRef.current, resultText, EXPR_MAX, EXPR_MIN, true)
        fitFontSize(chineseElRef.current, chineseText, CHN_BOLD_MAX, CHN_MIN, false)
      } else {
        // Input mode: upper row (expr=process) is big/bold, lower row (result=preview) is small/light
        fitFontSize(exprElRef.current, exprText, EXPR_MAX, EXPR_MIN, true)
        fitFontSize(resultElRef.current, resultText, RES_MAX, RES_MIN, false)
        fitFontSize(chineseElRef.current, chineseText, CHN_MAX, CHN_MIN, false)
      }
      // Auto-scroll history to bottom
      if (historyElRef.current) {
        historyElRef.current.scrollTop = historyElRef.current.scrollHeight
      }
    })
  })

  // Click overlay to close
  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose?.()
  }

  // In embedded mode (standalone window), always visible — no early return
  if (!embedded && !visible) return null

  const panel = (
    <div className={`calc-modal-panel ${inResultMode ? 'is-result' : ''} ${embedded ? 'is-embedded' : ''}`}>
      {/* Display Area */}
      <div className="calc-display-area">
        {/* History - always reserve height */}
        <div
          ref={historyElRef}
          className={`calc-history ${history.length > 0 ? 'has-items' : ''}`}
        >
          {history.map((h, i) => (
            <div
              key={i}
              className="calc-history-item"
              onClick={() => reuseHistory(i)}
            >
              <span className="calc-hist-expr">{h.expr}</span>
              <span className="calc-hist-res">{formatNumber(h.result)}</span>
            </div>
          ))}
        </div>

        {/* Primary row: expression (input) or answer (result) */}
        <div ref={exprElRef} className="calc-expr">{exprText}</div>
        {/* Secondary row: preview (input) or "expr =" (result) */}
        <div ref={resultElRef} className="calc-result">{resultText}</div>
        {/* Chinese amount row */}
        <div ref={chineseElRef} className="calc-chinese">{chineseText}</div>
      </div>

      {/* Buttons */}
      <div className="calc-buttons">
        <button className="calc-btn calc-btn-func" onClick={clearAll}>C</button>
        <button className="calc-btn calc-btn-func" onClick={backspace} aria-label="退格">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"></path>
            <line x1="18" y1="9" x2="12" y2="15"></line>
            <line x1="12" y1="9" x2="18" y2="15"></line>
          </svg>
        </button>
        <button className="calc-btn calc-btn-func" onClick={inputPercent}>%</button>
        <button className="calc-btn calc-btn-func" onClick={() => inputOperator('÷')}>÷</button>

        <button className="calc-btn calc-btn-num" onClick={() => inputNumber('7')}>7</button>
        <button className="calc-btn calc-btn-num" onClick={() => inputNumber('8')}>8</button>
        <button className="calc-btn calc-btn-num" onClick={() => inputNumber('9')}>9</button>
        <button className="calc-btn calc-btn-func" onClick={() => inputOperator('×')}>×</button>

        <button className="calc-btn calc-btn-num" onClick={() => inputNumber('4')}>4</button>
        <button className="calc-btn calc-btn-num" onClick={() => inputNumber('5')}>5</button>
        <button className="calc-btn calc-btn-num" onClick={() => inputNumber('6')}>6</button>
        <button className="calc-btn calc-btn-func" onClick={() => inputOperator('−')}>−</button>

        <button className="calc-btn calc-btn-num" onClick={() => inputNumber('1')}>1</button>
        <button className="calc-btn calc-btn-num" onClick={() => inputNumber('2')}>2</button>
        <button className="calc-btn calc-btn-num" onClick={() => inputNumber('3')}>3</button>
        <button className="calc-btn calc-btn-func" onClick={() => inputOperator('+')}>+</button>

        <button className="calc-btn calc-btn-num calc-btn-zero" onClick={() => inputNumber('0')}>0</button>
        <button className="calc-btn calc-btn-num" onClick={inputDecimal}>.</button>
        <button className="calc-btn calc-btn-eq" onClick={calculate}>=</button>
      </div>
    </div>
  )

  if (embedded) {
    return (
      <>
        <div
          ref={measurerRef}
          style={{
            position: 'fixed', top: -99999, left: 0, visibility: 'visible',
            whiteSpace: 'nowrap', pointerEvents: 'none', lineHeight: 'normal', display: 'block',
          }}
        />
        {panel}
      </>
    )
  }

  return (
    <>
      {/* Off-screen measurer */}
      <div
        ref={measurerRef}
        style={{
          position: 'fixed', top: -99999, left: 0, visibility: 'visible',
          whiteSpace: 'nowrap', pointerEvents: 'none', lineHeight: 'normal', display: 'block',
        }}
      />

      <div className="modal-overlay calc-modal-overlay" onClick={handleOverlayClick}>
        {panel}
      </div>
    </>
  )
})

export default CalculatorModal
