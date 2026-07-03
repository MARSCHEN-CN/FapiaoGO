"""
OFD 页面渲染 — RenderContext（坐标管线 + CTM 栈）

管线:  OFD 本地坐标 → CTM → World(mm) → Pixel
"""
from .ofd_ctm import CTM, IDENTITY_CTM


class RenderContext:
    """渲染上下文 —— 管理 CTM 栈与坐标转换管线。"""

    __slots__ = ('unit_to_mm', 'scale', '_stack')

    def __init__(self, unit_to_mm, scale):
        self.unit_to_mm = unit_to_mm
        self.scale = scale
        self._stack = [IDENTITY_CTM]

    @property
    def ctm(self):
        return self._stack[-1]

    def push(self, ctm):
        """压入组合 CTM: 栈顶 × ctm（新矩阵考虑所有祖先变换）。"""
        self._stack.append(self._stack[-1].multiply(ctm))

    def pop(self):
        """弹出 CTM。"""
        if len(self._stack) > 1:
            self._stack.pop()

    # ── 坐标转换 ──
    def local_to_px(self, lx, ly, bx_mm, by_mm):
        """完整管线: OFD 本地 → CTM → +boundary(mm) → 像素。"""
        ctm = self._stack[-1]
        tx = ctm.a * lx + ctm.c * ly + ctm.e
        ty = ctm.b * lx + ctm.d * ly + ctm.f
        u, s = self.unit_to_mm, self.scale
        return (round((bx_mm + tx * u) * s),
                round((by_mm + ty * u) * s))

    def make_to_px(self, bx_mm, by_mm):
        """创建 to_px 闭包，用于循环热路径（消除属性查找）。

        恒等矩阵走快速路径，非恒等矩阵内联 CTM 分量。
        """
        ctm = self._stack[-1]
        a, b = ctm.a, ctm.b
        c, d = ctm.c, ctm.d
        e, f = ctm.e, ctm.f
        u = self.unit_to_mm
        s = self.scale

        _tol = 1e-9
        if (abs(a - 1) < _tol and abs(b) < _tol and abs(c) < _tol
                and abs(d - 1) < _tol and abs(e) < _tol and abs(f) < _tol):
            # 恒等矩阵快速路径
            def to_px(lx, ly):
                return (round((bx_mm + lx * u) * s),
                        round((by_mm + ly * u) * s))
        else:
            # 一般 CTM 路径
            def to_px(lx, ly):
                tx = a * lx + c * ly + e
                ty = b * lx + d * ly + f
                return (round((bx_mm + tx * u) * s),
                        round((by_mm + ty * u) * s))
        return to_px
