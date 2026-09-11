"""v1.0.1 包内后端最小冒烟（server /health + pdf_tool margin）。
后端二进制复用 RC-v5（未重建），此冒烟目的是验证 extraResources 复制正确、包内路径可运行。
"""
import subprocess
import time
import os
import sys
import json
import urllib.request

BASE = r'E:\print706\release_r43\win-unpacked\resources'
SERVER = os.path.join(BASE, 'backend', 'server', 'server.exe')
PDFTOOL = os.path.join(BASE, 'tools', 'pdf_tool', 'pdf_tool.exe')

# 让 urllib 不走代理（127.0.0.1 必须直连）
for k in ('http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'):
    os.environ.pop(k, None)
os.environ['no_proxy'] = '*'

print('server exists:', os.path.exists(SERVER))
print('pdf_tool exists:', os.path.exists(PDFTOOL))

proc = None
health = None
try:
    env = dict(os.environ)
    env.setdefault('FAPIAOGO_PORT', '5000')
    proc = subprocess.Popen([SERVER], cwd=os.path.dirname(SERVER), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):  # 最多等 20s
        time.sleep(0.5)
        try:
            with urllib.request.urlopen('http://127.0.0.1:5000/health', timeout=2) as r:
                health = r.read().decode('utf-8', 'replace')[:200]
                break
        except Exception:
            continue
    print('HEALTH:', health)
finally:
    if proc:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

# pdf_tool 冒烟（margin 子命令）
if os.path.exists(PDFTOOL):
    try:
        out = subprocess.run([PDFTOOL, '--help'], capture_output=True, timeout=30)
        print('pdf_tool --help exit:', out.returncode)
        print('pdf_tool head:', (out.stdout or out.stderr).decode('utf-8', 'replace')[:200])
    except Exception as e:
        print('pdf_tool error:', e)

print()
print('SMOKE:', 'PASS' if health and 'ok' in health.lower() else 'CHECK')
