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
