"""13-A.3.5d preview adapter dispatch 契约测试。

锁定三件事（完整 HTTP 闭环：open → preview）：
  1. OFD 双页：page=1 / page=2 均返回 webp；page=3（越界）返回 404。
  2. PNG：page=1 返回 200（旧消费者回归，PDF/Image 世界不受影响）。
  3. PDF：page=1 返回 200。

page 参数沿用冻结的 1-based 契约（?page=1 为首页，后端 max(0,page-1)
转 0-based 喂 adapter.render）。不放宽到 ?page=0，否则会与 thumbnail/
render/print 及前端 buildPreviewUrl 产生「两个世界」。

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
    """合成最小可用 OFD（属性形式 FileLoc/BaseLoc，A4 210x297mm）。

    render_ofd_page 实际解析的是 Page.xml（list_ofd_page_paths 返回 Page 路径），
    因此可绘制的 PathObject 必须内联在 Page.xml 的 <Content> 中——若只放在独立
    Content.xml（经 FileLoc 引用），渲染器看不到绘制对象会返回 None（total==0）。
    """
    page_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Page Area="0 0 210 297">'
        '<PhysicalBox>0 0 210 297</PhysicalBox>'
        '<Content>'
        '<PathObject Boundary="20 20 170 257" Fill="true">'
        '<FillColor ColorSpace="RGB" Value="220 60 60"/>'
        '</PathObject>'
        '</Content>'
        '</Page>'
    )
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
    return buf.getvalue()


def _open(raw: bytes, name: str) -> str:
    """真实走 /api/documents/open（multipart 上传 → registry.open → doc_id）。"""
    backend_app.app.config["TESTING"] = True
    with backend_app.app.test_client() as c:
        resp = c.post(
            "/api/documents/open",
            data={"file": (io.BytesIO(raw), name)},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 200, (
            "open 应 200，实际 %s: %s" % (resp.status_code, resp.get_data(as_text=True))
        )
        return resp.get_json()["doc_id"]


def _preview(doc_id: str, page: int):
    with backend_app.app.test_client() as c:
        return c.get("/preview/%s?page=%d" % (doc_id, page))


def _assert_webp(resp):
    assert resp.status_code == 200, "preview 应 200，实际 %s" % resp.status_code
    assert resp.content_type == "image/webp", (
        "Content-Type 应为 image/webp，实际 %s" % resp.content_type
    )
    body = resp.get_data()
    assert body[:4] == b"RIFF" and body[8:12] == b"WEBP", "preview 主体应为 WebP 字节"


def test_preview_ofd_multi_page():
    """OFD 双页：page=1/page=2 均 webp；page=3 越界 404。"""
    doc_id = _open(_build_ofd(2), "a.ofd")

    _assert_webp(_preview(doc_id, 1))  # 首页（0-based page_idx=0）
    _assert_webp(_preview(doc_id, 2))  # 第二页（0-based page_idx=1）

    over = _preview(doc_id, 3)  # 越界（0-based page_idx=2 >= 2 页）
    assert over.status_code == 404, "OFD 越界页应 404，实际 %s" % over.status_code


def test_preview_png_regression():
    """PNG：page=1 返回 200（PDF/Image 世界零回归）。"""
    doc_id = _open(_MIN_PNG, "a.png")
    _assert_webp(_preview(doc_id, 1))


def test_preview_pdf_regression():
    """PDF：page=1 返回 200（PDF 走 fitz 路径，不受 adapter 短路影响）。"""
    doc_id = _open(_MIN_PDF, "a.pdf")
    resp = _preview(doc_id, 1)
    assert resp.status_code == 200, "PDF preview 应 200，实际 %s" % resp.status_code
