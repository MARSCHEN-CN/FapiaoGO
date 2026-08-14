#!/usr/bin/env python3
"""
flatten_annotations.py — Annotation Preservation Shared Module (AP-DR-6)

Content Integrity Patch: 在 as_form_xobject() 之前将 Annotation AP 嵌入页面内容

冻结契约（AP-DR-6 R1-R4）:
  R1: 必须在 as_form_xobject() 之前调用
  R2: 只处理有 /AP/N 的 /Stamp Annotation
  R3: AP → Page 坐标后，与主内容共享 placement transform
  R4: Flatten 后 /Annots 不参与打印视觉

No-Regression Invariant:
  - 无 Annotation 输入 → 函数为 no-op，输出几何完全一致
  - 不修改任何冻结的几何逻辑（compute_transform, contain_fit, policy_a 等）

用法（在 with pikepdf.open(src_path) 上下文内调用）:
  from shared.flatten_annotations import flatten_stamp_annotations
  
  with pikepdf.open(src_path) as src:
      src_page = pikepdf.Page(src.pages[0])
      
      # ⭐ AP-DR-6: Flatten Annotation AP before Form XObject
      flatten_stamp_annotations(src_page)
      
      # 后续逻辑完全不变
      form = src_page.as_form_xobject()
      ...
"""

from __future__ import annotations

import re

import pikepdf


def collect_stamp_annotations(src_page) -> list[dict]:
    """
    R2: 收集有有效 /AP/N 的 /Stamp Annotation
    
    只处理: /Subtype == /Stamp AND /AP/N 存在
    其他 Annotation 类型不受影响
    
    Returns:
        list of dict: [{"ref", "rect", "bbox", "ap_matrix", "ap_n"}, ...]
    """
    result = []
    if "/Annots" not in src_page.obj:
        return result
    
    for annot_ref in src_page.obj.get("/Annots", []):
        annot = pikepdf.Dictionary(annot_ref)
        
        # R2: 只处理 /Stamp 类型
        if annot.get("/Subtype") != "/Stamp":
            continue
        
        # R2: 必须有有效的 /AP/N
        if "/AP" not in annot or "/N" not in annot["/AP"]:
            continue
        
        ap_n = annot["/AP"]["/N"]
        result.append({
            "ref": annot_ref,
            "rect": [float(v) for v in annot.get("/Rect", [0, 0, 0, 0])],
            "bbox": [float(v) for v in ap_n.get("/BBox", [0, 0, 0, 0])],
            "ap_matrix": [float(v) for v in ap_n.get("/Matrix", [1, 0, 0, 1, 0, 0])],
            "ap_n": ap_n,
        })
    
    return result


def compute_ap_to_page_matrix(rect: list, bbox: list, ap_matrix: list) -> list:
    """
    R3: 计算 AP → Source Page 的坐标变换矩阵
    
    M_ap_to_page = translate(Rect.x0, Rect.y0) × scale(...) × AP_Matrix
    
    之后此矩阵会被现有 placement transform 二次合成:
    M_final = M_placement × M_ap_to_page
    
    Returns:
        list: [a, b, c, d, e, f] PDF 变换矩阵
    """
    bbox_w = bbox[2] - bbox[0]
    bbox_h = bbox[3] - bbox[1]
    rect_w = rect[2] - rect[0]
    rect_h = rect[3] - rect[1]
    
    scale_x = rect_w / bbox_w if bbox_w > 0 else 1.0
    scale_y = rect_h / bbox_h if bbox_h > 0 else 1.0
    
    # 构建矩阵: translate × scale
    if abs(scale_x - 1.0) > 0.001 or abs(scale_y - 1.0) > 0.001:
        M = [scale_x, 0, 0, scale_y, rect[0], rect[1]]
    else:
        M = [1, 0, 0, 1, rect[0], rect[1]]
    
    # 考虑 AP Matrix (如果不是 Identity)
    if ap_matrix != [1, 0, 0, 1, 0, 0]:
        a1, b1, c1, d1, e1, f1 = M
        a2, b2, c2, d2, e2, f2 = ap_matrix
        M = [
            a1 * a2 + c1 * b2,
            b1 * a2 + d1 * b2,
            a1 * c2 + c1 * d2,
            b1 * c2 + d1 * d2,
            a1 * e2 + c1 * f2 + e1,
            b1 * e2 + d1 * f2 + f1,
        ]
    
    return M


