"""
提取上下文（ExtractionContext）— 拆分为 3 个专用子上下文

设计原则：
- AnchorContext: 锚点检测相关（buyer_anchor, seller_anchor, anchor_diag）
- RegionContext: 区域构建相关（buyer_region, seller_region, region_debug, line_item_y, footer_y, inv_positions）
- ScoreContext:  评分决策相关（L1/L2 距离参数, structured_line_map, page_height）
- ExtractionContext: 组合 3 个子上下文，保留向后兼容的属性别名

向后兼容：
- 旧代码 `ctx.buyer_anchor` 仍可通过属性别名访问
- 新代码应使用 `ctx.anchor.buyer_anchor` 明确归属
"""
from dataclasses import dataclass, field as dc_field
from typing import Any, Dict, List, Optional


# ═══════════════════════════════════════════════════════════
# 3 个专用子上下文
# ═══════════════════════════════════════════════════════════

@dataclass
class AnchorContext:
    """锚点检测上下文（由 AnchorDetector 写入）"""
    buyer_anchor: Any = None
    seller_anchor: Any = None
    anchor_diag: dict = dc_field(default_factory=dict)


@dataclass
class RegionContext:
    """区域构建上下文（由 RegionBuilder 写入）"""
    buyer_region: list = dc_field(default_factory=list)
    seller_region: list = dc_field(default_factory=list)
    region_debug: dict = dc_field(default_factory=dict)
    line_item_y: Optional[float] = None
    footer_y: Optional[float] = None
    inv_positions: list = dc_field(default_factory=list)


@dataclass
class ScoreContext:
    """评分决策上下文（由 extract() 初始化，评分方法读取）"""
    L1_MAX_RIGHT_DIST: int = 500
    L2_WINDOW_RADIUS: int = 250
    L1_MAX_ROW_DIST: int = 20
    structured_line_map: dict = dc_field(default_factory=dict)
    page_height: float = 0.0
    l4_page_height: float = 0.0


# ═══════════════════════════════════════════════════════════
# 组合上下文（向后兼容）
# ═══════════════════════════════════════════════════════════

@dataclass
class ExtractionContext:
    """
    组合上下文 — 封装单次 extract() 调用的全部中间状态

    包含 3 个子上下文：
    - anchor: AnchorContext（锚点检测）
    - region: RegionContext（区域构建）
    - score:  ScoreContext（评分决策）

    向后兼容：保留所有原始字段作为属性别名，
    旧代码 `ctx.buyer_anchor` 等价于 `ctx.anchor.buyer_anchor`。
    """
    anchor: AnchorContext = dc_field(default_factory=AnchorContext)
    region: RegionContext = dc_field(default_factory=RegionContext)
    score: ScoreContext = dc_field(default_factory=ScoreContext)

    # ── AnchorContext 属性别名 ──
    @property
    def buyer_anchor(self):
        return self.anchor.buyer_anchor

    @buyer_anchor.setter
    def buyer_anchor(self, value):
        self.anchor.buyer_anchor = value

    @property
    def seller_anchor(self):
        return self.anchor.seller_anchor

    @seller_anchor.setter
    def seller_anchor(self, value):
        self.anchor.seller_anchor = value

    @property
    def anchor_diag(self):
        return self.anchor.anchor_diag

    @anchor_diag.setter
    def anchor_diag(self, value):
        self.anchor.anchor_diag = value

    # ── RegionContext 属性别名 ──
    @property
    def buyer_region(self):
        return self.region.buyer_region

    @buyer_region.setter
    def buyer_region(self, value):
        self.region.buyer_region = value

    @property
    def seller_region(self):
        return self.region.seller_region

    @seller_region.setter
    def seller_region(self, value):
        self.region.seller_region = value

    @property
    def region_debug(self):
        return self.region.region_debug

    @region_debug.setter
    def region_debug(self, value):
        self.region.region_debug = value

    @property
    def line_item_y(self):
        return self.region.line_item_y

    @line_item_y.setter
    def line_item_y(self, value):
        self.region.line_item_y = value

    @property
    def footer_y(self):
        return self.region.footer_y

    @footer_y.setter
    def footer_y(self, value):
        self.region.footer_y = value

    @property
    def inv_positions(self):
        return self.region.inv_positions

    @inv_positions.setter
    def inv_positions(self, value):
        self.region.inv_positions = value

    # ── ScoreContext 属性别名 ──
    @property
    def L1_MAX_RIGHT_DIST(self):
        return self.score.L1_MAX_RIGHT_DIST

    @L1_MAX_RIGHT_DIST.setter
    def L1_MAX_RIGHT_DIST(self, value):
        self.score.L1_MAX_RIGHT_DIST = value

    @property
    def L2_WINDOW_RADIUS(self):
        return self.score.L2_WINDOW_RADIUS

    @L2_WINDOW_RADIUS.setter
    def L2_WINDOW_RADIUS(self, value):
        self.score.L2_WINDOW_RADIUS = value

    @property
    def L1_MAX_ROW_DIST(self):
        return self.score.L1_MAX_ROW_DIST

    @L1_MAX_ROW_DIST.setter
    def L1_MAX_ROW_DIST(self, value):
        self.score.L1_MAX_ROW_DIST = value

    @property
    def structured_line_map(self):
        return self.score.structured_line_map

    @structured_line_map.setter
    def structured_line_map(self, value):
        self.score.structured_line_map = value

    @property
    def page_height(self):
        return self.score.page_height

    @page_height.setter
    def page_height(self, value):
        self.score.page_height = value

    @property
    def l4_page_height(self):
        return self.score.l4_page_height

    @l4_page_height.setter
    def l4_page_height(self, value):
        self.score.l4_page_height = value
