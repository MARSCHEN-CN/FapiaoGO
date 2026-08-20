"""
render_engine API — Flask Blueprint with resource endpoints.

Routes:
    POST /api/documents/open       — upload file, register, get doc_id + metadata
    GET  /preview/{doc_id}         — render page 1 with preview preset
    GET  /thumbnail/{doc_id}       — render page 1 with thumbnail preset
    GET  /render/{doc_id}          — render with explicit preset + page + vs + hl
    GET  /metadata/{doc_id}        — document metadata (page_count, hash, ...)
    GET  /search                   — unified search (metadata + content stub)

All image endpoints support:
    - format negotiation via Accept header
    - ETag / If-None-Match → 304
    - Cache-Control: immutable
"""

import io
import logging
import os
import time

from flask import Blueprint, request, jsonify, Response

from . import registry, render_cache, render_queue, engine
from .engine import DocumentNotRegistered
from .preset import PRESETS
from .cache import make_cache_headers, make_cache_key, generate_etag
from .content_index import ContentIndex
from .prefetch import prefetch_neighbors
from .render_spec_sig import verify_render_spec, RenderSpecParseError

logger = logging.getLogger(__name__)

render_bp = Blueprint("render", __name__, url_prefix="")

_content_index = ContentIndex(registry)


# ── POST /api/documents/open ───────────────────────────────────

@render_bp.route("/api/documents/open", methods=["POST"])
def open_document():
    """Upload a file, register it, return doc_id + metadata."""
    if "file" not in request.files:
        return jsonify({"success": False, "error": "no file uploaded"}), 400

    file = request.files["file"]
    file_bytes = file.read()
    if not file_bytes:
        return jsonify({"success": False, "error": "empty file"}), 400

    try:
        doc = registry.open(file_bytes, filename=file.filename or "")
    except Exception as e:
        logger.exception("Failed to open document")
        return jsonify({"success": False, "error": str(e)}), 500

    return jsonify({
        "success": True,
        "doc_id": doc.doc_id,
        "page_count": doc.page_count,
        "content_hash": doc.content_hash,
        "size": doc.size,
    })


# ── GET /preview/{doc_id} ──────────────────────────────────────

