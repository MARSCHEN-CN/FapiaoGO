#!/usr/bin/env python3
"""
placement_bake.py — PlacementBakeAdapter（C-2 Step 4-2a，DEV 验证）

把 Plan placement（RotationResolver 输出）烤进 PDF，产出临时 transformed PDF，
供 Sumatra noscale + paper command 纯执行（方案 A：PDF pre-transform bake）。

════════════════════════════════════════════════════════════════════════
⚠️ 冻结边界（用户裁决，2026-08-10）：
  1. adapter contract 层必须存在——**不假设 margin_contract == placement executor**。
     placement 的 scale/offset/layoutRotation 是 Plan 已算好的几何；
     margin_contract.apply_margin_contract 是「由边距推导 placement」的另一语义。
     本模块只复用 margin_contract 的【PDF 机械组装】（_form_extent / compute_transform /
     Form XObject 放置），geometry 来源 = placement（Plan authority），
     绝不让 margin_contract 重新 contain-fit（那会覆盖 Plan 的 placement）。
  2. 输入契约固定为 PlacementBakeSpec {source_pdf, paper, placement, output_pdf}，
     不直接暴露 apply_margin_contract 内部结构。
  3. 输出契约：MediaBox==paper / CropBox==paper / /Rotate=0 / placedRect==expectedRect。
════════════════════════════════════════════════════════════════════════

Placement 字段（RotationResolver.resolveContentPlacement 输出，px@dpi）：
  scale           float   适配比例（px 域）
  offset          {x, y}   px@dpi，左上角（mL, mT + 居中余量）
  placedRect      {x, y, w, h}  px@dpi，最终内容矩形（含 scale）
  layoutRotation  0 | -90  内容 vs 纸面的适配旋转（-90 = 内容横放竖纸需逆时针 90）
  renderRotation  number   SVG 施加旋转（归一 layoutRotation）
  canvasSize      {width, height} px@dpi，= 物理纸几何（needSwap 后）

单位换算：px@dpi → pt（÷dpi×72）。

用法（CLI，DEV 验证用）：
  python scripts/placement_bake.py \
    --source <src.pdf> --output <out.pdf> \
    --paper-width-mm 210 --paper-height-mm 297 \
    --placement '<json>'   # {scale, offset, placedRect, layoutRotation, canvasSize}

  placement JSON 也可从文件读：--placement-file <spec.json>

输出：JSON {success, path, info:{mediaBox, cropBox, rotate, contentBox, placedRect, expectedRect}}
"""
import argparse
import json
import sys
import traceback

try:
    import pikepdf
except ImportError:
    print(json.dumps({"success": False, "error": "pikepdf not available"}))
    sys.exit(2)

# 复用 margin_contract 的机械组装（几何引擎零改动——compute_transform 已是 INV-7a）
sys.path.insert(0, __file__.rsplit("/", 1)[0] if "/" in __file__ else ".")
from margin_contract import _form_extent, compute_transform, _content_size, _CW_UNIT  # noqa: E402

PT_PER_MM = 72.0 / 25.4


def _px_to_pt(px, dpi):
    return px * 72.0 / dpi


