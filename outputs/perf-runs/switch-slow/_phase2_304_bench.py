"""Phase 2 追问：真机数据里「第二次访问同一文档仍 ~313ms」到底花在哪。

背景（用户真机 27 次切换）：
  #1  4fd9e93a3d 首次 751.8ms
  #14 4fd9e93a3d 二次 313.3ms
  #27 4fd9e93a3d 三次   6.3ms
  313 这一档重复出现三次（313.3 / 313.7 / 313.9），高度一致 ⇒ 疑似固定开销而非抖动。

本脚本分离三层：
  A. 后端 engine.render() 命中 RenderCache 的耗时（已知 ~0.02ms，作为基线复核）
  B. HTTP 层：带 If-None-Match 的 304 往返耗时
  C. HTTP 层：不带 INM 的 200 往返耗时（缓存命中但仍回 body）
  D. 并发：legacy 与 spec 变体同时请求时的前台耗时（验证 R3 竞争假设）

只测量，不改任何生产代码。
"""
import io
import os
import sys
import time
import logging
import threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'backend'))
logging.disable(logging.CRITICAL)

# 沙箱有 HTTP 代理会拦截 127.0.0.1 —— 强制直连（与 Phase 1 脚本同款处理）
os.environ['no_proxy'] = '*'
os.environ['NO_PROXY'] = '*'
for k in ('http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'):
    os.environ.pop(k, None)

import fitz
import urllib.request
import urllib.error
from flask import Flask

from render_engine import registry, engine
from render_engine.api import render_bp


def make_vector_invoice(seed=0):
    """模拟真机样本：矢量 PDF 发票，页面 595x397pt（A4 宽、约 140mm 高）。

    preview preset dpi=150 ⇒ 输出 = 595*150/72 ≈ 1240 x 397*150/72 ≈ 827
    与真机 natural '1241x827' 完全吻合 ⇒ 证实真机样本是矢量 PDF，不是拍照/扫描件。
    """
    doc = fitz.open()
    page = doc.new_page(width=595, height=397)
    page.insert_text((40, 60), f'INVOICE {seed}', fontsize=14)
    page.insert_text((40, 100), '增值税电子普通发票', fontsize=11)
    for i in range(6):
        page.insert_text((40, 140 + i * 22), f'item {i}  {100 + i * 7}.00', fontsize=9)
    page.draw_rect(fitz.Rect(30, 30, 565, 367), width=0.7)
    data = doc.tobytes()
    doc.close()
    return data


def main():
    print('=' * 92)
    print('Phase 2 追问：313ms 归属（只读测量）')
    print('=' * 92)

    eng = engine  # 与 api.py 共用同一个全局引擎实例（保证 HTTP 端与直调端同一份缓存）

    blob = make_vector_invoice(1)
    doc = registry.open(blob, 'invoice.pdf')
    doc_id = doc.doc_id
    print(f'doc_id={doc_id[:16]}...')

    # 先冷渲染一次，确认输出尺寸是否与真机 natural 吻合
    t0 = time.perf_counter()
    data, fmt, etag = eng.render(doc_id=doc_id, preset_name='preview', page=1,
                                 accept_header='image/webp')
    cold_ms = (time.perf_counter() - t0) * 1000
    # 用 PIL 读回实际输出尺寸，核对是否与真机 natural '1241x827' 吻合
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(data))
        size = f'{im.width}x{im.height}'
    except Exception:
        size = '?'
    print(f'\n[A] 冷渲染 {cold_ms:.1f} ms  fmt={fmt} bytes={len(data)} 输出尺寸={size}')
    print(f'    （真机 natural 为 1241x827；吻合 ⇒ 真机样本是矢量 PDF 而非拍照/扫描件）')

    # A: 缓存命中
    hits = []
    for _ in range(5):
        t = time.perf_counter()
        eng.render(doc_id=doc_id, preset_name='preview', page=1, accept_header='image/webp')
        hits.append((time.perf_counter() - t) * 1000)
    print(f'[A] RenderCache 命中 中位 {sorted(hits)[len(hits)//2]:.3f} ms  '
          f'（若这里远小于 313ms ⇒ 313ms 不在后端渲染）')

    # ---- HTTP 层 ----
    app = Flask(__name__)
    app.register_blueprint(render_bp)
    port = 5099
    threading.Thread(
        target=lambda: app.run(host='127.0.0.1', port=port, debug=False,
                               threaded=True, use_reloader=False),
        daemon=True,
    ).start()
    time.sleep(1.5)

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    base = f'http://127.0.0.1:{port}'
    url = f'{base}/preview/{doc_id}?page=1&schema=2'

    def get(u, inm=None, timeout=30):
        h = {}
        if inm:
            h['If-None-Match'] = f'"{inm}"'
        req = urllib.request.Request(u, headers=h)
        t = time.perf_counter()
        try:
            with opener.open(req, timeout=timeout) as r:
                body = r.read()
                return (time.perf_counter() - t) * 1000, r.status, len(body)
        except urllib.error.HTTPError as e:
            e.read()
            return (time.perf_counter() - t) * 1000, e.code, 0

    print('\n[B] HTTP 200（无 If-None-Match，后端缓存已命中，仍回 body）')
    b = []
    for _ in range(5):
        ms, st, n = get(url)
        b.append(ms)
    print(f'    中位 {sorted(b)[len(b)//2]:.1f} ms   min {min(b):.1f} ms')

    print('\n[C] HTTP 304（带 If-None-Match —— 浏览器 must-revalidate 的实际路径）')
    c = []
    for _ in range(5):
        ms, st, n = get(url, inm=etag)
        c.append(ms)
    print(f'    中位 {sorted(c)[len(c)//2]:.1f} ms   min {min(c):.1f} ms   status 应为 304')

    # D: 并发 legacy + spec —— 验证 R3 是否把前台拖到 313ms 档
    print('\n[D] 并发：前台 legacy 与后台 spec 变体同时请求（模拟 R3 双管线）')
    spec_url = url + '&spec=' + urllib.parse.quote(
        '{"version":"1","page":1,"dpi":150,'
        '"placement":{"offsetX":0,"offsetY":0,"scale":1},'
        '"paper":{"widthMm":210,"heightMm":140,"landscape":false},'
        '"rotation":{"content":0,"layout":0}}')
    fg_alone = []
    fg_busy = []
    for _ in range(5):
        ms, _, _ = get(url, inm=etag)
        fg_alone.append(ms)
    for _ in range(5):
        th = threading.Thread(target=lambda: get(spec_url), daemon=True)
        th.start()
        ms, _, _ = get(url, inm=etag)
        th.join(timeout=30)
        fg_busy.append(ms)

    def med(xs):
        return sorted(xs)[len(xs) // 2]

    print(f'    前台单独  中位 {med(fg_alone):.1f} ms')
    print(f'    前台+spec 中位 {med(fg_busy):.1f} ms   '
          f'⇒ +{(med(fg_busy)/med(fg_alone)-1)*100:.0f}%')

    print('\n' + '=' * 92)
    print('判读：若 [C] 远小于 313ms 且 [D] 接近 313ms ⇒ 313ms 主要来自 R3 双管线竞争；')
    print('      若 [C] 本身就接近 313ms ⇒ 责任在 HTTP/后端响应路径（与 R3 无关）。')
    print('=' * 92)


if __name__ == '__main__':
    import urllib.parse  # noqa: E402  (供 spec_url 构造使用)
    main()
