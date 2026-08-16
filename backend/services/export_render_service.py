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
from services.pdf_handlers.image_handler import ImageExportHandler

# 方案 A：image → 单页 PDF → insert_pdf 复用 ImageExportHandler（方向/比例/无重采样已验证）
_image_handler = ImageExportHandler()


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


def _append_pdf_source(doc, source_bytes, page, pdf_doc=None):
    """Insert a single PDF page via fitz.insert_pdf (passthrough, no re-raster).

    insert_pdf preserves the source vector content -- the whole point of the
    D3-3 split (Case 1/2: PDF stays PDF). We insert only the page the command
    selected (sourceRef.page), keeping the 1-command -> 1-output-page mapping
    consistent with the image path.

    pdf_doc: optional already-open fitz.Document owned by the caller (used when
    the same source is referenced by several commands, so it is read + parsed
    only once). When omitted, source_bytes is opened+closed here (per-command).

    Raises:
        ValueError: when the requested page is out of range.
    """
    owned = pdf_doc is None
    src_doc = pdf_doc if pdf_doc is not None else fitz.open(stream=source_bytes)
    try:
        n = len(src_doc)
        if page < 0 or page >= n:
            raise ValueError(
                f"Page {page} out of range for PDF with {n} pages"
            )
        doc.insert_pdf(src_doc, from_page=page, to_page=page)
    finally:
        if owned:
            src_doc.close()


def render_sheet_commands(doc, command_group, source_cache=None, repeated=None):
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
    if source_cache is None:
        source_cache = {}
    sheet_page = None
    for command in command_group:
        src_ref = command.get('sourceRef') or {}
        path = src_ref.get('path')
        # Only consult the cache for sources referenced by >1 command (see
        # execute_export_render). Distinct sources are read once on demand, so
        # peak memory stays identical to the pre-cache behavior.
        use_cache = repeated is None or path in repeated
        source_bytes = source_cache.get(path) if (use_cache and path in source_cache) else None
        if source_bytes is None:
            source_bytes = read_source_bytes(src_ref)  # may raise ValueError/FileNotFoundError
            if use_cache:
                source_cache[path] = source_bytes
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


def execute_export_render(commands, progress=None, page_per_command=False):
    """Orchestrate a list of RenderCommands into a single merged PDF (bytes).

    Two composition semantics, selected by `page_per_command`:

      * page_per_command=False（scheme B, 默认 / 拼版）：所有 image command 共享
        一个 sheet 页；PDF command 透传（每个自己的页）。
      * page_per_command=True（合并导出）：每个 command 独立一个输出页，严格
        保持 commands 输入顺序（image → 单页 PDF → insert_pdf，页尺寸=图片尺寸、
        方向/比例跟随图片；pdf → insert_pdf 单页）。这使「输入物理页数 = 输出物理页数」成立。

    Geometry is consumed from the RenderCommands; this module never recomputes
    fit / scale / center / rotation.

    Args:
        commands: validated RenderCommand dicts (sourceRef + paper + geometry).
        progress: optional callable(label) invoked once per command (in request
                  order) for task progress reporting.
        page_per_command: True = 每 command 一个输出页（合并）；False = 同 sheet 拼版。

    Returns:
        bytes -- the merged PDF document.

    Raises:
        ValueError / FileNotFoundError: propagated from the source adapter or
        executor (missing/empty path, unreadable file, placement overflowing
        clip). The caller (route) maps these to a task failure -- we do NOT
        swallow source errors here.
    """
    doc = fitz.open()
    # Sources referenced by more than one command (e.g. exporting several pages
    # of one multi-page PDF) are read from disk + parsed only ONCE and reused.
    # Distinct sources keep the original per-command read (no extra memory held
    # for the whole request), so this is strictly non-regressive on memory.
    _path_counts = {}
    for cmd in commands:
        p = (cmd.get('sourceRef') or {}).get('path')
        if p:
            _path_counts[p] = _path_counts.get(p, 0) + 1
    _repeated = {p for p, c in _path_counts.items() if c > 1}
    _source_cache = {}      # path -> bytes (repeated sources only)
    _pdf_doc_cache = {}     # path -> fitz.Document (repeated PDF sources only)
    try:
        if page_per_command:
            # 合并导出契约（P0-C/P0-D）：每 command 一个输出页，严格保持输入顺序。
            # PDF → insert_pdf 单页透传；image → 单页 PDF → insert_pdf（方案 A，
            # 复用 ImageExportHandler，方向/比例/无重采样天然正确）。
            for cmd in commands:
                src_ref = cmd.get('sourceRef') or {}
                path = src_ref.get('path')
                if not path:
                    raise ValueError("sourceRef.path is required for every command")
                page = int(src_ref.get('page', 0) or 0)
                if _peek_source_kind(path) == 'pdf':
                    cached_doc = _pdf_doc_cache.get(path)
                    if cached_doc is not None:
                        _append_pdf_source(doc, None, page, pdf_doc=cached_doc)
                        continue
                    source_bytes = read_source_bytes(src_ref)
                    if path in _repeated:
                        src_doc = fitz.open(stream=source_bytes)
                        _pdf_doc_cache[path] = src_doc
                        _append_pdf_source(doc, None, page, pdf_doc=src_doc)
                    else:
                        _append_pdf_source(doc, source_bytes, page)
                else:
                    source_bytes = _source_cache.get(path)
                    if source_bytes is None:
                        source_bytes = read_source_bytes(src_ref)
                        if path in _repeated:
                            _source_cache[path] = source_bytes
                    # 方案 A：image → 单页 PDF → insert_pdf（页尺寸=图片尺寸，方向/比例跟随图片）
                    _image_handler.export_merge(source_bytes, path, doc)
        else:
            # scheme B：所有 image command 拼同一个 sheet 页；pdf 每 command 一页。
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
                render_sheet_commands(doc, image_group, _source_cache, _repeated)

            for cmd in pdf_items:
                src_ref = cmd.get('sourceRef') or {}
                path = src_ref.get('path')
                page = int(src_ref.get('page', 0) or 0)
                cached_doc = _pdf_doc_cache.get(path)
                if cached_doc is not None:
                    # Same source reused by another command: insert its page from the
                    # already-open doc (no disk read, no re-parse).
                    _append_pdf_source(doc, None, page, pdf_doc=cached_doc)
                    continue
                source_bytes = read_source_bytes(src_ref)
                if path in _repeated:
                    # Open once, keep for sibling commands, close in finally below.
                    src_doc = fitz.open(stream=source_bytes)
                    _pdf_doc_cache[path] = src_doc
                    _append_pdf_source(doc, None, page, pdf_doc=src_doc)
                else:
                    # Distinct source: original per-command open/close (no retained memory).
                    _append_pdf_source(doc, source_bytes, page)

        if progress:
            for cmd in commands:
                src_ref = cmd.get('sourceRef') or {}
                progress(src_ref.get('path') or 'command')

        data = doc.tobytes()
    finally:
        for sd in _pdf_doc_cache.values():
            sd.close()
        doc.close()
    return data