@render_bp.route("/preview/<doc_id>", methods=["GET"])
def preview(doc_id: str):
    """Render a specific page with the 'preview' preset.

    Honors the `?page=` query param so multi-page PDFs can preview pages
    other than page 1. The page is part of the cache key (cache.py) and the
    URL (buildPreviewUrl).

    NOTE: /preview does NOT use `immutable` because the current URL does not
    include all byte-changing parameters (e.g., isLandscape derived from
    page.rect + rotation). Browser caching therefore uses must-revalidate
    so that If-None-Match negotiation can correct stale orientation responses.
    """
    page = _int_param("page", 1)

    # ── [DIAG] Layer 1: HTTP 入口 — 调试日志（受 RE_DEBUG 控制）──
    if _render_spec_log_enabled():
        logger.debug(
            "[HTTP] sig=%s ox=%s oy=%s margin_l=%s",
            request.args.get('spec_sig', '-')[:8],
            request.args.get('ox', '-'),
            request.args.get('oy', '-'),
            request.args.get('margin_l', '-'),
        )

    # ── Commit A：先解析 spec（malformed → 400，早于任何渲染工作）──
    # 完整纪律见 v16-stage1-design.md §Step4 Commit A / §3c。
    # • 请求未携带 ?spec=（缺失/空串）→ None：Legacy 客户端，不回显、不 400。
    # • 协议结构非法（版本不支持 / 核心字段缺失 / 数值非数字 / clip 不完整）
    #   → RenderSpecParseError → 400 INVALID_RENDER_SPEC（fail-fast，与 hash mismatch 严格区分）。
    # • 合法 spec（含签名不符 verified=False）→ 继续走 Legacy 渲染（400 推迟到 Commit B）。
    try:
        spec_info = verify_render_spec(request.args, doc_id, page)
    except RenderSpecParseError as e:
        return jsonify({"success": False, "error": "INVALID_RENDER_SPEC", "detail": str(e)}), 400

    # ── Commit B-0：把已解析的 RenderSpec 送入渲染链 ──
    # spec_info 为 None 表示 Legacy 客户端（请求未携带 ?spec=）；
    # 否则取 verify_render_spec 重建的 placement/paper/rotation/clip。
    # B-0 shadow mode：engine 收到 render_spec 但仍执行 Legacy（零像素变化），
    # X-Render-Executor 保持 legacy（见下方回显块）。
    render_spec = spec_info["spec"] if spec_info else None
    resp = _render_and_respond(doc_id, "preview", page, render_spec=render_spec)
    # ✅ _render_and_respond 在 doc 未找到 / 渲染失败时返回错误元组 (jsonify(...), status)，
    #    此时 resp 不是 Response 对象，不能访问 .headers。直接透传错误，避免
    #    AttributeError: 'tuple' object has no attribute 'headers' 把 404/500 变成 500 HTML，
    #    进而被浏览器 ORB 拦截（前端 <img> 跨域 no-cors 加载 HTML 会 ERR_BLOCKED_BY_ORB）。
    if isinstance(resp, tuple):
        return resp
    resp.headers["Cache-Control"] = "public, max-age=0, must-revalidate"
    # ── [DIAG] 响应元数据：ETag + Content-Length（调试日志，受 RE_DEBUG 控制）──
    if _render_spec_log_enabled():
        logger.debug(
            "[RESPONSE] etag=%s len=%s",
            resp.headers.get('ETag', '-')[:16],
            resp.headers.get('Content-Length', '-'),
        )

    # ── Commit A/B：回显 RenderSpec（诊断）──
    # Commit A：spec 仅诊断、零渲染影响；Legacy 客户端（无 ?spec=）输出不变。
    # Commit B-1：携带合法 spec 的请求已交由 _render_spec_page 执行（RenderEngine = Executor）；
    #   渲染输出由 placement/paper 决定，Legacy 树作为 Frozen Baseline 仅服务无 spec 的请求。
    if spec_info is not None:
        resp.headers["X-RenderSpec-Version"] = spec_info["version"]
        # 回显后端「重算值」而非前端传来值，便于 DevTools 直接比对「后端实际看到什么」
        resp.headers["X-RenderSpec-Hash"] = spec_info["recomputed"] or spec_info["sig"]
        resp.headers["X-RenderSpec-Verified"] = "true" if spec_info["verified"] else "false"
        # Commit B-1 起 spec 已真正驱动渲染：X-Render-Executor 反映实际执行路径。
        executor = "renderspec" if spec_info is not None else "legacy"
        resp.headers["X-Render-Executor"] = executor
        # B-2.1：rotation 已收归后端唯一旋转源；前端 CSS 旋转在 B-2.2 删除。
        # 该头供 UI A/B 对照：backend=后端接管旋转 / 缺省=Legacy（前端 CSS 旋转）。
        if spec_info is not None and spec_info.get("spec", {}).get("rotation"):
            resp.headers["X-Render-Rotation"] = "backend"
        if _render_spec_log_enabled():
            logger.info(
                "RenderSpec echo spec=%s sig=%s verified=%s executor=%s",
                spec_info["version"], spec_info["recomputed"], str(spec_info["verified"]).lower(),
                executor,
            )
    return resp


def _render_spec_log_enabled() -> bool:
    """Commit A DEV 日志开关：环境变量 RE_DEBUG=1 或 Flask debug 模式开启时记录。"""
    if os.environ.get("RE_DEBUG") == "1":
        return True
    try:
        from flask import current_app
        return bool(current_app.debug)
    except Exception:
        return False


# ── GET /thumbnail/{doc_id} ────────────────────────────────────

@render_bp.route("/thumbnail/<doc_id>", methods=["GET"])
def thumbnail(doc_id: str):
    """Render a specific page with the 'thumbnail' preset.

    Honors the ``?page=`` query param (1-based, default 1) so multi-page
    documents can build a per-page thumbnail strip. The page flows into
    ``engine.render`` and therefore into the render cache key, so distinct
    pages never collide in cache.

    Rotation-Aware (Commit 3 fix): accepts ``?content_rotation=90`` to render
    thumbnails at the user's chosen orientation. Passed as view_state.rotation.
    """
    page = _int_param("page", 1)
    cr = _int_param("content_rotation", 0)
    vs = {}
    if cr:
        vs["rotation"] = cr
    return _render_and_respond(doc_id, "thumbnail", page, vs)


