"""PartyGeometry —— 统一 Party 空间事实层（Contract v0.1 / 轨道 A Batch 1 + Step 6 Vertical 扩展）。

本模块是 Model B（Facade / Canonicalizer + 渐进 Consumer Migration）的第一个
可复用构件。它**只**把已有的 Party anchor 几何 canonicalize 成 Contract 规定的
单一中间空间事实，供 L4 等 Consumer 通过 ``side_of(token)`` 取得 Party side。

职责边界（Facade，不是新的 AnchorDetector）：
    * 不负责 OCR / anchor 搜索 / candidate ranking / ``is_full_electric`` /
      ``gap <= 1`` / 字段内容识别 / fallback routing。
    * 只消费调用方已经找到的 buyer / seller anchor 几何。

设计红线（见 PartyGeometry_Contract_v0.1.md，PG-INV-1~8）：
    * PG-INV-3：``Δcy`` 不参与 Party side 主判定。
    * PG-INV-7：region 互斥（disjoint）；边界点一律 ``UNKNOWN``，不得静默用距离补救。
    * PG-INV-8：``side_of`` 是纯几何权威，不读 ``line_index`` / ``candidate`` /
      ``is_full_electric`` 等外部语义。
    * ``UNKNOWN`` 是合法结果；绝不回退 ``Δcy`` / nearest anchor / 默认 Party。

Step 6 Vertical 扩展（2026-08-16 授权实施）：
    * 原 00871971 只有 HORIZONTAL（mid_x / cx，LTR/RTL）。near-stacked（|Δcx| 很小非 0）
      或 exact-stacked（cx 相等）会被判 UNKNOWN → 合法候选全 dropped（完整性回归）。
    * 新增 VERTICAL（mid_y / cy）：当 anchor cx 近/相等但 cy 清晰分离时，按 cy 相对
      mid_y 切分；买卖方身份从锚点关键词命中（buyer_anchor / seller_anchor）读取，
      不假设「买方一定在上」。
    * 模糊边界（|token.cy - mid_y| <= _V_FUZZY）→ UNKNOWN（绝不猜）。
    * 两轴均不可靠（cx 近 且 cy 也近 / 缺 cy）→ UNKNOWN。
    * 既有 HORIZONTAL contract（mid_x / cx，LTR/RTL）完全不变。
    * 不引入 Δcy fallback / secondary candidate（那样会重开 dual-emission 污染通道）。

本模块仅依赖标准库，与 ``party_extractor`` 无循环依赖。
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional

# ── 常量 ────────────────────────────────────────────────────────────────
COORDINATE_SPACE = "OCRDocument.pixel:origin=top-left,x→right,y→down,axis-aligned"

# cx 近/相等容差（像素）。anchor cx 在容差内视为「水平不可靠」，改走 VERTICAL。
# 真实失败 PDF：|Δcx|=2.6（near-stacked）→ VERTICAL；清晰横向两栏 |Δcx|≫（如 1689）→ 仍 HORIZONTAL。
_CX_NEAR = 12.0
# VERTICAL 生效所需的最小 cy 分离（像素）。anchor cy 在容差内视为「纵向也不可靠」。
_CY_MIN_SEP = 24.0
# VERTICAL 下 token cy 距 mid_y 的模糊带（像素）。带内 → UNKNOWN（绝不猜）。
_V_FUZZY = 8.0


class PartySide(str, Enum):
    BUYER = "BUYER"
    SELLER = "SELLER"
    UNKNOWN = "UNKNOWN"


class Orientation(str, Enum):
    LTR = "ltr"            # 水平：购买方在左
    RTL = "rtl"            # 水平：购买方在右
    VERTICAL = "vertical"  # 垂直：按 cy 相对 mid_y 切分
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
    """水平分割出的单侧区域（Batch 1 只用 x 边界）。VERTICAL 不依赖 region。"""
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
    # Step 6 Vertical 扩展
    mid_y: Optional[float] = None
    buyer_is_top: Optional[bool] = None

    def side_of(self, token) -> PartySide:
        """唯一 Party side 语义权威。

        HORIZONTAL：仅依据 token 水平质心 x 与 ``mid_x``（既有 contract 不变）。
        VERTICAL：仅依据 token 垂直质心 y 与 ``mid_y``；身份来自锚点关键词命中。

        返回 BUYER / SELLER / UNKNOWN。UNKNOWN 触发条件（均为安全语义，不回退）：
            * completeness == ABSENT
            * orientation == UNKNOWN（含 cx 近且 cy 也近 / 缺 cy）
            * token 无可用质心
            * HORIZONTAL 下 token 质心恰好落在边界 cx == mid_x
            * VERTICAL 下 token cy 落入 mid_y 模糊带
        """
        if self.completeness is Completeness.ABSENT:
            return PartySide.UNKNOWN
        if self.orientation is Orientation.UNKNOWN:
            return PartySide.UNKNOWN

        if self.orientation in (Orientation.LTR, Orientation.RTL):
            # ── HORIZONTAL（既有 contract，不变）──
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

        # ── VERTICAL（Step 6 扩展）──
        if self.mid_y is None or self.buyer_is_top is None:
            return PartySide.UNKNOWN
        ty = _centroid_y(token)
        if ty is None:
            return PartySide.UNKNOWN
        # 模糊边界：|ty - mid_y| <= _V_FUZZY → 绝不猜
        if abs(ty - self.mid_y) <= _V_FUZZY:
            return PartySide.UNKNOWN
        # token 与哪个 anchor 同侧（按 cy 相对 mid_y）；买卖方身份来自锚点，非假设上下
        if ty < self.mid_y:
            return PartySide.BUYER if self.buyer_is_top else PartySide.SELLER
        return PartySide.SELLER if self.buyer_is_top else PartySide.BUYER


# ── 构造（Canonicalizer）──────────────────────────────────────────────────
def build_party_geometry(buyer_anchor, seller_anchor) -> PartyGeometry:
    """把已有的 buyer / seller anchor 几何 canonicalize 成 ``PartyGeometry``。

    Step 6 三态 orientation 分类：
        * HORIZONTAL：anchor cx 清晰分离（|Δcx| > _CX_NEAR）→ mid_x / cx（LTR/RTL），
          既有 contract 完全不变。
        * VERTICAL：anchor cx 近/相等（|Δcx| <= _CX_NEAR）且 cy 清晰分离
          （|Δcy| > _CY_MIN_SEP）→ mid_y / cy；身份读自锚点关键词。
        * UNKNOWN：两轴均不可靠（cx 近 且 cy 近 / 缺 cy）→ 安全 abstain。

    Returns:
        PartyGeometry。可定向时 side_of 给 BUYER/SELLER，不可定向给 UNKNOWN。
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

    dcx = abs(b_cx - s_cx)
    dcy = abs(b_cy - s_cy) if (b_cy is not None and s_cy is not None) else None

    # HORIZONTAL：cx 清晰分离 → 既有 contract 不变（mid_x / cx，LTR/RTL）
    if dcx > _CX_NEAR:
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

    # VERTICAL：cx 近/相等 + cy 清晰分离 → mid_y / cy
    if dcy is not None and dcy > _CY_MIN_SEP:
        mid_y = (b_cy + s_cy) / 2.0
        buyer_is_top = b_cy < s_cy
        return PartyGeometry(
            completeness=Completeness.COMPLETE,
            orientation=Orientation.VERTICAL,
            buyer_anchor=buyer,
            seller_anchor=seller,
            mid_y=mid_y,
            buyer_is_top=buyer_is_top,
        )

    # 两轴均不可靠（cx 近 且 cy 近 / 缺 cy）→ 安全 abstain，绝不猜
    return PartyGeometry(
        completeness=Completeness.PARTIAL,
        orientation=Orientation.UNKNOWN,
        buyer_anchor=buyer,
        seller_anchor=seller,
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
    """垂直质心 y（HORIZONTAL 下不用于 side_of；VERTICAL 下用于 side_of）。"""
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
