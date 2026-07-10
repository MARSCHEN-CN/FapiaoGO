"""P2A reference in-memory implementations (for tests / local dev).

- InMemoryImageRepository: the only writer is reached via Renderer (see StubRenderer).
- InMemoryImageProvider: implements the locked 5-method READ facade.
- StubRenderer: P2A PLACEHOLDER. Returns a synthetic ImageHandle. In P2B this is
  replaced by a real renderer that calls the existing renderers.js (Electron/pdf.js).
"""
from __future__ import annotations

from typing import Dict, List

from .cache import ImageRepository
from .handles import ConcreteImageHandle, MemoryPixelHandle
from .models import ImageRef, ImageMeta, ImageSource, PixelInfo
from .provider import ImageProvider
from .renderer import Renderer


class InMemoryImageRepository(ImageRepository):
    def __init__(self):
        self._store: Dict[str, bytes] = {}
        self._refs: Dict[str, ImageRef] = {}
        self._counts: Dict[str, int] = {}
        self._info: Dict[str, PixelInfo] = {}

    def put_rendered_image(self, source_id: str, pixels: bytes, ref: ImageRef) -> None:
        self._store[source_id] = pixels
        self._refs[source_id] = ref
        self._counts[source_id] = self._counts.get(source_id, 0) + 1
        self._info[source_id] = PixelInfo(
            width=ref.width,
            height=ref.height,
            channels=4,
            stride=ref.width * 4,
            colorspace="srgb",
        )

    def handle(self, source_id: str):
        if source_id not in self._store:
            return None
        return MemoryPixelHandle(self._store[source_id], self._info[source_id])

    def evict(self, source_id: str) -> None:
        if self._counts.get(source_id, 0) <= 0:
            self._store.pop(source_id, None)
            self._refs.pop(source_id, None)
            self._info.pop(source_id, None)

    def release(self, source_id: str) -> None:
        self._counts[source_id] = max(0, self._counts.get(source_id, 0) - 1)

    def acquire(self, source_id: str) -> None:
        self._counts[source_id] = self._counts.get(source_id, 0) + 1

    def count(self, source_id: str) -> int:
        return self._counts.get(source_id, 0)


class InMemoryImageProvider(ImageProvider):
    def __init__(self, repo: InMemoryImageRepository):
        self._repo = repo

    def resolve(self, source: ImageSource) -> str:
        # deterministic id from source fields (page/dpi/rotation in key)
        return f"{source.kind}:{source.doc_id}:{source.page}:{source.dpi}:{source.rotation}"

    def find(self, source_id: str):
        return self._repo._refs.get(source_id)

    def handle(self, source_id: str):
        return self._repo.handle(source_id)

    def open(self, source_id: str):
        ref = self._repo._refs.get(source_id)
        if ref is None:
            return None
        self._repo.acquire(source_id)
        return ConcreteImageHandle(ref, self._repo.release)

    def prefetch(self, sources: List[ImageSource]) -> None:
        return None


class StubRenderer(Renderer):
    """P2A PLACEHOLDER. Generates a synthetic image + writes via Repository.

    In P2B this is replaced by a real renderer delegating to renderers.js.
    """

    def __init__(self, repo: InMemoryImageRepository):
        self._repo = repo

    def render(self, source: ImageSource) -> ConcreteImageHandle:
        source_id = (
            f"{source.kind}:{source.doc_id}:{source.page}:{source.dpi}:{source.rotation}"
        )
        # synthetic 1x1 pixel placeholder (NOT a real image; P2A marker only)
        pixels = b"\x89PNG\r\n\x1a\n"
        ref = ImageRef(
            id=source_id,
            width=1,
            height=1,
            dpi=source.dpi,
            meta=ImageMeta(
                mime="image/png",
                source=str(source.doc_id),
                page=source.page,
                rotation=source.rotation,
            ),
        )
        self._repo.put_rendered_image(source_id, pixels, ref)
        return ConcreteImageHandle(ref, self._repo.release)
