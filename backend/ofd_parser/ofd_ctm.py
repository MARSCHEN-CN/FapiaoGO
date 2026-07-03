"""
OFD 页面渲染 — 2D 仿射变换矩阵 (CTM) 与包围盒计算

  | a  c  e |   | x |   | a*x + c*y + e |
  | b  d  f | × | y | = | b*x + d*y + f |
  | 0  0  1 |   | 1 |   |      1        |
"""
import logging

logger = logging.getLogger(__name__)


class CTM:
    """OFD / PDF 通用 2D 仿射变换矩阵（构造后不可变）"""
    __slots__ = ('a', 'b', 'c', 'd', 'e', 'f')

    def __init__(self, a=1.0, b=0.0, c=0.0, d=1.0, e=0.0, f=0.0):
        object.__setattr__(self, 'a', float(a))
        object.__setattr__(self, 'b', float(b))
        object.__setattr__(self, 'c', float(c))
        object.__setattr__(self, 'd', float(d))
        object.__setattr__(self, 'e', float(e))
        object.__setattr__(self, 'f', float(f))

    def __setattr__(self, name, value):
        if name in self.__slots__:
            raise AttributeError(f"CTM is immutable; cannot set '{name}'")
        super().__setattr__(name, value)

    def __delattr__(self, name):
        if name in self.__slots__:
            raise AttributeError(f"CTM is immutable; cannot delete '{name}'")
        super().__delattr__(name)

    # ── 工厂方法 ──
    @staticmethod
    def identity():
        return IDENTITY_CTM

    @staticmethod
    def from_string(ctm_str):
        """从 OFD XML 'a b c d e f' 字符串解析。"""
        if not ctm_str or not ctm_str.strip():
            return IDENTITY_CTM
        parts = ctm_str.strip().split()
        if len(parts) != 6:
            logger.warning("Invalid CTM string (expected 6 values, got %d): %r",
                           len(parts), ctm_str)
            return IDENTITY_CTM
        try:
            return CTM(
                float(parts[0]), float(parts[1]),
                float(parts[2]), float(parts[3]),
                float(parts[4]), float(parts[5]),
            )
        except (ValueError, OverflowError):
            logger.warning("Invalid CTM values: %r", ctm_str)
            return IDENTITY_CTM

    # ── 核心运算 ──
    def transform_point(self, x, y):
        """变换一个点。"""
        return (self.a * x + self.c * y + self.e,
                self.b * x + self.d * y + self.f)

    def multiply(self, other: 'CTM') -> 'CTM':
        """矩阵乘法 self × other，返回新的 CTM。"""
        return CTM(
            self.a * other.a + self.c * other.b,
            self.b * other.a + self.d * other.b,
            self.a * other.c + self.c * other.d,
            self.b * other.c + self.d * other.d,
            self.a * other.e + self.c * other.f + self.e,
            self.b * other.e + self.d * other.f + self.f,
        )

    def scale_factors(self):
        """提取 X / Y 方向缩放因子（含旋转/倾斜补偿）。"""
        return ((self.a * self.a + self.b * self.b) ** 0.5,
                (self.c * self.c + self.d * self.d) ** 0.5)


# 模块级常量：恒等矩阵单例（不可变 CTM，安全共享）
IDENTITY_CTM = CTM()


def affine_bounding_box(src_w, src_h, a_ctm, b_ctm, c_ctm, d_ctm):
    """计算源图像经 CTM 线性部分变换后的包围盒。

    Returns:
        (out_w, out_h, min_x, min_y) — 输出尺寸与偏移量
    """
    corners = [(0, 0), (src_w, 0), (0, src_h), (src_w, src_h)]
    xs = [a_ctm * x + c_ctm * y for x, y in corners]
    ys = [b_ctm * x + d_ctm * y for x, y in corners]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    return (max(1, round(max_x - min_x)),
            max(1, round(max_y - min_y)),
            min_x, min_y)