# ── GET /render/{doc_id} ───────────────────────────────────────

@render_bp.route("/render/<doc_id>", methods=["GET"])
def render_page(doc_id: str):
    """Render a specific page with explicit preset + view state."""
    preset_name = request.args.get("preset", "preview")
    page = _int_param("page", 1)
    vs = _parse_view_state(request.args)
    hl_token = request.args.get("hl", None)

    return _render_and_respond(doc_id, preset_name, page, vs, hl_token)


# ── GET /print/{doc_id} ────────────────────────────────────────

@render_bp.route("/print/<doc_id>", methods=["GET"])
def print_page(doc_id: str):
    """Render a page with the 'print' preset (200dpi, high quality).
    This validates RenderPreset under the most demanding scenario.
    Electron main process calls this to get print-ready images."""
    page = _int_param("page", 1)
    vs = _parse_view_state(request.args)
    # Allow overriding dpi/quality via query params for print flexibility
    overrides = {}
    if request.args.get("dpi"):
        try:
            overrides["dpi"] = int(request.args["dpi"])
        except ValueError:
            pass
    if request.args.get("quality"):
        try:
            overrides["quality"] = int(request.args["quality"])
        except ValueError:
            pass
    if request.args.get("fmt"):
        overrides["fmt"] = request.args["fmt"]
    override = overrides if overrides else None
    return _render_and_respond(doc_id, "print", page, vs, override_params=override)


# ── GET /print_pdf/{doc_id} ──────────────────────────────────────

