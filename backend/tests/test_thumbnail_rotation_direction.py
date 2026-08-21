"""Legacy /thumbnail rotation-direction regression test.

Locks the fix for the 90/270 reversal regression introduced by 4f83b8d:

  * _render_image_page / _render_pdf_page (legacy /thumbnail path) must rotate
    content CLOCKWISE (y-down), matching the frontend canvas / Viewer CSS rotate().
  * Discriminator is 90 vs 270: a CW matrix puts the marker on the RIGHT at 90
    and on the LEFT at 270. The buggy {90:270,270:90} mapping swapped these.

We exercise the REAL engine functions (no mirror exists in the legacy path),
so this is an end-to-end lock on the rendered pixels — not a unit test of a map.
"""

import io
import os
import sys

import fitz
import numpy as np
import pytest
from PIL import Image
from dataclasses import dataclass
from typing import Optional

_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND_ROOT)

from render_engine.engine import RenderEngine
from render_engine.preset import RenderPreset


@dataclass
class _FakeDoc:
    file_bytes: bytes = b""
    path: str = "marker"
    pdf: Optional[object] = None
    adapter: Optional[object] = None


def _marker_png(size=150):
    img = Image.new("RGB", (size, size), "white")
    px = img.load()
    for dx in range(-3, 4):
        for dy in range(-3, 4):
            px[75 + dx, 10 + dy] = (220, 20, 20)  # red dot at top-center
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _marker_pdf(size=150):
    doc = fitz.open()
    doc.new_page(width=size, height=size)
    doc[0].draw_rect(fitz.Rect(72, 7, 78, 13), color=(1, 0.1, 0.1), fill=(1, 0.1, 0.1))
    buf = io.BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()


def _dot_cx(png_bytes):
    a = np.asarray(Image.open(io.BytesIO(png_bytes)).convert("RGB"))
    mask = (a[:, :, 0] > 150) & (a[:, :, 1] < 80) & (a[:, :, 2] < 80)
    xs = np.where(mask)[1]
    return xs.mean(), a.shape[1]


PRESET = RenderPreset(name="thumbnail", dpi=96, margin_mm=0, white_bg=True)


@pytest.mark.parametrize("cr,expect", [(90, "RIGHT"), (270, "LEFT")])
def test_thumbnail_image_rotation_cw(cr, expect):
    doc = _FakeDoc(file_bytes=_marker_png())
    out, _ = RenderEngine._render_image_page(None, doc, PRESET, {"rotation": cr}, 0, "png")
    cx, w = _dot_cx(out)
    side = "RIGHT" if cx > w / 2 else "LEFT"
    assert side == expect, f"image content_rotation={cr} must be CW ({expect}), got {side}"


@pytest.mark.parametrize("cr,expect", [(90, "RIGHT"), (270, "LEFT")])
def test_thumbnail_pdf_rotation_cw(cr, expect):
    pdf_bytes = _marker_pdf()
    pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    doc = _FakeDoc(pdf=pdf_doc)
    try:
        out, _ = RenderEngine._render_pdf_page(
            None, doc, PRESET, {"rotation": cr}, 0, "png", pdf_doc=pdf_doc)
        cx, w = _dot_cx(out)
        side = "RIGHT" if cx > w / 2 else "LEFT"
        assert side == expect, f"pdf content_rotation={cr} must be CW ({expect}), got {side}"
    finally:
        pdf_doc.close()
