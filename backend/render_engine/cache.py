"""
RenderCache — TTL-based in-memory cache + deterministic ETag + immutable headers.
"""

import hashlib
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple

logger = logging.getLogger(__name__)


@dataclass
class CacheEntry:
    """A single cached rendered image."""
    data: bytes
    fmt: str      # "webp" | "jpeg" | "png"
    etag: str     # deterministic ETag value
    created_at: float = field(default_factory=time.time)
    size: int = 0


class RenderCache:
    """
    Thread-safe TTL cache for rendered previews.

    ETag generation: hash(preset_name + content_hash + view_state_hash + preset_version)
    Ensures deterministic cache keys — same input always produces same ETag.
    """

    MAX_ENTRIES = 1000
    DEFAULT_TTL = 3600             # 1 hour

    def __init__(self, ttl: int = None, max_entries: int = None):
        self._ttl = ttl or self.DEFAULT_TTL
        self._max = max_entries or self.MAX_ENTRIES
        self._store: Dict[str, CacheEntry] = {}
        self._lock = threading.Lock()

    # ── public API ──────────────────────────────────────────────

    def get(self, cache_key: str) -> Optional[CacheEntry]:
        with self._lock:
            entry = self._store.get(cache_key)
            if entry is None:
                return None
            if time.time() - entry.created_at > self._ttl:
                del self._store[cache_key]
                return None
            return entry

    def put(self, cache_key: str, data: bytes, fmt: str, etag: str):
        with self._lock:
            if len(self._store) >= self._max:
                self._evict_expired()
            self._store[cache_key] = CacheEntry(
                data=data, fmt=fmt, etag=etag, size=len(data),
            )

    def evict(self, cache_key: str):
        with self._lock:
            self._store.pop(cache_key, None)

    def clear(self):
        """Memory-pressure: discard all cached renders."""
        with self._lock:
            count = len(self._store)
            self._store.clear()
            logger.debug("memory-pressure: cleared %d cache entries", count)

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._store)

    # ── internal ────────────────────────────────────────────────

    def _evict_expired(self):
        cutoff = time.time() - self._ttl
        expired = [k for k, v in self._store.items() if v.created_at < cutoff]
        for k in expired:
            del self._store[k]
        if expired:
            logger.debug("RenderCache evicted %d expired entries", len(expired))

    def _evict_oldest(self):
        if not self._store:
            return
        oldest_key = min(self._store, key=lambda k: self._store[k].created_at)
        del self._store[oldest_key]


# ── module-level helpers ─────────────────────────────────────────

def generate_etag(content_hash: str, preset_name: str,
                  view_state_hash: str = "", preset_version: str = "1",
                  hl_token: str = "") -> str:
    """Deterministic ETag from all cache-key inputs."""
    raw = f"{content_hash}|{preset_name}|{view_state_hash}|v{preset_version}|hl:{hl_token}"
    return hashlib.md5(raw.encode()).hexdigest()[:16]


def make_cache_headers(etag: str, immutable: bool = True,
                       max_age: int = 31536000) -> dict:
    """HTTP response headers: Cache-Control + ETag."""
    if immutable:
        cc = f"public, max-age={max_age}, immutable"
    else:
        cc = f"public, max-age={max_age}"
    return {
        "Cache-Control": cc,
        "ETag": f'"{etag}"',
    }


def make_cache_key(doc_id: str, preset_name: str, page: int,
                   view_state_hash: str = "", hl_token: str = "") -> str:
    """Composite cache key for lookups. Keeps highlight identity in key."""
    parts = [doc_id, preset_name, str(page)]
    if view_state_hash:
        parts.append(view_state_hash)
    if hl_token:
        parts.append(f"hl:{hl_token}")
    return "|".join(parts)
