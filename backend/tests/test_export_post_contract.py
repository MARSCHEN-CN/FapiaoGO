"""Phase 3.1.3-C 架构契约测试（已入库，与 lifecycle/stream 同级别）。

锁死 POST /api/export-pdf → 返回 {taskId} 且不阻塞，
以及 GET /api/export-pdf/events/<taskId> 能接管同一任务观察终态。

通过 Flask test client 跑真实路由，验证「UI → POST 建任务 → GET 观察」的
端到端契约，不依赖任何 UI。状态唯一来源是 ExportTask.to_dict()。

关键原则（与 B 一致）：SSE 只读 TaskRegistry，不调用 Service / Handler / task.* 状态变更。
"""

import base64
import json
import time

import pytest

from services.pdf_handlers.base import PdfExportHandler

# 复用真实 app（含已提交的 C 形态路由）
import app as backend_app


# ── 可控 Handler / Resolver（绕过真实格式检测与 fitz） ──

class _FakeHandler(PdfExportHandler):
    def __init__(self, sleep=0.0, raise_on_export=False):
        self._sleep = sleep
        self._raise = raise_on_export

    def can_handle(self, file_format, details=None):
        return True

    def export_to_pdf(self, source, output_path, **kwargs):
        if self._sleep:
            time.sleep(self._sleep)
        if self._raise:
            raise RuntimeError("fake handler boom")
        with open(output_path, 'wb') as fh:
            fh.write(b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF")
        return {'pages': 1, 'sha256': 'x', 'size': 48, 'warnings': []}


class _ConstResolver:
    """始终返回同一个 fake handler（绕过格式检测）。"""

    def __init__(self, handler):
        self._handler = handler

    def resolve(self, file_bytes, filename):
        return self._handler


def _dummy_b64():
    return base64.b64encode(b"dummy-source-bytes").decode('ascii')


def _make_body(n=1, mode='single', sleep=0.0, raise_on_export=False):
    handler = _FakeHandler(sleep=sleep, raise_on_export=raise_on_export)
    items = []
    for i in range(n):
        items.append({
            'name': f'inv_{i}.pdf',
            'data': _dummy_b64(),
            'outputPath': f'/tmp/export_post_contract_{i}_{time.time_ns()}.pdf',
        })
    body = {'mode': mode, 'files': items}
    if mode == 'merge':
        body['outputPath'] = f'/tmp/export_post_contract_merge_{time.time_ns()}.pdf'
    return body, handler


def _parse_sse(text):
    out = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith('data:'):
            payload = line[5:].strip()
            if payload:
                out.append(json.loads(payload))
    return out


@pytest.fixture
def client():
    backend_app.app.config['TESTING'] = True
    with backend_app.app.test_client() as c:
        yield c


@pytest.fixture
def fake_resolver(monkeypatch):
    """默认用瞬时 fake handler 替换 service resolver。"""
    handler = _FakeHandler()
    monkeypatch.setattr(backend_app._export_pdf_service, 'resolver', _ConstResolver(handler))
    return handler


# ── 契约 1：POST 创建任务并返回 taskId ──
def test_post_creates_task_returns_task_id(client, fake_resolver):
    body, _ = _make_body(n=2)
    resp = client.post('/api/export-pdf', json=body)
    assert resp.status_code == 200
    data = resp.get_json()
    assert data.get('success') is True
    task_id = data.get('taskId')
    assert task_id
    task = backend_app.task_registry.get(task_id)
    assert task is not None


# ── 契约 2：POST 不阻塞（慢 handler 应 < 1s 返回） ──
def test_post_returns_before_export_completes(client, monkeypatch):
    slow = _FakeHandler(sleep=2.0)
    monkeypatch.setattr(backend_app._export_pdf_service, 'resolver', _ConstResolver(slow))
    body, _ = _make_body(n=1)
    start = time.time()
    resp = client.post('/api/export-pdf', json=body)
    elapsed = time.time() - start
    assert resp.status_code == 200
    assert elapsed < 1.0, f"POST 阻塞了 {elapsed:.2f}s（应 < 1s 立即返回 taskId）"
    # 任务此时应仍在运行/排队，尚未进入终态
    task = backend_app.task_registry.get(resp.get_json()['taskId'])
    assert task.status.value in ('pending', 'running')


# ── 契约 3：SSE 可接管同一任务并观察到 completed ──
def test_sse_takes_over_same_task(client, fake_resolver):
    body, _ = _make_body(n=3)
    resp = client.post('/api/export-pdf', json=body)
    task_id = resp.get_json()['taskId']
    sse = client.get(f'/api/export-pdf/events/{task_id}')
    events = _parse_sse(sse.get_data(as_text=True))
    assert events, "SSE 未产生任何事件"
    statuses = [e['status'] for e in events]
    assert statuses[-1] == 'completed', f"终态应为 completed，实为 {statuses[-1]}"
    assert events[-1]['taskId'] == task_id
    # 进度应被推进到 total
    assert events[-1]['current'] == events[-1]['total'] == 3


# ── 契约 4：cancel 生命周期 → cancelled ──
def test_cancel_marks_task_cancelled(client, monkeypatch):
    slow = _FakeHandler(sleep=1.0)
    monkeypatch.setattr(backend_app._export_pdf_service, 'resolver', _ConstResolver(slow))
    body, _ = _make_body(n=2)
    resp = client.post('/api/export-pdf', json=body)
    task_id = resp.get_json()['taskId']
    cancel = client.post('/api/export-pdf/cancel', json={'taskId': task_id})
    assert cancel.get_json().get('success') is True
    sse = client.get(f'/api/export-pdf/events/{task_id}')
    events = _parse_sse(sse.get_data(as_text=True))
    assert events[-1]['status'] == 'cancelled'


# ── 契约 5：Service 异常 → failed ──
def test_service_exception_marks_failed(client, monkeypatch):
    class _RaisingResolver:
        def resolve(self, file_bytes, filename):
            raise RuntimeError("resolver boom")

    monkeypatch.setattr(backend_app._export_pdf_service, 'resolver', _RaisingResolver())
    body, _ = _make_body(n=1)
    resp = client.post('/api/export-pdf', json=body)
    task_id = resp.get_json()['taskId']
    sse = client.get(f'/api/export-pdf/events/{task_id}')
    events = _parse_sse(sse.get_data(as_text=True))
    assert events[-1]['status'] == 'failed'


# ── 路由契约：未知 task → 404 ──
def test_sse_unknown_task_returns_404(client):
    resp = client.get('/api/export-pdf/events/does-not-exist')
    assert resp.status_code == 404


# ── 路由契约：缺 files 参数 → 400 ──
def test_post_missing_files_returns_400(client, fake_resolver):
    resp = client.post('/api/export-pdf', json={'mode': 'single'})
    assert resp.status_code == 400
