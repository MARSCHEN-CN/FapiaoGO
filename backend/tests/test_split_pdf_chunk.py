# -*- coding: utf-8 -*-
"""Commit 2 回归测试：split_pdf page task -> chunk task 优化。

锁定三件事（B2 设计约束）：
  1. fitz.open(stream=file_bytes) 次数 = 1（registry 常驻句柄）+ min(页数, 8)（chunk 级）。
     registry 的 1 次在旧实现中也存在、与本优化无关；本优化把「每页 1 次」降到
     「每 chunk 1 次」，故大页 PDF 总 open 数严格小于旧的 1 + 页数。
  2. pages[] 文档顺序完全一致：page_index 严格升序、page_id = f"{file_hash}_{i}"
     、且每个输出页内容与其源页一一对应（防 chunk flatten 错位）。
  3. 异常语义保持：单页失败 -> 整体 500（route 外层 try/except 保证，本测试验证正常路径）。

注意：PyMuPDF 提取的单页 PDF 含非确定元数据（如 /ID、时间戳），故「原始 page_bytes
字节」跨 run 不可比；一致性校验用「解码后文本」比对源页，这才是 chunk flatten 顺序
是否错位的真实判据。preview（JPEG 栅格，参数固定）是确定的，可做逐页字节 golden 比对。
"""

import base64
import hashlib
import io

import fitz
import pytest

import app as backend_app

SPLIT_MAX_WORKERS = 8


@pytest.fixture
def client():
    backend_app.app.config["TESTING"] = True
    with backend_app.app.test_client() as c:
        yield c


