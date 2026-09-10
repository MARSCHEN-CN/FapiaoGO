# -*- coding: utf-8 -*-
"""
_phase3_r1_gain_bench.py —— R1「位图 Preview 输出长边上限」收益实测。

目的：把 Phase 3 的 R1 修复收益从「预期」变成「实测」。
      ⚠️ 只读基准，不改任何生产代码；新策略在本脚本内复现，不落地。

现状（engine.py:726 _render_image_page）：
    zoom = preset.dpi / 72.0            # preview: 150/72 = 2.083
    pix  = img_doc[0].get_pixmap(matrix=fitz.Matrix(zoom, zoom))

    fitz 把位图包装成 1 页 PDF 时按 96dpi → 页面 pt = 像素 × 72/96
    ⇒ 输出像素 = 源像素 × (150/96) = 1.5625 线性、2.44× 面积，无上限。

候选契约（用户 2026-09-08 复核意见）：
    scale = min(1.0, MAX_LONG_EDGE / max(src_w, src_h))   # 不放大，只缩小
    zoom  = (96/72) * scale                               # pt → 源像素 1:1 基准

    位图：走上式。矢量：仍走 dpi/72（矢量放大无像素成本且更清晰）。
    二者必须区分 —— 本脚本会实测「矢量误用位图公式」的退化幅度来证明这点。

交叉验证：对同一文档，先跑真实 engine（基准），再跑本脚本复现的现状路径，
          对比耗时/尺寸/字节。若复现误差大，则新策略的数字不可信。
"""
import io
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'backend'))
import fitz  # noqa
from PIL import Image  # noqa

from render_engine.registry import DocumentRegistry  # noqa
from render_engine.cache import RenderCache  # noqa
from render_engine.engine import RenderEngine, _open_fitz_image_doc, _encode_pixmap  # noqa
from render_engine.preset import PRESETS  # noqa

MAX_LONG_EDGE = 2000
ALT_LONG_EDGE = 1600


class _Q:
    def submit(self, *a, **k):
        return ""


def make_jpeg(w, h, seed=0):
    """生成有内容的 JPEG（纯色会被压缩成极小文件，失真基准）。"""
    img = Image.new('RGB', (w, h), (250, 250, 245))
    px = img.load()
    for y in range(0, h, 7):
        for x in range(0, w, 13):
            px[x, y] = ((x * 7 + seed) % 255, (y * 11 + seed) % 255, 128)
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=88)
    return buf.getvalue()


def make_vector_pdf():
    doc = fitz.open()
    p = doc.new_page(width=595, height=842)
    for k in range(20):
        p.insert_text((60, 80 + k * 30), f"INVOICE line {k} amount {k * 11.1:.2f}", fontsize=12)
    data = doc.tobytes()
    doc.close()
    return data


def real_engine_render(reg, eng, blob, name):
    """真实链路（基准）。"""
    doc = reg.open(blob, name)
    t = time.perf_counter()
    data, fmt, _ = eng.render(doc_id=doc.doc_id, preset_name="preview", page=1,
                              accept_header="image/webp")
    return (time.perf_counter() - t) * 1000, data


def replica_image_render(blob, zoom_mode, max_edge=MAX_LONG_EDGE):
    """复现 _render_image_page 的渲染核心，zoom 策略可切换。

    zoom_mode:
      'current'  —— zoom = dpi/72（现状）
      'capped'   —— zoom = (96/72) * min(1, MAX/src_max_px)（候选契约）
    """
    preset = PRESETS['preview']
    img_doc = _open_fitz_image_doc(blob, 'x.jpg')
    try:
        if zoom_mode == 'current':
            zoom = preset.dpi / 72.0
        else:
            pr = img_doc[0].rect
            src_max_px = max(pr.width, pr.height) * 96.0 / 72.0
            scale = min(1.0, max_edge / src_max_px)
            zoom = (96.0 / 72.0) * scale
        pix = img_doc[0].get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    finally:
        img_doc.close()
    # ⚠️ 返回 (bytes, actual_fmt) 元组
    data, _fmt = _encode_pixmap(pix, 'webp', preset.quality, preset.chroma)
    return zoom, data


