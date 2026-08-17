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
import re
import zipfile
import xml.etree.ElementTree as ET

from .xml_utils import _strip_ofd_ns
from .ofd_constants import RE_PHYSICAL_BOX, local_tag
from .ofd_renderer import _OFDRenderer

logger = logging.getLogger(__name__)


# 旧链 render_ofd_page_preview（OFD CTM 重渲染 → base64 JPEG）已于
# 13-B.5 C2 删除，被 Render Contract 取代：OFDAdapter → render_ofd_page()
# → WebP → /preview|/print。preview_image 不再由重渲染产生，仅保留为
# ParseResult 业务预览兼容字段（来自 OFD 内嵌图，见 ofd_parser/_parser.py）。


def _natural_key(name: str):
    """自然排序键：Page_0 < Page_1 < ... < Page_9 < Page_10。"""
    return [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', name)]


def _find_doc_paths(zf, all_names):
    """返回 OFD.xml 引用的有序 Document.xml 路径列表。"""
    ofd_candidates = [n for n in all_names if n.lower().endswith('ofd.xml')]
    doc_paths = []
    for ofd_path in ofd_candidates:
        ofd_dir = '/'.join(ofd_path.split('/')[:-1])
        try:
            raw = zf.read(ofd_path).decode('utf-8', errors='ignore')
            clean = _strip_ofd_ns(raw)
            root = ET.fromstring(clean)
        except Exception:
            logger.debug("解析 %s 失败", ofd_path, exc_info=True)
            continue
        for elem in root.iter():
            if local_tag(elem.tag) != 'FileLoc' or not elem.text:
                continue
            p = elem.text.strip()
            full = f"{ofd_dir}/{p}" if ofd_dir else p
            full = full.replace('\\', '/')
            if full in all_names:
                doc_paths.append(full)
            elif p in all_names:
                doc_paths.append(p)
    if doc_paths:
        return doc_paths
    # 回退：任意非 res 的 Document.xml
    return [n for n in all_names
            if n.lower().endswith('document.xml') and 'res' not in n.lower()]


def _enumerate_ofd_pages(zf, all_names):
    """返回 OFD 包内有序的页面 Content.xml 路径列表。"""
    content_paths = []
    for doc_path in _find_doc_paths(zf, all_names):
        doc_dir = '/'.join(doc_path.split('/')[:-1])
        try:
            raw = zf.read(doc_path).decode('utf-8', errors='ignore')
            clean = _strip_ofd_ns(raw)
            root = ET.fromstring(clean)
        except Exception:
            logger.debug("解析 %s 失败", doc_path, exc_info=True)
            continue
        for page_elem in root.iter():
            if local_tag(page_elem.tag) != 'Page':
                continue
            base = page_elem.get('BaseLoc', '')
            if not base:
                continue
            path = f"{doc_dir}/{base}" if doc_dir else base
            path = path.replace('\\', '/')
            if path in all_names and path not in content_paths:
                content_paths.append(path)
    if content_paths:
        return content_paths
    # 回退：扫描所有 *content.xml，自然排序
    candidates = [n for n in all_names if n.lower().endswith('content.xml')]
    candidates.sort(key=_natural_key)
    return candidates


def list_ofd_page_paths(raw_bytes):
    """公开：有序页面 Content.xml 路径列表（非 OFD 返回空列表）。"""
    try:
        with zipfile.ZipFile(io.BytesIO(raw_bytes), 'r') as zf:
            return _enumerate_ofd_pages(zf, zf.namelist())
    except Exception:
        logger.debug("list_ofd_page_paths: 非法 zip", exc_info=True)
        return []


def _page_physical_box(content_clean):
    """从 PhysicalBox 取 (w, h)；缺失返回 (0.0, 0.0)。"""
    m = RE_PHYSICAL_BOX.search(content_clean)
    if not m:
        return 0.0, 0.0
    try:
        return float(m.group(3)), float(m.group(4))
    except ValueError:
        return 0.0, 0.0


def _page_pixel_dims(page_w, page_h, dpi):
    """复刻 _OFDRenderer._init_dimensions，保证 metadata 与渲染像素一致。"""
    unit_to_mm = 0.01 if page_w > 500 else 1.0
    scale = dpi / 25.4
    w_mm = page_w * unit_to_mm
    h_mm = page_h * unit_to_mm
    img_w = max(400, round(w_mm * scale))
    img_h = max(560, round(h_mm * scale))
    return img_w, img_h


def _page_source_rotation(content_clean):
    """页面级旋转（度，0/90/180/270），默认 0。"""
    m = re.search(r'Rotate\s*=\s*["\']?\s*(\d+)', content_clean)
    if not m:
        return 0
    try:
        return int(m.group(1)) % 360
    except ValueError:
        return 0


def ofd_page_dimensions(raw_bytes, dpi=300):
    """公开：每页元数据列表 [{index,width,height,sourceRotation}]。"""
    try:
        with zipfile.ZipFile(io.BytesIO(raw_bytes), 'r') as zf:
            all_names = zf.namelist()
            paths = _enumerate_ofd_pages(zf, all_names)
            contents = []
            for p in paths:
                try:
                    contents.append(
                        _strip_ofd_ns(zf.read(p).decode('utf-8', errors='ignore')))
                except Exception:
                    contents.append('')
            # P1-A 同步：Document.xml PageArea 作物理尺寸权威回退
            # （与 _OFDRenderer._resolve_doc_page_size 一致：Content.xml Area
            #  为生成器私有坐标（>500 触发 0.01 单位启发式）时回退 Document.xml）。
            doc_page_size = None
            for name in all_names:
                nl = name.lower()
                if ('document.xml' in nl
                        and 'res' not in nl
                        and 'annot' not in nl):
                    try:
                        doc_raw = zf.read(name).decode('utf-8', errors='ignore')
                        m = RE_PHYSICAL_BOX.search(doc_raw)
                        if m:
                            doc_page_size = (float(m.group(3)), float(m.group(4)))
                            break
                    except Exception:
                        continue
    except Exception:
        return []
    result = []
    for idx, content_clean in enumerate(contents):
        w, h = _page_physical_box(content_clean)
        if w > 500 and doc_page_size:
            w, h = doc_page_size
        pw, ph = _page_pixel_dims(w, h, dpi)
        result.append({
            'index': idx,
            'width': pw,
            'height': ph,
            'sourceRotation': _page_source_rotation(content_clean),
        })
    return result


def render_ofd_page(raw_bytes, page_index, dpi=300):
    """渲染指定 OFD 页为 WebP bytes（Render Contract 新消费链）。

    无法渲染时返回 None。
    """
    paths = list_ofd_page_paths(raw_bytes)
    if not paths or page_index < 0 or page_index >= len(paths):
        logger.debug("render_ofd_page: 非法 page_index=%s (共 %d 页)",
                     page_index, len(paths))
        return None
    try:
        with zipfile.ZipFile(io.BytesIO(raw_bytes), 'r') as zf:
            all_names = zf.namelist()
            content_raw = zf.read(paths[page_index]).decode('utf-8', errors='ignore')
            content_clean = _strip_ofd_ns(content_raw)
            try:
                root = ET.fromstring(content_clean)
            except ET.ParseError:
                logger.error("render_ofd_page: 第 %d 页 XML 解析失败", page_index)
                return None
            renderer = _OFDRenderer(zf, all_names, dpi)
            renderer.setup(content_clean)
            img = renderer.render(root)
            if img is None:
                logger.debug("render_ofd_page: 第 %d 页未渲染出任何内容", page_index)
                return None
            buf = io.BytesIO()
            img.save(buf, format='WEBP', quality=90, method=4)
            return buf.getvalue()
    except Exception as e:
        logger.error("render_ofd_page: 第 %d 页异常: %s", page_index, e, exc_info=True)
        return None
