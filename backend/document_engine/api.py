"""HTTP boundary (v12): only /render (= get_image), /compose, /encode.

No /layout (Layout is called internally by composer.py).
P2A: interface sketch; real Flask/FastAPI wiring in P5.
"""
from __future__ import annotations

from typing import Protocol

from .engine import DocumentEngine


class DocumentApi(Protocol):
    def render(self, source) -> object: ...  # = DocumentEngine.get_image
    def compose(self, req) -> object: ...
    def encode(self, image, fmt: str, dpi: int) -> bytes: ...
