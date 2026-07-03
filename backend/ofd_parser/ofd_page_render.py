"""
OFD 页面渲染 - True CTM 版本 (Review Fix 4)

公共 API 入口，所有内部实现已拆分至以下模块:
  - ofd_constants      常量、正则、工具函数
  - ofd_ctm            2D 仿射变换矩阵 (CTM) 与包围盒计算
  - ofd_render_context 坐标管线 + CTM 栈
  - ofd_glyph_engine   Glyph Engine v2 (注册表 + 基元 + 调度器)
  - ofd_renderer       _OFDRenderer 主渲染器
"""
import io
import logging
import zipfile
import xml.etree.ElementTree as ET

from .xml_utils import _strip_ofd_ns
from .ofd_renderer import _OFDRenderer

logger = logging.getLogger(__name__)


def render_ofd_page_preview(raw_bytes, dpi=300):
    """OFD 渲染：True CTM 管线 + 字体映射 + Unicode 回退。"""
    try:
        with zipfile.ZipFile(io.BytesIO(raw_bytes), 'r') as zf:
            all_names = zf.namelist()
            content_path = None
            for name in all_names:
                if name.lower().endswith('content.xml'):
                    content_path = name
                    break
            if not content_path:
                return None
            content_raw = zf.read(content_path).decode('utf-8', errors='ignore')
            content_clean = _strip_ofd_ns(content_raw)
            try:
                root = ET.fromstring(content_clean)
            except ET.ParseError:
                logger.error("Failed to parse OFD content XML", exc_info=True)
                return None
            renderer = _OFDRenderer(zf, all_names, dpi)
            renderer.setup(content_clean)
            return renderer.render(root)
    except Exception as e:
        logger.error("OFD页面渲染异常: %s", e, exc_info=True)
        return None
