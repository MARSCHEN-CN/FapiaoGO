"""
发票明细行提取器 v10（完整版）

v10 修复（基于 v9）:
1. [FIX-1] 新增 _prepare_lines：进入垂直/标准路径前，将表格式行
   （星号+数据在同一行）拆分为纯垂直格式，确保所有 item 的数据
   都能被垂直组装路径正确收集。
2. [FIX-2] _strip_control_markers / _is_control_marker：$$ → $$
   修复前 $$ 是行尾锚点，永远无法匹配 (BUYER_START) 等标签。
3. [FIX-3] _preprocess_orphan_lines：增加星号边界检测，
   遇到星号前缀时先刷新 pending，防止跨 item 污染。
4. [FIX-4] _assemble_multi_items Step 1：增加 _HEADER_FIELD_RE 过滤，
   防止表头噪声混入名称组。
5. [FIX-5] _is_data_value：增加逐 token 检查，支持多 token 混合行。
6. [FIX-6] BBox 路径：新增 _split_multi_item_rows，拆分共享 y 坐标
   的多个明细行（如折扣行与正行在同一行）。
7. [FIX-7] 文本路径：_assemble_multi_items 金额分配增加税率推导，
   区分金额与税额，避免税额被误分配为金额。
8. [FIX-8] 主提取器：始终先用文本路径提取作为基准，当 bbox_tokens
   不包含有效明细数据（全是噪声如银行账号、备注、开票人）时直接
   使用文本结果；当 bbox_tokens 包含有效明细数据时，比较两条路径
   的结果数量，选择更优的那条。
"""
from __future__ import annotations

import re
import logging
from dataclasses import dataclass, field
from typing import List, Optional

from ..models import OCRDocument, InvoiceLineItem, Token
from ..segments import SegmentedDocument, DocumentSegment

logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)

# ═══════════════════════════════════════════════════════
#  OCR-Aware Tokenizer (v9)
# ═══════════════════════════════════════════════════════

_TOKEN_RE = re.compile(
    r'[¥￥][\d,]+\.\d{2}'
    r'|[¥￥][\d,]+'
    r'|-?\d+(?:\.\d+)?%'
    r'|-?[\d,]+\.\d{2}'
    r'|-?\d+\.\d{3,4}'
    r'|-?\d+(?:\.\d+)?(?:mm|cm|dm|m|km|g|kg|mg|ml|L|㎡|m²|m³|kv|kw|w|v|a|hz|db|px)'
    r'|-?[\d,]+'
    r'|[A-Za-z0-9][A-Za-z0-9\-/×xX.]*'
    r'|[\u4e00-\u9fff]+'
    r'|[^\s]+'
)

# ═══════════════════════════════════════════════════════
#  Token 白名单过滤器 — v9
# ═══════════════════════════════════════════════════════

_INVOICE_NUMBER_RAW_RE = re.compile(r'^\d{8,20}$')
_BANK_ACCOUNT_RE = re.compile(r'^\d{12,19}$')
_TAX_ID_RE = re.compile(r'^[0-9A-Za-z]{15,20}$')
_DATE_RE = re.compile(
    r'^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?$'
    r'|^\d{4}[-/]\d{1,2}[-/]\d{1,2}$'
    r'|^\d{4}\.\d{1,2}\.\d{1,2}$'
)
_CHINESE_UPPER_AMOUNT_RE = re.compile(
    r'[零壹贰叁肆伍陆柒捌玖拾佰仟万亿元角分整负]'
)
_COMPANY_KW_RE = re.compile(
    r'(?:公司|有限|集团|中心|事务所|合作社|厂|行|部|室|处'
    r'|协会|商会|医院|学校|银行|保险|基金|信托|证券)'
)
_NON_AMOUNT_FLOAT_RE = re.compile(r'^0\.\d{3,}$')
_HEADER_FIELD_RE = re.compile(
    r'(?:发票代码|发票号码|开票日期|购买方|销售方|纳税人识别号'
    r'|地址.?电话|开户行.?账号|机器编号|校验码|密码区'
    r'|项目名称|规格型号|单位|数量|单价|金额|税率|税额|征收率|合计)'
)

_EAN_BARCODE_RE = re.compile(r'^\d{13}$')
_PRODUCT_BARCODE_RE = re.compile(r'^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$')

# [PERF] 模块级预编译正则（原在 _assemble_multi_items 循环内每次重新编译）
_BARCODE_SPEC_RE = re.compile(r'^\d{8,20}$')
_BARCODE_TRAIL_RE = re.compile(r'\s*\d{8,20}$')

# ═══════════════════════════════════════════════════════
#  金额/数值/税率校验 (继承 v8, 不变)
# ═══════════════════════════════════════════════════════

_AMOUNT_RE = re.compile(r'^-?[\d,]+\.\d{2}$')
_AMOUNT_LOOSE_RE = re.compile(r'^-?[\d,]+(?:\.\d{1,4})?$')
_NUMBER_RE = re.compile(r'^[\d,]+(\.\d+)?$')
_RATE_RE = re.compile(r'^-?\d+(?:\.\d+)?%$|^免税$')
_MODEL_RE = re.compile(
    r'^[A-Za-z]{1,6}\d{2,}'
    r'|^\d{2,}[A-Za-z]{1,6}'
    r'|^[A-Za-z]+[-]\d{2,}'
    r'|^[A-Za-z]{2,}\d+[A-Za-z]*$'
)

_TOKEN_SUMMARY_RE = re.compile(
    r'(?:^|(?<=[\s:：]))(?:合\s*计|价税合计|小计)(?:\s|$|[:：])')
_TOKEN_STAR_CATEGORY_RE = re.compile(r'\*[^*]+\*')

# ═══════════════════════════════════════════════════════
#  v8 常量 (继承)
# ═══════════════════════════════════════════════════════

_MIN_TOKENS = 2
# 无上限：明细行全部解析，不应被截断
_CROSS_VALIDATE_TOLERANCE_RATIO = 0.01
_CROSS_VALIDATE_TOLERANCE_MIN = 0.02
_MAX_QTY_PRICE_CANDIDATES = 4
_SPEC_SCORE_THRESHOLD = 2
_MIN_RATE = -17.0
_MAX_RATE = 17.0
_TAX_DERIVE_MIN_JE = 50.0
_TAX_DERIVE_MIN_SE = 1.0
_RELAXED_AMOUNT_MIN_DIGITS = 3

_QTY_INTEGER_PENALTY = 0.002
_QTY_RANGE_SOFT_CAP = 100_000
_PRICE_RANGE_SOFT_CAP = 1_000_000

_VALID_RATES: frozenset[str] = frozenset({
    '0%', '1%', '1.5%', '2%', '3%', '5%', '6%', '9%',
    '10%', '11%', '13%', '16%', '17%',
    '-0%', '-1%', '-1.5%', '-2%', '-3%', '-5%', '-6%', '-9%',
    '-10%', '-11%', '-13%', '-16%', '-17%',
    '免税',
})

_INDUSTRY_SPECS: frozenset[str] = frozenset({
    'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8',
    'B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8',
})
_INDUSTRY_SPEC_RE = re.compile(r'^\d+[gG]$')

_COMMON_UNITS: frozenset[str] = frozenset({
    '台', '个', '次', '套', '件', '批', '项', '组', '条',
    '吨', 'kg', '千克', '克', 'g', '毫克', 'mg', '磅', '盎司',
    '米', 'm', '厘米', 'cm', '毫米', 'mm', '公里', 'km',
    '㎡', 'm²', '平方米', '平方', '立方米', '亩', '公顷',
    '升', 'L', '毫升', 'ml', '加仑',
    '箱', '包', '卷', '张', '本', '册', '份', '盒', '瓶',
    '袋', '桶', '罐', '壶', '根', '块', '粒', '颗', '只',
    '支', '坛', '筐', '篓', '令', '把', '片',
    '小时', '天', '年', '月',
    '人', '对', '双', '班', '课', '期', '轮', '场',
    '元', '角', '分',
})

_STANDARD_RATES: list[float] = [0, 1, 1.5, 2, 3, 5, 6, 9, 10, 11, 13, 16, 17]

_OCR_DIGIT_MAP = str.maketrans({
    'O': '0', 'o': '0',
    'I': '1', 'l': '1', '|': '1',
    'S': '5', 's': '5',
    'B': '8',
})
_NUMERICISH_RE = re.compile(r'^-?[\dOolISB|gs,]+\.?[\dOolISB|gs]*$')

# [PERF] 模块级常量：避免在 _is_blacklisted_token 中重复创建
_HEADER_SINGLE_CHARS_FROZEN: frozenset = frozenset({
    '数', '量', '单', '价', '金', '额', '税', '率',
    '项', '目', '名', '称', '规', '格', '型', '号',
    '征', '收',
})

# [PERF] 模块级预编译正则（原在 _is_blacklisted_token 内每次重新编译）
_LONG_DECIMAL_RE = re.compile(r'^-?\d+\.\d{3,}$')

# [PERF] 中文大写字符集合（替代逐字符 regex match）
_CHINESE_UPPER_CHARS_SET: frozenset = frozenset(
    '零壹贰叁肆伍陆柒捌玖拾佰仟万亿元角分整负'
)


# ═══════════════════════════════════════════════════════
#  v9 Token 过滤器
# ═══════════════════════════════════════════════════════

def _is_blacklisted_token(token: str) -> bool:
    if not token:
        return True
    if token.isspace():
        return True

    clean = token.replace(' ', '').replace(',', '')

    if _INVOICE_NUMBER_RAW_RE.match(clean):
        if _PRODUCT_BARCODE_RE.match(clean):
            return False
        return True

    if _BANK_ACCOUNT_RE.match(clean):
        if _PRODUCT_BARCODE_RE.match(clean):
            return False
        return True

    if _TAX_ID_RE.match(token) and '.' not in token:
        return True

    if _DATE_RE.match(token):
        return True

    # [PERF] 用集合交集替代逐字符 regex match
    if len(token) >= 2:
        overlap = sum(1 for c in token if c in _CHINESE_UPPER_CHARS_SET)
        if overlap > 0 and overlap / len(token) > 0.5:
            return True

    if _HEADER_FIELD_RE.search(token):
        return True

    # [PERF] 使用模块级 frozenset 替代每次函数内重新创建 set
    if len(token) == 1 and '\u4e00' <= token <= '\u9fff' \
            and token in _HEADER_SINGLE_CHARS_FROZEN:
        return True

    if _COMPANY_KW_RE.search(token) and len(token) >= 6:
        return True

    if _NON_AMOUNT_FLOAT_RE.match(token):
        return True

    # [PERF] 使用模块级预编译正则
    if _LONG_DECIMAL_RE.match(token):
        return True

    return False


# [PERF] 模块级预编译正则（原在热路径函数内每次 re.match/re.search 重新编译）
_PURE_DIGITS_RE = re.compile(r'^\d+$')
_LONG_DECIMAL_5PLUS_RE = re.compile(r'^\d+\.\d{5,}$')
_NEG_AMOUNT_RE = re.compile(r'^-[\d,]+\.\d{1,2}$')
_HAS_DIGIT_RE = re.compile(r'\d')
_UPPER_ALPHA_RE = re.compile(r'^[A-Z][A-Z0-9]*$')
_DIGITS_COMMA_DOT_RE = re.compile(r'^[\d,.]+$')
_CAMEL_CASE_RE = re.compile(r'^[A-Z][a-z]+[A-Z]')
_CJK_1_2_RE = re.compile(r'^[\u4e00-\u9fff]{1,2}$')
_CJK_1_3_FULL_RE = re.compile(r'^[\u4e00-\u9fff]{1,3}$')
_CJK_END_RE = re.compile(r'[\u4e00-\u9fff]$')

