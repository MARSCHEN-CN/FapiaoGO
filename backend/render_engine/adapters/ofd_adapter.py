"""
OFD Adapter — render_engine 合同桥，专用于 OFD 文档。

这是 OFD 的「新消费链」（13-A.3.3）：
    OFDAdapter → ofd_parser.render_ofd_page() → WebP → DocumentViewer

设计纪律（与用户冻结决议一致）：
- 不复用旧 parse_ofd() 链（OCR / 导入缩略 / 字段识别仍走旧链）。
- 不进入 engine 核心渲染（PDF/Image 由 engine 直渲）。
- 不认识任何「格式」——它只是一个拿到 backend 页面合同的对象，
  前端桥 ensureDocumentFromMetadata 只消费 metadata()，DocumentViewer
  只消费 /preview 返回的 WebP。

公开合同：
    metadata() -> {"pageCount": int, "pages": [{index,width,height,sourceRotation}]}
    render(page_index) -> WebP bytes | None
"""
import logging
from typing import Dict, List, Optional

from ofd_parser.ofd_page_render import (
    list_ofd_page_paths,
    ofd_page_dimensions,
    render_ofd_page,
)

logger = logging.getLogger(__name__)

DEFAULT_OFD_DPI = 300


class OFDAdapter:
    """单个 OFD 文档的后端合同适配器。"""

    def __init__(self, raw_bytes: bytes, dpi: int = DEFAULT_OFD_DPI):
        self._raw_bytes = raw_bytes
        self.dpi = dpi
        self._page_paths: Optional[List[str]] = None
        self._dims: Optional[List[Dict]] = None

    # ── 懒加载缓存 ──
    def _ensure_paths(self) -> List[str]:
        if self._page_paths is None:
            self._page_paths = list_ofd_page_paths(self._raw_bytes)
        return self._page_paths

    def _ensure_dims(self) -> List[Dict]:
        if self._dims is None:
            self._dims = ofd_page_dimensions(self._raw_bytes, self.dpi)
        return self._dims

    # ── 公开合同 ──
    def page_count(self) -> int:
        return len(self._ensure_paths())

    def metadata(self) -> Dict:
        """返回页面合同，供前端 ensureDocumentFromMetadata 消费。"""
        pages = self._ensure_dims()
        return {
            "pageCount": len(pages),
            "pages": pages,
        }

    def render(self, page_index: int, dpi: Optional[int] = None) -> Optional[bytes]:
        """渲染指定页（0-based）为 WebP bytes；dpi 覆盖构造时 dpi。"""
        return render_ofd_page(self._raw_bytes, page_index, dpi=dpi or self.dpi)