# ---------------------------------------------------------------------------
# AP-DR-6R Layer 7 — CTM 感知 Flatten（修复 Stamp Flatten 坐标系错误）
# ---------------------------------------------------------------------------
def mat_mul(m1, m2):
    """行向量约定矩阵乘法 m1 × m2（与 PDF CTM 合成一致）。"""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return [
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    ]


def mat_inv(m):
    """2D 仿射矩阵求逆 [a b c d e f]。"""
    a, b, c, d, e, f = m
    det = a * d - b * c
    if abs(det) < 1e-12:
        raise ValueError("singular CTM, cannot invert")
    return [
        d / det, -b / det, -c / det, a / det,
        (c * f - d * e) / det, (b * e - a * f) / det,
    ]


def _read_page_content(page):
    """读取并解压页面全部 content stream（pikepdf 仅，避免 fitz 依赖）。"""
    contents = page.obj.get("/Contents")
    if contents is None:
        return b""
    streams = contents if isinstance(contents, pikepdf.Array) else [contents]
    raw = b""
    for s in streams:
        try:
            raw += bytes(s.read_bytes())
        except Exception:
            try:
                raw += bytes(s.read_raw_bytes())
            except Exception:
                pass
    return raw


def _active_ctm_at_end(content_bytes):
    """
    跟踪 content stream 顶层 cm/q/Q，返回 stream 末尾（flatten 插入点）的 active CTM。

    关键修复点：源页面 content 可能在开头就带有非单位变换
    （如 mm->pt 的 2.8346 缩放），flatten 追加指令会继承该 CTM，
    导致 Stamp 被二次变换推出页面。必须读取该 CTM 并求逆抵消。
    """
    try:
        s = content_bytes.decode("latin-1", "replace")
    except Exception:
        return [1, 0, 0, 1, 0, 0]
    s = re.sub(r"%.*", "", s)  # 去掉注释
    # 去掉字面量字符串 (...) 与十六进制串 <..> / 字典 << >>，避免误伤 q/Q/cm
    out = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c == "(":
            i += 1
            depth = 1
            while i < n and depth > 0:
                if s[i] == "\\" and i + 1 < n:
                    i += 2
                    continue
                if s[i] == "(":
                    depth += 1
                elif s[i] == ")":
                    depth -= 1
                i += 1
            continue
        if c == "<":
            if i + 1 < n and s[i + 1] == "<":
                j = s.find(">>", i)
                i = (j + 2) if j != -1 else n
                continue
            j = s.find(">", i)
            i = (j + 1) if j != -1 else n
            continue
        out.append(c)
        i += 1
    toks = "".join(out).split()
    C = [1, 0, 0, 1, 0, 0]
    stack = []
    k = 0
    while k < len(toks):
        t = toks[k]
        if t == "q":
            stack.append(C[:])
        elif t == "Q":
            if stack:
                C = stack.pop()
        elif t == "cm":
            try:
                a, b, cc, d, e, f = (float(x) for x in toks[k - 6:k])
                C = mat_mul(C, [a, b, cc, d, e, f])
            except Exception:
                pass
        k += 1
    return C


def _remove_flattened_annots(src_page):
    """
    R4: Flatten 后 /Annots 不参与打印视觉。
    移除已成功 flatten 的 /Stamp+/AP/N（与 collect 标准一致），
    避免 annotation 与 content 双链渲染/发散。
    """
    annots = src_page.obj.get("/Annots")
    if annots is None:
        return
    keep = []
    removed_any = False
    for a in annots:
        annot = pikepdf.Dictionary(a)
        is_flattened = (
            annot.get("/Subtype") == "/Stamp"
            and "/AP" in annot
            and "/N" in annot["/AP"]
        )
        if is_flattened:
            removed_any = True
        else:
            keep.append(a)
    if removed_any:
        if keep:
            src_page.obj["/Annots"] = keep
        else:
            del src_page.obj["/Annots"]