# [PERF] _strip_control_markers 预编译正则
_CTRL_MARKER_RE = re.compile(r'\((?:BUYER|SELLER)_(?:START|END)\)\$\$')
_AUX_MARKER_RE = re.compile(r'__AUX_[A-Za-z0-9_]+__')
_MULTI_SPACE_RE = re.compile(r'\s+')
_CTRL_MARKER_FULL_RE = re.compile(
    r'\$\$(?:BUYER|SELLER)_(?:START|END)\$\$')


# ═══════════════════════════════════════════════════════
#  工具函数
# ═══════════════════════════════════════════════════════

def _is_amount(token: str) -> bool:
    return bool(_AMOUNT_RE.match(token))


def _is_relaxed_amount(token: str) -> bool:
    clean = token.replace(',', '').replace('¥', '').replace('￥', '')
    # [PERF] 使用模块级预编译正则
    if not _PURE_DIGITS_RE.match(clean):
        return False
    if len(clean) > 10:
        return False
    return len(clean) >= _RELAXED_AMOUNT_MIN_DIGITS


def _is_loose_amount(token: str) -> bool:
    return bool(_AMOUNT_LOOSE_RE.match(token))


def _is_valid_number(s: str) -> bool:
    if not s:
        return False
    return bool(_AMOUNT_LOOSE_RE.match(s)) or bool(_NUMBER_RE.match(s))


def _is_valid_rate(token: str) -> bool:
    if token in _VALID_RATES:
        return True
    if token == '免税':
        return True
    if not _RATE_RE.match(token):
        return False
    try:
        val = float(token.rstrip('%'))
        return _MIN_RATE <= val <= _MAX_RATE
    except ValueError:
        return False


def _is_model_token(token: str) -> bool:
    return bool(_MODEL_RE.match(token)) and len(token) >= 4


def _is_integer_like(v: float) -> bool:
    return abs(v - round(v)) < 0.001


def _clean(s: str) -> str:
    return _strip_control_markers(s).replace(',', '').replace(' ', '') \
        .replace('¥', '').replace('￥', '')


# [FIX-2] 修正 $$ → \( （匹配字面括号）
# [PERF] 使用模块级预编译正则
def _strip_control_markers(s: str) -> str:
    if not s:
        return ''
    s = _CTRL_MARKER_RE.sub(' ', str(s))
    s = _AUX_MARKER_RE.sub(' ', s)
    return _MULTI_SPACE_RE.sub(' ', s).strip()


# [FIX-2] 修正 $$ → $$ $$ $$
# [PERF] 使用模块级预编译正则
def _is_control_marker(token: str) -> bool:
    return bool(_CTRL_MARKER_FULL_RE.fullmatch(str(token).strip()))


def _normalize_ocr_digits(token: str) -> str:
    if not token or not _NUMERICISH_RE.match(token):
        return token
    normalized = token.translate(_OCR_DIGIT_MAP)
    if _NUMBER_RE.match(normalized) or _AMOUNT_RE.match(normalized):
        return normalized
    return token


def _spec_score(token: str) -> int:
    if token in _INDUSTRY_SPECS or _INDUSTRY_SPEC_RE.match(token):
        return _SPEC_SCORE_THRESHOLD + 1
    score = 0
    if '-' in token or '/' in token:
        score += 1
    if '×' in token or 'x' in token or 'X' in token:
        score += 1
    # [PERF] 使用模块级预编译正则
    if _HAS_DIGIT_RE.search(token):
        score += 1
    if _UPPER_ALPHA_RE.match(token):
        score += 1
    if _DIGITS_COMMA_DOT_RE.match(token):
        score -= 2
    if _CAMEL_CASE_RE.match(token):
        score -= 2
    if _CJK_1_2_RE.match(token):
        score -= 2
    return score


def _assign_text_fields(item: InvoiceLineItem, tokens: list[str]) -> None:
    cleaned: list[str] = []
    for t in tokens:
        t = _strip_control_markers(t)
        if not t or _is_control_marker(t):
            continue
        c = _TOKEN_STAR_CATEGORY_RE.sub('', t).strip()
        if c:
            cleaned.append(c)
        elif not (t.startswith('*') and t.endswith('*') and len(t) > 2):
            cleaned.append(t.strip('*').strip())
    cleaned = [c for c in cleaned if c]
    if not cleaned:
        return
    last = cleaned[-1]
    is_industry = last in _INDUSTRY_SPECS or bool(_INDUSTRY_SPEC_RE.match(last))
    score = _spec_score(last)
    if len(cleaned) >= 3 and score >= _SPEC_SCORE_THRESHOLD:
        item.ggxh = last
        item.xmmc = ' '.join(cleaned[:-1])
    elif len(cleaned) >= 2 and is_industry:
        item.ggxh = last
        item.xmmc = ' '.join(cleaned[:-1])
    else:
        item.xmmc = ' '.join(cleaned)


# ═══════════════════════════════════════════════════
#  垂直明细 token 分类器
# ═══════════════════════════════════════════════════

_SPEC_TOKEN_RE = re.compile(
    r'^(?:'
    r'[A-Za-z]{1,5}\d+[A-Za-z0-9\-/.]*'
    r'|\d+(?:\.\d+)?(?:mm|cm|m|kg|g|ml|L|V|W|A|寸)'
    r'|\d+mm|\d+cm|\d+m'
    r'|φ\d+(?:\.\d+)?(?:mm|cm|m)?'
    r'|[A-Za-z]\d+(?:[A-Za-z]*)?'
    r')$'
)

_NAME_SUFFIX_TOKENS: frozenset[str] = frozenset({
    '头', '绳', '线', '管', '片', '扣', '座',
    '条', '块', '颗', '粒', '根', '支', '把',
    '盒', '瓶', '袋', '桶', '罐', '壶',
    '轮', '圈',
})


def _is_spec_like_token(text: str) -> bool:
    text = text.strip()
    if not text:
        return False
    if text in _COMMON_UNITS:
        return False
    if _RATE_RE.match(text):
        return False
    if _AMOUNT_RE.match(text) or _AMOUNT_LOOSE_RE.match(text):
        return False
    if text in _NAME_SUFFIX_TOKENS:
        return False
    return bool(_SPEC_TOKEN_RE.match(text))


def _is_name_suffix_token(text: str) -> bool:
    text = text.strip()
    if not text:
        return False
    if text in _COMMON_UNITS:
        return False
    if _is_spec_like_token(text):
        return False
    if _RATE_RE.match(text):
        return False
    if _AMOUNT_RE.match(text) or _AMOUNT_LOOSE_RE.match(text):
        return False
    # [PERF] 使用模块级预编译正则
    if _CJK_1_3_FULL_RE.fullmatch(text):
        return True
    return False


def _join_name_parts(parts: list[str]) -> str:
    result = ''
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if not result:
            result = part
            continue
        # [PERF] 使用模块级预编译正则
        if _CJK_END_RE.search(result) \
                and _CJK_1_3_FULL_RE.fullmatch(part):
            result += part
        else:
            result += ' ' + part
    return result.strip()


def _is_data_value(s: str) -> bool:
    """判断是否是数据值行（单位/数量/金额/税率/长小数）"""
    if s in _COMMON_UNITS:
        return True
    if _RATE_RE.match(s):
        return True
    if _AMOUNT_RE.match(s):
        return True
    # [PERF] 使用模块级预编译正则
    if _PURE_DIGITS_RE.match(s) and len(s) <= 10:
        return True
    if _LONG_DECIMAL_5PLUS_RE.match(s):
        return True
    if _NEG_AMOUNT_RE.match(s):
        return True
    # [FIX-5] 逐 token 检查：支持多 token 混合行
    parts = s.split()
    if len(parts) > 1:
        for p in parts:
            if p in _COMMON_UNITS:
                return True
            if _RATE_RE.match(p):
                return True
            if _AMOUNT_RE.match(p):
                return True
            if _PURE_DIGITS_RE.match(p) and len(p) <= 10:
                return True
            if _NEG_AMOUNT_RE.match(p):
                return True
    return False


# [FIX-1] 新增：单 token 数据值判断（用于表行拆分）
def _is_token_data_value(token: str) -> bool:
    """判断单个 token 是否为数据值（单位/数量/金额/税率）。

    用于 _prepare_lines 中的表行拆分，比 _is_data_value 更精确：
    只检查单个 token，不检查整行。
    """
    clean = token.strip()
    if not clean:
        return False
    if clean in _COMMON_UNITS:
        return True
    if _RATE_RE.match(clean):
        return True
    # 处理 ¥/￥ 前缀
    no_prefix = clean.lstrip('¥￥')
    if _AMOUNT_RE.match(no_prefix):
        return True
    if _AMOUNT_RE.match(clean):
        return True
    if re.match(r'^\d+$', clean) and len(clean) <= 10:
        return True
    if re.match(r'^-[\d,]+\.\d{1,2}$', clean):
        return True
    return False


def _is_name_only_line(line: str) -> bool:
    """判断行是否仅为项目名称文本（无单位、数量、金额）"""
    stripped = line.strip()
    if not stripped:
        return False
    tokens = list(_tokenize_line(stripped))
    for t in tokens:
        if t in _COMMON_UNITS:
            return False
        if re.match(r'^\d+$', t) and len(t) <= 10:
            return False
        if _is_amount(t) or _is_relaxed_amount(t) or _RATE_RE.match(t):
            return False
    return True


# ═══════════════════════════════════════════════════════
#  Token 组装
# ═══════════════════════════════════════════════════════

@dataclass
class LineItemCandidateGroup:
    name_lines: list[str] = field(default_factory=list)
    spec_lines: list[str] = field(default_factory=list)
    data_lines: list[str] = field(default_factory=list)
    suffix_lines: list[str] = field(default_factory=list)
    source_line_indices: list[int] = field(default_factory=list)


def _assemble_field(parts: list[str]) -> str:
    if not parts:
        return ''
    if len(parts) == 1:
        return _clean(_normalize_ocr_digits(parts[0]))
    joined = ''.join(_normalize_ocr_digits(p) for p in parts)
    cleaned = _clean(joined)
    if _is_valid_number(cleaned):
        return cleaned
    numeric_parts = [p for p in parts if re.match(r'^[\d.,¥￥\-\s]+$', p)]
    if numeric_parts and len(numeric_parts) < len(parts):
        joined2 = ''.join(_normalize_ocr_digits(p) for p in numeric_parts)
        cleaned2 = _clean(joined2)
        if _is_valid_number(cleaned2):
            return cleaned2
    for p in parts:
        c = _clean(_normalize_ocr_digits(p))
        if _is_valid_number(c):
            return c
    return ''


# ═══════════════════════════════════════════════════════
#  后处理
# ═══════════════════════════════════════════════════════


