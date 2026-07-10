"""ImageRepository: the ONLY store (v12).

Locked: the only writer is Renderer.render() (via put_rendered_image).
DocumentEngine / ImageProvider / Compose never write directly.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from .handles import PixelHandle
from .models import ImageRef


class ImageRepository(ABC):
    @abstractmethod
    def put_rendered_image(self, source_id: str, pixels: bytes, ref: ImageRef) -> None:
        """ONLY called by Renderer.render() internally (write + ref count +1)."""

    @abstractmethod
    def handle(self, source_id: str) -> PixelHandle | None:
        """read handle; never raw bytes."""

    @abstractmethod
    def evict(self, source_id: str) -> None:
        """true reclaim when count == 0 and LRU/TTL triggers."""

    @abstractmethod
    def release(self, source_id: str) -> None:
        """ref count -1 (called only by ImageHandle on scope exit)."""

    @abstractmethod
    def acquire(self, source_id: str) -> None:
        """ref count +1 on cache hit (called only by ImageProvider.open)."""
