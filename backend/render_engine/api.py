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

    # ── [DIAG] Layer 1: HTTP 入口 — 每次请求都打印，用于证明浏览器是否真的发了请求 ──
    print(f"[HTTP] sig={request.args.get('spec_sig','-')[:8]} ox={request.args.get('ox','-')} oy={request.args.get('oy','-')} margin_l={request.args.get('margin_l','-')}", flush=True)

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
    # ── [DIAG] 响应元数据：ETag + Content-Length，用于判断"拖边距后 JPEG 是否真的变了" ──
    print(f"[RESPONSE] etag={resp.headers.get('ETag','-')[:16]} len={resp.headers.get('Content-Length','-')}", flush=True)

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
    """
    page = _int_param("page", 1)
    return _render_and_respond(doc_id, "thumbnail", page)


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


# ── GET /metadata/{doc_id} ─────────────────────────────────────

@render_bp.route("/metadata/<doc_id>", methods=["GET"])
def metadata(doc_id: str):
    """Return document metadata: page count, content hash, size, page dimensions."""
    doc = registry.get(doc_id)
    if doc is None:
        return jsonify({"success": False, "error": "DOC_NOT_REGISTERED", "doc_id": doc_id}), 404

    # 获取第一页尺寸和旋转（用于方向检测），单位为 PDF points (1/72 inch)
    # page.rect 不含 /Rotate；需配合 page.rotation 计算显示方向
    page_width = 0
    page_height = 0
    page_rotation = 0
    if doc.pdf is not None and doc.page_count > 0:
        p = doc.pdf[0]
        page_width = round(p.rect.width, 2)
        page_height = round(p.rect.height, 2)
        page_rotation = getattr(p, 'rotation', 0)

    return jsonify({
        "success": True,
        "doc_id": doc.doc_id,
        "page_count": doc.page_count,
        "content_hash": doc.content_hash,
        "size": doc.size,
        "content_indexed": doc.content_indexed,
        "page_width": page_width,
        "page_height": page_height,
        "page_rotation": page_rotation,
    })


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