def _fix_sl_if_looks_like_ggxh(item: InvoiceLineItem, row_idx: int = 0) -> list:
    adjustments = []
    if not item.sl:
        return adjustments
    sl_str = str(item.sl).strip()
    if not sl_str:
        return adjustments

    if re.search(r'[A-Za-z]', sl_str):
        old_sl = item.sl
        old_ggxh = item.ggxh
        item.ggxh = sl_str if not old_ggxh else old_ggxh + ' ' + sl_str
        item.sl = ''
        adjustments.append({
            'row': row_idx, 'field': 'sl',
            'old_value': old_sl, 'new_value': '',
            'reason': 'sl 包含字母，移至 ggxh',
        })
        adjustments.append({
            'row': row_idx, 'field': 'ggxh',
            'old_value': old_ggxh, 'new_value': item.ggxh,
            'reason': '从 sl 移入规格型号',
        })
        return adjustments

    if sl_str.isdigit() and len(sl_str) >= 5 and not item.ggxh:
        if item.xmmc and sl_str in item.xmmc:
            old_sl = item.sl
            item.ggxh = sl_str
            item.sl = ''
            adjustments.append({
                'row': row_idx, 'field': 'sl',
                'old_value': old_sl, 'new_value': '',
                'reason': 'sl 的值出现在 xmmc 中，移至 ggxh',
            })
            adjustments.append({
                'row': row_idx, 'field': 'ggxh',
                'old_value': '', 'new_value': item.ggxh,
                'reason': '从 sl 移入规格型号',
            })
            return adjustments

    spec_patterns = [
        r'^[A-Za-z]\d+$',
        r'^φ\d+',
        r'^DN\d+',
        r'^\d+mm?$',
        r'^\d+cm$',
    ]
    for pattern in spec_patterns:
        if re.match(pattern, sl_str):
            old_sl = item.sl
            old_ggxh = item.ggxh
            item.ggxh = sl_str if not old_ggxh else old_ggxh + ' ' + sl_str
            item.sl = ''
            adjustments.append({
                'row': row_idx, 'field': 'sl',
                'old_value': old_sl, 'new_value': '',
                'reason': f'sl 匹配规格型号模式 {pattern}，移至 ggxh',
            })
            adjustments.append({
                'row': row_idx, 'field': 'ggxh',
                'old_value': old_ggxh, 'new_value': item.ggxh,
                'reason': '从 sl 移入规格型号',
            })
            return adjustments

    return adjustments


def _post_process(item: InvoiceLineItem, row_idx: int = 0) -> list:
    adjustments = []
    adjustments.extend(_fix_sl_if_looks_like_ggxh(item, row_idx))
    adjustments.extend(_derive_missing_tax(item, row_idx))
    adjustments.extend(_cross_validate_and_fix(item, row_idx))
    adjustments.extend(_validate_tax_equation(item, row_idx))
    from field_extractor.models import LineItemAdjustment
    return [LineItemAdjustment(**adj) if isinstance(adj, dict) else adj
            for adj in adjustments]


def _derive_missing_tax(item: InvoiceLineItem, row_idx: int = 0) -> list:
    adjustments = []
    if not item.je:
        return adjustments
    try:
        je_f = float(item.je)
    except (ValueError, TypeError):
        return adjustments
    if je_f == 0:
        return adjustments

    if item.slv and not item.se and item.slv != '免税':
        rate_str = item.slv.rstrip('%')
        try:
            rate = float(rate_str)
            se = je_f * rate / 100
            new_se = f"{se:.2f}"
            if se < 100:
                item.se = new_se
                adjustments.append({
                    'row': row_idx, 'field': 'se',
                    'old_value': '', 'new_value': new_se,
                    'reason': '税额缺失，根据金额和税率计算',
                    'auto_applied': True, 'confidence': 0.95,
                })
            else:
                adjustments.append({
                    'row': row_idx, 'field': 'se',
                    'old_value': '', 'new_value': new_se,
                    'reason': '税额缺失，候选值（大额未自动应用）',
                    'auto_applied': False, 'confidence': 0.85,
                })
        except (ValueError, TypeError):
            pass

    if item.se and not item.slv:
        try:
            se_f = float(item.se)
        except (ValueError, TypeError):
            return adjustments
        if abs(je_f) < _TAX_DERIVE_MIN_JE and abs(se_f) < _TAX_DERIVE_MIN_SE:
            return adjustments
        if se_f == 0:
            item.slv = '0%'
            adjustments.append({
                'row': row_idx, 'field': 'slv',
                'old_value': '', 'new_value': '0%',
                'reason': '税额为0，税率设为0%',
                'auto_applied': True, 'confidence': 0.98,
            })
            return adjustments
        rate = se_f / je_f * 100
        for r in _STANDARD_RATES:
            if abs(rate - r) < 0.5:
                item.slv = f"{r}%"
                adjustments.append({
                    'row': row_idx, 'field': 'slv',
                    'old_value': '', 'new_value': f"{r}%",
                    'reason': f'税率缺失，根据税额和金额计算为{r}%',
                    'auto_applied': True, 'confidence': 0.92,
                })
                return adjustments
        item.slv = f"{round(rate, 1)}%"
        adjustments.append({
            'row': row_idx, 'field': 'slv',
            'old_value': '', 'new_value': f"{round(rate, 1)}%",
            'reason': f'税率缺失，计算为{round(rate, 1)}%（非标准税率）',
            'auto_applied': True, 'confidence': 0.80,
        })
    return adjustments


def _cross_validate_and_fix(item: InvoiceLineItem, row_idx: int = 0) -> list:
    adjustments = []
    if not (item.sl and item.dj and item.je):
        return adjustments
    try:
        sl_f = float(item.sl)
        dj_f = float(item.dj)
        je_f = float(item.je)
    except (ValueError, TypeError):
        return adjustments
    if sl_f == 0 or dj_f == 0 or je_f == 0:
        return adjustments

    expected = sl_f * dj_f
    diff = abs(expected - je_f)
    tolerance = max(abs(je_f) * _CROSS_VALIDATE_TOLERANCE_RATIO,
                    _CROSS_VALIDATE_TOLERANCE_MIN)
    if diff <= tolerance:
        return adjustments

    best_sl, best_dj = item.sl, item.dj
    best_diff = diff
    sl_cands = _generate_correction_candidates(item.sl)
    dj_cands = _generate_correction_candidates(item.dj)

    for sl_c in [item.sl] + sl_cands:
        for dj_c in [item.dj] + dj_cands:
            if sl_c == item.sl and dj_c == item.dj:
                continue
            try:
                sv = float(sl_c)
                dv = float(dj_c)
            except (ValueError, TypeError):
                continue
            if sv == 0 or dv == 0:
                continue
            d = abs(sv * dv - je_f)
            if d < best_diff:
                best_diff = d
                best_sl = sl_c
                best_dj = dj_c

    new_tolerance = max(abs(je_f) * _CROSS_VALIDATE_TOLERANCE_RATIO,
                        _CROSS_VALIDATE_TOLERANCE_MIN)
    is_large_diff = diff > 10
    is_discount = je_f < 0 or expected < 0

    if best_diff < diff and best_diff <= new_tolerance * 5:
        if best_sl != item.sl or best_dj != item.dj:
            old_sl, old_dj = item.sl, item.dj
            if is_large_diff or is_discount:
                adjustments.append({
                    'row': row_idx, 'field': 'sl',
                    'old_value': old_sl, 'new_value': best_sl,
                    'reason': '数量×单价≠金额，候选修正',
                    'auto_applied': False, 'confidence': 0.75,
                })
                adjustments.append({
                    'row': row_idx, 'field': 'dj',
                    'old_value': old_dj, 'new_value': best_dj,
                    'reason': '数量×单价≠金额，候选修正',
                    'auto_applied': False, 'confidence': 0.75,
                })
            else:
                item.sl = best_sl
                item.dj = best_dj
                adjustments.append({
                    'row': row_idx, 'field': 'sl',
                    'old_value': old_sl, 'new_value': best_sl,
                    'reason': '数量×单价≠金额，自动修正',
                    'auto_applied': True, 'confidence': 0.88,
                })
                adjustments.append({
                    'row': row_idx, 'field': 'dj',
                    'old_value': old_dj, 'new_value': best_dj,
                    'reason': '数量×单价≠金额，自动修正',
                    'auto_applied': True, 'confidence': 0.88,
                })
    return adjustments


def _validate_tax_equation(item: InvoiceLineItem, row_idx: int = 0) -> list:
    adjustments = []
    if not (item.je and item.slv and item.se):
        return adjustments
    if item.slv == '免税':
        return adjustments
    try:
        je_f = float(item.je)
        se_f = float(item.se)
        rate = float(item.slv.rstrip('%'))
    except (ValueError, TypeError):
        return adjustments

    is_red_invoice = je_f < 0 or se_f < 0

    if item.sl and item.dj:
        try:
            sl_f = float(item.sl)
            dj_f = float(item.dj)
            if sl_f > 1 and abs(je_f - dj_f) < 0.01:
                correct_je = dj_f * sl_f
                old_je = item.je
                if is_red_invoice:
                    adjustments.append({
                        'row': row_idx, 'field': 'je',
                        'old_value': old_je, 'new_value': f"{correct_je:.2f}",
                        'reason': '金额等于单价且数量>1，候选修正（红字发票）',
                        'auto_applied': False, 'confidence': 0.70,
                    })
                else:
                    item.je = f"{correct_je:.2f}"
                    je_f = correct_je
                    adjustments.append({
                        'row': row_idx, 'field': 'je',
                        'old_value': old_je, 'new_value': f"{correct_je:.2f}",
                        'reason': '金额等于单价且数量>1，自动修正',
                        'auto_applied': True, 'confidence': 0.90,
                    })
        except (ValueError, TypeError):
            pass

    expected_se = je_f * rate / 100
    diff = abs(expected_se - se_f)
    tolerance = max(abs(se_f) * _CROSS_VALIDATE_TOLERANCE_RATIO,
                    _CROSS_VALIDATE_TOLERANCE_MIN)

    if diff > tolerance:
        old_se = item.se
        is_small_diff = diff < 1
        is_zero_rate = abs(rate) < 0.01 or item.slv == '0%'
        should_auto_apply = is_small_diff and not is_red_invoice and not is_zero_rate

        if should_auto_apply:
            item.se = f"{expected_se:.2f}"
            adjustments.append({
                'row': row_idx, 'field': 'se',
                'old_value': old_se, 'new_value': f"{expected_se:.2f}",
                'reason': '金额×税率校验，小额四舍五入自动修正',
                'auto_applied': True, 'confidence': 0.91,
            })
        else:
            reason = '金额×税率校验'
            if is_red_invoice:
                reason += '（红字发票）'
            elif is_zero_rate:
                reason += '（零税率）'
            elif not is_small_diff:
                reason += '（大额差异）'
            adjustments.append({
                'row': row_idx, 'field': 'se',
                'old_value': old_se, 'new_value': f"{expected_se:.2f}",
                'reason': f'{reason}，候选修正',
                'auto_applied': False, 'confidence': 0.80,
            })
    return adjustments


def _generate_correction_candidates(val_str: str) -> list[str]:
    clean = val_str.replace(',', '').replace(' ', '')
    try:
        val = float(clean)
    except (ValueError, TypeError):
        return []
    if val == 0:
        return []
    candidates: list[str] = []
    seen: set[str] = {clean}
    for factor in [0.1, 0.01, 0.001, 10.0, 100.0, 1000.0]:
        new_val = val * factor
        if abs(new_val) < 1e-12:
            continue
        if abs(new_val - round(new_val)) < 1e-9:
            s = str(int(round(new_val)))
        else:
            s = f"{new_val:.6f}".rstrip('0').rstrip('.')
        if s not in seen:
            candidates.append(s)
            seen.add(s)
    return candidates


# ═══════════════════════════════════════════════════════
#  [FIX-1] 新增：表行预拆分 → 垂直格式
# ═══════════════════════════════════════════════════════

