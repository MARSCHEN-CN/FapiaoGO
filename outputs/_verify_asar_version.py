"""验证 app.asar 内前端版本号确已更新（不能只信源码改了）。"""
import sys

asar = r'E:\print706\release_r43\win-unpacked\resources\app.asar'
d = open(asar, 'rb').read()
print('asar bytes:', len(d))

# config chunk 的特征串（vite 产出：var e=`1.0.1`,t={mode:`source`...）
NEW = b'var e=' + b'\x60' + b'1.0.1' + b'\x60' + b',t={mode:'
OLD = b'var e=' + b'\x60' + b'1.0.0' + b'\x60' + b',t={mode:'

off_new = d.find(NEW)
off_old = d.find(OLD)
print('NEW config(1.0.1) offset:', off_new)
print('OLD config(1.0.0) offset:', off_old)

# TopBarMenu 关于框：`版本 V` + `1.0.1`
about_new = d.find(b'\x60\x7248\x672c V\x60,`1.0.1\x60')  # `版本 V`,`1.0.1`
print('About version 1.0.1 offset:', about_new)

print('--- counts ---')
print('"1.0.1" count:', d.count(b'1.0.1'))
print('"1.0.0" count:', d.count(b'1.0.0'))

ok = off_new >= 0 and off_old < 0
print()
print('RESULT:', 'PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
