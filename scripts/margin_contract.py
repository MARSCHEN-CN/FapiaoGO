#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
margin_contract.py — Print Margin Contract 唯一正确几何 executor（Phase 1-A，纯新增）

权威：docs/print_margin_contract.md v1.1 (FROZEN 2026-08-10)
向量：docs/margin_contract_vectors.json v1.0.1（expected 手工推导，禁止本模块生成期望值）

本文件是契约 §7.1 的「Python executor」：**唯一**允许实现 §1.1 公式 / §2.1a Policy A
与 §1.4 contentSize 归一（SG-2/SG-3 的落点）。任何 renderer / 打印入口不得内联重算。

Phase 1-A 纪律（用户批准）：
  - 纯新增，不修改 / 不删除 scripts/add-pdf-margins.py 的任何函数；
  - 不接打印链路（不改 fit、不改 Sumatra 参数、不改 electron 入口）；
  - 输出 /Rotate 恒 0（R-1）；内容旋转烤进相似变换矩阵（R-2，phi 只取 Policy A θ）。

分层：
  - 纯几何层（无 PDF 依赖，可单测）：policy_a / contain_fit / apply_margin_contract /
    compute_transform / mm_to_pt
  - PDF 适配层（pikepdf）：_form_extent / apply_pdf —— 只做「机械放置 + 断言」，
    **不做任何几何决策**（契约 §3：Python 载体层零业务知识）。

用法（DEV / Gate 用，pt 单位，与向量零转换误差）:
  python margin_contract.py --input in.pdf --output out.pdf \\
      --paper-width-pt 595.2756 --paper-height-pt 841.8898 \\
      --left-pt 28.35 --right-pt 28.35 --top-pt 28.35 --bottom-pt 28.35 \\
      [--content-rotation 90] [--allow-upscale]

