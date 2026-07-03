"""
区域构建策略（Strategy Pattern）

从 party_extractor._build_regions 提取的 6 种区域分割策略：
- HorizontalSplitStrategy: 同行水平分割（左右布局 / 全电发票）
- DiagonalSplitStrategy:   对角线布局分割
- VerticalSplitStrategy:   异行垂直分割（上下布局）
- BuyerAnchorOnlyStrategy: 仅购买方锚点
- SellerAnchorOnlyStrategy: 仅销售方锚点
- HeuristicFallbackStrategy: 无锚点启发式回退

工厂函数：
- select_region_strategy(ba, sa, bounds) → 策略类
"""
import logging
logger = logging.getLogger(__name__)
from dataclasses import dataclass
from typing import Any, List, Optional, Tuple

from .party_constants import (
    ANCHOR_TOP_MARGIN,
    BUYER_ANCHORS,
    NAME_LABELS,
    REGION_SPLIT_Y_RATIO,
    REGION_SPLIT_Y_THRESHOLD,
    SELLER_ANCHORS,
    TAX_LABELS,
)

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════
# Token 几何辅助函数（模块内私有）
# ═══════════════════════════════════════════════════════════

def _get_token_attr(t: Any, key: str, default=None):
    if isinstance(t, dict):
        return t.get(key, default)
    return getattr(t, key, default)


def _token_text(t: Any) -> str:
    if isinstance(t, dict):
        return t.get('text', '').strip()
    return getattr(t, 'text', '').strip()


def _cx(t: Any) -> float:
    if isinstance(t, dict):
        x0, x1 = t.get('x0', 0), t.get('x1', 0)
    else:
        x0, x1 = getattr(t, 'x0', 0), getattr(t, 'x1', 0)
    return (x0 + x1) / 2


def _cy(t: Any) -> float:
    if isinstance(t, dict):
        y0, y1 = t.get('y0', 0), t.get('y1', 0)
    else:
        y0, y1 = getattr(t, 'y0', 0), getattr(t, 'y1', 0)
    return (y0 + y1) / 2


def _h(t: Any) -> float:
    if isinstance(t, dict):
        y0, y1 = t.get('y0', 0), t.get('y1', 0)
    else:
        y0, y1 = getattr(t, 'y0', 0), getattr(t, 'y1', 0)
    return max(y1 - y0, 5)


def _y_bottom(line_y: Optional[float], footer_y: Optional[float], py1: float) -> float:
    """计算区域底部 y 坐标"""
    if line_y is not None:
        return line_y
    if footer_y is not None:
        return footer_y
    return py1


def _anchor_y0(anchor: Any) -> float:
    """获取锚点的 y0 坐标（token 属性优先，否则 cy - margin）"""
    return _get_token_attr(anchor, 'y0', _cy(anchor) - ANCHOR_TOP_MARGIN)


# ═══════════════════════════════════════════════════════════
# Bounds: 页面边界参数
# ═══════════════════════════════════════════════════════════

@dataclass(frozen=True)
class Bounds:
    """页面边界参数（传递给所有策略）"""
    px0: float
    py0: float
    px1: float
    py1: float
    line_y: Optional[float] = None
    footer_y: Optional[float] = None


# ═══════════════════════════════════════════════════════════
# 策略类
# ═══════════════════════════════════════════════════════════

