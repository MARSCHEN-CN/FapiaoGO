"""
DocumentResolver — RE 文档恢复的抽象契约（接口冻结，暂未实现 backend）。

V16 四层模型（Facts → Derived → Consumers）::

    Facts (Source File / Invoice DB / OSS / ...)
            │
            ▼
    DocumentResolver   ← 本模块只定义接口与组合，不含任何具体存储后端
            │
            ▼
    DocumentRegistry (Derived Cache)
            │
            ▼
    RenderEngine
            │
            ▼
    Preview / Print / Export

设计铁律（2026-07-12 冻结）：
- RenderEngine 只依赖 ``DocumentResolver`` 接口，永不直接依赖任何 Facts 来源。
  新增来源（SQLite / Filesystem / OSS / S3 / OneDrive / ...）零改 RE。
- ``resolve(doc_id) -> (bytes, filename)`` 必须回传 filename：doc_id 是
  content-addressable 且含 filename（sha256(bytes + filename)），缺 filename 会算
  出不同 doc_id，导致刚恢复的文档下次仍 miss → 循环 miss。
- ``ResolverBackendError``（后端故障，如 OSS/DB 不可达）与 ``DocumentNotRegistered``
  （正常 cache miss）必须区分：前者记 ERROR 并上抛，后者记 INFO 交前端走 P0 重注册。

⚠️ 本文件仅为接口契约冻结（P2）。**不实现任何 backend，不接入 registry/render 流程。**
   具体 resolver（InvoiceDBResolver / FilesystemResolver / OSSResolver）与 wiring 暂缓，
   待 Stage1（RenderSpec 冻结）+ Registry 生命周期稳定后再做。
"""

from typing import List, Optional, Protocol, Tuple, runtime_checkable

from .engine import DocumentNotRegistered


class ResolverBackendError(Exception):
    """A resolver's backing store is unavailable (connection / timeout / 5xx).

    Distinct from ``DocumentNotRegistered``: this is infrastructure failure and
    must be logged at ERROR and surfaced — never swallowed as a normal cache miss.
    """


@runtime_checkable
class DocumentResolver(Protocol):
    """Resolve ``doc_id`` to ``(bytes, filename)`` from any Facts source.

    Implementations stay internal to the resolver package; RenderEngine only
    ever sees this interface.
    """

    def resolve(self, doc_id: str) -> Tuple[bytes, str]:
        """Return (document bytes, original filename) for ``doc_id``.

        Raises:
            DocumentNotRegistered: this resolver cannot find ``doc_id``.
            ResolverBackendError: the backing store failed (not "not found").
        """
        ...


class ChainResolver:
    """Try resolvers in order; first hit wins.

    - A resolver returning successfully short-circuits the chain.
    - A ``ResolverBackendError`` bubbles up immediately (never masked as a miss).
    - Only when *every* resolver reports ``DocumentNotRegistered`` do we raise
      ``DocumentNotRegistered`` (normal cache miss → frontend P0 auto-register).
    """

    def __init__(self, *resolvers: DocumentResolver) -> None:
        self._resolvers: List[DocumentResolver] = list(resolvers)

    def resolve(self, doc_id: str) -> Tuple[bytes, str]:
        last_miss: Optional[DocumentNotRegistered] = None
        for resolver in self._resolvers:
            try:
                return resolver.resolve(doc_id)
            except ResolverBackendError:
                # 后端故障不是"找不到"，必须上抛，否则真错误被淹没。
                raise
            except DocumentNotRegistered as e:
                last_miss = e
                continue
        if last_miss is not None:
            raise last_miss
        raise DocumentNotRegistered(doc_id)
