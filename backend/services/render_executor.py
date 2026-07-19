"""D3-3b-1 Render Executor — RenderCommand → fitz drawing (pure executor).

Ownership contract (D3-1 / D3-3a / D3-3b-0 audits):
  • Geometry is owned by the FRONTEND (createPlacement). This module CONSUMES
    the already-resolved RenderCommand: paper / placement / rotatedBounds /
    clip / contentRotation. It NEVER recomputes fit / scale / center / rotation.
  • The ONLY legitimate px derivation here is
        paper_px = round(widthMm * dpi / 25.4)
    and it MUST mirror frontend mmToPxFactor EXACTLY — including round-half-UP
    (see _js_round). Divergence = silent Preview≠Export drift.
  • Forbidden (grep-banned in tests): _apply_margins / scale=min(...) / center /
    fit / fit_scale. The backend only TRANSLATES geometry into fitz draw ops.

Input : RenderCommand (dict) + source bytes
Output: appends a fitz page to the given doc; returns the page.
"""

import math

try:
    import fitz
except ImportError:  # pragma: no cover - fitz is a hard backend dep
    fitz = None

_ALLOWED_ROTATIONS = (0, 90, 180, 270)


def _js_round(x: float) -> int:
    """Mirror JS Math.round (round half UP), NOT Python's banker's rounding.

    Frontend uses Math.round(mm * dpi / 25.4). Python's builtin round() uses
    round-half-to-even and would silently diverge by 1px on exact .5 inputs,
    breaking the Preview≡Export invariant. Replicate JS semantics instead.
    """
    return int(math.floor(x + 0.5))


def paper_px(paper: dict) -> tuple:
    """Backend-only px derivation. Byte-for-byte mirror of frontend mmToPxFactor.

    paper = PaperSpec {widthMm, heightMm, dpi}.
    Returns (width_px, height_px) via round(widthMm * dpi / 25.4).
    """
    w = _js_round(paper['widthMm'] * paper['dpi'] / 25.4)
    h = _js_round(paper['heightMm'] * paper['dpi'] / 25.4)
    return w, h


def _rotation_matrix(scale: float, rotation: int) -> 'fitz.Matrix':
    """Build a fitz transform matrix scaling by `scale` and rotating by
    `rotation` degrees CLOCKWISE (y-down), matching the frontend canvas
    `ctx.rotate(cr * PI/180)` in renderDraw.js.

    fitz Matrix(a, b, c, d) maps (x, y) -> (a*x + c*y, b*x + d*y).
    In y-down coords, CW 90° satisfies (x, y) -> (-y, x), giving
    (a, b, c, d) = (0, 1, -1, 0). General CW-θ with scale:
        (cosθ*scale, sinθ*scale, -sinθ*scale, cosθ*scale).
    """
    rad = math.radians(rotation)
    cos_t = math.cos(rad)
    sin_t = math.sin(rad)
    # fitz.Matrix 接受 6 元组 (a, b, c, d, e, f)，e/f 为平移分量（此处为 0）。
    return fitz.Matrix(
        cos_t * scale, sin_t * scale,
        -sin_t * scale, cos_t * scale,
        0.0, 0.0,
    )


def render_command_to_page(doc, command: dict, source_bytes: bytes):
    """Draw a single RenderCommand onto a NEW page appended to `doc`.

    Pure executor: translates the frontend's already-resolved geometry into
    fitz draw ops. Never recomputes fit / scale / center / rotation.

    Returns the created fitz page.
    """
    if fitz is None:
        raise RuntimeError("PyMuPDF (fitz) is not available")

    paper = command['paper']
    pw, ph = paper_px(paper)
    page = doc.new_page(width=pw, height=ph)

    placement = command['placement']
    scale = float(placement['scale'])
    offset_x = float(placement['offsetX'])
    offset_y = float(placement['offsetY'])

    rotation = int(command.get('contentRotation', 0) or 0)
    if rotation not in _ALLOWED_ROTATIONS:
        rotation = 0

    # bbox from rotatedBounds — already provided by the frontend. CONSUME, do NOT
    # recompute (that would be a second geometry owner).
    rb = command['rotatedBounds']
    draw_w = float(rb['width']) * scale
    draw_h = float(rb['height']) * scale

    # degenerate: frontend scale=0 / collapsed contentRect → nothing to draw.
    if scale <= 0 or draw_w <= 0 or draw_h <= 0:
        return page

    # clip is CONSUMED defensively. The fit model guarantees the drawn rect is
    # within clip (createPlacement centers into contentRect == clip). If a future
    # caller sends a placement overflowing clip, fail loudly instead of silently
    # clipping — keeps geometry ownership single-source (frontend only).
    clip = command.get('clip')
    if clip:
        drawn = fitz.Rect(offset_x, offset_y, offset_x + draw_w, offset_y + draw_h)
        clip_rect = fitz.Rect(
            clip['x'], clip['y'],
            clip['x'] + clip['width'], clip['y'] + clip['height'],
        )
        if not clip_rect.contains(drawn):
            raise ValueError(
                "RenderCommand placement overflows clip — geometry must be resolved "
                "by the frontend (createPlacement). Backend does not clip."
            )

    # source → pixmap at the resolved scale + rotation (CW, y-down == frontend)
    src_doc = fitz.open(stream=source_bytes)
    try:
        page_idx = int((command.get('sourceRef') or {}).get('page', 0) or 0)
        if page_idx < 0 or page_idx >= len(src_doc):
            page_idx = 0
        src_page = src_doc[page_idx]
        matrix = _rotation_matrix(scale, rotation)
        pix = src_page.get_pixmap(matrix=matrix)
    finally:
        src_doc.close()

    # insert using the pixmap's own (post-transform) size → pixel-exact placement
    target = fitz.Rect(offset_x, offset_y, offset_x + pix.width, offset_y + pix.height)
    page.insert_image(target, pixmap=pix)
    return page
