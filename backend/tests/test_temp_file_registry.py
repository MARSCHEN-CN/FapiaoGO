"""TempFileRegistry 契约测试 (IS-2 Commit 1)。

只验证"所有权契约"，不依赖任何文件 I/O（StorageBackend 默认 NullStorageBackend）。
对应 Contract v1 验收 4 类：
  1. 基本生命周期 retain → get → release → undefined
  2. ref 隔离（外部无法 mutate 内部记录）
  3. release 幂等（二次 release 不抛、不二次删除）
  4. Registry 只拥有 metadata，不持有业务对象引用

运行：backend/venv/Scripts/python -m pytest tests/test_temp_file_registry.py -q
"""
import os
import sys

# 保证 backend 目录在 sys.path（与既有 backend 测试一致）
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from temp_file_registry import TempFileRecord, TempFileRegistry, NullStorageBackend  # noqa: E402


class _SpyStorage:
    """记录 delete 调用次数，用于验证 release 只触发一次删除钩子。"""

    def __init__(self):
        self.deleted = []

    def delete(self, path: str) -> None:
        self.deleted.append(path)


class TestBasicLifecycle:
    def test_retain_get_release_undefined(self):
        reg = TempFileRegistry()
        rec = TempFileRecord(path="/tmp/x.pdf", filename="x.pdf", size=123, sha256="abc")
        ref = reg.retain(rec)

        got = reg.get(ref)
        assert got is not None
        assert got.refId == ref
        assert got.size == 123
        assert got.status == "active"

        assert reg.release(ref) is True
        # release 后 get 必须返回 None（生命周期结束）
        assert reg.get(ref) is None
        assert ref not in reg.active_refs()

    def test_auto_refId_when_empty(self):
        reg = TempFileRegistry()
        ref = reg.retain(TempFileRecord(size=1))
        assert ref.startswith("imp-")
        assert reg.get(ref).refId == ref

    def test_duplicate_retain_raises(self):
        reg = TempFileRegistry()
        ref = reg.retain(TempFileRecord(refId="imp-dup", size=1))
        import pytest
        with pytest.raises(ValueError):
            reg.retain(TempFileRecord(refId="imp-dup", size=2))


class TestRefIsolation:
    def test_external_record_mutation_does_not_leak(self):
        reg = TempFileRegistry()
        external = TempFileRecord(path="/tmp/x.pdf", filename="x.pdf", size=10)
        ref = reg.retain(external)
        # 改外部对象
        external.size = 999
        external.path = "/tmp/hacked.pdf"
        # 内部记录不受影响
        assert reg.get(ref).size == 10
        assert reg.get(ref).path == "/tmp/x.pdf"

    def test_returned_copy_is_isolated(self):
        reg = TempFileRegistry()
        ref = reg.retain(TempFileRecord(size=10))
        got = reg.get(ref)
        got.size = 888  # mutate 返回值
        # 再次 get 仍是原始值
        assert reg.get(ref).size == 10


class TestReleaseIdempotent:
    def test_double_release_no_throw_no_double_delete(self):
        storage = _SpyStorage()
        reg = TempFileRegistry(storage=storage)
        rec = TempFileRecord(path="/tmp/x.pdf", filename="x.pdf", size=1)
        ref = reg.retain(rec)

        assert reg.release(ref) is True
        # 第二次 release：不抛、返回 False、storage.delete 不被再次调用
        assert reg.release(ref) is False
        assert storage.deleted == ["/tmp/x.pdf"]

    def test_release_unknown_ref_returns_false(self):
        reg = TempFileRegistry()
        assert reg.release("imp-nonexistent") is False


class TestOwnsMetadataOnly:
    def test_does_not_hold_external_business_object(self):
        """Registry 只存自身 copy 的 metadata，不保留对外部对象的引用。"""
        reg = TempFileRegistry()
        external = TempFileRecord(size=42)
        ref = reg.retain(external)
        # 即便外部对象后来被改造/回收，内部记录独立
        external.size = -1
        internal = reg.get(ref)
        assert internal.size == 42
        # 返回的也是独立副本
        assert internal is not external
        assert internal is not reg.get(ref)
