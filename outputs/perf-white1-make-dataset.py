#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
PERF-WHITE-1 S-200 测试数据集生成器

用途：为大批量导入性能基线生成 200 份「发票号唯一」的 PDF。
为什么要发票号唯一 —— 前端 importHistory 是按发票号聚合后批量查询的
（FileContext.jsx 中 byNumber 分组 + runPool），如果 200 份文件发票号全部相同，
importHistoryQuery 计数器只会记到 1 次，「网络尾巴」这条归因链就会被低估甚至证伪。

用法（单行）：
  backend/venv/Scripts/python.exe outputs/perf-white1-make-dataset.py --count 200 --out test_fixtures/perf/S-200

可选：
  --count N     生成数量（默认 200）
  --out DIR     输出目录（默认 test_fixtures/perf/S-200）
  --pages N     每份文件页数（默认 1；>1 可测多页文档分组开销）
  --clean       生成前清空输出目录
"""
import argparse
import os
import sys

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.stderr.write("ERROR: 需要 PyMuPDF。请用 backend/venv/Scripts/python.exe 运行本脚本。\n")
    sys.exit(1)

# A4 纵向（pt）
PAGE_W, PAGE_H = 595.28, 841.89

# 电子发票号码为 20 位数字；前缀固定，后 4 位递增保证唯一
NUMBER_PREFIX = "2595200000012767"  # 16 位
NUMBER_SUFFIX_WIDTH = 4             # 后 4 位 → 0001..9999


def make_invoice_number(idx):
    """idx 从 1 开始，生成 20 位唯一发票号码。"""
    return NUMBER_PREFIX + str(idx).zfill(NUMBER_SUFFIX_WIDTH)


def build_pdf(path, idx, pages=1):
    doc = fitz.open()
    number = make_invoice_number(idx)
    try:
        for p in range(pages):
            page = doc.new_page(width=PAGE_W, height=PAGE_H)
            page_no = f"{p + 1} / {pages}" if pages > 1 else "1 / 1"

            lines = [
                (72, 80, "电子发票（普通发票）", 20),
                (72, 130, f"发票号码：{number}", 14),
                (72, 165, f"开票日期：2026年09月0{(idx % 9) + 1}日", 11),
                (72, 200, "购买方名称：性能测试样本有限公司", 11),
                (72, 230, "销售方名称：法票狗性能测试样本中心", 11),
                (72, 300, "项目名称            规格  数量   单价      金额", 11),
                (72, 330, f"咨询服务费         项    1   1000.00   {1000 + idx}.00", 11),
                (72, 360, f"技术服务费         项    2    500.00   {1000 + idx * 2}.00", 11),
                (72, 430, f"合计（含税）：￥{2000 + idx * 3}.00", 13),
                (72, 470, f"价税合计（大写）：贰仟零贰拾元整", 11),
                (72, 520, f"备注：PERF-WHITE-1 S-200 测试样本 #{idx:04d}  页码 {page_no}", 9),
                (72, 780, f"样本序号 {idx:04d}", 8),
            ]
            for x, y, text, size in lines:
                # china-s = PyMuPDF 内置简体中文字体（Droid Sans Fallback），无需外部字体文件
                page.insert_text(
                    (x, y),
                    text,
                    fontname="china-s",
                    fontsize=size,
                    color=(0, 0, 0),
                )
        doc.save(path, garbage=4, deflate=True)
    finally:
        doc.close()
    return number


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=200)
    ap.add_argument("--out", default=os.path.join("test_fixtures", "perf", "S-200"))
    ap.add_argument("--pages", type=int, default=1)
    ap.add_argument("--clean", action="store_true")
    args = ap.parse_args()

    if args.count > 9999:
        sys.stderr.write("ERROR: 后缀仅 4 位，count 上限 9999。\n")
        sys.exit(1)

    os.makedirs(args.out, exist_ok=True)

    if args.clean:
        removed = 0
        for name in os.listdir(args.out):
            if name.lower().endswith(".pdf"):
                os.remove(os.path.join(args.out, name))
                removed += 1
        if removed:
            print(f"[clean] 已删除旧样本 {removed} 个")

    numbers = []
    for i in range(1, args.count + 1):
        path = os.path.join(args.out, f"invoice_{i:04d}.pdf")
        numbers.append(build_pdf(path, i, args.pages))
        if i % 50 == 0:
            print(f"[gen] {i}/{args.count}")

    assert len(set(numbers)) == len(numbers), "发票号出现重复，数据集不可用"

    total = sum(
        os.path.getsize(os.path.join(args.out, f))
        for f in os.listdir(args.out)
        if f.lower().endswith(".pdf")
    )
    print(f"[done] 输出目录: {os.path.abspath(args.out)}")
    print(f"[done] 文件数: {args.count}  页数/份: {args.pages}  总大小: {total / 1024 / 1024:.2f} MB")
    print(f"[done] 发票号范围: {numbers[0]} .. {numbers[-1]}（唯一性校验通过）")


if __name__ == "__main__":
    main()
