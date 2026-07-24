"""IS-3 P3-B：/parse_invoice 迁移验收（T8 parity）。

验证：
  1. 上传流直接 spool 为 opaque ref，exec 边界只传 refId（不传 bytes，INV-IS3-3）；
  2. 路由 finally 释放 ref（active_refs 清空，INV-IS3-6）；
  3. doc_id 与 _make_doc_id(content) 一致（response JSON 不变的前提）；
  4. response JSON 形状与迁移前一致（build_response 入参不变）；
  5. 跨端点单例：app 的 registry 即 import_batch_manager 的 registry（T7 联动）。

运行（需完整后端依赖 / venv）：
    backend/venv/Scripts/python -m pytest tests/test_p3_parse_invoice_migration.py -q
"""
import io
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import pytest  # noqa: E402


@pytest.fixture
def client(monkeypatch):
    import app as backend_app

    captured = {}

    class _FakeExecutor:
        def __init__(self):
            self.submitted = []

        def submit(self, fn, *args, **kwargs):
            self.submitted.append((fn, args, kwargs))

            class _F:
                def result(self, timeout=None):
                    # 模拟 worker 返回（build_response 后续会用到这些键）
                    return {
                        'file_format': 'pdf',
                        'parse_method': 'ocr',
                        'invoice_type': '专票',
                        'invoice_number': 'NO123',
                        'amount': '100.00',
                        'invoice_date': '2026-01-01',
                        'extra_fields': {},
                        'preview_image': None,
                        'raw_text': 'raw',
                        'bbox_data': [],
                        'from_cache': False,
                        'safe_filename': 'x.pdf',
                        'db_record': {'id': 'rec1'},
                    }

            return _F()

    fx = _FakeExecutor()
    captured['executor'] = fx
    monkeypatch.setattr(backend_app, '_get_executor', lambda: fx)
    # 防止真实 DB 写入（route 内 db_module.upsert_invoice(db_record)）
    class _DB:
        def upsert_invoice(self, *a, **k):
            return None

    monkeypatch.setattr(backend_app, 'db_module', _DB())

    backend_app.app.config['TESTING'] = True
    with backend_app.app.test_client() as c:
        yield c, backend_app, captured


def test_parse_invoice_submits_ref_not_bytes_and_releases(client):
    c, backend_app, captured = client
    content = b"%PDF-1.4 migration parity payload for T8 " * 30

    resp = c.post(
        '/parse_invoice',
        data={'file': (io.BytesIO(content), 'x.pdf'),
              'autoOrient': '1', 'enableAutoOcr': '0', 'mode': 'detail'},
        content_type='multipart/form-data',
    )

    assert resp.status_code == 200
    body = resp.get_json()
    assert body['success'] is True

    # doc_id parity：response 透出的 doc_id 必须等于 _make_doc_id(content)
    from render_engine.registry import _make_doc_id
    assert body['doc_id'] == _make_doc_id(content, 'x.pdf')

    # transport 只含 refId（字符串），绝不含原始 bytes（INV-IS3-3）
    fx = captured['executor']
    assert len(fx.submitted) == 1
    fn, args, kwargs = fx.submitted[0]
    assert fn is backend_app.ocr_pool_task.run_parse
    ref_id = args[0]
    assert isinstance(ref_id, str) and ref_id.startswith('imp-')
    assert ref_id != content
    assert content not in args, "原始 bytes 不应被 pickle 进执行器（INV-IS3-3）"

    # 路由 finally 已释放 ref（INV-IS3-6）：singleton 无 active ref
    assert backend_app._import_temp_registry.active_refs() == []

    # 跨端点单例：app 的 registry 即 import_batch_manager 的 registry（T7 联动）
    from import_batch_manager import get_import_batch_manager
    assert backend_app._import_temp_registry is get_import_batch_manager().temp_file_registry
