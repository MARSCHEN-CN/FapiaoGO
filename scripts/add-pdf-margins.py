#!/usr/bin/env python
"""
add-pdf-margins.py — 给 PDF 各边分别添加安全边距（白边）

原理：
  扩展页面的 MediaBox，内容位置不变，四边各增加指定宽度的白边。
  PDF 坐标系原点在左下角，Y 向上增长。Box = [左, 下, 右, 上]，单位 pt。

  例如 MediaBox [0, 0, 595, 842]（A4）左+5mm 后变为 [-14.17, 0, 595, 842]，
  右+3mm 后变为 [0, 0, 603.78, 842]。页面变大了，内容仍在原始位置。

用法:
  python add-pdf-margins.py --input in.pdf --output out.pdf \\
      --left 5 --right 3 --top 3 --bottom 8

支持输入:
  - PDF 文件 (*.pdf) — 直接扩展 MediaBox
  - 图片文件 (*.png, *.jpg, *.jpeg, *.bmp, *.tiff) — 先转 PDF 再扩展

图片处理策略:
  - 图片方向自动检测：横向图片 → 横向 A4 (297×210mm)，竖向图片 → 竖向 A4 (210×297mm)
  - 优先使用 img2pdf（无损嵌入图片到 PDF）→ 再经 pikepdf 扩展 MediaBox
  - img2pdf 不可用时，用 PIL 直接生成最终尺寸 PDF（含方向+边距），跳过 pikepdf
  - 可通过 --orientation 强制指定方向，覆盖自动检测

注意事项:
  - 不处理页面旋转（/Rotate）。如果页面有 90°/270° 旋转，边距的物理方向
    可能不符合直觉（旋转后"左"边距实际对应的是物理上的"下"）。
  - TIFF 多页图片仅处理第一页。
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


def mm_to_pt(mm: float) -> float:
    """毫米 → 点 (1 inch = 25.4 mm = 72 pt)"""
    return mm / 25.4 * 72


def _detect_image_orientation(img, orientation_hint: str = 'auto') -> str:
    """
    确定图片页面方向。

    Args:
        img: PIL Image 对象
        orientation_hint: 'auto' | 'portrait' | 'landscape'

    Returns:
        'portrait' | 'landscape'
    """
    if orientation_hint in ('portrait', 'landscape'):
        return orientation_hint
    return 'landscape' if img.width > img.height else 'portrait'


def _get_page_size_mm(orientation: str):
    """根据方向返回 (宽_mm, 高_mm)。"""
    if orientation == 'landscape':
        return 297, 210
    return 210, 297


def _convert_image_via_img2pdf(img_path: str, orientation: str) -> str:
    """
    用 img2pdf 将图片无损嵌入指定方向的 A4 PDF。
    返回临时 PDF 文件路径，供后续 pikepdf 扩展 MediaBox。
    """
    import img2pdf

    page_w_mm, page_h_mm = _get_page_size_mm(orientation)
    page_w_pt = mm_to_pt(page_w_mm)
    page_h_pt = mm_to_pt(page_h_mm)

    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    tmp_path = tmp.name
    tmp.close()

    layout_fun = img2pdf.get_layout_fun(pagesize=(page_w_pt, page_h_pt))
    pdf_bytes = img2pdf.convert([img_path], layout_fun=layout_fun)

    with open(tmp_path, "wb") as f:
        f.write(pdf_bytes)

    return tmp_path


def _pil_image_to_pdf_with_margins(img_path: str, output_path: str,
                                    L: float, B: float, R: float, T: float,
                                    orientation: str = 'portrait',
                                    dpi: int = 200) -> None:
    """
    PIL 直接生成带边距的 PDF，不经过 pikepdf。

    根据方向选择页面尺寸（A4 或 A4 横向），图片在内容区域内居中 contain 缩放，
    边距区域为纯白。一步到位生成最终 PDF。

    Args:
        img_path: 源图片路径
        output_path: 输出 PDF 路径
        L, B, R, T: 左/下/右/上边距（pt）
        orientation: 'portrait' | 'landscape'
        dpi: 画布分辨率
    """
    if Image is None:
        raise RuntimeError("PIL not available")

    page_w_mm, page_h_mm = _get_page_size_mm(orientation)
    page_w_pt = mm_to_pt(page_w_mm)
    page_h_pt = mm_to_pt(page_h_mm)

    # 内容区域 = 页面尺寸 - 边距
    content_w_pt = page_w_pt - L - R
    content_h_pt = page_h_pt - T - B

    def pt2px(pt): return int(pt / 72 * dpi)
    L_px, R_px = pt2px(L), pt2px(R)
    T_px, B_px = pt2px(T), pt2px(B)
    content_w_px = pt2px(content_w_pt)
    content_h_px = pt2px(content_h_pt)
    final_w_px = content_w_px + L_px + R_px  # = pt2px(page_w_pt)
    final_h_px = content_h_px + T_px + B_px  # = pt2px(page_h_pt)

    img = Image.open(img_path)

    # 转 RGB，处理透明通道
    if img.mode in ('RGBA', 'LA', 'P'):
        bg_px = max(img.width, 1)
        bg_py = max(img.height, 1)
        bg = Image.new('RGB', (bg_px, bg_py), (255, 255, 255))
        if img.mode == 'P':
            img = img.convert('RGBA')
        if img.mode in ('RGBA', 'LA'):
            bg.paste(img, mask=img.split()[-1])
        img = bg
    elif img.mode != 'RGB':
        img = img.convert('RGB')

    # 在内容区域内 contain 缩放
    scale = min(content_w_px / max(img.width, 1),
                content_h_px / max(img.height, 1))
    new_w = max(1, int(img.width * scale))
    new_h = max(1, int(img.height * scale))
    img_resized = img.resize((new_w, new_h), Image.LANCZOS)

    # 白色画布（含边距），图片在内容区域居中
    canvas = Image.new('RGB', (final_w_px, final_h_px), (255, 255, 255))
    x = L_px + (content_w_px - new_w) // 2
    y = B_px + (content_h_px - new_h) // 2
    canvas.paste(img_resized, (x, y))

    canvas.save(output_path, 'PDF', resolution=(dpi, dpi))


def expand_box(box, L, B, R, T):
    """
    将 PDF 矩形框 [左, 下, 右, 上] 各边向外扩展指定 pt 数。
    使用 float() 确保与 pikepdf 的 Array 类型兼容。
    """
    return [
        float(box[0]) - L,
        float(box[1]) - B,
        float(box[2]) + R,
        float(box[3]) + T,
    ]


def add_margins(input_path: str, output_path: str,
                left_mm: float = 0, right_mm: float = 0,
                top_mm: float = 0, bottom_mm: float = 0,
                is_image: bool = False,
                orientation: str = 'auto') -> dict:
    """
    给 PDF 添加安全边距（扩展页面尺寸，内容位置不变）。

    图片文件走两条子路径：
      1. img2pdf 可用 → 无损嵌入 → pikepdf 扩展 MediaBox（与 PDF 路径统一）
      2. img2pdf 不可用 → PIL 直接生成最终尺寸 PDF（跳过 pikepdf）

    Args:
        input_path: 输入文件路径（PDF 或图片）
        output_path: 输出 PDF 路径
        left_mm / right_mm / top_mm / bottom_mm: 各边边距（毫米）
        is_image: 输入是否为图片（如果是则先转 PDF）
        orientation: 'auto' | 'portrait' | 'landscape'。auto 时根据图片宽高自动判断

    Returns:
        {"success": True, "path": output_path, "orientation": "..."}
        或 {"success": False, "error": "错误信息"}
    """
    L = mm_to_pt(left_mm)
    R = mm_to_pt(right_mm)
    T = mm_to_pt(top_mm)
    B = mm_to_pt(bottom_mm)

    # 无变化时直接复制
    if L == 0 and R == 0 and T == 0 and B == 0:
        import shutil
        shutil.copy2(input_path, output_path)
        return {"success": True, "path": output_path}

    temp_pdf = None
    try:
        if is_image:
            # ── 图片路径 ──
            # 先确定方向
            with Image.open(input_path) as img:
                detected_orientation = _detect_image_orientation(img, orientation)

            # 优先 img2pdf（无损嵌入）→ 经 pikepdf 扩展边距
            try:
                temp_pdf = _convert_image_via_img2pdf(input_path, detected_orientation)

                pdf = pikepdf.open(temp_pdf)
                for page in pdf.pages:
                    mb = page.mediabox
                    page.mediabox = expand_box(mb, L, B, R, T)
                    if "/CropBox" in page:
                        page.cropbox = expand_box(page.cropbox, L, B, R, T)
                    for box_name in ("/TrimBox", "/BleedBox", "/ArtBox"):
                        if box_name in page:
                            page[box_name] = expand_box(page[box_name], L, B, R, T)
                pdf.save(output_path)
                pdf.close()
                return {"success": True, "path": output_path,
                        "orientation": detected_orientation}

            except ImportError:
                # img2pdf 不可用：PIL 直接生成带边距 PDF，跳过 pikepdf
                _pil_image_to_pdf_with_margins(
                    input_path, output_path, L, B, R, T,
                    orientation=detected_orientation)
                return {"success": True, "path": output_path,
                        "orientation": detected_orientation}

        # ── PDF 路径 → pikepdf 扩展边距 ──
        pdf = pikepdf.open(input_path)

        for page in pdf.pages:
            mb = page.mediabox
            page.mediabox = expand_box(mb, L, B, R, T)
            if "/CropBox" in page:
                page.cropbox = expand_box(page.cropbox, L, B, R, T)
            for box_name in ("/TrimBox", "/BleedBox", "/ArtBox"):
                if box_name in page:
                    page[box_name] = expand_box(page[box_name], L, B, R, T)

        pdf.save(output_path)
        pdf.close()
        return {"success": True, "path": output_path}

    except Exception as e:
        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}

    finally:
        if temp_pdf and os.path.exists(temp_pdf):
            try:
                os.unlink(temp_pdf)
            except OSError:
                pass


def main():
    parser = argparse.ArgumentParser(
        description="给 PDF 添加安全边距（白边）"
    )
    parser.add_argument("--input", "-i", required=True,
                        help="输入文件路径（PDF 或图片）")
    parser.add_argument("--output", "-o", required=True,
                        help="输出 PDF 路径")
    parser.add_argument("--left", type=float, default=0,
                        help="左边距（毫米）")
    parser.add_argument("--right", type=float, default=0,
                        help="右边距（毫米）")
    parser.add_argument("--top", type=float, default=0,
                        help="上边距（毫米）")
    parser.add_argument("--bottom", type=float, default=0,
                        help="下边距（毫米）")
    parser.add_argument("--is-image", action="store_true", default=False,
                        help="强制将输入视为图片（先转 PDF）")
    parser.add_argument("--orientation", choices=['portrait', 'landscape', 'auto'],
                        default='auto',
                        help="页面方向（auto=根据图片宽高自动判断，仅对图片有效）")

    args = parser.parse_args()

    # 判断输入是否为图片
    img_exts = {".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif"}
    ext = os.path.splitext(args.input)[1].lower()
    is_image = args.is_image or ext in img_exts

    result = add_margins(
        args.input, args.output,
        left_mm=args.left, right_mm=args.right,
        top_mm=args.top, bottom_mm=args.bottom,
        is_image=is_image,
        orientation=args.orientation,
    )

    print(json.dumps(result))
    if not result.get("success"):
        sys.exit(1)


if __name__ == "__main__":
    main()
