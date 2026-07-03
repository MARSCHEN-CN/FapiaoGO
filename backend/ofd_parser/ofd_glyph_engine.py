"""
OFD 页面渲染 — Glyph Engine v2（统一 Glyph 渲染架构）

把"字符渲染"从 font-driven 改成 rule-driven，
所有字符都走 GlyphEngineV2，font system 只做 fallback。
"""
import os
import math
import logging

logger = logging.getLogger(__name__)


class GlyphRegistry:
    """Glyph → 渲染策略注册表（v2 核心）。"""

    def __init__(self):
        self._map = {}

    def register(self, ch, handler):
        self._map[ch] = handler

    def get(self, ch):
        return self._map.get(ch)


class GlyphPrimitives:
    """所有稳定图形 glyph（WPS 级一致性来源）。"""

    def __init__(self, draw):
        self.draw = draw

    def circled_times(self, x, y, size, color):
        """绘制 ⊗（U+2297）— 正圆 + 叉号，等比缩放。"""
        scale = size
        r = scale * 0.45
        cx = x + scale * 0.5
        cy = y + scale * 0.5
        stroke = max(1, round(scale * 0.08))

        self.draw.ellipse(
            (cx - r, cy - r, cx + r, cy + r),
            outline=color, width=stroke,
        )
        pad = r * 0.55
        self.draw.line(
            (cx - pad, cy - pad, cx + pad, cy + pad),
            fill=color, width=stroke,
        )
        self.draw.line(
            (cx - pad, cy + pad, cx + pad, cy - pad),
            fill=color, width=stroke,
        )

    def circled_times_affine(self, x, y, size, color, a_ctm, b_ctm, c_ctm, d_ctm):
        """在仿射变换坐标系中绘制 ⊗（U+2297）。

        使用面积保持公式计算缩放。
        """
        det = a_ctm * d_ctm - b_ctm * c_ctm
        scale = math.sqrt(abs(det))
        if scale < 1:
            scale = 1

        r = scale * 0.45
        cx = x
        cy = y - scale * 0.35
        stroke = max(1, round(scale * 0.08))

        self.draw.ellipse(
            (cx - r, cy - r, cx + r, cy + r),
            outline=color, width=stroke,
        )
        pad = r * 0.55
        self.draw.line(
            (cx - pad, cy - pad, cx + pad, cy + pad),
            fill=color, width=stroke,
        )
        self.draw.line(
            (cx - pad, cy + pad, cx + pad, cy - pad),
            fill=color, width=stroke,
        )


