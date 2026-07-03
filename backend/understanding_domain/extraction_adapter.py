from typing import Any, Dict, List

from contracts.extracted_field import ExtractedField


class ExtractionAdapter:
    @staticmethod
    def from_legacy_result(
        invoice_fields: Dict[str, Any], field_meta: Dict[str, Any] = None
    ) -> List[ExtractedField]:
        """
        Convert legacy flat invoice fields and field_meta into ExtractedField objects.
        """
        results = []
        for field_id, value in invoice_fields.items():
            meta = (field_meta or {}).get(field_id, {})
            results.append(
                ExtractedField(
                    field_id=field_id,
                    value=value,
                    state=None,
                    source="FALLBACK",
                    source_region_id=meta.get("source_region", ""),
                    evidence=meta.get("evidence"),
                    validator_status="PASS",
                )
            )
        return results