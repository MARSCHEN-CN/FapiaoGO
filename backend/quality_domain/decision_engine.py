from typing import List

from contracts.extracted_field import ExtractedField


class DecisionEngine:
    """
    Evaluate field quality based on state and source.
    """

    # state → validator_status 映射
    _STATE_MAP = {
        "VALID": "PASS",
        "CORRECTED": "WARN",
        "INVALID": "FAIL",
        "MISSING": "FAIL",
    }

    def evaluate(self, fields: List[ExtractedField]) -> List[ExtractedField]:
        """
        Evaluate field quality based on state.
        - VALID: field passed validation → PASS
        - CORRECTED: field was corrected by fallback → WARN
        - INVALID: field failed validation → FAIL
        - MISSING: field was not extracted → FAIL
        """
        for field in fields:
            # 如果 evidence 中有 validation 失败记录，强制 FAIL
            if field.evidence and "validation" in (field.evidence or {}):
                has_fail = any(
                    not v.get("passed", True)
                    for v in field.evidence["validation"]
                )
                if has_fail:
                    field.validator_status = "FAIL"
                    continue

            field.validator_status = self._STATE_MAP.get(field.state, "PASS")
        return fields