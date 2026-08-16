"""
field_extractor 包 - 发票字段提取
对外 API 与拆分前完全兼容：
  from field_extractor import normalize_invoice_type, extract_fields, extract_fields_legacy
"""
from ._extractor import (
    normalize_invoice_type,
    extract_fields,
    extract_fields_legacy,
    normalize_amount,
    normalize_date,
)

# to_chinese_amount / extract_project_name 移至 extractors.__init__ 内部，
# 此处保留向后兼容的引用
from .extractors import InvoiceExtractor

_to_chinese = InvoiceExtractor._to_chinese_amount

def to_chinese_amount(num_str: str) -> str:
    return _to_chinese(num_str)

def extract_project_name(text: str) -> str:
    """提取项目名称（兼容旧版）"""
    from .extractors.project_extractor import ProjectExtractor
    from .normalizer import TextNormalizer
    normalizer = TextNormalizer()
    doc = normalizer.normalize(text)
    return ProjectExtractor().extract(doc)
