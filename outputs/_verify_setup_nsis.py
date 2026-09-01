"""Setup.exe (NSIS) 结构完整性实证。

定位策略（两级）：
1. 从 PE section table 计算所有 section 的 raw data 结束点 → NSIS firstheader 就落在这里
2. 兜底：遍历全文件中所有 siginfo=0xDEADBEEF 候选，找满足
   `0 <= file_size - (fh_off + length_of_header + length_of_all_following_data) <= 4096`
   的自洽解（真正 header 必然自洽，随机碰撞不会）

验证点：
- PE 头有效（MZ / PE）
- NSIS first header 可定位且长度字段自洽 → 安装包未被截断/拼接损坏
- IMAGE_DIRECTORY_ENTRY_SECURITY 为空 → 未签名（R4-C 已知状态）
"""
import struct
import os
import sys
import json

P = r'E:\print706\release_final_v5\FapiaoGO-Setup-1.0.0.exe'
size = os.path.getsize(P)
MAGIC = struct.pack('<I', 0xDEADBEEF)

with open(P, 'rb') as f:
    head = f.read(4096)

r = {'file_size': size}
r['pe_mz'] = head[:2] == b'MZ'
pe = struct.unpack('<I', head[0x3c:0x40])[0]
r['pe_sig'] = head[pe:pe + 4] == b'PE\x00\x00'
nsec = struct.unpack('<H', head[pe + 6:pe + 8])[0]
soh = struct.unpack('<H', head[pe + 20:pe + 22])[0]
opt = pe + 24
sect_off = opt + soh
file_align = struct.unpack('<I', head[opt + 36:opt + 40])[0]
r['num_sections'] = nsec
r['file_alignment'] = file_align

# --- section table → raw data 结束点 ---
sections = []
end = 0
for i in range(nsec):
    e = sect_off + i * 40
    name = head[e:e + 8].rstrip(b'\x00').decode('ascii', 'replace')
    vsize, vaddr, rawsize, rawptr = struct.unpack('<IIII', head[e + 8:e + 24])
    sections.append((name, rawptr, rawsize))
    end = max(end, rawptr + rawsize)
r['sections'] = sections
r['raw_data_end'] = end

# 对齐到 FileAlignment
aligned = (end + file_align - 1) // file_align * file_align
r['nsis_header_candidate_aligned'] = aligned

# --- 在候选偏移附近找 siginfo，并做自洽校验 ---
def probe(buf, base, tag):
    """NSIS firstheader 布局（已实测确认）：
         +0  flags (int)
         +4  siginfo = 0xDEADBEEF
         +8  nsinstaller[3] = ASCII 'NullsoftInst' (12 bytes)
         +20 length_of_header
         +24 length_of_all_following_data  <- 含 header 本身，从 firstheader 起算到文件尾
       故：file_size == fh_offset + length_of_all_following_data
    """
    off = buf.find(MAGIC)
    if off < 0:
        return None
    fh = off - 4
    if fh < 0:
        return None
    nsinst = buf[off + 4:off + 16]
    loh, lofd = struct.unpack('<ii', buf[off + 16:off + 24])
    total = base + fh + lofd  # lofd 已含 header，不再加 loh
    delta = size - total
    return {'tag': tag, 'fh_offset': base + fh, 'loh': loh, 'lofd': lofd,
            'nsinstaller_ascii': nsinst.decode('ascii', 'replace'),
            'nsinstaller_ok': nsinst == b'NullsoftInst',
            'computed_total': total, 'delta': delta,
            'self_consistent': delta == 0}

found = None

# 候选 1：section 结束点（对齐前后各读 512 字节窗口）
for cand in sorted({end, aligned}):
    with open(P, 'rb') as f:
        f.seek(cand)
        buf = f.read(512)
    got = probe(buf, cand, f'cand@{cand}')
    if got and got['self_consistent']:
        found = got
        break

# 候选 2：全文件扫描自洽解
if not found:
    with open(P, 'rb') as f:
        data = f.read()
    pos = 0
    hits = []
    while True:
        off = data.find(MAGIC, pos)
        if off < 0:
            break
        fh = off - 4
        if fh >= 0:
            nsinst = data[off + 4:off + 16]
            loh, lofd = struct.unpack('<ii', data[off + 16:off + 24])
            delta = size - (fh + lofd)
            if delta == 0 and nsinst == b'NullsoftInst':
                hits.append({'tag': 'scan', 'fh_offset': fh, 'loh': loh,
                             'lofd': lofd, 'nsinstaller_ascii': nsinst.decode(),
                             'nsinstaller_ok': True,
                             'computed_total': fh + lofd,
                             'delta': delta, 'self_consistent': True})
        pos = off + 1
    r['scan_hits'] = len(hits)
    if hits:
        found = hits[0]

# --- 签名状态 ---
cert = struct.unpack('<II', head[opt + 128:opt + 136])
r['signed'] = cert[1] > 0
r['signed_note'] = 'SIGNED' if r['signed'] else 'NOT SIGNED (R4-C 已知状态)'
mach = struct.unpack('<H', head[pe + 4:pe + 6])[0]
r['machine'] = hex(mach)
r['machine_note'] = 'i386 (NSIS stub 固定 32 位，承载 x64 内容 —— 正常)' if mach == 0x14c else 'UNEXPECTED'

if found:
    r.update(found)
r['NSIS_HEADER_OK'] = found is not None

print('=== Setup.exe (NSIS) 结构完整性 ===')
for k, v in r.items():
    print(f'{k:32} {v}')

ok = r['pe_mz'] and r['pe_sig'] and r['NSIS_HEADER_OK']
print()
print('RESULT:', 'PASS' if ok else 'FAIL')

with open(r'E:\print706\outputs\_v5_setup_verify.json', 'w', encoding='utf-8') as f:
    json.dump(r, f, indent=2, ensure_ascii=False, default=str)
sys.exit(0 if ok else 1)