# 表格式行的星号类别正则（行首 *xxx* 开头的明细名称行）
_TABLE_STAR_LINE_RE = re.compile(
    r'^\s*\*[^*]+\*'
)

# 负数金额 token
_NEGATIVE_AMOUNT_RE = re.compile(r'^-[\d,]+\.\d{1,2}$')


def _split_table_row(line: str) -> list[str]:
    """将表格式行拆分为多行垂直格式。

    表格式行的特征：一行中同时包含项目名称(*xxx*)和数据值
    （单位/数量/单价/金额/税率/税额）。

    拆分策略：
    1. 找到星号类别名称的结束位置
    2. 名称后的内容按空格拆分为 tokens
    3. 名称 token 归入名称行，数据 token 各自独立成行
    4. 名称续行（纯中文、无数字）归入名称行

    返回：拆分后的行列表（垂直格式）
    """
    stripped = line.strip()
    if not stripped:
        return [line]

    # 找星号类别
    star_match = _TOKEN_STAR_CATEGORY_RE.search(stripped)
    if not star_match:
        return [line]

    # 星号类别后的部分
    after_star = stripped[star_match.end():].strip()
    star_part = stripped[:star_match.end()]

    if not after_star:
        return [line]

    # 把星号类别后的部分按空格拆分为 tokens
    after_tokens = after_star.split()
    if not after_tokens:
        return [line]

    # 分类：名称 token vs 数据 token
    name_tokens = []
    data_tokens = []
    found_first_data = False

    for token in after_tokens:
        if found_first_data:
            data_tokens.append(token)
            continue

        # 数据值判断（单位/数量/金额/税率）
        if _is_token_data_value(token):
            found_first_data = True
            data_tokens.append(token)
            continue

        # 长纯数字（可能是规格型号，但也可能是数量/金额的误判）
        # 对于长度<=6的纯数字，在未发现数据前暂时归入名称
        if re.match(r'^\d+$', token) and len(token) <= 6:
            name_tokens.append(token)
            continue

        # 纯中文短文本 → 名称续行
        if re.fullmatch(r'[\u4e00-\u9fff]+', token):
            name_tokens.append(token)
            continue

        # 其他字母数字 token（如规格型号）
        name_tokens.append(token)

    # 组装拆分结果
    result_lines = []

    # 名称行：星号类别 + 名称续行 tokens
    name_line = star_part
    if name_tokens:
        name_line += ' ' + ' '.join(name_tokens)
    result_lines.append(name_line)

    # 数据行：每个数据 token 独立成行
    for dt in data_tokens:
        result_lines.append(dt)

    return result_lines


# [FIX] 拆分无空格合并行的辅助函数
# OCR 垂直文本合并后可能丢失空格，如 "*劳务*运费次14.424.4213%0.58"
# 需要用数字/单位/税率模式在字符串中切分


def _split_collapsed_item(text: str) -> List[str]:
    """将无空格的合并文本按数字/单位/税率模式拆分为独立 token。

    Args:
        text: 如 "运费次14.424.4213%0.58"

    Returns:
        拆分后的 token 列表，如 ['运费次', '1', '4.42', '4.42', '13%', '0.58']
    """
    # 策略：从左到右扫描，识别数据模式
    tokens = []
    i = 0
    while i < len(text):
        # 先尝试匹配金额/单价: xx.yy (4.42, 131.86, 0.58)
        # 必须在税率之前匹配，避免税率模式越界吞噬 "4.4213%"
        m = re.match(r'(\d+\.\d{2})', text[i:])
        if m:
            val = m.group(1)
            # 特殊处理：如 "14.42" 实际上是数量"1" + 金额"4.42"
            # 只在金额很小（≤5.0）时拆分，避免误拆税额如 17.14
            dot_pos = val.index('.')
            prefix_digits = val[:dot_pos]
            if len(prefix_digits) == 2 and prefix_digits.isdigit():
                qty = prefix_digits[0]
                amount_val = float(prefix_digits[1] + val[dot_pos:])
                if qty == '1' and amount_val <= 5.0:
                    tokens.append(qty)
                    tokens.append(prefix_digits[1] + val[dot_pos:])
                    i += len(val)
                    continue
            # 普通金额
            tokens.append(val)
            i += len(val)
            continue

        # 尝试匹配税率: 13% 1% （标准中文发票税率，整数或简单小数）
        m = re.match(r'(\d{1,2}(?:\.\d{1,2})?%)', text[i:])
        if m:
            tokens.append(m.group(1))
            i += m.end()
            continue

        # 尝试匹配纯数字（数量等）
        m = re.match(r'(\d+)', text[i:])
        if m:
            tokens.append(m.group(1))
            i += m.end()
            continue

        # 中文/字母文本 → 收集连续的非数字字符
        m = re.match(r'([^\d]+)', text[i:])
        if m:
            tokens.append(m.group(1))
            i += m.end()
            continue

        # 不应到达这里，但安全处理
        tokens.append(text[i])
        i += 1

    return tokens


def _prepare_lines(lines: List[str]) -> List[str]:
    """[FIX-1] 进入垂直/标准路径前的预处理：拆分表格式行。"""
    result: List[str] = []
    star_line_count = 0
    split_count = 0

    for line in lines:
        stripped = line.strip()
        if not stripped:
            result.append(line)
            continue

        # 检查是否为表格式行（星号类别 + 数据值在同一行）
        if _TABLE_STAR_LINE_RE.search(stripped):
            star_line_count += 1
            after_star_match = _TOKEN_STAR_CATEGORY_RE.search(stripped)
            if after_star_match:
                after_star = stripped[after_star_match.end():].strip()
                if after_star:
                    # 检查星号后是否包含数据值 token
                    after_tokens = after_star.split()
                    has_data = any(_is_token_data_value(t)
                                   for t in after_tokens)
                    if has_data:
                        # 表格式行 → 拆分
                        split_lines = _split_table_row(stripped)
                        result.extend(split_lines)
                        split_count += 1
                        logger.debug(
                            "[LineItem/Prepare] 拆分表行: '%s' → %d lines",
                            stripped[:60], len(split_lines))
                        continue

                    # [FIX] 星号后无空格合并行：用数字/单位模式拆分
                    if len(after_tokens) == 1:
                        # [FIX] 先检查星号后文本是否包含金额/税率模式，避免将规格型号行
                        # (如 "*家用厨房电器具*316L不") 误判为无空格合并数据行进行拆分。
                        # 真正的合并数据行一定包含 xx.xx 金额或 xx% 税率模式。
                        has_amount = bool(re.search(r'\d+\.\d{2}', after_star))
                        has_rate = bool(re.search(r'\d{1,2}(?:\.\d{1,2})?%', after_star))
                        if not (has_amount or has_rate):
                            logger.debug(
                                "[LineItem/Prepare] 星号后续无金额/税率模式，跳过拆分: "
                                "'%s'...", after_star[:40])
                            result.append(line)
                            continue

                        split_by_data = _split_collapsed_item(after_star)
                        logger.info("[LineItem/Prepare] 无空格行: star='%s' after='%s' split=%s",
                                    after_star_match.group()[:20], after_star[:40], split_by_data)
                        if len(split_by_data) >= 2:
                            prefix = stripped[:after_star_match.end()]
                            split_lines = [prefix]
                            split_lines.extend(split_by_data)
                            result.extend(split_lines)
                            split_count += 1
                            logger.debug(
                                "[LineItem/Prepare] 拆分无空格合并行: '%s' → %s",
                                after_star[:40], split_by_data)
                            continue
                        else:
                            logger.debug(
                                "[LineItem/Prepare] 无空格行无法拆分: '%s' → %s",
                                after_star[:40], split_by_data)
                    else:
                        logger.debug(
                            "[LineItem/Prepare] 星号行无数据值(has_data=False): '%s' after_tokens=%s",
                            stripped[:60], [t[:15] for t in after_tokens[:6]])

        result.append(line)

    if star_line_count > 0:
        logger.info("[LineItem/Prepare] 星号行: %d 行, 拆分: %d 行",
                    star_line_count, split_count)

    return result


# ═══════════════════════════════════════════════════════
#  v9 预处理: 孤行合并
# ═══════════════════════════════════════════════════════

def _preprocess_orphan_lines(lines: List[str]) -> List[str]:
    if not lines:
        return []

    def _has_data(line: str) -> bool:
        tokens = list(_tokenize_line(line))
        has_data_result = False
        for t in tokens:
            clean = t.replace(',', '').replace('¥', '').replace('￥', '')
            if _is_amount(t) or _is_relaxed_amount(t) or _RATE_RE.match(t):
                has_data_result = True
                break
            if t in _COMMON_UNITS:
                has_data_result = True
                break
            if re.match(r'^\d+$', t) and len(t) <= 10:
                has_data_result = True
                break
        if not has_data_result and line.strip() and len(tokens) >= 1:
            logger.debug("[LineItem/Orphan] 无数据标记: '%s' tokens=%s", line.strip()[:40], list(tokens)[:5])
        return has_data_result

    result: List[str] = []
    pending: List[str] = []
    _MAX_PENDING = 4

    def _is_header_noise(line: str) -> bool:
        s = line.strip()
        if not s:
            return True
        # [PERF] 使用模块级 frozenset
        if len(s) == 1 and s in _HEADER_SINGLE_CHARS_FROZEN:
            return True
        if _HEADER_FIELD_RE.search(s):
            return True
        return False

    for line in lines:
        # [FIX-3] 星号边界检测：遇到新的明细项前缀时先刷新 pending
        if _TOKEN_STAR_CATEGORY_RE.search(line.strip()):
            if pending and result:
                # 把 pending 合并到上一行（名称续行）
                result[-1] = result[-1] + ' ' + ' '.join(pending)
                pending = []

        if _has_data(line):
            if pending:
                if len(pending) <= _MAX_PENDING:
                    merged = ' '.join(pending) + ' ' + line
                    result.append(merged.strip())
                else:
                    kept = pending[-_MAX_PENDING:]
                    merged = ' '.join(kept) + ' ' + line
                    result.append(merged.strip())
                pending = []
            else:
                result.append(line)
        else:
            if not _is_header_noise(line):
                pending.append(line)

    if pending:
        if result:
            name_parts = [p for p in pending if _is_name_only_line(p)]
            if name_parts:
                result[-1] = result[-1] + ' ' + ' '.join(name_parts)
        else:
            result.extend(pending)

    return result


# ═══════════════════════════════════════════════════════
#  OCR-Aware Tokenizer
# ═══════════════════════════════════════════════════════

def _tokenize_line(line: str) -> tuple[str, ...]:
    line_parts = re.split(r'\s+', line.strip())
    tokens: list[str] = []
    for part in line_parts:
        if not part:
            continue
        raw_tokens = _TOKEN_RE.findall(part)
        for t in raw_tokens:
            if not t:
                continue
            if _is_blacklisted_token(t):
                continue
            tokens.append(_normalize_numeric_token(t))
    if not tokens and line.strip():
        if not re.search(r'[\d¥￥%.,]', line.strip()):
            tokens.append(line.strip())
    if len(tokens) <= 1 and line.strip():
        logger.debug("[LineItem/Tokenize] '%s' → %d tokens: %s", line.strip()[:40], len(tokens), tokens[:6])
    return tuple(tokens)


def _normalize_numeric_token(token: str) -> str:
    """OCR 数字修正（保留 ¥ 前缀）"""
    if token.startswith('¥') or token.startswith('￥'):
        return token
    if not _NUMERICISH_RE.match(token):
        return token
    normalized = token.translate(_OCR_DIGIT_MAP)
    if _NUMBER_RE.match(normalized) or _AMOUNT_RE.match(normalized):
        return normalized
    return token


