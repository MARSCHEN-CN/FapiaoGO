"""发布产物完整性复核（通用版）。

用法：python _verify_release_assets.py <产物目录> [期望Setup的SHA256] [期望Portable的SHA256]

校验 4 项：
1. Setup.exe 与 Portable.zip 的 SHA-256（给了期望值则逐字符比对）
2. Portable.zip CRC 全量解压校验（SHA 只证传输未变，CRC 才证压缩包结构未损）
3. latest.yml 的 size == Setup.exe 实际字节数
4. latest.yml 的 sha512(base64) == Setup.exe 实测
"""
import hashlib
import base64
import zipfile
import os
import re
import sys
import json
import glob
import time

D = sys.argv[1] if len(sys.argv) > 1 else r'E:\print706\release_final_v5'
WANT_SETUP = sys.argv[2] if len(sys.argv) > 2 else None
WANT_PORT = sys.argv[3] if len(sys.argv) > 3 else None

setups = [p for p in glob.glob(os.path.join(D, '*-Setup-*.exe'))]
ports = glob.glob(os.path.join(D, '*-Portable.zip'))
if not setups or not ports:
    print('FAIL: 产物目录缺少 Setup.exe 或 Portable.zip ->', D)
    sys.exit(1)
setup, portable = setups[0], ports[0]

t0 = time.time()
r = {'dir': D,
     'setup': os.path.basename(setup),
     'portable': os.path.basename(portable),
     'setup_size': os.path.getsize(setup),
     'portable_size': os.path.getsize(portable)}


def h_of(p, algo):
    h = hashlib.new(algo)
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return h


r['setup_sha256'] = h_of(setup, 'sha256').hexdigest()
r['setup_sha512_b64'] = base64.b64encode(h_of(setup, 'sha512').digest()).decode()
r['portable_sha256'] = h_of(portable, 'sha256').hexdigest()

with zipfile.ZipFile(portable) as z:
    r['zip_entries'] = len(z.infolist())
    bad = z.testzip()
r['zip_crc_bad'] = bad
r['zip_crc_ok'] = bad is None

yml_path = os.path.join(D, 'latest.yml')
if os.path.exists(yml_path):
    yml = open(yml_path, encoding='utf-8').read()
    r['yml_version'] = re.search(r'version:\s*(\S+)', yml).group(1)
    r['yml_size'] = int(re.search(r'size:\s*(\d+)', yml).group(1))
    r['yml_sha512'] = re.search(r'sha512:\s*(\S+)', yml).group(1)
    r['MATCH_yml_size'] = (r['yml_size'] == r['setup_size'])
    r['MATCH_yml_sha512'] = (r['yml_sha512'] == r['setup_sha512_b64'])
else:
    r['MATCH_yml_size'] = None
    r['MATCH_yml_sha512'] = None

if WANT_SETUP:
    r['MATCH_setup_sha256'] = (r['setup_sha256'] == WANT_SETUP)
if WANT_PORT:
    r['MATCH_portable_sha256'] = (r['portable_sha256'] == WANT_PORT)

r['elapsed_sec'] = round(time.time() - t0, 2)

print('=== 产物完整性复核 ===')
for k, v in r.items():
    print(f'{k:24} {v}')

ok = (r['zip_crc_ok']
      and (WANT_SETUP is None or r['MATCH_setup_sha256'])
      and (WANT_PORT is None or r['MATCH_portable_sha256'])
      and (r['MATCH_yml_size'] in (None, True))
      and (r['MATCH_yml_sha512'] in (None, True)))
print()
print('RESULT:', 'PASS' if ok else 'FAIL')

out = os.path.join(D, '_asset_verify.json')
with open(out, 'w', encoding='utf-8') as f:
    json.dump(r, f, indent=2, ensure_ascii=False)
print('saved:', out)
sys.exit(0 if ok else 1)
