#!/usr/bin/env python3
"""
placement_bake.py — PlacementBakeAdapter（C-2 Step 4-2a，DEV 验证；R-4.6-B 多页 enablement）

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
  2. 输入契约固定为 PlacementBakeSpec {source_pdf, paper, placement | pagePlacements, output_pdf}，
     不直接暴露 apply_margin_contract 内部结构。
  3. 输出契约：每页 MediaBox==paper / CropBox==paper / /Rotate=0 / placedRect==expectedRect。

⚠️ R-4.6-B 解冻（用户裁决，2026-08-25，Geometry consumer capability）：
  - 单页限制（len(src.pages)!=1 → raise）升级为 N page independent bake（Model A）。
  - 消费契约（方案 B，pageIndex 显式消费）：
      len(pagePlacements) == 1         → 同一 placement 应用于全部页（Model B 兼容）
      len(pagePlacements) == N(页数)   → sorted(pageIndex) == [0..N-1]，按 pageIndex 消费
      其余                             → raise（错误含 page index / placement count /
                                           source page count / reason，G3）
  - v1（仅 placement，无 pagePlacements）→ 归一 [{pageIndex:0, placement}]（单页源逐行
    等价 v1；多页源 = Model B 全页复用，替代旧 raise —— 用户契约明确允许）。
  - 单页 v1 路径零行为变化（G1）：同一输入 placement vs [placement] 输出逐字段一致。
════════════════════════════════════════════════════════════════════════

Placement 字段（RotationResolver.resolveContentPlacement 输出，px@dpi）：
  scale           float   适配比例（px 域）
  offset          {x, y}   px@dpi，左上角（mL, mT + 居中余量）
  placedRect      {x, y, w, h}  px@dpi，最终内容矩形（含 scale）
  layoutRotation  0 | -90  内容 vs 纸面的适配旋转（-90 = 内容横放竖纸需逆时针 90）
  renderRotation  number   SVG 施加旋转（归一 layoutRotation）
  canvasSize      {width, height} px@dpi，= 物理纸几何（needSwap 后）

pagePlacements（R-4.6-A v2 IPC 契约）：
  [{pageIndex: int(0-based 物理页序), placement: {...}}, ...]

单位换算：px@dpi → pt（÷dpi×72）。
"""
import argparse
import json
import os
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

# ⭐ AP-DR-6: Annotation Preservation Shared Module (Content Integrity Patch)
sys.path.insert(0, os.path.join(__file__.rsplit("/", 1)[0] if "/" in __file__ else ".", "shared"))
from shared.flatten_annotations import flatten_stamp_annotations  # noqa: E402

PT_PER_MM = 72.0 / 25.4

# R-4.6-B：placement 必填字段（G3：缺字段报错含 page index / counts / reason）
_PLACEMENT_REQUIRED = ("scale", "offset", "placedRect", "layoutRotation", "canvasSize")


def _px_to_pt(px, dpi):
    return px * 72.0 / dpi


