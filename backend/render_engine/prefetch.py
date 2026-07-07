"""
Prefetch — neighbor page prefetching.

On first-page display, immediately queue rendering of neighboring
pages (page ± 1) at background priority so they are in cache when
the user flips pages.  Bounded:  never fetches all pages in a long
document — only immediate neighbors.
"""

import logging

logger = logging.getLogger(__name__)


def prefetch_neighbors(engine, doc_id: str, current_page: int,
                       preset_name: str = "preview",
                       view_state: dict = None):
    """
    Submit Page-1 and Page+1 renders to the background queue.

    Called from the idle callback ~300 ms after first paint
    so the CPU spike does not compete with the first page.
    """
    vs = view_state or {}
    doc = engine._registry.get(doc_id)
    if doc is None:
        return

    page_count = doc.page_count
    neighbor_pages = []

    # Always prefetch immediate neighbors if they exist
    if current_page > 1:
        neighbor_pages.append(current_page - 1)
    if current_page < page_count:
        neighbor_pages.append(current_page + 1)

    for page in neighbor_pages:
        engine._queue.submit(
            "background",
            _prefetch_render,
            engine, doc_id, preset_name, vs, page,
        )

    if neighbor_pages:
        logger.debug("prefetch queued pages %s for doc %s",
                     neighbor_pages, doc_id[:12])


def _prefetch_render(engine, doc_id: str, preset_name: str,
                     vs: dict, page: int):
    """Background render task — populates cache, returns nothing."""
    try:
        engine.render(
            doc_id=doc_id,
            preset_name=preset_name,
            view_state=vs,
            page=page,
        )
    except Exception as e:
        logger.debug("prefetch render pg %d failed (non-fatal): %s", page, e)
