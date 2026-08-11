#!/usr/bin/env python
"""P2/P3 artifact 文本方向对照（模板匹配，0°/180°）— 2026-08-11 18:10

方法：bake 原始 PDF 内容作为模板 B；artifact P2/P3 内容 A。
计算 A 与 B 的 0° 匹配度、以及 A 旋转 180° 后与 B 的匹配度。
匹配度高（MSE 低 / 相关度高）的那个 = 内容实际方向。
  - A(0°) ≈ B → rotate=N 是正向（净 0°）
  - rot180(A) ≈ B → rotate=N 是倒置（净 180°）
"""
import fitz
import numpy as np

BAKE = r'C:/Users/it01/AppData/Local/Temp/placement_bake_1786441296107_uh3pxs.pdf'
OUT = r'E:/print706/frontend/test/printGate/.out/cmd-compare'
CASES = [
    ('P2', f'{OUT}/art_P2-16case-fit-r90.pdf', 'rotate=90'),
    ('P3', f'{OUT}/art_P3-16case-fit-r270.pdf', 'rotate=270'),
]

DPI = 300
MM = 25.4 / DPI


def render_content_gray(pdf):
    d = fitz.open(pdf)
    p = d[0]
    pix = p.get_pixmap(dpi=DPI)
    a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    gray = a[:, :, :3].mean(axis=2)
    mask = gray < 250
    ys, xs = np.where(mask)
    if not mask.sum():
        return None, None
    # 内容区域裁剪（带 2px 边距）
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    pad = 2
    crop = gray[max(y0 - pad, 0):y1 + pad + 1, max(x0 - pad, 0):x1 + pad + 1]
    d.close()
    return crop, (y0, y1, x0, x1)


def normalize(img, size=(400, 260)):
    """缩放到统一尺寸 + 二值化，便于比较"""
    from PIL import Image
    im = Image.fromarray(img).resize(size, Image.LANCZOS)
    arr = np.array(im)
    return (arr < 200).astype(bool)  # 二值：墨水=True


def score(a, b):
    """匹配度：交集/并集（IoU）越高越好"""
    inter = (a & b).sum()
    union = (a | b).sum()
    return inter / union if union else 0


def rot180(img):
    return img[::-1, ::-1]


# 模板：bake 原始内容
tb, box_b = render_content_gray(BAKE)
B = normalize(tb)
bw, bh = (box_b[3]-box_b[2])*MM, (box_b[1]-box_b[0])*MM
print(f'bake 内容 bbox: x{box_b[2]}-{box_b[3]} y{box_b[0]}-{box_b[1]}px（{round(bw,1)}x{round(bh,1)}mm 宽x高）')
print()
print('=== P2/P3 vs bake 模板方向匹配（IoU，越高越匹配）===')
for tag, path, cmd in CASES:
    ta, box_a = render_content_gray(path)
    if ta is None:
        print(f'{tag}: 内容为空')
        continue
    A = normalize(ta)
    A180 = rot180(A)
    iou0 = score(A, B)          # artifact 0° vs bake 0°
    iou180 = score(A180, B)     # artifact 180° vs bake 0°
    verdict = '正向 (净0°)' if iou0 > iou180 else '倒置 180°' if iou180 > iou0 else '无法区分'
    print(f'{tag} ({cmd}): IoU(0°)={iou0:.3f} IoU(180°)={iou180:.3f} → {verdict}')
    print(f'   内容 bbox: y{box_a[0]}-{box_a[1]} x{box_a[2]}-{box_a[3]}px（{round((box_a[1]-box_a[0])*MM,1)}x{round((box_a[3]-box_a[2])*MM,1)}mm）')