def _process_placement_page(src_page, src_pdf, out, paper_w_pt, paper_h_pt, placement, dpi, page_index):
    """
    对单个源页执行 placement 烤入（R-4.6-B：从 v1 bake 主体逐行等价抽取，多页循环复用）。
    G-1 输出 /Rotate == 0；G-2 输出 MediaBox == paper（0.1pt）；G-4 /UserUnit != 1 拒绝。
    geometry 100% 来自 placement（Plan authority），禁止任何 margin/contain-fit 推导。
    """
    content_w, content_h, page_rotate, user_unit = _content_size(src_page)
    if user_unit != 1.0:
        raise ValueError(
            f"G-4: 源页 /UserUnit = {user_unit} != 1，拒绝处理（契约 §1.5）page_index={page_index}")

    # ⭐ AP-DR-6: Annotation Preservation - Flatten Stamp AP before Form XObject
    flatten_count = flatten_stamp_annotations(src_page, src_pdf=src_pdf)
    if flatten_count > 0:
        print(f"[AP-DR-6] Flattened {flatten_count} Stamp annotation(s) into page contents (page_index={page_index})", file=sys.stderr)

    form = out.copy_foreign(src_page.as_form_xobject())
    src_rect = _form_extent(form)

    # 自检：form 有效范围 == §1.4 归一尺寸（库行为证明，而非假定）
    if (abs((src_rect[2] - src_rect[0]) - content_w) > 0.01
            or abs((src_rect[3] - src_rect[1]) - content_h) > 0.01):
        raise RuntimeError(
            f"form extent {(src_rect[2]-src_rect[0]):.4f}x"
            f"{(src_rect[3]-src_rect[1]):.4f} != §1.4 归一 {content_w:.4f}x{content_h:.4f}"
            f"（page_index={page_index}, pageRotate={page_rotate}）")

    # 完整相似矩阵：placement 精确几何（offset/placedRect/layoutRotation/contentRotation）
    # —— RotationResolver 最终结果，只做坐标系搬运：px@dpi top-left → pt bottom-left。
    px_to_pt = 72.0 / dpi
    s = float(placement["scale"])
    layout_rot = int(placement.get("layoutRotation", 0))
    content_rot = int(placement.get("contentRotation", 0))
    # E1：bake 烤入 contentRotation + layoutRotation 的最终旋转（INV-R 违约修复）
    phi = (360 + content_rot + layout_rot) % 360
    if phi not in _CW_UNIT:
        raise ValueError(
            f"page_index={page_index}: contentRotation+layoutRotation {content_rot}+{layout_rot}"
            f" 不在 {{0,±90,180,270}}，phi={phi}")

    # 旋转+缩放后包围盒（compute_transform 原生：src_rect 经 R(phi)·S(scale)）
    matrix0, placed = compute_transform(src_rect, {"x": 0, "y": 0, "widthPt": 0, "heightPt": 0}, phi, s)
    placed_w, placed_h = placed

    # offset（px@dpi，top-left 左上角）→ pt
    off_x = float(placement["offset"]["x"]) * px_to_pt
    off_y = float(placement["offset"]["y"]) * px_to_pt
    # 旋转后包围盒中心（top-left）→ PDF bottom-left（y 翻转）
    center_x_svg = off_x + placed_w / 2
    center_y_svg = off_y + placed_h / 2
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

    # G-1 / G-2 运行时断言（契约 §6：失败即 raise）
    assert int(page.obj.get("/Rotate", 0)) == 0, f"G-1 失败：page_index={page_index} /Rotate != 0"
    mb = [float(v) for v in page.obj.MediaBox]
    out_w, out_h = abs(mb[2] - mb[0]), abs(mb[3] - mb[1])
    if abs(out_w - paper_w_pt) > 0.1 or abs(out_h - paper_h_pt) > 0.1:
        raise RuntimeError(
            f"G-2 失败：page_index={page_index} 输出 MediaBox {out_w:.4f}x{out_h:.4f} != "
            f"paper {paper_w_pt:.4f}x{paper_h_pt:.4f}")

    return {
        "ok": True,
        "pageIndex": page_index,
        "contentSize": [content_w, content_h],
        "contentBox": content_box,
        "placedSize": [round(placed[0], 4), round(placed[1], 4)],
        "matrix": list(matrix),
        "phi": phi,
        "expectedRect": {
            "x": round(off_x, 4), "y": round(off_y, 4),
            "w": round(placed_w, 4), "h": round(placed_h, 4),
        },
    }


