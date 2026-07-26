"""
Preview Warmup Planner — P10 Phase A.

After import completion, proactively render first-page previews so the
RenderCache is warm before the user opens the document viewer.

Design constraints (P10 Phase A):
  • Warm is best-effort: failures are logged, never propagate to import.
  • Warm is fire-and-forget: all rendering runs in background daemon threads.
  • Warm does not own the cache: it only reads/writes through existing cache API.
  • Warm does not interact with the frontend: no endpoint, no UI coupling.
  • Dedupe: before rendering, check if cache already has the key.
    In-flight dedupe (task tracking) is Phase B — Phase A accepts a possible
    duplicate render race (one get_pixmap() wasted at most).

Identity bridge:
    RenderRequest.sourceDocumentId == engine.doc_id == sha256(file_bytes)[:24]
    Both are pure content hashes. When P8 Phase A introduces renderDocId, only
    the bridge function (_warm_render) changes — RenderRequest field names stay.
"""

import logging
from dataclasses import dataclass
from typing import Dict, List, Optional

from .cache import make_cache_key
from .engine import _hash_view_state

logger = logging.getLogger(__name__)

# ── Module-level constants ────────────────────────────────────

# engine.render() always calls _hash_view_state(vs), even for vs={}.
# Compute the empty-view-state hash once so warm cache-key lookups
# match the exact key that engine.render() produces — without
# hardcoding a magic string or duplicating the hash algorithm.
_EMPTY_VS_HASH = _hash_view_state({})

# Phase A cap: maximum files to warm in a single import batch.
# Prevents 1000-file import from spawning 1000 daemon render threads.
MAX_WARM_FILES = 20


@dataclass
class RenderRequest:
    """Describes a rendering resource to warm up.

    Fields mirror the P10 contract stack:
        sourceDocumentId  — content identity (sha256 of file bytes, first 24 chars)
        renderProfile     — "preview" | "thumbnail" | "print"
        page              — 1-based page number
        priority          — queue lane label (fixed to "warm" in Phase A)
        reason            — diagnostic label
    """
    sourceDocumentId: str
    renderProfile: str = "preview"
    page: int = 1
    priority: str = "warm"
    reason: str = ""


class WarmPlanner:
    """Decides WHAT to warm after import, delegates WHEN to RenderQueue.

    Phase A: warms page 1 of every newly imported file.
    No task tracking, no in-flight dedupe — just cache-check-then-submit.
    """

    def __init__(self, engine, queue, cache):
        self._engine = engine
        self._queue = queue
        self._cache = cache

    def warm_after_import(self, files: List[Dict]) -> None:
        """Fire-and-forget: submit page-1 warm requests for imported files.

        Called from the import pipeline after registry.open() succeeds.
        Runs in the worker thread — never blocks import return.

        Args:
            files: list of ``{"doc_id": str, "page_count": int}`` from the
                   completed import. ``doc_id`` == sha256(file_bytes)[:24].
        """
        # Phase A cap: limit warm threads to prevent CPU storm on 1000+ imports.
        files = files[:MAX_WARM_FILES]
        for f in files:
            req = RenderRequest(
                sourceDocumentId=f["doc_id"],
                page=1,
            )
            if self._already_ready(req):
                logger.debug("warmup skip (cache HIT): %s p%d",
                             req.sourceDocumentId[:12], req.page)
                continue
            self._queue.submit(
                "warm",
                _warm_render,
                self._engine,
                self._cache,
                req,
            )

    def _already_ready(self, req: RenderRequest) -> bool:
        """Check whether the requested resource is already cached."""
        key = make_cache_key(req.sourceDocumentId, req.renderProfile, req.page,
                             _EMPTY_VS_HASH)
        return self._cache.get(key) is not None


def _warm_render(engine, cache, req: RenderRequest):
    """Bridge: P10 RenderRequest → engine.render().

    This is the only identity bridge point:
        sourceDocumentId → engine.doc_id (same value, different role).

    When P8 Phase A introduces renderDocId, only the ``doc_id=`` parameter
    below changes — RenderRequest field names stay.
    """
    try:
        # Double-check cache before rendering: an interactive request may have
        # filled the cache while this warm task was queued. Use the same
        # vs_hash that engine.render() produces for empty view state.
        key = make_cache_key(req.sourceDocumentId, req.renderProfile, req.page,
                             _EMPTY_VS_HASH)
        if cache.get(key):
            logger.debug("warm_render skip (cache already filled): %s p%d",
                         req.sourceDocumentId[:12], req.page)
            return

        engine.render(
            doc_id=req.sourceDocumentId,
            preset_name=req.renderProfile,
            page=req.page,
        )
        logger.debug("warm_render done: %s p%d",
                     req.sourceDocumentId[:12], req.page)
    except Exception:
        logger.exception("warm_render failed (non-fatal): %s p%d",
                         req.sourceDocumentId[:12], req.page)