def replica_vector_render(blob, zoom_mode, max_edge=MAX_LONG_EDGE):
    """复现 _render_pdf_page 的缩放核心（用于证明矢量必须走 dpi/72）。"""
    preset = PRESETS['preview']
    vdoc = fitz.open(stream=blob, filetype='pdf')
    try:
        pr = vdoc[0].rect
        if zoom_mode == 'current':
            zoom = preset.dpi / 72.0
        else:
            # 若误把位图公式套到矢量上
            src_max_px = max(pr.width, pr.height) * 96.0 / 72.0
            scale = min(1.0, max_edge / src_max_px)
            zoom = (96.0 / 72.0) * scale
        pix = vdoc[0].get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    finally:
        vdoc.close()
    # ⚠️ 只取 pixmap 尺寸、不做编码：真实 _render_pdf_page 还含 white_bg/margins/
    #    colorspace 处理，本复现不含，编码结果不可比；但**缩放尺寸由 zoom 唯一决定**，
    #   足以证明「矢量必须走 dpi/72」。
    return zoom, f"{pix.width}x{pix.height}"


def dims_of(data):
    try:
        im = Image.open(io.BytesIO(data))
        return f"{im.width}x{im.height}", im.width * im.height
    except Exception:
        return "?", 0


def timed(fn, *a, **k):
    t = time.perf_counter()
    out = fn(*a, **k)
    return (time.perf_counter() - t) * 1000, out


