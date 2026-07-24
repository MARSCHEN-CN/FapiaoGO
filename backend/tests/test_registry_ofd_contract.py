"""13-A.3.4 registry OFD 接入契约测试（registry 级，不碰 API/前端）。

锁定三件事：
  1. sniff 分类：PDF / Image / OFD / 非 OFD 的 zip 互不误判。
  2. registry.open() 对三类输入产出正确的 Document 身份：
       PDF -> pdf!=None, adapter=None
       PNG -> pdf=None,  file_bytes!=None, adapter=None
       OFD -> pdf=None,  file_bytes!=None, adapter=OFDAdapter
  3. OFD 的 doc.pdf is None（DocumentViewer 路由语义），doc_id 对同 bytes 稳定复用。

仅依赖 stdlib + 项目包，不引入 Pillow 等第三方依赖，便于 CI。
"""
import base64
import io
import os
import sys
import zipfile

_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND_ROOT)

from render_engine.registry import (  # noqa: E402
    DocumentRegistry,
    _sniff_pdf,
    _sniff_image,
    _sniff_ofd,
)
from render_engine.adapters.ofd_adapter import OFDAdapter  # noqa: E402

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
    """合成最小可用 OFD：根 OFD.xml → Doc_0/Document.xml → Page BaseLoc 属性。

    Page.xml 内放 PhysicalBox（元素形式，RE_PHYSICAL_BOX 可匹配），A4(210x297mm)。
    FileLoc / BaseLoc 均用属性形式（符合 OFD 规范，否则枚举会回退到 Content.xml）。
    """
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


def _build_plain_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", "not an ofd")
    return buf.getvalue()


def test_sniff_classification():
    ofd = _build_ofd(2)
    assert _sniff_pdf(_MIN_PDF) and not _sniff_ofd(_MIN_PDF)
    assert _sniff_image(_MIN_PNG) and not _sniff_ofd(_MIN_PNG)
    assert _sniff_ofd(ofd) and not _sniff_pdf(ofd)
    assert not _sniff_ofd(_build_plain_zip())  # 非 OFD 的 zip 不应误判
    assert not _sniff_ofd(b"random bytes")      # 非 zip 直接降级


def test_registry_pdf_document():
    reg = DocumentRegistry()
    doc = reg.open(_MIN_PDF, "a.pdf")
    assert doc.pdf is not None, "PDF 应持有 fitz handle"
    assert doc.adapter is None, "PDF 不应挂载 adapter"
    assert doc.page_count >= 1


def test_registry_png_document():
    reg = DocumentRegistry()
    doc = reg.open(_MIN_PNG, "a.png")
    assert doc.pdf is None, "PNG 绝不能进入 fitz 路径"
    assert doc.file_bytes is not None, "PNG 应持有 raw bytes"
    assert doc.adapter is None, "PNG 不应挂载 adapter"
    assert doc.page_count == 1


def test_registry_ofd_document():
    """核心：OFD 跨过 Document contract boundary。"""
    reg = DocumentRegistry()
    doc = reg.open(_build_ofd(2), "a.ofd")
    assert doc.pdf is None, "OFD 绝不能进入 fitz 路径（doc.pdf is None 是路由语义）"
    assert doc.file_bytes is not None, "OFD 应持有 raw bytes"
    assert isinstance(doc.adapter, OFDAdapter), "OFD 应挂载 OFDAdapter"

    meta = doc.adapter.metadata()
    assert meta["pageCount"] == 2, "合成双页 OFD 页数应为 2"
    p0 = meta["pages"][0]
    assert p0["index"] == 0
    assert p0["width"] == 2480 and p0["height"] == 3508, (
        "OFD A4@300dpi 应为 2480x3508，实际 %s" % p0
    )
    assert p0["sourceRotation"] == 0


def test_ofd_doc_id_stable_for_same_bytes():
    reg = DocumentRegistry()
    ofd = _build_ofd(2)
    d1 = reg.open(ofd, "a.ofd")
    d2 = reg.open(ofd, "a.ofd")
    assert d1.doc_id == d2.doc_id, "同 bytes 应复用同一 doc_id"
    assert d1.ref_count == 2, "复用应递增 ref_count"
