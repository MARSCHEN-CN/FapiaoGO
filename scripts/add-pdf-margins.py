#!/usr/bin/env python
"""
add-pdf-margins.py — 打印安全边距兼容壳（Phase 1-B Step 2）

⚠️ 本文件不再包含任何几何实现。全部几何转交 scripts/margin_contract.py
（契约 §7.1：唯一 executor，INV-4 环境一致性）。

历史（见 git c7e25fd..HEAD）：
  - 旧「页面边界外扩」实现已删除 —— 那是错误业务模型，不是打印安全边距
  - 旧 PIL 直接生成带边距 PDF 的 fallback 已删除 —— 双语义根源
  - margin==0 短路复制已删除 —— 违反 INV-6（margin=0 仍走 contain-fit）
  - orientation 不再决定纸张方向 —— 旧「orientation→A4」是 rotation bug 同类风险；
    目标纸由调用方显式传入（paper_w_mm/paper_h_mm），CLI 保留 --orientation 仅为
    兼容旧调用方（忽略并告警，不参与几何）。

结构：
  add_margins()
      ↓
  MarginExecutor（margin_contract.apply_pdf，唯一几何来源）
      ↓
  +-- PDF adapter（源 PDF → apply_pdf）
  +-- Image adapter（图片 → 原始尺寸 PDF → apply_pdf）

用法:
  python add-pdf-margins.py --input in.pdf --output out.pdf \
      --left 10 --right 5 --top 30 --bottom 10 \
      [--paper-width-mm 210 --paper-height-mm 297] [--content-rotation 90]

  paper 缺省（仅 PDF 路径允许）：目标纸 = 源页 MediaBox（不换纸，V-01 语义）。
  图片路径 paper 必填（旧 orientation 推断已废弃）。
"""
import argparse
import json
import os
import sys
import tempfile
import traceback

try:
    import pikepdf
except ImportError:
    print(json.dumps({"success": False, "error": "pikepdf not installed"}))
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    Image = None

# 唯一几何来源（契约 §7.1 / I-1）。mm→pt 算术只允许出现在 margin_contract 内（SG-3）。
from margin_contract import apply_pdf, mm_to_pt  # noqa: E402


# ── PDF adapter ────────────────────────────────────────────────────────────

def _probe_media_box_pt(pdf_path):
    """读单页源 PDF 的 MediaBox（pt）。用于「目标纸 = 源纸」的显式兜底。"""
    with pikepdf.open(pdf_path) as pdf:
        if len(pdf.pages) != 1:
            raise ValueError(f"margin contract 要求单页源，收到 {len(pdf.pages)} 页")
        page = pdf.pages[0]
        box = [float(v) for v in page.obj["/MediaBox"]]
    return abs(box[2] - box[0]), abs(box[3] - box[1])


def _apply_to_pdf(pdf_path, out_path, left_mm, right_mm, top_mm, bottom_mm,
                  paper_w_mm=None, paper_h_mm=None, rotation=0):
    """
    把 margin contract 应用到单页 PDF。paper 缺省时目标纸 = 源 MediaBox。
    返回 apply_pdf 的 info dict。
    """
    if paper_w_mm is not None and paper_h_mm is not None:
        paper_w_pt = mm_to_pt(paper_w_mm)
        paper_h_pt = mm_to_pt(paper_h_mm)
    else:
        paper_w_pt, paper_h_pt = _probe_media_box_pt(pdf_path)
    margin_pt = (mm_to_pt(left_mm), mm_to_pt(right_mm),
                 mm_to_pt(top_mm), mm_to_pt(bottom_mm))
    return apply_pdf(pdf_path, out_path, paper_w_pt, paper_h_pt, margin_pt,
                     content_rotation=rotation)


# ── Image adapter ──────────────────────────────────────────────────────────

def _image_to_pdf_native_size(img_path):
    """
    图片 →「图片原始物理尺寸」的 PDF（无页面适配，零几何）。
    两种载体必须产出相同 MediaBox（INV-4 / B2）：
      ① img2pdf：convert 不带 layout_fun（默认按图片 DPI，无则 72dpi → 1px=1pt）
      ② PIL    ：save PDF + resolution=(img dpi, 72 缺省)，与 img2pdf 对齐
    几何全部留给 margin_contract 决定 —— 这里不做任何 contain / 页面适配。
    返回临时 PDF 路径。
    """
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    tmp_path = tmp.name
    tmp.close()

    try:
        import img2pdf
        pdf_bytes = img2pdf.convert([img_path])  # 无 layout_fun：原始尺寸
        with open(tmp_path, "wb") as f:
            f.write(pdf_bytes)
        return tmp_path
    except ImportError:
        if Image is None:
            raise RuntimeError("img2pdf 与 PIL 均不可用，无法处理图片")
        with Image.open(img_path) as img:
            # dpi 对齐 img2pdf 的 pil_get_dpi（img2pdf.py L1446-1478）：
            #   ndpi = img.info.get("dpi") → int(round(...))
            # 必须 round —— PNG pHYs 以整数 ppm 存 dpi（72dpi → 2835ppm → 读回 72.009），
            # 不 round 会导致 MediaBox 差 ~0.1pt（72.009 问题，img2pdf 源码注释同源）。
            dpi = img.info.get("dpi", (72.0, 72.0))
            if isinstance(dpi, tuple) and len(dpi) == 2:
                dpi = int(round(float(dpi[0]))) or 72
            else:
                dpi = int(round(float(dpi))) or 72
            # RGB 化（处理 RGBA/LA/P 透明通道 → 白底）
            rgb = img.convert("RGBA")
            bg = Image.new("RGB", rgb.size, (255, 255, 255))
            bg.paste(rgb, mask=rgb.split()[-1])
            # 原始像素尺寸 + round 后的图片 DPI → 页面尺寸与 img2pdf 语义一致（B2 断言）
            bg.save(tmp_path, "PDF", resolution=dpi)
        return tmp_path


