# -*- coding: utf-8 -*-
"""P1-3 Commit A 回归测试：parse_batch 收敛到已有 OCR 进程池。

范围（与 Design Audit 冻结点一致，不扩大）：
  - 仅验证 /parse_batch 的 _parse_one 改走 _run_parse_offthread()（即复用单文件
    /parse_invoice 已有的 ProcessPoolExecutor + OCR_WORKERS 并行度），不再在 batch
    线程内 GIL 受限地直接跑 OCR。
  - 不碰 _get_executor 生命周期（全局单例、懒加载、OCR 子进程常驻）。
  - 不碰 frontend / F5 / Thumbnail / engine.py:477 flush / parse_job_manager / render_engine。

关键验收（用户硬验收）：
  [硬验收 1] executor 类型必须是 ProcessPoolExecutor，且任务确实跑在子进程
             （pid != 主进程）。因为现有回退链 ProcessPool->ThreadPool->sync 会让
             "功能成功" 掩盖 "优化没生效"，所以必须直接断言进程池真生效。
  [硬验收 2] /parse_invoice 与 /parse_batch 对同一个文件调用 _run_parse_offthread
             的参数签名一致 -> 两条路径收敛到同一解析实现（batch vs single 行为一致）。
  [pickle]   进程池返回结构必须可 pickle（无 numpy/PIL/fitz.Page/logger/exception
             等不可跨进程对象）。已由生产单文件路径证明，本测试用真实 OCR 结果再验一次。

注意：
  /parse_invoice 端点使用 render_engine.registry._make_doc_id（模块级函数，content-hash
  生成 doc_id）以与 /split_pdf、/preview/{doc_id} 共用同一身份链。该端点曾误调用
  registry._make_doc_id（实例方法不存在）导致全程 500，已在 fix(backend) 中修复。
  本测试验证单文件 / 批量路径收敛到同一 _run_parse_offthread 签名。
"""

import io
import json
import os
import pickle

import fitz
import pytest
from unittest import mock

import app as backend_app
from concurrent.futures import ProcessPoolExecutor


# ── 工具 ──

def _make_pdf():
    """生成单页 PDF，含少量可读文本，供解析使用（无需真实 OCR 模型）。"""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((50, 50), "test invoice hello world 123456")
    data = doc.tobytes()
    doc.close()
    return data


def _probe_subprocess_pid():
    """提交到进程池的任务：返回子进程 PID，用于证明『真在子进程执行』。"""
    import os as _os
    return _os.getpid()


def _canned_svc_result():
    """模拟 parse_invoice_service 的返回（db_record=None 以跳过入库，避免触碰 DB）。"""
    return {
        "db_record": None,
        "invoice_type": "增值税电子普通发票",
        "invoice_number": "P1-3-NO-001",
        "amount": "88.88",
        "invoice_date": "2026-07-22",
        "safe_filename": "safe.pdf",
        "parse_method": "ocr",
        "file_format": "pdf",
        "preview_image": "",
        "extra_fields": {"failed_fields": []},
        "from_cache": False,
        "bbox_data": [],
        "raw_text": "test invoice hello world 123456",
    }


def _parse_sse_final(body):
    """从 SSE 响应体提取最终的 data: JSON（含 items 的那条）。"""
    final = None
    for chunk in body.split("\n\n"):
        chunk = chunk.strip()
        if not chunk.startswith("data:"):
            continue
        payload = chunk[len("data:"):].strip()
        try:
            obj = json.loads(payload)
        except ValueError:
            continue
        if "items" in obj:
            final = obj
    return final


@pytest.fixture
def client():
    backend_app.app.config["TESTING"] = True
    with backend_app.app.test_client() as c:
        yield c


# ── [硬验收 1] executor 类型 + 真子进程 ──

