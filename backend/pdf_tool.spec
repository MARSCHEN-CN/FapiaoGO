# -*- mode: python ; coding: utf-8 -*-
# R2-3-B: 独立 pdf_tool.exe（onefile）— 双 CLI 分发器入口
#
# 闭包（datas，原样携带，零修改执行）：
#   pyscripts/pdf_tool.py          → PNG→PDF（img2pdf + pikepdf，旧 mediabox+Rotate 边距语义，冻结不变）
#   scripts/add-pdf-margins.py     → margin 长旗标 CLI 兼容壳（几何转交 margin_contract）
#   scripts/margin_contract.py     → 冻结几何 executor（契约 §7.1 唯一几何来源）
#   scripts/shared/flatten_annotations.py → margin_contract 的监制章展平依赖（shared 包）
#
# hiddenimports：img2pdf（单模块）+ pikepdf + PIL 全子模块收集（含 C 扩展/libs）。
#
# 产物：backend/dist/pdf_tool.exe（onefile；console=True，由 main.js windowsHide 隐藏窗口）

from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH).resolve().parent          # backend/ 的父目录 = 仓库根
PYSCRIPTS = ROOT / 'pyscripts'
SCRIPTS = ROOT / 'scripts'

hiddenimports = (
    ['img2pdf', 'pikepdf', 'PIL']
    + collect_submodules('pikepdf')
    + collect_submodules('PIL')
)

a = Analysis(
    [str(PYSCRIPTS / 'pdf_tool_entry.py')],
    pathex=[str(ROOT), str(PYSCRIPTS), str(SCRIPTS)],
    binaries=[],
    datas=[
        (str(PYSCRIPTS / 'pdf_tool.py'), '.'),
        (str(SCRIPTS / 'add-pdf-margins.py'), '.'),
        (str(SCRIPTS / 'margin_contract.py'), '.'),
        (str(SCRIPTS / 'shared' / '__init__.py'), 'shared'),
        (str(SCRIPTS / 'shared' / 'flatten_annotations.py'), 'shared'),
    ],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='pdf_tool',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
