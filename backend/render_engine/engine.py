"""
RenderEngine — unified rendering entry (Image + Geometry Producer).

render(doc, preset, view_state, page, highlights) → (bytes, format, etag)
"""

import io
import logging
from typing import Optional, Tuple

from .preset import RenderPreset, PRESETS
from .cache import RenderCache, generate_etag, make_cache_key

logger = logging.getLogger(__name__)

try:
    import fitz
except ImportError:
    fitz = None

# A4 dimensions in mm (used as default page size for image rendering)
A4_W_MM = 210.0
A4_H_MM = 297.0
MM_PER_INCH = 25.4
PDF_DPI = 72.0

# ── format negotiation ──────────────────────────────────────────

_FORMAT_MIME = {
    "image/webp": "webp",
    "image/jpeg": "jpeg",
    "image/png": "png",
    # Phase 3: "image/avif": "avif",
    "webp": "webp",
    "jpeg": "jpeg",
}

_FORMAT_EXT = {"webp": "webp", "jpeg": "jpg", "png": "png"}


def negotiate_format(accept_header: str, preset_fmt: str) -> str:
    """Resolve output format from Accept header."""
    if preset_fmt != "auto":
        return _FORMAT_EXT.get(preset_fmt, "webp")

    if not accept_header:
        return "webp"

    # Simple priority: avif > webp > jpeg > png
    for mime, fmt in [("image/avif", "avif"),
                       ("image/webp", "webp"),
                       ("image/jpeg", "jpeg")]:
        if mime in accept_header:
            if fmt in ("webp", "jpeg"):
                return fmt
    return "webp"


# ── DocumentPage ────────────────────────────────────────────────

class DocumentPage:
    """
    Unified page-level API for a single page of a registered document.

    Converges render / extract / text / bbox / highlight onto one object
    so Engine doesn't accumulate methods.  Usage:

        page = engine.page(doc_id, 5)
        data, fmt, etag = page.render("preview", view_state=vs)
        pdf_bytes = page.extract_pdf()
    """

    def __init__(self, engine: "RenderEngine", doc_id: str, page_no: int):
        self._engine = engine
        self._doc_id = doc_id
        self._page_no = page_no
        doc = engine._registry.get(doc_id)
        if doc is None:
            raise ValueError(f"Document not found: {doc_id[:12]}...")
        if page_no < 1 or page_no > doc.page_count:
            raise ValueError(f"Page {page_no} out of range (1–{doc.page_count})")
        self._doc = doc

    @property
    def doc_id(self) -> str:
        return self._doc_id

    @property
    def page_no(self) -> int:
        return self._page_no

    @property
    def page_count(self) -> int:
        return self._doc.page_count

    # ── rendering ─────────────────────────────────────────────

    def render(self, preset_name: str = "preview",
               view_state: dict = None, highlights: list = None,
               hl_token: str = None, accept_header: str = "",
               override_params: dict = None) -> Tuple[bytes, str, str]:
        """Render this page. Delegates to Engine.render()."""
        return self._engine.render(
            doc_id=self._doc_id,
            preset_name=preset_name,
            view_state=view_state,
            page=self._page_no,
            highlights=highlights,
            hl_token=hl_token,
            accept_header=accept_header,
            override_params=override_params,
        )

    def extract_pdf(self) -> bytes:
        """Extract this page as standalone PDF bytes."""
        return self._engine.extract_page_pdf(self._doc_id, self._page_no)

    # ── content (Phase 2 stubs) ───────────────────────────────

    def text(self) -> str:
        """Get text content of this page. Phase 2 — uses Content Index."""
        return ""

    def bbox(self) -> list:
        """Get text bounding boxes of this page. Phase 2 — uses Content Index."""
        return []

    def highlight(self, rects: list, style: str = "yellow",
                  preset_name: str = "preview",
                  view_state: dict = None,
                  accept_header: str = "") -> Tuple[bytes, str, str]:
        """
        Render this page with highlight rectangles baked in.
        Phase 2 — pass rects to engine.render(highlights=rects).
        """
        return self._engine.render(
            doc_id=self._doc_id,
            preset_name=preset_name,
            view_state=view_state,
            page=self._page_no,
            highlights=rects,
            hl_token=_make_hl_token(rects),
            accept_header=accept_header,
        )


# ── Engine ──────────────────────────────────────────────────────

