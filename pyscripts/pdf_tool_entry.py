#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pdf_tool.exe 入口（R2-3-B）— 薄分发器：双 CLI 契约零改动转发。

argv[1] 分发：
  - png-to-pdf / batch-png-to-pdf  → 原样执行 pyscripts/pdf_tool.py（stdout JSON / exit 1 契约不变）
  - 以 '-' 开头（--input ...）      → 原样执行 scripts/add-pdf-margins.py（冻结 margin_contract 语义）
  - 其他 / 缺省                     → {"success": false, "error": ...} + exit 1

冻结边界（R2-3 决策：合并 CLI ≠ 统一边距语义）：
  - 不修改 pdf_tool.py / add-pdf-margins.py / margin_contract.py / shared/flatten_annotations.py 任何一行
  - batch/png 保持「mediabox + /Rotate」旧行为（零语义变更）
  - margin 长旗标走 contain-fit（契约 §7.1 唯一几何 executor）
  - 两条历史语义差异登记为后续行为一致性课题，不在 R2-3 消灭
  - 用 runpy 以 __main__ 执行原脚本，保证 sys.argv / sys.exit / stdout 与 dev 完全一致
"""
import os
import sys
import json
import runpy


def _bundle_dir() -> str:
    """onefile 解包目录（sys._MEIPASS）；dev 运行时为脚本所在目录。"""
    if getattr(sys, 'frozen', False):
        return getattr(sys, '_MEIPASS', os.path.dirname(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _find(rel_name: str) -> str:
    """在解包目录/源树中定位脚本；dev 下 pdf_tool 在 pyscripts/、margin 脚本在 scripts/。"""
    base = _bundle_dir()
    candidates = (
        os.path.join(base, rel_name),
        os.path.normpath(os.path.join(base, '..', 'scripts', rel_name)),
        os.path.normpath(os.path.join(base, '..', '..', 'scripts', rel_name)),
        os.path.normpath(os.path.join(base, '..', 'pyscripts', rel_name)),
    )
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[0]


def main() -> None:
    argv = sys.argv[1:]
    cmd = argv[0] if argv else ''

    base = _bundle_dir()
    # add-pdf-margins.py 依赖 `from margin_contract import ...`、`from shared.flatten_annotations import ...`
    # （同解包目录兄弟模块/包）。frozen 下 _MEIPASS 已含全部 datas。
    if base not in sys.path:
        sys.path.insert(0, base)

    if cmd in ('png-to-pdf', 'batch-png-to-pdf'):
        runpy.run_path(_find('pdf_tool.py'), run_name='__main__')
        return

    if cmd.startswith('--'):
        runpy.run_path(_find('add-pdf-margins.py'), run_name='__main__')
        return

    print(json.dumps({"success": False, "error": f"Unknown command: {cmd}"}))
    sys.exit(1)


if __name__ == '__main__':
    main()
