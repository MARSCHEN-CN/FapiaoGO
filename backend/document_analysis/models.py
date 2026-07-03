from dataclasses import dataclass

from backend.ocr_models import BoundingBox


@dataclass
class Anchor:
    name: str
    text: str
    bbox: BoundingBox


@dataclass
class Region:
    region_id: str
    bbox: BoundingBox
    text: str


@dataclass
class DocumentLayout:
    anchors: list[Anchor]
    regions: list[Region]
