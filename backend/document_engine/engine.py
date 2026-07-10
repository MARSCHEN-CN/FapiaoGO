"""DocumentEngine facade (v12): the ONLY orchestration entry.

Depends on ImageProvider (read) + Renderer (returns ImageHandle).
Does NOT import or touch the Repository directly (dependency inversion).
"""
from __future__ import annotations

from .handles import ImageHandle
from .models import ImageSource
from .provider import ImageProvider
from .renderer import Renderer


class DocumentEngine:
    def __init__(self, provider: ImageProvider, renderer: Renderer):
        self._provider = provider
        self._renderer = renderer

    def get_image(self, source: ImageSource) -> ImageHandle:
        """Single orchestration point.

        Hit  -> provider.open(id) (find + acquire + return Handle, count +1)
        Miss -> renderer.render(source) (Renderer writes Repository + returns Handle)
        """
        source_id = self._provider.resolve(source)
        hit = self._provider.open(source_id)
        if hit is not None:
            return hit
        return self._renderer.render(source)
