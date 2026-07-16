"""
RenderEngine — unified rendering entry (Image + Geometry Producer).

render(doc, preset, view_state, page, highlights) → (bytes, format, etag)
"""

import io
import logging
from typing import List, Optional, Tuple

from .preset import RenderPreset, PRESETS
from .cache import RenderCache, generate_etag, make_cache_key
from .render_spec_sig import render_spec_signature
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
               render_spec: dict = None,
               highlights: list = None, hl_token: str = None,
               accept_header: str = "",
               override_params: dict = None,
               pdf_doc: Optional["fitz.Document"] = None) -> Tuple[bytes, str, str]:
        """
        Render a single page. Returns (image_bytes, format, etag).

        Args:
            doc_id:     opaque document id from Registry
            preset_name: "preview" | "print" | "export" | "thumbnail"
            view_state: {rotation, gray, paper, margin_mm, mirror} — Legacy Intent
            page:       1-based page number
            render_spec: Resolved Layout from RenderSpec (Commit B). None → Legacy.
                         B-0 shadow mode: passed through to `_render_page` but the
                         renderer still executes Legacy (zero pixel change); B-1 wires
                         it into the real RenderSpec renderer.
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
        # B-1: spec 真正驱动渲染时，必须把 render_spec 纳入 cache_key 与 etag。
        # 否则不同 spec（如 paperLandscape 不同）会命中同一缓存位，输出字节
        # 不同却共用 key → 返回修复前的陈旧图。spec 为 None（Legacy）时不加，
        # 保持旧客户端字节级一致。
        spec_tag = f"|spec:{render_spec_signature(render_spec)}" if render_spec else ""
        cache_key = make_cache_key(doc_id, preset.name, page,
                                   vs_hash + override_tag + spec_tag, hl_token or "")
        cached = self._cache.get(cache_key)
        # ── [DIAG] Layer 1.5: 缓存层 — HIT 时不进 _render_spec_page ──
        ox = render_spec.get("placement", {}).get("offsetX", "-") if render_spec else "-"
        oy = render_spec.get("placement", {}).get("offsetY", "-") if render_spec else "-"
        print(f"[CACHE] {'HIT' if cached else 'MISS'} ox={ox} oy={oy} sig={spec_tag[:20] if spec_tag else 'legacy'}", flush=True)
        if cached is not None:
            logger.debug("cache hit: %s", cache_key[:32])
            return cached.data, cached.fmt, cached.etag

        # --- render ---
        doc = self._registry.get(doc_id)
        if doc is None:
            raise DocumentNotRegistered(doc_id)

        fmt = negotiate_format(accept_header, preset.fmt)
        data, actual_fmt = self._render_page(doc, preset, vs, page, fmt,
                                             highlights, pdf_doc=pdf_doc,
                                             render_spec=render_spec)

        # --- cache write ---
        etag = generate_etag(
            content_hash=doc.content_hash,
            preset_name=preset.name,
            view_state_hash=vs_hash + override_tag + spec_tag,
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
                     pdf_doc: Optional["fitz.Document"] = None,
                     render_spec: dict = None) -> bytes:
        """Dispatch a single page render to the active renderer.

        Commit B dispatch (B-1 起生效):
          • render_spec is None     → Legacy renderer (`_render_legacy_page`) — Frozen Baseline
          • render_spec is not None → RenderSpec renderer (`_render_spec_page`)，
            消费 placement/paper 直接执行，零重算（见 v16-stage1-design.md ⑤⑦）。
        B-0 阶段两分支都走 Legacy（shadow mode）；B-1 起 spec 分支为真实 RenderSpec 渲染。
        """
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is not available")

        page_idx = max(0, page - 1)

        # ── Commit B dispatch ──
        # 两棵树完全独立、互不调用（⑥⑦）：Legacy 仅服务无 spec 的请求（Frozen Baseline），
        # RenderSpec 树独立消费 placement/paper/contentRotation（RenderCommand 纯执行）。
        # Slice 1.2B 起本路径消费 contentRotation 经 prerotate 旋转内容；Legacy 不消费 spec。
        if render_spec is None:
            return self._render_legacy_page(doc, preset, vs, page_idx, fmt,
                                            highlights, pdf_doc)
        # RenderSpec 分支（B-1 起真实渲染；B-0 曾 shadow 走 Legacy）。
        return self._render_spec_page(doc, preset, render_spec, page_idx, fmt,
                                      highlights, pdf_doc)

    def _render_legacy_page(self, doc, preset: RenderPreset, vs: dict,
                            page_idx: int, fmt: str, highlights: list = None,
                            pdf_doc: Optional["fitz.Document"] = None) -> bytes:
        """Legacy render path (Frozen Baseline — Commit B 期间禁止修改算法)。

        仅被 `_render_page` 在 render_spec is None 或 B-0 shadow mode 下调用。
        任何 Legacy 算法修复须独立 commit（见 v16-stage1-design.md ⑥）。
        """
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

    def _render_spec_page(self, doc, preset: RenderPreset, spec: dict,
                          page_idx: int, fmt: str, highlights: list = None,
                          pdf_doc: Optional["fitz.Document"] = None) -> bytes:
        """RenderSpec render path — **RenderCommand Executor**（Slice 1.2B 落地）。

        消费 RenderCommand（spec 中的 placement + contentRotation），**逐字使用，绝不重算**
        （见 v16-stage1-design.md ⑤⑦ 与 Page Placement Pipeline 模型）：
          • paper.width/height  → 画布像素尺寸（已含方向，不读 A4 常量）
          • placement.scale     → 直接作为 get_pixmap(matrix) 缩放（PDF）/ 缩放因子（image）
          • placement.offsetX/Y → 直接作为粘贴左上角（不再居中）
          • contentRotation     → 🆕 Slice 1.2B **真实内容旋转 Fact**（0/90/180/270）；
            唯一来源 = RenderLayoutFactory 单一决策点。本函数仅把它翻译成 fitz.prerotate 角度，
            绝不由此推导 fit / center / landscape。
          • paperLandscape      → 纸方向（True=横纸/False=竖纸），**只决定画布尺寸交换**，
            与内容旋转(contentRotation)解耦（见 v17-paper-orientation-contract.md）。
          • dpi                 → 信息字段（paper/placement 已是权威像素，渲染不二次使用）。
          • rotation            → [LEGACY] 已退役字段（恒 0），被 contentRotation 取代；本路径不读它。

        与 Legacy 树零共享（⑦）：禁止调用 `_render_legacy_page` / `_render_pdf_page` /
        `_apply_margins` / `_apply_rotation`。本函数是 RenderEngine 作为 Executor 的体现——
        只执行 Factory 已解析好的事实（Resolved Layout），绝不重新推导布局。
        """
        # ── [Slice 1.2B 收口] RenderCommand 契约入口校验（用户建议④）──
        # 字段缺失 → ValueError（api.py 映射 400），杜绝 offset=None 类静默 Runtime Bug。
        validate_render_command(spec)

        scale = float(spec["placement"]["scale"])
        ox = int(round(float(spec["placement"]["offsetX"])))
        oy = int(round(float(spec["placement"]["offsetY"])))
        # ── [DIAG] Layer 2: 真正进入渲染（只有 cache MISS 才会走到这里）──
        print(f"[RENDER] ox={ox} oy={oy} scale={scale}", flush=True)
        print(f"[SPEC] margin={spec.get('margin',{})} placement={{scale:{scale}, ox:{ox}, oy:{oy}}} "
              f"paperLandscape={spec.get('paperLandscape')} contentRotation={spec.get('contentRotation')}", flush=True)
        # ── [Slice 1.2B] RenderCommand 纯执行契约 ──
        # Renderer 只消费 spec 中的 placement(scale/offset) 与 contentRotation，**绝不重算**
        # fit / center / landscape，也绝不把内容旋转「推导」自 paperLandscape 或 legacy rotation。
        # 内容旋转的唯一事实来源 = contentRotation（由 RenderLayoutFactory 单一决策点产出）；
        # 本函数仅把它翻译成 fitz 旋转角度，不引入任何布局决策。Single Decision Point 在这里被守住：
        # 若有人想「智能」重算，必须先回 RenderLayoutFactory，而不是在 Renderer 里私算。
        # ⚠️ 若 contentRotation 非法（非枚举值）→ 视为 malformed 协议 → 抛错（api.py 映射 400）。
        # 枚举 Rotation（Page Placement Pipeline 设计前提）：contentRotation 仅允许这 4 个离散值，
        # 任何非 90 倍数的角度（如 13°、89.99999°）都禁止进入 Matrix.prerotate，避免静默混入。
        ALLOWED_CONTENT_ROTATIONS = (0, 90, 180, 270)
        cr = int(round(float(spec.get("contentRotation", 0)))) % 360
        if cr not in ALLOWED_CONTENT_ROTATIONS:
            raise ValueError(
                f"[1.2B] contentRotation must be one of {ALLOWED_CONTENT_ROTATIONS}, got {cr} "
                f"(Renderer 不重算布局；内容旋转必须来自 RenderCommand)")
        # fitz.prerotate 角度映射（⚠️ 经 Slice 1.2B 实测校准，fitz 1.28）：
        #   fitz 的 prerotate(+θ) = 视觉顺时针 θ（屏幕 y 向下坐标），与前端 CSS rotate(θ) 一致：
        #     contentRotation=90  → 视觉顺时针90°（CSS rotate(90deg)）→ prerotate(+90)
        #     contentRotation=270 → 视觉顺时针270°（CSS rotate(270deg)）→ prerotate(-90)
        #     contentRotation=180 → prerotate(180)
        #     contentRotation=0   → 不旋转
        #   （注：v17-paper-orientation-contract.md 旧 helper 注释写 prerotate(-90)=CW90，
        #    在本 fitz 版本实测相反——已用红块方位测试校准，见 test_render_spec_page_rotation.py。）
        # ⚠️ 避坑：prerotate(-270) 在 fitz 实测给出镜像结果，故 270 映射 -90（=+270 等价但安全），
        #    绝不写 prerotate(-contentRotation)。
        _pre = {0: 0, 90: 90, 180: 180, 270: -90}[cr]
        # 读 camelCase paperLandscape（与 rebuild_spec_from_args / 前端 buildRenderSpec 结构一致）。
        # ⚠️ 历史 bug：此前读 snake_case "paper_landscape"，而 rebuild 重建的 spec 用
        #    camelCase，导致该字段永远取默认 False → 横纸变竖纸（见 repro_landscape_bug.py）。
        paper_landscape = bool(spec.get("paperLandscape", False))
        paper_w = int(round(float(spec["paper"]["width"])))
        paper_h = int(round(float(spec["paper"]["height"])))
        if paper_w <= 0 or paper_h <= 0:
            raise ValueError(
                f"RenderSpec paper dimensions must be positive, got {paper_w}x{paper_h}")
        gray = bool(spec.get("gray", False))
        # 画布尺寸：paper_landscape 时交换（纸随内容方向）
        canvas_w, canvas_h = (paper_h, paper_w) if paper_landscape else (paper_w, paper_h)

        if doc.pdf is not None:
            pdf = pdf_doc if pdf_doc is not None else doc.pdf
            if page_idx >= len(pdf):
                raise ValueError(f"Page {page_idx + 1} out of range ({len(pdf)} pages)")
            page = pdf[page_idx]
            # 🆕 Slice 1.2B：内容按 contentRotation 经 prerotate 旋转（RenderCommand 消费），
            # 缩放仅 placement.scale，不重算 fit。placement 已在 rotatedBounds 上算好（见 Factory）。
            mat = fitz.Matrix(scale, scale)
            if _pre:
                mat.prerotate(_pre)
            pix = page.get_pixmap(matrix=mat, alpha=False)
        else:
            # image path：以「dpi 栅格 + placement.scale + contentRotation」组合矩阵一次性栅格化
            # （与 PDF 路径统一——旋转由后端唯一接管，不调用任何 Legacy helper（⑦）；零重算）。
            img_doc = _open_image_doc(doc)
            try:
                dpi = float(spec.get("dpi", preset.dpi))
                zoom = dpi / 72.0
                mat = fitz.Matrix(zoom, zoom)
                if scale != 1.0:
                    mat = fitz.Matrix(mat.a * scale, mat.d * scale)
                if _pre:
                    mat.prerotate(_pre)
                pix = img_doc[0].get_pixmap(matrix=mat, alpha=False)
            finally:
                img_doc.close()

        # 🆕 Slice 1.2B：内容按 contentRotation 经 prerotate 旋转（矩阵旋转，非 pixmap 后处理）；
        # 旧 fitz 1.27「旋转 pixmap 空白」兼容 hack 仍无需——fitz 自动处理旋转后包围盒。

        if gray:
            pix = _apply_grayscale(pix)

        # 白画布 + 偏移粘贴（无 fit / 无 center；offset 已是最终位置）。
        # 防御：旋转/取整可能让内容 pixmap 比 spec.paper 大 1px（fitz 取整边界），
        # 若粘贴越界，fitz 会静默输出空白。故画布以 spec.paper 为基准，
        # 必要时扩展到内容尺寸，保证粘贴不越界（Executor 不因取整差产白图）。
        #
        # ⚠️  PyMuPDF Pixmap.copy(canvas, pix, irect) 把 irect 同时作为源矩形和目标矩形。
        #     直接传 IRect(ox, oy, ox+w, oy+h) 会从源 pix 的 (ox,oy) 开始复制，
        #     切掉左上角 (ox,oy) 像素（见 scripts/test_fitz_copy.py 实证）。
        #     修复：手动逐行 memoryview 拷贝，把 pix 完整像素写入 canvas 的 (ox,oy) 位置。
        canvas_w = max(canvas_w, ox + pix.width)
        canvas_h = max(canvas_h, oy + pix.height)
        canvas = fitz.Pixmap(fitz.csRGB if pix.n >= 3 else fitz.csGRAY,
                             fitz.IRect(0, 0, canvas_w, canvas_h))
        canvas.clear_with(255)
        if pix.n == canvas.n:
            pix_mv = pix.samples_mv
            canvas_mv = canvas.samples_mv
            pix_stride = pix.stride
            canvas_stride = canvas.stride
            row_bytes = pix.width * pix.n
            for y in range(pix.height):
                src_start = y * pix_stride
                # 目标行从 ox/oy 偏移开始
                dst_start = (oy + y) * canvas_stride + ox * pix.n
                canvas_mv[dst_start:dst_start + row_bytes] = pix_mv[src_start:src_start + row_bytes]
        else:
            canvas = pix

        # ---- highlight overlay (Phase 2 stub) ----
        if highlights:
            logger.debug("highlight rendering not yet implemented (%d rects)",
                         len(highlights))

        return _encode_pixmap(canvas, fmt, preset.quality, preset.chroma)

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


def _open_image_doc(doc) -> "fitz.Document":
    """Open an image document for rendering (Commit B-1 spec path; additive).

    新增 helper，供 `_render_spec_page` 的 image 分支使用；**不修改** Legacy 的
    `_render_image_page`（⑥ Frozen Baseline）。打开逻辑与其等价，但集中为一处。
    """
    filetype = doc.path.split(".")[-1] if getattr(doc, "path", None) else "png"
    img_bytes = doc.get("file_bytes") if hasattr(doc, "get") else None
    if img_bytes is None:
        img_bytes = b""
    try:
        return fitz.open(stream=img_bytes, filetype=filetype)
    except Exception as e:
        raise ValueError(f"Cannot open image document: {getattr(doc, 'path', '?')}") from e


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


def _rotation_to_fitz_arg(rotation: int) -> int:
    """🆕 V17 deprecated：paperLandscape 模型已取代 prerotate，本函数不再被调用（Phase 3 删除）。
    视觉顺时针角度(0/90/180/270) → fitz `prerotate` 参数（B-2.1 唯一旋转源）。

    经 fitz 横票实验验证（红顶/蓝左标记，见 B-2.1 提交说明）：
      • prerotate(-90) 产生「视觉顺时针 90°」（= 前端 CSS rotate(90deg)），故 90→-90；
      • prerotate(+90) 产生「视觉逆时针 90°」，故 270(=CW270=CW-90)→+90；
      • 180 对称，±180 等价。
    ⚠️ 禁止直接传 prerotate(-rotation)：fitz 对 prerotate(-270) 实测给出镜像结果
    （与数学等价 +90 不符），故必须把 rotation%360 归一到 {0,90,180,270} 再查表。
    """
    r = rotation % 360
    if r == 0:
        return 0
    if r == 90:
        return -90
    if r == 180:
        return 180
    if r == 270:
        return 90
    raise ValueError(f"unsupported rotation {rotation!r} (must be multiple of 90)")


def validate_render_command(spec: dict) -> None:
    """Slice 1.2B 收口 — RenderCommand 契约校验（用户收尾建议④）。

    RenderCommand 是 Renderer 的唯一输入契约（见 frontend RenderLayoutFactory.js
    的 RenderCommand typedef）。本函数把「字段缺失」在入口拦截为 ValueError
    （api.py 映射 400），而非让 placement/offset 成为 None 后静默穿透到
    get_pixmap / paste 产生空白图这类 Runtime Bug。

    校验字段（= RenderCommand 契约，由 RenderLayoutFactory 单一决策点产出；Renderer 不重算）：
      • placement: {scale, offsetX, offsetY}  必填，Renderer 直接消费
      • contentRotation: 0/90/180/270          内容旋转 Fact（新模型；legacy `rotation` 已退役，不校验）
      • paperLandscape: bool                   纸方向（仅决定画布交换）
      • paper: {width, height}                 画布像素尺寸（>0）
    """
    if not isinstance(spec, dict):
        raise ValueError("[1.2B] RenderCommand spec 必须是 dict")
    # ── RenderCommand 契约版本（用户收尾建议）──
    # 缺失 / 非 1 → 拒绝（400），杜绝"前端升 v2 / 后端仍 v1"的静默兼容。
    # 与 ?spec=v1（RenderSpec DTO 信封版本，verify_render_spec 校验）是两回事：
    #   • ?spec=v1  = 线路信封格式版本（前端→后端 DTO 序列化格式）
    #   • version   = RenderCommand 契约版本（Factory 产出对象的语义版本）
    # 两者都拦"静默兼容"，但作用在不同层。
    CURRENT_RENDER_COMMAND_VERSION = 1
    ver = spec.get("version")
    if ver != CURRENT_RENDER_COMMAND_VERSION:
        raise ValueError(
            f"[1.2B] RenderCommand.version 必须为 {CURRENT_RENDER_COMMAND_VERSION}，"
            f"收到 {ver!r}（未知版本 → 拒绝，杜绝前后端静默兼容；"
            f"若需升级请同步 RenderLayoutFactory + engine + rebuild_spec_from_args）")
    missing = []
    placement = spec.get("placement")
    if not isinstance(placement, dict):
        missing.append("placement")
    else:
        for fld in ("scale", "offsetX", "offsetY"):
            if fld not in placement:
                missing.append(f"placement.{fld}")
    if "contentRotation" not in spec:
        missing.append("contentRotation")
    if "paperLandscape" not in spec:
        missing.append("paperLandscape")
    paper = spec.get("paper")
    if not isinstance(paper, dict) or "width" not in paper or "height" not in paper:
        missing.append("paper{width,height}")
    if missing:
        raise ValueError(
            f"[1.2B] RenderCommand 缺失必填字段: {missing} "
            f"(这些必须由 RenderLayoutFactory 单一决策点产出；Renderer 不重算布局)")
