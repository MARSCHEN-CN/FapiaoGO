from dataclasses import dataclass, field
from typing import Any, Optional, Literal
from contracts.document_layout import BBox


@dataclass
class ExtractedField:
    """Single field extraction result with provenance."""
    field_id: str
    value: Any
    state: Literal["MISSING", "VALID", "INVALID", "CORRECTED", None]
    source: Literal["RULE", "FALLBACK"]
    source_region_id: str = ""
    evidence: Optional[dict] = None  # {"text": str, "bbox": BBox}
    validator_status: Literal["PASS", "WARN", "FAIL"] = "PASS"
    confidence: float = 1.0