class RenderEngine:
    """Unified rendering engine for all document types."""

    def __init__(self, registry, cache: RenderCache, queue):
        self._registry = registry
        self._cache = cache
        self._queue = queue

    # ── public API ──────────────────────────────────────────────

    def render(self, doc_id: str, preset_name: str = "preview",
               view_state: dict = None, page: int = 1,
               highlights: list = None, hl_token: str = None,
               accept_header: str = "",
               override_params: dict = None) -> Tuple[bytes, str, str]:
        """
        Render a single page. Returns (image_bytes, format, etag).

        Args:
            doc_id:     opaque document id from Registry
            preset_name: "preview" | "print" | "export" | "thumbnail"
            view_state: {rotation, gray, paper, margin_mm, mirror}
            page:       1-based page number
            highlights: list of BBox dicts for highlight (Phase 2)
            hl_token:   opaque highlight token for cache-key (Phase 2)
            accept_header: HTTP Accept header for format negotiation
        """
        vs = view_state or {}
        preset = PRESETS.get(preset_name, PRESETS["preview"])

        # --- override support (for backward compat, e.g. split_pdf 200dpi) ---
        override_tag = ""
        if override_params:
            preset = _merge_override(preset, override_params)
            override_tag = "|override:" + _hash_override(override_params)

        # --- cache lookup ---
        vs_hash = _hash_view_state(vs)
        cache_key = make_cache_key(doc_id, preset.name, page,
                                   vs_hash + override_tag, hl_token or "")
        cached = self._cache.get(cache_key)
        if cached is not None:
            logger.debug("cache hit: %s", cache_key[:32])
            return cached.data, cached.fmt, cached.etag

        # --- render ---
        doc = self._registry.get(doc_id)
        if doc is None:
            raise ValueError(f"Document not registered: {doc_id[:12]}...")

        fmt = negotiate_format(accept_header, preset.fmt)
        data = self._render_page(doc, preset, vs, page, fmt, highlights)

        # --- cache write ---
        etag = generate_etag(
            content_hash=doc.content_hash,
            preset_name=preset.name,
            view_state_hash=vs_hash,
            hl_token=hl_token or "",
        )
        self._cache.put(cache_key, data, fmt, etag)
        return data, fmt, etag

    # ── page extraction ────────────────────────────────────────

    def page(self, doc_id: str, page_no: int = 1) -> DocumentPage:
        """Return a DocumentPage wrapping a single page for unified operations."""
        return DocumentPage(self, doc_id, page_no)

    def extract_page_pdf(self, doc_id: str, page: int = 1) -> bytes:
        """Extract a single page as standalone PDF bytes."""
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is not available")
        doc = self._registry.get(doc_id)
        if doc is None:
            raise ValueError(f"Document not registered: {doc_id[:12]}...")
        if doc.pdf is None:
            raise ValueError("Document is not a PDF")

        page_idx = max(0, page - 1)
        if page_idx >= len(doc.pdf):
            raise ValueError(f"Page {page} out of range ({len(doc.pdf)} pages)")

        page_doc = fitz.open()
        page_doc.insert_pdf(doc.pdf, from_page=page_idx, to_page=page_idx)
        data = page_doc.tobytes()
        page_doc.close()
        return data

    # ── internal rendering ──────────────────────────────────────

    def _render_page(self, doc, preset: RenderPreset, vs: dict,
                     page: int, fmt: str, highlights: list = None) -> bytes:
        """Render a single page to image bytes via PyMuPDF."""
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is not available")

        page_idx = max(0, page - 1)

        if doc.pdf is not None:
            data = self._render_pdf_page(doc, preset, vs, page_idx, fmt)
        else:
            data = self._render_image_page(doc, preset, vs, page_idx, fmt)

        # ---- highlight overlay (Phase 2 stub) ----
        # If highlights are provided, draw them via fitz annotations.
        # For now this is a no-op; full implementation in Phase 2.
        if highlights:
            logger.debug("highlight rendering not yet implemented (%d rects)",
                         len(highlights))

        return data

    def _render_pdf_page(self, doc, preset: RenderPreset, vs: dict,
                         page_idx: int, fmt: str) -> bytes:
        """Render a PDF page."""
        pdf_doc = doc.pdf
        if page_idx >= len(pdf_doc):
            raise ValueError(f"Page {page_idx + 1} out of range ({len(pdf_doc)} pages)")

        page = pdf_doc[page_idx]

        # --- zoom / rotation ---
        zoom = preset.dpi / PDF_DPI
        rotation = vs.get("rotation", 0) % 360

        # Build transform matrix with rotation and zoom
        mat = fitz.Matrix(zoom, zoom)
        if rotation:
            mat.prerotate(rotation)

        # --- render to pixmap ---
        pix = page.get_pixmap(matrix=mat, alpha=False)

        # --- grayscale ---
        if vs.get("gray", False):
            pix = _apply_grayscale(pix)

        # --- margins ---
        pix = _apply_margins(pix, preset, vs, page.rect.width, page.rect.height, zoom)

        # --- encode ---
        return _encode_pixmap(pix, fmt, preset.quality, preset.chroma)

    def _render_image_page(self, doc, preset: RenderPreset, vs: dict,
                           page_idx: int, fmt: str) -> bytes:
        """Render an image (non-PDF) to a pixmap with margins."""
        # For images, create a blank page and place the image on it
        img_bytes = doc.get("file_bytes") if hasattr(doc, "get") else None
        if img_bytes is None:
            # Try opening with fitz as image
            try:
                img_doc = fitz.open(stream=doc.get("file_bytes", b""),
                                    filetype=doc.path.split(".")[-1] if doc.path else "png")
            except Exception:
                img_doc = None

            if img_doc is None:
                raise ValueError(f"Cannot render image: {doc.path}")

            # Render first page (image documents have 1 page)
            pix = img_doc[0].get_pixmap(dpi=preset.dpi)
            img_doc.close()
        else:
            img_doc = fitz.open(stream=img_bytes, filetype=doc.path.split(".")[-1])
            pix = img_doc[0].get_pixmap(dpi=preset.dpi)
            img_doc.close()

        # --- grayscale ---
        if vs.get("gray", False):
            pix = _apply_grayscale(pix)

        # --- margins ---
        margin_px = int(preset.margin_mm * preset.dpi / MM_PER_INCH)
        pix = _apply_margins(pix, preset, vs,
                             pix.width / (preset.dpi / PDF_DPI),
                             pix.height / (preset.dpi / PDF_DPI),
                             preset.dpi / PDF_DPI)

        # --- encode ---
        return _encode_pixmap(pix, fmt, preset.quality, preset.chroma)


