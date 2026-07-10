"""ImageProvider: pure READ facade over the Repository (v12).

Locked boundary (§12 ③b): ONLY resolve / find / handle / open / prefetch.
Forbidden: invalidate / clear / stats / memory / pin (CacheManager methods).
`open` / `acquire` / `release` are ref-count lifecycle, NOT cache management.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List

from .handles import ImageHandle, PixelHandle
from .models import ImageRef, ImageSource


class ImageProvider(ABC):
    @abstractmethod
    def resolve(self, source: ImageSource) -> str:
        """source -> deterministic id (page/dpi/rotation in key)."""

    @abstractmethod
    def find(self, source_id: str) -> ImageRef | None:
        """metadata only, no pixels."""

    @abstractmethod
    def handle(self, source_id: str) -> PixelHandle | None:
        """read-only pixel handle (Compose reads via this)."""

    @abstractmethod
    def open(self, source_id: str) -> ImageHandle | None:
        """cache hit: find + acquire + return ImageHandle (ref count +1)."""

    @abstractmethod
    def prefetch(self, sources: List[ImageSource]) -> None:
        ...
