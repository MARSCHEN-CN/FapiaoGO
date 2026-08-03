#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A2-G1 光栅化 helper（DEV-only）：PDF 页 → RGBA raw bytes。
用 fitz(PyMuPDF) 渲染，输出 raw RGBA 到 <out>.bin，宽高 JSON 到 stdout。
供 collectGateOutput.mjs source 轨采集调用（backend/venv/Scripts/python.exe 运行）。
用法: python rasterize_pdf.py <input.pdf> <dpi> <out.bin>
"""
import sys, json, fitz

def main():
    if len(sys.argv) != 4:
        print(json.dumps({"error": "usage: rasterize_pdf.py <input> <dpi> <out.bin>"}))
        return 1
    pdf_path, dpi, out_bin = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    doc = fitz.open(pdf_path)
    page = doc[0]  # G1 第一轮只采第 0 页（A1 单页/A3 多页首页）
    zoom = dpi / 72.0
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=True)
    with open(out_bin, "wb") as f:
        f.write(pix.samples)  # RGBA, len = width*height*4
    print(json.dumps({"ok": True, "width": pix.width, "height": pix.height, "pages": doc.page_count}))
    return 0

if __name__ == "__main__":
    sys.exit(main())