def main():
    print("=" * 104)
    print("R1 收益实测 —— 位图 Preview 输出长边上限（只读基准，未改生产代码）")
    print(f"MAX_LONG_EDGE = {MAX_LONG_EDGE}   交叉验证：真实 engine vs 本脚本复现")
    print("=" * 104)

    # ── 1. 交叉验证：复现路径是否可信 ──
    print("\n【步骤 1】交叉验证 —— 复现路径 vs 真实 engine（现状 zoom 必须吻合，否则后续数字不可信）")
    print(f"{'样本':<26} {'真实 engine':>28} {'复现(现状)':>28} {'误差':>10}")
    print("-" * 104)

    vec = make_vector_pdf()
    samples = [
        ("矢量 PDF A4 595x842pt", vec, 'vector'),
        ("扫描件 1240x1754", make_jpeg(1240, 1754, seed=7), 'image'),
        ("手机拍照 3000x4000", make_jpeg(3000, 4000, seed=3), 'image'),
    ]

    ok = True
    for name, blob, kind in samples:
        reg = DocumentRegistry()
        eng = RenderEngine(reg, RenderCache(), _Q())
        real_ms, real_data = real_engine_render(reg, eng, blob, f"{name}.bin")
        rd, rp = dims_of(real_data)

        if kind == 'vector':
            # 矢量复现只比尺寸（不做编码，见 replica_vector_render 注释）
            rep_ms, (_, nd) = timed(replica_vector_render, blob, 'current')
            diff_s, kb_s = '   n/a', '    n/a'
        else:
            rep_ms, (_, rep_data) = timed(replica_image_render, blob, 'current')
            nd, _np = dims_of(rep_data)
            diff = abs(len(real_data) - len(rep_data)) / max(1, len(real_data)) * 100
            diff_s, kb_s = f"{diff:7.1f}%", f"{len(rep_data)/1024:7.1f}KB"

        same = (rd == nd)
        if not same:
            ok = False
        print(f"{name:<26} {rd:>14} {len(real_data)/1024:7.1f}KB {real_ms:6.1f}ms "
              f"{nd:>14} {kb_s} {rep_ms:6.1f}ms {diff_s}"
              f"{'' if same else '  ❌尺寸不符'}")

    print(f"\n  ⇒ 交叉验证 {'PASS（复现可信，后续新策略数字有效）' if ok else 'FAIL（尺寸不符，后续数字仅作参考）'}")

    # ── 2. 位图：现状 vs 长边上限 ──
    print("\n【步骤 2】位图类 —— 现状 vs 长边上限策略")
    print(f"{'样本':<26} {'源像素':>12} {'现状产物':>13} {'现状耗时':>10} {'新策略产物':>13} "
          f"{'新策略耗时':>11} {'提速':>8}")
    print("-" * 104)

    img_cases = [
        ("扫描件 1240x1754", 1240, 1754),
        ("高拍仪 2592x1944", 2592, 1944),
        ("手机拍照 3000x4000", 3000, 4000),
        ("手机拍照 4608x3456", 4608, 3456),
    ]

    rows = []
    for name, w, h in img_cases:
        blob = make_jpeg(w, h, seed=w)
        cur_ms, (cur_zoom, cur_data) = timed(replica_image_render, blob, 'current')
        new_ms, (new_zoom, new_data) = timed(replica_image_render, blob, 'capped')
        cd, cp = dims_of(cur_data)
        nd, np_ = dims_of(new_data)
        speed = cur_ms / new_ms if new_ms else 0
        rows.append((name, f"{w}x{h}", cd, cur_ms, len(cur_data), nd, new_ms, len(new_data), speed))
        print(f"{name:<26} {w}x{h:<7} {cd:>13} {cur_ms:8.1f}ms {nd:>13} "
              f"{new_ms:9.1f}ms {speed:6.1f}×")

    print(f"\n{'样本':<26} {'现状体积':>12} {'新策略体积':>12} {'体积比':>9} {'现状放大':>10} {'新策略放大':>12}")
    print("-" * 104)
    for i, (name, src, cd, cur_ms, cb, nd, new_ms, nb, speed) in enumerate(rows):
        w, h = img_cases[i][1], img_cases[i][2]
        cur_scale = (int(cd.split('x')[0]) / w) if w else 0
        new_scale = (int(nd.split('x')[0]) / w) if w else 0
        print(f"{name:<26} {cb/1024:9.1f}KB {nb/1024:9.1f}KB {cb/nb if nb else 0:7.1f}× "
              f"{cur_scale:9.3f}× {new_scale:11.3f}×")

    # ── 3. 矢量必须区分 ──
    print("\n【步骤 3】矢量若误用位图公式 —— 证明二者必须走不同策略")
    cur_ms, (cz, cd) = timed(replica_vector_render, vec, 'current')
    wrong_ms, (wz, wd) = timed(replica_vector_render, vec, 'capped')
    cw = int(cd.split('x')[0])
    ww = int(wd.split('x')[0])
    print(f"  矢量 A4 现状(dpi/72)      : {cd:>12}   zoom={cz:.3f}   {cur_ms:6.1f}ms")
    print(f"  矢量 A4 误用(位图公式)    : {wd:>12}   zoom={wz:.3f}   {wrong_ms:6.1f}ms")
    print(f"  ⇒ 输出宽度比 {ww/cw:.3f}×（面积 {(ww/cw)**2:.2f}×）—— 矢量清晰度会显著下降，"
          f"故契约必须区分位图/矢量")

    # ── 4. 阈值敏感性 ──
    print(f"\n【步骤 4】MAX_LONG_EDGE 阈值敏感性（手机拍照 3000x4000）")
    blob12 = make_jpeg(3000, 4000, seed=3)
    print(f"{'阈值':>10} {'产物':>13} {'耗时':>10} {'体积':>10}")
    print("-" * 104)
    for edge in (1200, 1600, 2000, 2400):
        ms, (_, d) = timed(replica_image_render, blob12, 'capped', max_edge=edge)
        dd, _ = dims_of(d)
        print(f"{edge:>10} {dd:>13} {ms:8.1f}ms {len(d)/1024:7.1f}KB")

    print("\n" + "=" * 104)
    print("说明：本脚本为只读基准，新策略未写入 engine.py。")
    print("      耗时为单次冷渲染（含 fitz 打开 + 栅格化 + WebP 编码），沙箱环境，非真机绝对值。")
    print("=" * 104)


if __name__ == '__main__':
    main()
