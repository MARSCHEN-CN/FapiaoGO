"""Renderer: the ONLY writer of the Repository (v12, dependency inversion).

render() is responsible for: parse page -> pixels -> repository.put_rendered_image
(write + count +1) -> return ImageHandle. DocumentEngine never touches Repository.

P2A: the concrete renderer that calls the existing renderers.js (Electron/pdf.js path)
is wired in P2B. Here we keep the interface + a clearly-marked placeholder so the
contracts are executable and testable.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from .handles import ImageHandle
from .models import ImageSource


class Renderer(ABC):
    @abstractmethod
    def render(self, source: ImageSource) -> ImageHandle:
        """Render source -> pixels, write to Repository internally, return ImageHandle."""
