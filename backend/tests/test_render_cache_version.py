"""Lock that RENDER_ENGINE_VERSION flows into the cache key + ETag.

Prevents a future "optimization" from silently dropping the version dimension,
which would re-introduce stale-thumbnail bugs (e.g. the 90/270 rotation flip of
2026-08-20) after any render-algorithm change: identical URL+doc+rotation but
stale bytes would otherwise keep hitting the old in-memory cache entry.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from render_engine.cache import (
    RENDER_ENGINE_VERSION,
    generate_etag,
    make_cache_key,
)


def test_version_segment_present_in_key():
    key = make_cache_key("docX", "thumbnail", 1, "vh",
                         engine_version=RENDER_ENGINE_VERSION)
    assert f"ev:{RENDER_ENGINE_VERSION}" in key


def test_different_version_yields_different_key():
    a = make_cache_key("docX", "thumbnail", 1, "vh", engine_version="1")
    b = make_cache_key("docX", "thumbnail", 1, "vh", engine_version="2")
    assert a != b


def test_different_version_yields_different_etag():
    a = generate_etag("ch", "thumbnail", "vh", engine_version="1")
    b = generate_etag("ch", "thumbnail", "vh", engine_version="2")
    assert a != b