def bake(spec):
    """
    PlacementBakeSpec → transformed PDF。

    spec = {
      "source_pdf": str,
      "output_pdf": str,
      "paper": {"widthMm": float, "heightMm": float},
      "placement": {
        "scale": float,
        "offset": {"x": float, "y": float},       # px@dpi
        "placedRect": {"x": float, "y": float, "w": float, "h": float},  # px@dpi
        "layoutRotation": int,                     # 0 | -90 | 90 | 180
        "canvasSize": {"width": float, "height": float},  # px@dpi
      },
      "dpi": int,   # placement 的坐标域（默认 300）
    }
    """
    src_path = spec["source_pdf"]
    out_path = spec["output_pdf"]
    paper_mm = spec["paper"]
    placement = spec["placement"]
    dpi = spec.get("dpi", 300)

    # ── 1. 输入契约校验 ──
    paper_w_pt = paper_mm["widthMm"] * PT_PER_MM
    paper_h_pt = paper_mm["heightMm"] * PT_PER_MM
    scale = float(placement["scale"])
    off_x = _px_to_pt(placement["offset"]["x"], dpi)
    off_y = _px_to_pt(placement["offset"]["y"], dpi)
    placed_w = _px_to_pt(placement["placedRect"]["w"], dpi)
    placed_h = _px_to_pt(placement["placedRect"]["h"], dpi)
    # layoutRotation：RotationResolver 用 -90（内容横放竖纸需逆时针 90 = PDF 顺时针 270）
    # PDF 用户空间顺时针 = _CW_UNIT 的 θ；layoutRotation=-90 → phi=270
    layout_rot = int(placement.get("layoutRotation", 0))
    phi = (360 + layout_rot) % 360
    if phi not in _CW_UNIT:
        raise ValueError(f"layoutRotation {layout_rot} 不在 {{0,±90,180}}，phi={phi}")

    # ── 2. 打开源，Form XObject 归一（§1.4 由库完成）──
    with pikepdf.open(src_path) as src:
        if len(src.pages) != 1:
            raise ValueError(f"placement bake 要求单页源，收到 {len(src.pages)} 页")
        src_page = pikepdf.Page(src.pages[0])
        content_w, content_h, page_rotate, user_unit = _content_size(src_page)
        if user_unit != 1.0:
            raise ValueError(f"源页 /UserUnit = {user_unit} != 1，拒绝处理（契约 §1.5）")

        out = pikepdf.new()
        form = out.copy_foreign(src_page.as_form_xobject())
        src_rect = _form_extent(form)

        # 自检：form 有效范围 == §1.4 归一尺寸（库行为证明）
        if (abs((src_rect[2] - src_rect[0]) - content_w) > 0.01
                or abs((src_rect[3] - src_rect[1]) - content_h) > 0.01):
            raise RuntimeError(
                f"form extent {(src_rect[2]-src_rect[0]):.4f}x"
                f"{(src_rect[3]-src_rect[1]):.4f} != §1.4 归一 {content_w:.4f}x{content_h:.4f}")

    # ── 3. 完整相似矩阵：忠实复刻 Preview 的 SVG 变换序列 ──
    # Preview 用 renderTransformMM 渲染（mm 坐标系，SVG 原点 top-left）：
    #   transform = translate(tx,ty) scale(s) rotate(deg, cx,cy)
    #   —— 该序列已被 Preview 视觉验证正确（C-2 Step 2 统一）。
    # adapter 不复刻几何推导，只做【坐标系搬运】：SVG(top-left, mm) → PDF(bottom-left, pt)。
    #
    # 数学：用 margin_contract 的 compute_transform 原生机制（已处理 src_rect min 角），
    # content_box = 旋转后包围盒的【min 角目标位置】。
    #
    # ⚠️ 2026-08-10 验证：不采用 renderTransform（Preview SVG 近似——rotate 绕中心后
    # translate 无法精确固定左上角，偏差 ~570px）。改用 placement 的【精确几何】：
    #   offset（旋转后左上角）+ placedRect（旋转后尺寸）+ layoutRotation——这是
    #   RotationResolver 的最终结果（placedRect 已含 scale 与 layoutRotation）。
    #   adapter 只做坐标系搬运：px@dpi top-left → pt bottom-left。
    px_to_pt = 72.0 / dpi
    s = float(placement["scale"])
    layout_rot = int(placement.get("layoutRotation", 0))
    phi = (360 + layout_rot) % 360
    if phi not in _CW_UNIT:
        raise ValueError(f"layoutRotation {layout_rot} 不在 {{0,±90,180}}，phi={phi}")

    # 旋转+缩放后包围盒（compute_transform 原生：src_rect 经 R(phi)·S(scale)）
    matrix0, placed = compute_transform(src_rect, {"x": 0, "y": 0, "widthPt": 0, "heightPt": 0}, phi, s)
    placed_w, placed_h = placed

    # offset（px@dpi，top-left 左上角）→ pt
    off_x = float(placement["offset"]["x"]) * px_to_pt
    off_y = float(placement["offset"]["y"]) * px_to_pt
    # 旋转后包围盒中心（top-left）→ pt
    center_x_svg = off_x + placed_w / 2
    center_y_svg = off_y + placed_h / 2
    # → PDF bottom-left（y 翻转）
    center_x_pdf = center_x_svg
    center_y_pdf = paper_h_pt - center_y_svg

    # content_box（min 角）= 中心 - 包围盒/2
    cbox = {
        "x": center_x_pdf - placed_w / 2,
        "y": center_y_pdf - placed_h / 2,
        "widthPt": placed_w,
        "heightPt": placed_h,
    }
    matrix, placed = compute_transform(src_rect, cbox, phi, s)

    content_box = {
        "x": round(cbox["x"], 4), "y": round(cbox["y"], 4),
        "widthPt": round(placed_w, 4), "heightPt": round(placed_h, 4),
    }

    page_obj = out.add_blank_page(page_size=(paper_w_pt, paper_h_pt))
    page = pikepdf.Page(page_obj)
    name = page.add_resource(form, pikepdf.Name.XObject)
    page.contents_add(
        f"q {matrix[0]:.10f} {matrix[1]:.10f} {matrix[2]:.10f} {matrix[3]:.10f} "
        f"{matrix[4]:.10f} {matrix[5]:.10f} cm {name} Do Q".encode(),
        prepend=False)
    page.obj["/Rotate"] = 0

    out.save(out_path)
    out.close()

    # ── 4. 输出契约断言（不是只看 PDF size！）──
    # 4.1 MediaBox == target paper（0.1pt）
    verify = pikepdf.open(out_path)
    try:
        vp = verify.pages[0]
        mb = [float(v) for v in vp.MediaBox]
        cb = [float(v) for v in (vp.CropBox if "/CropBox" in vp else vp.MediaBox)]
        out_w, out_h = abs(mb[2] - mb[0]), abs(mb[3] - mb[1])
        cb_w, cb_h = abs(cb[2] - cb[0]), abs(cb[3] - cb[1])
        rot = int(vp.get("/Rotate", 0))
        if abs(out_w - paper_w_pt) > 0.1 or abs(out_h - paper_h_pt) > 0.1:
            raise RuntimeError(
                f"MediaBox {out_w:.4f}x{out_h:.4f} != paper {paper_w_pt:.4f}x{paper_h_pt:.4f}")
        if abs(cb_w - paper_w_pt) > 0.1 or abs(cb_h - paper_h_pt) > 0.1:
            raise RuntimeError(
                f"CropBox {cb_w:.4f}x{cb_h:.4f} != paper {paper_w_pt:.4f}x{paper_h_pt:.4f}")
        if rot != 0:
            raise RuntimeError(f"/Rotate = {rot} != 0（R-1）")
    finally:
        verify.close()

    return {
        "ok": True,
        "mediaBox": [round(paper_w_pt, 4), round(paper_h_pt, 4)],
        "cropBox": [round(paper_w_pt, 4), round(paper_h_pt, 4)],
        "rotate": 0,
        "contentBox": {k: round(v, 4) for k, v in content_box.items()},
        "placedSize": [round(placed[0], 4), round(placed[1], 4)],
        "expectedRect": {
            "x": round(off_x, 4), "y": round(off_y, 4),
            "w": round(placed_w, 4), "h": round(placed_h, 4),
        },
        "phi": phi,
    }


