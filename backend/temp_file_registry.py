"""TempFileRegistry — import 生命周期中 temp 文件的所有权契约 (IS-2).

Commit 1：只建立所有权契约（retain/get/release + NullStorageBackend 占位，无 I/O）。
Commit 2：新增 LocalTempFileStorageBackend（真实落盘/读取/删除）+ Registry.spool()/
         read_bytes()，并在 spool 边界一次性物化 identity（sha256 + doc_id）。

设计原则（来自 Contract v1 INV-1..5）：
- refId 是唯一 opaque 标识，绝不暴露 path 给 session / job contract。
- spool 边界物化 identity（sha256 + doc_id），manager/scheduler 不得重算哈希。
- get() 返回副本，外部无法 mutate 内部记录（参照 IS-1 getChildBatchIds 副本隔离）。
- release() 幂等：重复 release 不抛、不二次删除。
- Registry 只拥有 metadata，不持有 Session / Store / Batch result 等业务对象。
- 文件 I/O 全部委托给可注入的 StorageBackend，Registry 与具体落盘方式解耦。
"""
from __future__ import annotations

import hashlib
import os
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
    就把抽象绑死到 open()/unlink()。Commit 2 的 LocalTempFileStorageBackend 替换它即可。
    """

    def delete(self, path: str) -> None:  # noqa: D401 - intentionally no-op
        return None


class LocalTempFileStorageBackend:
    """Commit 2 真实 I/O 后端：把上传流 spool 到本地临时文件。

    替换 Commit 1 的 NullStorageBackend。Registry 的所有权契约不变：
    它只知道 path/sha256/doc_id 等 metadata，落盘/读取/删除都委托给本后端。
    """

    def __init__(self, base_dir: Optional[str] = None):
        if base_dir is None:
            import tempfile
            base_dir = os.path.join(tempfile.gettempdir(), "print706_import_tmp")
        self._base_dir = base_dir
        os.makedirs(self._base_dir, exist_ok=True)

    def spool(self, stream, filename: str):
        """把 stream 写入临时文件，增量计算 sha256，返回 (path, size, sha256)。

        分块流式写入，避免一次性读入内存（大文件友好）。
        filename 仅用于生成可读的临时名，绝不含进哈希（保持 content-only 身份）。
        """
        ext = os.path.splitext(filename or "")[1] or ".bin"
        name = "imp-" + uuid.uuid4().hex + ext
        path = os.path.join(self._base_dir, name)
        h = hashlib.sha256()
        size = 0
        with open(path, "wb") as out:
            for chunk in iter(lambda: stream.read(65536), b""):
                if not chunk:
                    break
                h.update(chunk)
                out.write(chunk)
                size += len(chunk)
        return path, size, h.hexdigest()

    def read_bytes(self, path: str) -> bytes:
        """读取已落盘的临时文件内容（scheduler 按 refId 即时读取用）。"""
        with open(path, "rb") as f:
            return f.read()

    def delete(self, path: str) -> None:
        """幂等删除；文件不存在也不抛。"""
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


class TempFileRecord:
    """temp 文件的不可变元数据记录（opaque refId 形态，字段集合冻结）。

    字段（与 Contract v1 冻结形状一致，camelCase 保留以对齐前端 _ref 语义）：
        refId    唯一 opaque 标识（如 "imp-<uuid4>"），session/job contract 只持它
        path     内部存储路径（不暴露给上层 contract）
        filename 原始文件名
        size     字节数
        sha256   content-only 哈希（Commit 2 spool 边界算定）
        doc_id   文档身份（= sha256[:24]，与 render_engine.registry._make_doc_id 同规则）
        createdAt 登记时间戳（epoch 秒）
        status   生命周期状态（Commit 1: "active"；release 后记录移除）
    """

    __slots__ = ("refId", "path", "filename", "size", "sha256", "doc_id", "createdAt", "status")

    def __init__(self, refId="", path="", filename="", size=0, sha256="",
                 doc_id="", createdAt=0.0, status="active"):
        self.refId = refId
        self.path = path
        self.filename = filename
        self.size = size
        self.sha256 = sha256
        self.doc_id = doc_id
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
            doc_id=self.doc_id,
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
            "doc_id": self.doc_id,
            "createdAt": self.createdAt,
            "status": self.status,
        }


class TempFileRegistry:
    """temp 文件生命周期的所有者（retain / get / release / spool / read_bytes）。

    Commit 1 仅承担"所有权契约"：记录存于内存 dict（key=refId），
    文件删除通过注入的 StorageBackend 委托（当前为 no-op）。
    Commit 2 起：spool() 把上传流落盘并物化 identity；read_bytes() 供 scheduler 即时读取。
    """

    def __init__(self, storage: Optional[StorageBackend] = None):
        self._storage = storage if storage is not None else NullStorageBackend()
        self._records: Dict[str, TempFileRecord] = {}

    def spool(self, stream, filename: str, *, doc_id: Optional[str] = None) -> TempFileRecord:
        """Spool 一个上传流到临时存储，登记记录并返回（opaque refId）。

        身份物化边界（INV-2）：落盘 + sha256 + doc_id 在此一次性算定，
        manager/scheduler 之后只消费 record.sha256，绝不重新 read+hash 字节。
        doc_id 默认 = sha256[:24]，与 render_engine.registry._make_doc_id 的
        content-only 规则保持一致（若调用方已知 doc_id 可传入避免重复计算）。

        Args:
            stream: 任意可读二进制流（werkzeug FileStorage.stream / BytesIO / 文件）
            filename: 原始文件名（仅用于生成可读临时名，不含进哈希）
            doc_id: 可选，已知文档身份时传入；否则由 sha256[:24] 推导
        """
        path, size, sha256 = self._storage.spool(stream, filename)
        if doc_id is None:
            doc_id = sha256[:24]
        rec = TempFileRecord(
            path=path,
            filename=filename,
            size=size,
            sha256=sha256,
            doc_id=doc_id,
            status="active",
        )
        ref_id = self.retain(rec)
        return self.get(ref_id)

    def read_bytes(self, ref_id: str) -> bytes:
        """按 refId 即时读取临时文件内容（scheduler 给 worker 用）。

        注意：这是"按需读取"，不是常驻内存——配合 spool 使用可彻底消除
        上传期的全量 bytes 峰值（INV-1）。
        """
        rec = self.get(ref_id)
        if rec is None:
            raise KeyError(f"refId not retained in registry: {ref_id}")
        return self._storage.read_bytes(rec.path)

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
