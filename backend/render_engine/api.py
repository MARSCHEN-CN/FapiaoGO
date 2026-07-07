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
import time

from flask import Blueprint, request, jsonify, Response

from . import registry, render_cache, render_queue, engine
from .preset import PRESETS
from .cache import make_cache_headers, make_cache_key, generate_etag
from .content_index import ContentIndex
from .prefetch import prefetch_neighbors

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
    """Render page 1 with the 'preview' preset."""
    return _render_and_respond(doc_id, "preview")


# ── GET /thumbnail/{doc_id} ────────────────────────────────────

@render_bp.route("/thumbnail/<doc_id>", methods=["GET"])
def thumbnail(doc_id: str):
    """Render page 1 with the 'thumbnail' preset."""
    return _render_and_respond(doc_id, "thumbnail")


# ── GET /render/{doc_id} ───────────────────────────────────────

@render_bp.route("/render/<doc_id>", methods=["GET"])
def render_page(doc_id: str):
    """Render a specific page with explicit preset + view state."""
    preset_name = request.args.get("preset", "preview")
    page = _int_param("page", 1)
    vs = _parse_view_state(request.args)
    hl_token = request.args.get("hl", None)

    return _render_and_respond(doc_id, preset_name, page, vs, hl_token)


# ── GET /metadata/{doc_id} ─────────────────────────────────────

@render_bp.route("/metadata/<doc_id>", methods=["GET"])
def metadata(doc_id: str):
    """Return document metadata: page count, content hash, size."""
    doc = registry.get(doc_id)
    if doc is None:
        return jsonify({"success": False, "error": "document not found"}), 404

    return jsonify({
        "success": True,
        "doc_id": doc.doc_id,
        "page_count": doc.page_count,
        "content_hash": doc.content_hash,
        "size": doc.size,
        "content_indexed": doc.content_indexed,
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
                        hl_token: str = None):
    """Shared rendering path: build, render, cache, respond."""
    vs = vs or {}

    if preset_name not in PRESETS:
        return jsonify({"success": False, "error": f"unknown preset: {preset_name}"}), 400

    try:
        data, fmt, etag = engine.render(
            doc_id=doc_id,
            preset_name=preset_name,
            view_state=vs,
            page=page,
            hl_token=hl_token,
            accept_header=request.headers.get("Accept", ""),
        )
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
