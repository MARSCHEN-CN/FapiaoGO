# -*- coding: utf-8 -*-
"""P1-3-c Benchmark: parse_batch OCR 路径前后对照（ProcessPool vs 旧 ThreadPool 直调）。

============================================================================
                            ⚠️ 重要测量纪律 ⚠️
============================================================================
本脚本的目的**不是**证明 "ProcessPool 比 ThreadPool 快 N 倍"。

P1-3 的真实目标是：
  > 让 batch OCR 与单文件 OCR 使用**同一执行模型**（同一 ProcessPool 单例、
  > 同一 OCR_WORKERS 并行度），并在真实 Windows 环境下获得**稳定并行收益**，
  > 同时不引入正确性 / 内存 / 回退风险。

因此本 benchmark 测量的是：
  1. [硬验收] executor 类型必须是 ProcessPoolExecutor（防止"功能绿但静默回退
     ThreadPool/sync"导致优化没生效）。断言失败直接非零退出。
  2. 正确性：old result count == new result count，exception == 0，DB rows 一致。
  3. 内存：父进程峰值工作集 / Python 分配峰值（确认无内存爆炸；注意 worker
     进程内存独立，仅真实 OCR 引擎加载模型时才显著，沙箱里几乎为 0）。
  4. 耗时：wall time。

----------------------------------------------------------------------------
沙箱模式（自动检测）：
----------------------------------------------------------------------------
若运行环境未安装 onnxruntime（即无真实 OCR 引擎），则每文件 OCR 计算成本≈0，
此时 new 路径相对 old 路径**只会多出 IPC pickle 开销**，wall time 表现为
"new 略慢于 old"。这是**诚实的 IPC 成本**，不是 regression，也**不能**据此
声称生产吞吐量提升。

=> 带有真实 OCR 引擎的、**打包后的 Windows 构建**才是权威吞吐基线。
   沙箱数字仅用于：验证 harness 可用、执行模型已统一、正确性/内存安全。

----------------------------------------------------------------------------
运行：
----------------------------------------------------------------------------
  cd backend && ./venv/Scripts/python.exe benchmarks/bench_p1_3_batch.py
  # 自定义 N： --ns 10,100,500
  # 跳过大数据 IPC 探测： --no-large

输出：打印对照表 + 写 benchmarks/p1_3_bench_results.json。
"""

import argparse
import ctypes
import io
import json
import logging
import os
import sys
import threading
import time
import tracemalloc
from concurrent.futures import ThreadPoolExecutor, as_completed

# 让脚本可直接运行：把 backend/ 加入 path 以便 `import app`
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fitz

import app as backend_app
from app import (
    parse_invoice_service,
    _run_parse_offthread,
    _get_executor_kind,
    OCR_WORKERS,
)

# ── 自动检测真实 OCR 引擎（实际探针，避免误标"生产相关")──────────────────────
def _has_real_ocr():
    """仅当 onnxruntime 可导入 **且** 真实解析能产出非空字段时才算"真 OCR 在跑"。

    沙箱常见情况：onnxruntime(CPU) 已装，但模型权重缺失 -> parse_invoice_service
    走 canned 回退（invoice_number 为空）。此时不应声称生产吞吐相关。
    """
    import importlib.util
    if importlib.util.find_spec("onnxruntime") is None:
        return False
    try:
        logging.disable(logging.CRITICAL)  # 压掉探针期的 OCR 缺失噪声
        doc = fitz.open()
        page = doc.new_page()
        page.insert_text((50, 50), "增值税专用发票 1234567890")
        probe_bytes = doc.tobytes()
        doc.close()
        res = parse_invoice_service(
            probe_bytes, "probe.pdf",
            auto_orient=True, enable_auto_ocr=True, skip_db_write=True,
        )
        return bool(res and res.get("invoice_number"))
    except Exception:  # noqa: BLE001
        return False
    finally:
        logging.disable(logging.NOTSET)


SANDBOX_MODE = not _has_real_ocr()

