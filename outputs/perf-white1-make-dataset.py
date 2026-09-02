#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
PERF-WHITE-1 S-200 测试数据集生成器

用途：为大批量导入性能基线生成 200 份「发票号唯一」的 PDF。
为什么要发票号唯一 —— 前端 importHistory 是按发票号聚合后批量查询的
（FileContext.jsx 中 byNumber 分组 + runPool），如果 200 份文件发票号全部相同，
importHistoryQuery 计数器只会记到 1 次，「网络尾巴」这条归因链就会被低估甚至证伪。

用法（单行，PowerShell 5.1 用 ; 不用 &&）：
  cd E:\print706; backend\venv\Scripts\python.exe outputs/perf-white1-make-dataset.py --count 200 --out test_fixtures/perf/S-200

可选：
  --count N     生成数量（默认 200）
  --out DIR     输出目录（默认 test_fixtures/perf/S-200）
  --pages N     每份文件页数（默认 1；>1 可测多页文档分组开销）
  --clean       生成前清空输出目录
  --start N     发票号起始序号（默认 1）——★ 用于造多组互不相交的数据集

────────────────────────────────────────────────────────────────
★ 为什么需要 --start：3 轮基线必须是「同一次冷导入」

后端 `import_history` 按**发票号**累计 importCount（每次导入 +1），
前端只有 `importCount >= 2` 才会写 importHistoryInfo（FileContext.jsx:264），
写入即触发 Map 重建 + 全量重排。于是：

  第 1 轮 importCount=1 → 不写 → 冷路径（无网络回写尾巴）
  第 2 轮 importCount=2 → 写 200 次 → 热路径（200 次重排）
  第 3 轮 importCount=3 → 写 200 次 → 热路径

三轮走的不是同一条代码路径，取中位数等于把两种场景混在一起，结论不可信。

解法：用 --start 造 3 组号码互不相交的数据集，每轮导入一组全新的号码，
三轮全部走冷路径 → 可比、可聚合。

  cd E:\print706; backend/venv/Scripts/python.exe outputs/perf-white1-make-dataset.py --start 1 --count 200 --out test_fixtures/perf/S-200-A
  cd E:\print706; backend/venv/Scripts/python.exe outputs/perf-white1-make-dataset.py --start 201 --count 200 --out test_fixtures/perf/S-200-B
  cd E:\print706; backend/venv/Scripts/python.exe outputs/perf-white1-make-dataset.py --start 401 --count 200 --out test_fixtures/perf/S-200-C

⚠️ 不要用「删 database/invoice_import_history.json」来重置：
后端把历史缓存在模块级全局变量（import_history.py:158 _history_by_number），
且 atexit 会从内存写回覆盖文件 —— 进程活着删文件无效，退出时还会复活。
真要重置必须先停后端、删文件、再起后端。用 --start 换号码可以完全绕开这个坑。
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
    ap.add_argument("--start", type=int, default=1,
                    help="发票号起始序号（默认 1）；造多组互不相交数据集时用（见文件头说明）")
    args = ap.parse_args()

    if args.start < 1:
        sys.stderr.write("ERROR: --start 必须 >= 1。\n")
        sys.exit(1)
    end_idx = args.start + args.count - 1
    if end_idx > 9999:
        sys.stderr.write(f"ERROR: 后缀仅 4 位，序号上限 9999；start={args.start} + count={args.count} - 1 = {end_idx} 超限。\n")
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
    for n in range(args.count):
        idx = args.start + n
        path = os.path.join(args.out, f"invoice_{idx:04d}.pdf")
        numbers.append(build_pdf(path, idx, args.pages))
        if (n + 1) % 50 == 0:
            print(f"[gen] {n + 1}/{args.count}（序号 {idx}）")

    assert len(set(numbers)) == len(numbers), "发票号出现重复，数据集不可用"

    total = sum(
        os.path.getsize(os.path.join(args.out, f))
        for f in os.listdir(args.out)
        if f.lower().endswith(".pdf")
    )
    print(f"[done] 输出目录: {os.path.abspath(args.out)}")
    print(f"[done] 文件数: {args.count}  页数/份: {args.pages}  总大小: {total / 1024 / 1024:.2f} MB")
    print(f"[done] 发票号范围: {numbers[0]} .. {numbers[-1]}（序号 {args.start}..{end_idx}，唯一性校验通过）")


if __name__ == "__main__":
    main()
