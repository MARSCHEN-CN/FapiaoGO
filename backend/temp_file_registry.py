"""TempFileRegistry — import 生命周期中 temp 文件的所有权契约 (IS-2 Commit 1).

本模块**只建立所有权契约**，不实现 spool / 落盘 / 删除文件。
真正的文件 I/O 由可注入的 StorageBackend 承担：
- Commit 1 用 NullStorageBackend 占位（delete 为 no-op，不产生/不删除任何文件）；
- Commit 2 的 spool 实现再提供真实 TempFileStorageBackend（open().write / os.unlink）。

设计原则（来自 Contract v1 INV-1..5）：
- refId 是唯一 opaque 标识，绝不暴露 path 给 session / job contract。
- get() 返回副本，外部无法 mutate 内部记录（参照 IS-1 getChildBatchIds 副本隔离）。
- release() 幂等：重复 release 不抛、不二次删除。
- Registry 只拥有 metadata，不持有 Session / Store / Batch result 等业务对象。
"""
from __future__ import annotations

import time
import uuid
from typing import Dict, Optional, Protocol, runtime_checkable


@runtime_checkable
class StorageBackend(Protocol):
    """文件落盘/删除的抽象。Commit 1 不实现真实 I/O。"""

    def delete(self, path: str) -> None:
        ...


class NullStorageBackend:
    """Commit 1 占位：delete 为 no-op，不产生也不删除任何文件。

    把 Registry 的"所有权契约"与"spool 实现"解耦，避免在 Commit 1
    就把抽象绑死到 open()/unlink()。Commit 2 的 TempFileStorageBackend 替换它即可。
    """

    def delete(self, path: str) -> None:  # noqa: D401 - intentionally no-op
        return None


class TempFileRecord:
    """temp 文件的不可变元数据记录（opaque refId 形态，字段集合冻结）。

    字段（与 Contract v1 冻结形状一致，camelCase 保留以对齐前端 _ref 语义）：
        refId    唯一 opaque 标识（如 "imp-<uuid4>"），session/job contract 只持它
        path     内部存储路径（不暴露给上层 contract）
        filename 原始文件名
        size     字节数
        sha256   content-only 哈希（Commit 2 spool 边界算定）
        createdAt 登记时间戳（epoch 秒）
        status   生命周期状态（Commit 1: "active"；release 后记录移除）
    """

    __slots__ = ("refId", "path", "filename", "size", "sha256", "createdAt", "status")

    def __init__(self, refId="", path="", filename="", size=0, sha256="",
                 createdAt=0.0, status="active"):
        self.refId = refId
        self.path = path
        self.filename = filename
        self.size = size
        self.sha256 = sha256
        self.createdAt = createdAt if createdAt else time.time()
        self.status = status

    def copy(self) -> "TempFileRecord":
        """返回一份独立副本（隔离用，防止外部 mutate 内部记录）。"""
        return TempFileRecord(
            refId=self.refId,
            path=self.path,
            filename=self.filename,
            size=self.size,
            sha256=self.sha256,
            createdAt=self.createdAt,
            status=self.status,
        )

    def to_dict(self) -> dict:
        return {
            "refId": self.refId,
            "path": self.path,
            "filename": self.filename,
            "size": self.size,
            "sha256": self.sha256,
            "createdAt": self.createdAt,
            "status": self.status,
        }


class TempFileRegistry:
    """temp 文件生命周期的所有者（retain / get / release）。

    Commit 1 仅承担"所有权契约"：记录存于内存 dict（key=refId），
    文件删除通过注入的 StorageBackend 委托（当前为 no-op）。
    """

    def __init__(self, storage: Optional[StorageBackend] = None):
        self._storage = storage if storage is not None else NullStorageBackend()
        self._records: Dict[str, TempFileRecord] = {}

    def retain(self, record: TempFileRecord) -> str:
        """登记一条 temp 文件记录，返回其 opaque refId。

        - record.refId 为空时自动生成（"imp-<uuid4>" 前缀，预留给 Commit 5 startup sweep）。
        - 重复 refId 视为契约冲突，抛 ValueError（refId 必须唯一）。
        - 内部存副本，外部持有的 record 不再与内部记录绑定。
        """
        if not isinstance(record, TempFileRecord):
            raise TypeError("retain expects a TempFileRecord")
        if not record.refId:
            record.refId = "imp-" + uuid.uuid4().hex
        if record.refId in self._records:
            raise ValueError(f"refId already retained: {record.refId}")
        self._records[record.refId] = record.copy()
        return record.refId

    def get(self, refId: str) -> Optional[TempFileRecord]:
        """返回记录的副本（隔离）；不存在返回 None。"""
        rec = self._records.get(refId)
        return rec.copy() if rec is not None else None

    def release(self, refId: str) -> bool:
        """释放单条记录（= 单 job 生命周期结束）。幂等：

        - 存在 → 委托 storage.delete(path)（Commit 1 为 no-op），移除记录，返回 True
        - 不存在 → 无操作、不抛、不二次删除，返回 False

        注意：只删"本 job 对应的 refId"；在途/队列中的 refId 由调用方在 _on_job_done
        之前保证不被提前 release（INV-3，Commit 5 接线）。
        """
        rec = self._records.pop(refId, None)
        if rec is None:
            return False
        self._storage.delete(rec.path)
        return True

    def active_refs(self):
        """当前在册 refId 列表（供测试 / 审计）。"""
        return list(self._records.keys())
