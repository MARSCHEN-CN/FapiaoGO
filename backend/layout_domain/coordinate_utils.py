from contracts.document_layout import BBox


def from_points(x1: float, y1: float, x2: float, y2: float) -> BBox:
    """Convert (x1,y1,x2,y2) to (x,y,w,h)."""
    return BBox(
        x=min(x1, x2),
        y=min(y1, y2),
        width=abs(x2 - x1),
        height=abs(y2 - y1),
    )


def from_ocr_bbox(ocr_bbox) -> BBox:
    """Adapt ocr_models.BoundingBox to contracts.BBox."""
    return from_points(ocr_bbox.x1, ocr_bbox.y1, ocr_bbox.x2, ocr_bbox.y2)
