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
from ofd_parser.ofd_page_render import render_ofd_page
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
    """Bug A：1412424 页面尺寸必须为 A4 2480×3508 @300dpi（非 400×560）。"""
    raw = _load(SAMPLE_BAD)
    w, h, ratio = _render_stats(raw)
    assert (w, h) == (2480, 3508), f"期望 A4 2480×3508, 实际 {w}×{h}"


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


if __name__ == '__main__':
    test_bad_sample_abs_mediafile_resource_registered()
    test_bad_sample_a4_dimensions()
    test_bad_sample_content_present()
    test_good_sample_unchanged()
    print('\n🎉 双样本 Gate 全部通过')