class HorizontalSplitStrategy:
    """
    同行水平分割（全电发票左右布局）

    适用场景：
    - x_separation > 0.3（左右布局）
    - cy_diff < y_threshold（同行）

    分割方式：按页面 x 轴中线分割，各自区域使用独立 y 范围
    """

    @staticmethod
    def build(tokens, ba, sa, bounds: Bounds):
        page_mid_x = (bounds.px0 + bounds.px1) / 2
        is_buyer_left = _cx(ba) < _cx(sa)

        # x 范围：购买方占一侧，销售方占另一侧
        if is_buyer_left:
            b_x0, b_x1 = bounds.px0, page_mid_x
            s_x0, s_x1 = page_mid_x, bounds.px1
        else:
            b_x0, b_x1 = page_mid_x, bounds.px1
            s_x0, s_x1 = bounds.px0, page_mid_x

        # y 范围：只截取"购买方信息"锚点本行（y0~y1），下方区域不捕获
        b_y0 = _anchor_y0(ba)
        s_y0 = b_y0
        y_bot = _get_token_attr(ba, 'y1', _cy(ba) + _h(ba))

        buyer_region = [
            t for t in tokens
            if b_x0 <= _cx(t) <= b_x1
            and b_y0 <= _cy(t) <= y_bot
            and _token_text(t)
        ]
        seller_region = [
            t for t in tokens
            if s_x0 <= _cx(t) <= s_x1
            and s_y0 <= _cy(t) <= y_bot
            and _token_text(t)
        ]

        region_debug = {
            'strategy': 'horizontal_same_row',
            'page_mid_x': page_mid_x,
            'is_buyer_left': is_buyer_left,
            'b_y0': b_y0,
            's_y0': s_y0,
            'y_bottom': y_bot,
            'ba_cx': _cx(ba),
            'sa_cx': _cx(sa),
            'ba_cy': _cy(ba),
            'sa_cy': _cy(sa),
            'buyer_token_count': len(buyer_region),
            'seller_token_count': len(seller_region),
        }

        # ── INFO 日志：水平分割决策与结果 ──
        logger.info("[HorizontalSplit] 分割: mid_x=%.1f buyer_left=%s "
                     "ba_cx=%.1f sa_cx=%.1f ba_cy=%.1f sa_cy=%.1f",
                     page_mid_x, is_buyer_left,
                     _cx(ba), _cx(sa), _cy(ba), _cy(sa))
        logger.info("[HorizontalSplit] y范围: b_y0=%.1f s_y0=%.1f y_bot=%.1f",
                     b_y0, s_y0, y_bot)
        logger.info("[HorizontalSplit] 结果: 购买方%d个token 销售方%d个token "
                     "x范围=[%.0f~%.0f], [%.0f~%.0f]",
                     len(buyer_region), len(seller_region),
                     b_x0, b_x1, s_x0, s_x1)
        if buyer_region:
            samples = [_token_text(t)[:15] for t in buyer_region[:5]]
            logger.info("[HorizontalSplit] 购买方前5token: %s", samples)
            all_buyer = [_token_text(t)[:20] for t in buyer_region]
            logger.info("[HorizontalSplit] 购买方全部token(%d): %s",
                        len(all_buyer), all_buyer)
        if seller_region:
            samples = [_token_text(t)[:15] for t in seller_region[:5]]
            logger.info("[HorizontalSplit] 销售方前5token: %s", samples)
            all_seller = [_token_text(t)[:20] for t in seller_region]
            logger.info("[HorizontalSplit] 销售方全部token(%d): %s",
                        len(all_seller), all_seller)
        return buyer_region, seller_region, region_debug


class DiagonalSplitStrategy:
    """
    对角线布局分割

    适用场景：cy_diff >= y_threshold 且 x_separation > 0.15
    （锚点 y 有差异但 x 也分离）

    分割方式：按 x 先分，再在各自区域内按 y 微调
    """

    @staticmethod
    def build(tokens, ba, sa, bounds: Bounds):
        page_mid_x = (bounds.px0 + bounds.px1) / 2
        is_buyer_left = _cx(ba) < _cx(sa)

        # x 范围
        if is_buyer_left:
            b_x0, b_x1 = bounds.px0, page_mid_x
            s_x0, s_x1 = page_mid_x, bounds.px1
        else:
            b_x0, b_x1 = page_mid_x, bounds.px1
            s_x0, s_x1 = bounds.px0, page_mid_x

        # y 范围：各区域独立
        b_y0 = _cy(ba) - ANCHOR_TOP_MARGIN
        s_y0 = _cy(sa) - ANCHOR_TOP_MARGIN
        y_bot = _y_bottom(bounds.line_y, bounds.footer_y, bounds.py1)

        buyer_region = [
            t for t in tokens
            if b_x0 <= _cx(t) <= b_x1
            and b_y0 <= _cy(t) <= y_bot
            and _token_text(t)
        ]
        seller_region = [
            t for t in tokens
            if s_x0 <= _cx(t) <= s_x1
            and s_y0 <= _cy(t) <= y_bot
            and _token_text(t)
        ]

        region_debug = {
            'strategy': 'diagonal_split',
            'page_mid_x': page_mid_x,
            'is_buyer_left': is_buyer_left,
            'b_y0': b_y0,
            's_y0': s_y0,
            'y_bottom': y_bot,
            'ba_cx': _cx(ba),
            'sa_cx': _cx(sa),
            'ba_cy': _cy(ba),
            'sa_cy': _cy(sa),
            'buyer_token_count': len(buyer_region),
            'seller_token_count': len(seller_region),
        }
        return buyer_region, seller_region, region_debug


