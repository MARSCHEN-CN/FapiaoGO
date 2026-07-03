"""
发票字段提取模块（重构版）

OCR 文本 → 结构化字段 — 轻量编排层，委托给 extractors 包

用法:
    from field_extractor import extract_fields
    result = extract_fields(ocr_text)

兼容旧版:
    from field_extractor import extract_fields, extract_fields_legacy
    type_, fphm, amount_hj, kprq = extract_fields_legacy(ocr_text)
"""
import logging
from .extractors import InvoiceExtractor
from .models import InvoiceFields

logger = logging.getLogger(__name__)

# 全局提取器实例（避免重复实例化）
_extractor = InvoiceExtractor()


def extract_fields(text: str, bbox_data: list = None, source_type: str = '', auxiliary_blocks: list = None, pymupdf_page=None) -> dict:
    """提取发票全部字段，返回字典（兼容旧版返回值）
    
    Args:
        text: OCR 文本
        bbox_data: OCR bbox 数据
        source_type: 来源类型 (pdf_text / pdf_ocr / image / ofd)
        auxiliary_blocks: 辅助文本块
        pymupdf_page: PyMuPDF Page 对象（可选），传入后可激活字符级分割通路
    """
    fields = _extractor.extract(text, bbox_data=bbox_data, source_type=source_type, auxiliary_blocks=auxiliary_blocks, pymupdf_page=pymupdf_page)
    return fields.to_dict()


def extract_fields_legacy(text: str, bbox_data: list = None, source_type: str = ''):
    """旧版4字段返回，保持向后兼容"""
    fields = extract_fields(text, bbox_data=bbox_data, source_type=source_type)
    return fields['type'], fields['fphm'], fields['amountHj'], fields['kprq']


# ─── 工具函数（兼容旧版导入） ───

def normalize_invoice_type(type_str):
    if not type_str:
        return '其他'
    type_str = str(type_str).lower()
    if any(k in type_str for k in ['专票', '专用', 'special', '04']):
        return '专票'
    if any(k in type_str for k in ['普票', '普通', 'normal', '01', '电子发票']):
        return '普票'
    return '其他'


def normalize_amount(amt):
    if not amt or amt.strip() == '' or amt in ('未知金额',):
        return None
    cleaned = str(amt).replace(',', '').replace('¥', '').replace('￥', '').replace(' ', '')
    try:
        return f"{float(cleaned):.2f}"
    except ValueError:
        return None


def normalize_date(date_str):
    import re
    if not date_str or date_str in ('未知日期', ''):
        return None
    cleaned = date_str.replace('年', '-').replace('月', '-').replace('日', '').replace('号', '')
    m = re.match(r'(\d{4})[-/](\d{1,2})[-/](\d{1,2})', cleaned)
    if m:
        return f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"
    return None


# 导出符号（旧版调用方可能直接引用这些）
__all__ = [
    'extract_fields',
    'extract_fields_legacy',
    'normalize_invoice_type',
    'normalize_amount',
    'normalize_date',
    'InvoiceExtractor',
    'InvoiceFields',
]
