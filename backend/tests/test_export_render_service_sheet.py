"""D3-3d-2 Export Render Service — same-sheet (multi-ticket compose) contract.

Locks the scheme-B same-sheet behavior end-to-end through execute_export_render:

  1. Four image commands (one A4, 4 invoices) -> ONE sheet page (page_count == 1).
  2. Offset realness: each ticket's pixels actually land in its quadrant of the
     shared paper (not just "1 page exists"). Verified by pixel-sampling the
     output sheet at each quadrant centre.
  3. Rotation direction lock: contentRotation 0/90/180/270 must rotate the
     source CLOCKWISE (y-down), matching the frontend canvas ctx.rotate(+theta).
     The discriminator is 90 vs 270 — if the matrix were CCW those would swap;
     we assert the marker lands on the RIGHT at 90 and on the LEFT at 270.
  4. Single-command regression: one image command -> one page, paper-sized
     (2480x3508 @ A4@300dpi). No behaviour lost from the D3-3b-3 single path.

Pixel sampling renders the sheet at a small zoom (0.1) and reads RGB at scaled
coords — robust, and does not depend on fragile fitz image introspection
(which proved version-fragile in D3-3d-1).
"""

import os
import sys
import tempfile

import fitz
import pytest

_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND_ROOT)

from services.export_render_service import execute_export_render


# --- sample-image builders -------------------------------------------------

def _write_tmp(suffix, data):
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, 'wb') as fh:
        fh.write(data)
    return path


def _solid_png(rgb):
    """A 1000x1414 solid-colour PNG (bytes)."""
    doc = fitz.open()
    doc.new_page(width=1000, height=1414)
    doc[0].draw_rect(fitz.Rect(0, 0, 1000, 1414),
                     color=rgb, fill=rgb)
    data = doc[0].get_pixmap().tobytes('png')
    doc.close()
    return data


def _marker_png():
    """Portrait 1000x1414: red bg with a GREEN bar across the TOP edge.

    After a CW rotation the top bar must move: 0->top, 90->right, 180->bottom,
    270->left. This is the direction discriminator.
    """
    doc = fitz.open()
    doc.new_page(width=1000, height=1414)
    doc[0].draw_rect(fitz.Rect(0, 0, 1000, 1414), color=(1, 0, 0), fill=(1, 0, 0))
    doc[0].draw_rect(fitz.Rect(0, 0, 1000, 120), color=(0, 1, 0), fill=(0, 1, 0))
    data = doc[0].get_pixmap().tobytes('png')
    doc.close()
    return data


def _image_command(path, offset, color_placeholder=None, content_rotation=0,
                   scale=0.4, rotated_bounds=None):
    rb = rotated_bounds or {'width': 1000, 'height': 1414}
    if content_rotation in (90, 270):
        rb = {'width': rb['height'], 'height': rb['width']}
    return {
        "version": 1,
        "sourceRef": {"path": path, "page": 0},
        "paper": {"widthMm": 210.0, "heightMm": 297.0, "dpi": 300},
        "placement": {"scale": scale, "offsetX": offset[0], "offsetY": offset[1]},
        "rotatedBounds": rb,
        "contentRotation": content_rotation,
        "rotation": 0,
        "clip": {"x": 0, "y": 0, "width": 2480, "height": 3508},
    }


# --- pixel helpers ---------------------------------------------------------

def _render_sheet(data, zoom=0.1):
    doc = fitz.open(stream=data)
    pix = doc[0].get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    doc.close()
    return pix


def _is_color(pix, x, y, kind):
    if x < 0 or y < 0 or x >= pix.width or y >= pix.height:
        return False
    r, g, b = pix.pixel(x, y)
    if kind == 'red':
        return r > 200 and g < 80 and b < 80
    if kind == 'green':
        return g > 200 and r < 100 and b < 100
    if kind == 'blue':
        return b > 200 and r < 80 and g < 80
    if kind == 'yellow':
        return r > 200 and g > 200 and b < 80
    return False


# world coord -> zoomed coord (zoom=0.1)
Z = 0.1


# --- tests -----------------------------------------------------------------

def test_four_tickets_share_one_sheet_page():
    paths = []
    try:
        colors = [(1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 0)]
        # four quadrants of an A4@300 sheet (2480x3508)
        offsets = [(100, 100), (2080, 100), (100, 2842), (2080, 2842)]
        commands = []
        for rgb, off in zip(colors, offsets):
            p = _write_tmp('.png', _solid_png(rgb))
            paths.append(p)
            commands.append(_image_command(p, off))

        data = execute_export_render(commands)
        doc = fitz.open(stream=data)
        try:
            assert len(doc) == 1, "4 image tickets must share one sheet page"
            assert (int(doc[0].rect.width), int(doc[0].rect.height)) == (2480, 3508)
        finally:
            doc.close()
    finally:
        for p in paths:
            os.remove(p)


