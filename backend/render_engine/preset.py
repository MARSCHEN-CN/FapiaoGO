"""
RenderPreset — defines how a page is rendered: DPI, quality, margins, highlight.
A single dataclass; named by usage (preview / print / export / thumbnail).
"""

from dataclasses import dataclass, field
from typing import Dict


@dataclass
class RenderPreset:
    """Rendering parameters for a specific use-case."""
    name: str                    # "preview" | "print" | "export" | "thumbnail"
    dpi: int = 150
    quality: int = 88            # 0-100, for lossy formats
    margin_mm: float = 3.0       # white margin around content (mm)
    white_bg: bool = True        # fill white background before drawing
    fmt: str = "auto"            # "auto" | "webp" | "jpeg" | "png" — auto uses Accept
    chroma: str = "420"          # JPEG chroma subsampling: "420" | "444"
    highlight_style: str = "none"  # "none" | "yellow" | "red" | "mask" (Phase 2)


# ── Predefined presets ───────────────────────────────────────────

PRESETS: Dict[str, RenderPreset] = {
    "preview": RenderPreset(
        name="preview",
        dpi=150,
        quality=88,
        margin_mm=0,          # 屏幕预览不贴纸/边距，内容填满图像（与 canvas 路径一致）
        white_bg=True,
    ),
    "print": RenderPreset(
        name="print",
        dpi=200,
        quality=95,
        margin_mm=0,
        white_bg=True,
        chroma="444",
    ),
    "export": RenderPreset(
        name="export",
        dpi=200,
        quality=92,
        margin_mm=0,
        white_bg=True,
    ),
    "thumbnail": RenderPreset(
        name="thumbnail",
        dpi=48,
        quality=80,
        margin_mm=0,
        white_bg=True,
    ),
}
