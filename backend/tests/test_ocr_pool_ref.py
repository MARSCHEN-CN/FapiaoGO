"""IS-3 P2-2：ProcessPool ref adapter 验证。

核心验收：
  1. run_parse(ref_id) 在 worker 内按 refId 读回 bytes 并交给 parse_invoice_service
     （签名不变，INV-IS3-2），且 worker 收到的必须是 bytes 而非 ref_id。
  2. _run_parse_offthread(file_bytes) 提交到执行器时，跨进程 transport 只含 refId
     字符串，绝不包含原始 bytes（INV-IS3-3）；提交后父进程负责 release（INV-IS3-6）。

注：真实 ProcessPool 跨进程解析由 P1/P2-1 的 test_temp_file_registry 已覆盖
（read_bytes_by_ref 真实子进程）。本文件聚焦 adapter 接线与 transport 形态。
"""
import io

from temp_file_registry import TempFileRegistry, LocalTempFileStorageBackend
import ocr_pool_task


class _FakeExecutor:
    """捕获 submit 调用，不真正执行（避免触发真实 OCR / 进程池）。"""

    def __init__(self):
        self.submitted = []

    def submit(self, fn, *args, **kwargs):
        self.submitted.append((fn, args, kwargs))

        class _F:
            def result(self, timeout=None):
                return {"ok": True}

        return _F()


def test_run_parse_resolves_ref_to_bytes(monkeypatch, tmp_path):
    """run_parse(ref_id) 必须按 refId 读回原始 bytes（不是 ref 字符串）交给 service。"""
    import services.invoice_service as svc

    captured = {}

    def fake_parse(file_bytes, filename, auto_orient=True, force_ocr=False,
                   enable_auto_ocr=False, skip_db_write=False):
        captured['bytes'] = file_bytes
        captured['filename'] = filename
        return {'ok': True}

    monkeypatch.setattr(svc, 'parse_invoice_service', fake_parse)

    content = b"%PDF-1.4 worker resolve test payload " * 20
    reg = TempFileRegistry(LocalTempFileStorageBackend(base_dir=str(tmp_path)))
    rec = reg.spool(io.BytesIO(content), "x.pdf")

    res = ocr_pool_task.run_parse(rec.refId, "x.pdf", True, False)

    assert res == {'ok': True}
    # worker 必须把 refId 解析成原始 bytes 再交给 service（INV-IS3-5）
    assert captured['bytes'] == content
    assert captured['filename'] == "x.pdf"


def test_run_parse_offthread_submits_ref_not_bytes(monkeypatch):
    """_run_parse_offthread 跨进程 transport 只含 refId 字符串，绝不含原始 bytes；
    父进程在 finally 中 release（INV-IS3-3 / INV-IS3-6）。"""
    import app as backend_app

    fake = _FakeExecutor()
    monkeypatch.setattr(backend_app, '_get_executor', lambda: fake)

    payload = b"%PDF-1.4 fake transport payload for offthread test " * 5
    backend_app._run_parse_offthread(payload, "t.pdf", True, False)

    assert len(fake.submitted) == 1
    fn, args, kwargs = fake.submitted[0]
    # 提交给执行器的是 run_parse
    assert fn is ocr_pool_task.run_parse
    ref_id = args[0]
    # transport 仅含 opaque refId 字符串
    assert isinstance(ref_id, str) and ref_id.startswith("imp-")
    assert ref_id != payload
    assert payload not in args, "原始 bytes 不应被 pickle 进执行器（INV-IS3-3）"
    # 父进程负责释放 temp 文件（worker 不持有 lifecycle）
    assert backend_app._import_temp_registry.active_refs() == [], \
        "提交后父进程必须已 release ref（INV-IS3-6）"