class VerticalSplitStrategy:
    """
    异行垂直分割（上下布局）

    适用场景：cy_diff >= y_threshold 且 x_separation <= 0.15
    （锚点水平位置接近，垂直方向分离）

    分割方式：按 ba/sa 中点 y 分割
    """

    @staticmethod
    def build(tokens, ba, sa, bounds: Bounds):
        split_y = (_cy(ba) + _cy(sa)) / 2
        is_buyer_above = _cy(ba) < _cy(sa)

        b_y0, b_y1 = (bounds.py0, split_y) if is_buyer_above else (split_y, bounds.py1)
        s_y0, s_y1 = (split_y, bounds.py1) if is_buyer_above else (bounds.py0, split_y)
        b_y0 = max(b_y0, _cy(ba) - ANCHOR_TOP_MARGIN)
        s_y0 = max(s_y0, _cy(sa) - ANCHOR_TOP_MARGIN)

        buyer_region = [
            t for t in tokens
            if b_y0 <= _cy(t) <= b_y1
            and _token_text(t)
        ]
        seller_region = [
            t for t in tokens
            if s_y0 <= _cy(t) <= s_y1
            and _token_text(t)
        ]

        region_debug = {
            'strategy': 'vertical_split',
            'split_y': split_y,
            'is_buyer_above': is_buyer_above,
            'ba_cy': _cy(ba),
            'sa_cy': _cy(sa),
            'buyer_token_count': len(buyer_region),
            'seller_token_count': len(seller_region),
        }
        return buyer_region, seller_region, region_debug


class BuyerAnchorOnlyStrategy:
    """
    仅购买方锚点

    适用场景：ba 存在但 sa 不存在

    分割方式：
    - buyer_region: cy >= ba.cy - margin 且 cy <= line_y
    - seller_region: cy > line_y（仅当 line_y 存在时）
    """

    @staticmethod
    def build(tokens, ba, _sa, bounds: Bounds):
        y_end = bounds.line_y if bounds.line_y is not None else bounds.py1

        buyer_region = [
            t for t in tokens
            if _cy(t) >= _cy(ba) - ANCHOR_TOP_MARGIN
            and _cy(t) <= y_end
            and _token_text(t)
        ]
        seller_region = [
            t for t in tokens
            if _cy(t) > y_end
            and _token_text(t)
        ] if bounds.line_y is not None else []

        region_debug = {
            'strategy': 'buyer_anchor_only',
            'ba_cy': _cy(ba),
            'y_end': y_end,
            'buyer_token_count': len(buyer_region),
            'seller_token_count': len(seller_region),
        }
        return buyer_region, seller_region, region_debug


class SellerAnchorOnlyStrategy:
    """
    仅销售方锚点

    适用场景：sa 存在但 ba 不存在

    分割方式：
    - seller_region: cy >= sa.cy - margin 且 cy <= footer_y
    - buyer_region: cy < sa.cy - margin
    """

    @staticmethod
    def build(tokens, _ba, sa, bounds: Bounds):
        seller_region = [
            t for t in tokens
            if _cy(t) >= _cy(sa) - ANCHOR_TOP_MARGIN
            and _cy(t) <= (bounds.footer_y if bounds.footer_y is not None else bounds.py1)
            and _token_text(t)
        ]
        buyer_region = [
            t for t in tokens
            if _cy(t) < _cy(sa) - ANCHOR_TOP_MARGIN
            and _token_text(t)
        ]

        region_debug = {
            'strategy': 'seller_anchor_only',
            'sa_cy': _cy(sa),
            'buyer_token_count': len(buyer_region),
            'seller_token_count': len(seller_region),
        }
        return buyer_region, seller_region, region_debug


