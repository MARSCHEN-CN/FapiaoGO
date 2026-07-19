"""D3-3d-1 contract: executor can draw MULTIPLE RenderCommands onto ONE page.

This is the "same-sheet" capability for Case ③ (one A4, N invoices). It changes
ONLY the executor contract: draw_render_command(page, command, source_bytes)
draws onto a caller-provided page. The service is NOT touched here (D3-3d-2 wires
it). The existing render_command_to_page (one command -> one page) is kept
backward-compatible so the live service still works.

Invariants locked:
  • N draw_render_command calls on one page -> exactly 1 page with N images.
  • each command's offset lands at its absolute (offsetX, offsetY) on the page.
  • rotation is still applied per-command (footprint orientation changes).
  • no new_page inside draw_render_command (page lifecycle stays with the caller).
  • degenerate (scale=0) skips draw but keeps the shared page.
"""

import fitz

from services.render_executor import draw_render_command, render_command_to_page, paper_px


def _make_source_png(w, h, color=(1.0, 0.0, 0.0)):
    """Build a solid-color PNG (bytes) of size w x h via fitz."""
    d = fitz.open()
    p = d.new_page(width=w, height=h)
    shape = p.new_shape()
    shape.draw_rect(fitz.Rect(0, 0, w, h))
    shape.finish(color=color, fill=color)
    shape.commit()
    b = d.tobytes()
    d.close()
    return b


def _paper_a4_300():
    return {'widthMm': 210.0, 'heightMm': 297.0, 'dpi': 300}


def _cmd(offset_x, offset_y, rb=(1000, 1414), rotation=0, scale=0.5):
    return {
        'version': 1,
        'paper': _paper_a4_300(),
        'rotatedBounds': {'width': rb[0], 'height': rb[1]},
        'placement': {'scale': scale, 'offsetX': float(offset_x), 'offsetY': float(offset_y)},
        'contentRotation': rotation,
        'rotation': 0,
        'clip': {'x': 0, 'y': 0, 'width': 2480, 'height': 3508},
        'sourceRef': {'path': 'x.png', 'page': 0},
    }


def test_draw_two_commands_share_one_page():
    doc = fitz.open()
    try:
        pw, ph = paper_px(_paper_a4_300())
        page = doc.new_page(width=pw, height=ph)
        # distinct sources (color + size) so fitz keeps two image XObjects
        draw_render_command(page, _cmd(100, 100), _make_source_png(1000, 1414, (1, 0, 0)))
        draw_render_command(page, _cmd(1500, 1500), _make_source_png(800, 1200, (0, 0, 1)))
        # one page, two images -- NOT two pages
        assert len(doc) == 1
        assert len(page.get_images()) == 2
    finally:
        doc.close()


def test_command_offsets_land_at_expected_positions():
    doc = fitz.open()
    try:
        pw, ph = paper_px(_paper_a4_300())
        page = doc.new_page(width=pw, height=ph)
        zoom = 0.1
        draw_render_command(page, _cmd(100, 100), _make_source_png(1000, 1414, (1, 0, 0)))
        draw_render_command(page, _cmd(1500, 1500), _make_source_png(1000, 1414, (0, 0, 1)))
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
        # each image top-left ~= its command offset (sample a few px inside the edge)
        r_px = pix.pixel(int((100 + 50) * zoom), int((100 + 50) * zoom))
        b_px = pix.pixel(int((1500 + 50) * zoom), int((1500 + 50) * zoom))
        # red command -> reddish; blue command -> bluish; both clearly non-white
        assert r_px[0] > 150 and r_px[2] < 100, r_px
        assert b_px[2] > 150 and b_px[0] < 100, b_px
    finally:
        doc.close()


def test_rotation_90_on_shared_page_single_page_and_applied():
    doc = fitz.open()
    try:
        pw, ph = paper_px(_paper_a4_300())
        page = doc.new_page(width=pw, height=ph)
        zoom = 0.1
        # 0 deg at (100,100): portrait footprint -> extends DOWNWARD (tall)
        draw_render_command(page, _cmd(100, 100, rb=(1000, 1414), rotation=0, scale=0.5),
                            _make_source_png(1000, 1414, (1, 0, 0)))
        # 90 deg at (1200,100) on SAME page: rotation applied -> extends RIGHTWARD (wide)
        draw_render_command(page, _cmd(1200, 100, rb=(1000, 1414), rotation=90, scale=0.5),
                            _make_source_png(1000, 1414, (0, 1, 0)))
        assert len(doc) == 1
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
        # point well inside the 0deg portrait footprint (centered, low) -> red
        p0 = pix.pixel(int((100 + 250) * zoom), int((100 + 600) * zoom))
        assert p0[0] > 150, p0  # reddish -> portrait present
        # point well inside the 90deg landscape footprint (right, centered) -> green
        # (offset 1200 is far from the 0deg footprint max-x 600, so no overlap)
        p90 = pix.pixel(int((1200 + 600) * zoom), int((100 + 250) * zoom))
        assert p90[1] > 150, p90  # greenish -> rotation applied (landscape present)
    finally:
        doc.close()


def test_backward_compat_single_command_own_page():
    """render_command_to_page (live service path) must still make ONE page per call."""
    doc = fitz.open()
    try:
        render_command_to_page(doc, _cmd(100, 100), _make_source_png(1000, 1414))
        render_command_to_page(doc, _cmd(100, 100), _make_source_png(1000, 1414))
        assert len(doc) == 2
    finally:
        doc.close()


def test_degenerate_scale_skips_draw_on_shared_page():
    doc = fitz.open()
    try:
        pw, ph = paper_px(_paper_a4_300())
        page = doc.new_page(width=pw, height=ph)
        draw_render_command(page, _cmd(100, 100, scale=0.0), _make_source_png(1000, 1414))
        assert len(page.get_images()) == 0  # collapsed contentRect -> nothing drawn
        assert len(doc) == 1  # page still exists
    finally:
        doc.close()