@render_bp.route("/print_pdf/<doc_id>", methods=["GET"])
def print_pdf(doc_id: str):
    """Render an image document as a print-ready A4 PDF.

    IMAGE PIPELINE ONLY — This endpoint is exclusively for raster images.
    PDF and OFD documents are explicitly rejected; they use their own
    print pipelines (SumatraPDF direct for PDF, PrintAutoRotationPolicy
    + fitz embedding for OFD).

    Flow:
      1. Verify document is an image (not PDF, not OFD)
      2. Read image dims via Pillow → determine content orientation
      3. Compute auto-rotation (mirrors frontend PrintAutoRotationPolicy)
      4. Combine auto-rotation + user rotation → effective rotation
      5. Render at 200 dpi (print preset) with effective rotation
      6. Determine A4 page orientation from RENDERED dimensions
      7. Fit rendered image to page (contain mode, preserve aspect)
      8. Return PDF bytes

    Query params:
      content_rotation    int       0 | 90 | 180 | 270  user rotation (default: 0)
      paper_orientation   str       "portrait" | "landscape" (default: portrait)
    """
    # ── 1. Get document + verify image-only ────────────────────
    doc = registry.get(doc_id)
    if doc is None:
        return jsonify({"success": False, "error": "DOC_NOT_REGISTERED", "doc_id": doc_id}), 404

    # Reject PDF (has fitz handle) and OFD (has adapter)
    if doc.pdf is not None:
        return jsonify({"success": False, "error": "PRINT_PDF_ONLY_IMAGES", "reason": "document is a PDF, not an image"}), 400
    if doc.adapter is not None:
        return jsonify({"success": False, "error": "PRINT_PDF_ONLY_IMAGES", "reason": "document is OFD, not an image"}), 400
    if not doc.file_bytes:
        return jsonify({"success": False, "error": "PRINT_PDF_ONLY_IMAGES", "reason": "document has no raw bytes"}), 400

    # ── 2. Get image dimensions via Pillow + compute auto-rotation ──
    # 与前端 PrintAutoRotationPolicy 保持一致的自动旋转逻辑：
    #   内容方向 vs 纸张方向 → 决定是否需要旋转
    #   横内容塞竖纸 = 270°；竖内容塞横纸 = 90°；方向一致 = 0°
    try:
        from PIL import Image, ImageOps
        with Image.open(io.BytesIO(doc.file_bytes)) as pil_img:
            oriented = ImageOps.exif_transpose(pil_img)
            if oriented is not None:
                pil_img = oriented
            img_w, img_h = pil_img.size
    except Exception:
        logger.warning("print_pdf: cannot read image dims via Pillow, using defaults")
        img_w, img_h = 595, 842  # A4 portrait default

    # Parse user rotation (from frontend's fileRotations)
    user_rotation = _int_param("content_rotation", 0)
    if user_rotation not in (0, 90, 180, 270):
        user_rotation = 0

    # Parse target paper orientation (default: portrait A4)
    paper_orient = request.args.get("paper_orientation", "portrait").lower()
    if paper_orient not in ("portrait", "landscape"):
        paper_orient = "portrait"

    # ── Auto-rotation (PrintAutoRotationPolicy v1.0 backend mirror) ──
    # 先确定原始内容方向，再结合用户旋转计算旋转后的方向，
    # 最后基于旋转后的方向 vs 纸张方向 决定是否需要自动旋转。
    content_orient = "landscape" if img_w > img_h else "portrait"

    # 用户旋转后的内容方向（90/270 度方向反转，0/180 度方向不变）
    user_swaps_orient = (user_rotation % 180) != 0
    user_intended_orient = (
        ("landscape" if content_orient == "portrait" else "portrait")
        if user_swaps_orient
        else content_orient
    )

    # 基于用户意图方向决定自动旋转
    auto_rotation = 0
    if user_intended_orient != paper_orient:
        auto_rotation = 270 if user_intended_orient == "landscape" else 90
    effective_rotation = (auto_rotation + user_rotation) % 360

    logger.info("print_pdf: doc=%s img=%dx%d orig=%s user_rot=%d intended=%s paper=%s auto_rot=%d effective=%d",
                doc_id[:12], img_w, img_h, content_orient, user_rotation,
                user_intended_orient, paper_orient, auto_rotation, effective_rotation)

    rotation = effective_rotation

    # ── 3. Render at 200 dpi (print preset), output PNG for fitz ──
    # Use override_params to request PNG format directly, avoiding
    # the webp→png roundtrip (fitz insert_image doesn't support webp).
    vs = {"rotation": rotation}
    try:
        render_data, render_fmt, _etag = engine.render(
            doc_id=doc_id,
            preset_name="print",
            view_state=vs,
            page=1,
            override_params={"fmt": "png"},
        )
    except DocumentNotRegistered:
        return jsonify({"success": False, "error": "DOC_NOT_REGISTERED", "doc_id": doc_id}), 404
    except Exception as e:
        logger.exception("print_pdf: render failed for %s", doc_id[:12])
        return jsonify({"success": False, "error": f"render failed: {e}"}), 500

    # ── 4. Get rendered image dimensions via PIL ───────────────
    try:
        from PIL import Image
        with Image.open(io.BytesIO(render_data)) as rendered_img:
            rendered_w, rendered_h = rendered_img.size
    except Exception:
        logger.warning("print_pdf: cannot read rendered image dims, using A4 defaults")
        rendered_w, rendered_h = 1654, 2339  # A4 @ 200dpi fallback

    # ── 5. Determine A4 page orientation from RENDERED dimensions ──
    # ⚠️ 关键修复：不使用 rotation 值判断方向，而是使用实际渲染后的图像尺寸。
    # 因为 _render_image_page 已经用 _apply_margins 将旋转后的内容放在 A4 画布上，
    # 渲染输出的宽高比 = 内容旋转后的实际方向。
    # 旧逻辑 rotation in (90, 270) 仅对纵向图片正确，对横向图片完全错误。
    is_landscape = rendered_w > rendered_h
    A4_PT = {
        "portrait": (595.0, 842.0),
        "landscape": (842.0, 595.0),
    }
    page_w, page_h = A4_PT["landscape"] if is_landscape else A4_PT["portrait"]

    # ── 6. Fit rendered image to page (contain, centered) ──────
    # Convert rendered pixel dimensions to PDF points (72 dpi)
    # The render preset is 200 dpi, so: points = pixels * 72/200
    RENDER_DPI = 200.0
    SCALE_TO_PT = 72.0 / RENDER_DPI
    img_w_pt = rendered_w * SCALE_TO_PT
    img_h_pt = rendered_h * SCALE_TO_PT

    # Contain fit: scale factor to fit within page
    # 注意：_render_image_page 已经通过 _apply_margins 在 A4 画布上渲染，
    # 所以渲染输出通常已经接近 A4 尺寸。fit_ratio 应接近 1.0。
    fit_ratio = min(page_w / img_w_pt, page_h / img_h_pt, 1.0)
    fitted_w = img_w_pt * fit_ratio
    fitted_h = img_h_pt * fit_ratio

    x_offset = (page_w - fitted_w) / 2.0
    y_offset = (page_h - fitted_h) / 2.0

    # ── 7. Create PDF (render_data is already PNG, safe for fitz) ─
    try:
        import fitz

        pdf_doc = fitz.open()
        pdf_page = pdf_doc.new_page(width=page_w, height=page_h)
        pdf_page.insert_image(
            fitz.Rect(x_offset, y_offset, x_offset + fitted_w, y_offset + fitted_h),
            stream=render_data,
        )

        output = io.BytesIO()
        pdf_doc.save(output, incremental=False, deflate=True)
        pdf_doc.close()
        output.seek(0)
        pdf_bytes = output.read()
    except ImportError:
        return jsonify({"success": False, "error": "fitz (PyMuPDF) is not available"}), 500
    except Exception as e:
        logger.exception("print_pdf: pdf creation failed for %s", doc_id[:12])
        return jsonify({"success": False, "error": f"pdf creation failed: {e}"}), 500

    # ── 8. Return PDF ──────────────────────────────────────────
    headers = {
        "Content-Type": "application/pdf",
        "Content-Length": str(len(pdf_bytes)),
        "Cache-Control": "no-store, private",
        "X-Print-PDF-Doc": doc_id[:12],
        "X-Print-PDF-Rotation": str(rotation),
        "X-Print-PDF-Orientation": "landscape" if is_landscape else "portrait",
    }
    return Response(pdf_bytes, status=200, headers=headers)


