# -*- coding: utf-8 -*-
"""
_switch_bench_http.py — 端到端 HTTP 基准：复现前端「切换发票」时发出的真实请求序列。

测量（真实 Flask + 真实 RenderEngine，仅起本地临时 server）：
  1. GET /metadata/{docId}                       （usePreview.loadFilePreview 每次都发，无缓存）
  2. GET /preview/{docId}?page=1&schema=2        （DocumentViewer 展示区，首次=冷）
  3. 同上第二次（带 If-None-Match）→ 304 / 200
  4. GET /preview/{docId}?page=1&schema=2&spec=..（遗留 usePreview 管线，另一条 URL，冷）
  5. A→B→C→A 来回切换（模拟用户行为，含预取 6 张）
"""
import io
import os
import sys
import time
import threading
import statistics
import logging

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend'))

import fitz  # noqa
from flask import Flask  # noqa

logging.disable(logging.CRITICAL)

from render_engine import registry, render_cache, render_queue, engine  # noqa
from render_engine.api import render_bp  # noqa


def make_pdf(i, pages=1):
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


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 220
    print(f"准备 {n} 份测试发票 PDF ...")
    blobs = [make_pdf(i) for i in range(n)]
    doc_ids = [registry.open(b, f"invoice_{i:05d}.pdf").doc_id for i, b in enumerate(blobs)]

    app = Flask(__name__)
    app.register_blueprint(render_bp)
    port = 5099
    threading.Thread(target=lambda: app.run(host='127.0.0.1', port=port,
                                            debug=False, threaded=True, use_reloader=False),
                     daemon=True).start()
    time.sleep(1.5)
    base = f"http://127.0.0.1:{port}"

    import urllib.request
    import urllib.error
    # 沙箱/公司环境有 HTTP 代理，会拦截 127.0.0.1 请求 → 强制直连（显式 opener，不用 install_opener）
    _opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def get(path, headers=None, timeout=30):
        req = urllib.request.Request(base + path, headers=headers or {})
        t = time.perf_counter()
        try:
            with _opener.open(req, timeout=timeout) as r:
                body = r.read()
                return r.status, r.headers, body, (time.perf_counter() - t) * 1000
        except urllib.error.HTTPError as e:
            body = e.read()
            return e.code, e.headers, body, (time.perf_counter() - t) * 1000

    def p(label, ms, extra=""):
        print(f"   {label:<46} {ms:8.1f} ms  {extra}")

    print("\n=== 0. 连通性自检 ===")
    st, h, b, ms = get(f"/metadata/{doc_ids[0]}")
    print(f"   status={st}  body={b[:160]!r}")

    print("\n=== 1. /metadata/{docId}（每次切换都发，前端零缓存）===")
    xs = []
    for i in range(10):
        st, h, b, ms = get(f"/metadata/{doc_ids[i]}")
        xs.append(ms)
    p("metadata 首 10 次 中位", statistics.median(xs))
    xs = []
    for i in range(10):
        st, h, b, ms = get(f"/metadata/{doc_ids[i]}")
        xs.append(ms)
    p("metadata 重放 中位（后端无缓存）", statistics.median(xs))

    print("\n=== 2. /preview 冷渲染（展示区 DocumentViewer 的 URL）===")
    cold = []
    for i in range(10):
        st, h, b, ms = get(f"/preview/{doc_ids[i]}?page=1&schema=2")
        cold.append(ms)
        if i == 0:
            etag0 = h.get('ETag', '')
            print(f"      产物 {len(b)/1024:.1f} KB  Cache-Control={h.get('Cache-Control')}")
    p("冷渲染 中位", statistics.median(cold))
    p("冷渲染 max", max(cold))

    print("\n=== 3. /preview 重复请求（带 If-None-Match → 304）===")
    warm = []
    for i in range(10):
        st, h, b, ms = get(f"/preview/{doc_ids[i]}?page=1&schema=2",
                           headers={'If-None-Match': f'"{etag0}"'})
        warm.append(ms)
        if i == 0:
            print(f"      第 1 次 status={st}（etag 取自 doc0，其余故意不匹配）")
    p("重复请求 中位", statistics.median(warm))

    # 用正确 etag 逐个重放
    print("\n=== 3b. A→B→C→A 来回切换（各自正确 ETag，模拟真实重复切换）===")
    etags = {}
    for i in range(3):
        st, h, b, ms = get(f"/preview/{doc_ids[i]}?page=1&schema=2")
        etags[i] = h.get('ETag', '')
    seq = [0, 1, 2, 0, 1, 2, 0]
    lat = []
    for k in seq:
        st, h, b, ms = get(f"/preview/{doc_ids[k]}?page=1&schema=2",
                           headers={'If-None-Match': etags.get(k, '')})
        lat.append((k, st, ms))
    for k, st, ms in lat:
        print(f"      doc{k}  status={st}  {ms:8.1f} ms")

    print("\n=== 4. 遗留 usePreview 管线的 spec URL（与展示区 URL 不同键）===")
    spec = "spec_sig=deadbeefcafe&ox=0&oy=0&sw=100&sh=100&rot=0"
    lat2 = []
    for i in range(5):
        st, h, b, ms = get(f"/preview/{doc_ids[i]}?page=1&schema=2&{spec}")
        lat2.append(ms)
        if i == 0:
            print(f"      第 1 次 status={st}（应为 400 INVALID_RENDER_SPEC 或 200）")
    p("spec 变体 中位", statistics.median(lat2))
    print(f"      render_cache 现有条目 = {render_cache.size}")

    print("\n=== 5. 预取争用：6 张后台渲染并发时的前台延迟 ===")
    render_cache.clear()
    fg = []
    for round_i in range(6):
        off = 100 + round_i * 8
        ts = []
        def bg(j):
            get(f"/preview/{doc_ids[(off + j) % n]}?page=1&schema=2")
        ths = [threading.Thread(target=bg, args=(j,)) for j in range(6)]
        for th in ths: th.start()
        st, h, b, ms = get(f"/preview/{doc_ids[off % n]}?page=1&schema=2")
        fg.append(ms)
        for th in ths: th.join()
    p("前台（有 6 张预取在跑）中位", statistics.median(fg))
    p("前台 max", max(fg))
    print(f"      对比：无争用冷渲染中位 = {statistics.median(cold):.1f} ms")

    print("\n=== 6. registry 容量与内存 ===")
    print(f"      MAX_DOCUMENTS = {registry.MAX_DOCUMENTS}   实际持有 = {len(registry._docs)}")
    held = sum(1 for d in registry._docs.values() if d.pdf is not None)
    print(f"      仍持有已打开 fitz 句柄的文档数 = {held}")
    print(f"      render_cache 条目 = {render_cache.size} / {render_cache.MAX_ENTRIES}")


if __name__ == '__main__':
    main()