# ═══════════════════════════════════════════════════════
#  v9 文本路径
# ═══════════════════════════════════════════════════════

class _TextLineParser:

    def extract(self, seg: DocumentSegment,
                return_adjustments: bool = False):
        if not seg.lines:
            return ([], []) if return_adjustments else []

        # [FIX-1] 进入任何解析路径前，先预处理表格式行
        prepared_lines = _prepare_lines(seg.lines)

        if self._is_vertical_layout(prepared_lines):
            logger.debug("[LineItem/Text] 垂直布局，使用垂直组装路径")
            return self._extract_vertical(prepared_lines, return_adjustments)

        merged_lines = _preprocess_orphan_lines(prepared_lines)

        items: list[InvoiceLineItem] = []
        adjustments: list = []
        parsed_count = 0

        for line in merged_lines:
            stripped = line.strip()
            if not stripped:
                continue
            if _TOKEN_SUMMARY_RE.search(stripped):
                break
            tokens = list(_tokenize_line(stripped))
            if not tokens or len(tokens) < _MIN_TOKENS:
                line_parts = re.split(r'\s+', stripped)
                logger.debug("[LineItem/Text] token不足(%d<%d): '%s' split=%s",
                             len(tokens), _MIN_TOKENS, stripped[:60],
                             [p[:15] for p in line_parts if p][:8])
                continue

            item = self._parse_tokens(tokens)
            parsed_count += 1

            if item and item.je:
                adj = _post_process(item, len(items))
                adjustments.extend(adj)
                items.append(item)
                if logger.isEnabledFor(logging.DEBUG):
                    logger.debug(
                        "[LineItem/Text] #%d: xmmc='%s' ggxh='%s' dw='%s' "
                        "sl=%s dj=%s je=%s slv=%s se=%s",
                        len(items), item.xmmc, item.ggxh, item.dw,
                        item.sl, item.dj, item.je, item.slv, item.se)
            elif item and item.xmmc:
                logger.debug("[LineItem/Text] 仅名称无金额: '%s'", item.xmmc)
            else:
                log_fn = logger.warning if not items else logger.debug
                log_fn("[LineItem/Text] 无法解析: '%s'", stripped)

        if return_adjustments:
            return items, adjustments
        return items

    # ── 垂直布局检测 ──

    @staticmethod
    def _is_vertical_layout(lines: List[str]) -> bool:
        if len(lines) < 5:
            return False
        short_lines = 0
        single_char_lines = 0
        digit_only_lines = 0
        has_unit = False
        has_rate = False
        has_amount = False
        has_star_prefix = False

        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            parts = stripped.split()
            if len(parts) <= 2:
                short_lines += 1
            if len(stripped) == 1 and '\u4e00' <= stripped <= '\u9fff':
                single_char_lines += 1
            if re.match(r'^\d+$', stripped) and len(stripped) <= 10:
                digit_only_lines += 1
            if stripped in _COMMON_UNITS:
                has_unit = True
            if _RATE_RE.match(stripped):
                has_rate = True
            if _AMOUNT_RE.match(stripped) or _AMOUNT_LOOSE_RE.match(stripped):
                has_amount = True
            if _TOKEN_STAR_CATEGORY_RE.search(stripped):
                has_star_prefix = True

        total = len([l for l in lines if l.strip()])
        if total == 0:
            return False

        short_ratio = short_lines / total
        feature_count = sum([has_unit, has_rate, has_amount, has_star_prefix])

        if short_ratio >= 0.6 and feature_count >= 2:
            return True

        single_char_ratio = single_char_lines / total
        digit_ratio = digit_only_lines / total
        if (single_char_ratio >= 0.2 or digit_ratio >= 0.15) \
                and feature_count >= 1:
            return True

        return False

    # ── 垂直组装路径 ──

    def _extract_vertical(self, lines: List[str],
                          return_adjustments: bool = False):
        return self._manual_vertical_assemble(lines, return_adjustments)

    def _manual_vertical_assemble(self, lines: List[str],
                                  return_adjustments: bool = False):
        star_indices = []
        for idx, line in enumerate(lines):
            if _TOKEN_STAR_CATEGORY_RE.search(line.strip()):
                star_indices.append(idx)

        if len(star_indices) <= 1:
            return self._assemble_single_item(lines, return_adjustments)

        return self._assemble_multi_items(lines, star_indices,
                                          return_adjustments)

    def _assign_integer_candidates(self, item: InvoiceLineItem,
                                   integer_candidates: list[str]) -> None:
        if not integer_candidates:
            return
        if item.sl and item.dj:
            return

        je_f = None
        if item.je:
            try:
                je_f = float(item.je)
            except (ValueError, TypeError):
                pass

        if len(integer_candidates) == 1:
            val = integer_candidates[0]
            if not item.sl:
                item.sl = val
            elif not item.dj:
                item.dj = val
            return

        num_candidates = []
        for c in integer_candidates:
            try:
                num_candidates.append((c, float(c)))
            except (ValueError, TypeError):
                continue

        if len(num_candidates) < 2:
            for c, _ in num_candidates:
                if not item.sl:
                    item.sl = c
                elif not item.dj:
                    item.dj = c
            return

        best_sl = None
        best_dj = None
        best_score = float('inf')

        for i in range(len(num_candidates)):
            for j in range(len(num_candidates)):
                if i == j:
                    continue
                sl_str, sl_f = num_candidates[i]
                dj_str, dj_f = num_candidates[j]
                if sl_f == 0 or dj_f == 0:
                    continue

                if je_f is not None and je_f != 0:
                    diff = abs(sl_f * dj_f - je_f)
                    score = diff
                    if not _is_integer_like(sl_f):
                        score += 1.0
                    if sl_f > dj_f:
                        score += 0.5
                else:
                    score = 0
                    if sl_f > dj_f:
                        score += 1.0
                    if not _is_integer_like(sl_f):
                        score += 0.5

                if score < best_score:
                    best_score = score
                    best_sl = sl_str
                    best_dj = dj_str

        if best_sl is not None and not item.sl:
            item.sl = best_sl
        if best_dj is not None and not item.dj:
            item.dj = best_dj

    def _assemble_single_item(self, lines: List[str],
                              return_adjustments: bool = False):
        item = InvoiceLineItem()
        adjustments = []
        name_parts = []
        spec_parts = []
        amount_values = []
        rate_value = ''
        integer_candidates = []

        _NOISE_RE = re.compile(
            r'^(?:下载次数|订单号|下载链接|发票代码|校验码|机器编号)'
            r'|^\d{15,}$'
            r'|^\d{4,}-\d{10,}$'
        )

        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if re.match(r'^[¥￥]', stripped):
                continue
            if _NOISE_RE.search(stripped):
                continue
            if _RATE_RE.match(stripped) and not rate_value:
                rate_value = stripped
                continue
            if _AMOUNT_RE.match(stripped):
                amount_values.append(stripped)
                continue
            if re.match(r'^\d+\.\d{5,}$', stripped):
                if not item.dj:
                    item.dj = stripped
                continue
            if re.match(r'^\d+$', stripped) and len(stripped) <= 10:
                integer_candidates.append(stripped)
                continue
            if _AMOUNT_LOOSE_RE.match(stripped) and '.' in stripped:
                amount_values.append(stripped)
                continue
            if stripped in _COMMON_UNITS and not item.dw:
                item.dw = stripped
                continue
            if _TOKEN_STAR_CATEGORY_RE.search(stripped):
                name_parts.append(stripped)
                continue
            if _is_spec_like_token(stripped):
                spec_parts.append(stripped)
            elif _is_name_suffix_token(stripped) and not (amount_values or rate_value):
                name_parts.append(stripped)
            elif _is_name_suffix_token(stripped) and (amount_values or rate_value):
                name_parts.append(stripped)
            elif not (amount_values or rate_value):
                name_parts.append(stripped)
            else:
                spec_parts.append(stripped)

        if name_parts:
            item.xmmc = ' '.join(name_parts)
        if spec_parts:
            item.ggxh = ' '.join(spec_parts)
        if rate_value:
            item.slv = rate_value

        if len(amount_values) >= 2:
            exact_amounts = [v for v in amount_values if _AMOUNT_RE.match(v)]
            loose_amounts = [v for v in amount_values if not _AMOUNT_RE.match(v)]

            allocated = False

            # [FIX] 税率推导：用 je × slv ≈ se 识别税额，避免按顺序误分配
            if len(exact_amounts) >= 2 and item.slv and item.slv != '免税':
                try:
                    rate_val = float(item.slv.rstrip('%'))
                    if abs(rate_val) > 0.001:
                        se_idx = None
                        for idx_c, v in enumerate(exact_amounts):
                            for idx_a, a in enumerate(exact_amounts):
                                if idx_c == idx_a:
                                    continue
                                try:
                                    expected_se = float(a) * rate_val / 100
                                    if abs(expected_se - float(v)) < 0.02:
                                        se_idx = idx_c
                                        break
                                except (ValueError, TypeError):
                                    pass
                            if se_idx is not None:
                                break

                        if se_idx is not None:
                            item.se = exact_amounts[se_idx]
                            remaining = [
                                exact_amounts[i]
                                for i in range(len(exact_amounts))
                                if i != se_idx
                            ]
                            if len(remaining) >= 2:
                                # [FIX] 用税率交叉校验确定 je：je × slv / 100 ≈ se
                                je_found = False
                                for rv in remaining:
                                    try:
                                        if abs(float(rv) * rate_val / 100
                                               - float(item.se)) < 0.02:
                                            item.je = rv
                                            # 仅在 dj 未设置时才从 remaining 推导
                                            if not item.dj:
                                                dj_candidates = [x for x in remaining
                                                                if x != rv]
                                                if dj_candidates:
                                                    item.dj = dj_candidates[0]
                                            je_found = True
                                            break
                                    except (ValueError, TypeError):
                                        pass
                                if not je_found:
                                    # 回退：小数位多的更可能是单价
                                    dec_lens = [
                                        (len(v.split('.')[-1]) if '.' in v else 0, v)
                                        for v in remaining]
                                    dec_lens.sort(key=lambda x: -x[0])
                                    if dec_lens[0][0] >= 4:
                                        item.dj = dec_lens[0][1]
                                        item.je = dec_lens[1][1]
                                    else:
                                        item.je = remaining[0]
                                        item.dj = remaining[1]
                            elif len(remaining) == 1:
                                item.je = remaining[0]
                                if loose_amounts:
                                    item.dj = loose_amounts[0]
                            allocated = True
                except (ValueError, TypeError):
                    pass

            if not allocated:
                if len(exact_amounts) >= 2:
                    item.je = exact_amounts[0]
                    item.se = exact_amounts[1]
                    if loose_amounts:
                        item.dj = loose_amounts[0]
                elif len(exact_amounts) == 1:
                    item.je = exact_amounts[0]
                    if loose_amounts:
                        item.dj = loose_amounts[0]
                        remaining = [v for v in amount_values
                                     if v not in (exact_amounts + loose_amounts[0:1])]
                        if remaining:
                            item.se = remaining[0]
                else:
                    if len(amount_values) >= 3:
                        item.dj = amount_values[0]
                        item.je = amount_values[1]
                        item.se = amount_values[2]
                    elif len(amount_values) >= 2:
                        item.je = amount_values[0]
                        item.se = amount_values[1]
                    elif len(amount_values) == 1:
                        item.je = amount_values[0]
        elif len(amount_values) == 1:
            item.je = amount_values[0]

        self._assign_integer_candidates(item, integer_candidates)

        if item.dj and item.je and item.dj == item.je:
            try:
                if item.sl and float(item.sl) > 1:
                    item.dj = ''
            except (ValueError, TypeError):
                pass
        if item.sl and item.je and not item.dj:
            try:
                sl_f = float(item.sl)
                je_f = float(item.je)
                if sl_f > 0:
                    item.dj = f"{je_f / sl_f:.2f}"
            except (ValueError, ZeroDivisionError):
                pass

        if item.je:
            adj = _post_process(item, 0)
            adjustments.extend(adj)
            logger.debug(
                "[LineItem/Vert/Manual] xmmc='%s' ggxh='%s' dw='%s' "
                "sl=%s dj=%s je=%s slv=%s se=%s",
                item.xmmc, item.ggxh, item.dw,
                item.sl, item.dj, item.je, item.slv, item.se)
            if return_adjustments:
                return [item], adjustments
            return [item]

        if item.xmmc:
            logger.debug("[LineItem/Vert/Manual] 仅名称无金额: '%s'",
                         item.xmmc)
        if return_adjustments:
            return [], adjustments
        return []

    # [FIX-4] [FIX-7] 重写 _assemble_multi_items：star-index 驱动 + 税率推导金额分配
    def _assemble_multi_items(self, lines: List[str],
                              star_indices: List[int],
                              return_adjustments: bool = False):
        """多项目垂直布局组装。

        [FIX] 核心改动：
        1. Step 1: 按 star-index 边界划分名称组
        2. Step 2: 预分离 name/spec
        3. Step 4: 按 star-index 边界收集数据块
        [FIX-4] Step 1 增加 _HEADER_FIELD_RE 过滤
        [FIX-7] Step 6 金额分配增加税率推导，区分金额与税额
        """
        adjustments = []

        # ══════════════════════════════════════════════════
        # Step 1+4: 单次扫描同时收集名称组和数据块
        # [PERF] 原 Step1 和 Step4 各自遍历相同 line range，现合并为一次
        # ══════════════════════════════════════════════════
        name_groups: list[list[str]] = []
        item_data_blocks: list[list[str]] = []
        for item_idx in range(len(star_indices)):
            start = star_indices[item_idx]
            end = (star_indices[item_idx + 1]
                   if item_idx + 1 < len(star_indices)
                   else len(lines))

            name_group = []
            data_block = []
            for i in range(start, end):
                stripped = lines[i].strip()
                if not stripped:
                    continue
                # 过滤表头噪声
                if _HEADER_FIELD_RE.search(stripped):
                    continue
                if _TOKEN_STAR_CATEGORY_RE.search(stripped):
                    name_group.append(stripped)
                    # star/category 行不归入 data_block
                elif _is_data_value(stripped) or stripped in _COMMON_UNITS:
                    data_block.append(stripped)
                elif not _is_data_value(stripped):
                    name_group.append(stripped)
            if name_group:
                name_groups.append(name_group)
            item_data_blocks.append(data_block)

        if not name_groups:
            return ([], []) if return_adjustments else []

        # ══════════════════════════════════════════════════
        # Step 2: 从名称组预提取 clean_name 和 spec
        # ══════════════════════════════════════════════════
        unique_names: list[str] = []
        unique_specs: list[str] = []

        for group in name_groups:
            star_line = ''
            spec_parts: list[str] = []
            name_continuation: list[str] = []
            name_suffix_parts: list[str] = []
            past_star = False

            for g in group:
                g_stripped = g.strip()
                if _TOKEN_STAR_CATEGORY_RE.search(g_stripped):
                    star_line = g_stripped
                    past_star = True
                elif past_star:
                    if _is_spec_like_token(g_stripped):
                        spec_parts.append(g_stripped)
                    elif _is_name_suffix_token(g_stripped):
                        name_suffix_parts.append(g_stripped)
                    else:
                        if (len(g_stripped) <= 20
                                and re.search(r'[A-Za-z0-9]', g_stripped)
                                and not re.search(r'[\u4e00-\u9fff]{4,}',
                                                  g_stripped)):
                            spec_parts.append(g_stripped)
                        else:
                            name_continuation.append(g_stripped)

            clean_name = star_line
            if name_continuation:
                clean_name += ' ' + ' '.join(name_continuation)
            if name_suffix_parts:
                clean_name = _join_name_parts(
                    [clean_name] + name_suffix_parts)
            unique_names.append(clean_name.strip())
            unique_specs.append(' '.join(spec_parts))

        # ══════════════════════════════════════════════════
        # Step 3+4: 已在 Step 1+4 合并完成
        # ══════════════════════════════════════════════════
        num_names = len(unique_names)

        logger.debug("[LineItem/Vert/Multi] star_indices=%s, "
                     "names=%d, data_blocks=%d",
                     star_indices, num_names, len(item_data_blocks))

        # ══════════════════════════════════════════════════
        # Step 5: 匹配名称和数据块
        # ══════════════════════════════════════════════════

        # ══════════════════════════════════════════════════
        # Step 6: 组装每个项目
        # ══════════════════════════════════════════════════
        items: list[InvoiceLineItem] = []
        num_items = min(num_names, len(item_data_blocks))

        for name_idx in range(num_items):
            clean_name = unique_names[name_idx]
            spec_text = unique_specs[name_idx]
            data_block = item_data_blocks[name_idx]
            item = InvoiceLineItem()

            item.xmmc = clean_name

            if spec_text:
                # [PERF] 使用模块级预编译正则
                parts = spec_text.rsplit(' ', 1)
                if len(parts) == 2 and _BARCODE_SPEC_RE.match(parts[1]):
                    item.ggxh = parts[1]
                    item.xmmc = _BARCODE_TRAIL_RE.sub('', item.xmmc) \
                        if item.xmmc else item.xmmc
                else:
                    item.ggxh = spec_text

            amount_values = []
            negative_amounts = []
            integer_candidates = []

            for dl in data_block:
                if _RATE_RE.match(dl):
                    if not item.slv:
                        item.slv = dl
                    continue
                if dl in _COMMON_UNITS and not item.dw:
                    item.dw = dl
                    continue
                if re.match(r'^-[\d,]+\.\d{1,2}$', dl):
                    negative_amounts.append(dl)
                    continue
                if re.match(r'^\d+\.\d{5,}$', dl):
                    if not item.dj:
                        item.dj = dl
                    continue
                if re.match(r'^\d+$', dl) and len(dl) <= 10:
                    integer_candidates.append(dl)
                    continue
                if _AMOUNT_RE.match(dl):
                    amount_values.append(dl)
                    continue
                if _AMOUNT_LOOSE_RE.match(dl) and '.' in dl:
                    amount_values.append(dl)
                    continue
                if not spec_text and not item.ggxh:
                    if len(dl) <= 30 and (
                            _spec_score(dl) >= 1
                            or re.match(r'^[\w\-/]+$', dl)):
                        item.ggxh = dl

            # [FIX-7] 分配金额：利用税率推导区分金额与税额
            exact_amounts = [v for v in amount_values
                             if _AMOUNT_RE.match(v)]
            loose_amounts = [v for v in amount_values
                             if not _AMOUNT_RE.match(v)]

            allocated = False
            if len(exact_amounts) >= 2 and item.slv and item.slv != '免税':
                # [FIX-7] 税率推导：识别哪个值是税额
                try:
                    rate_val = float(item.slv.rstrip('%'))
                    if abs(rate_val) > 0.001:
                        se_idx = None
                        for idx_c, v in enumerate(exact_amounts):
                            for idx_a, a in enumerate(exact_amounts):
                                if idx_c == idx_a:
                                    continue
                                try:
                                    expected_se = float(a) * rate_val / 100
                                    if abs(expected_se - float(v)) < 0.02:
                                        se_idx = idx_c
                                        break
                                except (ValueError, TypeError):
                                    pass
                            if se_idx is not None:
                                break

                        if se_idx is not None:
                            item.se = exact_amounts[se_idx]
                            remaining_amounts = [
                                exact_amounts[i]
                                for i in range(len(exact_amounts))
                                if i != se_idx
                            ]
                            if len(remaining_amounts) >= 2:
                                item.dj = remaining_amounts[0]
                                item.je = remaining_amounts[1]
                            elif len(remaining_amounts) == 1:
                                item.je = remaining_amounts[0]
                                if loose_amounts:
                                    item.dj = loose_amounts[0]
                            allocated = True
                except (ValueError, TypeError):
                    pass

            if not allocated:
                # 回退原有逻辑
                if len(exact_amounts) >= 3:
                    item.dj = exact_amounts[0]
                    item.je = exact_amounts[1]
                    item.se = exact_amounts[2]
                elif len(exact_amounts) == 2:
                    item.je = exact_amounts[0]
                    item.se = exact_amounts[1]
                    if loose_amounts:
                        item.dj = loose_amounts[0]
                elif len(exact_amounts) == 1:
                    item.je = exact_amounts[0]
                    if loose_amounts:
                        item.dj = loose_amounts[0]
                elif len(amount_values) == 1:
                    item.je = amount_values[0]

            self._assign_integer_candidates(item, integer_candidates)

            # 单价=金额且数量>1时清空单价
            if item.dj and item.je and item.dj == item.je:
                try:
                    if item.sl and float(item.sl) > 1:
                        item.dj = ''
                except (ValueError, TypeError):
                    pass

            # 推导单价
            if item.sl and item.je and not item.dj:
                try:
                    sl_f = float(item.sl)
                    je_f = float(item.je)
                    if sl_f > 0:
                        item.dj = (f"{je_f / sl_f:.4f}"
                                   .rstrip('0').rstrip('.'))
                except (ValueError, ZeroDivisionError):
                    pass

            if item.je:
                adj = _post_process(item, len(items))
                adjustments.extend(adj)
                items.append(item)
                if logger.isEnabledFor(logging.DEBUG):
                    logger.debug(
                        "[LineItem/Vert/Multi] #%d: xmmc='%s' ggxh='%s' "
                        "dw='%s' sl=%s dj=%s je=%s slv=%s se=%s",
                        len(items), item.xmmc, item.ggxh, item.dw,
                        item.sl, item.dj, item.je, item.slv, item.se)

            # 折扣行：负数金额作为独立明细
            if negative_amounts:
                discount_item = InvoiceLineItem()
                discount_item.xmmc = '*'
                discount_item.ggxh = ''
                discount_item.dw = ''
                discount_item.sl = ''
                discount_item.dj = ''
                discount_item.slv = item.slv or ''
                if negative_amounts[0]:
                    discount_item.je = negative_amounts[0]
                if len(negative_amounts) >= 2 and negative_amounts[1]:
                    discount_item.se = negative_amounts[1]
                adj = _post_process(discount_item, len(items))
                adjustments.extend(adj)
                items.append(discount_item)
                logger.debug(
                    "[LineItem/Vert/Multi] #%d (discount): "
                    "xmmc='%s' je=%s se=%s",
                    len(items), discount_item.xmmc,
                    discount_item.je, discount_item.se)

        if return_adjustments:
            return items, adjustments
        return items

    # ── 数据行解析 ──

    def _parse_tokens(self, tokens: list[str]) -> InvoiceLineItem | None:
        if len(tokens) < _MIN_TOKENS:
            return None

        item = InvoiceLineItem()
        i = len(tokens) - 1

        # ① 税额
        if i >= 0 and _is_amount(tokens[i]):
            item.se = _clean(tokens[i])
            i -= 1

        # ② 税率
        if i >= 0 and _is_valid_rate(tokens[i]):
            item.slv = tokens[i]
            i -= 1

        # ③ 金额
        if i >= 0 and _is_amount(tokens[i]):
            item.je = _clean(tokens[i])
            i -= 1
        elif i >= 0 and _is_relaxed_amount(tokens[i]):
            item.je = _clean(tokens[i])
            i -= 1

        # ④ 数量 + 单价
        qp = self._pick_qty_price(tokens, i, item.je)
        item.dj = qp.dj
        item.sl = qp.sl
        if qp.consumed_indices:
            i = min(qp.consumed_indices) - 1

        # ⑤ 单位
        if i >= 0 and tokens[i] in _COMMON_UNITS:
            item.dw = tokens[i]
            i -= 1

        # ⑥ 文本
        text_tokens = tokens[:i + 1]
        if text_tokens:
            _assign_text_fields(item, text_tokens)

        return item if (item.xmmc or item.je) else None

    def _pick_qty_price(self, tokens, end_idx, amount_je):
        candidates: list[tuple[int, str, float]] = []
        j = end_idx
        while j >= 0 and len(candidates) < _MAX_QTY_PRICE_CANDIDATES:
            t = tokens[j]
            if _is_model_token(t):
                j -= 1
                continue
            if (_is_amount(t) or _is_loose_amount(t)
                    or _NUMBER_RE.match(t)):
                clean = _clean(t)
                try:
                    fval = float(clean)
                    candidates.append((j, clean, fval))
                except ValueError:
                    break
                j -= 1
            else:
                break

        if not candidates:
            return _QtyPriceResult()

        if len(candidates) == 1:
            idx, clean, _ = candidates[0]
            dj, sl = self._resolve_single_number(clean, amount_je)
            return _QtyPriceResult(
                dj=dj, sl=sl, consumed_indices=frozenset({idx}))

        je_f = None
        if amount_je:
            try:
                je_f = float(amount_je)
            except ValueError:
                pass

        if je_f is None:
            return self._pick_best_ordering(candidates)
        return self._pick_best_pair(candidates, je_f)

    @staticmethod
    def _pick_best_pair(candidates, je_f):
        best = _QtyPriceResult()
        best_score = float('inf')
        for a in range(len(candidates)):
            for b in range(len(candidates)):
                if a == b:
                    continue
                a_idx, a_clean, a_f = candidates[a]
                b_idx, b_clean, b_f = candidates[b]
                if a_f == 0 or b_f == 0:
                    continue
                diff = abs(b_f * a_f - je_f)
                score = diff
                if not _is_integer_like(b_f):
                    score += max(abs(je_f) * _QTY_INTEGER_PENALTY, 0.5)
                if abs(b_f) > _QTY_RANGE_SOFT_CAP:
                    score += (abs(b_f) - _QTY_RANGE_SOFT_CAP) * 0.01
                if abs(a_f) > _PRICE_RANGE_SOFT_CAP:
                    score += (abs(a_f) - _PRICE_RANGE_SOFT_CAP) * 0.001
                if score < best_score:
                    best_score = score
                    best = _QtyPriceResult(
                        dj=a_clean, sl=b_clean,
                        consumed_indices=frozenset({a_idx, b_idx}))
        return best

    @staticmethod
    def _pick_best_ordering(candidates):
        c0, c1 = candidates[0], candidates[1]
        orderings = [(c0, c1), (c1, c0)]
        best_score = float('inf')
        best = _QtyPriceResult()
        for dj_c, sl_c in orderings:
            score = 0
            if not _is_integer_like(sl_c[2]):
                score += 10
            if abs(sl_c[2]) > abs(dj_c[2]):
                score += 5
            if abs(sl_c[2]) > _QTY_RANGE_SOFT_CAP:
                score += 100
            if abs(dj_c[2]) > _PRICE_RANGE_SOFT_CAP:
                score += 100
            if score < best_score:
                best_score = score
                best = _QtyPriceResult(
                    dj=dj_c[1], sl=sl_c[1],
                    consumed_indices=frozenset({dj_c[0], sl_c[0]}))
        return best

    @staticmethod
    def _resolve_single_number(val, amount_je):
        try:
            val_f = float(val)
        except (ValueError, TypeError):
            return '', val
        if not amount_je or val_f == 0:
            if '.' in val and len(val.split('.')[-1]) > 2:
                return val, ''
            return '', val
        try:
            je_f = float(amount_je)
        except (ValueError, TypeError):
            return '', val
        val_is_likely_price = (
            ('.' in val and len(val.split('.')[-1]) > 2)
            or abs(val_f) > 1_000
        )
        if val_is_likely_price:
            try:
                candidate_qty = je_f / val_f
            except ZeroDivisionError:
                return val, ''
            if 0.0001 < abs(candidate_qty) < 100_000:
                return val, (f"{candidate_qty:.4f}"
                             .rstrip('0').rstrip('.'))
            if '.' in val and len(val.split('.')[-1]) > 2:
                return val, ''
            return '', val
        else:
            try:
                candidate_price = je_f / val_f
            except ZeroDivisionError:
                return '', val
            if 0.001 < abs(candidate_price) < 1_000_000:
                return f"{candidate_price:.2f}", val
            return '', val


