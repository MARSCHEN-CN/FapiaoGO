# -*- coding: utf-8 -*-
"""
_phase1_verify.py — Phase 1 实验验证：R3（双管线重复渲染）与 R2（预取竞争）实测。

遵循「最小变量」原则，本脚本**只测量、不改生产代码**：

  实验 A（R3）：模拟一次「切换发票」发出的 /preview 请求序列，统计后端**真实渲染次数**
               （= RenderCache MISS 次数，MISS 才真正渲染）：
                 现状  = 展示区(无 spec, legacy) + 遗留 RE probe(带 spec, renderspec)
                 P1-A后 = 仅展示区(无 spec, legacy)
               期望：现状 MISS=2，P1-A 后 MISS=1。

  实验 B（R3 热路径）：A→B→C→A 来回切换，统计每次切换的渲染次数与耗时。

  实验 C（R2）：前台请求在「有/无后台预取并发」下的延迟对比（前台单变量）。

  实验 D（缓存存活）：200+ 文件规模下，切回 A 时缓存是否还在（LRU 挤压验证）。

运行：backend/venv/Scripts/python.exe outputs/perf-runs/switch-slow/_phase1_verify.py
"""
import io
import os
import sys
import time
import threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'backend'))

import fitz  # noqa
from PIL import Image  # noqa

from render_engine.registry import DocumentRegistry  # noqa
from render_engine.cache import RenderCache  # noqa
from render_engine.engine import RenderEngine  # noqa

logging_disabled = True
if logging_disabled:
    import logging
    logging.disable(logging.CRITICAL)


class _Q:
    """空队列：本脚本不同步跑后台预取，避免污染计数（实验 C 自行模拟并发）。"""
    def submit(self, *a, **k):
        return ""


def make_jpeg(w, h, seed=0):
    img = Image.new('RGB', (w, h), (250, 250, 245))
    px = img.load()
    for y in range(0, h, 7):
        for x in range(0, w, 13):
            px[x, y] = ((x * 7 + seed) % 255, (y * 11 + seed) % 255, 128)
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=88)
    return buf.getvalue()


def make_vector_pdf(i=0):
    doc = fitz.open()
    p = doc.new_page(width=595, height=842)
    for k in range(20):
        p.insert_text((60, 80 + k * 30), f"INVOICE #{i:05d} line {k} amount {k * 11.1:.2f}", fontsize=12)
    p.draw_rect(fitz.Rect(40, 40, 555, 800), width=1)
    data = doc.tobytes()
    doc.close()
    return data


# 模拟前端 buildRenderSpec 输出。必须是**合法** RenderCommand，否则 engine 走
# _render_spec_page → validate_render_command 会 400/ValueError（这本身也证明了：
# 带 spec 的请求走的是与 legacy 完全不同的渲染执行路径）。
# 必填项见 engine.py validate_render_command：version / placement{scale,offsetX,offsetY}
# / contentRotation / paperLandscape / paper{width,height}
SPEC = {
    'version': 1,
    'docId': 'x', 'page': 1, 'dpi': 150,
    'placement': {'scale': 1.0, 'offsetX': 0.0, 'offsetY': 0.0},
    'contentRotation': 0,
    'paperLandscape': False,
    'paper': {'width': 1240, 'height': 1754},
    'marginsMm': {'top': 3, 'right': 3, 'bottom': 3, 'left': 3},
}


class Counter:
    """包装 RenderCache.get，统计 MISS(=真实渲染) / HIT，并记录 cache_key。"""
    def __init__(self, cache):
        self.cache = cache
        self.miss = 0
        self.hit = 0
        self.keys = []
        self._orig = cache.get
        cache.get = self._get

    def _get(self, key):
        entry = self._orig(key)
        if entry is None:
            self.miss += 1
        else:
            self.hit += 1
        self.keys.append(key)
        return entry

    def reset(self):
        self.miss = self.hit = 0
        self.keys = []


def build_env():
    reg = DocumentRegistry()
    cache = RenderCache()
    eng = RenderEngine(reg, cache, _Q())
    return reg, cache, eng, Counter(cache)


def render_ms(eng, doc_id, spec=None, page=1):
    t = time.perf_counter()
    data, fmt, etag = eng.render(doc_id=doc_id, preset_name="preview", page=page,
                                 render_spec=spec, accept_header="image/webp")
    return (time.perf_counter() - t) * 1000, data, etag