# ── helpers ─────────────────────────────────────────────────────

def _hash_view_state(vs: dict) -> str:
    """Produce a short deterministic hash from view state."""
    import hashlib
    items = sorted(vs.items())
    raw = "|".join(f"{k}={v}" for k, v in items)
    return hashlib.md5(raw.encode()).hexdigest()[:12]


def _apply_grayscale(pix) -> "fitz.Pixmap":
    """Convert pixmap to grayscale."""
    if pix.n >= 3:
        pix = fitz.Pixmap(fitz.csGRAY, pix)
    return pix


def _apply_margins(pix, preset: RenderPreset, vs: dict,
                   page_w: float, page_h: float, zoom: float) -> "fitz.Pixmap":
    """Add white margins around the rendered content."""
    margin_mm = vs.get("margin_mm", preset.margin_mm)
    if margin_mm <= 0:
        return pix

    margin_px = int(margin_mm * preset.dpi / MM_PER_INCH)
    paper_w = int(A4_W_MM * preset.dpi / MM_PER_INCH)
    paper_h = int(A4_H_MM * preset.dpi / MM_PER_INCH)

    # Create white canvas
    canvas = fitz.Pixmap(fitz.csRGB if pix.n >= 3 else fitz.csGRAY,
                         paper_w, paper_h)
    canvas.clear_with(255)

    # Calculate position (center content)
    src_w, src_h = pix.width, pix.height
    avail_w = paper_w - 2 * margin_px
    avail_h = paper_h - 2 * margin_px
    scale = min(avail_w / src_w, avail_h / src_h, 1.0)

    draw_w = int(src_w * scale)
    draw_h = int(src_h * scale)
    ox = max(0, (paper_w - draw_w) // 2)
    oy = max(0, (paper_h - draw_h) // 2)

    # Scale content pixmap if needed
    if scale < 1.0:
        pix = fitz.Pixmap(pix, draw_w, draw_h)

    # Paste onto canvas (simple copy for RGB)
    if pix.n == canvas.n:
        canvas.copy(pix, fitz.IRect(ox, oy, ox + draw_w, oy + draw_h))
    else:
        canvas = pix  # fallback

    return canvas


def _encode_pixmap(pix, fmt: str, quality: int, chroma: str) -> bytes:
    """Encode fitz Pixmap to image bytes."""
    if fmt == "jpeg":
        return pix.tobytes("jpeg", jpg_quality=quality)
    elif fmt == "webp":
        try:
            return pix.tobytes("webp", lossless=False, quality=quality)
        except TypeError:
            # Fallback for PyMuPDF versions without webp quality param
            return pix.tobytes("webp")
    elif fmt == "png":
        return pix.tobytes("png")
    else:
        return pix.tobytes("webp")


def _merge_override(preset: RenderPreset, override: dict) -> RenderPreset:
    """Return a copy of preset with fields overridden from dict."""
    import copy
    p = copy.copy(preset)
    for field in ("dpi", "quality", "margin_mm", "white_bg", "fmt", "chroma"):
        if field in override:
            setattr(p, field, override[field])
    return p


def _hash_override(override: dict) -> str:
    """Short deterministic hash of override params (for cache key)."""
    import hashlib
    items = sorted(override.items())
    raw = "|".join(f"{k}={v}" for k, v in items)
    return hashlib.md5(raw.encode()).hexdigest()[:8]


def _make_hl_token(rects: list) -> str:
    """Generate a short token from highlight rects for cache-key identity."""
    if not rects:
        return ""
    import hashlib
    raw = "|".join(f"{r.get('x0',0):.0f},{r.get('y0',0):.0f},{r.get('x1',0):.0f},{r.get('y1',0):.0f}" for r in rects)
    return hashlib.md5(raw.encode()).hexdigest()[:12]
