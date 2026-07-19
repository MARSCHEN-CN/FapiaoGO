"""D3-3b-3 Export Render Service - orchestration: source -> executor -> PDF.

Owns the export-render task orchestration. The three pipeline layers stay
strictly separate (mirrors export-pdf / PdfExportService / handlers):

  * SOURCE   : services.source_adapter.read_source_bytes   (path -> raw bytes)
  * GEOMETRY : services.render_executor.render_command_to_page (bytes+command -> fitz page)
  * OUTPUT   : this module merges pages into one fitz doc and returns PDF bytes.

Routing (image vs pdf) is decided from the ACTUAL bytes (magic-byte sniff),
never from the file name / extension. Why: the request's sourceRef has no
`kind` field (D3-3a schema is frozen: {path, page}), and the export-pdf
`files` metadata only carries path/name -- guessing from the extension is
exactly what the D3-3b-3 boundary forbids (case sensitivity / OFD / temp
files / renames). Byte content is the only authoritative signal available
without a schema change. PDF goes through insert_pdf passthrough (no
re-raster: preserves vectors / text / file size); everything else goes
through the executor.

This module MUST NOT compute fit / scale / center / rotation. Grep ban:
_apply_margins / calculateFit / fit_scale.
"""

import fitz

from services.source_adapter import read_source_bytes
from services.render_executor import render_command_to_page


def _detect_source_kind(source_bytes):
    """Decide image vs pdf from byte content, not from the filename."""
    if source_bytes[:4] == b'%PDF':
        return 'pdf'
    return 'image'


def _append_pdf_source(doc, source_bytes, page):
    """Insert a single PDF page via fitz.insert_pdf (passthrough, no re-raster).

    insert_pdf preserves the source vector content -- the whole point of the
    D3-3 split (Case 1/2: PDF stays PDF). We insert only the page the command
    selected (sourceRef.page), keeping the 1-command -> 1-output-page mapping
    consistent with the image path.
    """
    src_doc = fitz.open(stream=source_bytes)
    try:
        n = len(src_doc)
        if page < 0 or page >= n:
            page = 0
        doc.insert_pdf(src_doc, from_page=page, to_page=page)
    finally:
        src_doc.close()


def execute_export_render(commands, progress=None):
    """Orchestrate a list of RenderCommands into a single merged PDF (bytes).

    Args:
        commands: validated RenderCommand dicts (sourceRef + paper + geometry).
        progress: optional callable(label) invoked after each command, for
                  task progress reporting.

    Returns:
        bytes -- the merged PDF document.

    Raises:
        ValueError / FileNotFoundError: propagated from the source adapter
        (missing/empty path, file not found). The caller (route) maps these
        to a task failure -- we do NOT swallow source errors here.
    """
    doc = fitz.open()
    try:
        for cmd in commands:
            src_ref = cmd.get('sourceRef') or {}
            source_bytes = read_source_bytes(src_ref)  # may raise
            if _detect_source_kind(source_bytes) == 'pdf':
                _append_pdf_source(doc, source_bytes, int(src_ref.get('page', 0) or 0))
            else:
                render_command_to_page(doc, cmd, source_bytes)
            if progress:
                progress(src_ref.get('path') or 'command')
        data = doc.tobytes()
    finally:
        doc.close()
    return data