def render_concurrent(eng, doc_id, page=1):
    """两条管线**同时**发起（模拟浏览器两个 <img> 并发加载），返回墙钟耗时。
    串行累加会高估墙钟：真实浏览器是并发发请求，墙钟取决于 CPU 竞争而非算术和。"""
    results = {}

    def one(tag, spec):
        ms, _data, etag = render_ms(eng, doc_id, spec=spec, page=page)
        results[tag] = (ms, etag)

    t1 = threading.Thread(target=one, args=('legacy', None))
    t2 = threading.Thread(target=one, args=('spec', SPEC))
    t0 = time.perf_counter()
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    return (time.perf_counter() - t0) * 1000, results


def main():
    print("=" * 92)
    print("Phase 1 验证 —— R3 双管线重复渲染 / R2 预取竞争（只读测量，不改生产代码）")
    print("=" * 92)

    cases = [
        ("矢量 PDF A4", make_vector_pdf(1), 'vector'),
        ("扫描件 1240x1754", make_jpeg(1240, 1754, seed=7), 'jpeg'),
        ("手机拍照 3000x4000", make_jpeg(3000, 4000, seed=3), 'jpeg'),
    ]

    # ── 实验 A：一次切换的渲染次数（冷）────────────────────────────────
    print("\n【实验 A】一次切换 = 几次真实渲染？（冷启动，MISS=真实渲染）")
    print("  墙钟 = 两条管线并发发起（模拟浏览器两个 <img> 同时加载）的真实等待时间")
    print(f"{'文档类型':<20} {'现状:渲染次数':>14} {'墙钟':>10} | {'P1-A:渲染次数':>14} {'墙钟':>10} {'墙钟节省':>10}")
    print("-" * 92)
    for name, blob, kind in cases:
        # 现状：展示区(spec=None) + 遗留 RE probe(spec 非空)，并发
        reg, cache, eng, cnt = build_env()
        doc = reg.open(blob, f"{name}.bin")
        cnt.reset()
        wall_dual, res = render_concurrent(eng, doc.doc_id)
        dual_miss = cnt.miss
        etag_l = res.get('legacy', (0, ''))[1]
        etag_s = res.get('spec', (0, ''))[1]

        # P1-A：仅展示区
        reg2, cache2, eng2, cnt2 = build_env()
        doc2 = reg2.open(blob, f"{name}.bin")
        cnt2.reset()
        wall_single, _data, _ = render_ms(eng2, doc2.doc_id, spec=None)
        single_miss = cnt2.miss

        save = (1 - wall_single / wall_dual) * 100 if wall_dual else 0
        print(f"{name:<20} MISS={dual_miss:<9} {wall_dual:8.1f}ms | MISS={single_miss:<9} "
              f"{wall_single:8.1f}ms {save:8.1f}%")
        if etag_l != etag_s:
            print(f"{'':<20} └─ 两条请求 ETag 不同 ⇒ 确为两条独立缓存条目（spec_tag 已进入 cache_key）")

    # ── 实验 B：A→B→C→A 来回切换（热）──────────────────────────────────
    print("\n【实验 B】A→B→C→A 来回切换（⚠️ 三份必须是**内容不同**的文档，")
    print("        否则 content-only docId 相同 ⇒ 实为同一份，测不出真实切换）")
    print(f"{'文档类型':<20} {'现状:每次切换渲染次数':>26} {'P1-A:每次切换渲染次数':>26}")
    print("-" * 92)

    def blob_of(kind, i):
        if kind == 'vector':
            return make_vector_pdf(100 + i)
        if kind == 'jpeg_small':
            return make_jpeg(1240, 1754, seed=500 + i)
        return make_jpeg(1240, 1754, seed=900 + i)

    # 大图（3000x4000）冷渲染 ~6.5s × 多次切换太慢，实验 B 只取前两类
    b_cases = [("矢量 PDF A4", 'vector'), ("扫描件 1240x1754", 'jpeg_small')]
    for name, kind in b_cases:
        # ── 现状：每次切换发两条请求（legacy + spec）──
        reg, cache, eng, cnt = build_env()
        ids = [reg.open(blob_of(kind, i), f"{kind}_{i}.bin").doc_id for i in range(3)]
        seq_dual = []
        for idx in [0, 1, 2, 0]:
            before = cnt.miss
            _, _, _ = render_ms(eng, ids[idx], spec=None)
            _, _, _ = render_ms(eng, ids[idx], spec=SPEC)
            seq_dual.append(cnt.miss - before)   # 本次切换的**增量**渲染次数

        # ── P1-A：每次切换只发一条请求 ──
        reg2, cache2, eng2, cnt2 = build_env()
        ids2 = [reg2.open(blob_of(kind, i), f"{kind}_{i}.bin").doc_id for i in range(3)]
        seq_single = []
        for idx in [0, 1, 2, 0]:
            before2 = cnt2.miss
            _, _, _ = render_ms(eng2, ids2[idx], spec=None)
            seq_single.append(cnt2.miss - before2)

        print(f"{name:<20} A,B,C,A = {str(seq_dual):<14}      A,B,C,A = {str(seq_single):<14}")
        print(f"{'':<20} └─ 0 = 命中缓存未重渲染；第 4 项（切回 A）是否为 0 是关键")

    # ── 实验 C：R2 预取竞争（前台延迟单变量）───────────────────────────
    print("\n【实验 C】后台预取并发对前台延迟的影响（矢量 PDF）")
    print("  ⚠️ 后台线程必须渲染**本 env 已注册**的文档，否则 doc 未注册直接抛异常、")
    print("     实际零负载 —— 这是上一版得出「+0%」的原因（缺陷已修）。")

    fg_alone, fg_busy = [], []
    N_BG = 18          # 后台冷渲染总数（分 6 线程，每线程 3 份）
    for i in range(6):
        # ── 无后台：前台独占 ──
        reg_a, cache_a, eng_a, _ = build_env()
        d_a = reg_a.open(make_vector_pdf(4000 + i), "fg.pdf")
        ms, _, _ = render_ms(eng_a, d_a.doc_id)
        fg_alone.append(ms)

        # ── 有后台：6 线程各渲染 3 份不同文档（持续冷渲染负载）──
        reg_b, cache_b, eng_b, _ = build_env()
        d_b = reg_b.open(make_vector_pdf(4000 + i), "fg.pdf")
        bg_ids = [reg_b.open(make_vector_pdf(5000 + i * 50 + k), f"bg_{k}.pdf").doc_id
                  for k in range(N_BG)]
        chunks = [bg_ids[k::6] for k in range(6)]
        stop = threading.Event()
        done = [0]

        def bg(chunk, ev, cntref):
            for bid in chunk:
                if ev.is_set():
                    return
                try:
                    eng_b.render(doc_id=bid, preset_name="preview", page=1,
                                 accept_header="image/webp")
                    cntref[0] += 1
                except Exception:
                    return

        workers = [threading.Thread(target=bg, args=(c, stop, done), daemon=True) for c in chunks]
        for t in workers:
            t.start()
        ms, _, _ = render_ms(eng_b, d_b.doc_id)   # 前台与后台同时跑
        stop.set()
        for t in workers:
            t.join(timeout=5)
        fg_busy.append(ms)

    def med(xs):
        xs = sorted(xs)
        return xs[len(xs) // 2]

    m1, m2 = med(fg_alone), med(fg_busy)
    print(f"  无后台预取：中位 {m1:.1f} ms   min {min(fg_alone):.1f} ms   max {max(fg_alone):.1f} ms")
    print(f"  6 路后台并发：中位 {m2:.1f} ms   min {min(fg_busy):.1f} ms   max {max(fg_busy):.1f} ms")
    delta = (m2 / m1 - 1) * 100 if m1 else 0
    print(f"  ⇒ 前台延迟 {delta:+.0f}%（**仅矢量 PDF、本测试环境、本并发模型**下的实测值；")
    print(f"     不可外推到 12MP/16MP 大图 —— 大图单张 6.5s/29s，后台并发会造成完全不同的饱和形态）")

    # ── 实验 D：200+ 文件规模下缓存存活 ────────────────────────────────
    print("\n【实验 D】200+ 文件：切回最早看过的 A 时，缓存还在吗？")
    from render_engine.cache import RenderCache as _RC
    rc = _RC()
    cap = getattr(rc, 'max_entries', None) or getattr(rc, '_max_entries', None) \
        or getattr(rc, 'MAX_ENTRIES', None) or getattr(rc, 'capacity', None)
    print(f"  RenderCache 上限 = {cap}")
    reg, cache, eng, cnt = build_env()
    big = [reg.open(make_vector_pdf(i), f"big_{i}.pdf") for i in range(210)]
    big_ids = [d.doc_id for d in big]
    _, _, _ = render_ms(eng, big_ids[0])          # 访问 A（现状单管线）
    for i in range(1, 210):                        # 依次访问其余 209 份
        _, _, _ = render_ms(eng, big_ids[i])
    cnt.reset()
    ms_back, _, _ = render_ms(eng, big_ids[0])     # 切回 A
    print(f"  切回 A：MISS={cnt.miss}（0=缓存存活/命中，1=已被挤掉需重渲染）  耗时 {ms_back:.1f} ms")
    print(f"  当前 cache 条目数 = {len(cache._store)}")


if __name__ == '__main__':
    main()
