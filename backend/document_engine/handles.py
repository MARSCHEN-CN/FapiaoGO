"""Resource handles (P2A contracts).

- ImageHandle: RAII lifecycle. Business layer holds it via `with` (sync) or
  `async with` (await using). Scope exit auto-releases -> Repository never leaks.
- PixelHandle: storage-agnostic read of pixels. Never exposes raw bytes at rest;
  only via as_*() accessors (v12 asXxx naming). `info()` returns PixelInfo.
"""
from __future__ import annotations

from typing import AsyncIterator, Protocol, runtime_checkable

from .models import ImageRef, PixelInfo


@runtime_checkable
class PixelHandle(Protocol):
    def as_bytes(self) -> bytes: ...
    def as_stream(self) -> AsyncIterator[bytes]: ...
    def as_bitmap(self): ...  # ImageBitmap / numpy array depending on runtime
    def info(self) -> PixelInfo: ...


@runtime_checkable
class ImageHandle(Protocol):
    ref: ImageRef

    def __enter__(self) -> "ImageHandle": ...
    def __exit__(self, exc_type, exc, tb) -> None: ...
    async def __aenter__(self) -> "ImageHandle": ...
    async def __aexit__(self, exc_type, exc, tb) -> None: ...


class MemoryPixelHandle:
    """Concrete PixelHandle backed by in-memory bytes (P2A reference impl)."""

    def __init__(self, data: bytes, info: PixelInfo):
        self._data = data
        self._info = info

    def as_bytes(self) -> bytes:
        return self._data

    async def as_stream(self) -> AsyncIterator[bytes]:
        yield self._data

    def as_bitmap(self):
        # P2A: caller decides decoding; raw bytes returned as a marker.
        return self._data

    def info(self) -> PixelInfo:
        return self._info


class ConcreteImageHandle:
    """Concrete RAII ImageHandle used by the in-memory P2A reference impl.

    `release` is a callable(id) invoked exactly once on scope exit.
    """

    def __init__(self, ref: ImageRef, release):
        self.ref = ref
        self._release = release
        self._released = False

    def __enter__(self) -> "ConcreteImageHandle":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._safe_release()

    async def __aenter__(self) -> "ConcreteImageHandle":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        self._safe_release()

    def _safe_release(self) -> None:
        if not self._released:
            self._released = True
            self._release(self.ref.id)
