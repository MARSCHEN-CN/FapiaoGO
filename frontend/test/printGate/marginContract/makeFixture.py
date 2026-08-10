#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Margin Contract Gate — 确定性 fixture 生成器（DEV-only，非生产代码）

两种模式：
  source  : 按向量 input 生成【源 PDF】（未加边距）
  correct : 按向量 expected 生成【已知正确的 contain-fit 输出 PDF】
            —— 用于 Gate 基础设施自检（契约 §9.1 条件 2）

⚠️ 纪律：
  - 本脚本【绝不】调用 scripts/add-pdf-margins.py 或任何生产实现。
  - correct 模式的几何【全部来自】docs/margin_contract_vectors.json 的手工推导值，
    fitz 在此只充当"把内容放到指定矩形"的绘图工具，不参与任何几何决策。
  - 因此 correct fixture 能验证的是【测量管线 + 坐标系换算】，不是数值本身。
    数值的正确性由 Gate 1 的有理数推导 + 14 条自审计保证。

用法:
  python makeFixture.py source  --vector V-01-a4-sym --out src.pdf
  python makeFixture.py correct --vector V-01-a4-sym --out ok.pdf

坐标系提醒：
  契约 D3 = PDF 用户空间（原点左下，Y 向上）。
  fitz 的 Rect 用【左上原点、Y 向下】。本文件所有 pdf→fitz 换算集中在 _pdf_rect_to_fitz()。
