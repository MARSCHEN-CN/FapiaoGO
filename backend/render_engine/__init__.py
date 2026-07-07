"""
render_engine — Document Pipeline rendering subsystem.

Components:
    registry   — DocumentRegistry (opaque doc_id → Document, holds fitz handle)
    preset     — RenderPreset dataclass + PRESETS registry
    queue      — RenderQueue with priority scheduling + idle/memory-pressure hooks
    cache      — Memory TTL cache + deterministic ETag + immutable headers
    engine     — Engine.render() unified entry (Image + Geometry Producer)
    prefetch   — Neighbor prefetch (page ±1) via background queue
    content_index — Metadata + Content dual index interface
    api        — Flask Blueprint (resource endpoints)
"""

from .registry import Document, DocumentRegistry
from .preset import RenderPreset, PRESETS
from .queue import RenderQueue
from .cache import RenderCache, generate_etag, make_cache_headers
from .engine import RenderEngine

# Global singletons (one per process)
registry = DocumentRegistry()
render_cache = RenderCache()
render_queue = RenderQueue()
engine = RenderEngine(registry=registry, cache=render_cache, queue=render_queue)
