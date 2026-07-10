"""Compose Engine: geometry-only synthesis, NO encoding, NO Repository import (v12 §12 ⑦).

Pixels are read read-only via ImageProvider.handle(image_id).as_bitmap().
Compose must build a NEW ImageRef (new id) for the result — never mutate inputs.
Concrete impl moves from Electron in P5; interface defined in P2A.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from .models import ComposeRequest, ComposeResult


class ComposeEngine(ABC):
    @abstractmethod
    def compose(self, req: ComposeRequest) -> ComposeResult:
        ...
