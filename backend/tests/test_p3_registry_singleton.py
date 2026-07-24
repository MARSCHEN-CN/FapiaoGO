"""IS-3 P3-A：TempFileRegistry 跨端点单例（R1 blocker 修复验证）。

T7：get_temp_registry() 返回同一对象；/parse_invoice 与 /import/batch 共用同一实例
（INV-IS3-6 lifecycle mutation owner 唯一）。

本文件刻意只依赖 temp_file_registry + import_batch_manager（不 import app/Flask），
以便轻量验证单例接线；跨端点同一对象的端到端断言见 test_p3_parse_invoice_migration。
"""
import io
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from temp_file_registry import get_temp_registry  # noqa: E402
from import_batch_manager import get_import_batch_manager  # noqa: E402


def test_get_temp_registry_is_singleton():
    """单例：两次调用返回同一对象。"""
    a = get_temp_registry()
    b = get_temp_registry()
    assert a is b


def test_import_batch_manager_uses_singleton():
    """/import/batch 的管理器持有的 registry 必须是同一单例。"""
    mgr = get_import_batch_manager()
    assert mgr.temp_file_registry is get_temp_registry()


def test_shared_lifecycle_spool_release_closes_on_same_records():
    """🔴 R1 核心：一端 spool、另一端 release 必须命中同一 _records，否则 orphan。

    修复前：import_batch_manager 与 app 各 new 一个实例，此处 mgr.temp_file_registry
    与 singleton 不是同一对象，release 会返回 False 且文件残留。修复后：两者都是
    get_temp_registry() 单例，release 命中并删除文件。
    """
    reg = get_temp_registry()
    mgr = get_import_batch_manager()

    rec = mgr.temp_file_registry.spool(io.BytesIO(b"shared lifecycle check payload"), "x.pdf")
    # 用 singleton 直接 release（模拟另一端释放）——必须找到记录并删除
    assert reg.release(rec.refId) is True
    assert reg.get(rec.refId) is None
