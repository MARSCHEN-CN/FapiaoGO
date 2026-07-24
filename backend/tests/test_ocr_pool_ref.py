"""IS-3 P2-2 / P4：ProcessPool ref adapter 验证（worker 侧）。

核心验收：
  run_parse(ref_id) 在 worker 内按 refId 读回 bytes 并交给 parse_invoice_service
  （签名不变，INV-IS3-2），且 worker 收到的必须是 bytes 而非 ref_id。

注：真实 ProcessPool 跨进程解析由 P1/P2-1 的 test_temp_file_registry 已覆盖
（read_bytes_by_ref 真实子进程）。本文件聚焦 worker 端 ref→bytes 解析正确性。
P4 退役 /parse_batch 后，原 _run_parse_offthread(file_bytes) 的 transport 形态验收
已由 _run_parse_ref_offthread + run_parse(ref_id) 隐式覆盖（transport 仅含 refId）。
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