def bake(spec):
    """
    PlacementBakeSpec → transformed PDF（R-4.6-B：N page independent bake）。

    spec = {
      "source_pdf": str,
      "output_pdf": str,
      "paper": {"widthMm": float, "heightMm": float},
      "placement": {...}          # v1 兼容（单页）；R-4.6-A processor 双发射仍含
      "pagePlacements": [         # v2：逐页 [{pageIndex, placement}]（D3 显式 pageIndex）
        {"pageIndex": int, "placement": {...}}, ...
      ],                          # 可选；缺省回落 v1 placement
      "dpi": int,                 # placement 坐标域（默认 300）
    }

    消费契约（方案 B，用户裁决 2026-08-25）：
      len(pagePlacements) == 1         → 同一 placement 应用于全部页（Model B 兼容）
      len(pagePlacements) == len(pages)→ sorted(pageIndex) == [0..N-1]，按 pageIndex 消费
      其余                             → raise（G3：错误含 page index / placement count /
                                           source page count / reason）
    v1（仅 placement）→ 归一 [{pageIndex:0, placement}]（单页源逐行等价；多页源 = Model B
    全页复用，替代旧「要求单页源」raise）。
    """
    src_path = spec["source_pdf"]
    out_path = spec["output_pdf"]
    paper_mm = spec["paper"]
    dpi = spec.get("dpi", 300)

    paper_w_pt = paper_mm["widthMm"] * PT_PER_MM
    paper_h_pt = paper_mm["heightMm"] * PT_PER_MM

    # ── v1/v2 归一（R-4.6-A processor 已双发射；直接 CLI 调用 v1 单 placement 也兼容）──
    raw = spec.get("pagePlacements")
    if raw is None:
        raw = [{"pageIndex": 0, "placement": spec["placement"]}]
    if not isinstance(raw, list) or len(raw) == 0:
        raise ValueError("placement bake: pagePlacements 必须为非空数组（count=0）")

    with pikepdf.open(src_path) as src:
        n = len(src.pages)
        if n == 0:
            raise ValueError("placement bake: 源 PDF 0 页，拒绝处理")

        # ── 消费契约（方案 B）──
        if len(raw) == 1:
            # Model B 兼容：同一 placement 应用于全部页
            shared = raw[0]["placement"]
            plan = [{"pageIndex": i, "placement": shared} for i in range(n)]
        else:
            idxs = sorted(item["pageIndex"] for item in raw)
            if idxs != list(range(n)):
                raise ValueError(
                    f"placement bake: pagePlacements 页序不连续 —— pageIndex={idxs}, "
                    f"source page count={n}, placement count={len(raw)}"
                    f"（要求 [0..{n-1}]，D3 方案 B 显式消费）")
            plan = [dict(item) for item in raw]

        # ── G3：placement 字段完整预检（报错含 page index / counts / reason）──
        for item in plan:
            p = item["placement"]
            missing = [k for k in _PLACEMENT_REQUIRED if k not in p]
            if missing:
                raise ValueError(
                    f"placement bake: pageIndex={item['pageIndex']} placement 缺字段 {missing}"
                    f"（placement count={len(plan)}, source page count={n}）")

        # ── 逐页烤入（每页独立 placement 几何，异构页尺寸天然支持）──
        out = pikepdf.new()
        infos = []
        for item in plan:
            pi = item["pageIndex"]
            src_page = pikepdf.Page(src.pages[pi])
            infos.append(_process_placement_page(
                src_page, src, out, paper_w_pt, paper_h_pt, item["placement"], dpi, pi))
        out.save(out_path)
        out.close()

    # ── 输出契约断言（每页，不是只看 PDF size！）──
    # 4.1 MediaBox == target paper（0.1pt）；/Rotate == 0（R-1）
    verify = pikepdf.open(out_path)
    try:
        for idx, vp in enumerate(verify.pages):
            mb = [float(v) for v in vp.MediaBox]
            cb = [float(v) for v in (vp.CropBox if "/CropBox" in vp else vp.MediaBox)]
            out_w, out_h = abs(mb[2] - mb[0]), abs(mb[3] - mb[1])
            cb_w, cb_h = abs(cb[2] - cb[0]), abs(cb[3] - cb[1])
            rot = int(vp.get("/Rotate", 0))
            if abs(out_w - paper_w_pt) > 0.1 or abs(out_h - paper_h_pt) > 0.1:
                raise RuntimeError(
                    f"page {idx}: MediaBox {out_w:.4f}x{out_h:.4f} != paper {paper_w_pt:.4f}x{paper_h_pt:.4f}")
            if abs(cb_w - paper_w_pt) > 0.1 or abs(cb_h - paper_h_pt) > 0.1:
                raise RuntimeError(
                    f"page {idx}: CropBox {cb_w:.4f}x{cb_h:.4f} != paper {paper_w_pt:.4f}x{paper_h_pt:.4f}")
            if rot != 0:
                raise RuntimeError(f"page {idx}: /Rotate = {rot} != 0（R-1）")
    finally:
        verify.close()

    first = infos[0]
    result = {
        "ok": True,
        "mediaBox": [round(paper_w_pt, 4), round(paper_h_pt, 4)],
        "cropBox": [round(paper_w_pt, 4), round(paper_h_pt, 4)],
        "rotate": 0,
        "pageCount": n,
        "pages": infos,
        # v1 兼容：单页消费方取首页字段（processor / Gate 现有消费点零变化）
        "contentBox": first["contentBox"],
        "placedSize": first["placedSize"],
        "expectedRect": first["expectedRect"],
        "phi": first["phi"],
    }
    return result


def main():
    ap = argparse.ArgumentParser(description="PlacementBakeAdapter（C-2 Step 4-2a；R-4.6-B 多页）")
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
        if "placement" not in spec and "pagePlacements" not in spec:
            print(json.dumps({"success": False, "error": "placement-file 缺 placement/pagePlacements 字段"}))
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
