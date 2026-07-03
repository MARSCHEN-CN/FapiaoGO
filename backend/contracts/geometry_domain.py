"""Geometry domain data classes for layout analysis."""

from dataclasses import dataclass, field
from typing import List, Optional

from contracts.document_layout import BBox


@dataclass
class TextLine:
    """A single text line with its bounding box."""
    text: str
    bbox: BBox
    page_num: int = 0


@dataclass
class AlignedGroup:
    """A group of text lines sharing the same alignment."""
    lines: List[TextLine]
    alignment: str  # "left", "right", "center"
    x_value: float  # the reference x coordinate for alignment


@dataclass
class ColumnProposal:
    """A proposed column boundary."""
    x_start: float
    x_end: float
    header_hint: Optional[str] = None


@dataclass
class RegionProposal:
    """A candidate document region."""
    y_start: float
    y_end: float
    region_type: str  # "header", "body", "footer", "table"
    lines: List[TextLine] = field(default_factory=list)


@dataclass
class GeometryReport:
    """The full geometric structure report of a document."""
    lines: List[TextLine]
    aligned_groups: List[AlignedGroup]
    column_proposals: List[ColumnProposal]
    region_proposals: List[RegionProposal]
