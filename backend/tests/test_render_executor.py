"""D3-3b-1 Render Executor 契约测试。

锁定四件事：
  1. paper_px 同构：后端 round(mm*dpi/25.4) == 前端 mmToPxFactor（含 .5 进位）。
  2. 输出页尺寸 == paper_px（Preview≡Export 的像素级同构前提）。
  3. contentRotation 顺时针（y-down）== 前端 canvas ctx.rotate(+θ) ——
     这是最大静默陷阱：fitz 与 canvas 旋转方向相反，必须锁死。
     绿点（源左上）经 90° CW 后应在页面中心右侧（与前端同构）。
  4. 静态 grep：executor 内无后端 fit（_apply_margins / scale=min / center / fit_scale）。

注意：offset 采用 createPlacement 真实输出（居中于整页 clip），
即 offset = (paper_px - draw)/2，否则旋转后位置会整体偏移导致误判。
"""

import os
import re
import sys

import fitz
import pytest

_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND_ROOT)

from services.render_executor import paper_px, render_command_to_page, _js_round


def _make_source_png():
    """生成带角标的竖图 PNG：红底，左上角画绿点（旋转方向校验用）。"""
    doc = fitz.open()
    doc.new_page(width=100, height=140)  # 竖图（高 > 宽）
    pg = doc[0]
    pg.draw_rect(fitz.Rect(0, 0, 100, 140), color=(1, 0, 0), fill=(1, 0, 0))
    pg.draw_rect(fitz.Rect(2, 2, 22, 22), color=(0, 1, 0), fill=(0, 1, 0))
    pix = pg.get_pixmap()
    return pix.tobytes('png')


def _centered_placement(draw_w, draw_h, paper_w, paper_h):
    # 复刻 createPlacement 的居中 offset（contentRect == 整页 clip）
    return {
        'scale': 1.0,
        'offsetX': (paper_w - draw_w) / 2,
        'offsetY': (paper_h - draw_h) / 2,
    }


def _base_cmd(rotated_bounds, content_rotation):
    pw, ph = paper_px({'widthMm': 210, 'heightMm': 297, 'dpi': 300})
    draw_w = rotated_bounds['width'] * 1.0
    draw_h = rotated_bounds['height'] * 1.0
    return {
        'version': 1,
        'sourceRef': {'path': 'x.png', 'page': 0},
        'paper': {'widthMm': 210, 'heightMm': 297, 'dpi': 300},
        'placement': _centered_placement(draw_w, draw_h, pw, ph),
        'rotatedBounds': rotated_bounds,
        'contentRotation': content_rotation,
        'rotation': 0,
        'clip': {'x': 0, 'y': 0, 'width': pw, 'height': ph},
    }


# ── 1. paper_px 同构不变式 ──
def test_paper_px_a4_300():
    # 用户锁死的契约：210×297 @300dpi → 2480×3508 (round 后)
    assert paper_px({'widthMm': 210, 'heightMm': 297, 'dpi': 300}) == (2480, 3508)


def test_paper_px_matches_js_math_round():
    # 后端 round 必须与前端 Math.round 逐字节一致（含 .5 进位，非银行家舍入）
    assert _js_round(2.5) == 3
    assert _js_round(0.5) == 1
    assert _js_round(210 * 300 / 25.4) == 2480   # 2480.314...
    assert _js_round(297 * 300 / 25.4) == 3508   # 3507.874...
    # 反例：python 内置 round 在 .5 上银行家舍入，确认我们不依赖它
    assert round(2.5) == 2
    assert _js_round(2.5) == 3


# ── 2. 输出页尺寸 == paper_px ──
def test_render_page_size_matches_paper_px():
    src = _make_source_png()
    out = fitz.open()
    render_command_to_page(out, _base_cmd({'width': 100, 'height': 140}, 0), src)
    assert len(out) == 1
    page = out[0]
    assert (int(page.rect.width), int(page.rect.height)) == (2480, 3508)
    out.close()