def flatten_stamp_annotations(src_page, src_pdf=None) -> int:
    """
    R1-R4: 将 Annotation AP 嵌入页面内容（CTM 感知，修复坐标系错误）

    必须在 as_form_xobject() 之前调用。

    AP-DR-6R Layer 7 修复要点：
      * 读取插入点（content stream 末尾）的 active CTM = C_insert；
      * flatten_cm = inv(C_insert) × M，使 effective = C_insert × flatten_cm = M，
        即 Stamp 落在 /Rect 定义的页面坐标系（与 annotation 原位置一致）；
      * 每个 Stamp 用 q ... Q 隔离，避免污染后续图形状态；
      * R4：移除已 flatten 的 /Annots（annotation 退出渲染链）。

    Args:
        src_page: pikepdf.Page 源页面对象
        src_pdf: (兼容参数，已不使用；保留供旧调用方兼容)

    Returns:
        int: Flatten 的 Annotation 数量（0 表示 no-op）

    No-Regression:
        - 无 /Annots 或无有效 Stamp → 返回 0，不修改任何内容
        - 无 Stamp → 完全 no-op（不追加任何指令）
        - C_insert 读取失败 → 退化为单位矩阵（等同原 page-space 直接写，安全保守）
    """
    # R2: 收集符合条件的 Annotation
    stamp_annotations = collect_stamp_annotations(src_page)

    if not stamp_annotations:
        # No-op: 无 Annotation 或无有效 Stamp，保持几何完全一致
        return 0

    # AP-DR-6R Layer 7: 读取插入点 active CTM（源页面可能已带非单位变换）
    try:
        content_bytes = _read_page_content(src_page)
        C_insert = _active_ctm_at_end(content_bytes)
    except Exception:
        C_insert = [1, 0, 0, 1, 0, 0]

    # R1-R4: 将每个 Annotation 的 AP 嵌入页面内容
    flatten_commands = []

    for sa in stamp_annotations:
        rect = sa["rect"]
        bbox = sa["bbox"]
        ap_matrix = sa["ap_matrix"]
        ap_n = sa["ap_n"]

        # R3: 计算 AP → Page 矩阵（page-space placement）
        M = compute_ap_to_page_matrix(rect, bbox, ap_matrix)

        # 抵消 active CTM：flatten_cm = inv(C_insert) × M
        # effective = C_insert × flatten_cm = M → Stamp 落回 /Rect 页面坐标
        try:
            flatten_cm = mat_mul(mat_inv(C_insert), M)
        except Exception:
            flatten_cm = M  # 退化保护：退化为原 page-space 直接写（旧行为）

        # 将 AP Form 添加为页面资源（ap_n 已在 src_pdf 中，直接添加）
        ap_name = src_page.add_resource(ap_n, pikepdf.Name.XObject)

        # 构建 Flatten 指令（q ... Q 隔离图形状态）
        flatten_commands.append(
            f"q {flatten_cm[0]:.10f} {flatten_cm[1]:.10f} {flatten_cm[2]:.10f} "
            f"{flatten_cm[3]:.10f} {flatten_cm[4]:.10f} {flatten_cm[5]:.10f} cm {ap_name} Do Q"
        )

    # R4: 追加到现有 Contents（不替换，只追加）
    if flatten_commands:
        # contents_add() correctly handles compressed streams by decompressing
        # and creating an Array of streams, which as_form_xobject() properly
        # coalesces into the Form's content.
        src_page.contents_add(
            "\n".join(flatten_commands).encode(), prepend=False
        )

    # R4: 移除已 flatten 的 /Annots（annotation 退出渲染链，避免双链）
    _remove_flattened_annots(src_page)

    return len(stamp_annotations)
