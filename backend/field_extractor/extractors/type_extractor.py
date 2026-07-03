"""
发票类型检测提取器
"""
import re
import logging
from ..models import OCRDocument

logger = logging.getLogger(__name__)

# 修改2: 发票代码前缀映射表，便于维护和扩展
_CODE_PREFIX_MAP = {
    '专票': ['04', '3100'],
    '普票': ['01', '3200'],
}

# 修改4: 关键词模式，带优先级
_SPECIAL_PATTERNS = [
    re.compile(r'增值税专用发票'),
    re.compile(r'增值税专用电子发票'),
    re.compile(r'全电.*专用'),
    re.compile(r'数电.*专用'),
    re.compile(r'专用发票'),
]

_NORMAL_PATTERNS = [
    re.compile(r'增值税普通发票'),
    re.compile(r'增值税普通电子发票'),
    re.compile(r'全面数字化.*电子发票'),
    re.compile(r'电子普通发票'),
    re.compile(r'全电.*普通'),
    re.compile(r'数电.*普通'),
    re.compile(r'数电发票'),
    re.compile(r'电子发票'),
    re.compile(r'普通发票'),
    re.compile(r'[（(]普通发票[）)]'),
    # OCR 可能把「电子发票」拆成「电子发」+「（普发票）」
    re.compile(r'普发票'),
    re.compile(r'电子发'),
]


class TypeExtractor:
    """识别发票类型：专票 / 普票 / 其他"""

    def extract(self, doc: OCRDocument) -> str:
        # 策略1: 关键词匹配
        t = self._match_by_keyword(doc)
        if t:
            return t

        # 策略2: 发票代码前缀启发
        t = self._infer_from_code_prefix(doc.collapsed)
        if t:
            return t

        logger.debug("类型检测结果: 其他")
        return '其他'

    def _match_by_keyword(self, doc: OCRDocument) -> str:
        """通过关键词匹配发票类型（使用 doc 正则缓存）"""
        # 修改4: 分别统计专票和普票信号，解决冲突
        special_hits = sum(1 for p in _SPECIAL_PATTERNS if doc.cached_search(p))
        normal_hits = sum(1 for p in _NORMAL_PATTERNS if doc.cached_search(p))

        if special_hits > 0 and normal_hits > 0:
            # 两种信号都有，取命中数多的；相同则优先专票（宁严勿宽）
            if special_hits >= normal_hits:
                logger.debug("[Type] 关键词冲突: 专票=%d, 普票=%d → 专票", special_hits, normal_hits)
                return '专票'
            else:
                logger.debug("[Type] 关键词冲突: 专票=%d, 普票=%d → 普票", special_hits, normal_hits)
                return '普票'
        elif special_hits > 0:
            return '专票'
        elif normal_hits > 0:
            return '普票'

        return ''

    def _infer_from_code_prefix(self, text: str) -> str:
        """通过发票代码前缀推断类型
        
        注意：全电发票（数电票）没有发票代码，不适用此方法。
        """
        # 全电发票关键词排除：全电发票没有发票代码
        no_code_keywords = ['全电发票', '数电发票', '全面数字化', '数电票', '电子发票']
        for kw in no_code_keywords:
            if kw in text:
                logger.debug("[Type] 检测到全电发票关键词 '%s'，跳过代码前缀推断", kw)
                return ''

        m = re.search(r'发票代码[:：]?\s*([0-9]{10,12})', text)
        if not m:
            return ''
        code = m.group(1)
        for inv_type, prefixes in _CODE_PREFIX_MAP.items():
            if any(code.startswith(prefix) for prefix in prefixes):
                logger.debug("[Type] 代码前缀推断: %s → %s", code, inv_type)
                return inv_type
        return ''
