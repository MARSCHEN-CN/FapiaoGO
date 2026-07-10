"""Encoder: Stateless image encoding, decoupled from Compose (v12 §12 ⑧).

ImageRef -> bytes. No cache, no state, no ref counting, no lifecycle.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from .models import ImageRef


class Encoder(ABC):
    @abstractmethod
    def jpeg(self, image: ImageRef, dpi: int) -> bytes: ...

    @abstractmethod
    def webp(self, image: ImageRef, dpi: int) -> bytes: ...

    @abstractmethod
    def image_pdf(self, image: ImageRef, dpi: int) -> bytes: ...
