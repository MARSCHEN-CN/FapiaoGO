# -*- coding: utf-8 -*-
"""
_switch_bench.py — 只读基准：测量「切换发票 → 展示区出图」后端链路耗时。
不修改任何生产代码。测量项：
  A. 冷渲染（registry 命中 / render cache miss）
  B. 热渲染（render cache 命中）
  C. 预取并发下的前台渲染（6 个后台渲染同时跑）
  D. registry 容量上限（MAX_DOCUMENTS）触发淘汰后的行为
  E. 双 URL 变体（plain vs spec）造成的缓存条目翻倍
"""
import io
import os
import sys
import time
import threading
import statistics

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend'))

import fitz  # noqa

from render_engine.registry import DocumentRegistry  # noqa
from render_engine.engine import RenderEngine  # noqa
from render_engine.cache import RenderCache  # noqa


class _DummyQueue:
    """不真的跑后台任务，避免基准测量被后台线程污染。"""
    def submit(self, *a, **k):
        return ""


def make_pdf(i, pages=1):
    """生成一张轻量的发票样张 PDF（含少量矢量内容，模拟真实发票）。"""
    doc = fitz.open()
    for p in range(pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 80), f"INVOICE #{i:05d} PAGE {p+1}", fontsize=18)
        for k in range(12):
            page.insert_text((60, 140 + k * 24), f"item {k} amount {k*13.5:.2f} idx={i}", fontsize=10)
        page.draw_rect(fitz.Rect(40, 40, 555, 800), width=1)
    data = doc.tobytes(deflate=True)
    doc.close()
    return data


def fmt(ms):
    return f"{ms:8.2f} ms"


def main():
    n_docs = int(sys.argv[1]) if len(sys.argv) > 1 else 220
    print(f"== 生成 {n_docs} 份测试 PDF ==")
    t0 = time.perf_counter()
    blobs = [make_pdf(i) for i in range(n_docs)]
    print(f"   生成耗时 {fmt((time.perf_counter()-t0)*1000)}  平均体积 "
          f"{sum(len(b) for b in blobs)/n_docs/1024:.1f} KB")

    reg = DocumentRegistry()
    print(f"   DocumentRegistry.MAX_DOCUMENTS = {reg.MAX_DOCUMENTS}")

    # ── 注册全部文档（模拟 200+ 导入）──
    t0 = time.perf_counter()
    doc_ids = []
    for i, b in enumerate(blobs):
        d = reg.open(b, f"invoice_{i:05d}.pdf")
        doc_ids.append(d.doc_id)
    print(f"   注册 {n_docs} 份耗时 {fmt((time.perf_counter()-t0)*1000)}")
    print(f"   registry 实际持有 {len(reg._docs)} 份  ← 超出上限即触发淘汰")

    eng = RenderEngine(reg, RenderCache(), _DummyQueue())

    print("\n== A/B: 单次渲染 冷 vs 热（前 20 份）==")
    cold, warm = [], []
    for i in range(min(20, n_docs)):
        t = time.perf_counter()
        data, f, etag = eng.render(doc_id=doc_ids[i], preset_name="preview", page=1,
                                   accept_header="image/webp")
        cold.append((time.perf_counter()-t)*1000)
        t = time.perf_counter()
        eng.render(doc_id=doc_ids[i], preset_name="preview", page=1, accept_header="image/webp")
        warm.append((time.perf_counter()-t)*1000)
    print(f"   冷渲染 中位 {fmt(statistics.median(cold))}  均值 {fmt(statistics.mean(cold))}  max {fmt(max(cold))}")
    print(f"   热渲染 中位 {fmt(statistics.median(warm))}  均值 {fmt(statistics.mean(warm))}  max {fmt(max(warm))}")

    # payload 体积
    d0, f0, _ = eng.render(doc_id=doc_ids[0], preset_name="preview", page=1, accept_header="image/webp")
    print(f"   产物体积 {len(d0)/1024:.1f} KB  格式 {f0}")

    print("\n== C: 预取并发（6 个后台渲染）下的前台渲染延迟 ==")
    # 先清空 cache 让后台任务真的渲染
    eng._cache.clear()
    fg_lat = []
    for i in range(10):
        stop = threading.Event()
        ts = []
        def bg(j):
            t = time.perf_counter()
            try:
                eng.render(doc_id=doc_ids[(i*7+j+50) % n_docs], preset_name="preview",
                           page=1, accept_header="image/webp")
            except Exception:
                pass
            ts.append((time.perf_counter()-t)*1000)
        threads = [threading.Thread(target=bg, args=(j,)) for j in range(6)]
        for th in threads: th.start()
        t = time.perf_counter()
        eng.render(doc_id=doc_ids[i % n_docs], preset_name="preview", page=1,
                   accept_header="image/webp")
        fg_lat.append((time.perf_counter()-t)*1000)
        for th in threads: th.join()
    print(f"   前台延迟 中位 {fmt(statistics.median(fg_lat))}  max {fmt(max(fg_lat))}")

    print("\n== D: 超出 MAX_DOCUMENTS 后的 registry 行为 ==")
    print(f"   MAX_DOCUMENTS={reg.MAX_DOCUMENTS} 已注册={len(reg._docs)}")
    if len(reg._docs) < n_docs:
        missing = [d for d in doc_ids if reg.get(d) is None]
        print(f"   ⚠ 已被淘汰、registry 查不到的文档数 = {len(missing)}")
        hit, miss = 0, 0
        for d in doc_ids:
            try:
                eng.render(doc_id=d, preset_name="preview", page=1, accept_header="image/webp")
                hit += 1
            except Exception:
                miss += 1
        print(f"   但 render 仍成功（靠 render cache）= {hit}，抛 DocumentNotRegistered = {miss}")

    print("\n== E: 双 URL 变体对 render cache 条目的放大 ==")
    eng._cache.clear()
    for i in range(min(n_docs, 200)):
        eng.render(doc_id=doc_ids[i], preset_name="preview", page=1, accept_header="image/webp")
    n_plain = eng._cache.size
    for i in range(min(n_docs, 200)):
        eng.render(doc_id=doc_ids[i], preset_name="preview", page=1,
                   accept_header="image/webp", render_spec={"placement": {"scale": 1.0, "offsetX": 0, "offsetY": 0}})
    n_both = eng._cache.size
    print(f"   仅 plain URL 变体 → {n_plain} 条")
    print(f"   plain + spec 两个变体 → {n_both} 条  (放大 {n_both/max(n_plain,1):.2f}×)")
    print(f"   RenderCache.MAX_ENTRIES = {RenderCache.MAX_ENTRIES}")


def _accepts(cls, name):
    import inspect
    try:
        return name in inspect.signature(cls.__init__).parameters
    except Exception:
        return False


if __name__ == '__main__':
    main()
