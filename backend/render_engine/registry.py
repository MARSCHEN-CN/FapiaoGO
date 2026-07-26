"""
Document Registry — opaque doc_id → Document.
Holds fitz handle to avoid repeated fitz.open().
Never exposes filesystem paths through API.
"""

import hashlib
import io
import logging
import threading
import time
import zipfile
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .types import TextSpan

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
    file_bytes: Optional[bytes] = None  # raw bytes for non-PDF (image/OFD); PDF uses fitz handle
    adapter: Optional[Any] = None       # format-specific renderer (e.g. OFDAdapter); PDF/Image=None
    page_count: int = 0
    mtime: float = 0.0
    size: int = 0
    content_hash: str = ""        # sha256 of file bytes (content-addressable)
    content_indexed: bool = False # whether ContentIndex has been built
    text_cache: Optional[Dict[int, List[TextSpan]]] = None  # lazy, page→TextSpan[]
    created_at: float = field(default_factory=time.time)
    last_access: float = field(default_factory=time.time)
    ref_count: int = 1            # how many consumers hold this doc — only close fitz at 0


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
        self._lock = threading.RLock()

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
                existing.ref_count += 1
                logger.debug("doc %s ref_count now %d", doc_id[:12], existing.ref_count)
                return existing

            # Remove stale entry if hash changed (file overwritten)
            if existing is not None:
                self._release_doc(existing)

            # Enforce upper bound (clean idle first)
            if len(self._docs) >= self.MAX_DOCUMENTS:
                self.release_idle()
                # If still full after idle cleanup, fall back to LRU eviction
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

    def acquire(self, doc_id: str) -> Optional[Document]:
        """Explicitly increment ref_count (caller promises to release() later)."""
        with self._lock:
            doc = self._docs.get(doc_id)
            if doc is not None:
                doc.ref_count += 1
                doc.last_access = time.time()
                logger.debug("doc %s ref_count now %d (acquire)", doc_id[:12], doc.ref_count)
            return doc

    def release(self, doc_id: str):
        """Decrement ref_count. Only close fitz handle and remove from registry at 0."""
        with self._lock:
            doc = self._docs.get(doc_id)
            if doc is None:
                return
            doc.ref_count = max(0, doc.ref_count - 1)
            logger.debug("doc %s ref_count now %d (release)", doc_id[:12], doc.ref_count)
            if doc.ref_count == 0:
                self._release_doc(doc)
                del self._docs[doc_id]

    def release_idle(self):
        """
        Force-release documents that have been idle beyond IDLE_TTL.
        For ref_count>0: assume the consumer is gone (stale session), decrement
        and close if it reaches 0.
        """
        cutoff = time.time() - self.IDLE_TTL
        with self._lock:
            to_release = []
            for did, d in self._docs.items():
                if d.last_access < cutoff:
                    to_release.append(did)
            for did in to_release:
                doc = self._docs.get(did)
                if doc is None:
                    continue
                doc.ref_count = 0
                self._release_doc(doc)
                del self._docs[did]
                logger.info("release_idle: doc %s evicted (idle %.0fs)",
                            did[:12], time.time() - doc.last_access)

    def touch(self, doc_id: str):
        """Update last_access without opening fitz."""
        with self._lock:
            doc = self._docs.get(doc_id)
            if doc is not None:
                doc.last_access = time.time()

    def stats(self) -> dict:
        """Return aggregate statistics about the registry state."""
        with self._lock:
            total_docs = len(self._docs)
            total_refs = sum(d.ref_count for d in self._docs.values())
            total_pages = sum(d.page_count for d in self._docs.values())
            cached_pages = sum(
                len(d.text_cache) for d in self._docs.values()
                if d.text_cache is not None
            )
            open_fitz = sum(1 for d in self._docs.values() if d.pdf is not None)
        return {
            "documents": total_docs,
            "ref_count": total_refs,
            "page_count": total_pages,
            "text_cache_pages": cached_pages,
            "open_handles": open_fitz,
        }

    def close_all(self):
        """Force-close all documents (for shutdown / reset)."""
        with self._lock:
            for doc in list(self._docs.values()):
                self._release_doc(doc)
            self._docs.clear()
            logger.info("close_all: all documents released")

    # ── internal ────────────────────────────────────────────────

    def _create_document(self, doc_id: str, file_bytes: bytes,
                         filename: str, content_hash: str) -> Document:
        doc = Document(
            doc_id=doc_id,
            path=filename,
            content_hash=content_hash,
            size=len(file_bytes),
        )
        if _sniff_pdf(file_bytes):
            # PDF contract: hold fitz handle, route to _render_pdf_page.
            if fitz is not None:
                doc.pdf = fitz.open(stream=file_bytes, filetype="pdf")
                doc.page_count = len(doc.pdf)
            else:
                doc.file_bytes = file_bytes
                doc.page_count = 1
            doc.mtime = time.time()
            return doc
        if _sniff_image(file_bytes):
            # Image contract: store raw bytes, route to _render_image_page.
            # NOT through fitz — fitz.open(filetype="pdf") is permissive and
            # would silently mis-classify raster images as 1-page "PDFs".
            doc.pdf = None
            doc.file_bytes = file_bytes
            doc.page_count = 1
            doc.mtime = time.time()
            return doc
        if _sniff_ofd(file_bytes):
            # OFD contract: store raw bytes + attach a renderer adapter.
            # NOT through fitz — fitz.open() is permissive and may open an OFD
            # as a malformed PDF, silently mis-classifying it (the same class
            # of bug we already hit with raster images). All OFD-specific
            # behavior (page_count, dimensions, per-page render) lives in the
            # adapter; do NOT fabricate page_count here.
            doc.pdf = None
            doc.file_bytes = file_bytes
            try:
                from .adapters.ofd_adapter import OFDAdapter
                doc.adapter = OFDAdapter(file_bytes)
            except Exception as e:
                logger.warning("OFD sniffed but OFDAdapter init failed: %s", e)
                doc.adapter = None
            doc.mtime = time.time()
            return doc
        # Unknown format: let fitz try its own detection (XPS, etc.); on
        # failure, fall back to storing raw bytes (image path).
        if fitz is not None:
            try:
                doc.pdf = fitz.open(stream=file_bytes)
                doc.page_count = len(doc.pdf)
                doc.mtime = time.time()
                return doc
            except Exception:
                logger.debug("fitz cannot open %s; storing raw bytes", filename)
        doc.pdf = None
        doc.file_bytes = file_bytes
        doc.page_count = 1
        doc.mtime = time.time()
        return doc

    def _release_doc(self, doc: Document):
        """Close fitz handle if open and release raw bytes."""
        if doc.pdf is not None:
            try:
                doc.pdf.close()
            except Exception as e:
                logger.debug("release_doc fitz.close error: %s", e)
            doc.pdf = None
        doc.file_bytes = None

    def _evict_oldest(self):
        """Evict the least recently accessed document with ref_count == 0."""
        if not self._docs:
            return
        to_remove = None
        oldest = float("inf")
        for did, d in self._docs.items():
            if d.ref_count > 0:          # held by an active consumer
                continue
            if d.last_access < oldest:
                oldest = d.last_access
                to_remove = did
        if to_remove is not None:
            self._release_doc(self._docs[to_remove])
            del self._docs[to_remove]
            logger.debug("evicted doc %s (LRU, last_access=%.0fs ago)",
                         to_remove[:12], time.time() - oldest)


