"""D3-3b-3 Export Render Service contract tests (orchestration layer, no Flask).

Locks five things:
  1. image command -> output PDF has 1 page, page size == paper_px
     (2480x3508 @ A4@300dpi, the JS-round half-up invariant from D3-3b-1).
  2. pdf command -> insert_pdf passthrough: output has 1 page and KEEPS the
     source page size (595x842), proving it was NOT re-rastered into a 300dpi
     image (vectors/text/size preserved -- the whole point of the D3-3 split).
  3. contentRotation=90 -> pipeline does not crash; output page size still
     == paper_px (rotation never changes the paper). Executor rotation
     correctness itself is locked in test_render_executor.py; here we only
     verify the orchestration link.
  4. missing source file -> raises (route maps this to task.fail; the service
     must NOT swallow source errors).
  5. multiple commands -> multiple pages (1 command -> 1 output page).
"""

import os
import sys
import tempfile

import fitz
import pytest

_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND_ROOT)

from services.export_render_service import execute_export_render


def _make_png():
    doc = fitz.open()
    doc.new_page(width=200, height=280)
    doc[0].draw_rect(fitz.Rect(0, 0, 200, 280), color=(1, 0, 0), fill=(1, 0, 0))
    fd, path = tempfile.mkstemp(suffix='.png')
    with os.fdopen(fd, 'wb') as fh:
        fh.write(doc[0].get_pixmap().tobytes('png'))
    doc.close()
    return path


def _make_pdf(n_pages=2):
    doc = fitz.open()
    for _ in range(n_pages):
        doc.new_page(width=595, height=842)  # ~A4 @72dpi
    fd, path = tempfile.mkstemp(suffix='.pdf')
    with os.fdopen(fd, 'wb') as fh:
        fh.write(doc.tobytes())
    doc.close()
    return path


def _image_command(path, content_rotation=0):
    rb = {'width': 1000, 'height': 1414}
    if content_rotation in (90, 270):
        rb = {'width': 1414, 'height': 1000}
    return {
        "version": 1,
        "sourceRef": {"path": path, "page": 0},
        "paper": {"widthMm": 210.0, "heightMm": 297.0, "dpi": 300},
        "placement": {"scale": 0.5, "offsetX": 10.0, "offsetY": 20.0},
        "rotatedBounds": rb,
        "contentRotation": content_rotation,
        "rotation": 0,
        "clip": {"x": 0, "y": 0, "width": rb['width'], "height": rb['height']},
    }


def _pdf_command(path, page=0):
    return {
        "version": 1,
        "sourceRef": {"path": path, "page": page},
        "paper": {"widthMm": 210.0, "heightMm": 297.0, "dpi": 300},
        "placement": {"scale": 1.0, "offsetX": 0.0, "offsetY": 0.0},
        "rotatedBounds": {"width": 595, "height": 842},
        "contentRotation": 0,
        "rotation": 0,
        "clip": {"x": 0, "y": 0, "width": 595, "height": 842},
    }


def test_image_command_produces_paper_sized_page():
    png = _make_png()
    try:
        data = execute_export_render([_image_command(png)])
        doc = fitz.open(stream=data)
        try:
            assert len(doc) == 1
            assert (int(doc[0].rect.width), int(doc[0].rect.height)) == (2480, 3508)
        finally:
            doc.close()
    finally:
        os.remove(png)


def test_pdf_command_passthrough_inserts_source_page():
    pdf = _make_pdf(n_pages=2)
    try:
        # 源 PDF 2 页；命令选 page=0 -> 输出应只有 1 页（透传，不重栅）
        data = execute_export_render([_pdf_command(pdf, page=0)])
        doc = fitz.open(stream=data)
        try:
            assert len(doc) == 1, "PDF 透传应插入所选页（1 页），而非整本"
            # 透传页尺寸应等于源页尺寸，证明未被降级为 300dpi 重栅图
            assert (int(doc[0].rect.width), int(doc[0].rect.height)) == (595, 842)
        finally:
            doc.close()
    finally:
        os.remove(pdf)


def test_rotation_90_pipeline_runs_and_keeps_paper_size():
    png = _make_png()
    try:
        data = execute_export_render([_image_command(png, content_rotation=90)])
        doc = fitz.open(stream=data)
        try:
            assert len(doc) == 1
            assert (int(doc[0].rect.width), int(doc[0].rect.height)) == (2480, 3508)
        finally:
            doc.close()
    finally:
        os.remove(png)


def test_missing_source_file_raises():
    cmd = _image_command("C:/no/such/file/abc-xyz-123.png")
    with pytest.raises(Exception):
        execute_export_render([cmd])


def test_multiple_commands_produce_multiple_pages():
    p1 = _make_png()
    p2 = _make_png()
    try:
        data = execute_export_render([_image_command(p1), _image_command(p2)])
        doc = fitz.open(stream=data)
        try:
            assert len(doc) == 2
        finally:
            doc.close()
    finally:
        os.remove(p1)
        os.remove(p2)
