"""
OFD 页面渲染 — _OFDRenderer 主渲染器（True CTM 管线架构）

包含: 字体加载、文本/路径/图片对象渲染、注释层印章收集等。
"""
import io
import os
import logging
import zipfile
import xml.etree.ElementTree as ET

from PIL import Image as PILImage, ImageDraw, ImageFont

from .ofd_constants import (
    PROJECT_FONT_DIR, LANCZOS, RE_PHYSICAL_BOX, RE_DELTA_GLYPHS,
    MISSING, CLEAN_TABLE, DARK_THRESHOLD, MAX_CACHE_SIZE,
    local_tag,
)
from .ofd_ctm import CTM, IDENTITY_CTM, affine_bounding_box
from .ofd_render_context import RenderContext
from .ofd_glyph_engine import GlyphEngineV2
from .xml_utils import (
    _strip_ofd_ns, _parse_ofd_color, _parse_path_data, load_ofd_resources,
)

logger = logging.getLogger(__name__)


class _OFDRenderer:
    """OFD 页面渲染器 —— True CTM 管线架构。"""

    FONT_MAP = {
        '宋体': ['simsun.ttc', 'nsimsun.ttc', 'msyh.ttc'],
        'arial': ['arial.ttf', 'msyh.ttc'],
        '楷体': ['simkai.ttf', 'msyh.ttc', 'simsun.ttc'],
        '楷体_gb2312': ['simkai.ttf', 'msyh.ttc'],
        '仿宋': ['simfang.ttf', 'msyh.ttc'],
        '仿宋_gb2312': ['simfang.ttf', 'msyh.ttc'],
        '黑体': ['simhei.ttf', 'msyh.ttc'],
        'courier new': ['cour.ttf', 'courbd.ttf', 'msyh.ttc'],
        'times new roman': ['times.ttf', 'msyh.ttc'],
    }

    FONT_DIRS = [
        'C:/Windows/Fonts/',
        './fonts/',
        PROJECT_FONT_DIR,
        '/usr/share/fonts/truetype/',
        '/System/Library/Fonts/',
    ]

    PUA_MAP = {
        '\ue700': '\u2297', '\ue701': '\u2611', '\ue702': '\u2713',
        '\ue703': '\u2714', '\ue704': '\u2612', '\ue705': '\u00d7',
        '\ue771': '\u2297', '\ue101': '\u2297', '\ue201': '\u2611',
    }

    FALLBACK_FONT_NAMES = [
        'seguisym.ttf', 'segoeui.ttf',
        'NotoSansSymbols2-Regular.ttf',
        'arial.ttf', 'times.ttf', 'cour.ttf', 'consola.ttf',
        'simsun.ttc', 'msyh.ttc',
    ]

    _SYMBOL_CHARS = frozenset({
        '\u2297', '\u2610', '\u2611', '\u2612',
        '\u2713', '\u2714', '\u00d7',
    })

    _CTM_SCALE_MIN = 0.1
    _CTM_SCALE_MAX = 10.0
    _BEZIER_SEGMENTS = 12
    _CIRCLED_TIMES_LINE_RATIO = 0.07
    _GLYPH_AFFINE_PAD = 2

    # ────────────────────── 初始化 ──────────────────────
    def __init__(self, zf, all_names, dpi):
        self.zf = zf
        self.all_names = all_names
        self.dpi = dpi
        self.scale = dpi / 25.4
        self.unit_to_mm = 1.0
        self.img_w = 0
        self.img_h = 0
        self.img = None
        self.draw = None
        self.resources = {}
        self.font_id_map = {}
        self.font_cache = {}
        self.img_cache = {}
        self._font_dir_cache = {}
        self._fb_size_cache = {}
        self._char_render_cache = {}
        self._glyph_visible_cache = {}
        self.fallback_fonts = []
        self._annot_collected = False
        self.ctx = None
        self._verified_font_chars = set()
        self._glyph_rgba_cache = {}
        self.glyph_engine = GlyphEngineV2(self)
        self._global_font_index = {}

    def setup(self, content_clean):
        page_w, page_h = 210.0, 297.0
        content_box = RE_PHYSICAL_BOX.search(content_clean)
        if content_box:
            page_w = float(content_box.group(3))
            page_h = float(content_box.group(4))
        else:
            for name in self.all_names:
                nl = name.lower()
                if ('document.xml' in nl
                        and 'res' not in nl
                        and 'annot' not in nl):
                    try:
                        doc_raw = self.zf.read(name).decode('utf-8', errors='ignore')
                        m = RE_PHYSICAL_BOX.search(doc_raw)
                        if m:
                            page_w, page_h = float(m.group(3)), float(m.group(4))
                            break
                    except Exception:
                        logger.debug("Failed to read %s for page size", name,
                                     exc_info=True)
                        continue
        self._init_dimensions(page_w, page_h)
        self.img = PILImage.new('RGB', (self.img_w, self.img_h), '#ffffff')
        self.draw = ImageDraw.Draw(self.img)
        self.glyph_engine.set_draw(self.draw)
        self.resources = load_ofd_resources(self.zf, self.all_names)
        self._load_font_resources()
        self._build_global_font_index()
        self._load_fallback_fonts()

    def _init_dimensions(self, page_w, page_h):
        self.unit_to_mm = 0.01 if page_w > 500 else 1.0
        page_w_mm = page_w * self.unit_to_mm
        page_h_mm = page_h * self.unit_to_mm
        self.img_w = max(400, round(page_w_mm * self.scale))
        self.img_h = max(560, round(page_h_mm * self.scale))

    def reset_caches(self):
        """清空所有内部缓存。"""
        self.font_cache.clear()
        self.img_cache.clear()
        self._font_dir_cache.clear()
        self._fb_size_cache.clear()
        self._char_render_cache.clear()
        self._glyph_visible_cache.clear()
        self._verified_font_chars.clear()
        self._glyph_rgba_cache.clear()
        self._global_font_index.clear()

    @staticmethod
    def _prune_cache(cache):
        if len(cache) > MAX_CACHE_SIZE:
            cache.clear()

    # ────────────────────── 资源加载 ──────────────────────
    def _load_resource_image(self, rid):
        if rid in self.img_cache:
            return self.img_cache[rid]
        file_path = self.resources.get(rid)
        if not file_path:
            self.img_cache[rid] = None
            return None
        try:
            data = self.zf.read(file_path)
            pil_img = PILImage.open(io.BytesIO(data)).convert('RGBA')
            self.img_cache[rid] = pil_img
            return pil_img
        except Exception:
            logger.debug("Failed to load resource image: %s", rid, exc_info=True)
            self.img_cache[rid] = None
            return None

    def _load_font_resources(self):
        for res_name in self.all_names:
            nl = res_name.lower()
            if not (nl.endswith('res.xml') or nl.endswith('resources.xml')):
                continue
            try:
                res_content = self.zf.read(res_name).decode('utf-8', errors='ignore')
                res_clean = _strip_ofd_ns(res_content)
                res_root = ET.fromstring(res_clean)
                for elem in res_root.iter():
                    tag = local_tag(elem.tag)
                    if tag == 'Font':
                        font_id = elem.get('ID', '')
                        font_name = (elem.get('FontName', '')
                                     or elem.get('FamilyName', ''))
                        if font_id and font_name:
                            self.font_id_map[font_id] = {'name': font_name}
            except Exception:
                logger.debug("Failed to load font resources from %s", res_name,
                             exc_info=True)

    def _probe_glyph(self, ch, fpath):
        """一次性探测字体是否真正包含某字形。"""
        try:
            test_font = ImageFont.truetype(fpath, 48)
            bbox = test_font.getbbox(ch)
            if not bbox or (bbox[2] - bbox[0]) < 3:
                return False
            img = PILImage.new('RGB', (64, 64), '#ffffff')
            d = ImageDraw.Draw(img)
            d.text((8, 8), ch, fill='#000000', font=test_font)
            dark = sum(
                1 for r, g, b in img.getdata()
                if r < DARK_THRESHOLD or g < DARK_THRESHOLD or b < DARK_THRESHOLD
            )
            return dark > 5
        except Exception:
            return False

    def _load_fallback_fonts(self):
        for fname in self.FALLBACK_FONT_NAMES:
            for fdir in self.FONT_DIRS:
                fpath = fdir + fname
                if os.path.exists(fpath):
                    try:
                        fb = ImageFont.truetype(fpath, 24)
                        self.fallback_fonts.append((fpath, fb))
                        break
                    except Exception:
                        logger.debug("Failed to load fallback font: %s", fpath,
                                     exc_info=True)
                        continue
        logger.debug(
            "fallback_fonts 加载顺序: %s",
            [os.path.basename(f) for f, _ in self.fallback_fonts],
        )

    # ────────────────────── 字体查找 ──────────────────────
    def _build_global_font_index(self):
        """预扫描所有 FONT_DIRS，构建全局 {filename_lower → (dir_index, filename)} 索引

        避免每次字体查找都重复遍历目录（os.listdir 在 Windows 上每次约 1-3ms，
        OFD 文档可能有数百次字体查找导致累计耗时数秒）。
        在 setup() 中调用一次即可。
        """
        self._global_font_index = {}
        for dir_idx, fdir in enumerate(self.FONT_DIRS):
            if not os.path.exists(fdir):
                continue
            try:
                for f in os.listdir(fdir):
                    lower = f.lower()
                    if lower.endswith(('.ttf', '.ttc')):
                        # 保留第一个匹配（目录顺序优先），后续同名文件忽略
                        if lower not in self._global_font_index:
                            self._global_font_index[lower] = (dir_idx, f)
            except OSError:
                continue

    def _find_system_font(self, font_name, size_px):
        key = font_name.lower().strip()
        candidates = self.FONT_MAP.get(key, []) + [
            f'{font_name}.ttf', f'{font_name}.ttc',
        ]
        # 优先从预构建的全局索引查找（O(1) 字典查询，无需目录遍历）
        for fname in candidates:
            lower = fname.lower()
            entry = self._global_font_index.get(lower) if hasattr(self, '_global_font_index') else None
            if entry:
                dir_idx, actual_name = entry
                fpath = self.FONT_DIRS[dir_idx] + actual_name
                try:
                    return ImageFont.truetype(fpath, size_px)
                except Exception:
                    logger.debug("Failed to load font from index: %s", fpath, exc_info=True)
                    continue
            else:
                # 回退到直接路径检查（兼容路径含子目录的候选名）
                for fdir in self.FONT_DIRS:
                    fpath = fdir + fname
                    if os.path.exists(fpath):
                        try:
                            return ImageFont.truetype(fpath, size_px)
                        except Exception:
                            logger.debug("Failed to load font: %s", fpath, exc_info=True)
                            continue
        # 目录扫描兜底（仅当全局索引未命中时）：优先选 Regular 权重
        if hasattr(self, '_global_font_index'):
            # 从全局索引中扫描：第一遍过滤 bold/italic，第二遍全部
            regular_candidates = []
            all_candidates = []
            for fname_lower, (dir_idx, actual_name) in self._global_font_index.items():
                fpath = self.FONT_DIRS[dir_idx] + actual_name
                all_candidates.append(fpath)
                if not any(w in fname_lower for w in ('bold', 'italic', 'bd', 'it')):
                    regular_candidates.append(fpath)
            for candidates_list in (regular_candidates, all_candidates):
                for fpath in candidates_list:
                    try:
                        return ImageFont.truetype(fpath, size_px)
                    except Exception:
                        continue
        else:
            # 无索引时的回退路径（几乎不会走到这里，保留仅为兜底）
            for fdir in self.FONT_DIRS:
                if not os.path.exists(fdir):
                    continue
                try:
                    entries = [f for f in os.listdir(fdir) if f.lower().endswith(('.ttf', '.ttc'))]
                except OSError:
                    continue
                for fname_in_dir in entries:
                    lower = fname_in_dir.lower()
                    if any(w in lower for w in ('bold', 'italic', 'bd', 'it')):
                        continue
                    try:
                        return ImageFont.truetype(fdir + fname_in_dir, size_px)
                    except Exception:
                        continue
                for fname_in_dir in entries:
                    try:
                        return ImageFont.truetype(fdir + fname_in_dir, size_px)
                    except Exception:
                        continue
        return ImageFont.load_default()

    def _get_font_for_id(self, font_id, size_px):
        cache_key = (font_id, size_px)
        if cache_key in self.font_cache:
            return self.font_cache[cache_key]
        info = self.font_id_map.get(font_id)
        font = (self._find_system_font(info['name'], size_px)
                if info else self._find_system_font('宋体', size_px))
        self.font_cache[cache_key] = font
        return font

    def _get_sized_fallback(self, fpath, size_px):
        key = (fpath, size_px)
        cached = self._fb_size_cache.get(key)
        if cached is not None:
            return None if cached is MISSING else cached
        try:
            sized = ImageFont.truetype(fpath, size_px)
            self._fb_size_cache[key] = sized
            return sized
        except Exception:
            self._fb_size_cache[key] = MISSING
            return None

    # ────────────────────── 文本处理 ──────────────────────
    @staticmethod
    def _clean_text(text):
        if not text:
            return ''
        return text.translate(CLEAN_TABLE)

    def _normalize_special_chars(self, text):
        puamap = self.PUA_MAP
        result = []
        for ch in text:
            mapped = puamap.get(ch)
            if mapped is not None:
                result.append(mapped)
            else:
                cp = ord(ch)
                if cp == 0xA8 or 0xE000 <= cp <= 0xF8FF:
                    result.append('\u2297')
                else:
                    result.append(ch)
        return ''.join(result)

    @staticmethod
    def _parse_glyphs_to_chars(glyphs_str):
        if not glyphs_str or not glyphs_str.strip():
            return ''
        result = []
        for part in glyphs_str.strip().rstrip(';').split(';'):
            part = part.strip()
            if not part:
                continue
            try:
                idx = int(part.split(',')[0])
            except ValueError:
                continue
            if 0 <= idx <= 25:
                result.append(chr(0x2460 + idx))
            elif 26 <= idx <= 35:
                result.append(chr(0x2486 + (idx - 26)))
            elif 36 <= idx <= 61:
                result.append(chr(0x24B6 + (idx - 36)))
            elif idx == 62:
                result.append('\u2297')
            elif idx == 63:
                result.append('\u24EA')
            else:
                try:
                    result.append(chr(idx))
                except ValueError:
                    result.append('?')
        return ''.join(result)

    # ────────────────────── 字符渲染 ──────────────────────
    def _get_font_identity(self, font):
        try:
            return font.path
        except AttributeError:
            return id(font)

    def _char_renders_ok(self, ch, font, strict=True):
        """检查字形是否可渲染。"""
        fid = self._get_font_identity(font)
        try:
            fsize = int(font.size)
        except (AttributeError, TypeError):
            fsize = 0
        cache_key = (fid, fsize, ch, strict)
        cached = self._char_render_cache.get(cache_key)
        if cached is not None:
            return cached
        try:
            bbox = font.getbbox(ch)
            if not bbox:
                self._char_render_cache[cache_key] = False
                return False
            w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
            if w < 3 or h < 3:
                self._char_render_cache[cache_key] = False
                return False
            if ch in self._SYMBOL_CHARS:
                result = self._verify_glyph_visible(
                    ch, font, bbox, fid, strict=strict)
                self._char_render_cache[cache_key] = result
                self._prune_cache(self._char_render_cache)
                return result
            self._char_render_cache[cache_key] = True
            return True
        except Exception:
            self._char_render_cache[cache_key] = False
            return False

    def _verify_glyph_visible(self, ch, font, bbox, font_id=None, strict=True):
        try:
            size_px = int(font.size)
        except AttributeError:
            size_px = 0
        cache_key = (font_id or id(font), size_px, ch, strict)
        cached = self._glyph_visible_cache.get(cache_key)
        if cached is not None:
            return cached
        result = self._do_verify(ch, font, bbox, strict=strict)
        self._glyph_visible_cache[cache_key] = result
        return result

    def _do_verify(self, ch, font, bbox, strict=True):
        """渲染字形到临时图像，验证是否有足够像素着色。"""
        try:
            w = int(bbox[2] - bbox[0])
            h = int(bbox[3] - bbox[1])
            img_w, img_h = max(w + 4, 16), max(h + 4, 16)
            test_img = PILImage.new('RGB', (img_w, img_h), '#ffffff')
            test_draw = ImageDraw.Draw(test_img)
            test_draw.text(
                (2 - int(bbox[0]), 2 - int(bbox[1])),
                ch, fill='#000000', font=font,
            )

            thresh = DARK_THRESHOLD
            pixels = test_img.getdata()
            dark_count = sum(
                1 for r, g, b in pixels
                if r < thresh or g < thresh or b < thresh
            )
            min_dark = 3 if strict else 1
            if dark_count <= min_dark:
                return False

            if ch in self._SYMBOL_CHARS:
                cx, cy = img_w // 2, img_h // 2
                half = max(2, min(img_w, img_h) // 6)
                y0, y1 = max(0, cy - half), min(img_h, cy + half)
                x0, x1 = max(0, cx - half), min(img_w, cx + half)
                center_img = test_img.crop((x0, y0, x1, y1))
                center_pixels = list(center_img.getdata())
                center_total = len(center_pixels)
                if center_total > 0:
                    center_dark = sum(
                        1 for r, g, b in center_pixels
                        if r < thresh or g < thresh or b < thresh
                    )
                    ratio = center_dark / center_total
                    min_ratio = 0.03 if strict else 0.005
                    if ratio < min_ratio:
                        return False
            return True
        except Exception:
            logger.debug("Glyph verification failed for U+%04X", ord(ch), exc_info=True)
            return False

    def _char_advance_px(self, ch, font, font_mm):
        """统一的字符宽度计算（像素）。"""
        try:
            return font.getlength(ch)
        except AttributeError:
            try:
                bbox = font.getbbox(ch)
                return bbox[2] - bbox[0] if bbox else font_mm * 0.6 * self.scale
            except Exception:
                return font_mm * 0.6 * self.scale

    # ────────────────────── 字形 RGBA 位图缓存 ──────────────────────
    def _get_glyph_rgba(self, ch, color, font, size_px):
        """获取或创建单个字形的 RGBA 位图（带缓存）。"""
        fpath = self._get_font_identity(font)
        cache_key = (fpath, size_px, ch, color)
        cached = self._glyph_rgba_cache.get(cache_key)
        if cached is not None:
            return cached

        try:
            bbox = font.getbbox(ch)
        except Exception:
            bbox = None
        if not bbox:
            self._glyph_rgba_cache[cache_key] = None
            return None
        gw = max(1, int(bbox[2] - bbox[0]))
        gh = max(1, int(bbox[3] - bbox[1]))
        pad = self._GLYPH_AFFINE_PAD
        glyph_img = PILImage.new('RGBA', (gw + 2 * pad, gh + 2 * pad), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glyph_img)
        gd.text((pad - int(bbox[0]), pad - int(bbox[1])),
                ch, fill=color, font=font)

        self._glyph_rgba_cache[cache_key] = glyph_img
        self._prune_cache(self._glyph_rgba_cache)
        return glyph_img

    def _draw_char(self, x_px, y_px, ch, color, font, size_px):
        """绘制单个字符（非旋转路径），唯一入口: Glyph Engine v2。"""
        self.glyph_engine.render(ch, x_px, y_px, size_px, color, font)

    def _draw_circled_times_manual(self, x, y, size, color):
        r = size * 0.42
        cx, cy = x + size * 0.5, y + size * 0.5
        pad = r * 0.55
        line_width = max(1, int(size * self._CIRCLED_TIMES_LINE_RATIO))
        self.draw.ellipse(
            [(cx - r, cy - r), (cx + r, cy + r)],
            outline=color, width=line_width,
        )
        self.draw.line([(cx - pad, cy - pad), (cx + pad, cy + pad)],
                       fill=color, width=line_width)
        self.draw.line([(cx + pad, cy - pad), (cx - pad, cy + pad)],
                       fill=color, width=line_width)

    # ────────────────────── 辅助解析 ──────────────────────
    def _get_color(self, elem, child_name):
        for child in elem:
            ctag = local_tag(child.tag)
            if ctag == child_name:
                value = child.get('Value', child.get('value', ''))
                if value:
                    parsed = _parse_ofd_color(value)
                    if parsed:
                        return parsed
        val = elem.get(child_name, '')
        return _parse_ofd_color(val) if val else None

    def _parse_boundary_mm(self, boundary_str):
        if not boundary_str:
            return None
        parts = boundary_str.strip().split()
        if len(parts) < 4:
            return None
        try:
            u = self.unit_to_mm
            return (float(parts[0]) * u, float(parts[1]) * u,
                    float(parts[2]) * u, float(parts[3]) * u)
        except ValueError:
            return None

    # ────────────────────── DeltaX 解析 ──────────────────────
    def _parse_deltas(self, dx_str, font_mm, text_len):
        """解析 DeltaX 属性。"""
        if not dx_str or not dx_str.strip():
            return [], False

        tokens = dx_str.strip().split()

        # 扩展格式: "alpha count value"
        if len(tokens) == 3:
            try:
                cnt = int(tokens[1])
                val = float(tokens[2])
                if tokens[0].isalpha() and 0 < cnt <= 200 and 0 < val < 100:
                    return [val] * cnt, False
            except (ValueError, OverflowError):
                pass

        deltas = []
        has_invalid_token = False
        for token in tokens:
            try:
                deltas.append(float(token))
            except ValueError:
                has_invalid_token = True

        use_font_advance = False
        if has_invalid_token:
            use_font_advance = True
        elif deltas and text_len > 1:
            needed = text_len - 1
            if len(deltas) < max(1, needed) * 0.5:
                use_font_advance = True

        if not use_font_advance and deltas and font_mm > 0:
            u = self.unit_to_mm
            for d in deltas:
                delta_mm = abs(d) * u
                ratio = delta_mm / font_mm
                if ratio < 0.1 or ratio > 5.0:
                    logger.debug(
                        "DeltaX 异常: delta_mm=%.4f, font_mm=%.4f, "
                        "ratio=%.2f — 回退到字体宽度", delta_mm, font_mm, ratio)
                    use_font_advance = True
                    break

        return deltas, use_font_advance

    # ────────────────────── 路径解析（CTM 感知）──────────────────────
    def _parse_ofd_path(self, abbr_data, to_px):
        """解析 OFD AbbreviatedData → 子路径列表。"""
        tokens = abbr_data.strip().split()
        sub_paths = []
        current = []
        cx, cy = 0.0, 0.0
        N = self._BEZIER_SEGMENTS
        tokens_len = len(tokens)

        i = 0
        while i < tokens_len:
            tok = tokens[i]
            i += 1

            if tok == 'M':
                if current:
                    sub_paths.append(current)
                    current = []
                if i + 1 < tokens_len:
                    try:
                        cx = float(tokens[i])
                        cy = float(tokens[i + 1])
                        i += 2
                        current.append(to_px(cx, cy))
                    except ValueError:
                        continue

            elif tok == 'L':
                if i + 1 < tokens_len:
                    try:
                        cx = float(tokens[i])
                        cy = float(tokens[i + 1])
                        i += 2
                        current.append(to_px(cx, cy))
                    except ValueError:
                        continue

            elif tok in ('B', 'C'):
                if i + 5 < tokens_len:
                    try:
                        x1, y1 = float(tokens[i]), float(tokens[i + 1])
                        x2, y2 = float(tokens[i + 2]), float(tokens[i + 3])
                        ex, ey = float(tokens[i + 4]), float(tokens[i + 5])
                        i += 6
                        for seg in range(1, N + 1):
                            t = seg / N
                            mt = 1.0 - t
                            mt2, t2 = mt * mt, t * t
                            bx = (mt2 * mt * cx + 3 * mt2 * t * x1
                                  + 3 * mt * t2 * x2 + t2 * t * ex)
                            by = (mt2 * mt * cy + 3 * mt2 * t * y1
                                  + 3 * mt * t2 * y2 + t2 * t * ey)
                            current.append(to_px(bx, by))
                        cx, cy = ex, ey
                    except ValueError:
                        continue

            elif tok == 'Q':
                if i + 3 < tokens_len:
                    try:
                        x1, y1 = float(tokens[i]), float(tokens[i + 1])
                        ex, ey = float(tokens[i + 2]), float(tokens[i + 3])
                        i += 4
                        for seg in range(1, N + 1):
                            t = seg / N
                            mt = 1.0 - t
                            qx = mt * mt * cx + 2 * mt * t * x1 + t * t * ex
                            qy = mt * mt * cy + 2 * mt * t * y1 + t * t * ey
                            current.append(to_px(qx, qy))
                        cx, cy = ex, ey
                    except ValueError:
                        continue

            elif tok == 'S':
                if current and len(current) > 1:
                    current.append(current[0])

            else:
                try:
                    float(tok)
                except ValueError:
                    pass

        if current:
            sub_paths.append(current)
        return sub_paths

    # ────────────────────── 注释层印章收集 ──────────────────────
    def _collect_annotation_objects(self, all_objects):
        if self._annot_collected:
            return
        self._annot_collected = True
        for name in self.all_names:
            nl = name.lower()
            if 'annot' not in nl or not nl.endswith('.xml'):
                continue
            try:
                ann_raw = self.zf.read(name).decode('utf-8', errors='ignore')
                ann_clean = _strip_ofd_ns(ann_raw)
                ann_root = ET.fromstring(ann_clean)
                for ann_elem in ann_root.iter():
                    ann_tag = local_tag(ann_elem.tag)
                    if ann_tag != 'Annot' or ann_elem.get('Type', '') != 'Stamp':
                        continue
                    for sub in ann_elem.iter():
                        sub_tag = local_tag(sub.tag)
                        if sub_tag != 'Appearance':
                            continue
                        app_boundary = sub.get('Boundary', '')
                        for img_elem in sub.iter():
                            img_tag = local_tag(img_elem.tag)
                            if img_tag != 'ImageObject':
                                continue
                            rid = img_elem.get('ResourceID', '')
                            ctm_val = img_elem.get('CTM', '')
                            if app_boundary and rid:
                                fake = ET.Element('ImageObject')
                                fake.set('Boundary', app_boundary)
                                fake.set('ResourceID', rid)
                                if ctm_val:
                                    fake.set('CTM', ctm_val)
                                all_objects.append(('ImageObject', fake))
            except Exception:
                logger.debug("Failed to collect annotations from %s", name,
                             exc_info=True)

    # ────────────────────── TextObject 渲染 ──────────────────────
    def _render_text_object(self, elem):
        """渲染文本对象 —— True CTM 管线。"""
        boundary = elem.get('Boundary', '')
        font_size_raw = elem.get('Size', '4')
        font_id = elem.get('Font', '')

        bound = self._parse_boundary_mm(boundary)
        if not bound:
            return False
        bx, by, bw, bh = bound

        font_mm = float(font_size_raw) * self.unit_to_mm
        font_px = max(8, round(font_mm * self.scale))
        font = self._get_font_for_id(font_id, font_px)
        ascent, descent = font.getmetrics()
        color = self._get_color(elem, 'FillColor') or '#000000'

        ctm_str = elem.get('CTM', '')
        if ctm_str:
            self.ctx.push(CTM.from_string(ctm_str))
        result = False
        try:
            result = self._do_render_text(
                elem, bound, font, font_px, font_mm, ascent, color,
            )
        finally:
            if ctm_str:
                self.ctx.pop()
        return result

    def _do_render_text(self, elem, bound, font, font_px, font_mm, ascent, color):
        """在 CTM 栈已设置的前提下渲染所有 TextCode。"""
        bx, by, bw, bh = bound
        ctx = self.ctx
        u = self.unit_to_mm
        s = self.scale

        all_textcodes = []
        for tc in elem.iter():
            tc_tag = local_tag(tc.tag)
            if tc_tag != 'TextCode':
                continue
            raw_text = tc.text or ''
            if not raw_text.strip():
                glyphs_attr = tc.get('Glyphs', '')
                if glyphs_attr:
                    raw_text = self._parse_glyphs_to_chars(glyphs_attr)
            elif (';' in raw_text
                  and RE_DELTA_GLYPHS.match(raw_text.replace(' ', ''))):
                raw_text = self._parse_glyphs_to_chars(raw_text)
            raw_text = self._normalize_special_chars(raw_text)
            cleaned = self._clean_text(raw_text)
            all_textcodes.append({
                'text': cleaned,
                'x': tc.get('X', None),
                'y': tc.get('Y', None),
                'deltaX': tc.get('DeltaX', None),
            })

        if not all_textcodes:
            return False

        to_px = ctx.make_to_px(bx, by)

        advance_px_cache = {}
        scale_inv = 1.0 / s

        def get_advance_ofd(ch):
            cached = advance_px_cache.get(ch)
            if cached is not None:
                return cached
            px = self._char_advance_px(ch, font, font_mm)
            val = px * scale_inv / u if u > 0 else 0.0
            advance_px_cache[ch] = val
            return val

        first = all_textcodes[0]
        default_x = float(first['x']) if first['x'] is not None else 0.0
        default_y = float(first['y']) if first['y'] is not None else 0.0

        rendered = False
        draw_char = self._draw_char

        ctm = ctx.ctm
        a_ctm, b_ctm, c_ctm, d_ctm = ctm.a, ctm.b, ctm.c, ctm.d
        det = a_ctm * d_ctm - b_ctm * c_ctm
        has_rotation = (abs(b_ctm) > 1e-4 or abs(c_ctm) > 1e-4)

        use_affine = False
        a_inv = b_inv = c_inv = d_inv = 0.0
        if has_rotation and abs(det) > 1e-9:
            inv_det = 1.0 / det
            a_inv = d_ctm * inv_det
            b_inv = -b_ctm * inv_det
            c_inv = -c_ctm * inv_det
            d_inv = a_ctm * inv_det
            use_affine = True

        for tc_data in all_textcodes:
            tc_x = (float(tc_data['x'])
                    if tc_data['x'] is not None else default_x)
            tc_y = (float(tc_data['y'])
                    if tc_data['y'] is not None else default_y)

            tc_text = tc_data['text']
            if not tc_text.strip():
                default_x = tc_x
                default_y = tc_y
                continue

            tc_deltas, use_font_advance = self._parse_deltas(
                tc_data.get('deltaX'), font_mm, len(tc_text),
            )

            if use_font_advance:
                char_x = tc_x
                for ch in tc_text:
                    if ch not in (' ', '\n', '\t', '\r'):
                        px_x, px_y = to_px(char_x, tc_y)
                        if use_affine:
                            if ch == '\u2297':
                                self.glyph_engine.render_affine(
                                    ch, px_x, px_y, font_px, color, font,
                                    a_ctm, b_ctm, c_ctm, d_ctm,
                                )
                            else:
                                self._draw_char_affine(
                                    px_x, px_y, ch, color,
                                    font, font_px,
                                    a_inv, b_inv, c_inv, d_inv, det,
                                    a_ctm, b_ctm, c_ctm, d_ctm,
                                )
                        else:
                            draw_char(px_x, px_y - ascent, ch, color,
                                      font, font_px)
                        rendered = True
                    char_x += get_advance_ofd(ch)
                default_x = char_x
                continue

            char_x = tc_x
            num_deltas = len(tc_deltas)
            for i, ch in enumerate(tc_text):
                if ch not in (' ', '\n', '\t', '\r'):
                    px_x, px_y = to_px(char_x, tc_y)
                    if use_affine:
                        if ch == '\u2297':
                            self.glyph_engine.render_affine(
                                ch, px_x, px_y, font_px, color, font,
                                a_ctm, b_ctm, c_ctm, d_ctm,
                            )
                        else:
                            self._draw_char_affine(
                                px_x, px_y, ch, color,
                                font, font_px,
                                a_inv, b_inv, c_inv, d_inv, det,
                                a_ctm, b_ctm, c_ctm, d_ctm,
                            )
                    else:
                        draw_char(px_x, px_y - ascent, ch, color,
                                  font, font_px)
                    rendered = True
                if i < num_deltas:
                    char_x += tc_deltas[i]
                else:
                    char_x += get_advance_ofd(ch)
            default_x = char_x

        return rendered

    # ────────────────────── 仿射字符渲染 ──────────────────────
    def _draw_char_affine(self, px_x, px_y, ch, color,
                          font, font_px,
                          a_inv, b_inv, c_inv, d_inv, det,
                          a_ctm, b_ctm, c_ctm, d_ctm):
        """使用仿射变换渲染单个字形（支持完整 CTM 旋转/缩放）。"""
        if abs(det) < 1e-12:
            self.draw.text((px_x, px_y), ch, fill=color, font=font)
            return

        glyph_rgba = self._get_glyph_rgba(ch, color, font, font_px)
        if glyph_rgba is None:
            return

        src_w, src_h = glyph_rgba.size

        out_w, out_h, min_x, min_y = affine_bounding_box(
            src_w, src_h, a_ctm, b_ctm, c_ctm, d_ctm,
        )

        e_inv = a_inv * min_x + c_inv * min_y
        f_inv = b_inv * min_x + d_inv * min_y
        aff = (a_inv, b_inv, c_inv, d_inv, e_inv, f_inv)

        try:
            transformed = glyph_rgba.transform(
                (out_w, out_h), PILImage.AFFINE, aff,
                resample=PILImage.BICUBIC, fillcolor=(0, 0, 0, 0),
            )
        except Exception:
            logger.debug("Affine transform failed for char U+%04X", ord(ch),
                         exc_info=True)
            return

        ascent_px = font.getmetrics()[0]
        dx = c_ctm * (-ascent_px)
        dy = d_ctm * (-ascent_px)

        pad = self._GLYPH_AFFINE_PAD
        try:
            _bbox = font.getbbox(ch)
            tox_src = pad - int(_bbox[0]) if _bbox else pad
            toy_src = pad - int(_bbox[1]) if _bbox else pad
        except Exception:
            tox_src = toy_src = pad

        tox_vis = a_ctm * tox_src + c_ctm * toy_src
        toy_vis = b_ctm * tox_src + d_ctm * toy_src

        tox_out = tox_vis - min_x
        toy_out = toy_vis - min_y

        dest_x = round(px_x + dx - tox_out)
        dest_y = round(px_y + dy - toy_out)

        try:
            self.img.paste(transformed, (dest_x, dest_y), transformed)
        except Exception:
            try:
                self.img.paste(transformed, (dest_x, dest_y))
            except Exception:
                logger.debug("Failed to paste affine glyph at (%d, %d)",
                             dest_x, dest_y, exc_info=True)

    # ────────────────────── PathObject 渲染 ──────────────────────
    def _render_path_object(self, elem):
        """渲染路径对象 —— True CTM 管线。"""
        boundary = elem.get('Boundary', '')
        stroke = elem.get('Stroke', 'false').lower() == 'true'
        fill = elem.get('Fill', 'false').lower() == 'true'
        try:
            line_width = float(elem.get('LineWidth', '0.35')) * self.unit_to_mm
        except ValueError:
            line_width = 0.35 * self.unit_to_mm
        if not elem.get('Stroke'):
            stroke = True
        bound = self._parse_boundary_mm(boundary)
        if not bound:
            return False
        bx, by, bw, bh = bound

        s_color = self._get_color(elem, 'StrokeColor') or '#000000'
        f_color = self._get_color(elem, 'FillColor')

        abbr_data = ''
        for child in elem:
            ctag = local_tag(child.tag)
            if ctag == 'AbbreviatedData' and child.text:
                abbr_data = child.text.strip()
                break

        ctm_str = elem.get('CTM', '')
        if ctm_str:
            self.ctx.push(CTM.from_string(ctm_str))
        result = False
        try:
            result = self._do_render_path(
                abbr_data, bx, by, bw, bh,
                stroke, fill, line_width, s_color, f_color,
            )
        finally:
            if ctm_str:
                self.ctx.pop()
        return result

    def _do_render_path(self, abbr_data, bx, by, bw, bh,
                        stroke, fill, line_width, s_color, f_color):
        """在 CTM 栈已设置的前提下渲染路径。"""
        lw = max(1, round(line_width * self.scale))

        if not abbr_data:
            x1, y1 = round(bx * self.scale), round(by * self.scale)
            x2, y2 = x1 + round(bw * self.scale), y1 + round(bh * self.scale)
            if fill and f_color:
                self.draw.rectangle(
                    [x1, y1, x2, y2], fill=f_color,
                    outline=s_color if stroke else None,
                )
            elif stroke:
                self.draw.rectangle(
                    [x1, y1, x2, y2], outline=s_color, width=lw,
                )
            return True

        to_px = self.ctx.make_to_px(bx, by)
        sub_paths = self._parse_ofd_path(abbr_data, to_px)

        if sub_paths:
            any_drawn = False
            for sp in sub_paths:
                if len(sp) < 2:
                    continue
                is_closed = len(sp) >= 3 and sp[0] == sp[-1]
                if fill and f_color and is_closed:
                    self.draw.polygon(sp, fill=f_color,
                                      outline=s_color if stroke else None)
                    any_drawn = True
                elif stroke:
                    self.draw.line(sp, fill=s_color, width=lw, joint='curve')
                    any_drawn = True
            if any_drawn:
                return True

        ctm = self.ctx.ctm
        is_identity = (
            abs(ctm.a - 1) < 1e-6 and abs(ctm.b) < 1e-6
            and abs(ctm.c) < 1e-6 and abs(ctm.d - 1) < 1e-6
            and abs(ctm.e) < 1e-6 and abs(ctm.f) < 1e-6
        )
        if not is_identity:
            logger.warning(
                "Path primary CTM-aware parser failed at boundary "
                "(%.2f, %.2f, %.2f, %.2f); CTM non-identity → "
                "skipping fallback to avoid incorrect rendering",
                bx, by, bw, bh,
            )
            return False

        logger.debug(
            "Path primary parser failed at (%.2f, %.2f, %.2f, %.2f); "
            "CTM=identity, trying xml_utils fallback",
            bx, by, bw, bh,
        )
        parsed = _parse_path_data(abbr_data, bx, by,
                                  self.unit_to_mm, self.scale)
        if parsed and len(parsed.get('points', [])) >= 2:
            points = parsed['points']
            if fill and f_color and len(points) >= 3:
                self.draw.polygon(points, fill=f_color,
                                  outline=s_color if stroke else None)
            elif stroke:
                self.draw.line(points, fill=s_color, width=lw)
            return True

        return False

    # ────────────────────── ImageObject 渲染 ──────────────────────
    def _render_image_object(self, elem):
        """渲染图片对象 —— True CTM 管线。"""
        boundary = elem.get('Boundary', '')
        resource_id = elem.get('ResourceID', '')
        bound = self._parse_boundary_mm(boundary)
        if not bound or not resource_id:
            return False
        bx, by, bw, bh = bound

        pil_img = self._load_resource_image(resource_id)
        if not pil_img:
            return False

        ctm_str = elem.get('CTM', '')
        if ctm_str:
            self.ctx.push(CTM.from_string(ctm_str))
        result = False
        try:
            pos_x, pos_y = self.ctx.local_to_px(0, 0, bx, by)

            ctm = self.ctx.ctm
            has_rotation = (abs(ctm.b) > 1e-6 or abs(ctm.c) > 1e-6)

            if has_rotation:
                base_w = max(10, round(bw * self.scale))
                base_h = max(10, round(bh * self.scale))
                resized = pil_img.resize((base_w, base_h), LANCZOS)

                det = ctm.a * ctm.d - ctm.b * ctm.c
                if abs(det) < 1e-12:
                    try:
                        self.img.paste(resized, (pos_x, pos_y), resized)
                    except Exception:
                        self.img.paste(resized, (pos_x, pos_y))
                else:
                    inv_det = 1.0 / det
                    a_inv = ctm.d * inv_det
                    b_inv = -ctm.b * inv_det
                    c_inv = -ctm.c * inv_det
                    d_inv = ctm.a * inv_det

                    src_w, src_h = resized.size
                    out_w, out_h, min_x, min_y = affine_bounding_box(
                        src_w, src_h, ctm.a, ctm.b, ctm.c, ctm.d,
                    )

                    e_inv = a_inv * min_x + c_inv * min_y
                    f_inv = b_inv * min_x + d_inv * min_y

                    aff = (a_inv, b_inv, c_inv, d_inv, e_inv, f_inv)
                    try:
                        rotated = resized.transform(
                            (out_w, out_h),
                            PILImage.AFFINE,
                            aff,
                            resample=PILImage.BICUBIC,
                            fillcolor=(0, 0, 0, 0),
                        )
                        paste_x = pos_x + round(min_x)
                        paste_y = pos_y + round(min_y)
                        self.img.paste(rotated, (paste_x, paste_y), rotated)
                    except Exception:
                        logger.debug(
                            "Image affine transform failed, "
                            "falling back to paste without rotation",
                            exc_info=True,
                        )
                        try:
                            self.img.paste(resized, (pos_x, pos_y), resized)
                        except Exception:
                            try:
                                self.img.paste(resized, (pos_x, pos_y))
                            except Exception:
                                logger.debug(
                                    "Failed to paste image at (%d, %d)",
                                    pos_x, pos_y, exc_info=True)
            else:
                sx, sy = self.ctx.ctm.scale_factors()
                lo, hi = self._CTM_SCALE_MIN, self._CTM_SCALE_MAX
                sx = sx if lo < sx < hi else 1.0
                sy = sy if lo < sy < hi else 1.0
                target_w = max(10, round(sx * bw * self.scale))
                target_h = max(10, round(sy * bh * self.scale))
                resized = pil_img.resize((target_w, target_h), LANCZOS)
                try:
                    self.img.paste(resized, (pos_x, pos_y), resized)
                except Exception:
                    try:
                        self.img.paste(resized, (pos_x, pos_y))
                    except Exception:
                        logger.debug("Failed to paste image at (%d, %d)",
                                     pos_x, pos_y, exc_info=True)
            result = True
        finally:
            if ctm_str:
                self.ctx.pop()
        return result

    # ────────────────────── 主渲染入口 ──────────────────────
    def render(self, root):
        self._annot_collected = False
        self.ctx = RenderContext(self.unit_to_mm, self.scale)

        all_objects = []
        for elem in root.iter():
            tag = local_tag(elem.tag)
            if tag in ('TextObject', 'PathObject', 'ImageObject'):
                all_objects.append((tag, elem))
        self._collect_annotation_objects(all_objects)

        text_count = path_count = image_count = 0
        for tag, elem in all_objects:
            if tag == 'TextObject' and self._render_text_object(elem):
                text_count += 1
            elif tag == 'PathObject' and self._render_path_object(elem):
                path_count += 1
            elif tag == 'ImageObject' and self._render_image_object(elem):
                image_count += 1

        total = text_count + path_count + image_count
        logger.info("OFD渲染完成: %d×%dpx, 文本 %d, 路径 %d, 图片 %d",
                     self.img_w, self.img_h, text_count, path_count, image_count)
        return self.img if total > 0 else None
