"""D3-3b-2 Source Adapter - SourceRef -> bytes (Source layer, zero geometry).

Ownership contract (D3-3b-0 audit / D3-3b-1 executor):
  * This module is the SOURCE layer ONLY. Its single job is to resolve a
    SourceRef to the raw file bytes. It answers "where is the source?", never
    "how to draw the source?".
  * It MUST NOT decode, resize, rotate, crop, fit, or otherwise touch geometry.
    Those are the EXECUTOR's responsibility (D3-3b-1). This adapter returns the
    bytes opaque.
  * It MUST NOT open the bytes with fitz or any image decoder. PDF passthrough
    (insert_pdf) is a separate route and is never routed through here; the
    caller routes image (and later OFD) sourceRefs to this adapter, and PDF
    sourceRefs to the existing insert_pdf path.

First version supports images only. The `page` field of SourceRef is accepted
but deliberately ignored here -- it is consumed later by the executor for
multi-page sources. The trust boundary mirrors `_build_export_items` in
app.py: a same-machine absolute path chosen by the OS file dialog, guarded by
`os.path.isfile`. No path rewriting, no upload-name sanitization.
"""

import os


def read_source_bytes(source_ref):
    """Resolve a SourceRef dict to its raw file bytes.

    Args:
        source_ref: dict with at least ``{"path": <file path>}``. The ``page``
            key is accepted but ignored (the executor consumes it).

    Returns:
        bytes -- the raw contents of the file at ``source_ref["path"]``.

    Raises:
        ValueError: if ``source_ref`` is missing/empty or has no usable path.
        FileNotFoundError: if the resolved path does not exist on disk.
    """
    if not isinstance(source_ref, dict):
        raise ValueError("sourceRef must be a dict containing a 'path' key")
    path = source_ref.get("path")
    if not path or not isinstance(path, str):
        raise ValueError("sourceRef.path is required (non-empty string)")

    if not os.path.isfile(path):
        raise FileNotFoundError("sourceRef.path does not exist: %s" % path)

    with open(path, "rb") as fh:
        return fh.read()
