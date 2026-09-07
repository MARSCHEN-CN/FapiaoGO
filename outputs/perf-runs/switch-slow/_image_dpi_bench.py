# -*- coding: utf-8 -*-
"""
_image_dpi_bench.py — 只读基准：图片类发票（手机拍照/扫描件）经 /preview 出图的真实代价。

怀疑点：_render_image_page 用 zoom = preset.dpi / 72.0 施加于「图片自身像素」，
而 fitz 把图片打开成 1 页 PDF 时页面尺寸（pt）等于图片像素数。
即：输出像素 = 原图像素 × (150/72) = 原图像素 × 2.083  → 面积放大 4.34 倍。
"""
import io
import os
import sys
import time
import statistics

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend'))
import fitz  # noqa
from PIL import Image  # noqa

from render_engine.registry import DocumentRegistry  # noqa
from render_engine.cache import RenderCache  # noqa
from render_engine.engine import RenderEngine  # noqa


class _Q:
    def submit(self, *a, **k): return ""


def make_jpeg(w, h, seed=0):
    img = Image.new('RGB', (w, h), (250, 250, 245))
    px = img.load()
    # 画点内容，避免纯色被压缩成极小文件
    for y in range(0, h, 7):
        for x in range(0, w, 13):
            px[x, y] = ((x * 7 + seed) % 255, (y * 11 + seed) % 255, 128)
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=88)
    return buf.getvalue()


def make_pdf_from_jpeg(jpeg_bytes):
    """模拟「图片发票」：后端把 JPEG 转成 1 页 PDF 后注册，或直接用 file_bytes 走 image 路径。"""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_image(fitz.Rect(0, 0, 595, 842), stream=jpeg_bytes)
    data = doc.tobytes(deflate=True)
    doc.close()
    return data


def main():
    reg = DocumentRegistry()
    eng = RenderEngine(reg, RenderCache(), _Q())

    cases = [
        ("扫描件 150dpi A4 灰度",        1240, 1754),
        ("手机拍照 1200万像素(3000x4000)", 3000, 4000),
        ("手机拍照 1600万像素(4608x3456)", 4608, 3456),
        ("高拍仪 2592x1944",             2592, 1944),
    ]

    print(f"{'场景':<32} {'源图':>12} {'产物像素':>16} {'产物体积':>10} {'冷渲染':>12} {'热渲染':>10}")
    print("-" * 100)
    for name, w, h in cases:
        jpg = make_jpeg(w, h, seed=w)
        # 直接把 JPEG 字节注册为「图片文档」（与 registry 判定 image 的路径一致）
        doc = reg.open(jpg, f"photo_{w}x{h}.jpg")
        t = time.perf_counter()
        data, fmt, _ = eng.render(doc_id=doc.doc_id, preset_name="preview", page=1,
                                  accept_header="image/webp")
        cold = (time.perf_counter() - t) * 1000
        t = time.perf_counter()
        eng.render(doc_id=doc.doc_id, preset_name="preview", page=1, accept_header="image/webp")
        warm = (time.perf_counter() - t) * 1000

        # 解析产物像素
        try:
            im = Image.open(io.BytesIO(data))
            dims = f"{im.width}x{im.height}"
        except Exception:
            dims = "?"
        mp = (w * h) / 1e6
        print(f"{name:<32} {w}x{h:<7} {dims:>16} {len(data)/1024:8.1f} KB "
              f"{cold:9.1f} ms {warm:7.2f} ms")

    print()
    print("对照：纯矢量 PDF（文本型发票）")
    vdoc = fitz.open()
    p = vdoc.new_page(width=595, height=842)
    for k in range(20):
        p.insert_text((60, 80 + k * 30), f"INVOICE line {k} amount {k*11.1:.2f}", fontsize=12)
    vb = vdoc.tobytes(); vdoc.close()
    d = reg.open(vb, "vector.pdf")
    t = time.perf_counter()
    data, fmt, _ = eng.render(doc_id=d.doc_id, preset_name="preview", page=1, accept_header="image/webp")
    cold = (time.perf_counter() - t) * 1000
    t = time.perf_counter()
    eng.render(doc_id=d.doc_id, preset_name="preview", page=1, accept_header="image/webp")
    warm = (time.perf_counter() - t) * 1000
    im = Image.open(io.BytesIO(data))
    print(f"{'矢量 PDF A4':<32} {'595x842pt':>12} {f'{im.width}x{im.height}':>16} "
          f"{len(data)/1024:8.1f} KB {cold:9.1f} ms {warm:7.2f} ms")

    print()
    print("结论性换算（_render_image_page: zoom = preset.dpi / 72.0）：")
    print(f"  preview preset dpi = 150  →  zoom = {150/72:.3f}  →  面积放大 {(150/72)**2:.2f}×")
    print(f"  print   preset dpi = 200  →  zoom = {200/72:.3f}  →  面积放大 {(200/72)**2:.2f}×")


if __name__ == '__main__':
    main()