# ═══════════════════════════════════════════════════════
#  数据结构
# ═══════════════════════════════════════════════════════

@dataclass
class _QtyPriceResult:
    dj: str = ''
    sl: str = ''
    consumed_indices: frozenset[int] = field(default_factory=frozenset)


# ═══════════════════════════════════════════════════════
#  BBox 列解析路径
# ═══════════════════════════════════════════════════════

class _ColumnAwareExtractor:

    _COL_NAME = 'name'
    _COL_SPEC = 'spec'
    _COL_UNIT = 'unit'
    _COL_QTY = 'qty'
    _COL_PRICE = 'price'
    _COL_AMOUNT = 'amount'
    _COL_RATE = 'rate'
    _COL_TAX = 'tax'

    _HEADER_MAP: list[tuple[re.Pattern, str]] = [
        (re.compile(r'项目名称|货物.*名称|服务名称|品名'), _COL_NAME),
        (re.compile(r'规格型号'), _COL_SPEC),
        (re.compile(r'单\s*位'), _COL_UNIT),
        (re.compile(r'数\s*量'), _COL_QTY),
        (re.compile(r'单\s*价'), _COL_PRICE),
        (re.compile(r'金\s*额'), _COL_AMOUNT),
        (re.compile(r'税\s*率'), _COL_RATE),
        (re.compile(r'税\s*额'), _COL_TAX),
    ]

    def extract(self, seg: DocumentSegment,
                return_adjustments: bool = False):
        tokens: list[Token] = seg.tokens
        if not tokens:
            return ([], []) if return_adjustments else []

        tokens = [t for t in tokens if not _is_blacklisted_token(t.text)]
        if not tokens:
            return ([], []) if return_adjustments else []

        rows = self._cluster_rows(tokens)
        if not rows:
            logger.debug("[LineItem/BBox] 行聚类失败，回退纯文本")
            return None

        # [FIX-6] 拆分包含多个明细的共享行（如折扣行与正行y坐标相同）
        rows = self._split_multi_item_rows(rows)

        header_row_idx = self._find_header_row(rows)
        if header_row_idx < 0:
            logger.debug("[LineItem/BBox] 未找到表头行，回退纯文本")
            return None

        columns = self._infer_columns(rows[header_row_idx])
        if not columns:
            logger.debug("[LineItem/BBox] 列推断失败，回退纯文本")
            return None

        items: list[InvoiceLineItem] = []
        adjustments: list = []
        parsed_count = 0
        total_rows = len(rows) - (header_row_idx + 1)
        logger.debug("[LineItem/BBox] 明细行开始解析: 总行数=%d, 表头行=%d",
                     total_rows, header_row_idx)

        for row_idx, row_tokens in enumerate(rows[header_row_idx + 1:]):
            row_tokens = [t for t in row_tokens
                          if not _is_blacklisted_token(t.text)]
            if not row_tokens:
                continue

            row_text = ' '.join(t.text for t in row_tokens)
            if _TOKEN_SUMMARY_RE.search(row_text):
                logger.debug("[LineItem/BBox] 截断: 第 %d 行匹配汇总关键词 '%s', 已解析 %d 行",
                             row_idx, row_text.strip(), parsed_count)
                break

            item = self._assign_columns(row_tokens, columns)
            has_data = any([item.je, item.sl, item.dj, item.slv, item.se])

            if not has_data and (item.xmmc or item.ggxh):
                logger.debug("[LineItem/BBox] 仅名称无数据: '%s'",
                             item.xmmc or item.ggxh)
                continue

            if item and item.je:
                adj = _post_process(item, row_idx)
                adjustments.extend(adj)
                items.append(item)
                parsed_count += 1
            elif not has_data:
                logger.debug("[LineItem/BBox] 无数据行跳过: '%s'", row_text)

        if items:
            logger.debug("[LineItem/BBox] 解析完成: 共 %d 条有效明细 (parsed=%d/%d)",
                         len(items), parsed_count, total_rows)
        else:
            logger.debug("[LineItem/BBox] 解析完成: 0 条有效明细")

        if return_adjustments:
            return items, adjustments
        return items

    @staticmethod
    def _cluster_rows(tokens: list[Token]) -> list[list[Token]]:
        if not tokens:
            return []

        sorted_tokens = sorted(tokens, key=lambda t: (t.cy, t.x))
        text_lines: list[list[Token]] = []
        current = [sorted_tokens[0]]
        line_y0 = sorted_tokens[0].y
        line_y1 = sorted_tokens[0].y1

        for t in sorted_tokens[1:]:
            overlap_start = max(t.y, line_y0)
            overlap_end = min(t.y1, line_y1)
            overlap = max(0.0, overlap_end - overlap_start)
            token_h = max(t.height, 1.0)
            overlap_ratio = overlap / token_h
            if overlap_ratio >= 0.5:
                current.append(t)
                line_y0 = min(line_y0, t.y)
                line_y1 = max(line_y1, t.y1)
            else:
                # [PERF] 跳过冗余 sort：tokens 已按 (cy, x) 排序，同行内已按 x 有序
                text_lines.append(current)
                current = [t]
                line_y0 = t.y
                line_y1 = t.y1
        if current:
            # [PERF] 同上
            text_lines.append(current)

        if len(text_lines) <= 1:
            return text_lines

        def _line_cy(tokens_line):
            return (sum(t.cy for t in tokens_line) / len(tokens_line)
                    if tokens_line else 0)

        gaps = [_line_cy(text_lines[k + 1]) - _line_cy(text_lines[k])
                for k in range(len(text_lines) - 1)]
        heights = [
            max(t.y1 for t in tl) - min(t.y0 for t in tl)
            for tl in text_lines if tl
        ]
        median_h = sorted(heights)[len(heights) // 2] if heights else 12.0
        sorted_gaps = sorted(gaps)
        median_gap = sorted_gaps[len(sorted_gaps) // 2]

        threshold = median_gap * 1.5
        if len(sorted_gaps) >= 3:
            best_ratio = 0.0
            best_split_val = threshold
            for k in range(len(sorted_gaps) - 1):
                if sorted_gaps[k] > 0.1:
                    ratio = sorted_gaps[k + 1] / sorted_gaps[k]
                    if ratio > best_ratio:
                        best_ratio = ratio
                        best_split_val = (
                            (sorted_gaps[k] + sorted_gaps[k + 1]) / 2)
            if best_ratio > 2.5:
                threshold = best_split_val
        threshold = max(threshold, median_h * 1.2)

        rows = [[t for t in text_lines[0]]]
        last_cy = _line_cy(text_lines[0])

        for tl in text_lines[1:]:
            gap = _line_cy(tl) - last_cy
            if gap < threshold:
                rows[-1].extend(tl)
            else:
                rows.append(list(tl))
            last_cy = _line_cy(tl)

        return [sorted(row, key=lambda t: t.x) for row in rows]

    # [FIX-6] 新增：拆分共享行中包含多个明细的token
    @staticmethod
    def _split_multi_item_rows(
            rows: list[list[Token]]) -> list[list[Token]]:
        """检测同一行中包含多个明细项的情况并拆分。

        当行中出现大间距（如正金额与负金额之间有空白列）时，
        说明该行可能包含多个明细项（如折扣行与正行合并）。
        """
        split_rows: list[list[Token]] = []
        for row in rows:
            if not row:
                split_rows.append(row)
                continue

            sorted_row = sorted(row, key=lambda t: t.x)

            char_widths = [t.width / max(len(t.text), 1)
                           for t in sorted_row
                           if t.width > 0 and t.text]
            if not char_widths:
                split_rows.append(row)
                continue
            median_cw = sorted(char_widths)[len(char_widths) // 2]

            gaps = []
            for i in range(1, len(sorted_row)):
                gap = sorted_row[i].x0 - sorted_row[i - 1].x1
                gaps.append((i, gap))

            if not gaps:
                split_rows.append(row)
                continue

            has_negative = any(
                t.text.strip().startswith('-')
                and any(c.isdigit() for c in t.text)
                for t in sorted_row
            )

            gap_threshold = median_cw * 3.0

            split_idx = None
            if has_negative:
                for i, gap in gaps:
                    if gap > gap_threshold:
                        split_idx = i
                        break

            if split_idx is not None:
                left = sorted_row[:split_idx]
                right = sorted_row[split_idx:]
                if left:
                    split_rows.append(left)
                if right:
                    split_rows.append(right)
                logger.debug("[LineItem/BBox] 拆分共享行: %d tokens → "
                             "%d + %d tokens",
                             len(sorted_row), len(left), len(right))
            else:
                split_rows.append(row)

        return split_rows

    def _find_header_row(self, rows: list[list[Token]]) -> int:
        for i, row in enumerate(rows):
            merged_text = self._merge_close_tokens_text(row)
            hits = sum(1 for pat, _ in self._HEADER_MAP
                       if pat.search(merged_text))
            if hits >= 2:
                return i
            row_text = ' '.join(t.text for t in row)
            hits = sum(1 for pat, _ in self._HEADER_MAP
                       if pat.search(row_text))
            if hits >= 2:
                return i
        return -1

    @staticmethod
    def _merge_close_tokens_text(tokens):
        if not tokens:
            return ''
        sorted_t = sorted(tokens, key=lambda t: t.x)
        char_widths = [t.width / max(len(t.text), 1)
                       for t in sorted_t if t.width > 0 and t.text]
        if not char_widths:
            return ' '.join(t.text for t in sorted_t)
        median_cw = sorted(char_widths)[len(char_widths) // 2]
        merge_threshold = median_cw * 1.2
        parts = [sorted_t[0].text]
        for j in range(1, len(sorted_t)):
            gap = sorted_t[j].x0 - sorted_t[j - 1].x1
            if gap < merge_threshold:
                parts[-1] += sorted_t[j].text
            else:
                parts.append(sorted_t[j].text)
        return ' '.join(parts)

    def _infer_columns(self, header_tokens):
        groups = self._group_close_tokens(header_tokens)
        columns = []
        for group in groups:
            group_text = ''.join(t.text for t in group)
            for pattern, col_name in self._HEADER_MAP:
                if pattern.search(group_text):
                    if col_name not in [c.name for c in columns]:
                        columns.append(_ColumnDef(
                            name=col_name,
                            x_min=group[0].x0,
                            x_max=group[-1].x1))
                    break
        columns.sort(key=lambda c: c.x_min)
        if len(columns) >= 2:
            for k in range(len(columns) - 1):
                mid = (columns[k].x_max + columns[k + 1].x_min) / 2
                columns[k] = _ColumnDef(
                    name=columns[k].name,
                    x_min=columns[k].x_min, x_max=mid)
                columns[k + 1] = _ColumnDef(
                    name=columns[k + 1].name,
                    x_min=mid, x_max=columns[k + 1].x_max)
            total_width = columns[-1].x_max - columns[0].x_min
            margin = total_width * 0.03
            columns[0] = _ColumnDef(
                name=columns[0].name,
                x_min=columns[0].x_min - margin,
                x_max=columns[0].x_max)
            columns[-1] = _ColumnDef(
                name=columns[-1].name,
                x_min=columns[-1].x_min,
                x_max=columns[-1].x_max + margin)
        return columns

    @staticmethod
    def _group_close_tokens(tokens):
        if not tokens:
            return []
        sorted_t = sorted(tokens, key=lambda t: t.x)
        char_widths = [t.width / max(len(t.text), 1)
                       for t in sorted_t if t.width > 0 and t.text]
        if not char_widths:
            return [[t] for t in sorted_t]
        median_cw = sorted(char_widths)[len(char_widths) // 2]
        threshold = median_cw * 1.2
        groups = [[sorted_t[0]]]
        for t in sorted_t[1:]:
            gap = t.x0 - groups[-1][-1].x1
            if gap < threshold:
                groups[-1].append(t)
            else:
                groups.append([t])
        return groups

    def _assign_columns(self, row_tokens, columns):
        col_texts = {c.name: [] for c in columns}
        for token in row_tokens:
            if _is_control_marker(token.text):
                continue
            token_text = _strip_control_markers(token.text)
            if not token_text:
                continue
            best_col = None
            best_overlap = 0.0
            for col in columns:
                overlap_start = max(token.x0, col.x_min)
                overlap_end = min(token.x1, col.x_max)
                overlap = max(0.0, overlap_end - overlap_start)
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_col = col.name
            if best_col is None:
                min_dist = float('inf')
                for col in columns:
                    dist = abs(token.cx - (col.x_min + col.x_max) / 2)
                    if dist < min_dist:
                        min_dist = dist
                        best_col = col.name
            if best_col:
                col_texts[best_col].append(token_text)

        item = InvoiceLineItem()
        if col_texts.get(self._COL_NAME):
            item.xmmc = ' '.join(col_texts[self._COL_NAME])
        if col_texts.get(self._COL_SPEC):
            item.ggxh = ' '.join(col_texts[self._COL_SPEC])
        unit_parts = col_texts.get(self._COL_UNIT, [])
        if unit_parts:
            item.dw = _normalize_ocr_digits(unit_parts[0])
        item.sl = _assemble_field(col_texts.get(self._COL_QTY, []))
        item.dj = _assemble_field(col_texts.get(self._COL_PRICE, []))
        assembled_je = _assemble_field(
            col_texts.get(self._COL_AMOUNT, []))
        if assembled_je and (_is_loose_amount(assembled_je)
                             or _is_amount(assembled_je)):
            item.je = assembled_je
        rate_parts = col_texts.get(self._COL_RATE, [])
        if rate_parts:
            item.slv = rate_parts[0]
        assembled_se = _assemble_field(
            col_texts.get(self._COL_TAX, []))
        if assembled_se and (_is_loose_amount(assembled_se)
                             or _is_amount(assembled_se)):
            item.se = assembled_se
        return item


@dataclass
class _ColumnDef:
    name: str
    x_min: float
    x_max: float


# ═══════════════════════════════════════════════════════
#  v10 主提取器
# ═══════════════════════════════════════════════════════

class LineItemExtractor:
    """提取发票明细行 v10。

    [FIX-8] 核心策略变更：
    始终先用文本路径提取作为基准，然后检查 bbox_tokens 是否
    包含有效明细数据（星号分类、金额、单位、税率）。如果不
    包含（全是噪声如银行账号、备注、开票人），直接使用文本
    结果；如果包含，则比较两条路径的结果数量，选择更优的那条。
    """

    def __init__(self):
        self._text_parser = _TextLineParser()
        self._bbox_parser = _ColumnAwareExtractor()
        self._adjustments = []

    def extract(self, doc_or_seg: OCRDocument | SegmentedDocument,
                return_adjustments: bool = False):
        self._adjustments = []

        if isinstance(doc_or_seg, SegmentedDocument):
            seg = doc_or_seg.line_items
        else:
            from ..segmenter import DocumentSegmenter
            segmenter = DocumentSegmenter()
            segmented = segmenter.segment(doc_or_seg)
            seg = segmented.line_items

        if not seg:
            return ([], []) if return_adjustments else []

        # ── 始终先用文本路径提取（作为基准和回退）──
        text_items, text_adj = self._text_parser.extract(
            seg, return_adjustments=True)

        if seg.tokens:
            # ── 检查 tokens 是否包含有效的明细数据 ──
            detail_token_count = sum(
                1 for t in seg.tokens
                if (_TOKEN_STAR_CATEGORY_RE.search(t.text)
                    or _AMOUNT_RE.match(t.text)
                    or t.text in _COMMON_UNITS
                    or _RATE_RE.match(t.text))
            )

            if detail_token_count >= 2:
                # bbox 包含有效明细数据，尝试 BBox 路径
                logger.debug(
                    "[LineItem] bbox_tokens 包含 %d 个有效明细 token，"
                    "尝试 BBox 路径", detail_token_count)
                result = self._bbox_parser.extract(
                    seg, return_adjustments=True)
                if result is None:
                    bbox_items = None
                    bbox_adj = []
                else:
                    bbox_items, bbox_adj = result

                # 选择结果更好的路径
                if bbox_items and len(bbox_items) >= len(text_items):
                    items = bbox_items
                    self._adjustments.extend(bbox_adj)
                    logger.debug(
                        "[LineItem] 使用 BBox 结果 "
                        "(%d items vs 文本 %d items)",
                        len(items), len(text_items))
                else:
                    items = text_items
                    self._adjustments.extend(text_adj)
                    logger.debug(
                        "[LineItem] BBox 结果不足 (%s vs 文本 %d items)，"
                        "使用文本结果",
                        len(bbox_items) if bbox_items else 0,
                        len(text_items))
            else:
                # bbox tokens 主要是噪声（银行账号、备注、开票人等），
                # 无有效明细数据，直接使用文本结果
                items = text_items
                self._adjustments.extend(text_adj)
                logger.debug(
                    "[LineItem] bbox_tokens 仅 %d 个有效明细 token "
                    "（主要是噪声），跳过 BBox 路径，"
                    "使用文本结果 (%d items)",
                    detail_token_count, len(items))
        else:
            items = text_items
            self._adjustments.extend(text_adj)

        items = self._sanitize_items(items)

        if return_adjustments:
            return items, self._adjustments
        return items

    def _sanitize_items(self, items: list[InvoiceLineItem]
                        ) -> list[InvoiceLineItem]:
        for item in items or []:
            for attr in ('xmmc', 'ggxh', 'dw', 'sl', 'dj', 'je',
                         'slv', 'se'):
                val = getattr(item, attr, '')
                if isinstance(val, str):
                    setattr(item, attr, _strip_control_markers(val))
        return items

    def get_adjustments(self) -> list:
        return self._adjustments