def test_four_ticket_offsets_land_in_quadrants():
    paths = []
    try:
        colors = [(1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 0)]
        offsets = [(100, 100), (2080, 100), (100, 2842), (2080, 2842)]
        # sample at each quadrant centre (world coords)
        samples = [(300, 380, 'red'), (2280, 380, 'green'),
                   (300, 3110, 'blue'), (2280, 3110, 'yellow')]
        commands = []
        for rgb, off in zip(colors, offsets):
            p = _write_tmp('.png', _solid_png(rgb))
            paths.append(p)
            commands.append(_image_command(p, off))

        data = execute_export_render(commands)
        pix = _render_sheet(data, Z)
        for wx, wy, kind in samples:
            assert _is_color(pix, int(wx * Z), int(wy * Z), kind), \
                f"quadrant sample ({wx},{wy}) expected {kind}"
    finally:
        for p in paths:
            os.remove(p)


def _green_centroid(pix):
    xs, ys = [], []
    for yy in range(pix.height):
        for xx in range(pix.width):
            r, g, b = pix.pixel(xx, yy)
            if g > 180 and r < 100 and b < 100:
                xs.append(xx)
                ys.append(yy)
    if not xs:
        return None
    return (sum(xs) / len(xs), sum(ys) / len(ys))


def test_rotation_0_90_180_270_direction_matches_frontend_cw():
    # The marker (green bar at source TOP) must rotate CLOCKWISE (y-down),
    # matching the frontend canvas ctx.rotate(+theta). We compare the green
    # centroid to the CENTER OF THE DRAWN RECT (not the sheet center -- the rect
    # is itself offset, so the sheet center is meaningless here). The key
    # discriminator is 90 vs 270: if the matrix were CCW these would swap.
    paths = []
    try:
        marker = _marker_png()
        # offset (500,500), scale 0.4, zoom 0.1.
        # rot 0/180: rb 1000x1414 -> drawn 400x566 -> rect-center zoom (70.0, 78.3)
        # rot 90/270: rb 1414x1000 -> drawn 565.6x400 -> rect-center zoom (78.3, 70.0)
        cases = [
            (0,   'top',    (70.0, 78.3)),
            (90,  'right',  (78.3, 70.0)),
            (180, 'bottom', (70.0, 78.3)),
            (270, 'left',   (78.3, 70.0)),
        ]
        for rotation, side, center in cases:
            p = _write_tmp('.png', marker)
            paths.append(p)
            data = execute_export_render([_image_command(p, (500, 500),
                                                         content_rotation=rotation)])
            pix = _render_sheet(data, Z)
            cen = _green_centroid(pix)
            assert cen is not None, f"rot={rotation}: green marker missing"
            cx, cy = cen
            if side == 'top':
                assert cy < center[1], f"rot=0: marker should be ABOVE rect center (cy={cy:.1f} < {center[1]})"
            elif side == 'bottom':
                assert cy > center[1], f"rot=180: marker should be BELOW rect center (cy={cy:.1f} > {center[1]})"
            elif side == 'right':
                assert cx > center[0], f"rot=90: marker should be RIGHT of rect center (cx={cx:.1f} > {center[0]}) -- CW"
            elif side == 'left':
                assert cx < center[0], f"rot=270: marker should be LEFT of rect center (cx={cx:.1f} < {center[0]}) -- CW"
        # CW discriminator across the 0/180 (vertical) vs 90/270 (horizontal) axis:
        # 90 is RIGHT, 270 is LEFT -- a CCW matrix would put them on the same side.
        p90 = _write_tmp('.png', marker)
        p270 = _write_tmp('.png', marker)
        paths += [p90, p270]
        c90 = _green_centroid(_render_sheet(
            execute_export_render([_image_command(p90, (500, 500), content_rotation=90)]), Z))
        c270 = _green_centroid(_render_sheet(
            execute_export_render([_image_command(p270, (500, 500), content_rotation=270)]), Z))
        assert c90[0] > 78.3 and c270[0] < 78.3, \
            "rotation matrix must be CW: 90 -> right, 270 -> left (got 90x=%.1f 270x=%.1f)" % (c90[0], c270[0])
    finally:
        for p in paths:
            os.remove(p)


def test_single_command_regression_one_page():
    p = _write_tmp('.png', _solid_png((0.2, 0.6, 1.0)))
    try:
        data = execute_export_render([_image_command(p, (100, 100))])
        doc = fitz.open(stream=data)
        try:
            assert len(doc) == 1
            assert (int(doc[0].rect.width), int(doc[0].rect.height)) == (2480, 3508)
        finally:
            doc.close()
    finally:
        os.remove(p)
