"""13-A.3.5a /metadata pages[] 统一合同契约测试。

锁定三件事：
  1. OFD：adapter 优先派发，pages.length == 真实页数，尺寸正确（不靠 sniff）
  2. PNG：pages.length == 1（旧消费者回归，顶层字段仍兼容）
  3. PDF：pages.length == page_count（旧消费者回归，顶层字段=首页）

仅依赖 stdlib + 项目包（合成 PDF/PNG/OFD），不引入 Pillow 等第三方依赖。
通过 backend_app 的 Flask test_client 发起真实 HTTP 请求，覆盖完整路由。
"""
import base64
import io
import os
import sys
import zipfile

_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND_ROOT)

import app as backend_app  # noqa: E402

# 最小可解析 PDF（fitz 能开，1 页）。无需 Pillow。
_MIN_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 280]>>endobj\n"
    b"trailer<</Root 1 0 R>>\n"
    b"%%EOF\n"
)

# 1x1 有效 PNG（base64），_sniff_image 仅靠 magic 头判定。
_MIN_PNG = base64.b64decode(
    b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _build_ofd(n_pages: int = 2) -> bytes:
    """合成最小可用 OFD（属性形式 FileLoc/BaseLoc，A4 210x297mm）。"""
    page_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Page Area="0 0 210 297">'
        '<Content FileLoc="Content.xml"/>'
        '<PhysicalBox>0 0 210 297</PhysicalBox>'
        '</Page>'
    )
    content_xml = '<?xml version="1.0" encoding="UTF-8"?><Content></Content>'
    page_nodes = "".join(
        '<Page ID="%d" BaseLoc="Pages/Page_%d/Page.xml"/>' % (i + 1, i)
        for i in range(n_pages)
    )
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Document><Pages>' + page_nodes + '</Pages></Document>'
    )
    ofd_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<OFD><DocBody><Document FileLoc="Doc_0/Document.xml"/></DocBody></OFD>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("OFD.xml", ofd_xml)
        zf.writestr("Doc_0/Document.xml", document_xml)
        for i in range(n_pages):
            zf.writestr("Doc_0/Pages/Page_%d/Page.xml" % i, page_xml)
            zf.writestr("Doc_0/Pages/Page_%d/Content.xml" % i, content_xml)
    return buf.getvalue()


def _register(raw: bytes, name: str):
    backend_app.app.config["TESTING"] = True
    return backend_app.registry.open(raw, filename=name)


def _get_metadata(doc_id: str) -> dict:
    with backend_app.app.test_client() as c:
        resp = c.get("/metadata/%s" % doc_id)
        assert resp.status_code == 200, "metadata 应 200，实际 %s" % resp.status_code
        return resp.get_json()


def test_metadata_ofd_pages():
    """OFD：adapter 优先派发，pages[] 正确，不靠 sniff。"""
    doc = _register(_build_ofd(2), "a.ofd")
    data = _get_metadata(doc.doc_id)

    assert data["success"] is True
    assert data["page_count"] == 2, "OFD 双页 page_count 应为 2"
    pages = data["pages"]
    assert len(pages) == 2, "OFD pages 长度应为 2"
    assert pages[0]["index"] == 0
    assert pages[0]["width"] == 2480 and pages[0]["height"] == 3508, (
        "OFD A4@300dpi 应为 2480x3508，实际 %s" % pages[0]
    )
    assert pages[1]["index"] == 1
    # 顶层兼容字段 = 首页；adapter 优先，绝不应走 image/pdf 分支
    assert data["page_width"] == 2480
    assert data["page_height"] == 3508
    # OFDAdapter 用 sourceRotation 字段，API 已映射为 rotation
    assert "rotation" in pages[0] and "sourceRotation" not in pages[0]


def test_metadata_png_regression():
    """PNG：pages.length == 1，顶层字段仍兼容（旧消费者不破）。"""
    doc = _register(_MIN_PNG, "a.png")
    data = _get_metadata(doc.doc_id)

    assert data["page_count"] == 1
    assert len(data["pages"]) == 1, "PNG pages 长度应为 1"
    assert data["pages"][0]["index"] == 0
    assert data["pages"][0]["rotation"] == 0
    # 顶层兼容字段存在且 = 首页
    assert data["page_width"] == data["pages"][0]["width"]
    assert data["page_height"] == data["pages"][0]["height"]


def test_metadata_pdf_regression():
    """PDF：pages.length == page_count，顶层字段 = 首页。"""
    doc = _register(_MIN_PDF, "a.pdf")
    data = _get_metadata(doc.doc_id)

    assert data["page_count"] == doc.page_count, "PDF page_count 应与 doc.page_count 一致"
    assert len(data["pages"]) == data["page_count"], "PDF pages 长度应等于 page_count"
    assert data["pages"][0]["index"] == 0
    # 顶层字段 = 首页（一致性保证）
    assert data["page_width"] == data["pages"][0]["width"]
    assert data["page_height"] == data["pages"][0]["height"]
    assert data["page_rotation"] == data["pages"][0]["rotation"]
