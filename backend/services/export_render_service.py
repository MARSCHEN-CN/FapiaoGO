"""D3-3b-3 / D3-3d-2 Export Render Service - orchestration: source -> executor -> PDF.

Owns the export-render task orchestration. The three pipeline layers stay
strictly separate (mirrors export-pdf / PdfExportService / handlers):

  * SOURCE   : services.source_adapter.read_source_bytes   (path -> raw bytes)
  * GEOMETRY : services.render_executor.draw_render_command (bytes+command -> draw on a page)
  * OUTPUT   : this module merges pages into one fitz doc and returns PDF bytes.

Routing (image vs pdf) is decided from the ACTUAL bytes (magic-byte sniff),
never from the file name / extension. (See D3-3b-3 boundary.) PDF goes through
insert_pdf passthrough (no re-raster); image goes through the executor.

Same-sheet model (D3-3d-2, scheme B: one request == one sheet):
  All IMAGE commands in a request are drawn onto a SINGLE shared sheet page
  (created once, sized from the first image command's paper spec). PDF commands
  are passthrough and each insert their own page -- a PDF cannot be composited
  onto a shared raster sheet without re-rastering (forbidden; that would drop
  vectors / text / size, the exact thing D3-3b-3's passthrough avoids).

This module MUST NOT compute fit / scale / center / rotation. Grep ban:
_apply_margins / calculateFit / fit_scale.
"""

import fitz

from services.source_adapter import read_source_bytes
from services.render_executor import draw_render_command, paper_px


def _detect_source_kind(source_bytes):
    """Decide image vs pdf from byte content, not from the filename."""
    if source_bytes[:4] == b'%PDF':
        return 'pdf'
    return 'image'


def _peek_source_kind(path):
    """Cheap magic-byte sniff to route a source (pdf vs image) without a full
    decode. Reads only the first 5 bytes of the (local, trusted) path. The
    actual bytes are read once later inside render_sheet_commands /
    _append_pdf_source, so each file is fully read exactly once.
    """
    with open(path, 'rb') as fh:
        head = fh.read(5)
    if head.startswith(b'%PDF-'):
        return 'pdf'
    return 'image'


def _create_sheet_page(doc, paper):
    """Create the single shared sheet page for the request (scheme B).

    Sized from the command's PaperSpec via the backend-only paper_px
    derivation (round-half-UP, mirrors frontend mmToPxFactor exactly -- the
    Preview≡Export invariant from D3-3b-1).
    """
    if not paper:
        raise ValueError(
            "image command requires a paper spec to size the export sheet"
        )
    pw, ph = paper_px(paper)
    return doc.new_page(width=pw, height=ph)


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


def render_sheet_commands(doc, command_group):
    """Draw a GROUP of image RenderCommands onto ONE shared sheet page.

    Scheme B: one request == one sheet. This is the same-sheet executor entry
    point. Every command is an image source; each is drawn at its absolute
    offset / clip on the shared paper -- geometry is CONSUMED, never recomputed.
    The sheet page is created lazily from the first command's paper spec.

    PDF sources are not sheet-able (they are passthrough, not raster-composited)
    -- this function raises if it encounters one, so callers must route PDFs to
    _append_pdf_source instead.

    Future multi-page (scheme C: pages=[[..],[..]]) is a natural extension:
        for sheet in sheets:
            render_sheet_commands(doc, sheet)
    with no change to the per-sheet geometry logic here.

    Raises:
        ValueError: missing/empty source path, placement overflowing clip, or a
                    PDF source sneaking into a sheet group.
        FileNotFoundError: source path does not exist (from the source adapter).
    """
    sheet_page = None
    for command in command_group:
        src_ref = command.get('sourceRef') or {}
        source_bytes = read_source_bytes(src_ref)  # may raise ValueError/FileNotFoundError
        if _detect_source_kind(source_bytes) == 'pdf':
            raise ValueError(
                "PDF source cannot be composited onto a shared sheet; route it "
                "through _append_pdf_source (insert_pdf) passthrough instead."
            )
        if sheet_page is None:
            sheet_page = _create_sheet_page(doc, command.get('paper'))
        draw_render_command(sheet_page, command, source_bytes)
    # A command_group with zero image commands yields no sheet page; the caller
    # is responsible for producing at least one page (pdf passthrough or a
    # non-empty image group) so the output PDF is never empty.


def execute_export_render(commands, progress=None):
    """Orchestrate a list of RenderCommands into a single merged PDF (bytes).

    Scheme B same-sheet: all image commands share ONE sheet page; PDF commands
    are passthrough (each its own page). Geometry is consumed from the
    RenderCommands; this module never recomputes fit / scale / center / rotation.

    Args:
        commands: validated RenderCommand dicts (sourceRef + paper + geometry).
        progress: optional callable(label) invoked once per command (in request
                  order) for task progress reporting.

    Returns:
        bytes -- the merged PDF document.

    Raises:
        ValueError / FileNotFoundError: propagated from the source adapter or
        executor (missing/empty path, unreadable file, placement overflowing
        clip). The caller (route) maps these to a task failure -- we do NOT
        swallow source errors here.
    """
    doc = fitz.open()
    try:
        # Route: sniff KIND cheaply (5 bytes) and split into the same-sheet image
        # group vs the PDF passthrough list. Full bytes are read once later.
        image_group = []
        pdf_items = []
        for cmd in commands:
            src_ref = cmd.get('sourceRef') or {}
            path = src_ref.get('path')
            if not path:
                raise ValueError("sourceRef.path is required for every command")
            if _peek_source_kind(path) == 'pdf':
                pdf_items.append(cmd)
            else:
                image_group.append(cmd)

        if image_group:
            render_sheet_commands(doc, image_group)

        for cmd in pdf_items:
            src_ref = cmd.get('sourceRef') or {}
            source_bytes = read_source_bytes(src_ref)
            _append_pdf_source(doc, source_bytes, int(src_ref.get('page', 0) or 0))

        if progress:
            for cmd in commands:
                src_ref = cmd.get('sourceRef') or {}
                progress(src_ref.get('path') or 'command')

        data = doc.tobytes()
    finally:
        doc.close()
    return data
