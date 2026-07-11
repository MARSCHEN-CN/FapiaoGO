import { useState, useRef, useEffect, useCallback, memo } from 'react'

/**
 * CalculatorModal — 计算器弹窗
 * 支持键盘输入、实时预览、中文大写金额、历史记录
 */
const CalculatorModal = memo(function CalculatorModal({ visible, onClose }) {
  const [expression, setExpression] = useState('')
  const [lastExpr, setLastExpr] = useState('')
  const [lastResult, setLastResult] = useState('')
  const [history, setHistory] = useState([]) // oldest first
  const [justEvaluated, setJustEvaluated] = useState(false)
  const [waitingForOperand, setWaitingForOperand] = useState(false) // true after pressing op post-=, before typing next number

  const exprElRef = useRef(null)
  const resultElRef = useRef(null)
  const chineseElRef = useRef(null)
  const historyElRef = useRef(null)
  const measurerRef = useRef(null)

  // Font size constants (matching fixed row heights in CSS)
  // expr: 46px base, fits in 56px height; result: 22px base, fits in 28px; chinese: 13px base
  const EXPR_MAX = 46, EXPR_MIN = 10
  const RES_MAX = 22, RES_MIN = 10
  const RES_SMALL_MAX = 15
  const CHN_MAX = 13, CHN_MIN = 10
  const CHN_BOLD_MAX = 15

  // ========== Chinese Amount Conversion ==========
  const toChineseAmount = useCallback((amount) => {
    if (isNaN(amount) || !isFinite(amount)) return ''
    if (Math.abs(amount) < 0.005) return '零元整'
    const digits = '零壹贰叁肆伍陆柒捌玖'
    const intUnits = ['', '拾', '佰', '仟']
    const bigUnits = ['', '万', '亿', '兆', '京']
    const negative = amount < 0
    const absAmount = Math.abs(amount)
    const rounded = Math.round(absAmount * 100) / 100
    const integerPart = Math.floor(rounded)
    const decimalPart = Math.round((rounded - integerPart) * 100)
    if (integerPart >= 1e20) return '数值过大'
    function sectionToChinese(sec) {
      if (sec === 0) return ''
      let str = '', zeroFlag = false, started = false
      for (let i = 3; i >= 0; i--) {
        const d = Math.floor(sec / Math.pow(10, i)) % 10
        if (d === 0) { zeroFlag = true }
        else {
          if (zeroFlag && started) str += '零'
          str += digits[d] + intUnits[i]
          zeroFlag = false; started = true
        }
      }
      return str
    }
    function convertInteger(n) {
      if (n === 0) return '零'
      let result = '', bigUnitIdx = 0, needZero = false
      while (n > 0) {
        const section = n % 10000
        const sectionStr = sectionToChinese(section)
        if (sectionStr) {
          if (needZero) result = '零' + result
          result = sectionStr + bigUnits[bigUnitIdx] + result
          needZero = section < 1000
        } else {
          if (result.length > 0 && !result.startsWith('零')) needZero = true
        }
        n = Math.floor(n / 10000); bigUnitIdx++
      }
      return result || '零'
    }
    let result = (negative ? '负' : '') + convertInteger(integerPart) + '元'
    if (decimalPart === 0) result += '整'
    else {
      const jiao = Math.floor(decimalPart / 10), fen = decimalPart % 10
      if (jiao > 0 && fen > 0) result += digits[jiao] + '角' + digits[fen] + '分'
      else if (jiao > 0) result += digits[jiao] + '角整'
      else result += '零' + digits[fen] + '分'
    }
    return result
  }, [])

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
    return parent.clientWidth - 6
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
  const inputNumber = useCallback((num) => {
    let newExpr = expression
    let newJustEval = justEvaluated
    let newLastExpr = lastExpr
    let newLastResult = lastResult
    let newWaiting = false
    if (justEvaluated) {
      // Starting a brand new calculation after =
      newExpr = num === '.' ? '0.' : num
      newLastExpr = ''
      newLastResult = ''
      newJustEval = false
    } else if (waitingForOperand) {
      // Just pressed an operator after =, now typing the next number.
      // Keep the expression (e.g. "50−") and append the new digit.
      newExpr = expression + num
      newWaiting = false
    } else {
      const currentNum = newExpr.match(/[^+\-×÷−]*$/)?.[0] || ''
      if (currentNum === '0' && num !== '.') {
        newExpr = newExpr.slice(0, -1) + num
      } else {
        newExpr += num
      }
    }
    setExpression(newExpr)
    setJustEvaluated(newJustEval)
    setLastExpr(newLastExpr)
    setLastResult(newLastResult)
    setWaitingForOperand(newWaiting)
  }, [expression, justEvaluated, lastExpr, lastResult, waitingForOperand])

  const inputDecimal = useCallback(() => {
    let newExpr = expression
    let newJustEval = justEvaluated
    let newLastExpr = lastExpr
    let newLastResult = lastResult
    let newWaiting = false
    if (justEvaluated) {
      newExpr = '0.'
      newLastExpr = ''
      newLastResult = ''
      newJustEval = false
    } else if (waitingForOperand) {
      newExpr = expression + '0.'
      newWaiting = false
    } else {
      const currentNum = newExpr.match(/[^+\-×÷−]*$/)?.[0] || ''
      if (currentNum === '') newExpr += '0.'
      else if (!currentNum.includes('.')) newExpr += '.'
    }
    setExpression(newExpr)
    setJustEvaluated(newJustEval)
    setLastExpr(newLastExpr)
    setLastResult(newLastResult)
    setWaitingForOperand(newWaiting)
  }, [expression, justEvaluated, lastExpr, lastResult, waitingForOperand])

  const inputOperator = useCallback((op) => {
    let newExpr = expression
    let newJustEval = justEvaluated
    let newLastExpr = lastExpr
    let newLastResult = lastResult
    let newWaiting = false
    if (justEvaluated) {
      // Continue calculation using previous result: "50" → "50−"
      newExpr = (lastResult || expression) + op
      newJustEval = false
      // Keep lastResult/lastExpr so display continues showing result prominently
      newWaiting = true
    } else if (waitingForOperand) {
      // Already waiting; just change the operator
      newExpr = newExpr.slice(0, -1) + op
    } else {
      if (newExpr === '' && op !== '−') return
      if (/[+\-×÷−]$/.test(newExpr)) {
        newExpr = newExpr.slice(0, -1) + op
      } else {
        newExpr += op
      }
    }
    setExpression(newExpr)
    setJustEvaluated(newJustEval)
    setLastExpr(newLastExpr)
    setLastResult(newLastResult)
    setWaitingForOperand(newWaiting)
  }, [expression, justEvaluated, lastExpr, lastResult, waitingForOperand])

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
    let newJustEval = justEvaluated
    let newLastExpr = lastExpr
    let newLastResult = lastResult
    if (lastOpIdx === -1) newExpr = resStr
    else newExpr = expression.slice(0, lastOpIdx + 1) + resStr
    if (justEvaluated) { newJustEval = false; newLastExpr = ''; newLastResult = '' }
    setExpression(newExpr)
    setJustEvaluated(newJustEval)
    setLastExpr(newLastExpr)
    setLastResult(newLastResult)
    setWaitingForOperand(false)
  }, [expression, justEvaluated, lastExpr, lastResult, waitingForOperand])

  const backspace = useCallback(() => {
    if (justEvaluated) {
      // Clear all when backspacing a result
      setExpression('')
      setLastExpr('')
      setLastResult('')
      setHistory([])
      setJustEvaluated(false)
      setWaitingForOperand(false)
      return
    }
    if (waitingForOperand) {
      // Pressing backspace while waiting for operand cancels the pending op
      setExpression(lastResult || '')
      setJustEvaluated(true)
      setWaitingForOperand(false)
      return
    }
    setExpression(prev => prev.slice(0, -1))
  }, [justEvaluated, waitingForOperand, lastResult])

  const clearAll = useCallback(() => {
    setExpression('')
    setLastExpr('')
    setLastResult('')
    setHistory([])
    setJustEvaluated(false)
    setWaitingForOperand(false)
  }, [])

  const calculate = useCallback(() => {
    if (expression === '') return
    // If waiting for operand (just pressed op after =), don't calculate again
    if (waitingForOperand) return
    const evalExpr = expression.replace(/[+\-×÷−]$/, '')
    if (!evalExpr) return
    const result = evaluateExpression(evalExpr)
    if (isNaN(result)) {
      setExpression('Error')
      setJustEvaluated(true)
      setWaitingForOperand(false)
      return
    }
    const resultStr = numberToString(result)
    setHistory(prev => {
      const next = [...prev, { expr: evalExpr + '=', result: resultStr }]
      if (next.length > 10) next.shift()
      return next
    })
    setLastExpr(evalExpr + ' =')
    setLastResult(resultStr)
    setExpression(resultStr)
    setJustEvaluated(true)
    setWaitingForOperand(false)
  }, [expression, evaluateExpression, numberToString, waitingForOperand])

  const reuseHistory = useCallback((index) => {
    const item = history[index]
    if (!item) return
    setLastResult(item.result)
    setLastExpr(item.expr)
    setExpression(item.result)
    setJustEvaluated(true)
    setWaitingForOperand(false)
  }, [history])

  // ========== Keyboard Support ==========
  useEffect(() => {
    if (!visible) return
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
  }, [visible, inputNumber, inputDecimal, inputOperator, inputPercent, calculate, backspace, onClose])

  // Reset when opened
  useEffect(() => {
    if (visible) {
      setExpression('')
      setLastExpr('')
      setLastResult('')
      setJustEvaluated(false)
      setWaitingForOperand(false)
    }
  }, [visible])

  // ========== Render Logic ==========
  const isError = expression === 'Error'
  let exprText, resultText, chineseText, inResultMode = false

  if (isError) {
    exprText = 'Error'; resultText = ''; chineseText = ''
  } else if ((justEvaluated || waitingForOperand) && lastResult) {
    // Show result prominently:
    // - justEvaluated: after pressing =
    // - waitingForOperand: after pressing operator post-=, before typing next number
    inResultMode = true
    exprText = formatNumber(lastResult)
    resultText = lastExpr
    const resultNum = parseFloat(lastResult)
    chineseText = (isFinite(resultNum) && Math.abs(resultNum) < 1e20) ? toChineseAmount(resultNum) : ''
  } else {
    exprText = expression || '0'
    let showLive = false, liveResult = null
    if (expression && expression !== '0') {
      // Strip trailing operators to get the "computable" part.
      const stripped = expression.replace(/[+\-×÷−]+$/, '')
      if (stripped && stripped !== '−' && stripped !== '-') {
        const val = evaluateExpression(expression)
        if (!isNaN(val)) {
          showLive = true; liveResult = val
        }
      }
    }
    resultText = showLive ? '= ' + formatNumber(numberToString(liveResult)) : ''
    chineseText = (showLive && isFinite(liveResult) && Math.abs(liveResult) < 1e20) ? toChineseAmount(liveResult) : ''
  }

  // Apply font sizing after render
  useEffect(() => {
    if (!visible) return
    requestAnimationFrame(() => {
      if (inResultMode) {
        fitFontSize(exprElRef.current, exprText, EXPR_MAX, EXPR_MIN, true)
        fitFontSize(resultElRef.current, resultText, RES_SMALL_MAX, RES_MIN, false)
        fitFontSize(chineseElRef.current, chineseText, CHN_BOLD_MAX, CHN_MIN, false)
      } else {
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

  if (!visible) return null

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
        <div className={`calc-modal-panel ${inResultMode ? 'is-result' : ''}`}>
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
      </div>
    </>
  )
})

export default CalculatorModal
