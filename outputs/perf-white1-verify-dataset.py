#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
PERF-WHITE-1 数据集自检工具

用途：在正式跑基线之前，确认数据集「能被后端解析出唯一发票号」。

为什么必须自检 —— 前端 importHistory 是按发票号分组后批量查询的
（FileContext.jsx 里 byNumber 分组 + runPool）。如果数据集里的发票号大量重复或为空，
importHistoryQuery 计数器会远小于文件数，「网络尾巴」这条归因链会被**假证伪**；
更糟的情况是整批解析失败，200 个文件全进失败分支，测出来的时间线完全没有意义。

用法（单行，取样检测默认 5 份，全量加 --all）：
  backend/venv/Scripts/python.exe outputs/perf-white1-verify-dataset.py test_fixtures/perf/S-200

可选：
  --all          全量检测（200 份约需数分钟，取决于 OCR 负载）
  --sample N     取样份数（默认 5，取首/中/尾三段）
  --expect N     期望文件总数（默认按目录内 pdf 计数），用于核对数量是否够

退出码：0 = 通过；1 = 数据集不可用（必须修好再跑基线）
"""
import argparse
import os
import sys
import logging

# 解析过程日志噪音极大，压掉
logging.disable(logging.CRITICAL)

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'backend')))

try:
    from app import parse_invoice_service
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"ERROR: 无法导入后端解析服务（是否用了 backend/venv/Scripts/python.exe？）: {exc}\n")
    sys.exit(1)


def pick_samples(files, sample_n, use_all):
    if use_all or sample_n >= len(files):
        return files
    n = len(files)
    idx = set()
    # 首/中/尾三段均匀取样，覆盖编号边界
    for k in range(sample_n):
        idx.add(min(n - 1, round(k * (n - 1) / max(1, sample_n - 1))))
    return [files[i] for i in sorted(idx)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("directory")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--sample", type=int, default=5)
    ap.add_argument("--expect", type=int, default=0)
    args = ap.parse_args()

    d = os.path.abspath(args.directory)
    if not os.path.isdir(d):
        sys.stderr.write(f"ERROR: 目录不存在: {d}\n")
        sys.exit(1)

    files = sorted(f for f in os.listdir(d) if f.lower().endswith('.pdf'))
    if not files:
        sys.stderr.write(f"ERROR: 目录内没有 PDF: {d}\n")
        sys.exit(1)

    expect = args.expect or len(files)
    print(f"[info] 目录: {d}")
    print(f"[info] PDF 文件数: {len(files)}（期望 {expect}）")

    samples = pick_samples(files, args.sample, args.all)
    print(f"[info] 检测 {len(samples)} 份{'（全量）' if args.all else '（取样，全量请加 --all）'}")

    numbers = {}
    failed = []
    for i, name in enumerate(samples, 1):
        with open(os.path.join(d, name), 'rb') as f:
            data = f.read()
        try:
            res = parse_invoice_service(data, name, auto_orient=True,
                                        enable_auto_ocr=True, skip_db_write=True)
            num = (res or {}).get('invoice_number', '') or ''
        except Exception as exc:  # noqa: BLE001
            num = ''
            print(f"  [{i}/{len(samples)}] {name}: EXCEPTION {type(exc).__name__}: {exc}")
        if not num:
            failed.append(name)
            print(f"  [{i}/{len(samples)}] {name}: <空>")
        else:
            numbers.setdefault(num, []).append(name)
        if i % 20 == 0:
            print(f"  ... {i}/{len(samples)}")

    total = len(samples)
    ok = total - len(failed)
    unique = len(numbers)
    dup = {k: v for k, v in numbers.items() if len(v) > 1}

    print("\n===== 自检结果 =====")
    print(f"检测份数        : {total}")
    print(f"解析成功        : {ok}")
    print(f"解析失败/空号   : {len(failed)}")
    print(f"唯一发票号      : {unique}")
    if dup:
        print(f"重复发票号      : {len(dup)} 个（例: {list(dup)[:3]}）")

    problems = []
    if len(files) < expect:
        problems.append(f"文件数不足：{len(files)} < {expect}")
    if failed:
        problems.append(f"{len(failed)} 份解析失败或发票号为空（整批会走失败分支，时间线无意义）")
    if dup:
        problems.append(f"{len(dup)} 个发票号重复（importHistoryQuery 会被聚合，网络尾巴会被假证伪）")

    if problems:
        print("\n❌ 数据集不可用，请先修复：")
        for p in problems:
            print(f"   - {p}")
        sys.exit(1)

    print("\n✅ 数据集可用：文件数达标、全部解析成功、发票号唯一")
    sys.exit(0)


if __name__ == "__main__":
    main()
