#!/usr/bin/env python3
"""A3-RF RenderResource Probe — fitz (MuPDF) 侧。

取同一 PDF 的 box metadata + 栅格化尺寸 + content bbox，
用于和 pdf.js 侧（collectRenderResourceProbe）比对，定位 RenderResource fidelity 残差根因。

用法（PDF 本地环境，需 fitz）：
    python scripts/probe_render_resource_fitz.py <pdf_path> [dpi=300]

输出 JSON 到 stdout：
    {
      "engine": "fitz",
      "rotation": int,
      "mediabox_pt": [x0,y0,x1,y1], "cropbox_pt": [...], "rect_pt": [...],
      "mediabox_px": [w,h], "cropbox_px": [w,h], "pixmap_px": [w,h],
      "content_bbox_px": {"x":int,"y":int,"w":int,"h":int} | null,
      "bbox_method": "brightness<250 (white bg)"
    }
"""
import sys
import json

try:
    import fitz
except ImportError:
    print(json.dumps({"error": "fitz not installed: pip install pymupdf"}), file=sys.stderr)
    sys.exit(2)


def find_content_bbox(pix):
    """仿 node findContentBBox：白底 PDF 用亮度阈值（brightness<250 即内容）。"""
    w, h = pix.width, pix.height
    samples = pix.samples
    # pix.n channels; 取 RGB（忽略 alpha）
    n = pix.n
    min_x, min_y, max_x, max_y = w, h, -1, -1
    stride = w * n
    for y in range(h):
        row = samples[y * stride:(y + 1) * stride]
        for x in range(w):
            i = x * n
            r, g, b = row[i], row[i + 1], row[i + 2]
            # brightness 阈值：任一通道 < 250 视为内容（非纯白）
            if r < 250 or g < 250 or b < 250:
                if x < min_x: min_x = x
                if x > max_x: max_x = x
                if y < min_y: min_y = y
                if y > max_y: max_y = y
    if max_x < 0:
        return None
    return {"x": min_x, "y": min_y, "w": max_x - min_x + 1, "h": max_y - min_y + 1}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: probe_render_resource_fitz.py <pdf_path> [dpi]"}), file=sys.stderr)
        sys.exit(1)
    path = sys.argv[1]
    dpi = int(sys.argv[2]) if len(sys.argv) > 2 else 300

    try:
        doc = fitz.open(path)
    except Exception as e:
        print(json.dumps({"error": f"cannot open {path}: {e}"}), file=sys.stderr)
        sys.exit(3)

    pg = doc[0]
    mb = list(pg.mediabox)
    cb = list(pg.cropbox)
    rect = list(pg.rect)
    zoom = dpi / 72.0

    out = {
        "engine": "fitz",
        "rotation": pg.rotation,
        "mediabox_pt": [round(v, 2) for v in mb],
        "cropbox_pt": [round(v, 2) for v in cb],
        "rect_pt": [round(v, 2) for v in rect],
        "mediabox_px": [round(mb[2] * zoom), round(mb[3] * zoom)],
        "cropbox_px": [round(cb[2] * zoom), round(cb[3] * zoom)],
        "cropbox_eq_mediabox": abs(cb[2] - mb[2]) < 0.5 and abs(cb[3] - mb[3]) < 0.5,
    }

    # 栅格化（默认渲染 page.rect = MediaBox 区域；白底无 alpha，与 pdf.js 强制白底 / G1 rasterize_pdf.py 一致）
    # ⚠️ 勿用 alpha=True：透明背景像素 RGB=(0,0,0)，brightness<250 会把背景当内容 → 全页假阳性
    pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    out["pixmap_px"] = [pix.width, pix.height]
    out["bbox_method"] = "brightness<250 (white bg, no alpha)"
    bbox = find_content_bbox(pix)
    out["content_bbox_px"] = bbox

    # 关键判定：pixmap 尺寸 == MediaBox@300 还是 CropBox@300？
    mb_px = out["mediabox_px"]
    cb_px = out["cropbox_px"]
    out["pixmap_matches"] = (
        "mediabox" if (abs(pix.width - mb_px[0]) < 3 and abs(pix.height - mb_px[1]) < 3)
        else "cropbox" if (abs(pix.width - cb_px[0]) < 3 and abs(pix.height - cb_px[1]) < 3)
        else "neither"
    )

    print(json.dumps(out, indent=2))
    doc.close()


if __name__ == "__main__":
    main()
