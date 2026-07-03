"""
OCR 模型输出测试脚本

用于测试 RapidOCR 模型在图片上的输出，调试 OCR 结果格式。

Usage:
    python test_ocr.py <image_path>
    python test_ocr.py  # 弹出文件选择对话框
"""

import sys
import os
import logging

# 配置日志显示
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s - %(message)s'
)

# 添加 backend 目录到路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image as PILImage
import numpy as np

from ocr_engine import get_ocr, auto_orient_and_ocr


def test_ocr_output(image_path: str):
    """测试 OCR 输出并详细打印结果"""
    print("=" * 60)
    print(f"测试图片: {image_path}")
    print("=" * 60)

    # 加载图片
    img = PILImage.open(image_path)
    print(f"\n图片信息:")
    print(f"  - 尺寸: {img.size} (宽 x 高)")
    print(f"  - 模式: {img.mode}")
    print(f"  - 格式: {img.format}")

    # 初始化 OCR 引擎
    print("\n初始化 OCR 引擎...")
    try:
        ocr_engine = get_ocr()
        print("  - OCR 引擎初始化成功")
    except Exception as e:
        print(f"  - OCR 引擎初始化失败: {e}")
        return

    # 执行 OCR
    print("\n执行 OCR 识别...")
    result, elapse, angle, rotated_img = auto_orient_and_ocr(img, ocr_engine)

    print(f"\nOCR 结果:")
    print(f"  - 旋转角度: {angle}°")
    print(f"  - 旋转后图片尺寸: {rotated_img.shape if rotated_img is not None else 'N/A'}")

    # 处理 elapse，可能是 list、scalar 或 None
    if elapse is None:
        print(f"  - 识别耗时: N/A")
    elif isinstance(elapse, list):
        total_elapse = sum(elapse) if elapse else 0
        print(f"  - 识别耗时: {total_elapse:.2f}ms (det={elapse[0] if len(elapse)>0 else 0:.2f}ms, rec={elapse[1] if len(elapse)>1 else 0:.2f}ms)")
    else:
        print(f"  - 识别耗时: {elapse:.2f}ms")

    if result is None:
        print("\n[警告] OCR 返回 None，未识别到任何内容")
        return

    print(f"  - 识别行数: {len(result)}")

    # 详细打印每一行的结果
    print("\n" + "-" * 60)
    print("详细结果 (bbox, text, score):")
    print("-" * 60)

    for i, item in enumerate(result):
        if not item or len(item) < 3:
            print(f"行 {i}: [无效数据] {item}")
            continue

        bbox, text, score = item[0], item[1], item[2]

        # 解析 bbox
        if bbox and len(bbox) >= 4:
            xs = [p[0] for p in bbox]
            ys = [p[1] for p in bbox]
            x_min, x_max = min(xs), max(xs)
            y_min, y_max = min(ys), max(ys)
            width = x_max - x_min
            height = y_max - y_min
            bbox_str = f"x=[{x_min:.0f},{x_max:.0f}] y=[{y_min:.0f},{y_max:.0f}] W={width:.0f} H={height:.0f}"
        else:
            bbox_str = "无bbox"

        # 打印结果
        print(f"\n[{i}] 文本: '{text}'")
        print(f"    置信度: {score:.4f}")
        print(f"    坐标: {bbox_str}")

    # 统计信息
    print("\n" + "=" * 60)
    print("统计信息:")
    print("=" * 60)

    total_chars = sum(len(item[1]) for item in result if item and len(item) >= 2)
    avg_conf = sum(item[2] for item in result if item and len(item) >= 3) / len(result) if result else 0

    print(f"  - 总行数: {len(result)}")
    print(f"  - 总字符数: {total_chars}")
    print(f"  - 平均置信度: {avg_conf:.4f}")

    # 合并所有文本
    full_text = "\n".join(item[1] for item in result if item and len(item) >= 2)
    print(f"\n完整识别文本:")
    print("-" * 60)
    print(full_text)
    print("-" * 60)

    return result


def main():
    if len(sys.argv) > 1:
        image_path = sys.argv[1]
    else:
        # 弹出文件选择对话框
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        image_path = filedialog.askopenfilename(
            title="选择图片文件",
            filetypes=[
                ("图片文件", "*.jpg *.jpeg *.png *.bmp *.tiff *.gif"),
                ("所有文件", "*.*")
            ]
        )
        root.destroy()

        if not image_path:
            print("未选择文件，退出")
            return

    if not os.path.exists(image_path):
        print(f"文件不存在: {image_path}")
        return

    test_ocr_output(image_path)


if __name__ == "__main__":
    main()
