"""
Shared data types for the Render Engine pipeline.

BBox / TextSpan form the "Geometry" side of the Image+Geometry Producer contract.
"""

from dataclasses import dataclass
from typing import List


@dataclass
class BBox:
    """
    Bounding box — fractional coordinates relative to the page.

    All coordinates are in PDF user space (points, 1/72 inch).
    origin = top-left corner of the page.
    """
    x0: float
    y0: float
    x1: float
    y1: float
    page: int = 0


@dataclass
class TextSpan:
    """A span of text with its bounding box."""
    text: str
    bbox: BBox