def test_ocr_executor_is_real_processpool():
    """_get_executor() 必须返回 ProcessPoolExecutor，且任务跑在子进程（非线程回退）。"""
    ex = backend_app._get_executor()
    assert ex is not None, "OCR 执行器不可用（回退到 sync），P1-3 优化无法生效"
    assert isinstance(ex, ProcessPoolExecutor), (
        f"OCR 执行器不是 ProcessPoolExecutor（实际 {type(ex).__name__}），"
        f"说明已回退到 ThreadPool/sync —— 优化未生效，需排查 Windows spawn"
    )
    assert backend_app._ocr_executor_kind == "process", (
        f"_ocr_executor_kind={backend_app._ocr_executor_kind!r}，"
        f"应有 'process'；回退会掩盖 GIL 问题"
    )
    # 关键：提交一个任务，确认它确实在『不同 PID』的子进程执行
    fut = ex.submit(_probe_subprocess_pid)
    child_pid = fut.result(timeout=60)
    assert child_pid != os.getpid(), (
        f"任务在主进程(pid={os.getpid()})执行，未真正进入子进程 —— "
        f"ProcessPool 未生效（可能被静默回退）"
    )


# ── [pickle] 真实结果可跨进程 ──

def test_parse_result_picklable_roundtrip():
    """真实 _run_parse_offthread 返回 dict，且 pickle 往返相等（无不可跨进程对象）。"""
    pdf_bytes = _make_pdf()
    res = backend_app._run_parse_offthread(pdf_bytes, "probe.pdf", True, False)
    assert isinstance(res, dict), f"预期 dict，实际 {type(res)!r}"
    # 关键：进程池返回必然经过 pickle，能 round-trip 才证明无 numpy/PIL/fitz/logger/exception
    restored = pickle.loads(pickle.dumps(res))
    assert restored == res, "进程池返回结构 pickle 往返后不等（含不可序列化对象）"


# ── [接线验证] batch 改走 _run_parse_offthread，响应结构正确 ──

def test_parse_batch_routes_through_offthread(client):
    """POST /parse_batch：_parse_one 必须调用 _run_parse_offthread，且响应携带其返回数据。

    注意：/parse_batch 的解析跑在守护线程 run_batch 中，client.post 返回时线程仍在跑。
    必须在 mock 生效期内消费完整 SSE 流（resp.data），迫使后台线程在 mock 拆除前完成，
    否则会落到真实 OCR 路径、mock 不生效。
    """
    pdf_bytes = _make_pdf()
    canned = _canned_svc_result()

    with mock.patch.object(backend_app, "_run_parse_offthread",
                            return_value=canned) as m:
        resp = client.post(
            "/parse_batch",
            data={
                "files": (io.BytesIO(pdf_bytes), "test.pdf"),
                "autoOrient": "1",
                "enableAutoOcr": "0",
            },
            content_type="multipart/form-data",
        )
        assert resp.status_code == 200, f"状态码异常: {resp.status_code}"
        # 消费完整 SSE 流 -> 后台线程在 mock 生效期内完成
        body = resp.data.decode("utf-8")

        # 断言 batch 调用了进程池入口，且参数与单文件路径一致
        assert m.called, "/parse_batch 未调用 _run_parse_offthread（可能仍直接调 service）"
        args = m.call_args
        assert args.args[0] == pdf_bytes, "第 1 参应为文件 bytes"
        assert args.args[1] == "test.pdf", "第 2 参应为 filename"
        assert args.args[2] is True, "第 3 参 auto_orient 应为 True"
        assert args.args[3] is False, "第 4 参 enable_auto_ocr 应为 False"

        # 断言响应由 _run_parse_offthread 的返回值正确构建
        final = _parse_sse_final(body)
        assert final is not None and final.get("success") is True, "SSE 未携带成功结果"
        items = final["items"]
        assert len(items) == 1, "应返回 1 个文件的结果"
        data = items[0].get("data", {})
        assert data.get("invoice_type") == canned["invoice_type"]
        assert data.get("invoice_number") == canned["invoice_number"]
        assert data.get("amount") == canned["amount"]


# ── [硬验收 2] 单文件 / 批量 收敛到同一解析路径（参数签名一致） ──

