from typing import List

from contracts.extracted_field import ExtractedField


class ConfidenceEngine:
    def merge(self, fields: List[ExtractedField]) -> List[ExtractedField]:
        """
        Merge multi-source fields and compute confidence scores.
        Current version preserves existing values, assigns confidence based on state/source.
        """
        for field in fields:
            if field.state == "VALID":
                field.confidence = 0.95 if field.source == "RULE" else 0.80
            elif field.state == "CORRECTED":
                field.confidence = 0.65
            elif field.state == "INVALID":
                field.confidence = 0.20
            elif field.state == "MISSING":
                field.confidence = 0.0
        return fields