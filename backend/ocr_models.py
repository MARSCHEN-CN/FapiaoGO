from dataclasses import dataclass


@dataclass
class BoundingBox:
    x1: float
    y1: float
    x2: float
    y2: float
    page: int


@dataclass
class OCRToken:
    text: str
    confidence: float
    bbox: BoundingBox


@dataclass
class OCRLine:
    text: str
    tokens: list[OCRToken]
    bbox: BoundingBox


@dataclass
class OCRPage:
    page_number: int
    lines: list[OCRLine]


@dataclass
class OCRResult:
    pages: list[OCRPage]
