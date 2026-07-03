#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
查看发票的前40行文本
"""
import sys
import os

backend_dir = os.path.join(os.path.dirname(__file__), 'backend')
sys.path.insert(0, backend_dir)
os.chdir(backend_dir)

from werkzeug.datastructures import FileStorage
from pathlib import Path
from cache import get_or_parse

pdf_file = r'E:\print608\tests\test_pdfs\25447000001115703415.pdf'

with open(pdf_file, 'rb') as f:
    file_storage = FileStorage(
        stream=f,
        filename=Path(pdf_file).name,
        content_type='application/pdf'
    )
    doc = get_or_parse(file_storage, auto_orient=True)

print(f"总行数: {len(doc.lines)}\n")
print("前40行内容:")
print("=" * 80)
for i, line in enumerate(doc.lines[:40]):
    print(f"[{i:2d}] {line}")
print("=" * 80)
