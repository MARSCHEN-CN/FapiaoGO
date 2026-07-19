"""D3-3b-2 Source Adapter contract tests.

Locks three things (per the frozen b-2 boundary):
  1. happy path: sourceRef.path -> bytes == raw file bytes (opaque, no geometry).
  2. missing path -> MUST fail (ValueError).
  3. file not exists -> MUST fail (FileNotFoundError).
Plus:
  4. page field is ignored (same bytes with or without it).
  5. static grep: Source layer contains no geometry symbols
     (fitz.open / resize / rotate / crop / fit).
"""

import os
import re
import sys
import tempfile

import pytest

_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND_ROOT)

from services.source_adapter import read_source_bytes


def _write_tmp(data, suffix=".png"):
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return path


def test_read_source_returns_raw_file_bytes():
    data = b"\x89PNG\r\n\x1a\n" + os.urandom(128)
    path = _write_tmp(data)
    try:
        out = read_source_bytes({"path": path})
        assert out == data
    finally:
        os.remove(path)


def test_missing_path_raises():
    with pytest.raises(ValueError):
        read_source_bytes({})
    with pytest.raises(ValueError):
        read_source_bytes(None)
    with pytest.raises(ValueError):
        read_source_bytes({"path": ""})


def test_file_not_exists_raises():
    with pytest.raises(FileNotFoundError):
        read_source_bytes({"path": "C:/no/such/file/abc-xyz-123.png"})


def test_page_field_is_ignored():
    data = b"\xff\xd8\xff\xe0" + os.urandom(64)  # JPEG-ish header
    path = _write_tmp(data, suffix=".jpg")
    try:
        no_page = read_source_bytes({"path": path})
        with_page = read_source_bytes({"path": path, "page": 0})
        assert no_page == with_page == data
    finally:
        os.remove(path)


def test_adapter_does_not_touch_geometry():
    """Source layer never decodes/transforms geometry; that is the executor's job."""
    path = os.path.join(_BACKEND_ROOT, "services", "source_adapter.py")
    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()
    # strip docstrings / comments, inspect executable code only
    src = re.sub(r'""".*?"""', "", src, flags=re.DOTALL)
    src = re.sub(r"'''.*?'''", "", src, flags=re.DOTALL)
    src = re.sub(r"#.*$", "", src, flags=re.MULTILINE)
    for tok in ("fitz.open", "resize", "rotate", "crop", "calculateFit",
                "fit_scale", "_apply_margins"):
        assert tok not in src, "Source adapter must not contain geometry symbol '%s'" % tok