class HeuristicFallbackStrategy:
    """
    无锚点启发式回退

    适用场景：ba 和 sa 均不存在

    策略优先级：
    1. 找到两个"名称"标签 → 按上下位置分割
    2. 找到两个"税号"标签 → 按上下位置分割
    3. 一个"名称" + 一个"税号" → 推断区域边界
    4. 兜底 → 按页面中线分割（标准发票：购买方在上，销售方在下）
    5. 最终兜底 → 所有 token 归为 buyer
    """

    @staticmethod
    def build(tokens, _ba, _sa, bounds: Bounds):
        all_tokens = [t for t in tokens if _token_text(t)]
        if not all_tokens:
            return [], [], {'strategy': 'heuristic_fallback'}

        # 收集标签 token
        name_labels = []
        tax_labels = []
        for t in all_tokens:
            text = _token_text(t).strip()
            if text in NAME_LABELS:
                name_labels.append(t)
            elif text in TAX_LABELS:
                tax_labels.append(t)

        # 策略1：两个"名称"标签 → 按上下位置分割
        if len(name_labels) >= 2:
            name_labels.sort(key=lambda t: _cy(t))
            upper, lower = name_labels[0], name_labels[1]
            split_y = (_cy(upper) + _cy(lower)) / 2
            buyer_region = [t for t in all_tokens if _cy(t) <= split_y]
            seller_region = [t for t in all_tokens if _cy(t) > split_y]
            return buyer_region, seller_region, {
                'strategy': 'heuristic_name_labels',
                'split_y': split_y,
            }

        # 策略2：两个"税号"标签 → 按上下位置分割
        if len(tax_labels) >= 2:
            tax_labels.sort(key=lambda t: _cy(t))
            upper, lower = tax_labels[0], tax_labels[1]
            split_y = (_cy(upper) + _cy(lower)) / 2
            buyer_region = [t for t in all_tokens if _cy(t) <= split_y]
            seller_region = [t for t in all_tokens if _cy(t) > split_y]
            return buyer_region, seller_region, {
                'strategy': 'heuristic_tax_labels',
                'split_y': split_y,
            }

        # 策略3：一个"名称" + 一个"税号" → 推断区域边界
        if name_labels and tax_labels:
            name_labels.sort(key=lambda t: _cy(t))
            tax_labels.sort(key=lambda t: _cy(t))
            name_y = _cy(name_labels[0])
            tax_y = _cy(tax_labels[0])
            if abs(name_y - tax_y) < 60:
                # 名称和税号在同一区域，按页面中线分割
                mid_y = (bounds.py0 + bounds.py1) / 2
                buyer_region = [t for t in all_tokens if _cy(t) <= mid_y]
                seller_region = [t for t in all_tokens if _cy(t) > mid_y]
                return buyer_region, seller_region, {
                    'strategy': 'heuristic_name_tax_combined',
                    'mid_y': mid_y,
                }

        # 策略4：兜底 → 按页面中线分割
        mid_y = (bounds.py0 + bounds.py1) / 2
        buyer_region = [t for t in all_tokens if _cy(t) <= mid_y]
        seller_region = [t for t in all_tokens if _cy(t) > mid_y]
        if buyer_region and seller_region:
            return buyer_region, seller_region, {
                'strategy': 'heuristic_mid_page',
                'mid_y': mid_y,
            }

        # 最终兜底：所有 token 归为 buyer
        return all_tokens, [], {'strategy': 'heuristic_fallback'}


# ═══════════════════════════════════════════════════════════
# 工厂函数
# ═══════════════════════════════════════════════════════════

def select_region_strategy(ba, sa, bounds: Bounds, ndx: float, cy_diff: float):
    """
    根据锚点位置和几何特征选择区域分割策略

    Args:
        ba: 购买方锚点（可能为 None）
        sa: 销售方锚点（可能为 None）
        bounds: 页面边界
        ndx: 归一化 x 分离度 (0~1)
        cy_diff: ba 和 sa 的 y 坐标差值

    Returns:
        策略类（非实例），具有 build(tokens, ba, sa, bounds) 静态方法
    """
    # 单锚点情况
    if ba and not sa:
        return BuyerAnchorOnlyStrategy
    if sa and not ba:
        return SellerAnchorOnlyStrategy
    if not ba and not sa:
        return HeuristicFallbackStrategy

    # 双锚点：根据几何特征选择策略
    page_height = bounds.py1 - bounds.py0
    y_threshold = min(REGION_SPLIT_Y_THRESHOLD, page_height * REGION_SPLIT_Y_RATIO)
    x_separation = ndx  # ndx 已经是归一化的 x 分离度

    if x_separation > 0.3:
        # 左右布局，按 x 轴中线分割
        return HorizontalSplitStrategy
    elif cy_diff >= y_threshold:
        # y 有差异，检查 x 分离度
        if ndx <= 0.15:
            # 锚点水平位置接近，用垂直分割
            return VerticalSplitStrategy
        else:
            # 锚点 y 有差异但 x 也分离 → 对角线布局
            return DiagonalSplitStrategy
    else:
        # y 接近，用水平分割
        return HorizontalSplitStrategy