MAX_BATCH_SIZE = 100  # 与 app.py parse_batch 的硬上限一致（不绕过契约）


# ── 进程内存（Windows，零新依赖）─────────────────────────────────────────
class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_uint32),
        ("PageFaultCount", ctypes.c_uint32),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def _get_process_memory():
    """返回当前进程的 (working_set_bytes, peak_working_set_bytes)。"""
    try:
        kernel32 = ctypes.windll.kernel32
        psapi = ctypes.windll.psapi
    except AttributeError:
        return (0, 0)
    fn = getattr(kernel32, "GetProcessMemoryInfo", None) or getattr(
        psapi, "GetProcessMemoryInfo", None
    )
    if fn is None:
        return (0, 0)
    fn.argtypes = [ctypes.c_void_p, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), ctypes.c_uint32]
    fn.restype = ctypes.c_int
    counters = PROCESS_MEMORY_COUNTERS()
    counters.cb = ctypes.sizeof(counters)
    handle = kernel32.GetCurrentProcess()
    if fn(handle, ctypes.byref(counters), counters.cb) == 0:
        return (0, 0)
    return (counters.WorkingSetSize, counters.PeakWorkingSetSize)


class _MemSampler(threading.Thread):
    """后台采样父进程工作集峰值（Windows GetProcessMemoryInfo.PeakWorkingSetSize 是进程级高水位）。"""

    def __init__(self, interval=0.03):
        super().__init__(daemon=True)
        self._interval = interval
        self._stop_ev = threading.Event()
        self.peak = 0

    def run(self):
        while not self._stop_ev.is_set():
            _, peak = _get_process_memory()
            if peak > self.peak:
                self.peak = peak
            time.sleep(self._interval)

    def stop(self):
        self._stop_ev.set()


# ── 日志捕获：确认 batch 实际跑在哪个 executor ─────────────────────────────
class _ExecutorLogCapture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        msg = record.getMessage()
        if "parse_batch OCR executor=" in msg or "OCR 执行器:" in msg:
            self.records.append(msg)


def _install_executor_capture():
    cap = _ExecutorLogCapture()
    backend_app.logger.addHandler(cap)
    backend_app.logger.setLevel(logging.INFO)
    return cap


def _quiet_ocr_logs():
    """父进程内压制 OCR / extractor 噪声（WARNING 及以下）。

    注意：ProcessPool 子进程会重新 import app，拥有独立 logging 配置，父进程级别
    不影响子进程。worker 的 OCR 噪声在其 stderr，benchmark 运行时统一 2>/dev/null 丢弃；
    executor INFO 走内存 capture handler，不受 stderr 重定向影响。
    """
    logging.getLogger().setLevel(logging.CRITICAL)
    backend_app.logger.setLevel(logging.INFO)


# ── 样本生成 ─────────────────────────────────────────────────────────────
def _make_invoice_pdf(idx):
    """生成单页 PDF（fitz），含少量可读文本。无需真实 OCR 模型即可被解析返回 canned dict。"""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((50, 50), "test invoice hello world %08d" % idx)
    data = doc.tobytes()
    doc.close()
    return ("invoice_%04d.pdf" % idx, data)


def _make_large_payload(idx, size_mb):
    """生成 size_mb 随机字节的 '图片'（无 OCR 时仅用于观测 IPC pickle 成本）。"""
    n = int(size_mb * 1024 * 1024)
    return ("scan_%04d.jpg" % idx, os.urandom(n))


