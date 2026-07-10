"""Layout Engine: pure geometry, strictly stateless (v12 §12 ⑥).

No cache, no image knowledge. Paper -> LayoutResult(rects).
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from .models import LayoutResult, Paper


class LayoutEngine(ABC):
    @abstractmethod
    def layout(
        self, paper: Paper, count: int, margin: int, spacing: int
    ) -> LayoutResult:
        ...


class GridLayoutEngine(LayoutEngine):
    """Reference pure-function layout (P2A). No state, no side effects."""

    def layout(
        self, paper: Paper, count: int, margin: int, spacing: int
    ) -> LayoutResult:
        from .models import Rect

        if count <= 0:
            return LayoutResult(rects=[])

        usable_w = paper.width - 2 * margin
        usable_h = paper.height - 2 * margin
        # crude auto-grid: pick a column count that fits at least one row of squares
        cols = max(1, int((usable_w + spacing) / (200 + spacing)) or 1)
        cell_w = (usable_w - spacing * (cols - 1)) // cols
        cell_h = cell_w
        rects: list[Rect] = []
        for i in range(count):
            r, c = divmod(i, cols)
            x = margin + c * (cell_w + spacing)
            y = margin + r * (cell_h + spacing)
            rects.append(Rect(x, y, cell_w, cell_h))
        return LayoutResult(rects=rects)
