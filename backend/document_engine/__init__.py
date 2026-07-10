"""Document Engine — single package, multiple logical engines (v12 API Design Review baseline).

P2A scope: contracts + reference in-memory implementations. The real renderer that
delegates to the existing renderers.js (Electron/pdf.js path) lands in P2B.

Locked invariants (see merge-mode-pdfjs-migration-plan.md v12):
- ImageRef is a frozen Value Object; `id` is generated ONLY by the Renderer.
- ImageHandle is RAII: business layer holds it via `with`/`async with`; scope exit
  auto-releases so the Repository can never leak.
- ImageRepository's ONLY writer is Renderer.render() internally. DocumentEngine
  depends on provider(read) + renderer(return-handle); it never touches the Repository.
- ImageProvider exposes exactly resolve/find/handle/open/prefetch. No CacheManager methods.
"""
from .models import (
    ImageRef,
    ImageMeta,
    ImageSource,
    Rect,
    LayoutResult,
    Paper,
    LayoutModel,
    ComposeItem,
    ComposeRequest,
    ComposeResult,
    PrintOptions,
    PixelInfo,
)
from .handles import (
    ImageHandle,
    PixelHandle,
    MemoryPixelHandle,
    ConcreteImageHandle,
)
from .provider import ImageProvider
from .cache import ImageRepository
from .renderer import Renderer
from .layout import LayoutEngine, GridLayoutEngine
from .composer import ComposeEngine
from .encoder import Encoder
from .engine import DocumentEngine

__all__ = [
    "ImageRef",
    "ImageMeta",
    "ImageSource",
    "Rect",
    "LayoutResult",
    "Paper",
    "LayoutModel",
    "ComposeItem",
    "ComposeRequest",
    "ComposeResult",
    "PrintOptions",
    "PixelInfo",
    "ImageHandle",
    "PixelHandle",
    "MemoryPixelHandle",
    "ConcreteImageHandle",
    "ImageProvider",
    "ImageRepository",
    "Renderer",
    "LayoutEngine",
    "GridLayoutEngine",
    "ComposeEngine",
    "Encoder",
    "DocumentEngine",
]
