"""
锚点检测器（AnchorDetector）

从 party_extractor._find_anchors 提取的独立模块，包含：
- AnchorDiagnostics — 诊断信息容器（记录被拒绝/临近的候选锚点）
- AnchorDetector    — 锚点检测主类（标准匹配 + 竖排回退 + 冲突解决）

设计原则：
- 诊断信息独立为 AnchorDiagnostics 对象，不再嵌入 ExtractionContext
- 通过参数注入常量（BUYER_ANCHORS, SELLER_ANCHORS 等），不硬编码
- 仅依赖 party_constants、region_strategies（辅助函数）和标准库
"""
import logging
from dataclasses import dataclass, field
from typing import Any, List, Optional, Tuple

from ..models import Token
from .party_constants import (
    BUYER_ANCHORS,
    COMPANY_SUFFIX_LIST,
    SELLER_ANCHORS,
)
from .region_strategies import (
    _cx,
    _cy,
    _get_token_attr,
)

logger = logging.getLogger(__name__)

# 复用 party_extractor 中的 _fuzzy_match 函数
# 为避免循环导入，在此处定义简化版本
_FUZZY_MATCH_MIN_RATIO = 0.7


def _fuzzy_match(text: str, keywords: list, min_ratio: float = _FUZZY_MATCH_MIN_RATIO) -> Optional[str]:
    """模糊匹配关键词（与 party_extractor._fuzzy_match 同逻辑）"""
    tc = text.replace(' ', '').replace('\u3000', '')

    # 快速路径：精确子串匹配
    for kw in keywords:
        if kw in tc:
            return kw

    # 交叉过滤：seller/buyer 互斥关键词剔除
    if '销售' in tc or '销方' in tc:
        buyer_exclusive = {'购买方', '购方信息', '购买方信息'}
        keywords = [k for k in keywords if k not in buyer_exclusive]

    if '购买' in tc or '购方' in tc:
        seller_exclusive = {'销售方', '销方信息', '销售方信息'}
        keywords = [k for k in keywords if k not in seller_exclusive]

    # 覆盖率计算
    tc_set = set(tc)
    for kw in keywords:
        if len(tc) < len(kw) - 1:
            continue
        kw_chars = set(kw)
        if len(kw_chars & tc_set) < len(kw) * 0.5:
            continue
        coverage = sum(1 for c in kw if c in tc_set) / len(kw)
        if coverage >= min_ratio:
            return kw

    return None


# ═══════════════════════════════════════════════════════════
# AnchorDiagnostics — 诊断信息容器
# ═══════════════════════════════════════════════════════════

@dataclass
class AnchorDiagnostics:
    """
    锚点检测诊断信息

    记录每个潜在锚点被拒绝的原因，用于调试和分析。
    """
    buyer_rejected: List[dict] = field(default_factory=list)
    seller_rejected: List[dict] = field(default_factory=list)
    buyer_near: List[dict] = field(default_factory=list)
    line_y_filter: Optional[float] = None

    # 最终结果
    ba_found: bool = False
    sa_found: bool = False
    ba_text: str = ''
    ba_cx: float = 0.0
    ba_cy: float = 0.0
    sa_text: str = ''
    sa_cx: float = 0.0
    sa_cy: float = 0.0

    def to_dict(self) -> dict:
        """转换为字典（兼容旧接口）"""
        return {
            'buyer_rejected': self.buyer_rejected,
            'seller_rejected': self.seller_rejected,
            'buyer_near': self.buyer_near,
            'line_y_filter': self.line_y_filter,
            'ba_found': self.ba_found,
            'sa_found': self.sa_found,
            'ba_text': self.ba_text,
            'ba_cx': self.ba_cx,
            'ba_cy': self.ba_cy,
            'sa_text': self.sa_text,
            'sa_cx': self.sa_cx,
            'sa_cy': self.sa_cy,
        }


# ═══════════════════════════════════════════════════════════
# AnchorDetector — 锚点检测主类
# ═══════════════════════════════════════════════════════════