# ── content-type sniffing ─────────────────────────────────────
# Magic-byte detection is preferred over extension: a file named .jpg may
# actually be a PNG. fitz.open(filetype="pdf") is permissive and opens raster
# images as 1-page "PDFs", so we must classify BEFORE touching fitz.

def _sniff_pdf(file_bytes: bytes) -> bool:
    """True if the bytes look like a PDF (%PDF- header)."""
    return file_bytes[:5] == b"%PDF-"


def _sniff_ofd(file_bytes: bytes) -> bool:
    """True if bytes look like an OFD container.

    OFD is a ZIP archive, but so are .docx/.xlsx/.zip, so the PK magic alone is
    insufficient. Require a ZIP whose member list contains a canonical OFD
    marker file — either root `OFD.xml` or a `*/Document.xml` page document.
    """
    if file_bytes[:4] != b"PK\x03\x04":
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
            names = zf.namelist()
    except Exception:
        return False
    return "OFD.xml" in names or any("/Document.xml" in n for n in names)


def _sniff_image(file_bytes: bytes) -> bool:
    """True if the bytes look like a raster image fitz can render."""
    if len(file_bytes) < 12:
        return False
    # PNG
    if file_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        return True
    # JPEG (SOI marker FFD8FF — covers EXIF/JFIF)
    if file_bytes[:3] == b"\xff\xd8\xff":
        return True
    # GIF87a / GIF89a
    if file_bytes[:6] in (b"GIF87a", b"GIF89a"):
        return True
    # BMP
    if file_bytes[:2] == b"BM":
        return True
    # WEBP (RIFF....WEBP)
    if file_bytes[:4] == b"RIFF" and file_bytes[8:12] == b"WEBP":
        return True
    # TIFF (little-endian II*\x00 / big-endian MM\x00*)
    if file_bytes[:4] in (b"II*\x00", b"MM\x00*"):
        return True
    return False


# ── helpers ────────────────────────────────────────────────────

def _make_doc_id(file_bytes: bytes, filename: str = "") -> str:
    """Generate an opaque document identity — pure content hash.

    Identity Contract v1.1:
        docId = sha256(file_bytes).hexdigest()[:24]

    The `filename` parameter is accepted (for callers that pass it)
    but deliberately NOT included in the hash. Including the filename
    would cause renaming to change the document's persistent identity,
    breaking DocFacts, RenderCache, and UI state across sessions.

    Old behavior (pre-v1.1):
        docId = sha256(file_bytes + filename)[:24] — deprecated.
        See docs/architecture/identity-migration-note-v1.1.md.
    """
    digest = hashlib.sha256(file_bytes).hexdigest()
    return digest[:24]
