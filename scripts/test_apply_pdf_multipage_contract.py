"""
test_apply_pdf_multipage_contract — R-2.2 多页 margin contract 回归（RED-first）

回归背景（2026-08-24）：
  R-1（62453a9）修复后，多页 PDF 走 source 打印轨，但 margin_contract.apply_pdf
  仍限制单页（len(src.pages)!=1 → raise ValueError），pdf-margin-processor 因此
  回退原路径 → 多页 PDF 打印无安全边距（R-2.1 已定位）。

  本测试锁定 Contract v1.2 语义（R-2.2 Design Decision Gate 冻结）：
    - apply_pdf 接受 N 页源，输出 N 页单文件（input.pdf → output.pdf(N页)）；
    - 每页同一 paper/margin/content_rotation 几何，逐页 contain-fit（源页尺寸可混合）；
    - 每页输出 /Rotate == 0；MediaBox == 同一 Policy A outputPaper；
    - 空 PDF（0 页）拒绝（reject）；
    - 单页行为与 v1.1 完全一致（N=1 自然等价）。

运行：backend/venv/Scripts/python.exe -m pytest scripts/test_apply_pdf_multipage_contract.py -v
"""

import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # scripts/ 可 import margin_contract

import pikepdf
import pytest

from margin_contract import apply_pdf, mm_to_pt

A4_PT = (595.2756, 841.8898)
A5_PT = (419.5276, 595.2756)
LETTER_PT = (612.0, 792.0)
M3 = mm_to_pt(3)  # 3mm 安全边距 ≈ 8.5039pt


def make_pdf(path, sizes, rotates=None):
    """生成测试 PDF：每页一个 200x200pt 内容矩形（源页内部几何），可带 /Rotate。"""
    with pikepdf.new() as pdf:
        for i, size in enumerate(sizes):
            page = pdf.add_blank_page(page_size=size)
            if rotates and rotates[i]:
                page.obj["/Rotate"] = rotates[i]
            page.contents_add(b"q 0.3 w 50 50 200 200 re f Q")
        pdf.save(path)
    return path


def output_placed_bbox(page):
    """输出页内容（form 经 cm matrix 放置）的包围盒（pt）。"""
    c = page.obj.get("/Contents")
    assert c is not None, "输出页应有 /Contents"
    # pikepdf：/Contents 可能是单个 Stream 或 Array[Stream]
    try:
        n = len(c)
        streams = [c[i] for i in range(n)]
    except TypeError:
        streams = [c]
    content = b"".join(s.read_bytes() for s in streams if s is not None)
    m = re.search(
        rb"q\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+cm",
        content,
    )
    assert m, "content stream 应含放置矩阵"
    a, b, c, d, e, f = (float(v) for v in m.groups())
    for _name, xobj in page.resources.get("/XObject", {}).items():
        bb = [float(v) for v in xobj.BBox]
    x0, y0, x1, y1 = bb
    pts = [
        (a * x + c * y + e, b * x + d * y + f)
        for (x, y) in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    ]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def run_apply(sizes, rotates=None, paper=A4_PT, margins=(M3, M3, M3, M3)):
    # 使用 tempfile 临时目录：沙箱安全删除垫片会拦截 os.remove 批量清理
    # （SAFE_DELETE_BULK_CONFIRM_REQUIRED → SystemExit），临时目录由系统回收，测试不主动删除。
    tmp = tempfile.mkdtemp(prefix="mp_margin_")
    src = make_pdf(os.path.join(tmp, f"{len(sizes)}p_src.pdf"), sizes, rotates)
    out = os.path.join(tmp, f"{len(sizes)}p_out.pdf")
    apply_pdf(src, out, paper[0], paper[1], margins, content_rotation=0)
    return out


def assert_pages(out, expected_n, expected_size, margins=(M3, M3, M3, M3)):
    with pikepdf.open(out) as pdf:
        assert len(pdf.pages) == expected_n, f"输出页数应为 {expected_n}"
        L, R, T, B = margins
        inner = (L, B, expected_size[0] - R, expected_size[1] - T)
        for page in pdf.pages:
            assert int(page.obj.get("/Rotate", 0)) == 0, "G-1: 输出 /Rotate 必须为 0"
            mb = [float(v) for v in page.MediaBox]
            w, h = abs(mb[2] - mb[0]), abs(mb[3] - mb[1])
            assert abs(w - expected_size[0]) < 0.2 and abs(h - expected_size[1]) < 0.2, \
                f"G-2: 输出 MediaBox 应为 Policy A outputPaper {expected_size}"
            x0, y0, x1, y1 = output_placed_bbox(page)
            assert x0 >= inner[0] - 0.05 and y0 >= inner[1] - 0.05 \
                and x1 <= inner[2] + 0.05 and y1 <= inner[3] + 0.05, \
                f"内容 bbox ({x0:.2f},{y0:.2f},{x1:.2f},{y1:.2f}) 应 ⊆ inner area {inner}"


def test_t1_three_page_uniform_a4():
    """3 页 A4 同票 → 输出 3 页、每页 /Rotate=0、MediaBox=A4、内容在 inner area 内。"""
    out = run_apply([A4_PT, A4_PT, A4_PT])
    assert_pages(out, 3, A4_PT)


def test_t2_mixed_page_sizes_same_paper_policy():
    """混合尺寸（A4/A5/Letter）→ 输出 3 页、同一 paper policy（全部归一为 A4）。"""
    out = run_apply([A4_PT, A5_PT, LETTER_PT])
    assert_pages(out, 3, A4_PT)


def test_t3_empty_pdf_rejected():
    """空 PDF（0 页）→ 拒绝（raise）。"""
    tmp = tempfile.mkdtemp(prefix="mp_margin_")
    src = os.path.join(tmp, "empty.pdf")
    with pikepdf.new() as pdf:
        pdf.save(src)
    with pytest.raises(ValueError):
        apply_pdf(src, os.path.join(tmp, "out_empty.pdf"), A4_PT[0], A4_PT[1], (M3, M3, M3, M3))


def test_t4_page_rotate_normalized_to_zero():
    """页 /Rotate=90 → 输出仍 /Rotate=0（G-1 每页保持）。"""
    out = run_apply([A4_PT, A4_PT, A4_PT], rotates=[0, 90, 0])
    assert_pages(out, 3, A4_PT)


def test_single_page_regression():
    """单页输入 → 输出 1 页，行为与 v1.1 完全一致（多页改造零回归保护）。"""
    out = run_apply([A4_PT])
    assert_pages(out, 1, A4_PT)