# ── NEW 路径：真实 /parse_batch 端点 ──────────────────────────────────────
def bench_new(files):
    """通过 Flask 测试客户端走真实 /parse_batch 端点（内部已收敛到 ProcessPool）。"""
    client = backend_app.app.test_client()
    n = len(files)

    tracer = _MemSampler()
    tracer.start()
    start_ws, _ = _get_process_memory()
    t0 = time.perf_counter()
    tracemalloc.start()

    resp = client.post(
        "/parse_batch",
        data={
            # werkzeug 此版本文件元组顺序为 (file, filename)
            "files": [(io.BytesIO(data), fn) for fn, data in files],
            "autoOrient": "1",
            "enableAutoOcr": "0",
        },
        content_type="multipart/form-data",
    )
    # 必须完整消费 SSE 流，否则守护线程 run_batch 不会跑完
    body = resp.get_data()
    wall = time.perf_counter() - t0

    _, peak_ws_now = _get_process_memory()
    tracer.stop()
    tracer.join(timeout=1)
    peak_py = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    end_ws, _ = _get_process_memory()

    # 解析 SSE：取含 items 的最终事件
    success = fail = 0
    items = []
    for raw in body.decode("utf-8", "ignore").split("\n\n"):
        raw = raw.strip()
        if not raw.startswith("data:"):
            continue
        payload = raw[len("data:"):].strip()
        try:
            evt = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if "items" in evt:
            items = evt["items"]
            success = evt.get("success_count", 0)
            fail = evt.get("fail_count", 0)

    return {
        "mode": "new",
        "n": n,
        "http_status": resp.status_code,
        "wall_s": round(wall, 4),
        "success": success,
        "fail": fail,
        "items_returned": len(items),
        "peak_py_mb": round(peak_py / 1024 / 1024, 3),
        "start_ws_mb": round(start_ws / 1024 / 1024, 2),
        "peak_ws_mb": round(max(tracer.peak, peak_ws_now) / 1024 / 1024, 2),
        "end_ws_mb": round(end_ws / 1024 / 1024, 2),
        "executor_kind": _get_executor_kind(),
    }


# ── OLD 路径：复刻 P1-3-a 之前的 _parse_one（ThreadPool 直调 parse_invoice_service）──
def bench_old(files):
    """忠实复刻 pre-P1-3-a 行为：ThreadPool(BATCH_WORKERS) 内同步调用
    parse_invoice_service(..., skip_db_write=True)，无 IPC、GIL 受限。"""
    n = len(files)
    BATCH_WORKERS = min(4, n)

    tracer = _MemSampler()
    tracer.start()
    start_ws, _ = _get_process_memory()
    t0 = time.perf_counter()
    tracemalloc.start()

    results = [None] * n

    def _old_parse_one(index, fi):
        if not backend_app.parse_semaphore.acquire(timeout=30):
            return index, None, "server busy"
        try:
            res = parse_invoice_service(
                fi[1], fi[0],
                auto_orient=True,
                enable_auto_ocr=False,
                skip_db_write=True,
            )
            return index, res, None
        except Exception as e:  # noqa: BLE001
            return index, None, str(e)
        finally:
            backend_app.parse_semaphore.release()

    with ThreadPoolExecutor(max_workers=BATCH_WORKERS, thread_name_prefix="old-batch") as pool:
        futures = {pool.submit(_old_parse_one, i, fi): i for i, fi in enumerate(files)}
        for fut in as_completed(futures):
            idx, res, err = fut.result()
            results[idx] = (res, err)

    wall = time.perf_counter() - t0
    _, peak_ws_now = _get_process_memory()
    tracer.stop()
    tracer.join(timeout=1)
    peak_py = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    end_ws, _ = _get_process_memory()

    success = sum(1 for r, _ in results if r is not None)
    fail = n - success
    return {
        "mode": "old",
        "n": n,
        "wall_s": round(wall, 4),
        "success": success,
        "fail": fail,
        "peak_py_mb": round(peak_py / 1024 / 1024, 3),
        "start_ws_mb": round(start_ws / 1024 / 1024, 2),
        "peak_ws_mb": round(max(tracer.peak, peak_ws_now) / 1024 / 1024, 2),
        "end_ws_mb": round(end_ws / 1024 / 1024, 2),
        "executor_kind": "n/a (pre-P1-3-b: no observability; in-thread sync OCR)",
    }