⚠️ 禁止在本文件外再次实现：contain-fit 公式 / Policy A / mm_to_pt 算术（SG-2/SG-3）。
"""
import argparse
import json
import os
import sys
import traceback

import pikepdf

# ⭐ AP-DR-6: Annotation Preservation Shared Module (Content Integrity Patch)
sys.path.insert(0, os.path.join(__file__.rsplit("/", 1)[0] if "/" in __file__ else ".", "shared"))
from shared.flatten_annotations import flatten_stamp_annotations  # noqa: E402

# ────────────────────────────────────────────────────────────────────────────
# 纯几何层（无 PDF 依赖）—— 契约 §1.1 / §1.4 / §2.1a
# ────────────────────────────────────────────────────────────────────────────

PT_PER_MM = 72.0 / 25.4


def mm_to_pt(mm: float) -> float:
    """毫米 → pt。SG-3：本算术只允许出现在 contract 模块内。"""
    return mm * PT_PER_MM


def policy_a(paper_w_pt, paper_h_pt, margin_lrtb, content_rotation):
    """
    契约 §2.1a Policy A（Rotation Policy 的唯一实现）。

    θ % 180 == 0   → outputPaper = (paperW, paperH)    m' = [L, R, T, B]
    θ % 180 == 90  → outputPaper = (paperH, paperW)    m' = 顺时针轮换

    顺时针轮换方向（契约 §2.1 + MEMORY 实测锚点 rot0[L14.3,R10.6,T16,B17]
    → rot90[L17,R16,T14.3,B10.6]）：
      m' = [L',R',T',B'] = [B, T, L, R]
      （原下边 → 新左边，原上边 → 新右边，原左边 → 新上边，原右边 → 新下边）

    返回 (output_paper_wh, m'_lrtb)。纯函数，不涉及 PDF。
    """
    theta = int(content_rotation) % 360
    L, R, T, B = margin_lrtb
    if theta % 180 == 90:
        return (paper_h_pt, paper_w_pt), (B, T, L, R)
    return (paper_w_pt, paper_h_pt), (L, R, T, B)


def contain_fit(output_paper_wh, margin_lrtb, content_w, content_h, allow_upscale=False):
    """
    契约 §1.1 公式（含 ERRATA-1 的 allowUpscale clamp）。

      usableWidth  = paperWidth  - marginLeft - marginRight
      usableHeight = paperHeight - marginTop  - marginBottom
      sx = usableWidth  / contentWidth
      sy = usableHeight / contentHeight
      scale = allowUpscale ? min(sx, sy) : min(1, sx, sy)
      offsetX = marginLeft   + (usableWidth  - contentWidth  * scale) / 2
      offsetY = marginBottom + (usableHeight - contentHeight * scale) / 2

    ⚠️ 「禁止放大」只是 scale 上限，不是另一套布局分支：任一方向超出 usableRect，
    照常缩小（INV-3 / §1.1 反例注释）。返回 (scale, offset_x, offset_y)。
    """
    L, R, T, B = margin_lrtb
    paper_w, paper_h = output_paper_wh
    usable_w = paper_w - L - R
    usable_h = paper_h - T - B
    sx = usable_w / content_w
    sy = usable_h / content_h
    scale = min(sx, sy) if allow_upscale else min(1.0, sx, sy)
    offset_x = L + (usable_w - content_w * scale) / 2.0
    offset_y = B + (usable_h - content_h * scale) / 2.0
    return scale, offset_x, offset_y


def apply_margin_contract(paper_w_pt, paper_h_pt, margin_lrtb,
                          source_geometry, content_rotation=0, allow_upscale=False):
    """
    用户批准签名的实现（Phase 1-A）：
      输入 {paper, margin, source_geometry, rotation_policy}
      输出 {mediaBox, contentBox, scale, rotation: 0}

    source_geometry = §1.4 归一后的有效可视尺寸 {widthPt, heightPt}
      （归一由 PDF 适配层完成：CropBox else MediaBox，pageRotate%180==90 时宽高互换）

    内容旋转（R-2）：θ%180==90 时内容宽高随 Policy A 同步互换后再 contain-fit
    （V-04 实测锚点：源 595.28×841.89 + θ90 → 旋转后内容 841.89×595.28，
     scale=usableW/841.89 才等于 227/297）。
    """
    theta = int(content_rotation) % 360
    src_w = float(source_geometry["widthPt"])
    src_h = float(source_geometry["heightPt"])
    if theta % 180 == 90:
        content_w, content_h = src_h, src_w   # R-2：内容随纸面同步旋转
    else:
        content_w, content_h = src_w, src_h

    output_paper, m_prime = policy_a(paper_w_pt, paper_h_pt, margin_lrtb, theta)
    scale, offset_x, offset_y = contain_fit(
        output_paper, m_prime, content_w, content_h, allow_upscale)

    # usableRect 语义 = 契约 §3 / 向量 expected：**源纸空间**（D1，旋转前）。
    # rot0 时源纸空间 == 输出纸空间；rot90 才区分（V-04 expected.usableRect 是源纸空间）。
    # G-5 若需输出纸空间 usableRect，由 PDF 适配层用 contentBox 推导（Gate 5 范围）。
    L0, R0, T0, B0 = margin_lrtb
    usable_rect_source = {
        "x": L0, "y": B0,
        "widthPt": paper_w_pt - L0 - R0,
        "heightPt": paper_h_pt - T0 - B0,
    }

    return {
        "mediaBox": {"widthPt": output_paper[0], "heightPt": output_paper[1]},
        "contentBox": {
            "x": offset_x, "y": offset_y,
            "widthPt": content_w * scale, "heightPt": content_h * scale,
        },
        "scale": scale,
        "rotation": 0,  # R-1：输出 /Rotate 恒 0
        "usableRect": usable_rect_source,
        "policy": {
            "contentRotation": theta,
            "outputPaper": list(output_paper),
            "margin": list(m_prime),   # 顺时针轮换后的边距 [L',R',T',B']
            "contentRotated": bool(theta % 180 == 90),
        },
    }


# INV-7a 相似变换：仅允许 [s·cosθ, s·sinθ, -s·sinθ, s·cosθ, tx, ty]，θ∈{0,90,180,270}。
# 顺时针旋转单位矩阵（PDF 用户空间，y 向上；/Rotate 语义即顺时针）：
#   θ=0   (x,y) -> ( x,  y)
#   θ=90  (x,y) -> ( y, -x)
#   θ=180 (x,y) -> (-x, -y)
#   θ=270 (x,y) -> (-y,  x)
_CW_UNIT = {
    0:   (1.0, 0.0, 0.0, 1.0),
    90:  (0.0, -1.0, 1.0, 0.0),
    180: (-1.0, 0.0, 0.0, -1.0),
    270: (0.0, 1.0, -1.0, 0.0),
}


def compute_transform(src_rect, content_box, phi, scale):
    """
    构造 INV-7a 相似矩阵（与 Gate fixture 同一算法，这里是生产落点）。

    矩阵形态 [s·cosθ, s·sinθ, -s·sinθ, s·cosθ, tx, ty] —— 旋转与等比缩放一次合成，
    无 shear / 无镜像 / 无非等比（INV-7a）。

    src_rect    = 源对象有效范围 (x0, y0, x1, y1)（Form XObject 经 /Matrix 后的包围盒；
                  由 PDF 适配层实测，不做假定）
    content_box = apply_margin_contract 输出的目标放置矩形 {x, y, widthPt, heightPt}
    phi         = Policy A 业务旋转 θ（R-2 内容旋转角度）
    scale       = apply_margin_contract 输出的 scale（INV-7a 的 s）

    返回 (matrix, placed_size)。matrix 经 cm 运算符应用后，src_rect 的包围盒 == content_box。
    """
    if int(phi) % 360 not in _CW_UNIT:
        raise ValueError(f"phi must be one of 0/90/180/270, got {phi}")
    a0, b0, c0, d0 = _CW_UNIT[int(phi) % 360]
    a, b, c, d = a0 * scale, b0 * scale, c0 * scale, d0 * scale

    x0, y0, x1, y1 = src_rect
    xs, ys = [], []
    for (px, py) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        xs.append(a * px + c * py)
        ys.append(b * px + d * py)
    e = content_box["x"] - min(xs)
    f = content_box["y"] - min(ys)
    placed = (max(xs) - min(xs), max(ys) - min(ys))
    return (a, b, c, d, e, f), placed


# ────────────────────────────────────────────────────────────────────────────
# PDF 适配层（pikepdf）—— 只做机械放置 + 断言，零几何决策
# ────────────────────────────────────────────────────────────────────────────

def _form_extent(form):
    """
    Form XObject 在【调用方坐标系】的有效范围：/BBox 经 /Matrix 变换后的包围盒。

    为什么必须实测：qpdf/pikepdf 的 as_form_xobject() 会把源页 /Rotate 折进 form /Matrix
    （§1.4 归一是库完成的）。若按源页 raw MediaBox + pageRotate 再叠一次旋转 = 双重旋转
    （Gate 2 曾据此产生 55.7mm 偏差）。读实际值 + 上层断言，把库行为变成可证事实。
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


def _content_size(pdf_page):
    """
    契约 §1.4：contentSize = CropBox else MediaBox；pageRotate%180==90 时宽高互换。
    返回 (content_w, content_h, page_rotate, user_unit)。
    """
    rotate = int(pdf_page.get("/Rotate", 0)) % 360
    user_unit = float(pdf_page.get("/UserUnit", 1.0))
    if "/CropBox" in pdf_page:
        box = [float(v) for v in pdf_page.CropBox]
    else:
        box = [float(v) for v in pdf_page.MediaBox]
    w, h = abs(box[2] - box[0]), abs(box[3] - box[1])
    if rotate % 180 == 90:
        w, h = h, w
    return w, h, rotate, user_unit


def apply_pdf(src_path, out_path, paper_w_pt, paper_h_pt, margin_lrtb,
              content_rotation=0, allow_upscale=False, refuse_user_unit=True):
    """
    执行 margin contract 并产出 PDF。

    G-1：输出 /Rotate == 0（R-1）
    G-2：输出 MediaBox == Policy A outputPaper（0.1pt）
    G-4：源页 /UserUnit != 1 → 拒绝（refuse_user_unit=True 时 raise）
    G-3：源页 /Annots 存在 → 告警（防御性 P2，不阻断；注释见契约 §6）
    G-5（内容 bbox ⊆ usableRect）属 Gate 5 运行时 Guard 范围，本层不做光栅化断言。

    返回 info dict（供 Gate 报告）。任何 G 失败 raise（契约 §6：禁止降级为 warning）。
    """
    with pikepdf.open(src_path) as src:
        if len(src.pages) != 1:
            raise ValueError(f"margin contract 要求单页源，收到 {len(src.pages)} 页")

        src_page = pikepdf.Page(src.pages[0])
        content_w, content_h, page_rotate, user_unit = _content_size(src_page)
        if refuse_user_unit and user_unit != 1.0:
            raise ValueError(f"G-4: 源页 /UserUnit = {user_unit} != 1，拒绝处理（契约 §1.5）")
        if "/Annots" in src_page.obj and len(list(src_page.obj.get("/Annots", []))) > 0:
            # G-3 防御性 P2：Form XObject 变换不会移动 annotation，可能留在原位或被裁
            print(json.dumps({"warn": "G-3: 源页含 /Annots，Form XObject 不移动 annotation"
                                      "（契约 §6 G-3），若命中必须 flatten 或同步变换 Rect"}))

        geometry = apply_margin_contract(
            paper_w_pt, paper_h_pt, margin_lrtb,
            {"widthPt": content_w, "heightPt": content_h},
            content_rotation=content_rotation, allow_upscale=allow_upscale)

        # Form XObject 跨 Pdf 复制（src → out）：copy_foreign 目标必须是 out
        out = pikepdf.new()
        # ⭐ AP-DR-6: Annotation Preservation - Flatten Stamp AP before Form XObject
        flatten_count = flatten_stamp_annotations(src_page, src_pdf=src)
        if flatten_count > 0:
            print(f"[AP-DR-6] Flattened {flatten_count} Stamp annotation(s) into page contents", file=sys.stderr)
        form = out.copy_foreign(src_page.as_form_xobject())
        src_rect = _form_extent(form)

        # 自检：form 有效范围必须等于 §1.4 归一尺寸（库行为证明，而非假定）
        if (abs((src_rect[2] - src_rect[0]) - content_w) > 0.01
                or abs((src_rect[3] - src_rect[1]) - content_h) > 0.01):
            raise RuntimeError(
                f"form extent {(src_rect[2]-src_rect[0]):.4f}x"
                f"{(src_rect[3]-src_rect[1]):.4f} != §1.4 归一尺寸 "
                f"{content_w:.4f}x{content_h:.4f}（pageRotate={page_rotate}）")

        matrix, placed = compute_transform(
            src_rect, geometry["contentBox"],
            phi=int(content_rotation) % 360, scale=geometry["scale"])
    page_obj = out.add_blank_page(page_size=(
        geometry["mediaBox"]["widthPt"], geometry["mediaBox"]["heightPt"]))
    page = pikepdf.Page(page_obj)

    name = page.add_resource(form, pikepdf.Name.XObject)
    page.contents_add(
        f"q {matrix[0]:.10f} {matrix[1]:.10f} {matrix[2]:.10f} {matrix[3]:.10f} "
        f"{matrix[4]:.10f} {matrix[5]:.10f} cm {name} Do Q".encode(),
        prepend=False)

    # R-1：输出 /Rotate 恒 0（显式写死意图）
    page.obj["/Rotate"] = 0

    # G-1 / G-2 运行时断言（契约 §6：失败即 raise，不允许「边距加了但尺寸不对还继续」）
    assert int(page.obj.get("/Rotate", 0)) == 0, "G-1 失败：输出 /Rotate != 0"
    mb = [float(v) for v in page.obj.MediaBox]
    out_w, out_h = abs(mb[2] - mb[0]), abs(mb[3] - mb[1])
    exp_w = geometry["mediaBox"]["widthPt"]
    exp_h = geometry["mediaBox"]["heightPt"]
    if abs(out_w - exp_w) > 0.1 or abs(out_h - exp_h) > 0.1:
        raise RuntimeError(
            f"G-2 失败：输出 MediaBox {out_w:.4f}x{out_h:.4f} != "
            f"Policy A outputPaper {exp_w:.4f}x{exp_h:.4f}")

    out.save(out_path)
    out.close()

    return {
        "ok": True,
        "contentSize": [content_w, content_h],
        "geometry": geometry,
        "matrix": list(matrix),
        "placedSize": list(placed),
        "pageRotate": page_rotate,
    }


def main():
    ap = argparse.ArgumentParser(description="Print Margin Contract executor（Phase 1-A）")
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--paper-width-pt", type=float, required=True)
    ap.add_argument("--paper-height-pt", type=float, required=True)
    ap.add_argument("--left-pt", type=float, required=True)
    ap.add_argument("--right-pt", type=float, required=True)
    ap.add_argument("--top-pt", type=float, required=True)
    ap.add_argument("--bottom-pt", type=float, required=True)
    ap.add_argument("--content-rotation", type=int, default=0, choices=[0, 90, 180, 270])
    ap.add_argument("--allow-upscale", action="store_true", default=False)
    args = ap.parse_args()

    try:
        info = apply_pdf(
            args.input, args.output,
            args.paper_width_pt, args.paper_height_pt,
            (args.left_pt, args.right_pt, args.top_pt, args.bottom_pt),
            content_rotation=args.content_rotation,
            allow_upscale=args.allow_upscale,
        )
        print(json.dumps({"success": True, "path": args.output, "info": info}))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"success": False, "error": str(e),
                          "traceback": traceback.format_exc()}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
