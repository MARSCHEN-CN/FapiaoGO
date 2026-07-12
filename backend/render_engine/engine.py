"""
RenderEngine — unified rendering entry (Image + Geometry Producer).

render(doc, preset, view_state, page, highlights) → (bytes, format, etag)
"""

import io
import logging
from typing import List, Optional, Tuple

from .preset import RenderPreset, PRESETS
from .cache import RenderCache, generate_etag, make_cache_key
from .types import BBox, TextSpan

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


class DocumentNotRegistered(Exception):
    """Raised when a doc_id is not present in the in-memory registry.

    Carries the doc_id so API layers can return a structured, machine-readable
    error (e.g. ``{"error": "DOC_NOT_REGISTERED", "doc_id": ...}``) instead of a
    generic 404. Frontends use this code to auto-re-register the document
    (re-open via /api/documents/open) and retry, rather than masking the failure.
    """
    def __init__(self, doc_id: str):
        self.doc_id = doc_id
        super().__init__(f"Document not registered: {doc_id[:12]}...")


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
        spans     = page.text()         # List[TextSpan]
        boxes     = page.bbox()         # List[BBox]
        rect      = page.rect()         # BBox (page bounding rect)
        w, h      = page.size()         # tuple (width, height)
        rot       = page.rotation()     # int (0/90/180/270)
        has_txt   = page.has_text()     # bool
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

    # ── fitz page helper ──────────────────────────────────────

    @property
    def _fitz_page(self):
        """Get the underlying fitz Page (None if image/non-PDF)."""
        if self._doc.pdf is None:
            return None
        page_idx = max(0, self._page_no - 1)
        if page_idx >= len(self._doc.pdf):
            return None
        return self._doc.pdf[page_idx]

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

    # ── content ────────────────────────────────────────────────

    def text(self) -> List[TextSpan]:
        """
        Extract text content with bounding boxes from this page.

        Results are lazily cached in ``Document.text_cache`` on first call —
        subsequent calls (and calls to other pages of the same document)
        return instantly without re-parsing the PDF.

        Uses PyMuPDF's built-in text layer (``page.get_text("words")``)
        for PDF documents with embedded text.  Returns word-level spans.

        Returns:
            List[TextSpan]: text spans (empty for images / scanned PDFs).

        ``TextSpan`` is the foundational type that all downstream consumers
        (ContentIndex / Search / Highlight / OCR / Selection / Copy Text)
        build upon.  See :class:`types.TextSpan`.
        """
        cache = self._doc.text_cache
        if cache is not None and self._page_no in cache:
            return cache[self._page_no]
        spans = self._extract_text_spans()
        if cache is None:
            self._doc.text_cache = {self._page_no: spans}
        else:
            self._doc.text_cache[self._page_no] = spans
        return spans

    def _extract_text_spans(self) -> List[TextSpan]:
        """Call PyMuPDF to extract word-level text spans (uncached)."""
        if self._doc.pdf is None:
            return []
        page_idx = max(0, self._page_no - 1)
        if page_idx >= len(self._doc.pdf):
            return []
        fitz_page = self._doc.pdf[page_idx]
        words = fitz_page.get_text("words")
        return [
            TextSpan(
                text=w[4],
                bbox=BBox(x0=w[0], y0=w[1], x1=w[2], y1=w[3], page=self._page_no),
            )
            for w in words
        ]

    def bbox(self) -> List[BBox]:
        """Get bounding boxes of all text on this page (convenience wrapper)."""
        return [span.bbox for span in self.text()]

    # ── metadata ───────────────────────────────────────────────

    def rect(self) -> BBox:
        """
        Get the page's bounding rectangle in PDF user space (points).

        Returns:
            BBox: (x0, y0, x1, y1) — full page area, not media box.
            For images / non-PDF, returns a default A4 rect.
        """
        fp = self._fitz_page
        if fp is None:
            return BBox(x0=0, y0=0, x1=595, y1=842, page=self._page_no)  # A4
        r = fp.rect
        return BBox(x0=r.x0, y0=r.y0, x1=r.x1, y1=r.y1, page=self._page_no)

    def size(self) -> tuple:
        """
        Get the page dimensions in PDF user space points (1/72 inch).

        Returns:
            (width, height) tuple.  For images / non-PDF, returns A4.
        """
        r = self.rect()
        return (r.x1 - r.x0, r.y1 - r.y0)

    def rotation(self) -> int:
        """
        Get the page rotation in degrees.

        Returns:
            0 / 90 / 180 / 270.  0 for images / non-PDF.
        """
        fp = self._fitz_page
        if fp is None:
            return 0
        return fp.rotation or 0

    def has_text(self) -> bool:
        """
        Check whether this page has extractable text content.

        Returns:
            True if text() returns at least one non-empty span.
            False for blank pages, scanned PDFs, and image documents.
        """
        spans = self.text()
        return len(spans) > 0 and any(s.text.strip() for s in spans)

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
               override_params: dict = None,
               pdf_doc: Optional["fitz.Document"] = None) -> Tuple[bytes, str, str]:
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
            raise DocumentNotRegistered(doc_id)

        fmt = negotiate_format(accept_header, preset.fmt)
        data, actual_fmt = self._render_page(doc, preset, vs, page, fmt,
                                             highlights, pdf_doc=pdf_doc)

        # --- cache write ---
        etag = generate_etag(
            content_hash=doc.content_hash,
            preset_name=preset.name,
            view_state_hash=vs_hash,
            hl_token=hl_token or "",
        )
        self._cache.put(cache_key, data, actual_fmt, etag)
        return data, actual_fmt, etag

    # ── page extraction ────────────────────────────────────────

    def page(self, doc_id: str, page_no: int = 1) -> DocumentPage:
        """Return a DocumentPage wrapping a single page for unified operations."""
        return DocumentPage(self, doc_id, page_no)

    def extract_page_pdf(self, doc_id: str, page: int = 1,
                          pdf_doc: Optional["fitz.Document"] = None) -> bytes:
        """Extract a single page as standalone PDF bytes.

        Args:
            doc_id:   opaque document id from Registry
            page:     1-based page number
            pdf_doc:  optional pre-opened fitz.Document. When provided, it is
                      used instead of the registry's shared document. This lets
                      callers process different pages of the same doc from
                      isolated fitz handles — required for thread-safe
                      concurrency, since a single fitz.Document must not be
                      shared across threads.
        """
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is not available")
        doc = self._registry.get(doc_id)
        if doc is None:
            raise DocumentNotRegistered(doc_id)
        # Prefer the caller-supplied isolated handle; fall back to shared doc.
        src = pdf_doc if pdf_doc is not None else doc.pdf
        if src is None:
            raise ValueError("Document is not a PDF")

        page_idx = max(0, page - 1)
        if page_idx >= len(src):
            raise ValueError(f"Page {page} out of range ({len(src)} pages)")

        page_doc = fitz.open()
        page_doc.insert_pdf(src, from_page=page_idx, to_page=page_idx)
        data = page_doc.tobytes()
        page_doc.close()
        return data

    # ── internal rendering ──────────────────────────────────────

    def _render_page(self, doc, preset: RenderPreset, vs: dict,
                     page: int, fmt: str, highlights: list = None,
                     pdf_doc: Optional["fitz.Document"] = None) -> bytes:
        """Render a single page to image bytes via PyMuPDF."""
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is not available")

        page_idx = max(0, page - 1)

        if doc.pdf is not None:
            data = self._render_pdf_page(doc, preset, vs, page_idx, fmt,
                                         pdf_doc=pdf_doc)
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
                         page_idx: int, fmt: str,
                         pdf_doc: Optional["fitz.Document"] = None) -> bytes:
        """Render a PDF page.

        Uses ``pdf_doc`` (an isolated fitz.Document supplied by the caller) when
        provided, otherwise falls back to the registry's shared ``doc.pdf``.
        """
        pdf = pdf_doc if pdf_doc is not None else doc.pdf
        if page_idx >= len(pdf):
            raise ValueError(f"Page {page_idx + 1} out of range ({len(pdf)} pages)")

        page = pdf[page_idx]

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
        # 页面方向依据 page.rect（MediaBox），但需考虑 /Rotate：若 rotation 为 90/270，
        # 则 visual 方向与 rect 方向相反（get_pixmap 自动应用了 /Rotate）。
        pw, ph = page.rect.width, page.rect.height
        if getattr(page, "rotation", 0) % 180 != 0:
            pw, ph = ph, pw
        orient = "landscape" if pw > ph else "portrait"
        pix = _apply_margins(pix, preset, vs, orient)

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
        orient = "landscape" if pix.width > pix.height else "portrait"
        pix = _apply_margins(pix, preset, vs, orient)

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
                   orientation: str) -> "fitz.Pixmap":
    """Add white margins around the rendered content.

    Args:
        pix:          rendered content pixmap (any page orientation)
        preset:       render preset (dpi, margin_mm, …)
        vs:           view state dict (may override margin_mm)
        orientation:  'portrait' or 'landscape' — determines whether the
                      margin canvas is A4 portrait (210×297mm) or A4 landscape
                      (297×210mm). Must be set by caller based on source page
                      orientation (PDF: page.rect, image: pix dimensions),
                      NOT detected by this function from pix, so that the
                      paper orientation decision stays at the caller level
                      and can later integrate with a unified PaperSpec.
    """
    margin_mm = vs.get("margin_mm", preset.margin_mm)
    if margin_mm <= 0:
        return pix

    margin_px = int(margin_mm * preset.dpi / MM_PER_INCH)
    paper_w = int(A4_W_MM * preset.dpi / MM_PER_INCH)
    paper_h = int(A4_H_MM * preset.dpi / MM_PER_INCH)
    if orientation == "landscape":
        paper_w, paper_h = paper_h, paper_w

    # Create white canvas (PyMuPDF >= 1.24 requires IRect, not (cs, w, h))
    canvas = fitz.Pixmap(fitz.csRGB if pix.n >= 3 else fitz.csGRAY,
                         fitz.IRect(0, 0, paper_w, paper_h))
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


def _encode_pixmap(pix, fmt: str, quality: int, chroma: str):
    """Encode fitz Pixmap to image bytes.

    Returns a tuple (bytes, actual_fmt) so the caller can set the correct
    Content-Type even when the requested format is unavailable.
    Some PyMuPDF builds (e.g. 1.27.x wheels on certain platforms) are
    compiled WITHOUT webp support, so we transparently fall back to jpeg.
    """
    if fmt in ("jpeg", "jpg"):
        return pix.tobytes("jpeg", jpg_quality=quality), "jpeg"
    if fmt == "png":
        return pix.tobytes("png"), "png"
    if fmt == "webp":
        try:
            return pix.tobytes("webp", lossless=False, quality=quality), "webp"
        except Exception:
            # PyMuPDF built without webp — fall back to jpeg transparently.
            logger.warning("webp encoding unavailable in this PyMuPDF build; "
                           "falling back to jpeg")
            return pix.tobytes("jpeg", jpg_quality=quality), "jpeg"
    # unknown format → png
    return pix.tobytes("png"), "png"


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
