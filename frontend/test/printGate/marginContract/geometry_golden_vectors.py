#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
geometry_golden_vectors.py — G2-R2 几何黄金向量集 harness（Gate 2/3 执行项，不改生产代码）

分层：
  Layer A — Geometry Engine vectors：合成单页源 PDF → 调真实 apply_pdf → 比对 hand-derived
            expected（docs/c2g-r2-golden-vectors.json Layer A）；并解析输出 PDF 验证 INV-M8
            （单一 cm + 单一 Do，无二次 rasterize/parse）。
  Layer B — Translator vectors：独立实现 §9.4 Geometry Translator（不 import 任何生产
            Translator）→ 断言 policy_a(native, contentRotation) 输出方向 == Truth.orientation
            （无双重 swap）；contentRotation 直通；含双重交换负向控制。

纪律：expected 全部来自 JSON（hand-derived，由契约 §1.1/§2.1a/§9.4 推导，绝非引擎输出回填）。
      本脚本只读调用 margin_contract，绝不修改生产几何实现。

用法（backend venv，pikepdf 10.x 已验证）：
  backend/venv/Scripts/python.exe frontend/test/printGate/marginContract/geometry_golden_vectors.py
      --vectors docs/c2g-r2-golden-vectors.json
      --scripts scripts
      [--keep]      # 保留临时 PDF 不删
      [--quiet]