def test_render_rotation_0_marker_top_left_of_content():
    """0°：绿点（源左上）应落在 content box 左上（页面中心偏左上方）。"""
    src = _make_source_png()
    cmd = _base_cmd({'width': 100, 'height': 140}, 0)
    out = fitz.open()
    render_command_to_page(out, cmd, src)
    pix = out[0].get_pixmap()
    w, h = pix.width, pix.height
    off_x = int(cmd['placement']['offsetX'])
    off_y = int(cmd['placement']['offsetY'])
    cx = w // 2

    def is_green(i):
        return pix.samples[i + 1] > 150 and pix.samples[i] < 100 and pix.samples[i + 2] < 100

    # 绿点应在 content box 左上 40px 内，且 x 在页面中心左侧
    found = False
    for y in range(off_y, off_y + 40, 3):
        for x in range(off_x, off_x + 40, 3):
            if is_green((y * w + x) * 3):
                found = True
                break
        if found:
            break
    out.close()
    assert found, "0°：绿点(源左上)应在 content box 左上"
    # 且整页中心右侧不应有绿（确认居中 + 0° 未翻转）
    found_right = False
    for y in range(off_y, off_y + 40, 3):
        for x in range(cx, cx + 40, 3):
            if is_green((y * w + x) * 3):
                found_right = True
                break
        if found_right:
            break
    assert not found_right, "0°：绿点不应越过页面中心到右侧"


def test_render_rotation_90_cw_matches_frontend():
    """contentRotation=90 必须顺时针（与前端 canvas ctx.rotate(+90) 同构）。

    源竖图左上角绿点 → 顺时针 90°（y-down）→ 落 content box 『右上』，
    即页面中心右侧。若 fitz 误用逆时针，绿点会落 content box 左下（中心左侧）→ 失败。
    """
    src = _make_source_png()
    cmd = _base_cmd({'width': 140, 'height': 100}, 90)  # 90° 交换宽高
    out = fitz.open()
    render_command_to_page(out, cmd, src)
    pix = out[0].get_pixmap()
    w, h = pix.width, pix.height
    off_x = int(cmd['placement']['offsetX'])
    off_y = int(cmd['placement']['offsetY'])
    draw_w = int(cmd['rotatedBounds']['width'])
    draw_h = int(cmd['rotatedBounds']['height'])
    cx = w // 2

    def is_green(i):
        return pix.samples[i + 1] > 150 and pix.samples[i] < 100 and pix.samples[i + 2] < 100

    # 绿点应在 content box 右上 40px 内（页面中心右侧）
    found_right = False
    for y in range(off_y, off_y + 40, 3):
        for x in range(off_x + draw_w - 40, off_x + draw_w, 3):
            if is_green((y * w + x) * 3):
                found_right = True
                break
        if found_right:
            break
    # 左下不应有绿（排除逆时针误判）
    found_left = False
    for y in range(off_y + draw_h - 40, off_y + draw_h, 3):
        for x in range(off_x, off_x + 40, 3):
            if is_green((y * w + x) * 3):
                found_left = True
                break
        if found_left:
            break
    out.close()
    assert found_right, "contentRotation=90 顺时针：绿点应落 content box 右上（页面中心右侧）"
    assert not found_left, "contentRotation=90：绿点不应落 content box 左下（逆时针误判）"


def test_render_degenerate_scale_skips_draw():
    """scale=0（前端坍缩 contentRect）→ 不绘制，但页仍按 paper_px 建好。"""
    src = _make_source_png()
    out = fitz.open()
    cmd = _base_cmd({'width': 100, 'height': 140}, 0)
    cmd['placement']['scale'] = 0
    render_command_to_page(out, cmd, src)
    assert (int(out[0].rect.width), int(out[0].rect.height)) == (2480, 3508)
    out.close()


# ── 4. 静态 grep：executor 内无后端 fit ──
def test_executor_path_has_no_backend_fit():
    """D3-3b 边界铁律：后端绝不重算 fit/scale/center。"""
    forbidden = ('_apply_margins', 'calculateFit', 'fit_scale', 'scale=min', 'scale = min')
    path = os.path.join(_BACKEND_ROOT, 'services', 'render_executor.py')
    with open(path, 'r', encoding='utf-8') as fh:
        src = fh.read()
    # 去掉 docstring / 注释，只看可执行代码
    src = re.sub(r'""".*?"""', '', src, flags=re.DOTALL)
    src = re.sub(r"'''.*?'''", '', src, flags=re.DOTALL)
    src = re.sub(r'#.*$', '', src, flags=re.MULTILINE)
    for tok in forbidden:
        assert tok not in src, f"后端 fit 符号 '{tok}' 出现在 render_executor.py"
