"""Value objects for the Document Engine (P2A contracts).

Locked invariants (v12):
- ImageRef is a FROZEN Value Object. `id` is generated ONLY by the Renderer.
  No layer may mutate or recompute `id`. Compose must build a NEW ImageRef.
- meta is a frozen dataclass too, so `image.meta.rotation = 90` raises
  FrozenInstanceError at runtime instead of silently corrupting cache keys.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Union


@dataclass(frozen=True)
class ImageMeta:
    """Frozen provenance/debug metadata. Never mutated after creation."""

    mime: str = "image/png"
    source: str = ""
    page: int = 0
    rotation: int = 0
    # future: checksum / icc_profile / color_space / render_time ...


@dataclass(frozen=True)
class ImageRef:
    """Immutable, identity-stable reference to a rendered image.

    `id` is assigned once by the Renderer and MUST NOT be changed or recomputed
    by any other layer. Treat this as a Value Object.
    """

    id: str
    width: int
    height: int
    dpi: int
    meta: ImageMeta = field(default_factory=ImageMeta)


@dataclass(frozen=True)
class ImageSource:
    """Discriminated union of parse inputs (business-orchestration layer only)."""

    kind: Literal["docId", "file", "scanner", "clipboard", "remote", "memory"]
    doc_id: str | None = None
    page: int = 0
    dpi: int = 150
    rotation: int = 0
    path: str | None = None
    url: str | None = None
    bitmap: bytes | None = None  # for kind == "memory"

    @classmethod
    def from_doc(cls, doc_id: str, page: int, dpi: int, rotation: int) -> "ImageSource":
        return cls(kind="docId", doc_id=doc_id, page=page, dpi=dpi, rotation=rotation)


@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    w: int
    h: int


@dataclass(frozen=True)
class LayoutResult:
    """Layout output. Wraps Rect[] so Booklet/N-up/Label/Duplex can later add
    `paper_transforms` without changing the interface (v12 naming reservation)."""

    rects: list[Rect]
    # future: paper_transforms: list[PaperTransform] | None = None


@dataclass(frozen=True)
class Paper:
    width: int
    height: int


@dataclass(frozen=True)
class LayoutModel:
    strategy: str = "grid"
    margin: int = 0
    spacing: int = 0


@dataclass(frozen=True)
class ComposeItem:
    """One item placed into a compose. Future fields (scale/opacity/clip/mirror/
    crop/mask/blend) are additive — the interface never changes (v12)."""

    image: ImageRef
    rotation: int = 0


@dataclass(frozen=True)
class ComposeRequest:
    paper: Paper
    layout: LayoutModel
    items: list[ComposeItem]


# ComposeResult is just an ImageRef (immutable). Aliased for readability.
ComposeResult = ImageRef


@dataclass(frozen=True)
class PrintOptions:
    paper_kind: str = "A4"
    fit: bool = True
    monochrome: bool = False


@dataclass(frozen=True)
class PixelInfo:
    """Authoritative pixel metadata (v12). GPU/MMAP/Remote may not expose a full
    ImageRef, so metadata lives here and is fetched via PixelHandle.info()."""

    width: int
    height: int
    channels: int
    stride: int
    colorspace: str
