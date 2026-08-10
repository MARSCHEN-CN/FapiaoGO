# Python 侧几何回归（Gate 7 前身）：executor 纯几何层 vs 全部向量 expected（含 V-04 rot90）
# 用法: python scripts/verify_executor_geometry.py   （0 = 全过）
# 注意：本脚本只验证 apply_margin_contract 纯几何层；PDF 端到端由 Gate 2 三连验证覆盖。
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import margin_contract as mc  # noqa: E402

_REPO = os.path.abspath(os.path.join(_HERE, ".."))
_VECTORS = os.path.join(_REPO, "docs", "margin_contract_vectors.json")
doc = json.load(open(_VECTORS, encoding="utf-8"))
TOL = 0.01
allok = True
for v in doc['vectors']:
    inp, exp = v['input'], v['expected']
    m = inp['margin']
    src = inp['source']
    g = mc.apply_margin_contract(
        inp['paper']['widthPt'], inp['paper']['heightPt'],
        (m['left'], m['right'], m['top'], m['bottom']),
        {'widthPt': src['widthPt'], 'heightPt': src['heightPt']},
        content_rotation=inp['spec'].get('contentRotation', 0),
        allow_upscale=inp['spec'].get('allowUpscale', False))
    fails = []
    def chk(name, a, b):
        if abs(a - b) > TOL:
            fails.append(f'{name}: got {a:.4f} vs exp {b:.4f}')
    chk('scale', g['scale'], exp['scale'])
    chk('mediaBox.w', g['mediaBox']['widthPt'], exp['mediaBox']['widthPt'])
    chk('mediaBox.h', g['mediaBox']['heightPt'], exp['mediaBox']['heightPt'])
    chk('contentBox.x', g['contentBox']['x'], exp['contentBox']['x'])
    chk('contentBox.y', g['contentBox']['y'], exp['contentBox']['y'])
    chk('contentBox.w', g['contentBox']['widthPt'], exp['contentBox']['widthPt'])
    chk('contentBox.h', g['contentBox']['heightPt'], exp['contentBox']['heightPt'])
    chk('usableRect.x', g['usableRect']['x'], exp['usableRect']['x'])
    chk('usableRect.y', g['usableRect']['y'], exp['usableRect']['y'])
    chk('usableRect.w', g['usableRect']['widthPt'], exp['usableRect']['widthPt'])
    chk('usableRect.h', g['usableRect']['heightPt'], exp['usableRect']['heightPt'])
    print(f"{v['id']:28s} status={v['status']:14s} scale={g['scale']:.6f} "
          f"{'OK' if not fails else 'FAIL: ' + '; '.join(fails)}")
    allok = allok and not fails
print('=' * 60)
print('ALL OK' if allok else 'HAS FAILURES')
sys.exit(0 if allok else 1)