"""
import argparse
import json
import os
import sys

import fitz      # PyMuPDF —— 只用于 source 模式的画图
import pikepdf   # 只用于 correct 模式的放置（手写矩阵，不让库做几何决策）

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
VECTORS_PATH = os.path.join(REPO_ROOT, "docs", "margin_contract_vectors.json")

# 内容填充色：灰度 0.6 → RGB 153。
# 必须显著低于 measureMargins.mjs 的 brightnessMax=250，否则会被当成白底跳过。
FILL_GRAY = 0.6
MARKER_BLACK = 0.0


def load_vectors():
    with open(VECTORS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def find_vector(doc, vid):
    for v in doc["vectors"]:
        if v["id"] == vid:
            return v
    raise SystemExit(f"vector not found: {vid}")


def _pdf_rect_to_fitz(x, y, w, h, page_height):
    """
    PDF 用户空间矩形（原点左下）→ fitz Rect（原点左上）。
    这是全项目唯一允许的原点翻转点（契约 §1.1「坐标适配层」）。
    """
    return fitz.Rect(x, page_height - (y + h), x + w, page_height - y)


def build_source(vec, out_path):
    """
    生成源 PDF。

    注意 §1.4：向量里的 source.widthPt/heightPt 是【归一后】的有效可视尺寸。
    若 pageRotate%180==90，真实 MediaBox 必须是它的转置，再挂 /Rotate。
    """
    src = vec["input"]["source"]
    nw, nh = float(src["widthPt"]), float(src["heightPt"])
    rot = int(src.get("pageRotate", 0)) % 360

    if rot % 180 == 90:
        raw_w, raw_h = nh, nw   # 反归一：归一尺寸的转置才是真实 MediaBox
    else:
        raw_w, raw_h = nw, nh

    doc = fitz.open()
    page = doc.new_page(width=raw_w, height=raw_h)

    # ① 满版填充 —— 让 ink bbox 恰好等于页面 box，
    #    这样输出侧量到的 bbox 就是内容被放置后的真实位置。
    page.draw_rect(page.rect, color=None, fill=(FILL_GRAY, FILL_GRAY, FILL_GRAY))

    # ② 方向标记（仅供人工排错，不参与断言）：
    #    raw 页面左下角实心方块 + 顶边横条，用来一眼看出翻转/旋转。
    s = min(raw_w, raw_h) * 0.08
    page.draw_rect(_pdf_rect_to_fitz(0, 0, s, s, raw_h),
                   color=None, fill=(MARKER_BLACK,) * 3)
    page.draw_rect(_pdf_rect_to_fitz(0, raw_h - s * 0.35, s * 2.4, s * 0.35, raw_h),
                   color=None, fill=(MARKER_BLACK,) * 3)

    if rot:
        page.set_rotation(rot)

    doc.save(out_path)
    doc.close()
    return {"rawMediaBox": [raw_w, raw_h], "rotate": rot,
            "normalizedContent": [nw, nh]}


# 顺时针旋转的单位矩阵（PDF 用户空间，y 向上）。
# PDF 的 /Rotate 语义即"显示时顺时针旋转"，故归一与 Policy A 共用同一套。
#   phi=0   (x,y) -> ( x,  y)
#   phi=90  (x,y) -> ( y, -x)
#   phi=180 (x,y) -> (-x, -y)
#   phi=270 (x,y) -> (-y,  x)
_CW_UNIT = {
    0:   (1.0, 0.0, 0.0, 1.0),
    90:  (0.0, -1.0, 1.0, 0.0),
    180: (-1.0, 0.0, 0.0, -1.0),
    270: (0.0, 1.0, -1.0, 0.0),
}


def _similarity_matrix(box, phi, scale, cx, cy):
    """
    构造 INV-7a 允许的唯一形态：[s·cosθ, s·sinθ, -s·sinθ, s·cosθ, tx, ty]。

    把 box=(x0,y0,x1,y1) 顺时针旋 phi、等比缩 scale，再平移使其最小角落在 (cx, cy)。
    无 shear、无镜像、无非等比 —— 这是契约要求的形态，不是实现细节。

    box 取【form 的有效范围】而非源页 MediaBox：form 可能自带 /Matrix（见
    _form_extent），原点未必在 (0,0)，硬套 [0,w]x[0,h] 会算错平移量。
    """
    if phi not in _CW_UNIT:
        raise ValueError(f"phi must be one of 0/90/180/270, got {phi}")
    a0, b0, c0, d0 = _CW_UNIT[phi]
    a, b, c, d = a0 * scale, b0 * scale, c0 * scale, d0 * scale

    x0, y0, x1, y1 = box
    xs, ys = [], []
    for (px, py) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        xs.append(a * px + c * py)
        ys.append(b * px + d * py)
    e = cx - min(xs)
    f = cy - min(ys)
    return (a, b, c, d, e, f), (max(xs) - min(xs), max(ys) - min(ys))


def _form_extent(form):
    """
    算出 Form XObject 在【调用方坐标系】里的有效范围：/BBox 经 /Matrix 变换后的包围盒。

    为什么必须实测而不能假定 [0,w]x[0,h]：
      pikepdf/qpdf 的 as_form_xobject() 会把源页 /Rotate 折进 form 的 /Matrix，
      即 §1.4 归一【已由库完成】。若再按源页 raw MediaBox + pageRotate 叠一次旋转，
      就会双重旋转（V-07 曾据此产生 55.7mm 偏差）。
      这里读实际值 + 上层断言，把"库行为"从隐含假设变成可证事实。
    """
    bb = [float(v) for v in form.BBox]
    x0, y0 = min(bb[0], bb[2]), min(bb[1], bb[3])
    x1, y1 = max(bb[0], bb[2]), max(bb[1], bb[3])
    a, b, c, d, e, f = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    if "/Matrix" in form:
        a, b, c, d, e, f = (float(v) for v in form.Matrix)
    xs, ys = [], []
    for (px, py) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        xs.append(a * px + c * py + e)
        ys.append(b * px + d * py + f)
    return (min(xs), min(ys), max(xs), max(ys))


def build_correct(vec, out_path, src_path):
    """
    生成【已知正确】的输出：MediaBox == expected.mediaBox，
    源页作为【整页 Form XObject】经单次相似变换放置到 expected.contentBox，其余留白。

    几何全部读自向量（scale 用 scaleExact 的有理数），本函数不做任何 min/fit 运算。
    刻意【不用】fitz.show_pdf_page —— 实测该 API 在源页带 /Rotate 时会无视传入矩形的
    宽度（keep_proportion=False 亦然），把内容压成正方形。让绘图库替我们做几何，
    正是契约要禁止的第二解释点。
    """
    from fractions import Fraction

    exp = vec["expected"]
    mw = float(exp["mediaBox"]["widthPt"])
    mh = float(exp["mediaBox"]["heightPt"])
    cb = exp["contentBox"]
    cx, cy = float(cb["x"]), float(cb["y"])

    scale = float(Fraction(exp["scaleExact"]))   # 权威值取分数，浮点只是承载

    # phi 只取 Policy A 的业务旋转。
    # 源页 /Rotate 的 §1.4 归一【不在这里做】—— as_form_xobject 已折进 form /Matrix，
    # 下面的 _assert_normalized 负责证明这一点。两处都转 = 双重旋转。
    phi = int(vec["input"]["spec"].get("contentRotation", 0)) % 360

    src = pikepdf.open(src_path)
    src_page = pikepdf.Page(src.pages[0])
    mb = [float(v) for v in src_page.obj["/MediaBox"]]
    raw_w, raw_h = abs(mb[2] - mb[0]), abs(mb[3] - mb[1])

    out = pikepdf.new()
    page_obj = out.add_blank_page(page_size=(mw, mh))
    page = pikepdf.Page(page_obj)

    form = out.copy_foreign(src_page.as_form_xobject())
    name = page.add_resource(form, pikepdf.Name.XObject)

    fx0, fy0, fx1, fy1 = _form_extent(form)
    eff_w, eff_h = fx1 - fx0, fy1 - fy0

    # 自检 ①：form 的有效尺寸必须等于向量声明的 §1.4 归一尺寸。
    # 不通过就是库行为变了 —— 宁可 harness 报错，也不能悄悄产出错的"正确"fixture。
    want_w = float(vec["input"]["source"]["widthPt"])
    want_h = float(vec["input"]["source"]["heightPt"])
    if abs(eff_w - want_w) > 0.01 or abs(eff_h - want_h) > 0.01:
        raise RuntimeError(
            f"form extent {eff_w:.4f}x{eff_h:.4f} != §1.4 归一尺寸 "
            f"{want_w:.4f}x{want_h:.4f}（源 raw MediaBox {raw_w:.4f}x{raw_h:.4f}，"
            f"pageRotate={vec['input']['source'].get('pageRotate', 0)}）—— "
            f"as_form_xobject 的 /Rotate 归一行为与预期不符，先修 fixture 再谈几何")

    (a, b, c, d, e, f), (placed_w, placed_h) = _similarity_matrix(
        (fx0, fy0, fx1, fy1), phi, scale, cx, cy)

    # 自检 ②：落盘尺寸必须等于向量的 expected.contentBox 尺寸。
    exp_w, exp_h = float(cb["widthPt"]), float(cb["heightPt"])
    if abs(placed_w - exp_w) > 0.01 or abs(placed_h - exp_h) > 0.01:
        raise RuntimeError(
            f"placed {placed_w:.4f}x{placed_h:.4f} != expected.contentBox "
            f"{exp_w:.4f}x{exp_h:.4f}（phi={phi}, scale={scale}）")

    page.contents_add(
        f"q {a:.10f} {b:.10f} {c:.10f} {d:.10f} {e:.10f} {f:.10f} cm {name} Do Q".encode(),
        prepend=False)

    # R-1：输出 /Rotate 恒 0（add_blank_page 默认无 /Rotate，此处显式写死意图）
    page.obj["/Rotate"] = 0

    out.save(out_path)
    out.close()
    src.close()
    return {"mediaBox": [mw, mh], "srcRawMediaBox": [raw_w, raw_h],
            "formExtent": [fx0, fy0, fx1, fy1],
            "phi": phi, "scale": scale, "matrix": [a, b, c, d, e, f],
            "placedSize": [placed_w, placed_h],
            "expectedContentSize": [exp_w, exp_h]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["source", "correct"])
    ap.add_argument("--vector", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--src", help="correct 模式使用的源 PDF（默认同目录 <id>.src.pdf）")
    args = ap.parse_args()

    doc = load_vectors()
    vec = find_vector(doc, args.vector)

    try:
        if args.mode == "source":
            info = build_source(vec, args.out)
        else:
            src_path = args.src
            if not src_path:
                raise SystemExit("correct 模式必须提供 --src")
            info = build_correct(vec, args.out, src_path)
        print(json.dumps({"ok": True, "vector": args.vector,
                          "mode": args.mode, "out": args.out, "info": info}))
        return 0
    except Exception as e:  # noqa: BLE001
        import traceback
        print(json.dumps({"ok": False, "error": str(e),
                          "traceback": traceback.format_exc()}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
