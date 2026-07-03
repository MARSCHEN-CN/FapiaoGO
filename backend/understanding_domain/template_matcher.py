from typing import Optional

from contracts.document_layout import DocumentLayout
from contracts.template import Template
from understanding_domain.fingerprint_builder import FingerprintBuilder
from understanding_domain.template_repository import TemplateRepository


class TemplateMatcher:
    def __init__(self, repository: TemplateRepository):
        self.repository = repository

    def match(self, document: DocumentLayout, doc_fingerprint: dict = None,
              type_hint: str = "") -> Optional[Template]:
        """
        Match a template based on document fingerprint and/or type hint.
        
        Strategy:
          1. Exact match: type_hint == match_key (case-insensitive)
          2. Prefix/contain match: match_key is contained in type_hint or vice versa
             (e.g. type_hint="电子发票(普通发票)" → match_key="电子发票")
          3. Fall back to default_v1.
        """
        if doc_fingerprint is None:
            doc_fingerprint = FingerprintBuilder.build(document)

        if type_hint:
            hint_lower = type_hint.strip().lower()
            all_templates = self.repository.get_all_templates()

            # 策略 1：完全匹配（最高优先级）
            for t in all_templates:
                if t.status == "ACTIVE" and t.match_key:
                    if t.match_key.strip().lower() == hint_lower:
                        return t

            # 策略 2：包含/前缀匹配（type_hint 含 match_key 或反之）
            # 避免“发票”这类过短关键词产生误匹配：要求 match_key >= 2 字符
            for t in all_templates:
                if t.status == "ACTIVE" and t.match_key:
                    key_lower = t.match_key.strip().lower()
                    if len(key_lower) < 2:
                        continue
                    if key_lower in hint_lower or hint_lower in key_lower:
                        return t

        # 策略 3：降级到 default_v1
        return self.repository.get_active_template("default_v1")
