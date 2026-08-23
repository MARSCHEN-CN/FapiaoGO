# -*- coding: utf-8 -*-
"""
RASTER-1 回归守卫：OFD 不同 preset 渲染输出必须保持同一 aspect/orientation。

根因（2026-08-21）：_page_pixel_dims / _init_dimensions 的独立 clamp
（max(400)/max(560) 不同下限）在低 dpi 下破坏宽高比——小物理盒 OFD
（26447…：211.5×182.36mm，thumbnail dpi=48 → 400×345）被 clamp 成 400×560
（方向反转，横变纵），/thumbnail 与 /preview 方向不一致 → 打印预览弹窗
（消费 thumbnailUrl）contain 进横向 contentBox → 左右留白 → "不 fit"。

修复为等比例 clamp（任一维低于下限按同一 factor 整体放大），metadata
（_page_pixel_dims）与渲染器（_init_dimensions）同步，保持 aspect invariant。

本测试锁定：
  1. 小物理盒 OFD：thumbnail 方向 == metadata 方向（修复前违反）
  2. 大物理盒 OFD：thumbnail 尺寸保持修复前 baseline（561×371，走
     _init_dimensions_with_content，未改动）
"""
import io
import os
import sys
import zipfile

import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FIXTURES = os.path.normpath(os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    '..', 'test_fixtures'))

SMALL_BOX = os.path.join(FIXTURES, 'print-gate-anchors', '26447000000943604784.ofd')
LARGE_BOX = os.path.join(FIXTURES, '1412424.ofd')


def _thumb_dims(path):
    from render_engine import registry
    from render_engine.api import render_bp
    from flask import Flask
    with open(path, 'rb') as fh:
        raw = fh.read()
    doc = registry.open(raw, os.path.basename(path))
    app = Flask(__name__)
    app.register_blueprint(render_bp)
    client = app.test_client()
    r = client.get('/thumbnail/%s?page=1' % doc.doc_id)
    assert r.status_code == 200, 'thumbnail HTTP %d' % r.status_code
    img = Image.open(io.BytesIO(r.data))
    return img.width, img.height


def _meta_dims(path):
    from ofd_parser.ofd_page_render import ofd_page_dimensions
    with open(path, 'rb') as fh:
        raw = fh.read()
    return ofd_page_dimensions(raw, 300)[0]


def test_small_physical_box_ofd_thumbnail_aspect_matches_metadata():
    """RASTER-1：小物理盒 OFD thumbnail 方向必须与 metadata 一致。

    修复前：metadata=2498×2154（横），thumbnail=400×560（纵）→ 方向反转。
    修复后：thumbnail=649×560（横），与 metadata 方向一致。
    """
    md = _meta_dims(SMALL_BOX)
    tw, th = _thumb_dims(SMALL_BOX)
    assert tw > 0 and th > 0
    assert (tw > th) == (md['width'] > md['height']), (
        'thumbnail=%dx%d metadata=%dx%d 方向不一致（RASTER-1 违反）'
        % (tw, th, md['width'], md['height']))
    assert tw < md['width'] and th <= md['height'], (
        'thumbnail 不应超过 metadata 尺寸: %dx%d vs %dx%d'
        % (tw, th, md['width'], md['height']))


def test_large_physical_box_ofd_thumbnail_aspect_unchanged():
    """大物理盒 OFD thumbnail 尺寸保持修复前 baseline（561×371）。

    1412424 走 _init_dimensions_with_content（已按比例推导，未改动）；
    本测试锁定其 thumbnail 输出不被 clamp 修复波及（RASTER-1 baseline）。
    """
    tw, th = _thumb_dims(LARGE_BOX)
    assert (tw, th) == (561, 371), (
        '1412424 thumbnail 尺寸漂移: %dx%d（应保持 561x371）' % (tw, th))


def test_init_dimensions_clamp_syncs_scale():
    """RASTER-2：_init_dimensions 的 clamp 必须同步放大 self.scale。

    锁定根因：_clamp_min_dims 放大 canvas（400×345 → 649×560）时，渲染
    RenderContext 的 scale 必须同步乘同一 factor，否则内容按原始 scale
    渲染、缩在 canvas 左上角（右侧/下方大量白边）。

    冻结用例：页 211.5×182.36mm @48dpi → raw 400×345 → factor≈1.623
    → canvas 649×560，scale 也必须 ≈ (48/25.4) × 1.623。
    """
    from ofd_parser.ofd_renderer import _OFDRenderer

    raw = open(SMALL_BOX, 'rb').read()
    zf = zipfile.ZipFile(io.BytesIO(raw))
    try:
        r = _OFDRenderer(zf, zf.namelist(), dpi=48)
        r._init_dimensions(211.5, 182.36)
    finally:
        zf.close()

    raw_scale = 48 / 25.4
    assert (r.img_w, r.img_h) == (649, 560), (
        'canvas 尺寸漂移: %dx%d（应 649x560）' % (r.img_w, r.img_h))
    factor = r.scale / raw_scale
    assert abs(factor - 1.623) < 0.01, (
        'scale 未按 factor 同步放大: scale/raw=%r（应≈1.623）' % factor)


def test_small_box_thumbnail_content_fills_canvas():
    """RASTER-2 端到端：小物理盒 OFD thumbnail 内容必须填满 canvas。

    修复前：clamp 放大 canvas 但 scale 未同步 → 内容只画 400×345 在左上角，
    右侧 258px / 下方 229px 白边（打印预览 contain 后视觉「内容居左、白边」）。
    修复后：scale 同步放大 → 内容填满 canvas，右/下白边≈内容边距（<60px）。

    直接调用 render_ofd_page(dpi=48)（= /thumbnail 的 adapter 渲染核心，
    不经 HTTP/fitz，避免测试环境 fitz 依赖），等价于验证 thumbnail WebP。
    """
    from ofd_parser.ofd_page_render import render_ofd_page

    with open(SMALL_BOX, 'rb') as fh:
        raw = fh.read()
    webp = render_ofd_page(raw, 0, dpi=48)  # thumbnail preset dpi=48
    assert webp is not None, 'render_ofd_page 返回 None'

    img = Image.open(io.BytesIO(webp)).convert('RGB')
    w, h = img.size
    px = img.load()
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            rr, gg, bb = px[x, y]
            if not (rr > 245 and gg > 245 and bb > 245):
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
                if y < miny:
                    miny = y
                if y > maxy:
                    maxy = y
    right_margin = w - 1 - maxx
    bottom_margin = h - 1 - maxy
    assert right_margin < 60, (
        '右白边过大 %dpx（scale 未同步，内容未填满 canvas）' % right_margin)
    assert bottom_margin < 60, (
        '下白边过大 %dpx（scale 未同步，内容未填满 canvas）' % bottom_margin)
