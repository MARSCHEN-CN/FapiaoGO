"""
ContentIndex — dual-index search interface (Metadata + Content).

Metadata Index:  delegates to existing db.search_invoices (file-level)
Content Index:   page+bbox text index (interface only, full impl in Phase 2)

Unified /search returns results from both indexes as an opaque envelope.
"""

import logging
from typing import List, Optional

logger = logging.getLogger(__name__)

try:
    import db as db_module
    DB_AVAILABLE = True
except ImportError:
    DB_AVAILABLE = False


class ContentIndex:
    """
    Dual-index search interface.

    Usage:
        ci = ContentIndex(registry)
        hits = ci.search("keyword")   # returns hits from both indexes
        token = ci.highlight_token(hits)  # for /render?hl=... (Phase 2)
    """

    def __init__(self, registry):
        self._registry = registry

    # ── public API ──────────────────────────────────────────────

    def search(self, query: str, limit: int = 50,
               offset: int = 0) -> dict:
        """
        Unified search across Metadata + Content indexes.

        Returns:
            {
                "metadata_hits": [...],   # file-level, from db.search_invoices
                "content_hits":  [...],   # page+bbox hits (empty in P0)
                "total": int,
            }
        """
        metadata_hits = []
        content_hits = []

        # --- Metadata Index (existing db.py) ---
        if DB_AVAILABLE and query.strip():
            try:
                db_result = db_module.search_invoices(
                    keyword=query,
                    type_filter="",
                    date_from="",
                    date_to="",
                    order_by="created_at",
                    order_dir="DESC",
                    limit=limit,
                    offset=offset,
                )
                metadata_hits = _hits_from_db(db_result)
            except Exception as e:
                logger.exception("MetadataIndex search error: %s", e)

        # --- Content Index (stub — Phase 2) ---
        # Once the full-text page+bbox index is built,
        # content_hits will contain [(doc_id, page, bbox, text), ...].
        # For P0, this returns empty — the interface is ready.
        if query.strip():
            content_hits = []  # Phase 2: delegate to bbox index lookup

        return {
            "metadata_hits": metadata_hits,
            "content_hits": content_hits,
            "total": len(metadata_hits) + len(content_hits),
        }

    def build(self, doc_id: str) -> bool:
        """
        Build Content Index for a document (lazy, called on first search/highlight).
        Phase 2: extracts text+bbox from pdf_text layer or OCR for scanned documents.
        P0: stub, returns False.
        """
        doc = self._registry.get(doc_id)
        if doc is None:
            return False
        logger.debug("ContentIndex.build called for %s (stub in P0)", doc_id[:12])
        # Phase 2: call paragraph/char extraction from pdf_text / ocr_engine,
        # then store (doc_id, page, x0, y0, x1, y1, text) rows in SQLite/JSON.
        return False

    def highlight_token(self, hits: list) -> str:
        """
        Generate an opaque hl_token from a list of content hits.
        Phase 2: deterministic hash of the bbox set, stored for lookup.
        P0: stub, returns empty string.
        """
        return ""


# ── helpers ─────────────────────────────────────────────────────

def _hits_from_db(db_result: dict) -> list:
    """Convert db.search_invoices output to uniform hit format."""
    hits = []
    for row in db_result.get("rows", []):
        hits.append({
            "doc_id": "",
            "page": None,
            "bbox": None,
            "text": "",
            "source": "metadata",
            "invoice_id": row.get("id"),
            "invoice_number": row.get("invoiceNumber", ""),
            "buyer_name": row.get("buyerName", ""),
            "seller_name": row.get("sellerName", ""),
            "total_amount": row.get("totalAmount", ""),
            "invoice_date": row.get("invoiceDate", ""),
            "file_name": row.get("fileName", row.get("originalFilename", "")),
        })
    return hits
