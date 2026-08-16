"""PartyGeometry —— 统一 Party 空间事实层（Contract v0.1 / 轨道 A Batch 1）。

本模块是 Model B（Facade / Canonicalizer + 渐进 Consumer Migration）的第一个
可复用构件。它**只**把已有的 Party anchor 几何 canonicalize 成 Contract 规定的
单一中间空间事实，供 L4 等 Consumer 通过 ``side_of(token)`` 取得 Party side。

职责边界（Facade，不是新的 AnchorDetector）：
    * 不负责 OCR / anchor 搜索 / candidate ranking / ``is_full_electric`` /
      ``gap <= 1`` / 字段内容识别 / fallback routing。
    * 只消费调用方已经找到的 buyer / seller anchor 几何。

设计红线（见 PartyGeometry_Contract_v0.1.md，PG-INV-1~8）：
    * PG-INV-3：``Δcy`` 不参与 Party side 主判定。
    * PG-INV-7：region 互斥（disjoint）；边界点（cx == mid_x）与未落入任一 region
      的 token 一律 ``UNKNOWN``，不得静默用距离补救。
    * PG-INV-8：``side_of`` 是纯几何权威，不读 ``line_index`` / ``candidate`` /
      ``is_full_electric`` 等外部语义。
    * ``UNKNOWN`` 是合法结果；绝不回退 ``Δcy`` / nearest anchor / 默认 Party。
      否则会重新形成一个隐藏的 ``PartySide Resolver #2``，违背 Model B。

本模块仅依赖标准库，与 ``party_extractor`` 无循环依赖。
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional

# ── 常量 ────────────────────────────────────────────────────────────────
COORDINATE_SPACE = "OCRDocument.pixel:origin=top-left,x→right,y→down,axis-aligned"
# cx 相等的容差（像素）。在同一坐标系下 anchor cx 几乎不会恰好相等。
_CX_EPS = 1e-6


class PartySide(str, Enum):
    BUYER = "BUYER"
    SELLER = "SELLER"
    UNKNOWN = "UNKNOWN"


class Orientation(str, Enum):
    LTR = "ltr"
    RTL = "rtl"
    UNKNOWN = "unknown"


class Completeness(str, Enum):
    COMPLETE = "COMPLETE"
    PARTIAL = "PARTIAL"
    ABSENT = "ABSENT"


# ── 数据结构 ──────────────────────────────────────────────────────────────
@dataclass
class PartyAnchor:
    """单一 Party anchor 的最小几何事实（仅用于诊断 / 高阶 Geometry）。"""
    bbox: Optional[dict] = None
    cx: Optional[float] = None
    cy: Optional[float] = None
    source: Optional[str] = None


@dataclass
class PartyRegion:
    """水平分割出的单侧区域（Batch 1 只用 x 边界）。"""
    x_upper: Optional[float] = None  # 左侧 region 的 x 上限（不含）→ 用于 BUYER(LTR)
    x_lower: Optional[float] = None  # 右侧 region 的 x 下限（不含）→ 用于 SELLER(LTR)
    side: PartySide = PartySide.UNKNOWN


@dataclass
class PartyGeometry:
    coordinate_space: str = COORDINATE_SPACE
    completeness: Completeness = Completeness.ABSENT
    orientation: Orientation = Orientation.UNKNOWN
    buyer_anchor: Optional[PartyAnchor] = None
    seller_anchor: Optional[PartyAnchor] = None
    buyer_region: Optional[PartyRegion] = None
    seller_region: Optional[PartyRegion] = None
    mid_x: Optional[float] = None

    def side_of(self, token) -> PartySide:
        """唯一 Party side 语义权威。

        仅依据 token 水平质心 x 与 ``mid_x`` 比较；**绝不**读
        ``cy`` / ``line_index`` / ``candidate`` / ``is_full_electric``。

        返回：
            BUYER / SELLER / UNKNOWN

        ``UNKNOWN`` 触发条件（均为安全语义，不回退）：
            * completeness == ABSENT（anchor 缺失或 anchor 缺 cx）
            * orientation == UNKNOWN（含 buyer.cx == seller.cx，无法可靠定向）
            * token 无可用 cx
            * token 质心恰好落在边界 ``cx == mid_x``（region 互斥，边界点不归属）
        """
        if self.completeness is Completeness.ABSENT:
            return PartySide.UNKNOWN
        if self.orientation is Orientation.UNKNOWN:
            return PartySide.UNKNOWN
        if self.mid_x is None:
            return PartySide.UNKNOWN

        cx = _centroid_x(token)
        if cx is None:
            return PartySide.UNKNOWN

        # region disjoint：严格 < / >，边界点（cx == mid_x）属 UNKNOWN
        if cx < self.mid_x:
            return PartySide.BUYER if self.orientation is Orientation.LTR else PartySide.SELLER
        if cx > self.mid_x:
            return PartySide.SELLER if self.orientation is Orientation.LTR else PartySide.BUYER
        return PartySide.UNKNOWN


# ── 构造（Canonicalizer）──────────────────────────────────────────────────
def build_party_geometry(buyer_anchor, seller_anchor) -> PartyGeometry:
    """把已有的 buyer / seller anchor 几何 canonicalize 成 ``PartyGeometry``。

    Args:
        buyer_anchor: 带 ``.cx``（或 bbox.x0/x1）的 anchor 对象；可为 None。
        seller_anchor: 同上；可为 None。

    Returns:
        PartyGeometry。其 ``side_of`` 在可定向时给出 BUYER/SELLER，
        不可定向时给出 UNKNOWN（绝不回退其它 resolver）。
    """
    b_cx = _centroid_x(buyer_anchor)
    s_cx = _centroid_x(seller_anchor)
    b_cy = _centroid_y(buyer_anchor)
    s_cy = _centroid_y(seller_anchor)

    buyer = _to_party_anchor(buyer_anchor)
    seller = _to_party_anchor(seller_anchor)

    # ABSENT：缺任一 anchor 或任一 anchor 缺可用 cx
    if b_cx is None or s_cx is None:
        return PartyGeometry(
            completeness=Completeness.ABSENT,
            orientation=Orientation.UNKNOWN,
            buyer_anchor=buyer,
            seller_anchor=seller,
        )

    # buyer.cx == seller.cx → 无法构造可靠水平方向（含 P0 票的 cy 相等无关，
    # 此处只看 cx）。标记为 PARTIAL（几何存在但方向不可靠），orientation=unknown。
    if abs(b_cx - s_cx) < _CX_EPS:
        return PartyGeometry(
            completeness=Completeness.PARTIAL,
            orientation=Orientation.UNKNOWN,
            buyer_anchor=buyer,
            seller_anchor=seller,
        )

    mid_x = (b_cx + s_cx) / 2.0
    orientation = Orientation.LTR if b_cx < s_cx else Orientation.RTL
    return PartyGeometry(
        completeness=Completeness.COMPLETE,
        orientation=orientation,
        buyer_anchor=buyer,
        seller_anchor=seller,
        buyer_region=PartyRegion(x_upper=mid_x, side=PartySide.BUYER),
        seller_region=PartyRegion(x_lower=mid_x, side=PartySide.SELLER),
        mid_x=mid_x,
    )


# ── 内部 helper ──────────────────────────────────────────────────────────
def _centroid_x(obj) -> Optional[float]:
    """水平质心 x。优先用 ``.cx``，回退到 bbox 中心。"""
    if obj is None:
        return None
    cx = getattr(obj, 'cx', None)
    if cx is not None:
        try:
            return float(cx)
        except (TypeError, ValueError):
            pass
    x0 = getattr(obj, 'x0', None)
    x1 = getattr(obj, 'x1', None)
    if x0 is not None and x1 is not None:
        try:
            return (float(x0) + float(x1)) / 2.0
        except (TypeError, ValueError):
            return None
    return None


def _centroid_y(obj) -> Optional[float]:
    """垂直质心 y（仅用于诊断 completeness，不参与 side_of）。"""
    if obj is None:
        return None
    cy = getattr(obj, 'cy', None)
    if cy is not None:
        try:
            return float(cy)
        except (TypeError, ValueError):
            pass
    y0 = getattr(obj, 'y0', None)
    y1 = getattr(obj, 'y1', None)
    if y0 is not None and y1 is not None:
        try:
            return (float(y0) + float(y1)) / 2.0
        except (TypeError, ValueError):
            return None
    return None


def _to_party_anchor(obj) -> Optional[PartyAnchor]:
    if obj is None:
        return None
    return PartyAnchor(
        bbox=getattr(obj, 'bbox', None),
        cx=getattr(obj, 'cx', None),
        cy=getattr(obj, 'cy', None),
        source=getattr(obj, 'source', None),
    )
