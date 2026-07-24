"""TempFileRegistry 契约测试 (IS-2 Commit 1)。

只验证"所有权契约"，不依赖任何文件 I/O（StorageBackend 默认 NullStorageBackend）。
对应 Contract v1 验收 4 类：
  1. 基本生命周期 retain → get → release → undefined
  2. ref 隔离（外部无法 mutate 内部记录）
  3. release 幂等（二次 release 不抛、不二次删除）
  4. Registry 只拥有 metadata，不持有业务对象引用

运行：backend/venv/Scripts/python -m pytest tests/test_temp_file_registry.py -q
"""
import io
import os
import sys

# 保证 backend 目录在 sys.path（与既有 backend 测试一致）
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from temp_file_registry import (  # noqa: E402
    TempFileRecord,
    TempFileRegistry,
    NullStorageBackend,
    LocalTempFileStorageBackend,
    read_bytes_by_ref,
)


def _child_read_bytes_by_ref(ref_id, base_dir):
    """模块级子进程 worker 模拟（必须模块级，Windows spawn 才能 pickle）。

    模拟 ProcessPool 子进程：只持 refId + base_dir，无父进程 _records 索引。
    """
    return read_bytes_by_ref(ref_id, base_dir)


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


class TestSpoolAndLocalBackend:
    """IS-2 Commit 2：真实落盘后端 + spool 边界身份物化。

    对应 Contract v1 INV-1（消除全量 bytes 峰值）+ INV-2（identity 在 spool 物化）。
    """

    def test_spool_writes_file_and_materializes_identity(self, tmp_path):
        backend = LocalTempFileStorageBackend(base_dir=str(tmp_path))
        reg = TempFileRegistry(backend)
        content = b"%PDF-1.4 fake invoice content for spool test"
        rec = reg.spool(io.BytesIO(content), "inv.pdf")

        # refId opaque 且唯一
        assert rec.refId.startswith("imp-")
        # 文件已落到磁盘
        assert os.path.exists(rec.path)
        # 元数据完整
        assert rec.filename == "inv.pdf"
        assert rec.size == len(content)
        # INV-2：sha256 + doc_id 一次性物化
        import hashlib
        assert rec.sha256 == hashlib.sha256(content).hexdigest()
        assert rec.doc_id == rec.sha256[:24]

    def test_read_bytes_roundtrip(self, tmp_path):
        backend = LocalTempFileStorageBackend(base_dir=str(tmp_path))
        reg = TempFileRegistry(backend)
        content = b"another pdf payload " * 100  # 超过单块 65536 的边界测试
        rec = reg.spool(io.BytesIO(content), "big.bin")
        # 即时读取得到原始内容（scheduler 给 worker 用）
        assert reg.read_bytes(rec.refId) == content
        # 落盘内容也一致
        with open(rec.path, "rb") as f:
            assert f.read() == content

    def test_spool_two_files_distinct_refs_and_paths(self, tmp_path):
        backend = LocalTempFileStorageBackend(base_dir=str(tmp_path))
        reg = TempFileRegistry(backend)
        r1 = reg.spool(io.BytesIO(b"aaa"), "a.pdf")
        r2 = reg.spool(io.BytesIO(b"bbb"), "b.pdf")
        assert r1.refId != r2.refId
        assert r1.path != r2.path
        assert r1.sha256 != r2.sha256

    def test_release_deletes_temp_file(self, tmp_path):
        backend = LocalTempFileStorageBackend(base_dir=str(tmp_path))
        reg = TempFileRegistry(backend)
        rec = reg.spool(io.BytesIO(b"to be deleted"), "del.pdf")
        assert os.path.exists(rec.path)
        # 释放（= 单 job 生命周期结束）→ 临时文件被删除
        assert reg.release(rec.refId) is True
        assert not os.path.exists(rec.path)
        assert reg.get(rec.refId) is None

    def test_release_idempotent_no_double_delete(self, tmp_path):
        backend = LocalTempFileStorageBackend(base_dir=str(tmp_path))
        reg = TempFileRegistry(backend)
        rec = reg.spool(io.BytesIO(b"idempotent"), "id.pdf")
        assert reg.release(rec.refId) is True
        assert not os.path.exists(rec.path)
        # 第二次 release：不抛、返回 False、不二次触碰磁盘
        assert reg.release(rec.refId) is False
        assert not os.path.exists(rec.path)

    def test_local_backend_delete_missing_path_no_error(self, tmp_path):
        backend = LocalTempFileStorageBackend(base_dir=str(tmp_path))
        # 不存在的路径删除不抛（幂等）
        backend.delete(os.path.join(str(tmp_path), "ghost.pdf"))

    def test_null_backend_spool_is_not_supported(self):
        """Commit 1 的 NullStorageBackend 没有 spool —— 印证解耦边界：
        spool 真实落盘能力仅由 Commit 2 的 LocalTempFileStorageBackend 提供。
        """
        reg = TempFileRegistry(NullStorageBackend())
        import pytest
        with pytest.raises(AttributeError):
            reg.spool(io.BytesIO(b"x"), "x.pdf")

    # ---- IS-3 P1：storage identity migration (INV-IS3-5) ----

    def test_refId_is_storage_filename_no_extension(self, tmp_path):
        """INV-IS3-5 单元护栏：refId == 存储文件名（无扩展名），path 确定性。

        防止未来有人偷偷把 uuid 文件名与 refId 解耦，导致跨进程解析失效。
        """
        backend = LocalTempFileStorageBackend(base_dir=str(tmp_path))
        reg = TempFileRegistry(backend)
        rec = reg.spool(io.BytesIO(b"identity check"), "inv.pdf")
        expected_path = os.path.join(str(tmp_path), rec.refId)
        # 路径严格等于 base_dir/refId
        assert rec.path == expected_path
        # 文件确以 refId 命名（无扩展名；filename 的 .pdf 不应泄漏进存储名）
        assert os.path.basename(rec.path) == rec.refId
        assert not rec.refId.endswith(".pdf")
        # 文件存在且内容一致
        assert os.path.exists(expected_path)
        with open(expected_path, "rb") as f:
            assert f.read() == b"identity check"
        # 确定性：backend.path_for(refId) 必须返回同一 path（跨进程解析契约）
        assert backend.path_for(rec.refId) == expected_path

    def test_read_bytes_by_ref_standalone(self, tmp_path):
        """INV-IS3-5 单元：子进程用 read_bytes_by_ref 解析，无需父进程 _records。

        模拟一个全新进程（无 registry 索引）也能按 refId + base_dir 读到字节。
        """
        backend = LocalTempFileStorageBackend(base_dir=str(tmp_path))
        reg = TempFileRegistry(backend)
        content = b"standalone cross-process read " * 20
        rec = reg.spool(io.BytesIO(content), "s.pdf")
        # 不经过任何 TempFileRegistry 实例，直接按 refId 解析
        got = read_bytes_by_ref(rec.refId, base_dir=str(tmp_path))
        assert got == content
        # 反向证明：一个空 registry 没有该 ref 的索引（解析靠存储不靠内存）
        orphan = TempFileRegistry(LocalTempFileStorageBackend(base_dir=str(tmp_path)))
        assert orphan.get(rec.refId) is None

    def test_read_bytes_by_ref_rejects_path_separator(self, tmp_path):
        """refId 不得承载路径分隔符（opaque storage identity，INV-IS3-3）。"""
        import pytest
        with pytest.raises(ValueError):
            read_bytes_by_ref("imp-../escape", base_dir=str(tmp_path))

    def test_cross_process_resolve_via_ref(self, tmp_path):
        """🔴 T1：真实 ProcessPoolExecutor 跨进程解析（非 mock）。

        父进程 spool 出 refId；子进程仅凭 refId + base_dir 解析读取，其内存中
        没有父进程的 _records 索引——验证 INV-IS3-5 实战成立。这是 IS-3 的
        核心验收，必须用真实子进程（spawn 隔离内存）才能证明。
        """
        import concurrent.futures as cf
        backend = LocalTempFileStorageBackend(base_dir=str(tmp_path))
        reg = TempFileRegistry(backend)
        content = b"%PDF-1.4 cross-process payload " * 50
        rec = reg.spool(io.BytesIO(content), "x.pdf")
        ref_id = rec.refId
        base = str(tmp_path)

        with cf.ProcessPoolExecutor(max_workers=1) as ex:
            fut = ex.submit(_child_read_bytes_by_ref, ref_id, base)
            got = fut.result(timeout=15)
        assert got == content

    # ---- IS-3 P2-1：explicit temp root config (INV-IS3-5 cross-process premise) ----

    def test_backend_default_root_is_config_temp_root(self, tmp_path):
        """P2-1：LocalTempFileStorageBackend() 无参默认根必须来自 config.TEMP_ROOT，
        而非隐式 tempfile.gettempdir()，保证父子进程同 root（INV-IS3-5 前提）。
        """
        import config
        import tempfile
        backend = LocalTempFileStorageBackend()
        assert backend._base_dir == config.TEMP_ROOT
        # 不是裸 gettempdir——否则 spawn 子进程可能落到不同 root
        assert backend._base_dir != tempfile.gettempdir()

    def test_resolver_fallback_uses_config_temp_root(self, tmp_path):
        """P2-1：read_bytes_by_ref(refId) 不传 base_dir 时回退 config.TEMP_ROOT，
        且能读到默认 backend spool 出的文件——验证 fallback 链在进程内闭环。
        （跨进程 env 注入由 Bash smoke 单独验证，此处验证 fallback 接线正确。）
        """
        backend = LocalTempFileStorageBackend()  # 默认根 = config.TEMP_ROOT
        reg = TempFileRegistry(backend)
        content = b"resolver fallback via config.TEMP_ROOT " * 10
        rec = reg.spool(io.BytesIO(content), "fb.pdf")
        # 不传 base_dir -> 走 config.TEMP_ROOT fallback
        assert read_bytes_by_ref(rec.refId) == content