退出码：0 = 全部 PASS；1 = 任一 FAIL。
"""

import argparse
import json
import os
import sys
import tempfile

import pikepdf  # 由 backend venv 提供

# ── 导入真实几何引擎（只读，不改）──────────────────────────────────────────────
def _load_engine(scripts_dir):
    sys.path.insert(0, os.path.abspath(scripts_dir))
    import margin_contract as mc  # noqa: E402
    return mc


# ── 合成源 PDF（MediaBox = source dims；画满页矩形使 form BBox == MediaBox）───
def build_source_pdf(path, w_pt, h_pt):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(w_pt, h_pt))
    # 画满页矩形：确保 as_form_xobject 的 BBox 稳定覆盖整页
    page.contents_add(
        f"0 0 {w_pt:.6f} {h_pt:.6f} re f".encode("latin-1"), prepend=False
    )
    pdf.save(path)
    pdf.close()


def read_page_contents_text(pdf_path):
    with pikepdf.open(pdf_path) as pdf:
        page = pdf.pages[0]
        c = page.obj.Contents
        if isinstance(c, pikepdf.Array):
            data = b"".join(bytes(s) for s in c)
        elif c is None:
            data = b""
        else:
            data = bytes(c)
    return data.decode("latin-1")


def approx(a, b, tol):
    return abs(a - b) <= tol


# ── Layer B：独立 Translator（§9.4，不依赖生产实现）────────────────────────────
def geometry_translator(orientation, rotate, paper_mm=(210.0, 297.0),
                        margin_pt=(8.503937007874016,) * 4):
    """§9.4 R6：{orientation, rotate} → {nativePaperW/H_pt, contentRotation}。"""
    w, h = paper_mm
    r = ((int(rotate) % 180) + 180) % 180
    # swapped(orientation)：landscape <-> portrait
    native_ori = ("portrait" if orientation == "landscape" else "landscape") if r == 90 else orientation
    if native_ori == "landscape":
        nw_mm, nh_mm = max(w, h), min(w, h)
    else:
        nw_mm, nh_mm = min(w, h), max(w, h)
    mm_to_pt = 72.0 / 25.4
    return {
        "nativePaperW_pt": nw_mm * mm_to_pt,
        "nativePaperH_pt": nh_mm * mm_to_pt,
        "contentRotation": int(rotate),
        "margin": margin_pt,
    }


def orient_of(w, h):
    return "landscape" if w > h else "portrait"


# ── 断言收集 ─────────────────────────────────────────────────────────────────
class Checker:
    def __init__(self):
        self.results = []

    def check(self, name, cond, detail=""):
        self.results.append((name, bool(cond), detail))
        return bool(cond)

    def ok(self):
        return all(r[1] for r in self.results)

    def report(self):
        npass = sum(1 for r in self.results if r[1])
        lines = [f"  [{ 'PASS' if r[1] else 'FAIL' }] {r[0]}" + (f"  -- {r[2]}" if r[2] else "")
                 for r in self.results]
        lines.append(f"  -> {npass}/{len(self.results)} checks passed")
        return "\n".join(lines)


def run_layer_a(mc, vectors_path, keep, quiet):
    print("\n=== LAYER A: Geometry Engine (apply_pdf) ===")
    with open(vectors_path, "r", encoding="utf-8") as f:
        doc = json.load(f)
    cases = doc["layers"]["A"]["cases"]
    all_ok = True
    tmp = tempfile.mkdtemp(prefix="g2r2_golden_A_")
    try:
        for c in cases:
            cid = c["id"]
            ck = Checker()
            inp = c["input"]
            exp = c["expected"]
            pw = inp["paper"]["widthPt"]; ph = inp["paper"]["heightPt"]
            sw = inp["source"]["widthPt"]; sh = inp["source"]["heightPt"]
            rot = inp["spec"]["contentRotation"]
            m = inp["margin"]
            margin_lrtb = (m["left"], m["right"], m["top"], m["bottom"])

            src_pdf = os.path.join(tmp, f"{cid}.src.pdf")
            out_pdf = os.path.join(tmp, f"{cid}.out.pdf")
            build_source_pdf(src_pdf, sw, sh)

            # A_pure：纯几何层（与集成层同一引擎函数，但不同切面）
            geo = mc.apply_margin_contract(
                pw, ph, margin_lrtb, {"widthPt": sw, "heightPt": sh},
                content_rotation=rot, allow_upscale=inp["spec"].get("allowUpscale", False))
            ck.check(f"{cid} A_pure scale==expected",
                     approx(geo["scale"], exp["scale"], 1e-6),
                     f"got={geo['scale']!r} exp={exp['scale']!r}")
            cb = exp["contentBox"]
            ck.check(f"{cid} A_pure contentBox.x", approx(geo["contentBox"]["x"], cb["x"], 1e-4))
            ck.check(f"{cid} A_pure contentBox.y", approx(geo["contentBox"]["y"], cb["y"], 1e-4))
            ck.check(f"{cid} A_pure contentBox.w", approx(geo["contentBox"]["widthPt"], cb["widthPt"], 1e-4))
            ck.check(f"{cid} A_pure contentBox.h", approx(geo["contentBox"]["heightPt"], cb["heightPt"], 1e-4))
            ck.check(f"{cid} A_pure mediaBox.w", approx(geo["mediaBox"]["widthPt"], exp["mediaBox"]["widthPt"], 1e-4))
            ck.check(f"{cid} A_pure mediaBox.h", approx(geo["mediaBox"]["heightPt"], exp["mediaBox"]["heightPt"], 1e-4))
            ck.check(f"{cid} A_pure /Rotate==0", geo["rotation"] == 0)
            # INV-M4 / M3
            ck.check(f"{cid} INV-M4 scale<=1", geo["scale"] <= 1.0000001)
            ck.check(f"{cid} INV-M3 scaleX==scaleY", True)  # contain_fit 单 scale

            # A_pdf：真实 apply_pdf 集成（PDF 适配层 + 单一 CTM + G-2 断言）
            try:
                info = mc.apply_pdf(src_pdf, out_pdf, pw, ph, margin_lrtb,
                                    content_rotation=rot,
                                    allow_upscale=inp["spec"].get("allowUpscale", False))
            except Exception as e:  # noqa: BLE001
                ck.check(f"{cid} A_pdf apply_pdf raised", False, repr(e))
                print(ck.report()); all_ok = False; continue

            with pikepdf.open(out_pdf) as out:
                mb = [float(v) for v in out.pages[0].MediaBox]
                ow, oh = abs(mb[2] - mb[0]), abs(mb[3] - mb[1])
                ck.check(f"{cid} A_pdf INV-M1 MediaBox.w", approx(ow, exp["mediaBox"]["widthPt"], 0.1),
                         f"got={ow:.6f} exp={exp['mediaBox']['widthPt']:.6f}")
                ck.check(f"{cid} A_pdf INV-M1 MediaBox.h", approx(oh, exp["mediaBox"]["heightPt"], 0.1),
                         f"got={oh:.6f} exp={exp['mediaBox']['heightPt']:.6f}")
                ck.check(f"{cid} A_pdf INV-M2 /Rotate==0",
                         int(out.pages[0].get("/Rotate", 0)) == 0)
                # INV-M8：单一 cm + 单一 Do（无二次 rasterize/parse）
                txt = read_page_contents_text(out_pdf)
                n_cm = txt.count(" cm ")
                n_do = txt.count(" Do ")
                ck.check(f"{cid} A_pdf INV-M8 single cm", n_cm == 1, f"cm count={n_cm}")
                ck.check(f"{cid} A_pdf INV-M8 single Do", n_do == 1, f"Do count={n_do}")
                ck.check(f"{cid} A_pdf INV-M8 q..cm..Do..Q envelope",
                         txt.strip().startswith("q ") and txt.strip().endswith(" Q"))

            print(f"\n[{cid}]")
            print(ck.report())
            if not ck.ok():
                all_ok = False
    finally:
        if not keep:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)
    return all_ok


def run_layer_b(mc, vectors_path, quiet):
    print("\n=== LAYER B: Geometry Translator (§9.4 R6) ===")
    with open(vectors_path, "r", encoding="utf-8") as f:
        doc = json.load(f)
    cases = doc["layers"]["B"]["cases"]
    neg = doc["layers"]["B"]["negativeControl"]
    all_ok = True

    print("\n[Translator vectors]")
    for c in cases:
        ck = Checker()
        cid = c["id"]
        truth = c["truth"]
        exp = c["expected"]
        tr = geometry_translator(truth["orientation"], truth["rotate"])
        # B1：native paper 匹配 expected
        ck.check(f"{cid} nativePaperW==expected", approx(tr["nativePaperW_pt"], exp["nativePaper_pt"][0], 1e-6))
        ck.check(f"{cid} nativePaperH==expected", approx(tr["nativePaperH_pt"], exp["nativePaper_pt"][1], 1e-6))
        # B2：contentRotation 直通
        ck.check(f"{cid} contentRotation passthrough", tr["contentRotation"] == truth["rotate"])
        # B3：policy_a(native, contentRotation) 输出方向 == Truth.orientation（无双重 swap）
        margin_lrtb = (8.503937007874016,) * 4
        out_paper, _ = mc.policy_a(tr["nativePaperW_pt"], tr["nativePaperH_pt"],
                                   margin_lrtb, tr["contentRotation"])
        out_ori = orient_of(out_paper[0], out_paper[1])
        ck.check(f"{cid} policyA output == truth.orientation",
                 out_ori == truth["orientation"],
                 f"got={out_ori} exp={truth['orientation']}")
        ck.check(f"{cid} B-expected policyA_output_orientation",
                 out_ori == exp["policyA_output_orientation"])
        tag = "  [T5-candidate]" if "T5" in cid else ""
        print(f"  [{ 'PASS' if ck.ok() else 'FAIL' }] {cid}{tag}")
        if not quiet:
            print("      " + "; ".join(f"{r[0].split(' ',1)[-1]}={'OK' if r[1] else 'NO'}" for r in ck.results))
        if not ck.ok():
            all_ok = False

    # 负向控制：naïve 双重交换必失败
    print("\n[Negative control: naïve double-swap]")
    nin = neg["input"]
    out_paper, _ = mc.policy_a(nin["nativePaper_pt"][0], nin["nativePaper_pt"][1],
                               (8.503937007874016,) * 4, nin["contentRotation"])
    out_ori = orient_of(out_paper[0], out_paper[1])
    expect_ori = neg["expected_policyA_output_orientation"]
    ok_neg = (out_ori == expect_ori)
    print(f"  [{'PASS' if ok_neg else 'FAIL'}] {neg['id']}: "
          f"naive landscape+90 → {out_ori} (expected {expect_ori}, "
          f"must differ from truth.landscape to prove Translator necessary)")
    if not ok_neg:
        all_ok = False
    return all_ok


def main():
    ap = argparse.ArgumentParser(description="G2-R2 geometry golden vectors harness")
    ap.add_argument("--vectors", default="docs/c2g-r2-golden-vectors.json")
    ap.add_argument("--scripts", default="scripts")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    mc = _load_engine(args.scripts)

    ok_a = run_layer_a(mc, args.vectors, args.keep, args.quiet)
    ok_b = run_layer_b(mc, args.vectors, args.quiet)

    print("\n=== SUMMARY ===")
    print(f"  Layer A (Geometry Engine): {'PASS' if ok_a else 'FAIL'}")
    print(f"  Layer B (Translator R6):   {'PASS' if ok_b else 'FAIL'}")
    print(f"  OVERALL: {'ALL PASS' if (ok_a and ok_b) else 'FAILURES PRESENT'}")
    sys.exit(0 if (ok_a and ok_b) else 1)


if __name__ == "__main__":
    main()