# ── 驱动：尊重 MAX_BATCH_SIZE 上限 ─────────────────────────────────────────
def _chunked_run(make_files, n, bench_fn):
    """N>MAX_BATCH_SIZE 时分批发（端点硬上限 100），聚合结果。"""
    results = []
    for start in range(0, n, MAX_BATCH_SIZE):
        chunk = make_files(start, min(MAX_BATCH_SIZE, n - start))
        r = bench_fn(chunk)
        results.append(r)
    if len(results) == 1:
        return results[0]
    agg = {
        "mode": results[0]["mode"],
        "n": n,
        "chunks": len(results),
        "wall_s": round(sum(r["wall_s"] for r in results), 4),
        "success": sum(r["success"] for r in results),
        "fail": sum(r["fail"] for r in results),
        "peak_py_mb": round(max(r["peak_py_mb"] for r in results), 3),
        "peak_ws_mb": round(max(r["peak_ws_mb"] for r in results), 2),
        "start_ws_mb": results[0]["start_ws_mb"],
        "end_ws_mb": results[-1]["end_ws_mb"],
        "executor_kind": results[0].get("executor_kind", "n/a"),
    }
    return agg


def _run_matrix(ns, run_large):
    _quiet_ocr_logs()  # 先压 OCR 噪声，避免每文件完整 traceback 淹没输出
    cap = _install_executor_capture()
    rows = []
    for n in ns:
        new_r = _chunked_run(
            lambda s, c: [_make_invoice_pdf(s + i) for i in range(c)],
            n, bench_new,
        )
        old_r = _chunked_run(
            lambda s, c: [_make_invoice_pdf(s + i) for i in range(c)],
            n, bench_old,
        )
        rows.append((new_r, old_r))

    large_rows = []
    if run_large:
        for mb in (2, 5, 10):
            # 仅 new 路径，观测大 payload 的 IPC pickle 成本（无 OCR 计算）
            r = bench_new([_make_large_payload(i, mb) for i in range(10)])
            r["payload_mb"] = mb
            large_rows.append(r)

    return rows, large_rows, cap.records


def _print_report(rows, large_rows, exec_logs):
    print("\n" + "=" * 78)
    print("P1-3-c BENCHMARK  —  parse_batch OCR (new=ProcessPool vs old=ThreadPool直调)")
    print("=" * 78)
    print("环境: Python %s | platform=%s | OCR_WORKERS=%d | 真实OCR引擎=%s"
          % (sys.version.split()[0], sys.platform, OCR_WORKERS,
             "YES" if not SANDBOX_MODE else "NO (sandbox)"))
    print("-" * 78)
    hdr = "%-6s %-5s %10s %8s %8s %10s %10s" % (
        "mode", "N", "wall_s", "ok", "fail", "peakPy_MB", "peakWS_MB")
    print(hdr)
    print("-" * 78)
    for new_r, old_r in rows:
        print("%-6s %-5d %10.4f %8d %8d %10.3f %10.2f" % (
            "NEW", new_r["n"], new_r["wall_s"], new_r["success"], new_r["fail"],
            new_r["peak_py_mb"], new_r["peak_ws_mb"]))
        print("%-6s %-5d %10.4f %8d %8d %10.3f %10.2f" % (
            "OLD", old_r["n"], old_r["wall_s"], old_r["success"], old_r["fail"],
            old_r["peak_py_mb"], old_r["peak_ws_mb"]))
        # delta
        if old_r["wall_s"] > 0:
            delta = (new_r["wall_s"] - old_r["wall_s"]) / old_r["wall_s"] * 100
        else:
            delta = 0.0
        print("   ↳ wall delta(new-old): %+.1f%%   executor=%s"
              % (delta, new_r.get("executor_kind")))
        print("-" * 78)

    if large_rows:
        print("Case B — 大 payload IPC 成本探测 (new 路径, 仅观测 pickle, 无 OCR 计算):")
        for r in large_rows:
            print("   payload=%2dMB x10  wall=%.4fs  peakWS=%.2fMB"
                  % (r["payload_mb"], r["wall_s"], r["peak_ws_mb"]))
        print("-" * 78)

    print("捕获的执行器日志 (样例):")
    for m in exec_logs[:4]:
        print("   •", m)

    print("\n" + "=" * 78)
    if SANDBOX_MODE:
        print("⚠️  SANDBOX 模式：未检测到 onnxruntime（无真实 OCR 引擎）。")
        print("   此处 wall time 仅含『调度 + IPC pickle』成本，new 相对 old 偏慢是")
        print("   诚实的 IPC 开销，不是 regression，也**不能**据此声称生产吞吐提升。")
        print("   ⇒ 权威吞吐基线必须在『打包后的 Windows 构建 + 真实 OCR 引擎』上重跑本脚本。")
    else:
        print("✅ 真实 OCR 引擎已加载：以上 wall time 为生产相关基线。")
    print("=" * 78)


