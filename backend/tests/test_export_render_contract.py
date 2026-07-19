"""D3-3a 架构契约测试：POST /api/export-render → {taskId} 不阻塞 + 校验 + SSE 终态。

锁死三件事（D3-3a boundary freeze）：
  1. schema valid → 200 + taskId（前端 RenderCommand 形状：sourceRef/paper/placement/
     rotatedBounds/clip/contentRotation/rotation/version）
  2. schema invalid（sourceRef:null / paper 是 PaperLayout）→ 400
  3. executor 路径（app.py export-render section + schema 模块）禁止后端 fit：
     _apply_margins / calculateFit / fit_scale 不得出现。

通过 Flask test client 跑真实路由，状态唯一来源是 ExportTask.to_dict()。
"""

import json
import os
import re
import tempfile
import time

import fitz
import pytest

# 复用真实 app（含 D3-3a 新增路由 + D3-3b-3 真实执行器）
import app as backend_app

_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# D3-3b-3 起 _run_export_render_task 真正读源、生成 PDF。契约测试的 sourceRef
# 必须指向一个真实存在的图片，否则任务会 fail（不再是 no-op skeleton）。
# 这里用 fitz 造一张真实的 PNG 作为 fixture（与导出源同构）。
_PNG_FIXTURE = None


def _real_png_path():
    global _PNG_FIXTURE
    if _PNG_FIXTURE is None:
        doc = fitz.open()
        doc.new_page(width=200, height=280)
        doc[0].draw_rect(fitz.Rect(0, 0, 200, 280), color=(1, 0, 0), fill=(1, 0, 0))
        fd, path = tempfile.mkstemp(suffix='.png')
        with os.fdopen(fd, 'wb') as fh:
            fh.write(doc[0].get_pixmap().tobytes('png'))
        doc.close()
        _PNG_FIXTURE = path
    return _PNG_FIXTURE


def _valid_command(idx=0):
    """构造一个完全合规的 RenderCommand（几何来自前端 producer，后端只消费）。

    sourceRef 指向一张真实存在的 PNG（D3-3b-3 真实执行器会读取并绘制）。
    """
    return {
        "version": 1,
        "sourceRef": {"path": _real_png_path(), "page": 0},
        "paper": {"widthMm": 210.0, "heightMm": 297.0, "dpi": 300},
        "placement": {"scale": 0.5, "offsetX": 10.0, "offsetY": 20.0},
        "rotatedBounds": {"width": 1000, "height": 1414},
        "contentRotation": 0,
        "rotation": 0,
        "clip": {"x": 0, "y": 0, "width": 1000, "height": 1414},
    }


def _valid_body(n=1):
    return {"commands": [_valid_command(i) for i in range(n)]}


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


# ── 契约 1：schema valid → 200 + taskId ──
def test_post_valid_commands_returns_task_id(client):
    resp = client.post('/api/export-render', json=_valid_body(n=2))
    assert resp.status_code == 200
    data = resp.get_json()
    assert data.get('success') is True
    task_id = data.get('taskId')
    assert task_id
    assert backend_app.task_registry.get(task_id) is not None


# ── 契约 2：sourceRef 为 null → 400（D3-3-0 核心阻塞：资源绑定） ──
def test_post_source_ref_null_rejected(client):
    body = _valid_body(n=1)
    body['commands'][0]['sourceRef'] = None
    resp = client.post('/api/export-render', json=body)
    assert resp.status_code == 400
    assert 'sourceRef' in resp.get_json().get('error', '')


# ── 契约 3：sourceRef 缺 path → 400 ──
def test_post_source_ref_missing_path_rejected(client):
    body = _valid_body(n=1)
    body['commands'][0]['sourceRef'] = {"page": 0}
    resp = client.post('/api/export-render', json=body)
    assert resp.status_code == 400


# ── 契约 4：paper 是 PaperLayout（含 marginRect）→ 400 ──
def test_post_paper_layout_forbidden(client):
    body = _valid_body(n=1)
    body['commands'][0]['paper'] = {
        "widthMm": 210.0, "heightMm": 297.0, "dpi": 300,
        "marginRect": {"x": 10, "y": 10, "width": 190, "height": 277},  # Preview-only
    }
    resp = client.post('/api/export-render', json=body)
    assert resp.status_code == 400
    assert 'PaperLayout' in resp.get_json().get('error', '')