def _make_pdf(n_pages):
    """生成 n 页 PDF，每页带 ASCII 标记 PAGE_MARKER_{i}，便于内容校验。"""
    doc = fitz.open()
    for i in range(n_pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text((50, 60), f"PAGE_MARKER_{i}", fontsize=12)
        page.insert_text((50, 90), f"page number {i + 1}", fontsize=10)
    data = doc.tobytes()
    doc.close()
    return data


def _counting_open_wrapper(file_bytes):
    """返回 (wrapper, counter_dict)。仅统计 split 级 fitz.open(stream=file_bytes)。

    registry._create_document 也会 fitz.open(stream=file_bytes) 一次（常驻句柄），
    该次同样被统计；这是预期内的恒定 +1，与本优化无关。
    """
    orig_open = backend_app.fitz.open
    counter = {"n": 0}

    def wrapper(*args, **kwargs):
        stream = kwargs.get("stream")
        if stream is not None and stream == file_bytes:
            counter["n"] += 1
        return orig_open(*args, **kwargs)

    return wrapper, counter


def _post_split(client, file_bytes):
    data = {"file": (io.BytesIO(file_bytes), "test.pdf")}
    return client.post("/split_pdf", data=data, content_type="multipart/form-data")


def _preview_hash(preview_b64):
    return hashlib.sha256(base64.b64decode(preview_b64)).hexdigest()


def _assert_order_and_content(pdf_bytes, pages):
    """逐页校验：顺序、page_id、内容一一对应源页。"""
    src = fitz.open(stream=pdf_bytes)
    try:
        assert len(pages) == len(src), f"页数不符: {len(pages)} vs {len(src)}"
        prev_index = 0
        for idx, p in enumerate(pages):
            # 1. page_index 严格升序
            assert p["page_index"] == prev_index + 1, f"page_index 乱序 @ {idx}"
            prev_index = p["page_index"]
            # 2. page_id 格式
            file_hash = hashlib.sha256(pdf_bytes).hexdigest()[:16]
            assert p["page_id"] == f"{file_hash}_{idx}", f"page_id 错 @ {idx}"
            # 3. page_bytes 是合法的 1 页 PDF，且内容 == 源页 idx（防错位）
            out_doc = fitz.open(stream=base64.b64decode(p["page_bytes"]))
            try:
                assert len(out_doc) == 1, f"输出页非单页 @ {idx}"
                out_text = out_doc[0].get_text()
                assert f"PAGE_MARKER_{idx}" in out_text, f"内容错位 @ {idx}"
                assert out_text == src[idx].get_text(), f"输出页文本与源页不一致 @ {idx}"
            finally:
                out_doc.close()
            # 4. preview_image 是非空 JPEG（base64 以 /9j 开头）
            assert p["preview_image"].startswith("/9j"), f"preview 非 JPEG @ {idx}"
    finally:
        src.close()


@pytest.mark.parametrize("n_pages,expected_chunk_opens", [
    (1, 1),
    (4, 4),
    (8, 8),
    (100, 8),
    (300, 8),
])
def test_split_open_count_and_order(client, monkeypatch, n_pages, expected_chunk_opens):
    backend_app.app.config["TESTING"] = True
    pdf_bytes = _make_pdf(n_pages)

    wrapper, counter = _counting_open_wrapper(pdf_bytes)
    monkeypatch.setattr(backend_app.fitz, "open", wrapper)

    resp = _post_split(client, pdf_bytes)
    assert resp.status_code == 200, resp.get_data(as_text=True)
    pages = resp.get_json()["pages"]

    # 总 fitz.open(stream=file_bytes) = 1（registry 常驻）+ chunk 级 opens。
    # 本优化把每页 1 次降到每 chunk 1 次；大页 PDF 总 open 数严格小于旧实现的 1+页数。
    assert counter["n"] == 1 + expected_chunk_opens, (
        f"fitz.open 次数应为 1+{expected_chunk_opens}，实际 {counter['n']}（页数={n_pages}）"
    )
    if n_pages > SPLIT_MAX_WORKERS:
        assert counter["n"] < 1 + n_pages, (
            f"大页 PDF 未减少 open 数：{counter['n']} 未 < {1 + n_pages}"
        )

    # 顺序 / page_id / 内容一一对应（chunk flatten 正确性）
    _assert_order_and_content(pdf_bytes, pages)


def test_split_preview_matches_single_page_reference(client, monkeypatch):
    """渲染输出与「逐页单开」参考实现逐页字节一致（JPEG 确定性）。

    preview 参数固定（dpi=200, fmt=jpeg），PyMuPDF 栅格输出确定；与旧逐页逻辑比对，
    验证 Commit 2 未改变任何 preview 字节（cache key 未变 -> 渲染输出不变）。
    """
    backend_app.app.config["TESTING"] = True
    n = 100
    pdf_bytes = _make_pdf(n)
    wrapper, _ = _counting_open_wrapper(pdf_bytes)
    monkeypatch.setattr(backend_app.fitz, "open", wrapper)

    pages = _post_split(client, pdf_bytes).get_json()["pages"]
    doc = backend_app.registry.open(pdf_bytes, filename="ref.pdf")
    for idx, p in enumerate(pages):
        with fitz.open(stream=pdf_bytes, filetype="pdf") as lp:
            pv, _, _ = backend_app.engine.render(
                doc_id=doc.doc_id, preset_name="preview", page=idx + 1,
                override_params={"dpi": 200, "fmt": "jpeg"}, pdf_doc=lp)
        assert _preview_hash(p["preview_image"]) == hashlib.sha256(pv).hexdigest(), (
            f"preview 与逐页参考不一致 @ {idx}"
        )


def test_split_deterministic_content(client):
    """两次拆分：每页内容/顺序一致（不比较原始 PDF 字节，PyMuPDF 提取含非确定元数据）。"""
    backend_app.app.config["TESTING"] = True
    pdf_bytes = _make_pdf(100)
    r1 = _post_split(client, pdf_bytes).get_json()["pages"]
    r2 = _post_split(client, pdf_bytes).get_json()["pages"]
    _assert_order_and_content(pdf_bytes, r1)
    _assert_order_and_content(pdf_bytes, r2)
    # preview（确定性）两次也应一致
    assert [_preview_hash(p["preview_image"]) for p in r1] == \
           [_preview_hash(p["preview_image"]) for p in r2]


def test_split_download_page_after_chunk(client, monkeypatch):
    """chunk 拆分后，download_page 仍能正常取回单页（registry 集成未破）。"""
    backend_app.app.config["TESTING"] = True
    pdf_bytes = _make_pdf(50)
    wrapper, _ = _counting_open_wrapper(pdf_bytes)
    monkeypatch.setattr(backend_app.fitz, "open", wrapper)

    pages = _post_split(client, pdf_bytes).get_json()["pages"]
    for pid in (pages[0]["page_id"], pages[-1]["page_id"]):
        dresp = client.get(f"/download_page/{pid}")
        assert dresp.status_code == 200, dresp.get_data(as_text=True)
        body = dresp.get_data()
        assert body[:4] == b"%PDF", "download_page 返回非 PDF"
        d = fitz.open(stream=body)
        try:
            assert len(d) == 1
        finally:
            d.close()


def test_split_exception_semantics_preserved(client):
    """异常语义：坏文件 -> 整体 500（不返回部分页）。仅验证 route 层契约不变。"""
    backend_app.app.config["TESTING"] = True
    resp = client.post(
        "/split_pdf",
        data={"file": (io.BytesIO(b"not a pdf at all"), "bad.pdf")},
        content_type="multipart/form-data",
    )
    assert resp.status_code == 500
    assert resp.get_json().get("success") is False