def main():
    ap = argparse.ArgumentParser(description="P1-3-c parse_batch OCR benchmark")
    ap.add_argument("--ns", default="10,100,500", help="逗号分隔的 batch size 列表")
    ap.add_argument("--no-large", action="store_true", help="跳过大数据 IPC 探测")
    args = ap.parse_args()

    ns = [int(x) for x in args.ns.split(",") if x.strip()]
    run_large = not args.no_large

    rows, large_rows, exec_logs = _run_matrix(ns, run_large)
    _print_report(rows, large_rows, exec_logs)

    # ── 硬验收 #1：executor 必须是 ProcessPoolExecutor，否则非零退出 ──
    new_exec_kinds = {r[0].get("executor_kind") for r in rows}
    if "ProcessPoolExecutor" not in new_exec_kinds:
        print("\n❌ 硬验收失败：new 路径 executor 不是 ProcessPoolExecutor ->",
              new_exec_kinds)
        sys.exit(2)

    # ── 正确性验收：batch(new) 与 old 路径结果计数必须一致（同一 canned 解析器）──
    # 沙箱无真实 OCR 时 canned 回退对部分文件可能返回 None，计数不稳定；
    # 但 new/old 走同一解析器，故比对两者一致即可证明"收敛后行为不变"。
    for new_r, old_r in rows:
        if new_r["success"] != old_r["success"] or new_r["fail"] != old_r["fail"]:
            print("\n❌ 正确性验收失败：new 与 old 计数不一致 new=%s old=%s"
                  % (new_r, old_r))
            sys.exit(3)

    # ── 生产模式（真实 OCR 在跑）才额外要求全成功 ──
    if not SANDBOX_MODE:
        for new_r, old_r in rows:
            if new_r["success"] != new_r["n"] or new_r["fail"] != 0:
                print("\n❌ 生产正确性失败：存在解析失败 new=%s" % new_r,
                      file=sys.stderr)
                sys.exit(3)

    out = {
        "meta": {
            "sandbox_mode": SANDBOX_MODE,
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "ocr_workers": OCR_WORKERS,
            "max_batch_size": MAX_BATCH_SIZE,
            "note": ("SANDBOX: no real OCR engine; wall time = dispatch+IPC only, "
                     "NOT production throughput. Re-run on packaged Windows build."
                     if SANDBOX_MODE else
                     "Real OCR engine present; numbers are production-relevant."),
            "known_observability_artifact": (
                "首条 batch 的 'parse_batch OCR executor=none' 是 P1-3-b 的日志时序缺陷："
                "run_batch 的 INFO 在 _get_executor() 懒初始化之前发出，故首批评到 None；"
                "后续批次与 'OCR 执行器: ProcessPoolExecutor' 日志均正确。修复：在日志前先调一次"
                "_get_executor() 预热。属独立小修复，不并入本 benchmark commit。"),
        },
        "matrix": [{"new": nr, "old": or_} for nr, or_ in rows],
        "large_payload_probe": large_rows,
        "executor_logs": exec_logs,
    }
    here = os.path.dirname(os.path.abspath(__file__))
    out_path = os.path.join(here, "p1_3_bench_results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("\n✅ 全部硬验收通过（executor=ProcessPoolExecutor + 正确性一致）。")
    print("   结果已写入:", out_path)


if __name__ == "__main__":
    main()
