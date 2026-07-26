"""
13-B.5 C2 门禁（backend，静态源码断言，无需 import 应用，CI 可跑）：

确认 OFD Legacy Render Producer 已删除、import 表面已停产 preview_image：
  - ofd_page_render.py 不再定义 def render_ofd_page_preview（新链 render_ofd_page 保留）。
  - _parser.py 不再调用 render_ofd_page_preview(...)。
  - ofd_parser/__init__.py 不再再导出 render_ofd_page_preview。
  - app.py import 端点不再按 OFD emit preview_image（svc_result.get('preview_image' 消失）。
  - import_batch_manager.py 不再 emit 'previewImage': result.get('preview_image')。

仅用 stdlib（pathlib + re + unittest）读取源文件做字符串/正则断言，
不 import 任何业务模块，避免拉起 flask/rapidocr 等重依赖。
"""

import re
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent  # backend/


def _read(rel):
    return (BACKEND / rel).read_text(encoding='utf-8')


class TestRenderOfdLegacyProducerRemoved(unittest.TestCase):
    def test_producer_function_removed(self):
        code = _read('ofd_parser/ofd_page_render.py')
        # 注意：assertRegex/assertNotRegex 用 re.search（无 MULTILINE），
        # 故不能用 '^' 锚行首；'def ' 前缀已足以锁定函数定义。
        self.assertNotRegex(
            code, r'def\s+render_ofd_page_preview\b',
            'render_ofd_page_preview 应已从 ofd_page_render.py 删除',
        )
        # 新消费链必须保留（Render Contract）
        self.assertRegex(
            code, r'def\s+render_ofd_page\b',
            'render_ofd_page（Render Contract 新消费链）必须保留',
        )

    def test_no_call_in_parser(self):
        code = _read('ofd_parser/_parser.py')
        # 允许注释中出现函数名，但禁止调用 render_ofd_page_preview(
        self.assertNotRegex(
            code, r'render_ofd_page_preview\s*\(',
            '_parser.py 不得再调用 render_ofd_page_preview（CTM 重渲染已删）',
        )

    def test_no_reexport_in_init(self):
        code = _read('ofd_parser/__init__.py')
        self.assertNotIn(
            'from .ofd_page_render import render_ofd_page_preview', code,
            '__init__.py 不得再导出 render_ofd_page_preview',
        )

    def test_import_surface_stopped(self):
        app = _read('app.py')
        self.assertNotIn(
            "svc_result.get('preview_image'", app,
            'app.py import 端点不得再按 OFD emit preview_image',
        )
        ibm = _read('import_batch_manager.py')
        self.assertNotIn(
            "'previewImage': result.get('preview_image')", ibm,
            'import_batch_manager 不得再 emit previewImage（import 表面停产）',
        )


if __name__ == '__main__':
    unittest.main()