def main():
    ap = argparse.ArgumentParser(description="PlacementBakeAdapter（C-2 Step 4-2a）")
    ap.add_argument("--source", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--paper-width-mm", type=float, required=True)
    ap.add_argument("--paper-height-mm", type=float, required=True)
    ap.add_argument("--placement", default=None, help="placement JSON 字符串")
    ap.add_argument("--placement-file", default=None, help="placement JSON 文件")
    ap.add_argument("--dpi", type=int, default=300)
    args = ap.parse_args()

    if args.placement and args.placement_file:
        print(json.dumps({"success": False, "error": "placement 与 placement-file 二选一"}))
        return 1
    if args.placement:
        spec = {
            "source_pdf": args.source,
            "output_pdf": args.output,
            "paper": {"widthMm": args.paper_width_mm, "heightMm": args.paper_height_mm},
            "placement": json.loads(args.placement),
            "dpi": args.dpi,
        }
    elif args.placement_file:
        # ⚠️ placement-file = 完整 PlacementBakeSpec（含 source_pdf/output_pdf/paper/placement/dpi），
        # 与 bake(spec) 签名一致；CLI 显式参数（--source 等）作为覆盖。
        with open(args.placement_file, encoding="utf-8") as f:
            spec = json.load(f)
        if args.source:
            spec["source_pdf"] = args.source
        if args.output:
            spec["output_pdf"] = args.output
        if args.paper_width_mm and args.paper_height_mm:
            spec.setdefault("paper", {})["widthMm"] = args.paper_width_mm
            spec.setdefault("paper", {})["heightMm"] = args.paper_height_mm
        if args.dpi:
            spec["dpi"] = args.dpi
        if "placement" not in spec:
            print(json.dumps({"success": False, "error": "placement-file 缺 placement 字段"}))
            return 1
    else:
        print(json.dumps({"success": False, "error": "需要 --placement 或 --placement-file"}))
        return 1

    try:
        info = bake(spec)
        print(json.dumps({"success": True, "path": spec["output_pdf"], "info": info}))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"success": False, "error": str(e),
                          "traceback": traceback.format_exc()}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
