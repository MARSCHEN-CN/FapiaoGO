#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Margin Contract Gate — PDF 几何探针（DEV-only）

只读，输出 JSON。不修改任何文件，不引用生产代码。
用法: python probePdf.py <input.pdf>

输出:
{
  "ok": true,
  "pages": 1,
  "page0": {
    "mediaBox": {"x0":..,"y0":..,"x1":..,"y1":..,"widthPt":..,"heightPt":..},
    "cropBox":  {...},
    "rotate": 0,
    "userUnit": 1.0
  }
}

说明：用 pikepdf 直读 box 原值（不经渲染器归一），避免 fitz 在 /Rotate 存在时
返回"显示后"的矩形而掩盖 R-1 违规。INV-1 必须断言【原始 MediaBox】。
"""
import json
import sys

import pikepdf


def _box(page, name, fallback=None):
    if name in page:
        b = [float(v) for v in page[name]]
    elif fallback is not None:
        b = fallback
    else:
        return None
    x0, y0, x1, y1 = min(b[0], b[2]), min(b[1], b[3]), max(b[0], b[2]), max(b[1], b[3])
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1,
            "widthPt": x1 - x0, "heightPt": y1 - y0}


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "error": "usage: probePdf.py <input.pdf>"}))
        return 1
    path = sys.argv[1]
    try:
        with pikepdf.open(path) as pdf:
            pages = len(pdf.pages)
            if pages == 0:
                print(json.dumps({"ok": False, "error": "pdf has 0 pages"}))
                return 1
            p = pdf.pages[0]
            mb = _box(p, "/MediaBox")
            if mb is None:
                print(json.dumps({"ok": False, "error": "page has no /MediaBox"}))
                return 1
            cb = _box(p, "/CropBox", [mb["x0"], mb["y0"], mb["x1"], mb["y1"]])
            rotate = int(p.get("/Rotate", 0)) % 360
            uu = float(p.get("/UserUnit", 1))
            print(json.dumps({"ok": True, "pages": pages,
                              "page0": {"mediaBox": mb, "cropBox": cb,
                                        "rotate": rotate, "userUnit": uu}}))
            return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
