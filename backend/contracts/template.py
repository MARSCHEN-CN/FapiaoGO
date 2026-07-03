from dataclasses import dataclass, field
from typing import List, Any, Optional, Literal


TemplateStatus = Literal["DRAFT", "REVIEW", "ACTIVE", "DEPRECATED"]


@dataclass
class ExtractionRule:
    rule_id: str
    field_id: str
    strategy: str = "keyword"  # "anchor", "table", "regex", "llm" (legacy)
    config: dict = field(default_factory=dict)
    # New fields (vNext)
    locator_type: Optional[str] = None     # "keyword", "regex", "position", "region", "table"
    locator_config: Optional[dict] = None  # locator-specific config (see extraction_rules.py docs)
    post_process: Optional[str] = None     # post-processing function name


@dataclass
class ValidationRule:
    rule_id: str
    field_id: str
    type: str
    config: dict = field(default_factory=dict)


@dataclass
class Template:
    """Versioned extraction + validation template, bound to a Schema."""
    template_id: str
    version: int
    status: TemplateStatus
    schema_id: str
    schema_version: int
    fingerprint: dict  # structural + visual
    extraction_rules: List[ExtractionRule] = field(default_factory=list)
    validation_rules: List[ValidationRule] = field(default_factory=list)
    match_key: str = ""  # 匹配键（如发票类型 "专票"、"普票"），由 TemplateMatcher 使用
