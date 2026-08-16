"""
final_sanitizer.py — 最终统一清洗闸门

职责：所有字段在返回前的统一清洗、截断、反污染、兜底规范化。
不做提取，不做评分。这是最后一道闸门。

被调用位置：extractors/__init__.py → InvoiceExtractor.extract() 返回前。
"""
from __future__ import annotations

import re
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import InvoiceFields, InvoiceLineItem

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════
#  控制标记清洗
# ═══════════════════════════════════════════════════════

_CONTROL_MARKER_RE = re.compile(
    r'\[(?:BUYER|SELLER)_(?:START|END)\]'
    r'|__AUX_[A-Za-z0-9_]+__'
)


def strip_control_markers(value: str) -> str:
    """移除内部控制标记（BUYER_START/SELLER_END/__AUX_*__），合并多余空白。"""
    if not isinstance(value, str):
        return value
    value = _CONTROL_MARKER_RE.sub(' ', value)
    return re.sub(r'\s+', ' ', value).strip()


# ═══════════════════════════════════════════════════════
#  购买方/销售方名称清洗
# ═══════════════════════════════════════════════════════

# 切断正则：遇到以下模式时截断后续内容
_CUT_PATTERNS = [
    r'销\s*[:：]',
    r'销售方信息',
    r'购\s*名\s*称[:：]',
    r'购买方\s*名\s*称[:：]',
    r'购买方信息',
    r'统一社会信用代码',
    r'纳税人识别号',
    r'项目名称',
    r'规格型号',
]


def sanitize_party_name(value: str) -> str:
    """清洗购买方/销售方名称：去控制标记、去空格、去污染后缀。"""
    value = strip_control_markers(value or '')
    # 去掉全角空格和半角空格
    value = value.replace('\u3000', '').replace(' ', '').strip()

    # 去掉 "下载次数" 及后续
    value = re.sub(r'下载次数[:：]?\d+.*$', '', value)

    # 遇到发票结构关键词时截断
    for pattern in _CUT_PATTERNS:
        m = re.search(pattern, value)
        if m and m.start() > 0:
            value = value[:m.start()]
            break

    return value.strip()


# ═══════════════════════════════════════════════════════
#  人员名称清洗
# ═══════════════════════════════════════════════════════

_BAD_PERSON_VALUES: frozenset[str] = frozenset({
    '单位', '数量', '单价', '金额', '税率', '税额',
    '名称', '下载次数', '备注', '开票人', '收款人', '复核人',
    '价税合计', '合计', '小写', '大写',
    '旅客运输服务', '餐饮服务', '运输服务', '服务费',
})


def sanitize_person_name(value: str) -> str:
    """清洗开票人/收款人/复核人：去控制标记、去两端空白、排除脏数据。"""
    value = strip_control_markers(value or '').strip()
    if not value:
        return ''
    if value in _BAD_PERSON_VALUES:
        return ''
    if len(value) > 12:
        return ''
    if re.search(r'发票|合计|金额|税|项目|规格|单位|数量|单价', value):
        return ''
    return value


# ═══════════════════════════════════════════════════════
#  备注清洗
# ═══════════════════════════════════════════════════════

def sanitize_note(value: str) -> str:
    """清洗备注：去控制标记、排除裸控制关键字。"""
    value = strip_control_markers(value or '')
    if value in {'BUYER_START', 'BUYER_END', 'SELLER_START', 'SELLER_END'}:
        return ''
    return value.strip()


# ═══════════════════════════════════════════════════════
#  明细行后处理（规格/名称误拆修正）
# ═══════════════════════════════════════════════════════

def _import_normalize_helpers():
    """延迟导入 line_item_extractor 中的语义判断辅助函数。"""
    from .extractors.line_item_extractor import (
        _is_spec_like_token,
        _is_name_suffix_token,
        _join_name_parts,
    )
    return _is_spec_like_token, _is_name_suffix_token, _join_name_parts


def normalize_line_item_text_fields(item: 'InvoiceLineItem') -> 'InvoiceLineItem':
    """后处理：修正 xmmc/ggxh 字段中的误拆问题。

    目标：
      xmmc: "*金属制品*304不锈钢卡 M4 头", ggxh: "M4 头"
      → xmmc: "*金属制品*304不锈钢卡头", ggxh: "M4"
    """
    _is_spec_like_token, _is_name_suffix_token, _join_name_parts = _import_normalize_helpers()

    # 如果 ggxh 末尾包含短中文尾缀，转移到 xmmc
    if item.ggxh:
        parts = item.ggxh.split()
        keep_specs = []
        suffixes = []

        for part in parts:
            if _is_name_suffix_token(part):
                suffixes.append(part)
            else:
                keep_specs.append(part)

        if suffixes:
            item.xmmc = _join_name_parts([item.xmmc] + suffixes)
            item.ggxh = ' '.join(keep_specs)

    # 如果 xmmc 中混入规格，尝试拆出来
    if item.xmmc and not item.ggxh:
        tokens = item.xmmc.split()
        name_tokens = []
        spec_tokens = []
        suffix_tokens = []

        for token in tokens:
            if _is_spec_like_token(token):
                spec_tokens.append(token)
            elif _is_name_suffix_token(token):
                suffix_tokens.append(token)
            else:
                name_tokens.append(token)

        if spec_tokens:
            item.xmmc = _join_name_parts(name_tokens + suffix_tokens)
            item.ggxh = ' '.join(spec_tokens)

    return item


# ═══════════════════════════════════════════════════════
#  明细行统一清洗
# ═══════════════════════════════════════════════════════

def sanitize_line_item(item: 'InvoiceLineItem') -> 'InvoiceLineItem':
    """明细行最终清洗：去控制标记 + 名称/规格误拆修正。"""
    for attr in ('xmmc', 'ggxh', 'dw', 'sl', 'dj', 'je', 'slv', 'se'):
        val = getattr(item, attr, '')
        if isinstance(val, str):
            setattr(item, attr, strip_control_markers(val))

    item = normalize_line_item_text_fields(item)
    return item


# ═══════════════════════════════════════════════════════
#  InvoiceFields 最终统一清洗入口
# ═══════════════════════════════════════════════════════

def sanitize_invoice_fields(fields: 'InvoiceFields') -> 'InvoiceFields':
    """所有字段提取完成后、返回前的最终统一清洗。

    这是最后一道闸门，不做提取、不做评分。
    调用位置：extractors/__init__.py → InvoiceExtractor.extract() 返回前。
    """
    # 购买方/销售方名称
    fields.gmfmc = sanitize_party_name(fields.gmfmc)
    fields.xsfmc = sanitize_party_name(fields.xsfmc)

    # 备注
    fields.note = sanitize_note(fields.note)

    # 开票人/收款人/复核人
    fields.kpr = sanitize_person_name(fields.kpr)
    fields.skr = sanitize_person_name(fields.skr)
    fields.fhr = sanitize_person_name(fields.fhr)

    # 明细行逐条清洗
    fields.line_items = [sanitize_line_item(item) for item in (fields.line_items or [])]

    return fields