class AnchorDetector:
    """
    锚点检测器

    检测文档中的购买方和销售方锚点 token。

    流程：
    1. 标准匹配：遍历 tokens，用 _fuzzy_match 匹配 buyer/seller 关键词
    2. 竖排回退：单字 token 拼接后重试匹配
    3. 冲突解决：处理 ba == sa 的情况（OCR 合并 token）

    用法:
        detector = AnchorDetector(line_y=ctx.line_item_y)
        ba, sa = detector.detect(tokens)
        diag = detector.diagnostics  # 获取诊断信息
    """

    def __init__(
        self,
        line_y: Optional[float] = None,
        footer_y: Optional[float] = None,
        *,
        buyer_anchors: tuple = BUYER_ANCHORS,
        seller_anchors: tuple = SELLER_ANCHORS,
        company_suffix_list: tuple = COMPANY_SUFFIX_LIST,
    ):
        self.line_y = line_y
        self.footer_y = footer_y
        self.buyer_anchors = buyer_anchors
        self.seller_anchors = seller_anchors
        self.company_suffix_list = company_suffix_list
        self.diagnostics = AnchorDiagnostics(line_y_filter=line_y)

    def detect(self, tokens) -> Tuple[Optional[Any], Optional[Any]]:
        """
        检测购买方和销售方锚点

        Args:
            tokens: OCR token 列表

        Returns:
            (buyer_anchor, seller_anchor) — 可能为 None
        """
        buyer_candidates = []
        seller_candidates = []

        # ── 阶段1：标准匹配 ──
        buyer_candidates, seller_candidates = self._standard_match(tokens)

        # ── 阶段2：竖排回退 ──
        if not buyer_candidates or not seller_candidates:
            v_buyer, v_seller = self._vertical_fallback(tokens)
            if not buyer_candidates:
                buyer_candidates = v_buyer
            if not seller_candidates:
                seller_candidates = v_seller

        # ── 阶段3：选择最佳候选 ──
        ba = max(buyer_candidates, key=lambda x: (x[0], x[1]))[2] if buyer_candidates else None
        sa = max(seller_candidates, key=lambda x: (x[0], x[1]))[2] if seller_candidates else None

        # ── 阶段4：冲突解决 ──
        ba, sa = self._resolve_conflict(ba, sa, buyer_candidates, seller_candidates)

        # ── 记录诊断结果 ──
        self._record_diagnostics(ba, sa)

        return ba, sa

    def _standard_match(self, tokens) -> Tuple[list, list]:
        """标准匹配：遍历 tokens，用 _fuzzy_match 匹配锚点
        优先选长文本匹配（PyMuPDF 完整词优先于 OCR 单字）"""
        buyer_candidates = []
        seller_candidates = []

        for t in tokens:
            text = _get_token_attr(t, 'text', '').strip()
            if not text:
                continue

            # 探针：记录所有含"购"字的 token
            if '购' in text:
                cy_val = _cy(t)
                filtered = self.line_y is not None and cy_val > self.line_y + 20
                logger.info("[ANCHOR_PROBE] 购字token: text='%s' cy=%.1f y0=%.1f y1=%.1f %s",
                            text[:30], cy_val,
                            _get_token_attr(t, 'y0', 0),
                            _get_token_attr(t, 'y1', 0),
                            '← 被line_y过滤' if filtered else '')

            # line_y 过滤
            if self.line_y is not None and _cy(t) > self.line_y + 20:
                tc_filtered = text.replace(' ', '').replace('\u3000', '')
                if any(k in tc_filtered for k in ['购买', '购方', '销售', '销方']):
                    self.diagnostics.buyer_rejected.append({
                        'text': text[:30], 'reason': 'line_y_filtered',
                        'cy': round(_cy(t), 1), 'line_y': round(self.line_y, 1)
                    })
                continue

            tc = text.replace(' ', '').replace('\u3000', '')

            # Buyer 匹配
            buyer_match = _fuzzy_match(text, self.buyer_anchors)
            if buyer_match:
                tc_len = len(tc)
                kw_len = len(buyer_match)
                if tc_len > kw_len * 1.5:
                    has_suffix = any(s in tc for s in self.company_suffix_list)
                    starts_with_kw = tc.startswith(buyer_match)
                    if not has_suffix and not starts_with_kw:
                        self.diagnostics.buyer_rejected.append({
                            'text': text[:30], 'reason': 'text_too_long',
                            'match': buyer_match,
                            'len_text': tc_len, 'limit': kw_len * 1.5
                        })
                        continue
                # 以原文本长度为优先得分（PyMuPDF 完整词 5字 > OCR 单字 1字）
                trust_score = len(tc)
                if text in self.buyer_anchors:
                    trust_score += 10
                w = _get_token_attr(t, 'x1', 0) - _get_token_attr(t, 'x0', 0)
                h = _get_token_attr(t, 'y1', 0) - _get_token_attr(t, 'y0', 0)
                if h > w * 2:
                    trust_score += 5
                buyer_candidates.append((trust_score, len(buyer_match), t))
            else:
                # 未匹配 buyer anchor，但文本含"购"字
                tc = text.replace(' ', '').replace('\u3000', '')
                if '购' in tc and len(tc) <= 15 and len(self.diagnostics.buyer_near) < 5:
                    self.diagnostics.buyer_near.append({
                        'text': text[:30], 'cy': round(_cy(t), 1)
                    })

            # Seller 匹配
            seller_match = _fuzzy_match(text, self.seller_anchors)
            # 合并 token 兜底：绕过交叉过滤
            if buyer_match and not seller_match:
                tc_len = len(tc)
                kw_len = len(buyer_match)
                if tc_len > kw_len * 1.5:
                    for skw in self.seller_anchors:
                        if skw in tc:
                            seller_match = skw
                            break
            if seller_match:
                tc_len = len(tc)
                kw_len = len(seller_match)
                if tc_len > kw_len * 1.5:
                    has_suffix = any(s in tc for s in self.company_suffix_list)
                    starts_with_kw = tc.startswith(seller_match)
                    has_both = bool(buyer_match) and any(skw in tc for skw in self.seller_anchors)
                    if not has_suffix and not starts_with_kw and not has_both:
                        self.diagnostics.seller_rejected.append({
                            'text': text[:30], 'reason': 'text_too_long',
                            'match': seller_match,
                        })
                        continue
                trust_score = len(tc)
                if text in self.seller_anchors:
                    trust_score += 10
                w = _get_token_attr(t, 'x1', 0) - _get_token_attr(t, 'x0', 0)
                h = _get_token_attr(t, 'y1', 0) - _get_token_attr(t, 'y0', 0)
                if h > w * 2:
                    trust_score += 5
                seller_candidates.append((trust_score, len(seller_match), t))

        # 过滤单字碎片：仅保留长度 > 1 的 token，让 _vertical_fallback 拼接完整词
        # 除非无多字匹配，才用单字兜底
        def _keep_multi(c):
            return len(_get_token_attr(c[2], 'text', '').strip()) > 1
        b_multi = [c for c in buyer_candidates if _keep_multi(c)]
        s_multi = [c for c in seller_candidates if _keep_multi(c)]
        return b_multi or buyer_candidates, s_multi or seller_candidates

    def _vertical_fallback(self, tokens) -> Tuple[list, list]:
        """竖排回退：单字 token 拼接后重试匹配"""
        buyer_candidates = []
        seller_candidates = []

        # 收集单字中文字符 token
        single_chars = []
        for t in tokens:
            text = _get_token_attr(t, 'text', '').strip()
            if self.line_y is not None and _cy(t) > self.line_y + 20:
                continue
            if len(text) == 1 and '\u4e00' <= text <= '\u9fff':
                single_chars.append(t)

        if not single_chars:
            return buyer_candidates, seller_candidates

        # 按 x 坐标分组
        x_tol = 15
        col_groups = {}
        for t in single_chars:
            cx = _cx(t)
            matched_key = None
            for key in col_groups:
                if abs(cx - key) < x_tol:
                    matched_key = key
                    break
            if matched_key is not None:
                col_groups[matched_key].append(t)
            else:
                col_groups[cx] = [t]

        # 拼接每列字符并尝试匹配
        for col_cx, group in col_groups.items():
            if len(group) < 2:
                continue
            group.sort(key=lambda t: _cy(t))
            combined = ''.join(_get_token_attr(t, 'text', '') for t in group)
            combined_nospace = combined.replace(' ', '').replace('\u3000', '')

            if not buyer_candidates:
                bm = _fuzzy_match(combined_nospace, self.buyer_anchors)
                if bm:
                    x0 = min(_get_token_attr(t, 'x0', 0) for t in group)
                    y0 = min(_get_token_attr(t, 'y0', 0) for t in group)
                    x1 = max(_get_token_attr(t, 'x1', 0) for t in group)
                    y1 = max(_get_token_attr(t, 'y1', 0) for t in group)
                    synth = Token(text=combined_nospace, x0=x0, y0=y0, x1=x1, y1=y1, page=0, confidence=1.0)
                    trust = len(bm) + 10
                    buyer_candidates.append((trust, len(bm), synth))
                    logger.info("[VERTICAL_FALLBACK] buyer: '%s' → match '%s'", combined_nospace[:20], bm)

            if not seller_candidates:
                sm = _fuzzy_match(combined_nospace, self.seller_anchors)
                if sm:
                    x0 = min(_get_token_attr(t, 'x0', 0) for t in group)
                    y0 = min(_get_token_attr(t, 'y0', 0) for t in group)
                    x1 = max(_get_token_attr(t, 'x1', 0) for t in group)
                    y1 = max(_get_token_attr(t, 'y1', 0) for t in group)
                    synth = Token(text=combined_nospace, x0=x0, y0=y0, x1=x1, y1=y1, page=0, confidence=1.0)
                    trust = len(sm) + 10
                    seller_candidates.append((trust, len(sm), synth))
                    logger.info("[VERTICAL_FALLBACK] seller: '%s' → match '%s'", combined_nospace[:20], sm)

        return buyer_candidates, seller_candidates

    def _resolve_conflict(
        self,
        ba: Optional[Any],
        sa: Optional[Any],
        buyer_candidates: list,
        seller_candidates: list,
    ) -> Tuple[Optional[Any], Optional[Any]]:
        """
        冲突解决：当 ba 和 sa 是同一个 token 时，找不同的配对

        全电发票横向布局中，OCR 可能将"购买方信息"和"销售方信息"
        合并为单个 token，导致 ba=sa。
        """
        if ba is None or sa is None or ba is not sa:
            return ba, sa

        best_pair = None
        best_score = -1
        for bc in buyer_candidates:
            for sc in seller_candidates:
                if bc[2] is not sc[2]:
                    pair_score = bc[0] + sc[0]
                    if pair_score > best_score:
                        best_score = pair_score
                        best_pair = (bc[2], sc[2])
        if best_pair:
            return best_pair

        return ba, sa

    def _record_diagnostics(self, ba: Optional[Any], sa: Optional[Any]) -> None:
        """记录最终诊断结果"""
        self.diagnostics.ba_found = ba is not None
        self.diagnostics.sa_found = sa is not None
        if ba:
            self.diagnostics.ba_text = _get_token_attr(ba, 'text', '').strip()[:30]
            self.diagnostics.ba_cx = round(_cx(ba), 1)
            self.diagnostics.ba_cy = round(_cy(ba), 1)
        if sa:
            self.diagnostics.sa_text = _get_token_attr(sa, 'text', '').strip()[:30]
            self.diagnostics.sa_cx = round(_cx(sa), 1)
            self.diagnostics.sa_cy = round(_cy(sa), 1)