class GlyphEngineV2:
    """Glyph Engine v2 — 统一调度器。

    renderer 参数为鸭子类型，需提供以下属性/方法:
      - draw, fallback_fonts, _verified_font_chars
      - _get_sized_fallback(), _char_renders_ok()
    """

    # 等宽字体优先级（用于数字、代码、信用代码等）
    MONOSPACE_FONTS = (
        'cour.ttf',      # Courier New
        'consola.ttf',   # Consolas
        'consolas.ttf',
        'DejaVuSansMono.ttf',
        'RobotoMono-Regular.ttf',
    )

    def __init__(self, renderer):
        self.r = renderer
        self.registry = GlyphRegistry()
        self.primitive = None  # 延迟初始化，因为 draw 对象后创建
        self._init_registry()

    def _init_registry(self):
        self.registry.register('\u2297', self._circled_times)

    def set_draw(self, draw):
        """设置 draw 对象（延迟初始化）。"""
        self.primitive = GlyphPrimitives(draw)

    # ─────────────────────────────
    #  公共渲染入口
    # ─────────────────────────────
    def render(self, ch, x, y, size_px, color, font):
        """统一渲染入口（唯一入口）。"""
        handler = self.registry.get(ch)
        if handler:
            return handler(ch, x, y, size_px, color, font)
        return self._font_render(ch, x, y, size_px, color, font)

    def render_affine(self, ch, x, y, size_px, color, font,
                      a_ctm, b_ctm, c_ctm, d_ctm):
        """仿射变换路径的渲染入口。"""
        handler = self.registry.get(ch)
        if handler:
            if ch == '\u2297':
                return self._circled_times_affine(
                    ch, x, y, size_px, color, font,
                    a_ctm, b_ctm, c_ctm, d_ctm,
                )
            return handler(ch, x, y, size_px, color, font)
        return False

    # ─────────────────────────────
    #  ⊗ (U+2297) 渲染
    # ─────────────────────────────
    def _circled_times(self, ch, x, y, size_px, color, font):
        """⊗ 渲染：primitive 优先 → 字体 → fallback。"""
        if self.primitive:
            self.primitive.circled_times(x, y, size_px, color)
            return

        for fpath, _ in self.r.fallback_fonts:
            sized = self.r._get_sized_fallback(fpath, size_px)
            if sized is None:
                continue
            if (fpath, ch) in self.r._verified_font_chars:
                self.r.draw.text((x, y), ch, fill=color, font=sized)
                return
            if self.r._char_renders_ok(ch, sized, strict=False):
                self.r._verified_font_chars.add((fpath, ch))
                self.r.draw.text((x, y), ch, fill=color, font=sized)
                return

    def _circled_times_affine(self, ch, x, y, size_px, color, font,
                              a_ctm, b_ctm, c_ctm, d_ctm):
        """⊗ affine 渲染：primitive 优先 → 字体 → fallback。"""
        if self.primitive:
            self.primitive.circled_times_affine(
                x, y, size_px, color, a_ctm, b_ctm, c_ctm, d_ctm,
            )
            return True

        for fpath, _ in self.r.fallback_fonts:
            sized = self.r._get_sized_fallback(fpath, size_px)
            if sized is None:
                continue
            if (fpath, ch) in self.r._verified_font_chars:
                self.r.draw.text((x, y), ch, fill=color, font=sized)
                return True
            if self.r._char_renders_ok(ch, sized, strict=False):
                self.r._verified_font_chars.add((fpath, ch))
                self.r.draw.text((x, y), ch, fill=color, font=sized)
                return True

        return False

    # ─────────────────────────────
    #  Font system fallback
    # ─────────────────────────────
    def _font_render(self, ch, x, y, size_px, color, font):
        """Font system fallback（只做 fallback，不做决策）。"""
        # 数字、大写字母和小数点优先用等宽字体
        if ch.isdigit() or ch == '.' or ('A' <= ch <= 'Z'):
            if self._render_with_monospace(ch, x, y, size_px, color):
                return

        # 其他符号走 fallback 字体
        if ch in self.r._SYMBOL_CHARS:
            for fpath, _ in self.r.fallback_fonts:
                sized = self.r._get_sized_fallback(fpath, size_px)
                if sized is None:
                    continue
                if (fpath, ch) in self.r._verified_font_chars:
                    self.r.draw.text((x, y), ch, fill=color, font=sized)
                    return
                if self.r._char_renders_ok(ch, sized, strict=False):
                    self.r._verified_font_chars.add((fpath, ch))
                    self.r.draw.text((x, y), ch, fill=color, font=sized)
                    return

        # 主字体
        if self.r._char_renders_ok(ch, font):
            self.r.draw.text((x, y), ch, fill=color, font=font)
            return

        # fallback 链
        for fpath, _ in self.r.fallback_fonts:
            sized = self.r._get_sized_fallback(fpath, size_px)
            if sized and self.r._char_renders_ok(ch, sized):
                self.r.draw.text((x, y), ch, fill=color, font=sized)
                return

        # 最终兜底
        self.r.draw.text((x, y), ch, fill=color, font=font)

    def _render_with_monospace(self, ch, x, y, size_px, color):
        """用等宽字体渲染字符（数字、信用代码等）。"""
        for mono_name in self.MONOSPACE_FONTS:
            for fpath, _ in self.r.fallback_fonts:
                if mono_name.lower() not in os.path.basename(fpath).lower():
                    continue
                sized = self.r._get_sized_fallback(fpath, size_px)
                if sized is None:
                    continue
                if self.r._char_renders_ok(ch, sized, strict=False):
                    self.r.draw.text((x, y), ch, fill=color, font=sized)
                    return True

        # 回退到 Arial（非 bold）
        for fpath, _ in self.r.fallback_fonts:
            fname = os.path.basename(fpath).lower()
            if 'arial' not in fname:
                continue
            if any(w in fname for w in ('bd', 'bi', 'bold', 'italic')):
                continue
            sized = self.r._get_sized_fallback(fpath, size_px)
            if sized is None:
                continue
            self.r.draw.text((x, y), ch, fill=color, font=sized)
            return True

        return False