# ── 契约 5：缺 commands / 空 commands → 400 ──
def test_post_missing_commands_400(client):
    resp = client.post('/api/export-render', json={})
    assert resp.status_code == 400


def test_post_empty_commands_400(client):
    resp = client.post('/api/export-render', json={"commands": []})
    assert resp.status_code == 400


# ── 契约 6：SSE 接管同一任务并观察到 completed ──
def test_sse_reaches_completed_for_valid(client):
    resp = client.post('/api/export-render', json=_valid_body(n=3))
    task_id = resp.get_json()['taskId']
    sse = client.get(f'/api/export-render/events/{task_id}')
    events = _parse_sse(sse.get_data(as_text=True))
    assert events, "SSE 未产生任何事件"
    assert events[-1]['status'] == 'completed', events[-1]
    assert events[-1]['taskId'] == task_id
    assert events[-1]['current'] == events[-1]['total'] == 3


# ── 契约 6b：D3-3b-3 真实 PDF 产出（source → executor → PDF writer 闭环）──
def test_export_render_produces_real_pdf(client):
    """D3-3b-3 验收 1+2：任务完成后磁盘上真的有 PDF，且页尺寸 == paper_px。

    这是 D3-3 真正闭环点的端到端证据：不再只是 task.complete，而是
    output.pdf 存在且页尺寸与前端 paper_px 同构（A4@300dpi -> 2480x3508）。
    """
    resp = client.post('/api/export-render', json=_valid_body(n=1))
    task_id = resp.get_json()['taskId']
    sse = client.get(f'/api/export-render/events/{task_id}')
    events = _parse_sse(sse.get_data(as_text=True))
    assert events[-1]['status'] == 'completed', events[-1]

    out_path = os.path.join(tempfile.gettempdir(), f'export-render-{task_id}.pdf')
    assert os.path.isfile(out_path), "D3-3b-3 未生成真实 PDF（闭环断裂）"
    doc = fitz.open(out_path)
    try:
        assert len(doc) == 1
        assert (int(doc[0].rect.width), int(doc[0].rect.height)) == (2480, 3508)
    finally:
        doc.close()


# ── 契约 7：未知 task → 404 ──
def test_sse_unknown_task_returns_404(client):
    resp = client.get('/api/export-render/events/does-not-exist')
    assert resp.status_code == 404


# ── 契约 8：POST 不阻塞（立即返回 taskId） ──
def test_post_returns_before_execution(client):
    start = time.time()
    resp = client.post('/api/export-render', json=_valid_body(n=1))
    elapsed = time.time() - start
    assert resp.status_code == 200
    assert elapsed < 1.0, f"POST 阻塞了 {elapsed:.2f}s（应 < 1s 立即返回 taskId）"


# ── 契约 9：executor 路径禁止后端 fit（静态 grep 锁） ──
def _strip_comments_and_docstrings(src):
    """去掉 triple-quoted docstring 与 # 行注释，仅保留可执行代码用于扫描。

    禁令针对实现代码（后端不得重算 fit），文档字符串中提及被禁符号作为
    契约说明是允许的 —— 故扫描前剥离注释/docstring 避免误报。
    """
    src = re.sub(r'""".*?"""', '', src, flags=re.DOTALL)
    src = re.sub(r"'''.*?'''", '', src, flags=re.DOTALL)
    src = re.sub(r'#[^\n]*', '', src)
    return src


def test_executor_path_has_no_backend_fit():
    """D3-3a 边界铁律：后端绝不重算 fit/scale/center。

    扫描 schema 模块与 app.py 的可执行代码，确认 _apply_margins / calculateFit /
    fit_scale 不进入 export-render 执行路径（docstring 中的说明性提及被剥离）。
    """
    forbidden = ('_apply_margins', 'calculateFit', 'fit_scale')
    targets = [
        os.path.join(_BACKEND_ROOT, 'services', 'export_render_schema.py'),
        os.path.join(_BACKEND_ROOT, 'services', 'export_render_service.py'),
        os.path.join(_BACKEND_ROOT, 'app.py'),
    ]
    for path in targets:
        with open(path, 'r', encoding='utf-8') as fh:
            src = _strip_comments_and_docstrings(fh.read())
        for tok in forbidden:
            assert tok not in src, (
                f"后端 fit 符号 '{tok}' 出现在 {path} 的可执行代码 —— "
                f"违反 D3-3a 边界（几何所有权在前端 RenderCommand）"
            )
