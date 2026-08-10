# -*- coding: utf-8 -*-
"""
INV-4 环境一致性验证（Phase 1-B B2）—— 三路载体，同一几何。

向量锚点：V-01（A4 目标纸 + 对称 10mm margin）。
三路共享【相同 contentSize】（595×842pt）：
  路1 pdf adapter      : 源 PDF（595×842pt）→ add-pdf-margins.py（PDF 路径 + 显式 paper）
  路2 image adapter    : 源 PNG（595×842px @72dpi）→ img2pdf 转原始尺寸 → apply_pdf
  路3 fallback disabled: 同上 PNG → 模拟 img2pdf 缺失（sys.modules 置 None）→ PIL 转原始尺寸 → apply_pdf

断言（INV-4）：三路的 contentSize / mediaBox / contentBox / scale 必须一致（容差 0.01pt）。
任何不一致 = 环境决定了几何，B2 不通过（历史最大 bug 正是 img2pdf 有无决定几何）。

用法: python scripts/verify_inv4_env_consistency.py   （0 = 全过）
"""
import json
import importlib.util
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

# add-pdf-margins.py 文件名含连字符，不能用 import 语句，按路径加载
def _load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod

add_pdf_margins = _load_module("add_pdf_margins",
                               os.path.join(_HERE, "add-pdf-margins.py"))
import margin_contract as mc  # noqa: E402

_TMP = tempfile.mkdtemp(prefix="inv4_")
TOL_PT = 0.01

GRAY = 0.6  # 灰度内容（与 Gate fixture 一致，避免被当白底）


def _make_source_pdf(path):
    """595×842pt 单页源 PDF（灰度 0.6 满版 + 左下黑方块方向标记），无 /Rotate。"""
    from PIL import Image
    W, H = 595, 842
    img = Image.new("L", (W, H), int(GRAY * 255))
    px = img.load()
    s = 48  # 标记尺寸
    for y in range(s):
        for x in range(s):
            px[x, H - 1 - y] = 0  # 左下角方块（PDF 坐标 y 向上，从底边起）
    for x in range(s * 2):
        for y in range(int(s * 0.4)):
            px[x, H - 1 - y - s] = 0  # 顶边横条（相对底边）
    img.save(path, "PDF", resolution=72.0)


def _make_source_png(path):
    """595×842px PNG @72dpi（与源 PDF 同一内容）。"""
    from PIL import Image
    W, H = 595, 842
    img = Image.new("L", (W, H), int(GRAY * 255))
    px = img.load()
    s = 48
    for y in range(s):
        for x in range(s):
            px[x, H - 1 - y] = 0
    for x in range(s * 2):
        for y in range(int(s * 0.4)):
            px[x, H - 1 - y - s] = 0
    img.save(path, "PNG", dpi=(72.0, 72.0))


def _run_route(route_name, input_path, is_image, patch_img2pdf=None):
    """跑一路 add_margins，返回 (info, out_path)。patch_img2pdf: True=强制走 PIL。"""
    out = os.path.join(_TMP, f"{route_name}.pdf")
    if patch_img2pdf:
        sys.modules["img2pdf"] = None  # import img2pdf → ImportError → PIL 分支
    try:
        result = add_pdf_margins.add_margins(
            input_path, out, left_mm=10, right_mm=10, top_mm=10, bottom_mm=10,
            is_image=is_image, paper_w_mm=210, paper_h_mm=297, rotation=0)
    finally:
        if patch_img2pdf:
            del sys.modules["img2pdf"]
    if not result.get("success"):
        raise RuntimeError(f"[{route_name}] add_margins failed: {result.get('error')}")
    return result["info"], out


def _probe_media_box(pdf_path):
    """实际输出 PDF 的 MediaBox（pt）。"""
    import pikepdf
    with pikepdf.open(pdf_path) as pdf:
        page = pdf.pages[0]
        box = [float(v) for v in page.obj["/MediaBox"]]
        rot = int(page.obj.get("/Rotate", 0))
    return abs(box[2] - box[0]), abs(box[3] - box[1]), rot


def main():
    src_pdf = os.path.join(_TMP, "src.pdf")
    src_png = os.path.join(_TMP, "src.png")
    _make_source_pdf(src_pdf)
    _make_source_png(src_png)

    routes = {
        "pdf-adapter":       _run_route("pdf-adapter", src_pdf, is_image=False),
        "image-img2pdf":     _run_route("image-img2pdf", src_png, is_image=True),
        "image-pil-fallback": _run_route("image-pil-fallback", src_png, is_image=True,
                                          patch_img2pdf=True),
    }

    allok = True
    cols = ["contentSize", "mediaBox", "contentBox", "scale"]
    # 逐字段打印三路
    print("=" * 70)
    print("INV-4 三路一致性（V-01 锚点：A4 + 10mm margin，contentSize 595×842pt）")
    print("=" * 70)
    for route, (info, out) in routes.items():
        g = info["geometry"]
        print(f"\n[{route}]  out={os.path.basename(out)}")
        print(f"  contentSize = {info['contentSize'][0]:.4f} x {info['contentSize'][1]:.4f} pt")
        print(f"  mediaBox    = {g['mediaBox']['widthPt']:.4f} x {g['mediaBox']['heightPt']:.4f} pt")
        print(f"  contentBox  = x {g['contentBox']['x']:.4f}  y {g['contentBox']['y']:.4f}  "
              f"w {g['contentBox']['widthPt']:.4f}  h {g['contentBox']['heightPt']:.4f}")
        print(f"  scale       = {g['scale']:.6f}")

    # 断言：三路两两一致（0.01pt）
    def field(route, name):
        g = routes[route][0]["geometry"]
        if name == "contentSize":
            return routes[route][0]["contentSize"]
        return [g[name]["widthPt"], g[name]["heightPt"]] if name in ("mediaBox", "contentBox") \
            else [g[name]]
    for name in cols:
        base = field("pdf-adapter", name)
        for route in ("image-img2pdf", "image-pil-fallback"):
            cur = field(route, name)
            for a, b in zip(base, cur):
                if abs(a - b) > TOL_PT:
                    print(f"\n[FAIL] {name}: pdf-adapter={a:.4f} vs {route}={b:.4f} (Δ {abs(a-b):.4f}pt)")
                    allok = False
                else:
                    print(f"  [ok] {name}: {route} == pdf-adapter (Δ {abs(a-b):.4f}pt)")

    # INV-1 顺带断言：三路实际输出 MediaBox == A4、/Rotate == 0
    for route, (info, out) in routes.items():
        w, h, rot = _probe_media_box(out)
        a4w, a4h = mc.mm_to_pt(210), mc.mm_to_pt(297)
        if abs(w - a4w) > 0.1 or abs(h - a4h) > 0.1 or rot != 0:
            print(f"[FAIL] {route} 实际输出 MediaBox {w:.2f}x{h:.2f} /Rotate={rot} != A4+0")
            allok = False
        else:
            print(f"  [ok] {route} 实际输出 MediaBox {w:.2f}x{h:.2f} /Rotate={rot} (INV-1/R-1)")

    print("\n" + "=" * 70)
    print("INV-4 PASS：三路几何完全一致" if allok else "INV-4 FAIL：环境决定了几何")
    sys.exit(0 if allok else 1)


if __name__ == "__main__":
    main()
