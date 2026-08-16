# -*- coding: utf-8 -*-
"""
发票字段校验工具
"""
import re
import logging

from .party_constants import (
    COMPANY_KEYWORDS,
    COMPANY_SUFFIX_LIST,
    POLLUTION_KEYWORDS,
    AMOUNT_DAXIE_KEYWORDS,
    GOODS_KEYWORDS,
)

logger = logging.getLogger(__name__)

# ── 编译正则 ──
_ASCII_ONLY_RE = re.compile(r'^[A-Za-z0-9\s]+$')
_LONG_DIGITS_RE = re.compile(r'^\d{10,}$')
_TAIL_PHONE_RE = re.compile(r'\d{11,}$')
_COMPANY_KEYWORDS_SET = frozenset(COMPANY_KEYWORDS)

DIGIT_RATIO_THRESHOLD = 0.3


class NameCleaner:
    """公司名清理与校验"""

    @staticmethod
    def clean_name(name: str) -> str:
        """
        清理公司名文本

        处理：
        1. 去除 BUYER/SELLER 标记和 AUX 标记
        2. 去除全角空格和普通空格
        3. 去除"下载次数:xxx"等后缀
        4. 截断标签前缀（如"购买方信息 xxx公司"→"xxx公司"）
        5. 处理多后缀粘连（如"公司A有限公司公司B有限公司"→"公司A有限公司"）
        """
        if not name:
            return ''

        # 去除 BUYER/SELLER 标记
        name = _LABEL_PATTERNS[0].sub(' ', str(name))
        # 去除 AUX 标记
        name = _LABEL_PATTERNS[1].sub(' ', name)
        # 去除全角空格和普通空格
        name = name.replace('\u3000', '').replace(' ', '').strip()
        # 去除"下载次数:xxx"
        name = _LABEL_PATTERNS[2].sub('', name)

        # 截断标签前缀：从标签位置截断，保留前缀（公司名部分）
        for pat in _NAME_PREFIX_PATTERNS:
            m = re.search(pat, name)
            if m:
                prefix = name[:m.start()]
                # 如果前缀已包含公司后缀，说明是有效公司名
                if any(suffix in prefix for suffix in (
                        '有限公司', '有限责任公司', '股份有限公司',
                        '集团', '厂', '店', '中心', '事务所', '工作室',
                        '合伙企业', '个人独资企业', '合作社',
                )):
                    name = prefix
                else:
                    name = prefix.strip()
                    if not any(kw in name for kw in ('公司', '企业', '集团')):
                        name = m.group(1)
                break

        # 处理多后缀粘连
        # 找到最后一个公司后缀的位置
        last_suffix_pos = -1
        last_suffix = ''
        for suffix in COMPANY_SUFFIX_LIST:
            pos = name.rfind(suffix)
            if pos > last_suffix_pos:
                last_suffix_pos = pos
                last_suffix = suffix
        if last_suffix_pos > 0:
            name = name[:last_suffix_pos + len(last_suffix)]

        return name.strip()

    @staticmethod
    def name_ok(
        name: str,
        *,
        company_keywords: frozenset = _COMPANY_KEYWORDS_SET,
        pollution_keywords: tuple = POLLUTION_KEYWORDS,
        amount_daxie_keywords: tuple = AMOUNT_DAXIE_KEYWORDS,
        company_suffix_list: tuple = COMPANY_SUFFIX_LIST,
        digit_ratio_threshold: float = DIGIT_RATIO_THRESHOLD,
    ) -> bool:
        """
        判断文本是否可能是公司名

        过滤规则：
        1. 长度 4~60 字符
        2. 数字比例不超过阈值
        3. 不含污染关键词（项目名称、规格型号等）
        4. 不含大写金额关键词
        5. 不是纯 ASCII 名称
        6. 不是长数字串
        7. 不是银行支行/分行特征
        8. 必须有公司后缀或公司特征词
        """
        ok_logger = logging.getLogger(__name__)
        ok_logger.info("[NameOK/DBG] name='%s' len=%d", name, len(name) if name else 0)
        if not name:
            ok_logger.info("[NameOK/DBG] FAIL empty")
            return False
        if len(name) < 4 or len(name) > 60:
            ok_logger.info("[NameOK/DBG] FAIL len: %d", len(name))
            return False

        # 数字比例检查
        name_len = len(name)
        digit_ratio = sum(1 for c in name if c.isdigit()) / name_len if name_len > 0 else 0
        if digit_ratio > digit_ratio_threshold:
            ok_logger.info("[NameOK/DBG] FAIL digit_ratio=%.2f > %.2f", digit_ratio, digit_ratio_threshold)
            return False

        # 污染关键词检查
        pollution_hits = [kw for kw in pollution_keywords if kw in name]
        if pollution_hits:
            ok_logger.info("[NameOK/DBG] FAIL pollution: %s", pollution_hits)
            return False

        # 大写金额关键词检查（但公司名中可能包含"万"如"万兆通"，有公司后缀时跳过）
        daxie_hits = [kw for kw in amount_daxie_keywords if kw in name]
        if daxie_hits:
            has_suffix = any(s in name for s in company_suffix_list)
            if not has_suffix:
                ok_logger.info("[NameOK/DBG] FAIL daxie: %s (no suffix)", daxie_hits)
                return False

        # 纯 ASCII 名称排除
        if _ASCII_ONLY_RE.match(name):
            ok_logger.info("[NameOK/DBG] FAIL ascii")
            return False

        # 订单号排除
        if '订单号' in name or '订单编号' in name:
            ok_logger.info("[NameOK/DBG] FAIL order")
            return False

        # 长数字串排除
        name_no_space = name.replace(' ', '')
        if _LONG_DIGITS_RE.match(name_no_space):
            ok_logger.info("[NameOK/DBG] FAIL long_digits")
            return False

        # 尾部手机号排除（除非包含公司特征词）
        if _TAIL_PHONE_RE.search(name_no_space) \
                and not any(kw in name for kw in ('公司', '企业', '集团', '厂', '店', '中心')):
            ok_logger.info("[NameOK/DBG] FAIL tail_phone")
            return False

        # 银行支行/分行检查
        if NameCleaner.is_bank_branch(name):
            ok_logger.info("[NameOK/DBG] FAIL bank_branch: %s", name)
            return False

        # 公司后缀或特征词检查
        has_company_suffix = any(s in name for s in company_suffix_list)
        ok_logger.info("[NameOK/DBG] suffix=%s list_sample=%s", has_company_suffix, list(company_suffix_list)[:3])
        if not has_company_suffix:
            has_company_keyword = any(kw in name for kw in company_keywords)
            if not has_company_keyword:
                ok_logger.info("[NameOK/DBG] FAIL no suffix no kw: %s", name)
                return False

        ok_logger.info("[NameOK/DBG] PASS: %s", name)
        return True

    @staticmethod
    def is_bank_branch(name: str) -> bool:
        """判断是否为银行支行/分行（收款账户信息，非买卖方）"""
        if not name:
            return False
        return ('支行' in name or '分行' in name or '总行' in name) and '银行' in name

    @staticmethod
    def is_likely_goods(
        name: str,
        *,
        goods_keywords: tuple = GOODS_KEYWORDS,
        company_suffix_list: tuple = COMPANY_SUFFIX_LIST,
    ) -> bool:
        """
        判断文本是否可能是商品名（非公司名）

        条件：长度 > 15 且包含商品关键词且不含公司后缀
        """
        if not name:
            return False
        if len(name) <= 15:
            return False
        has_goods_kw = any(kw in name for kw in goods_keywords)
        has_suffix = any(s in name for s in company_suffix_list)
        return has_goods_kw and not has_suffix

    @staticmethod
    def tax_ok(tax: str) -> bool:
        """判断税号格式是否合法"""
        if not tax:
            return False
        # 去除可能的空格和前缀
        tax = tax.replace(' ', '').lstrip('：:')
        if not tax:
            return False
        # 15-20 位字母数字
        return bool(re.match(r'^[A-Z0-9]{15,20}$', tax, re.IGNORECASE))


# 标签模式（编译后复用）
_LABEL_PATTERNS = [
    re.compile(r'(BUYER|SELLER|BUY|SEL)\s*[:：]\s*'),
    re.compile(r'AUX\d*\s*[:：]\s*'),
    re.compile(r'下载次数\s*[:：]?\s*\d+'),
]

# 名称前缀模式
_NAME_PREFIX_PATTERNS = [
    re.compile(r'(名称|单位名称|公司名称)\s*[:：]?\s*(.+?)(?:有限公司|有限责任公司|股份有限公司|集团|厂|店|中心|$)', re.DOTALL),
    re.compile(r'(名称|单位名称|公司名称)\s*[:：]?\s*'),
]
