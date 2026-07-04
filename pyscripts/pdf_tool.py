#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Electron 从 print-merged-images 调用的 PDF 处理工具
链路：img2pdf 无损 PNG→PDF → pikepdf 加安全边距
"""

import sys
import json
import os
from pathlib import Path
from io import BytesIO

import img2pdf
import pikepdf
from PIL import Image


def mm_to_pt(mm: float) -> float:
    return mm / 25.4 * 72


def png_to_pdf_with_margin(input_png: str, output_pdf: str, margins: dict, dpi: int = 300):
    """
    PNG 无损转 PDF，并加安全边距（单步完成）
    """
    # 1. img2pdf 无损转 PDF，自定义 layout 确保 300dpi 像素→物理尺寸映射
    def _layout(w_px, h_px, ndpi):
        w_pt = w_px * 72 / dpi
        h_pt = h_px * 72 / dpi
        return (w_pt, h_pt, w_pt, h_pt)
    pdf_bytes = img2pdf.convert(input_png, layout_fun=_layout)

    # 2. pikepdf 加边距（内存中处理，不落地临时文件）
    pdf = pikepdf.open(BytesIO(pdf_bytes))

    L = mm_to_pt(margins.get("left", 0))
    R = mm_to_pt(margins.get("right", 0))
    T = mm_to_pt(margins.get("top", 0))
    B = mm_to_pt(margins.get("bottom", 0))

    if L or R or T or B:
        for page in pdf.pages:
            rotate = int(page.get("/Rotate", 0)) % 360
            mapping = {
                0:   (L, B, R, T),
                90:  (B, R, T, L),
                180: (R, T, L, B),
                270: (T, L, B, R),
            }
            dl, db, dr, dt = mapping.get(rotate, (L, B, R, T))

            mb = page.mediabox
            page.mediabox = [
                float(mb[0]) - dl,
                float(mb[1]) - db,
                float(mb[2]) + dr,
                float(mb[3]) + dt
            ]

            for box_name in ("/CropBox", "/TrimBox", "/BleedBox", "/ArtBox"):
                if box_name in page:
                    box = page[box_name]
                    page[box_name] = [
                        float(box[0]) - dl,
                        float(box[1]) - db,
                        float(box[2]) + dr,
                        float(box[3]) + dt
                    ]

    pdf.save(output_pdf)
    pdf.close()


def main():
    try:
        cmd = sys.argv[1]

        if cmd == "png-to-pdf":
            input_png = sys.argv[2]
            output_pdf = sys.argv[3]
            margins = json.loads(sys.argv[4]) if len(sys.argv) > 4 else {}
            dpi = int(sys.argv[5]) if len(sys.argv) > 5 else 300

            png_to_pdf_with_margin(input_png, output_pdf, margins, dpi)

            print(json.dumps({
                "success": True,
                "output": output_pdf,
                "action": "png-to-pdf-with-margin"
            }))

        else:
            raise ValueError(f"Unknown command: {cmd}")

    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e)
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