# ── GET /metadata/{doc_id} ─────────────────────────────────────

@render_bp.route("/metadata/<doc_id>", methods=["GET"])
def metadata(doc_id: str):
    """Return document metadata: page count, content hash, size, page dimensions.

    统一 page metadata contract：pages[] 是前端未来的唯一消费源；顶层
    page_width/page_height/page_rotation 保留兼容旧消费者（取首页值）。
    派发顺序 adapter → pdf → image：adapter 是格式专属渲染器的权威来源，
    不再 sniff（doc.adapter 已标识类型）。
    """
    doc = registry.get(doc_id)
    if doc is None:
        return jsonify({"success": False, "error": "DOC_NOT_REGISTERED", "doc_id": doc_id}), 404

    # adapter 优先（OFD 等），其次 pdf，最后 image；不做格式 sniff
    if doc.adapter is not None:
        pages = _pages_from_adapter(doc.adapter)
    elif doc.pdf is not None and doc.page_count > 0:
        pages = _pages_from_pdf(doc)
    elif doc.file_bytes and doc.page_count > 0:
        pages = _pages_from_image(doc)
    else:
        pages = []

    page_count = len(pages)
    # 顶层兼容字段 = 首页（无页时全 0）；多页 PDF 仅表征第 0 页，pages[] 才是全量
    first = pages[0] if pages else {"width": 0, "height": 0, "rotation": 0}

    return jsonify({
        "success": True,
        "doc_id": doc.doc_id,
        "page_count": page_count,
        "content_hash": doc.content_hash,
        "size": doc.size,
        "content_indexed": doc.content_indexed,
        "page_width": first["width"],
        "page_height": first["height"],
        "page_rotation": first["rotation"],
        "pages": pages,
    })


def _pages_from_adapter(adapter) -> list:
    """格式专属适配器的页面合同 → 统一 pages[]。

    adapter.metadata() 返回 {pageCount, pages:[{index,width,height,sourceRotation}]}；
    映射 sourceRotation → rotation，使 API 不感知具体格式（无 if ofd 分支）。
    """
    meta = adapter.metadata() or {}
    out = []
    for p in meta.get("pages", []):
        out.append({
            "index": p.get("index", len(out)),
            "width": p.get("width", 0),
            "height": p.get("height", 0),
            "rotation": p.get("sourceRotation", 0),
        })
    return out