# ── 兼容壳入口 ─────────────────────────────────────────────────────────────

def add_margins(input_path, output_path,
                left_mm=0, right_mm=0, top_mm=0, bottom_mm=0,
                is_image=False, paper_w_mm=None, paper_h_mm=None,
                rotation=0) -> dict:
    """
    打印安全边距兼容壳。唯一几何来源 = margin_contract.apply_pdf。

    Args:
        input_path: 源文件（PDF 或图片）
        output_path: 输出 PDF
        left_mm/right_mm/top_mm/bottom_mm: 边距（mm）
        is_image: 输入是否为图片
        paper_w_mm/paper_h_mm: 目标物理纸尺寸（mm）。PDF 路径缺省 → 目标纸 = 源 MediaBox；
            图片路径必填（旧 orientation 推断已废弃）。
        rotation: Policy A 内容旋转（0/90/180/270）。默认 0（RG-1：Phase 1 rot0）。

    Returns:
        {"success": True, "path": output_path, "info": {...}}
        或 {"success": False, "error": "..."}
    """
    try:
        temp_pdf = None
        try:
            if is_image:
                # ── Image adapter ──
                if paper_w_mm is None or paper_h_mm is None:
                    return {"success": False,
                            "error": "图片路径必须显式提供目标纸 (--paper-width-mm/--paper-height-mm)。"
                                     "旧的 orientation→A4 推断已废弃（rotation bug 同类风险）。"}
                temp_pdf = _image_to_pdf_native_size(input_path)
                info = _apply_to_pdf(temp_pdf, output_path,
                                     left_mm, right_mm, top_mm, bottom_mm,
                                     paper_w_mm, paper_h_mm, rotation)
            else:
                # ── PDF adapter ──
                info = _apply_to_pdf(input_path, output_path,
                                     left_mm, right_mm, top_mm, bottom_mm,
                                     paper_w_mm, paper_h_mm, rotation)
            return {"success": True, "path": output_path, "info": info}
        finally:
            if temp_pdf and os.path.exists(temp_pdf):
                try:
                    os.unlink(temp_pdf)
                except OSError:
                    pass
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def main():
    parser = argparse.ArgumentParser(
        description="打印安全边距（兼容壳 → margin_contract executor）")
    parser.add_argument("--input", "-i", required=True)
    parser.add_argument("--output", "-o", required=True)
    parser.add_argument("--left", type=float, default=0, help="左边距（mm）")
    parser.add_argument("--right", type=float, default=0, help="右边距（mm）")
    parser.add_argument("--top", type=float, default=0, help="上边距（mm）")
    parser.add_argument("--bottom", type=float, default=0, help="下边距（mm）")
    parser.add_argument("--is-image", action="store_true", default=False)
    parser.add_argument("--paper-width-mm", type=float, default=None,
                        help="目标纸宽（mm）。PDF 缺省=源 MediaBox；图片必填")
    parser.add_argument("--paper-height-mm", type=float, default=None,
                        help="目标纸高（mm）。PDF 缺省=源 MediaBox；图片必填")
    parser.add_argument("--content-rotation", type=int, default=0,
                        choices=[0, 90, 180, 270],
                        help="Policy A 内容旋转（RG-1：Phase 1 范围 rot0）")
    parser.add_argument("--orientation", choices=['portrait', 'landscape', 'auto'],
                        default='auto',
                        help="⚠️ 已废弃：不再参与几何（旧 orientation→A4 推断移除）。"
                             "仅保留参数位兼容旧调用方。")

    args = parser.parse_args()

    if args.orientation != 'auto':
        print(json.dumps({"warn": "--orientation 已废弃，不再决定纸张方向；"
                                   "目标纸请用 --paper-width-mm/--paper-height-mm 显式传入"}))

    img_exts = {".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif"}
    ext = os.path.splitext(args.input)[1].lower()
    is_image = args.is_image or ext in img_exts

    result = add_margins(
        args.input, args.output,
        left_mm=args.left, right_mm=args.right,
        top_mm=args.top, bottom_mm=args.bottom,
        is_image=is_image,
        paper_w_mm=args.paper_width_mm, paper_h_mm=args.paper_height_mm,
        rotation=args.content_rotation,
    )

    print(json.dumps(result))
    if not result.get("success"):
        sys.exit(1)


if __name__ == "__main__":
    main()
