export function amountToChinese(amount) {
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
}