def test_single_and_batch_share_offthread_signature(client):
    """/parse_invoice 与 /parse_batch 对同一文件调用 _run_parse_offthread 的参数签名一致。"""
    pdf_bytes = _make_pdf()
    canned = _canned_svc_result()

    # 单文件路径：验证单端点确实走 _run_parse_offthread（真实 doc_id 计算）
    with mock.patch.object(backend_app, "_run_parse_offthread",
                           return_value=canned) as m_single:
        r1 = client.post(
            "/parse_invoice",
            data={
                "file": (io.BytesIO(pdf_bytes), "test.pdf"),
                "autoOrient": "1",
                "enableAutoOcr": "0",
            },
            content_type="multipart/form-data",
        )
        assert r1.status_code == 200, f"/parse_invoice 状态码异常: {r1.status_code}"
        assert m_single.called, "/parse_invoice 未调用 _run_parse_offthread"
        single_args = m_single.call_args.args

    # 批量路径（守护线程，须在 mock 生效期内消费流）
    with mock.patch.object(backend_app, "_run_parse_offthread",
                            return_value=canned) as m_batch:
        r2 = client.post(
            "/parse_batch",
            data={
                "files": (io.BytesIO(pdf_bytes), "test.pdf"),
                "autoOrient": "1",
                "enableAutoOcr": "0",
            },
            content_type="multipart/form-data",
        )
        assert r2.status_code == 200, f"/parse_batch 状态码异常: {r2.status_code}"
        _ = r2.data.decode("utf-8")  # 消费流 -> 后台线程完成
        assert m_batch.called, "/parse_batch 未调用 _run_parse_offthread"
        batch_args = m_batch.call_args.args

    # 两条路径参数签名一致 -> 同一解析实现 -> batch vs single 行为一致
    assert single_args == batch_args, (
        f"单文件与批量路径参数不一致：single={single_args} batch={batch_args}"
    )
    assert single_args == (pdf_bytes, "test.pdf", True, False)


# ── P1-3-b: 执行器类型可观测性（契约测试，不测日志文本） ──

def test_get_executor_kind_reflects_singleton(monkeypatch):
    """_get_executor_kind() 应如实反映全局执行器单例类型（可观测性核心）。

    不依赖真实进程池（避免测试内 spawn 进程），用假对象验证 helper 仅做类型名映射。
    """
    class _FakeEx:
        pass

    monkeypatch.setattr(backend_app, "_ocr_executor", None)
    assert backend_app._get_executor_kind() == "none"

    monkeypatch.setattr(backend_app, "_ocr_executor", _FakeEx())
    assert backend_app._get_executor_kind() == "_FakeEx"


def test_parse_batch_routes_through_injected_executor(client, monkeypatch):
    """契约：batch 必须使用 _get_executor() 返回的执行器（可被注入/观测）。

    注入一个假 executor，断言 /parse_batch 把解析任务提交到该 executor —— 证明
    batch OCR 并发模型由 _get_executor() 单例决定（即 P1-3-a 的复用契约），且 P1-3-b
    的可观测性点就是『同一个单例』。不断言日志文本（日志格式未来可改，测文本会脆弱）。
    """
    class FakeExecutor:
        def __init__(self):
            self.submitted = []  # 记录 (fn, args)

        def submit(self, fn, *args, **kwargs):
            import concurrent.futures as _cf
            fut = _cf.Future()
            fut.set_result(_canned_svc_result())
            self.submitted.append((fn, args))
            return fut

    fake = FakeExecutor()
    # 注入：让 _get_executor() 返回假 executor（不创建真实进程池）
    monkeypatch.setattr(backend_app, "_get_executor", lambda: fake)

    pdf_bytes = _make_pdf()
    resp = client.post(
        "/parse_batch",
        data={
            "files": (io.BytesIO(pdf_bytes), "test.pdf"),
            "autoOrient": "1",
            "enableAutoOcr": "0",
        },
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200, f"状态码异常: {resp.status_code}"
    # 消费完整 SSE 流 -> 后台 run_batch 线程在 monkeypatch 生效期内完成
    body = resp.data.decode("utf-8")

    # 契约：batch 确实把解析任务提交到了注入的 executor（即 _get_executor 返回的那个）
    assert len(fake.submitted) == 1, (
        f"batch 未通过注入的 executor 提交任务（submitted={len(fake.submitted)}）"
    )
    # 提交的函数应是 ocr_pool_task.run_parse（与单文件路径一致）
    submitted_fn = fake.submitted[0][0]
    import ocr_pool_task
    assert submitted_fn is ocr_pool_task.run_parse, (
        f"batch 提交的函数不是 ocr_pool_task.run_parse（实际 {submitted_fn!r}）"
    )
    # 响应由注入 executor 的返回正确构建
    final = _parse_sse_final(body)
    assert final is not None and final.get("success") is True, "SSE 未携带成功结果"
    items = final["items"]
    assert len(items) == 1
    assert items[0].get("data", {}).get("invoice_number") == \
        _canned_svc_result()["invoice_number"]
