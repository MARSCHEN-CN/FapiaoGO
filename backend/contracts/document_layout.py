from dataclasses import dataclass, field
from typing import List, Optional, Literal


@dataclass
class BBox:
    """Unified bounding box with (x,y) top-left origin and dimensions.

    Compatibility aliases (x0/y0/x1/y1/cx/cy) bridge legacy code that
    uses the two-corner convention.  Scheduled for removal once all
    consumers migrate to (x, y, width, height).
    """
    x: float
    y: float
    width: float
    height: float

    # ── Legacy two-corner aliases (read/write) ──────────────────────

    @property
    def x0(self) -> float:
        """Alias for *x* (top-left X)."""
        return self.x

    @x0.setter
    def x0(self, value: float) -> None:
        self.x = value

    @property
    def y0(self) -> float:
        """Alias for *y* (top-left Y)."""
        return self.y

    @y0.setter
    def y0(self, value: float) -> None:
        self.y = value

    @property
    def x1(self) -> float:
        """Right edge: x + width."""
        return self.x + self.width

    @x1.setter
    def x1(self, value: float) -> None:
        self.width = value - self.x

    @property
    def y1(self) -> float:
        """Bottom edge: y + height."""
        return self.y + self.height

    @y1.setter
    def y1(self, value: float) -> None:
        self.height = value - self.y

    # ── Centre-point aliases (read/write) ────────────────────────────

    @property
    def cx(self) -> float:
        """Centre X: x + width/2."""
        return self.x + self.width / 2

    @cx.setter
    def cx(self, value: float) -> None:
        self.x = value - self.width / 2

    @property
    def cy(self) -> float:
        """Centre Y: y + height/2."""
        return self.y + self.height / 2

    @cy.setter
    def cy(self, value: float) -> None:
        self.y = value - self.height / 2


@dataclass
class Region:
    """Semantic text/image region produced by any extractor."""
    id: str
    source: dict  # { "extractor": "pdf"|"ofd"|"ocr", "page": int }
    bbox: BBox
    type: Literal["text", "table", "image", "stamp"]
    text: str
    role: Optional[Literal["header", "body", "footer", "stamp"]] = None


@dataclass
class Page:
    """Page metadata, referencing Region IDs present on the page."""
    page_number: int
    width: float
    height: float
    regions: List[str] = field(default_factory=list)  # Region.id


@dataclass
class Table:
    """Table structure as a 2D matrix of Region IDs."""
    id: str
    regions: List[List[str]]  # [row][col] Region.id
    bbox: BBox
    page: int


@dataclass
class DocumentLayout:
    """Top-level contract: the output of layout analysis."""
    document_id: str
    pages: List[Page] = field(default_factory=list)
    regions: List[Region] = field(default_factory=list)
    tables: List[Table] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)
