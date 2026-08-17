# -*- coding: utf-8 -*-
"""
P1 回归：OFD renderer 双样本 Gate（2026-08-17）

背景：1412424.ofd（原白屏）与正常样本 26447000000943604784.ofd 结构不同——
前者 TextObject=0、内容全在 3 个 PNG（ImageObject）里。白图 = 三个独立 bug 叠加：
  A. setup() 尺寸来源：Content.xml Area PhysicalBox（600.938×397.013 私有坐标）
     误判 unit → 画布 400×560 下限
  B. load_ofd_resources：绝对路径 MediaFile（/Doc_0/Res/x.png）拼接失败 →
     MultiMedia ID 未注册 → ImageObject 全部跳过（内容主因）
  C. _get_color 不解析 DrawParam 引用 → Path 填充色 None → 线框不画

Gate 断言（双样本）：
  - 1412424：A4 2480×3508 @300dpi、非白像素明显 > 0（内容铺满）、resources 含 ID 6
  - 2644：保持修复前行为（2498×2154 横向、非白 > 0）—— 不回归
"""

import sys
import os
import io

_root = os.path.join(os.path.dirname(__file__), '..', '..')
sys.path.insert(0, _root)
sys.path.insert(0, os.path.join(_root, 'backend'))

import numpy as np
from PIL import Image
from ofd_parser.ofd_page_render import render_ofd_page, ofd_page_dimensions
from ofd_parser.xml_utils import load_ofd_resources
import zipfile

SAMPLE_BAD = os.path.join(_root, 'test_fixtures', '1412424.ofd')
SAMPLE_GOOD = os.path.join(_root, 'test_fixtures', 'print-gate-anchors',
                           '26447000000943604784.ofd')


def _load(path):
    with open(path, 'rb') as f:
        return f.read()


def _render_stats(raw):
    """渲染并返回 (w, h, nonwhite_ratio)"""
    img_bytes = render_ofd_page(raw, 0, dpi=300)
    assert img_bytes is not None, 'render_ofd_page 返回 None'
    arr = np.array(Image.open(io.BytesIO(img_bytes)).convert('RGB'))
    total = arr.shape[0] * arr.shape[1]
    nonwhite = int((arr < 240).any(axis=2).sum())
    return arr.shape[1], arr.shape[0], nonwhite / total


# ═══════════════════════════════════════════
# 1412424（原白屏样本）
# ═══════════════════════════════════════════

def test_bad_sample_abs_mediafile_resource_registered():
    """Bug B：绝对路径 MediaFile 的 MultiMedia ID 必须注册进 resources。"""
    raw = _load(SAMPLE_BAD)
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        resources = load_ofd_resources(zf, zf.namelist())
    # DocumentRes.xml: MultiMedia ID=6 → /Doc_0/Res/res2361876740733327849.png
    assert resources.get('6') == 'Doc_0/Res/res2361876740733327849.png', \
        f"MultiMedia ID=6 未注册（绝对路径拼接失败）: {resources}"


def test_bad_sample_a4_dimensions():
    """1412424 横向发票：以 Content.xml PhysicalBox 为画布 @300dpi，
    宽高比应匹配内容（600.938/397.013≈1.511），尺寸在 (2800-3508, 2000-2500) 合理范围。"""
    raw = _load(SAMPLE_BAD)
    w, h, ratio = _render_stats(raw)
    assert w == 3508, f"期望宽度 3508（上限）, 实际 {w}"
    assert 2200 <= h <= 2500, f"期望高度 2200-2500（内容比例 ~1.51）, 实际 {h}"
    assert abs(w / h - 600.938 / 397.013) < 0.02, \
        f"宽高比偏离内容原始比例: {w/h:.4f} vs {600.938/397.013:.4f}"


def test_bad_sample_content_present():
    """Bug A+B+C：非白像素必须明显 > 0（图片 + Path 都渲染，非纯白）。"""
    raw = _load(SAMPLE_BAD)
    w, h, ratio = _render_stats(raw)
    assert ratio > 0.10, f"内容占比过小: {ratio:.2%}（修复前为 0%）"


# ═══════════════════════════════════════════
# 2644（正常样本，防回归）
# ═══════════════════════════════════════════

def test_good_sample_unchanged():
    """正常 OFD 尺寸路径保持不变：2644 仍为 2498×2154 横向、非白 > 0。"""
    raw = _load(SAMPLE_GOOD)
    w, h, ratio = _render_stats(raw)
    assert (w, h) == (2498, 2154), f"2644 尺寸回归: 期望 2498×2154, 实际 {w}×{h}"
    assert ratio > 0.01, f"2644 内容异常: 非白 {ratio:.2%}"


# ═══════════════════════════════════════════
# metadata 尺寸（ofd_page_dimensions 与渲染器一致，P1-A 同步）
# ═══════════════════════════════════════════

def test_bad_sample_metadata_a4():
    """1412424 metadata：宽高比匹配内容比例，宽度 3508。"""
    raw = _load(SAMPLE_BAD)
    dims = ofd_page_dimensions(raw, 300)
    assert dims and dims[0]['width'] == 3508, f"宽度应为 3508, 实际 {dims}"
    assert 2200 <= dims[0]['height'] <= 2500, f"高度应在 2200-2500, 实际 {dims[0]['height']}"
    actual_ratio = dims[0]['width'] / dims[0]['height']
    expected_ratio = 600.938 / 397.013
    assert abs(actual_ratio - expected_ratio) < 0.02, \
        f"宽高比偏离: {actual_ratio:.4f} vs {expected_ratio:.4f}"


def test_good_sample_metadata_unchanged():
    """2644 metadata 尺寸保持 2498×2154（不回归）。"""
    raw = _load(SAMPLE_GOOD)
    dims = ofd_page_dimensions(raw, 300)
    assert dims and dims[0]['width'] == 2498 and dims[0]['height'] == 2154, \
        f"2644 metadata 尺寸回归: {dims}"


if __name__ == '__main__':
    test_bad_sample_abs_mediafile_resource_registered()
    test_bad_sample_a4_dimensions()
    test_bad_sample_content_present()
    test_good_sample_unchanged()
    test_bad_sample_metadata_a4()
    test_good_sample_metadata_unchanged()
    print('\n🎉 双样本 Gate 全部通过')