def _pages_from_pdf(doc) -> list:
    """PDF 每页几何 → pages[]（含 /Rotate）。"""
    pages = []
    for i in range(doc.page_count):
        try:
            p = doc.pdf[i]
            pages.append({
                "index": i,
                "width": round(p.rect.width, 2),
                "height": round(p.rect.height, 2),
                "rotation": getattr(p, "rotation", 0),
            })
        except Exception:
            pages.append({"index": i, "width": 0, "height": 0, "rotation": 0})
    return pages


def _pages_from_image(doc) -> list:
    """单页图像 → pages[]（含 EXIF 方向校正）。"""
    try:
        from PIL import Image, ImageOps
        with Image.open(io.BytesIO(doc.file_bytes)) as img:
            oriented = ImageOps.exif_transpose(img)
            if oriented is not None:
                img = oriented
            return [{
                "index": 0,
                "width": img.width,
                "height": img.height,
                "rotation": 0,
            }]
    except Exception:
        return []


# ── GET /search ────────────────────────────────────────────────

@render_bp.route("/search", methods=["GET"])
def search():
    """Unified search across Metadata + Content indexes."""
    query = request.args.get("q", "").strip()
    limit = _int_param("limit", 50)
    offset = _int_param("offset", 0)

    if not query:
        return jsonify({"success": True, "data": {"metadata_hits": [], "content_hits": [], "total": 0}})

    result = _content_index.search(query, limit=limit, offset=offset)
    return jsonify({"success": True, "data": result})


# ── internal helpers ───────────────────────────────────────────

def _render_and_respond(doc_id: str, preset_name: str,
                        page: int = 1, vs: dict = None,
                        hl_token: str = None,
                        override_params: dict = None,
                        render_spec: dict = None):
    """Shared rendering path: build, render, cache, respond.

    render_spec: Resolved Layout from Commit A/B verify_render_spec.
                 None → Legacy; not-None → wired into engine.render (Commit B-0
                 shadow mode: engine still executes Legacy).
    """
    vs = vs or {}

    if preset_name not in PRESETS:
        return jsonify({"success": False, "error": f"unknown preset: {preset_name}"}), 400

    try:
        data, fmt, etag = engine.render(
            doc_id=doc_id,
            preset_name=preset_name,
            view_state=vs,
            page=page,
            render_spec=render_spec,
            hl_token=hl_token,
            accept_header=request.headers.get("Accept", ""),
            override_params=override_params,
        )
    except DocumentNotRegistered as e:
        # ✅ 结构化错误码：前端据此精确触发「自动重注册 + 重试」，而非把所有 404 一刀切。
        return jsonify({
            "success": False,
            "error": "DOC_NOT_REGISTERED",
            "doc_id": e.doc_id,
        }), 404
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)}), 404
    except Exception as e:
        logger.exception("render failed for %s page %d", doc_id[:12], page)
        return jsonify({"success": False, "error": "render failed"}), 500

    # --- ETag / 304 ---
    incoming_etag = request.headers.get("If-None-Match", "").strip('"')
    if incoming_etag and incoming_etag == etag:
        headers = make_cache_headers(etag)
        return Response(status=304, headers=headers)

    # --- response ---
    mime = f"image/{fmt}"
    if fmt == "jpeg":
        mime = "image/jpeg"

    headers = make_cache_headers(etag)
    headers["Content-Type"] = mime
    headers["Content-Length"] = str(len(data))

    resp = Response(data, status=200, headers=headers)

    # --- trigger neighbor prefetch after first-page render ---
    if page == 1 and preset_name == "preview":
        render_queue.submit(
            "background",
            prefetch_neighbors,
            engine, doc_id, page, preset_name, vs,
        )

    return resp


def _parse_view_state(args) -> dict:
    """Parse view state from query string."""
    vs = {}
    rotation = _int_param("rotation", 0, args)
    if rotation:
        vs["rotation"] = rotation
    if args.get("gray", "0") == "1":
        vs["gray"] = True
    paper = args.get("paper", "")
    if paper:
        vs["paper"] = paper
    margin = args.get("margin")
    if margin is not None:
        try:
            vs["margin_mm"] = float(margin)
        except ValueError:
            pass
    if args.get("mirror", "0") == "1":
        vs["mirror"] = True
    return vs


def _int_param(name: str, default: int = 1, args=None) -> int:
    """Safely extract an int query parameter."""
    if args is None:
        args = request.args
    try:
        return int(args.get(name, default))
    except (ValueError, TypeError):
        return default
