"""
Document Registry — opaque doc_id → Document.
Holds fitz handle to avoid repeated fitz.open().
Never exposes filesystem paths through API.
"""

import hashlib
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Optional, Dict

logger = logging.getLogger(__name__)

try:
    import fitz
except ImportError:
    fitz = None


@dataclass
class Document:
    """A registered document in the rendering pipeline."""
    doc_id: str
    path: str                     # internal only, never returned to client
    pdf: Optional["fitz.Document"] = None
    page_count: int = 0
    mtime: float = 0.0
    size: int = 0
    content_hash: str = ""        # sha256 of file bytes (content-addressable)
    content_indexed: bool = False # whether ContentIndex has been built
    created_at: float = field(default_factory=time.time)
    last_access: float = field(default_factory=time.time)


class DocumentRegistry:
    """
    Thread-safe registry mapping opaque doc_id → Document.

    Usage:
        reg = DocumentRegistry()
        doc = reg.open(file_bytes, filename)
        # later...
        reg.release(doc.doc_id)
    """

    MAX_DOCUMENTS = 200           # upper bound to avoid leak on long sessions
    IDLE_TTL = 3600 * 4           # 4 hours, release documents idle beyond this

    def __init__(self):
        self._docs: Dict[str, Document] = {}
        self._lock = threading.Lock()

    # ── public API ──────────────────────────────────────────────

    def open(self, file_bytes: bytes, filename: str = "") -> Document:
        """Register a document from raw bytes. Returns Document with opaque doc_id."""
        doc_id = _make_doc_id(file_bytes, filename)
        content_hash = hashlib.sha256(file_bytes).hexdigest()

        with self._lock:
            # Return existing if already registered (same id + content)
            existing = self._docs.get(doc_id)
            if existing is not None and existing.content_hash == content_hash:
                existing.last_access = time.time()
                return existing

            # Remove stale entry if hash changed (file overwritten)
            if existing is not None:
                self._release_doc(existing)

            # Enforce upper bound
            if len(self._docs) >= self.MAX_DOCUMENTS:
                self._evict_oldest()

            doc = self._create_document(doc_id, file_bytes, filename, content_hash)
            self._docs[doc_id] = doc
            return doc

    def get(self, doc_id: str) -> Optional[Document]:
        """Retrieve a registered document by id."""
        with self._lock:
            doc = self._docs.get(doc_id)
            if doc is not None:
                doc.last_access = time.time()
            return doc

    def release(self, doc_id: str):
        """Release document handle and remove from registry."""
        with self._lock:
            doc = self._docs.pop(doc_id, None)
            if doc is not None:
                self._release_doc(doc)

    def touch(self, doc_id: str):
        """Update last_access without opening fitz."""
        with self._lock:
            doc = self._docs.get(doc_id)
            if doc is not None:
                doc.last_access = time.time()

    # ── internal ────────────────────────────────────────────────

    def _create_document(self, doc_id: str, file_bytes: bytes,
                         filename: str, content_hash: str) -> Document:
        doc = Document(
            doc_id=doc_id,
            path=filename,
            content_hash=content_hash,
            size=len(file_bytes),
        )
        if fitz is not None:
            try:
                doc.pdf = fitz.open(stream=file_bytes, filetype="pdf")
                doc.page_count = len(doc.pdf)
                doc.mtime = time.time()
            except Exception:
                # Not a PDF — fitz can still open as image later
                doc.pdf = None
                doc.page_count = 1
                doc.mtime = time.time()
        else:
            doc.page_count = 1
        return doc

    def _release_doc(self, doc: Document):
        """Close fitz handle if open."""
        if doc.pdf is not None:
            try:
                doc.pdf.close()
            except Exception as e:
                logger.debug("release_doc fitz.close error: %s", e)
            doc.pdf = None

    def _evict_oldest(self):
        """Evict the least recently accessed document."""
        if not self._docs:
            return
        to_remove = None
        oldest = float("inf")
        for did, d in self._docs.items():
            if d.last_access < oldest:
                oldest = d.last_access
                to_remove = did
        if to_remove is not None:
            self._release_doc(self._docs[to_remove])
            del self._docs[to_remove]
            logger.debug("evicted doc %s (LRU, last_access=%.0fs ago)",
                         to_remove[:12], time.time() - oldest)


# ── helpers ────────────────────────────────────────────────────

def _make_doc_id(file_bytes: bytes, filename: str = "") -> str:
    """Generate an opaque document id — not a path, not guessable."""
    digest = hashlib.sha256(file_bytes + filename.encode("utf-8")).hexdigest()
    return digest[:24]
