# -*- coding: utf-8 -*-
"""
购买方/销售方名称与税号提取器（Candidate-based Pipeline v5）

核心原则：
  1. Candidate Competition — 保留所有候选，按置信度排序，支持追溯
  2. Multi-Layer Evidence — L1(label) → L2(anchor) → L3(region) → L4(text)
     每一层都产生候选，而非补缺
  3. Scoring System — 基于证据类型、格式校验、位置关系综合评分
  4. Conflict Detection — 检测买卖方名称/税号相同、顺序冲突等

输出格式：
  {
    "gmfmc": "xxx", "gmfsh": "xxx", "xsfmc": "xxx", "xsfsh": "xxx",
    "field_meta": {
      "gmfmc": {
        "value": "...",
        "confidence": 0.92,
        "source": "bbox_l1_label",
        "candidates": [...],
        "warnings": []
      }
    }
  }

评分规则：
| 证据 | 加分 |
| --- | --- |
| 与明确标签同行右侧绑定 | +0.25 |
| 位于购买方/销售方锁定区域 | +0.40 |
| 公司名格式合理 | +0.15 |
| 税号格式合法 | +0.20 |
| 名称与税号垂直距离近 | +0.15 |
| 靠近发票号码/机器编号 | -0.30 |
| 落入明细表或备注区 | -0.40 |
| 买卖方名称相同 | conflict |
| 买卖方税号相同 | conflict |

最终规则：
- confidence >= 0.85：自动通过
- 0.60 <= confidence < 0.85：解析成功但需要人工确认
- < 0.60：字段失败，进入 failed_fields
- 存在 conflict：无论置信度多少，都进入人工确认
"""
import re
import math
import logging
from dataclasses import dataclass, field as dc_field
from typing import Optional, List, Dict, Tuple, Any, Union

from ..models import OCRDocument, Region, Token
from ..regex_patterns import _UNIFIED_TAX_RE, _TAX_ID_ONLY_RE
from ..candidates import FieldCandidate
from ..segments import SegmentedDocument
from .party_constants import (
    BUYER_ANCHORS, SELLER_ANCHORS, FOOTER_ANCHORS,
    NAME_LABELS, TAX_LABELS,
    COMPANY_SUFFIX_LIST, COMPANY_PATTERN, COMPANY_PATTERN_NO_SUFFIX,
    POLLUTION_KEYWORDS, INVOICE_ID_KEYWORDS, AMOUNT_DAXIE_KEYWORDS,
    LINE_ITEM_KEYWORDS, REMARK_LINE_KEYWORDS,
    STANDALONE_TAX_ID_RE,
    BASE_SCORE, SCORE_LABEL_BINDING, SCORE_REGION_LOCKED,
    SCORE_COMPANY_FORMAT, SCORE_TAX_FORMAT, SCORE_NEAR_TAX,
    SCORE_NEAR_INV_ID, SCORE_IN_LINE_ITEM, SCORE_GOODS_PENALTY,
    SCORE_L4_LABEL_BIND, SCORE_L4_LABEL_RIGHT, SCORE_L4_ANCHOR_NEAR,
    SCORE_L4_POSITION, SCORE_L4_ORDER,
    CONFIDENCE_AUTO_PASS, CONFIDENCE_NEED_CONFIRM,
    REGION_SPLIT_Y_THRESHOLD, REGION_SPLIT_Y_RATIO,
    LINE_CLUSTER_TOL, FUZZY_MATCH_MIN_RATIO, SIMILARITY_THRESHOLD,
    JACCARD_THRESHOLD, DIGIT_RATIO_THRESHOLD, LABEL_VALUE_RATIO_THRESHOLD,
    ROW_HEIGHT_RATIO, RIGHT_DIST_WEIGHT_DX, RIGHT_DIST_WEIGHT_DY,
    SOURCE_PRIORITY,
    WINDOW_SIZE, FULL_ELECTRIC_MAX_ANCHOR_GAP,
    ANCHOR_TOP_MARGIN, ANCHOR_BOTTOM_MARGIN,
    TAX_ANCHOR_MAX_DIST, L1_MAX_RIGHT_DIST_RATIO, L2_WINDOW_RADIUS_RATIO,
    GOODS_KEYWORDS, COMPANY_KEYWORDS,
)
from .region_strategies import Bounds, select_region_strategy
from .party_validation import NameCleaner
from .anchor_detector import AnchorDetector
from .extraction_context import ExtractionContext, AnchorContext, RegionContext, ScoreContext

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
logger.propagate = False
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter('%(levelname)s %(name)s - %(message)s'))
    logger.addHandler(_handler)

# ═══════════════════════════════════════════════════════════
# 常量（从 party_constants 导入，保留 _ 前缀别名以保持向后兼容）
# ═══════════════════════════════════════════════════════════

# 锚点关键词
_BUYER_ANCHORS = BUYER_ANCHORS
_SELLER_ANCHORS = SELLER_ANCHORS
_FOOTER_ANCHORS = FOOTER_ANCHORS

# 标签关键词
_NAME_LABELS = NAME_LABELS
_TAX_LABELS = TAX_LABELS

# 公司后缀与正则
_COMPANY_SUFFIX_LIST = COMPANY_SUFFIX_LIST
_COMPANY_PATTERN = COMPANY_PATTERN
_COMPANY_PATTERN_NO_SUFFIX = COMPANY_PATTERN_NO_SUFFIX

# 过滤关键词
_POLLUTION_KEYWORDS = POLLUTION_KEYWORDS
_INVOICE_ID_KEYWORDS = INVOICE_ID_KEYWORDS
_AMOUNT_DAXIE_KEYWORDS = AMOUNT_DAXIE_KEYWORDS
_LINE_ITEM_KEYWORDS = LINE_ITEM_KEYWORDS
_REMARK_LINE_KEYWORDS = REMARK_LINE_KEYWORDS

# 税号正则
_STANDALONE_TAX_ID_RE = STANDALONE_TAX_ID_RE

# 评分常量
_BASE_SCORE = BASE_SCORE
_SCORE_LABEL_BINDING = SCORE_LABEL_BINDING
_SCORE_REGION_LOCKED = SCORE_REGION_LOCKED
_SCORE_COMPANY_FORMAT = SCORE_COMPANY_FORMAT
_SCORE_TAX_FORMAT = SCORE_TAX_FORMAT
_SCORE_NEAR_TAX = SCORE_NEAR_TAX
_SCORE_NEAR_INV_ID = SCORE_NEAR_INV_ID
_SCORE_IN_LINE_ITEM = SCORE_IN_LINE_ITEM
_SCORE_GOODS_PENALTY = SCORE_GOODS_PENALTY
_SCORE_L4_LABEL_BIND = SCORE_L4_LABEL_BIND
_SCORE_L4_LABEL_RIGHT = SCORE_L4_LABEL_RIGHT
_SCORE_L4_ANCHOR_NEAR = SCORE_L4_ANCHOR_NEAR
_SCORE_L4_POSITION = SCORE_L4_POSITION
_SCORE_L4_ORDER = SCORE_L4_ORDER

# 置信度阈值
_CONFIDENCE_AUTO_PASS = CONFIDENCE_AUTO_PASS
_CONFIDENCE_NEED_CONFIRM = CONFIDENCE_NEED_CONFIRM

# 区域构建阈值
_REGION_SPLIT_Y_THRESHOLD = REGION_SPLIT_Y_THRESHOLD
_REGION_SPLIT_Y_RATIO = REGION_SPLIT_Y_RATIO

# 行聚类与匹配阈值
_LINE_CLUSTER_TOL = LINE_CLUSTER_TOL
_FUZZY_MATCH_MIN_RATIO = FUZZY_MATCH_MIN_RATIO
_SIMILARITY_THRESHOLD = SIMILARITY_THRESHOLD
_JACCARD_THRESHOLD = JACCARD_THRESHOLD
_DIGIT_RATIO_THRESHOLD = DIGIT_RATIO_THRESHOLD
_LABEL_VALUE_RATIO_THRESHOLD = LABEL_VALUE_RATIO_THRESHOLD

# 行内距离阈值
_ROW_HEIGHT_RATIO = ROW_HEIGHT_RATIO
_RIGHT_DIST_WEIGHT_DX = RIGHT_DIST_WEIGHT_DX
_RIGHT_DIST_WEIGHT_DY = RIGHT_DIST_WEIGHT_DY

# 来源优先级
_SOURCE_PRIORITY = SOURCE_PRIORITY

# ═══════════════════════════════════════════════════════════
# Token 辅助函数
# ═══════════════════════════════════════════════════════════

def _get_token_attr(t, key, default=None):
    if isinstance(t, dict):
        return t.get(key, default)
    return getattr(t, key, default)


def _token_text(t) -> str:
    if isinstance(t, dict):
        return t.get('text', '').strip()
    return getattr(t, 'text', '').strip()


def _token_x0(t) -> float:
    if isinstance(t, dict):
        return t.get('x0', 0)
    return getattr(t, 'x0', 0)


def _cx(t) -> float:
    if isinstance(t, dict):
        x0 = t.get('x0', 0)
        x1 = t.get('x1', 0)
    else:
        x0 = getattr(t, 'x0', 0)
        x1 = getattr(t, 'x1', 0)
    return (x0 + x1) / 2


def _cy(t) -> float:
    if isinstance(t, dict):
        y0 = t.get('y0', 0)
        y1 = t.get('y1', 0)
    else:
        y0 = getattr(t, 'y0', 0)
        y1 = getattr(t, 'y1', 0)
    return (y0 + y1) / 2


def _h(t) -> float:
    if isinstance(t, dict):
        y0 = t.get('y0', 0)
        y1 = t.get('y1', 0)
    else:
        y0 = getattr(t, 'y0', 0)
        y1 = getattr(t, 'y1', 0)
    return max(y1 - y0, 5)


def _cluster_into_lines(tokens: List[Dict], tol: float = _LINE_CLUSTER_TOL, _sorted: bool = False) -> List[List[Dict]]:
    if not tokens:
        return []
    s = tokens if _sorted else sorted(tokens, key=lambda t: _cy(t))
    lines, cur = [], [s[0]]
    for t in s[1:]:
        if abs(_cy(t) - _cy(cur[0])) < max(_h(cur[0]), _h(t)) * tol:
            cur.append(t)
        else:
            lines.append(sorted(cur, key=lambda x: _get_token_attr(x, 'x0', 0)))
            cur = [t]
    if cur:
        lines.append(sorted(cur, key=lambda x: _get_token_attr(x, 'x0', 0)))
    return lines


def _fuzzy_match(text: str, keywords: list, min_ratio: float = _FUZZY_MATCH_MIN_RATIO) -> Optional[str]:
    tc = text.replace(' ', '').replace('\u3000', '')

    # [PERF] 关键词转集合，用于快速成员检测
    kw_set = set(keywords)

    # [PERF] 快速路径：精确子串匹配（O(n) Boyer-Moore，常数极低）
    for kw in keywords:
        if kw in tc:
            return kw

    # [PERF] 交叉过滤：seller/buyer 互斥关键词剔除
    if '销售' in tc or '销方' in tc:
        buyer_exclusive = {'购买方', '购方信息', '购买方信息'}
        kw_set -= buyer_exclusive

    if '购买' in tc or '购方' in tc:
        seller_exclusive = {'销售方', '销方信息', '销售方信息'}
        kw_set -= seller_exclusive

    # [PERF] 覆盖率计算前增加快速过滤：字符集交集不足则跳过
    tc_set = set(tc)
    for kw in kw_set:
        if len(tc) < len(kw) - 1:
            continue
        # [PERF] 快速检查：如果关键词中超过 30% 的字符根本不在文本中，跳过精确计算
        kw_chars = set(kw)
        if len(kw_chars & tc_set) < len(kw) * 0.5:
            continue
        coverage = sum(1 for c in kw if c in tc_set) / len(kw)
        if coverage >= min_ratio:
            return kw

    return None


def _lcs_length(seq1, seq2):
    """[FIX] 最长公共子序列长度（DP），用于 _name_similarity 顺序验证"""
    m, n = len(seq1), len(seq2)
    if m == 0 or n == 0:
        return 0
    # 优化空间：只用两行 DP
    prev = [0] * (n + 1)
    curr = [0] * (n + 1)
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if seq1[i - 1] == seq2[j - 1]:
                curr[j] = prev[j - 1] + 1
            else:
                curr[j] = max(prev[j], curr[j - 1])
        prev, curr = curr, [0] * (n + 1)
    return prev[n] if prev else 0


# ExtractionContext 已迁移至 extraction_context.py
# 包含: AnchorContext, RegionContext, ScoreContext 三个子上下文

# ═══════════════════════════════════════════════════════════
# PartyExtractor（候选竞争模式）
# ═══════════════════════════════════════════════════════════

class PartyExtractor:
    """提取购买方/销售方的名称和税号（Candidate-based Pipeline v5）"""

    # 几何常量（从 party_constants 导入）
    _WINDOW_SIZE = WINDOW_SIZE
    _FULL_ELECTRIC_MAX_ANCHOR_GAP = FULL_ELECTRIC_MAX_ANCHOR_GAP
    _ANCHOR_TOP_MARGIN = ANCHOR_TOP_MARGIN
    _ANCHOR_BOTTOM_MARGIN = ANCHOR_BOTTOM_MARGIN
    _TAX_ANCHOR_MAX_DIST = TAX_ANCHOR_MAX_DIST
    _L1_MAX_RIGHT_DIST_RATIO = L1_MAX_RIGHT_DIST_RATIO
    _L2_WINDOW_RADIUS_RATIO = L2_WINDOW_RADIUS_RATIO

    # 公司后缀（从 party_constants 导入）
    _COMPANY_SUFFIXES = COMPANY_SUFFIX_LIST

    # 商品关键词（从 party_constants 导入）
    _GOODS_KEYWORDS = GOODS_KEYWORDS

    # 公司特征词（从 party_constants 导入）
    _COMPANY_KEYWORDS = COMPANY_KEYWORDS

    def __init__(self):
        # [FIX] 无状态设计：每次 extract() 创建新的 ExtractionContext
        # __init__ 创建默认上下文，保证单独调用子方法时不崩溃
        self._ctx: ExtractionContext = ExtractionContext()

    def _has_sufficient_coverage(self, candidates, threshold=None):
        """检查 4 个目标字段是否都已有高置信候选（用于早退 L2/L3/L4 层）

        Args:
            candidates: 当前累积的 FieldCandidate 列表
            threshold: 置信度阈值，默认使用 CONFIDENCE_AUTO_PASS (0.85)
        """
        if threshold is None:
            threshold = CONFIDENCE_AUTO_PASS
        covered = set()
        for c in candidates:
            if c.confidence >= threshold:
                covered.add(c.field)  # ✅ 修复：FieldCandidate 的字段名是 field，不是 field_name
        return len(covered) >= 4

    # ─────────────────────────────────────────────────────
    # 垂直字符合并
    # ─────────────────────────────────────────────────────

    def _merge_vertical_chars(self, tokens, y_tol=5, x_tol=7, max_merge_height=200):
        """将竖排相邻的单字 token 合并为完整字符串

        Args:
            tokens: 原始 token 列表
            y_tol: 垂直方向容差（像素）
            x_tol: 水平方向容差（像素），用于判断是否在同一列
            max_merge_height: [FIX] 合并最大高度限制，防止远距离字符误合并
        """
        singles = []
        others = []
        for t in tokens:
            text = _token_text(t)
            if len(text) == 1 and '\u4e00' <= text <= '\u9fff':
                singles.append(t)
            else:
                others.append(t)

        groups = {}
        for t in singles:
            cx = _cx(t)
            # [FIX] 边缘列（x < 50）使用更宽松的 x 容差，防止页面左侧噪声导致合并链断裂
            edge_tol = x_tol * 2 if cx < 50 else x_tol
            matched = False
            for key in list(groups.keys()):
                if abs(cx - key) < edge_tol:
                    groups[key].append(t)
                    matched = True
                    break
            if not matched:
                groups[cx] = [t]

        merged = []
        for cx, group in groups.items():
            if len(group) >= 2:
                group.sort(key=lambda t: _cy(t))
                # [FIX] 检查合并总高度是否超过限制
                total_height = _cy(group[-1]) - _cy(group[0])
                if total_height > max_merge_height:
                    merged.extend(group)
                    continue
                # [FIX] 行间间隙检测：防止跨语义区域误合并
                sub_groups = self._split_by_gap(group)
                for sg in sub_groups:
                    if len(sg) >= 2:
                        text = ''.join(_token_text(t) for t in sg)
                        merged.append(Token(
                            text=text,
                            x0=min(_get_token_attr(t, 'x0', 0) for t in sg),
                            y0=min(_get_token_attr(t, 'y0', 0) for t in sg),
                            x1=max(_get_token_attr(t, 'x1', 0) for t in sg),
                            y1=max(_get_token_attr(t, 'y1', 0) for t in sg),
                            page=0,
                            confidence=1.0,
                        ))
                    else:
                        merged.extend(sg)
            else:
                merged.extend(group)

        # ── 合并后验证：拆回可疑的误合并 ──
        _ANCHOR_KW = ('购买方', '购方', '销售方', '销方', '名称', '税号',
                       '信用代码', '纳税人', '发票', '备注', '开票', '复核', '收款')
        _SUFFIX_KW = ('有限公司', '有限责任公司', '股份有限公司', '集团',
                       '合伙', '银行', '事务所', '合作社')
        validated = []
        for t in merged:
            tt = _token_text(t)
            if len(tt) <= 2:
                validated.append(t)
                continue
            has_anchor = any(kw in tt for kw in _ANCHOR_KW)
            has_suffix = any(s in tt for s in _SUFFIX_KW)
            if has_suffix:
                validated.append(t)
            elif has_anchor:
                # 含锚点但无公司后缀：检查锚点是否在开头或紧邻公司名
                anchor_at_start = any(tt.startswith(kw) for kw in _ANCHOR_KW)
                if anchor_at_start or len(tt) <= 6:
                    validated.append(t)
                else:
                    logger.info("[MERGE_VALIDATE] 拆回锚点+junk: '%s'", tt[:30])
                    for ch in tt:
                        validated.append(Token(
                            text=ch,
                            x0=_get_token_attr(t, 'x0', 0),
                            y0=_get_token_attr(t, 'y0', 0),
                            x1=_get_token_attr(t, 'x1', 0),
                            y1=_get_token_attr(t, 'y1', 0),
                            page=0,
                            confidence=1.0,
                        ))
            else:
                # 疑似误合并：拆回单字
                logger.info("[MERGE_VALIDATE] 拆回误合并: '%s'", tt[:30])
                for ch in tt:
                    validated.append(Token(
                        text=ch,
                        x0=_get_token_attr(t, 'x0', 0),
                        y0=_get_token_attr(t, 'y0', 0),
                        x1=_get_token_attr(t, 'x1', 0),
                        y1=_get_token_attr(t, 'y1', 0),
                        page=0,
                        confidence=1.0,
                    ))
        merged = validated

        # ── 探针2：合并结果统计 ──
        singles_count = sum(1 for t in tokens if len(_token_text(t)) == 1
                            and '\u4e00' <= _token_text(t) <= '\u9fff')
        merged_count = sum(1 for t in merged if len(_token_text(t)) > 1)
        logger.info("[MERGE_PROBE] singles=%d merged=%d others=%d",
                    singles_count, merged_count, len(merged) - merged_count)
        for t in merged:
            if '购' in _token_text(t):
                logger.info("[MERGE_PROBE] 含购字: text='%s' y0=%.1f y1=%.1f",
                            _token_text(t)[:20],
                            _get_token_attr(t, 'y0', 0),
                            _get_token_attr(t, 'y1', 0))

        return others + merged

    @staticmethod
    def _split_by_gap(group: list, gap_ratio: float = 2.0) -> list[list]:
        """[FIX] 按行间间隙拆分组，防止跨语义区域误合并

        计算相邻字符的 cy 间距，若某处间距超过中位数的 gap_ratio 倍，
        则在该处断开，拆为多个子组。

        Args:
            group: 已按 cy 排序的 token 列表
            gap_ratio: 间隙阈值倍数（相对于中位数间距）
        Returns:
            子组列表，如 [['票','务','税'], ['销','售','方','信','息']]
        """
        if len(group) <= 2:
            return [group]

        # 计算相邻 cy 间距
        gaps = [_cy(group[i + 1]) - _cy(group[i]) for i in range(len(group) - 1)]
        if not gaps:
            return [group]

        # 中位数间距
        sorted_gaps = sorted(gaps)
        n = len(sorted_gaps)
        if n % 2 == 1:
            median_gap = sorted_gaps[n // 2]
        else:
            median_gap = (sorted_gaps[n // 2 - 1] + sorted_gaps[n // 2]) / 2.0

        # 中位数为 0 或极小时，用平均值代替
        if median_gap < 1.0:
            median_gap = sum(gaps) / len(gaps) if gaps else 1.0

        threshold = median_gap * gap_ratio

        # 在超过阈值的位置断开
        sub_groups = []
        current = [group[0]]
        for i, gap in enumerate(gaps):
            if gap > threshold:
                sub_groups.append(current)
                current = [group[i + 1]]
            else:
                current.append(group[i + 1])
        if current:
            sub_groups.append(current)

        return sub_groups

    # ─────────────────────────────────────────────────────
    # 主入口
    # ─────────────────────────────────────────────────────

    def extract(self, doc: OCRDocument,
                segmented: SegmentedDocument = None
                ) -> Tuple[str, str, str, str, Dict[str, dict]]:
        """返回 (gmfmc, gmfsh, xsfmc, xsfsh, field_meta)

        [FIX] 新增 segmented 参数：优先利用 SegmentedDocument 的区域信息，
        避免重复构建锚点和区域。bbox 路径作为 fallback。
        写入: self._ctx.score (ScoreContext) — 页面几何参数
        """
        # [FIX] 创建全新的上下文，消除状态泄漏
        self._ctx = ExtractionContext()
        score_ctx = self._ctx.score
        candidates = []
        field_meta = {}

        # [FIX] 不修改原始 doc.tokens，使用副本
        merged_tokens = None
        if doc.tokens:
            # [FIX] 按比例计算 max_merge_height 替代硬编码 200
            all_y1 = [t.y1 for t in doc.tokens]
            all_y0 = [t.y for t in doc.tokens]
            page_height = (max(all_y1) - min(all_y0)) if all_y1 and all_y0 else 800
            score_ctx.page_height = page_height
            merge_height = max(200, page_height * 0.25)
            merged_tokens = self._merge_vertical_chars(
                doc.tokens, max_merge_height=merge_height)

        if merged_tokens:
            page_width = max(_get_token_attr(t, 'x1', 0) for t in merged_tokens) if merged_tokens else 1000
            score_ctx.L1_MAX_RIGHT_DIST = int(page_width * self._L1_MAX_RIGHT_DIST_RATIO)
            score_ctx.L2_WINDOW_RADIUS = int(page_width * self._L2_WINDOW_RADIUS_RATIO)

        # [FIX] 构建结构化行索引（用于平局决胜）
        if doc.structured_lines:
            score_ctx.structured_line_map = {
                i: sl for i, sl in enumerate(doc.structured_lines)
                if i < len(doc.lines)
            }

        bbox_candidates = []
        if merged_tokens:
            bbox_candidates = self._extract_bbox_candidates(
                merged_tokens, segmented=segmented, doc=doc)
            candidates.extend(bbox_candidates)

        # ✅ 早退检查：如果 bbox 候选已覆盖全部字段，跳过 L4 文本候选
        if not self._has_sufficient_coverage(candidates):
            text_candidates = self._extract_text_candidates(
                doc.lines, doc.structured_lines,
                existing_candidates=bbox_candidates)
            candidates.extend(text_candidates)
        else:
            logger.info("[EXTRACT] bbox 候选已覆盖全部字段（%d 候选），跳过 L4 文本候选",
                        len(candidates))

        conflicts, warnings = self._detect_conflicts(candidates)

        result = self._resolve_candidates(candidates, conflicts=conflicts)
        field_meta = self._build_field_meta(
            candidates, result, conflicts=conflicts, warnings=warnings)

        logger.info("[候选选择] 最终结果: buyer_name='%s' buyer_tax='%s' seller_name='%s' seller_tax='%s'",
                     result.get('gmfmc', '')[:20], result.get('gmfsh', '')[:20],
                     result.get('xsfmc', '')[:20], result.get('xsfsh', '')[:20])

        # 后置交叉验证：检查买卖方是否来自正确的页面半区
        buyer_name = result.get('gmfmc', '')
        seller_name = result.get('xsfmc', '')
        tokens_to_validate = merged_tokens if merged_tokens else (doc.tokens if doc.tokens else [])

        if buyer_name and seller_name and tokens_to_validate:
            (validated_buyer, validated_seller), validation_status = self._validate_party_sides(
                buyer_name, seller_name, tokens_to_validate)

            if validation_status != "ok":
                logger.info("[候选选择] 后置交叉验证: status=%s buyer='%s' seller='%s'",
                            validation_status, validated_buyer, validated_seller)

            if validation_status == "swapped":
                # 更新结果和元数据
                result['gmfmc'] = validated_buyer
                result['xsfmc'] = validated_seller

                # 更新 field_meta 中的值
                if 'gmfmc' in field_meta:
                    field_meta['gmfmc']['value'] = validated_buyer
                    field_meta['gmfmc']['warnings'].append('后置交叉验证：买卖方可能反了，已自动交换')
                if 'xsfmc' in field_meta:
                    field_meta['xsfmc']['value'] = validated_seller
                    field_meta['xsfmc']['warnings'].append('后置交叉验证：买卖方可能反了，已自动交换')

        # 将 token 级买卖方区域回写至 doc.regions（替代 Segmenter 的粗粒度区域）
        self._write_back_regions(doc)

        return (
            result.get('gmfmc', ''),
            result.get('gmfsh', ''),
            result.get('xsfmc', ''),
            result.get('xsfsh', ''),
            field_meta
        )

    def _write_back_regions(self, doc: OCRDocument) -> None:
        """将 PartyExtractor 的 token 级买卖方区域回写至 doc.regions

        Segmenter 不再填充 doc.regions['buyer'] / ['seller']，
        由 PartyExtractor 在此处回写更精确的 token 级区域，
        供 _process_auxiliary_blocks 等下游使用。
        """
        region = self._ctx.region
        for side in ('buyer', 'seller'):
            tokens = region.buyer_region if side == 'buyer' else region.seller_region
            if tokens:
                xs = [(t.x0 if hasattr(t, 'x0') else t.get('x0', 0)) for t in tokens]
                ys = [(t.y0 if hasattr(t, 'y0') else t.get('y0', 0)) for t in tokens]
                xe = [(t.x1 if hasattr(t, 'x1') else t.get('x1', 0)) for t in tokens]
                ye = [(t.y1 if hasattr(t, 'y1') else t.get('y1', 0)) for t in tokens]
                doc.regions[side] = Region(
                    name=side,
                    x0=min(xs), y0=min(ys),
                    x1=max(xe), y1=max(ye),
                    tokens=list(tokens),
                )

    # ─────────────────────────────────────────────────────
    # BBox 候选提取（L1-L3）
    # ─────────────────────────────────────────────────────

    def _extract_bbox_candidates(self, tokens: List[Dict],
                                  segmented: SegmentedDocument = None,
                                  doc: OCRDocument = None,
                                  ) -> List[FieldCandidate]:
        """从 bbox tokens 提取所有候选

        写入: self._ctx.region (RegionContext), self._ctx.anchor (AnchorContext)

        当锚点均缺失且启发式策略退化为弱回退（全归 buyer / 页面中线）时，
        调用 _detect_regions_by_bbox 作为最终兜底（支持竖排/横排模式）。
        """
        candidates = []
        # 使用子上下文别名，明确归属
        region = self._ctx.region
        anchor = self._ctx.anchor

        px0, py0, px1, py1 = self._page_bounds(tokens)

        # [FIX] 优先从 SegmentedDocument 获取 line_item_y / footer_y
        if segmented and not segmented.line_items.is_empty:
            li_tokens = segmented.line_items.tokens
            if li_tokens:
                region.line_item_y = min(_cy(t) for t in li_tokens)
        if segmented and not segmented.footer.is_empty:
            ft_tokens = segmented.footer.tokens
            if ft_tokens:
                region.footer_y = min(_cy(t) for t in ft_tokens)

        # 回退：自建检测
        if region.line_item_y is None:
            region.line_item_y = self._find_line_item_y(tokens)
        if region.footer_y is None:
            region.footer_y = self._find_footer_y(tokens)

        inv_pos = self._precompute_inv_id_positions(tokens)
        region.inv_positions = inv_pos

        ba, sa = self._find_anchors(tokens, line_y=region.line_item_y)
        anchor.buyer_anchor = ba
        anchor.seller_anchor = sa

        buyer_region, seller_region = self._build_regions(
            tokens, ba, sa, px0, py0, px1, py1,
            region.line_item_y, region.footer_y)

        # ── 兜底：当锚点均缺失且启发式策略太弱时，用 bbox 坐标重新检测 ──
        if not ba and not sa and doc is not None:
            strategy_name = (region.region_debug or {}).get('strategy', '')
            if strategy_name in ('heuristic_all_to_buyer', 'heuristic_page_mid'):
                logger.info("[EXTRACT_BBOX] 锚点均缺失，策略=%s，尝试 _detect_regions_by_bbox",
                            strategy_name)
                bbox_buyer, bbox_seller, split_mode = self._detect_regions_by_bbox(doc)
                if bbox_buyer and bbox_seller and split_mode != 'none':
                    logger.info("[EXTRACT_BBOX] bbox 兜底生效: split_mode=%s, "
                                "buyer=%d tokens, seller=%d tokens",
                                split_mode, len(bbox_buyer), len(bbox_seller))
                    buyer_region = bbox_buyer
                    seller_region = bbox_seller
                    # 清空锚点位置信息（bbox 模式下锚点不可用）
                    anchor.buyer_anchor = None
                    anchor.seller_anchor = None

        # ── L0: 标签锚点空间定位（在 label 过滤之前执行） ──
        l0_candidates = self._extract_label_anchor_candidates(
            buyer_region, seller_region, inv_pos)
        candidates.extend(l0_candidates)

        # 过滤标签token（统一社会信用代码、名称：等），避免污染名称候选
        buyer_region = self._remove_label_tokens(buyer_region)
        seller_region = self._remove_label_tokens(seller_region)
        region.buyer_region = buyer_region
        region.seller_region = seller_region

        # L1: Label Binding
        l1_candidates = self._extract_l1_candidates(buyer_region, seller_region, inv_pos)
        candidates.extend(l1_candidates)

        # ✅ 早退检查：L0+L1 是否已覆盖全部 4 个字段
        if self._has_sufficient_coverage(candidates):
            logger.info("[EXTRACT_BBOX] L0+L1 已覆盖全部字段（%d 候选），跳过 L2/L3",
                        len(candidates))
            return candidates

        # L2: Anchor Window
        l2_candidates = self._extract_l2_candidates(
            buyer_region, seller_region, ba, sa, inv_pos)
        candidates.extend(l2_candidates)

        # ✅ 早退检查：L0+L1+L2 是否已覆盖全部字段
        if self._has_sufficient_coverage(candidates):
            logger.info("[EXTRACT_BBOX] L0+L1+L2 已覆盖全部字段（%d 候选），跳过 L3",
                        len(candidates))
            return candidates

        # L3: Region Scan
        l3_candidates = self._extract_l3_candidates(buyer_region, seller_region, inv_pos)
        candidates.extend(l3_candidates)

        return candidates

    # ─────────────────────────────────────────────────────
    # 文本候选提取（L4）
    # ─────────────────────────────────────────────────────

    def _extract_text_candidates(self, lines: List[str],
                                 structured_lines: List = None,
                                 existing_candidates=None) -> List[FieldCandidate]:
        """从文本行提取候选（L4 fallback），支持坐标增强
        
        写入: self._ctx.score (ScoreContext)
        """
        candidates = []

        line_map = {}
        if structured_lines:
            line_map = {i: sl for i, sl in enumerate(structured_lines)
                        if i < len(lines)}

        page_height = 0
        if line_map:
            all_y1 = [sl.y1 for sl in line_map.values()]
            all_y0 = [sl.y for sl in line_map.values()]
            if all_y1 and all_y0:
                page_height = max(all_y1) - min(all_y0)
        self._ctx.score.l4_page_height = page_height

        buyer_anchor_line = None
        seller_anchor_line = None
        ba_idx = self._find_anchor_text(lines, _BUYER_ANCHORS)
        sa_idx = self._find_anchor_text(lines, _SELLER_ANCHORS)
        if ba_idx >= 0 and ba_idx in line_map:
            buyer_anchor_line = line_map[ba_idx]
        if sa_idx >= 0 and sa_idx in line_map:
            seller_anchor_line = line_map[sa_idx]

        # 处理买卖方锚点同行冲突
        if ba_idx >= 0 and sa_idx >= 0 and ba_idx == sa_idx:
            line_text = lines[ba_idx] if ba_idx < len(lines) else ''
            has_buyer = any(anchor in line_text for anchor in _BUYER_ANCHORS)
            has_seller = any(anchor in line_text for anchor in _SELLER_ANCHORS)
            if has_buyer and has_seller:
                pass  # 全电发票横向布局，保留两个
            elif line_text.strip():
                if any(anchor in line_text for anchor in _SELLER_ANCHORS):
                    ba_idx = -1
                elif any(anchor in line_text for anchor in _BUYER_ANCHORS):
                    sa_idx = -1
        elif ba_idx >= 0 and sa_idx >= 0 and abs(ba_idx - sa_idx) <= 1:
            ba_line = lines[ba_idx] if ba_idx < len(lines) else ''
            sa_line = lines[sa_idx] if sa_idx < len(lines) else ''
            if ba_line.strip() == sa_line.strip():
                if '销售' in ba_line or '销方' in ba_line:
                    ba_idx = -1
                elif '购买' in ba_line or '购方' in ba_line:
                    sa_idx = -1

        anchor_gap = abs(ba_idx - sa_idx) if ba_idx >= 0 and sa_idx >= 0 else 999
        is_full_electric = (ba_idx >= 0 and sa_idx >= 0 and anchor_gap <= 1)

        if is_full_electric:
            candidates.extend(self._extract_full_electric_candidates(
                lines, ba_idx, sa_idx, line_map, buyer_anchor_line,
                seller_anchor_line,
                structured_lines=structured_lines,
                existing_candidates=existing_candidates))
        else:
            fa_idx = self._find_anchor_text(lines, _FOOTER_ANCHORS)

            if ba_idx >= 0:
                if ba_idx == sa_idx and len(lines[ba_idx].strip()) > 2:
                    start = ba_idx
                else:
                    start = ba_idx + self._skip_anchor_lines(lines, ba_idx)
                end = max(sa_idx, start + self._WINDOW_SIZE) if sa_idx >= 0 and sa_idx != ba_idx else (
                    fa_idx if fa_idx >= 0 and fa_idx > start + 3 else start + self._WINDOW_SIZE)
                if end <= start:
                    end = start + self._WINDOW_SIZE
                candidates.extend(self._text_region_candidates(
                    lines[start:end], 'gmfmc', 'gmfsh', start,
                    line_map, buyer_anchor_line, seller_anchor_line))

            if sa_idx >= 0:
                if ba_idx != sa_idx:
                    start = sa_idx + self._skip_anchor_lines(lines, sa_idx)
                    end = fa_idx if fa_idx >= 0 and fa_idx > start + 3 else start + self._WINDOW_SIZE
                    if end <= start:
                        end = start + self._WINDOW_SIZE
                    candidates.extend(self._text_region_candidates(
                        lines[start:end], 'xsfmc', 'xsfsh', start,
                        line_map, buyer_anchor_line, seller_anchor_line))

        return candidates

    # ─────────────────────────────────────────────────────
    # L0: 标签锚点空间定位（名称：/纳税人识别号 → 右侧取值区）
    # ─────────────────────────────────────────────────────

    def _extract_label_anchor_candidates(
        self, buyer_region, seller_region, inv_pos,
    ) -> List[FieldCandidate]:
        """基于"名称："/"纳税人识别号"的坐标锚点，在其右侧划定取值区提取公司名/税号。"""
        candidates = []
        for region_name, region in [('buyer', buyer_region), ('seller', seller_region)]:
            self._extract_label_anchor_single(
                region, region_name, 'gmfmc' if region_name == 'buyer' else 'xsfmc',
                ('名称', '公司名称', '单位名称'), inv_pos, candidates)
            self._extract_label_anchor_single(
                region, region_name, 'gmfsh' if region_name == 'buyer' else 'xsfsh',
                ('纳税人识别号', '统一社会信用代码', '税号'), inv_pos, candidates)
        return candidates

    def _extract_label_anchor_single(
        self, region, region_name: str, field_name: str,
        labels: tuple, inv_pos, candidates: List[FieldCandidate],
    ):
        if not region:
            logger.debug("[LabelAnchor/DBG] %s %s: region为空, 跳过", region_name, field_name)
            return
        label_token = None
        for t in region:
            text = _token_text(t)
            logger.debug("[LabelAnchor/DBG] %s %s: 检查token='%s'", region_name, field_name, text[:20])
            if any(lbl in text for lbl in labels) and '购买方' not in text and '销售方' not in text:
                label_token = t
                break
        if label_token is None:
            logger.debug("[LabelAnchor/DBG] %s %s: 未找到标签token, labels=%s", region_name, field_name, labels)
            return

        lx1 = _get_token_attr(label_token, 'x1', 0)
        lcy = _cy(label_token)
        lh = _h(label_token)
        y_tol = max(lh * 1.5, 15)

        # 嵌入式提取：从标签 token 文本中去掉标签前缀获取值
        # 对名称类字段尤其重要（名称通常与标签合并为同一 token）
        label_text = _token_text(label_token)
        embedded_val = None
        for lbl in labels:
            if lbl in label_text:
                idx = label_text.index(lbl) + len(lbl)
                ev = label_text[idx:].strip().lstrip('：:').strip()
                if ev:
                    if field_name in ('gmfmc', 'xsfmc'):
                        ev = self._clean_name(ev)
                    if ev:
                        embedded_val = ev
                        score = self._calculate_score(ev, field_name, 'bbox_l1_label', label_token, inv_pos, 'label_anchor_embedded')
                        candidates.append(FieldCandidate(
                            field=field_name, value=ev, score=score + 100,
                            confidence=min((score + 100) / 100.0, 0.95),
                            source='bbox_l0_label_anchor', region=region_name,
                            bbox=self._token_to_bbox(label_token), reason='label_anchor_embedded'))
                        logger.info("[LabelAnchor] %s(%s): 嵌入式 label='%s' → value='%s' score=%d",
                                     region_name, field_name, label_text[:20], ev[:40], score + 100)
                break

        # 独立 value token 提取（标签右侧的 token）
        value_tokens = []
        for t in region:
            if t is label_token:
                continue
            cy_diff = abs(_cy(t) - lcy)
            x0 = _token_x0(t)
            if cy_diff > y_tol:
                logger.debug("[LabelAnchor] %s: 跳过 token='%s' cy_diff=%.1f > y_tol=%.1f",
                             field_name, _token_text(t)[:15], cy_diff, y_tol)
                continue
            if _token_x0(t) < lx1 - 5:
                continue
            text = _token_text(t)
            if not text:
                continue
            if any(kw in text for kw in _POLLUTION_KEYWORDS):
                continue
            if len(text) == 1 and text in '购买方信息销售':
                continue
            value_tokens.append(t)

        if not value_tokens:
            return

        for vt in value_tokens:
            val = _token_text(vt).strip()
            if not val:
                continue
            if field_name in ('gmfmc', 'xsfmc'):
                val = self._clean_name(val)
            if not val:
                continue
            score = self._calculate_score(val, field_name, 'bbox_l1_label', label_token, inv_pos, 'label_anchor_spatial')
            candidates.append(FieldCandidate(
                field=field_name, value=val, score=score + 100,
                confidence=min((score + 100) / 100.0, 0.95),
                source='bbox_l0_label_anchor', region=region_name,
                bbox=self._token_to_bbox(vt), reason='label_anchor_spatial'))
            logger.info("[LabelAnchor] %s(%s): label='%s' x1=%.1f cy=%.1f → "
                         "value='%s' score=%d",
                         region_name, field_name,
                         _token_text(label_token)[:10], lx1, lcy,
                         val[:40], score + 100)

    def _extract_l1_candidates(self, buyer_region, seller_region, inv_pos):
        candidates = []

        for field_name, label_list in [('gmfmc', _NAME_LABELS), ('gmfsh', _TAX_LABELS)]:
            vals = self._try_l1_single(buyer_region, label_list, inv_pos)
            for val, token, reason in vals:
                val = self._clean_name(val) if field_name in ('gmfmc', 'xsfmc') else val
                if not val:
                    continue
                score = self._calculate_score(val, field_name, 'bbox_l1_label', token, inv_pos, reason)
                candidates.append(FieldCandidate(
                    field=field_name, value=val, score=score,
                    confidence=score / 100.0, source='bbox_l1_label',
                    region='buyer', bbox=self._token_to_bbox(token), reason=reason,
                ))

        for field_name, label_list in [('xsfmc', _NAME_LABELS), ('xsfsh', _TAX_LABELS)]:
            vals = self._try_l1_single(seller_region, label_list, inv_pos)
            for val, token, reason in vals:
                val = self._clean_name(val) if field_name in ('gmfmc', 'xsfmc') else val
                if not val:
                    continue
                score = self._calculate_score(val, field_name, 'bbox_l1_label', token, inv_pos, reason)
                candidates.append(FieldCandidate(
                    field=field_name, value=val, score=score,
                    confidence=score / 100.0, source='bbox_l1_label',
                    region='seller', bbox=self._token_to_bbox(token), reason=reason,
                ))

        return candidates

    def _try_l1_single(self, region, labels, inv_pos):
        results = []
        sorted_region = sorted(region, key=lambda t: (_cy(t), _cx(t)))

        # [PERF] 预构建行索引：按 cy 分组，避免 _extract_right_values 每次全量扫描
        row_index: list[list] = []  # [(cy, [tokens_in_row])]
        _ROW_TOL = 8  # 行高容差
        for t in sorted_region:
            cy_val = _cy(t)
            if row_index and abs(cy_val - row_index[-1][0]) < _ROW_TOL:
                row_index[-1][1].append(t)
            else:
                row_index.append((cy_val, [t]))

        for cy_val, row_tokens in row_index:
            for lt in row_tokens:
                text = _token_text(lt)
                if not text:
                    continue

                for lbl in labels:
                    if lbl in text and not any(kw in text for kw in _POLLUTION_KEYWORDS):
                        # [PERF] 只扫描同行 token，O(w) 而非 O(t)
                        right_vals = self._extract_right_values(row_tokens, lt, inv_pos)
                        for val, reason in right_vals:
                            results.append((val, lt, reason))
        return results

    def _extract_right_values(self, region, label_token, inv_pos):
        """从 label 右侧提取所有候选值
        
        读取: self._ctx.score (ScoreContext) — L1 距离参数
        """
        results = []
        score_ctx = self._ctx.score
        lcy = _cy(label_token)
        lx0 = _get_token_attr(label_token, 'x0', 0)
        lx1 = _get_token_attr(label_token, 'x1', 0)
        label_text = _get_token_attr(label_token, 'text', '').strip()
        label_width = max(lx1 - lx0, 1)

        # [FIX] 扫描宽度上限：标签宽度的5倍或 L1_MAX_RIGHT_DIST 取较小值
        max_scan = min(label_width * 5, score_ctx.L1_MAX_RIGHT_DIST)

        rights = []
        for t in region:
            # [FIX] 排除 label_token 自身，防止自引用
            if t is label_token:
                continue
            tx0 = _token_x0(t)
            if tx0 < lx1 - 5:
                continue
            dx = tx0 - lx1
            dy = abs(_cy(t) - lcy)
            if dx > max_scan or dy > score_ctx.L1_MAX_ROW_DIST:
                continue
            rights.append((dx * _RIGHT_DIST_WEIGHT_DX + dy * _RIGHT_DIST_WEIGHT_DY, t))

        if rights:
            rights.sort(key=lambda x: x[0])
            same_row = [
                t for _, t in rights
                if abs(_cy(t) - lcy) < max(_h(label_token), _h(t)) * _ROW_HEIGHT_RATIO
            ]

            if same_row:
                same_row_sorted = sorted(same_row, key=lambda x: _token_x0(x))
                val = ''.join(_token_text(t) for t in same_row_sorted).strip()
                if val:
                    # [FIX] 跨区域污染检测：截断到已知标签关键词
                    val = self._truncate_at_label_keywords(val)
                    # [FIX] 长度守卫：公司名不应超过40字符
                    if len(val) <= 40:
                        results.append((val, '与标签同行右侧绑定'))

            merged_token_keys = {
                (_token_text(t), _token_x0(t), _get_token_attr(t, 'y1', 0))
                for t in same_row
            } if same_row else set()
            for _, candidate in rights:
                ck = (_token_text(candidate), _token_x0(candidate),
                      _get_token_attr(candidate, 'y1', 0))
                if ck in merged_token_keys:
                    continue
                val = _token_text(candidate)
                if val and val not in {':', '：', '|', '/', '、', ',', '，', ' '}:
                    results.append((val, '标签右侧候选'))

        # 检查标签内是否包含值（如"名称：华为技术有限公司"）
        m = re.search(r'[:：]\s*(.+)', label_text)
        if m:
            val = m.group(1).strip()
            if val:
                results.append((val, '标签内包含值'))

        return results

    @staticmethod
    def _truncate_at_label_keywords(val: str) -> str:
        """[FIX] 截断到已知标签关键词，防止跨区域污染。
        
        当 same_row 拼接跨越了多个发票区域时，值中会包含
        "名称：" "统一社会信用代码" 等标签文本。截断到第一个
        这样的关键词，保留前面的有效公司名。
        """
        _LABEL_CUT_RE = re.compile(
            r'名\s*称[:：]|统一社会信用代码|纳税人识别号|'
            r'销售方信息|购买方信息|下载次数'
        )
        m = _LABEL_CUT_RE.search(val)
        if m and m.start() >= 4:
            return val[:m.start()]
        return val

    # ─────────────────────────────────────────────────────
    # L2: 锚点窗口候选
    # ─────────────────────────────────────────────────────

    def _extract_l2_candidates(self, buyer_region, seller_region, ba, sa, inv_pos):
        """提取 L2 锚点窗口候选
        
        读取: self._ctx.score (ScoreContext) — L2_WINDOW_RADIUS
        """
        candidates = []
        score_ctx = self._ctx.score

        if ba:
            window = [t for t in buyer_region if abs(_cy(t) - _cy(ba)) < score_ctx.L2_WINDOW_RADIUS]
            if window:
                candidates.extend(self._window_candidates(
                    window, 'gmfmc', 'gmfsh', 'bbox_l2_anchor', 'buyer', inv_pos))

        if sa:
            window = [t for t in seller_region if abs(_cy(t) - _cy(sa)) < score_ctx.L2_WINDOW_RADIUS]
            if window:
                candidates.extend(self._window_candidates(
                    window, 'xsfmc', 'xsfsh', 'bbox_l2_anchor', 'seller', inv_pos))

        return candidates

    def _window_candidates(self, window, name_field, tax_field, source, region, inv_pos):
        candidates = []
        lines = _cluster_into_lines(window)

        for lt in lines:
            # 排除标签碎片的单字（"购 买 方 信 息"），避免污染公司名称
            line_tokens = []
            for t in lt:
                tt = _token_text(t).strip()
                if len(tt) == 1 and tt in '购买方信息销售方信息纳税人':
                    continue
                line_tokens.append(tt)
            line_text = ' '.join(line_tokens)

            cm = _COMPANY_PATTERN.search(line_text)
            if cm:
                name_val = self._clean_name(cm.group(0).strip())
                name_val = self._truncate_at_label_keywords(name_val)
                if self._name_ok(name_val):
                    score = self._calculate_score(
                        name_val, name_field, source, lt[0] if lt else None,
                        inv_pos, '锚点窗口内公司名匹配')
                    candidates.append(FieldCandidate(
                        field=name_field, value=name_val, score=score,
                        confidence=score / 100.0, source=source, region=region,
                        reason='锚点窗口内公司名匹配',
                    ))

            for t in lt:
                tt = _token_text(t).replace(' ', '')
                if _STANDALONE_TAX_ID_RE.match(tt) and not self._near_inv_id(t, inv_pos):
                    if self._tax_ok(tt):
                        score = self._calculate_score(
                            tt, tax_field, source, t, inv_pos, '锚点窗口内税号匹配')
                        candidates.append(FieldCandidate(
                            field=tax_field, value=tt.upper(), score=score,
                            confidence=score / 100.0, source=source, region=region,
                            bbox=self._token_to_bbox(t), reason='锚点窗口内税号匹配',
                        ))

        return candidates

    # ─────────────────────────────────────────────────────
    # L3: 区域扫描候选
    # ─────────────────────────────────────────────────────

    def _extract_l3_candidates(self, buyer_region, seller_region, inv_pos):
        candidates = []
        candidates.extend(self._region_scan_candidates(
            buyer_region, 'gmfmc', 'gmfsh', 'bbox_l3_region', 'buyer', inv_pos))
        candidates.extend(self._region_scan_candidates(
            seller_region, 'xsfmc', 'xsfsh', 'bbox_l3_region', 'seller', inv_pos))
        return candidates

    def _region_scan_candidates(self, region, name_field, tax_field, source, region_name, inv_pos):
        candidates = []
        sorted_region = sorted(region, key=lambda t: (_cy(t), _cx(t)))

        lines = self._group_tokens_by_lines(sorted_region)

        for line_tokens in lines:
            combined = ' | '.join(_token_text(t)[:30] for t in line_tokens)
            logger.info("[RegionScan/DBG] %s line_tokens=%s", region_name, combined)
            for t in line_tokens:
                text = _token_text(t)
                if not text:
                    continue

                cm = _COMPANY_PATTERN.search(text)
                if cm:
                    match_text = cm.group(0)
                    logger.info("[RegionScan/DBG] %s COMPANY_PATTERN matched: '%s'", region_name, match_text[:40])
                    name_val = self._clean_name(cm.group(0).strip())
                    name_val = self._truncate_at_label_keywords(name_val)
                    name_ok = self._name_ok(name_val)
                    logger.info("[RegionScan/DBG] %s clean='%s' name_ok=%s",
                                region_name, name_val[:40], name_ok)
                    if name_ok:
                        score = self._calculate_score(
                            name_val, name_field, source, t, inv_pos, '区域扫描公司名匹配')
                        candidates.append(FieldCandidate(
                            field=name_field, value=name_val, score=score,
                            confidence=score / 100.0, source=source,
                            region=region_name, bbox=self._token_to_bbox(t),
                            reason='区域扫描公司名匹配',
                        ))

                clean = text.replace(' ', '')
                if _STANDALONE_TAX_ID_RE.match(clean) and not self._near_inv_id(t, inv_pos):
                    if self._tax_ok(clean):
                        score = self._calculate_score(
                            clean, tax_field, source, t, inv_pos, '区域扫描税号匹配')
                        candidates.append(FieldCandidate(
                            field=tax_field, value=clean.upper(), score=score,
                            confidence=score / 100.0, source=source,
                            region=region_name, bbox=self._token_to_bbox(t),
                            reason='区域扫描税号匹配',
                        ))

            merged_tax = self._merge_adjacent_tax_tokens(line_tokens, inv_pos)
            if merged_tax:
                merged_text, merged_token = merged_tax
                clean = merged_text.replace(' ', '')
                if self._tax_ok(clean):
                    score = self._calculate_score(
                        clean, tax_field, source, merged_token, inv_pos, '跨token税号合并')
                    if not any(c.value == clean.upper() for c in candidates if c.field == tax_field):
                        candidates.append(FieldCandidate(
                            field=tax_field, value=clean.upper(), score=score,
                            confidence=score / 100.0, source=source,
                            region=region_name, bbox=self._token_to_bbox(merged_token),
                            reason='跨token税号合并',
                        ))

        return candidates

    def _group_tokens_by_lines(self, tokens):
        return _cluster_into_lines(tokens, tol=_LINE_CLUSTER_TOL, _sorted=True)

    def _is_plausible_tax_char(self, ch: str) -> bool:
        """判断字符是否可能出现在税号中（字母、数字、空格）"""
        return ch.isalnum() or ch.isspace()

    def _merge_adjacent_tax_tokens(self, line_tokens, inv_pos, gap_threshold=30):
        """
        合并相邻的税号 token（滑动窗口优化版本）

        相比三层循环 O(n³)，滑动窗口限制合并数量和总长度：
        - 最多合并 4 个 token
        - 总长度不超过 20 字符
        - 保留 _tax_ok 和 _near_inv_id 校验
        """
        if len(line_tokens) < 2:
            return None

        # 预过滤：只保留可能出现在税号中的字符
        filtered = [t for t in line_tokens if _token_text(t) and all(self._is_plausible_tax_char(ch) for ch in _token_text(t))]
        if len(filtered) < 2:
            return None

        sorted_tokens = sorted(filtered, key=lambda t: _cx(t))
        n = len(sorted_tokens)

        MAX_MERGE = 4
        MAX_LEN = 20

        for start in range(n):
            if self._near_inv_id(sorted_tokens[start], inv_pos):
                continue

            combined = ""
            for end in range(start, min(start + MAX_MERGE, n)):
                # 检查 x 方向间距，超过阈值则停止
                if end > start and _cx(sorted_tokens[end]) - _cx(sorted_tokens[end - 1]) > gap_threshold * 3:
                    break

                combined += _token_text(sorted_tokens[end])

                # 检查总长度
                if len(combined) > MAX_LEN:
                    break

                clean = combined.replace(' ', '')

                # 匹配税号正则并校验
                if _STANDALONE_TAX_ID_RE.match(clean) and self._tax_ok(clean):
                    if not self._near_inv_id(sorted_tokens[start], inv_pos):
                        return (combined, sorted_tokens[start])

        return None

    # ─────────────────────────────────────────────────────
    # 文本区域候选（L4）
    # ─────────────────────────────────────────────────────

    def _text_region_candidates(self, lines, name_field, tax_field, start_line,
                                line_map=None, buyer_anchor_line=None,
                                seller_anchor_line=None):
        candidates = []
        seen_names = set()
        seen_taxes = set()
        name_count = 0

        for i, line in enumerate(lines):
            line_text = line.strip()
            if not line_text:
                continue

            # [FIX] 过滤备注区内容
            if self._is_remark_content(line_text):
                continue

            line_idx = start_line + i
            line_obj = (line_map or {}).get(line_idx)

            cm = _COMPANY_PATTERN.search(line_text)
            if cm:
                name_val = self._clean_name(cm.group(0).strip())
                name_val = self._truncate_at_label_keywords(name_val)
                if self._name_ok(name_val) and name_val not in seen_names:
                    seen_names.add(name_val)
                    name_count += 1
                    score = self._calculate_text_score_v2(
                        name_val, name_field, line_obj,
                        buyer_anchor_line, seller_anchor_line)
                    # [FIX] 对于 xsfmc，后面的公司名加分（OCR文本中卖家名通常在后）
                    if name_field == 'xsfmc' and name_count > 1:
                        score = min(score + 10, 100)
                    candidates.append(FieldCandidate(
                        field=name_field, value=name_val, score=score,
                        confidence=score / 100.0, source='text_l4',
                        line_index=line_idx,
                        reason='文本行公司名匹配' + ('（坐标增强）' if line_obj else ''),
                    ))

            t = self._extract_tax_line(line_text)
            if t and t not in seen_taxes:
                seen_taxes.add(t)
                tax_count = len(seen_taxes)
                score = self._calculate_text_score_v2(
                    t, tax_field, line_obj,
                    buyer_anchor_line, seller_anchor_line)
                # [FIX] 对于 xsfsh，后面的税号加分（OCR文本中卖家税号通常在后）
                if tax_field == 'xsfsh' and tax_count > 1:
                    score = min(score + 10, 100)
                candidates.append(FieldCandidate(
                    field=tax_field, value=t, score=score,
                    confidence=score / 100.0, source='text_l4',
                    line_index=line_idx,
                    reason='文本行税号匹配' + ('（坐标增强）' if line_obj else ''),
                ))

        return candidates

    # ─────────────────────────────────────────────────────
    # 全电发票候选
    # ─────────────────────────────────────────────────────

    def _extract_full_electric_candidates(self, lines, ba_idx, sa_idx,
                                          line_map=None,
                                          buyer_anchor_line=None,
                                          seller_anchor_line=None,
                                          structured_lines=None,
                                          existing_candidates=None):
        candidates = []
        first_idx = min(ba_idx, sa_idx)
        start = first_idx
        end = min(len(lines), start + 50)

        l1_bound_names = set()
        l1_bound_taxes = set()
        if existing_candidates:
            for cand in existing_candidates:
                if cand.source == 'bbox_l1_label':
                    if cand.field in ('gmfmc', 'xsfmc'):
                        l1_bound_names.add(cand.value)
                    else:
                        l1_bound_taxes.add(cand.value)

        # 步骤 1：标签右侧直接提取
        label_bound_names = set()
        label_bound_taxes = set()
        if structured_lines:
            label_results = self._extract_label_right_values(
                structured_lines, buyer_anchor_line, seller_anchor_line)
            for field, value, reason in label_results:
                if field in ('gmfmc', 'xsfmc'):
                    if value in l1_bound_names:
                        continue
                else:
                    if value in l1_bound_taxes:
                        continue

                score = self._calculate_text_score(value, field) + _SCORE_L4_LABEL_BIND
                candidates.append(FieldCandidate(
                    field=field, value=value,
                    score=min(score, 100), confidence=min(score, 100) / 100.0,
                    source='text_l4', line_index=-1, reason=reason,
                ))
                if field in ('gmfmc', 'xsfmc'):
                    label_bound_names.add(value)
                else:
                    label_bound_taxes.add(value)

        # 步骤 2：通用文本模式匹配
        companies = []
        tax_ids = []
        seen_c, seen_t = set(), set()

        # y 范围过滤
        page_height = 0
        if line_map:
            all_y = [sl.cy for sl in line_map.values() if hasattr(sl, 'cy')]
            if all_y:
                page_height = max(all_y) - min(all_y)

        min_y = -float('inf')
        max_y = float('inf')
        if buyer_anchor_line and seller_anchor_line:
            min_y = buyer_anchor_line.cy - page_height * 0.25
            max_y = seller_anchor_line.cy + page_height * 0.35
        elif buyer_anchor_line:
            min_y = buyer_anchor_line.cy - page_height * 0.25
            max_y = buyer_anchor_line.cy + page_height * 0.55

        for i in range(start, end):
            line = lines[i].strip()
            if not line:
                continue
            if re.search(r'\*[^*]+\*', line):
                continue

            # [FIX] 过滤备注区内容
            if self._is_remark_content(line):
                continue

            # y 范围过滤
            if line_map and i in line_map:
                line_obj = line_map[i]
                if hasattr(line_obj, 'cy'):
                    if line_obj.cy < min_y or line_obj.cy > max_y:
                        continue

            # 提取公司名
            for cm in _COMPANY_PATTERN.finditer(line):
                n = cm.group(0).strip()
                if self._name_ok(n) and n not in seen_c and n not in label_bound_names:
                    companies.append((i, n))
                    seen_c.add(n)
            line_has_company = any(n in line for _, n in companies)
            if not line_has_company:
                for cm in _COMPANY_PATTERN_NO_SUFFIX.finditer(line):
                    n = cm.group(0).strip()
                    if self._name_ok(n) and n not in seen_c and len(n) >= 4 \
                            and n not in label_bound_names:
                        if any(kw in n for kw in [
                                '购买方', '销售方', '名称', '税号', '纳税人', '识别号']):
                            continue
                        companies.append((i, n))
                        seen_c.add(n)

            # 提取税号
            for t in self._extract_all_tax_lines(line):
                if t and t not in seen_t and t not in label_bound_taxes:
                    tax_ids.append((i, t))
                    seen_t.add(t)

        def _compute_score(value, field_name, line_obj, is_buyer, is_label_bound):
            primary_field = 'gmfmc' if is_buyer else 'xsfmc'
            secondary_field = 'xsfmc' if is_buyer else 'gmfmc'

            if is_label_bound:
                bonus = _SCORE_L4_LABEL_RIGHT
                reason_suffix = '标签右侧绑定' + ('（购买方侧）' if is_buyer else '（销售方侧）')
            else:
                bonus = _SCORE_L4_ORDER
                reason_suffix = '靠近购买方锚点' if is_buyer else '靠近销售方锚点'

            primary_score = self._calculate_text_score_v2(
                value, primary_field, line_obj,
                buyer_anchor_line, seller_anchor_line) + bonus
            secondary_score = self._calculate_text_score_v2(
                value, secondary_field, line_obj,
                buyer_anchor_line, seller_anchor_line)

            # [PERF] 候选裁剪：主候选分数远高于副候选时，跳过副候选
            if secondary_score > 0 and primary_score >= secondary_score * 1.5:
                secondary_score = 0  # 抑制弱候选

            return primary_score, secondary_score, reason_suffix

        # 坐标增强分配
        if line_map:
            for i, name in companies:
                line_obj = line_map.get(i)
                buyer_dist = abs(line_obj.cy - buyer_anchor_line.cy) if (
                    line_obj and buyer_anchor_line) else 999999
                seller_dist = abs(line_obj.cy - seller_anchor_line.cy) if (
                    line_obj and seller_anchor_line) else 999999
                is_buyer = buyer_dist <= seller_dist

                is_label_bound = self._is_value_right_of_label_in_line(
                    line_obj, name, _NAME_LABELS)

                primary_field = 'gmfmc' if is_buyer else 'xsfmc'
                secondary_field = 'xsfmc' if is_buyer else 'gmfmc'

                p_score, s_score, reason_suffix = _compute_score(
                    name, 'name', line_obj, is_buyer, is_label_bound)

                candidates.append(FieldCandidate(
                    field=primary_field, value=name,
                    score=p_score, confidence=p_score / 100.0,
                    source='text_l4', line_index=i,
                    reason=f'全电发票公司名（{reason_suffix}）',
                ))
                if s_score > 0:
                    candidates.append(FieldCandidate(
                        field=secondary_field, value=name,
                        score=s_score, confidence=s_score / 100.0,
                        source='text_l4', line_index=i,
                        reason='全电发票公司名',
                    ))

            for i, tax in tax_ids:
                line_obj = line_map.get(i)
                buyer_dist = abs(line_obj.cy - buyer_anchor_line.cy) if (
                    line_obj and buyer_anchor_line) else 999999
                seller_dist = abs(line_obj.cy - seller_anchor_line.cy) if (
                    line_obj and seller_anchor_line) else 999999
                is_buyer = buyer_dist <= seller_dist

                is_label_bound = self._is_value_right_of_label_in_line(
                    line_obj, tax, _TAX_LABELS)

                primary_field = 'gmfsh' if is_buyer else 'xsfsh'
                secondary_field = 'xsfsh' if is_buyer else 'gmfsh'

                p_score, s_score, reason_suffix = _compute_score(
                    tax, 'tax', line_obj, is_buyer, is_label_bound)

                candidates.append(FieldCandidate(
                    field=primary_field, value=tax,
                    score=p_score, confidence=p_score / 100.0,
                    source='text_l4', line_index=i,
                    reason=f'全电发票税号（{reason_suffix}）',
                ))
                if s_score > 0:
                    candidates.append(FieldCandidate(
                        field=secondary_field, value=tax,
                        score=s_score, confidence=s_score / 100.0,
                        source='text_l4', line_index=i,
                        reason='全电发票税号',
                    ))
        else:
            # 无坐标回退
            for idx, (i, name) in enumerate(companies):
                if idx == 0:
                    candidates.append(FieldCandidate(
                        field='gmfmc', value=name,
                        score=self._calculate_text_score(name, 'gmfmc') + 10,
                        confidence=(self._calculate_text_score(name, 'gmfmc') + 10) / 100.0,
                        source='text_l4', line_index=i,
                        reason='全电发票公司名（第一个）',
                    ))
                    candidates.append(FieldCandidate(
                        field='xsfmc', value=name,
                        score=self._calculate_text_score(name, 'xsfmc'),
                        confidence=self._calculate_text_score(name, 'xsfmc') / 100.0,
                        source='text_l4', line_index=i,
                        reason='全电发票公司名',
                    ))
                else:
                    candidates.append(FieldCandidate(
                        field='xsfmc', value=name,
                        score=self._calculate_text_score(name, 'xsfmc') + 10,
                        confidence=(self._calculate_text_score(name, 'xsfmc') + 10) / 100.0,
                        source='text_l4', line_index=i,
                        reason='全电发票公司名（后续）',
                    ))
                    candidates.append(FieldCandidate(
                        field='gmfmc', value=name,
                        score=self._calculate_text_score(name, 'gmfmc'),
                        confidence=self._calculate_text_score(name, 'gmfmc') / 100.0,
                        source='text_l4', line_index=i,
                        reason='全电发票公司名',
                    ))
            for idx, (i, tax) in enumerate(tax_ids):
                if idx == 0:
                    candidates.append(FieldCandidate(
                        field='gmfsh', value=tax,
                        score=self._calculate_text_score(tax, 'gmfsh') + 10,
                        confidence=(self._calculate_text_score(tax, 'gmfsh') + 10) / 100.0,
                        source='text_l4', line_index=i,
                        reason='全电发票税号（第一个）',
                    ))
                    candidates.append(FieldCandidate(
                        field='xsfsh', value=tax,
                        score=self._calculate_text_score(tax, 'xsfsh'),
                        confidence=self._calculate_text_score(tax, 'xsfsh') / 100.0,
                        source='text_l4', line_index=i,
                        reason='全电发票税号',
                    ))
                else:
                    candidates.append(FieldCandidate(
                        field='xsfsh', value=tax,
                        score=self._calculate_text_score(tax, 'xsfsh') + 10,
                        confidence=(self._calculate_text_score(tax, 'xsfsh') + 10) / 100.0,
                        source='text_l4', line_index=i,
                        reason='全电发票税号（后续）',
                    ))
                    candidates.append(FieldCandidate(
                        field='gmfsh', value=tax,
                        score=self._calculate_text_score(tax, 'gmfsh'),
                        confidence=self._calculate_text_score(tax, 'gmfsh') / 100.0,
                        source='text_l4', line_index=i,
                        reason='全电发票税号',
                    ))

        return candidates

    # ─────────────────────────────────────────────────────
    # 评分
    # ─────────────────────────────────────────────────────

    def _calculate_score(self, value, field_name, source, token, inv_pos, reason):
        """评分计算
        
        读取: self._ctx.region (RegionContext) — line_item_y
        """
        score = _BASE_SCORE

        if source == 'bbox_l1_label':
            score += _SCORE_LABEL_BINDING
        elif source == 'bbox_l2_anchor':
            score += _SCORE_REGION_LOCKED
        elif source == 'bbox_l3_region':
            score += _SCORE_REGION_LOCKED // 2

        if field_name in ('gmfmc', 'xsfmc'):
            if self._name_ok(value):
                score += _SCORE_COMPANY_FORMAT
            if self._is_likely_goods(value):
                score += _SCORE_GOODS_PENALTY
            # [FIX] _is_bank_branch 现在在 _name_ok 中硬过滤，
            # 此处保留软惩罚作为兜底
            if self._is_bank_branch(value):
                score += _SCORE_GOODS_PENALTY
        else:
            if self._tax_ok(value):
                score += _SCORE_TAX_FORMAT

        if token and self._near_inv_id(token, inv_pos):
            score += _SCORE_NEAR_INV_ID

        # 读取 RegionContext 的 line_item_y
        line_item_y = self._ctx.region.line_item_y
        if token and line_item_y and _cy(token) >= line_item_y:
            score += _SCORE_IN_LINE_ITEM

        return min(max(0, score), 100)

    def _calculate_text_score(self, value, field_name):
        # [FIX] L4 文本候选没有 bbox 证据，需要更高的基础分来补偿
        # 便得“有格式的公司名/税号”仍然能达到 need_confirm 阈值
        score = _BASE_SCORE + 15  # L4 补偿加分

        if field_name in ('gmfmc', 'xsfmc'):
            if self._name_ok(value):
                score += _SCORE_COMPANY_FORMAT
            if self._is_likely_goods(value):
                score += _SCORE_GOODS_PENALTY
        else:
            if self._tax_ok(value):
                score += _SCORE_TAX_FORMAT

        return min(max(0, score), 100)

    def _calculate_text_score_v2(self, value, field_name, line_obj=None,
                                  buyer_anchor_line=None, seller_anchor_line=None,
                                  page_height=None):
        base_score = self._calculate_text_score(value, field_name)

        if line_obj is None:
            return base_score

        score = base_score

        all_labels = _NAME_LABELS + _TAX_LABELS + ('购买方', '销售方', '购方', '销方')
        label_token = self._find_label_in_line(line_obj, all_labels)
        if label_token and self._is_right_of_label(value, label_token, line_obj):
            score += _SCORE_L4_LABEL_RIGHT

        role = 'buyer' if field_name in ('gmfmc', 'gmfsh') else 'seller'
        anchor_line = buyer_anchor_line if role == 'buyer' else seller_anchor_line
        if anchor_line and line_obj:
            dist = abs(line_obj.cy - anchor_line.cy)
            if dist < 200:
                score += _SCORE_L4_ANCHOR_NEAR
            elif dist < 400:
                score += _SCORE_L4_ANCHOR_NEAR // 2

        if page_height is None:
            page_height = getattr(self, '_l4_page_height', 0)
        if page_height > 0:
            score += self._vertical_position_score(line_obj.cy, page_height, role)

        return min(max(0, score), 100)

    # ─────────────────────────────────────────────────────
    # 决策与冲突
    # ─────────────────────────────────────────────────────

    def _resolve_candidates(self, candidates, conflicts=None):
        result = {}
        if conflicts is None:
            conflicts, _ = self._detect_conflicts(candidates)

        # [FIX] 税号冲突安全网：当 gmfsh/xsfsh 冲突时，尝试用位置关系解歧
        if 'gmfsh' in conflicts or 'xsfsh' in conflicts:
            candidates = self._resolve_tax_id_conflict(candidates)

        for field in ['gmfmc', 'gmfsh', 'xsfmc', 'xsfsh']:
            field_candidates = [c for c in candidates if c.field == field and c.value]
            if not field_candidates:
                logger.info("[候选选择] %s: 无候选", field)
                continue

            # [FIX] 三级排序：分数 → 来源优先级 → 空间距离（平局决胜）
            field_candidates.sort(
                key=lambda c: (
                    -c.score,
                    -_SOURCE_PRIORITY.get(c.source, 0),
                    self._anchor_distance(c, field),
                )
            )

            # 日志：该字段所有候选
            log_lines = [f"  [{i}] score={c.score} src={c.source} region={c.region} val='{str(c.value)[:30]}'"
                         for i, c in enumerate(field_candidates)]
            logger.info("[候选选择] %s 共%d个候选:\n%s",
                        field, len(field_candidates), '\n'.join(log_lines))

            best = field_candidates[0]
            logger.info("[候选选择] %s 胜出: score=%d src=%s region=%s val='%s'",
                        field, best.score, best.source, best.region,
                        str(best.value)[:40])

            has_conflict = field in conflicts

            best_value = self._clean_name(best.value) if field in ('gmfmc', 'xsfmc') else best.value

            if has_conflict:
                result[field] = best_value
            elif best.confidence >= _CONFIDENCE_AUTO_PASS:
                result[field] = best_value
            elif best.confidence >= _CONFIDENCE_NEED_CONFIRM:
                result[field] = best_value
            else:
                result[field] = ''

        return result

    def _resolve_tax_id_conflict(self, candidates):
        """[FIX] 税号冲突安全网：当 gmfsh 和 xsfsh 被绑定为同一值时

        利用位置关系（buyer_region vs seller_region）重新分配税号。
        """
        gmfsh_cands = [c for c in candidates if c.field == 'gmfsh' and c.value]
        xsfsh_cands = [c for c in candidates if c.field == 'xsfsh' and c.value]

        if not gmfsh_cands or not xsfsh_cands:
            return candidates

        # 检查是否真的冲突（最佳值相同）
        gmfsh_best = max(gmfsh_cands, key=lambda c: c.score)
        xsfsh_best = max(xsfsh_cands, key=lambda c: c.score)

        if gmfsh_best.value != xsfsh_best.value:
            return candidates

        # 冲突！利用位置关系重新分配
        # buyer_region 的税号 → gmfsh, seller_region 的税号 → xsfsh
        region = self._ctx.region
        buyer_region_set = set(id(t) for t in (region.buyer_region or []))
        seller_region_set = set(id(t) for t in (region.seller_region or []))

        # 为每个候选找到它对应的 region
        for c in gmfsh_cands + xsfsh_cands:
            if c.bbox:
                # 用 bbox 中心点判断在哪个 region
                cx = (c.bbox['x0'] + c.bbox['x1']) / 2
                cy = (c.bbox['y0'] + c.bbox['y1']) / 2
                # 找最近的 region token
                in_buyer = any(
                    abs(_cx(t) - cx) < 50 and abs(_cy(t) - cy) < 50
                    for t in (region.buyer_region or [])
                )
                in_seller = any(
                    abs(_cx(t) - cx) < 50 and abs(_cy(t) - cy) < 50
                    for t in (region.seller_region or [])
                )
                if in_buyer and not in_seller:
                    c.field = 'gmfsh'
                elif in_seller and not in_buyer:
                    c.field = 'xsfsh'

        return candidates

    def _anchor_distance(self, candidate, field):
        """[FIX] 计算候选与对应锚点的空间距离（用于平局决胜）

        距离越小越好；无位置信息时返回最大值。
        读取: self._ctx.anchor (AnchorContext), self._ctx.score (ScoreContext)
        """
        anchor_ctx = self._ctx.anchor
        role = 'buyer' if field in ('gmfmc', 'gmfsh') else 'seller'
        anchor = anchor_ctx.buyer_anchor if role == 'buyer' else anchor_ctx.seller_anchor
        if not anchor:
            return 999999.0

        anchor_cx = _cx(anchor)
        anchor_cy = _cy(anchor)

        # 优先使用 bbox
        if candidate.bbox:
            cx = (candidate.bbox['x0'] + candidate.bbox['x1']) / 2
            cy = (candidate.bbox['y0'] + candidate.bbox['y1']) / 2
            return math.hypot(cx - anchor_cx, cy - anchor_cy)

        # 回退到 line_index → structured_line
        if candidate.line_index is not None:
            sl = self._ctx.score.structured_line_map.get(candidate.line_index)
            if sl and hasattr(sl, 'cx') and hasattr(sl, 'cy'):
                return math.hypot(sl.cx - anchor_cx, sl.cy - anchor_cy)

        return 999999.0

    def _detect_conflicts(self, candidates):
        conflicts = set()
        warnings = []

        def get_best_value(field_name):
            field_candidates = [c for c in candidates if c.field == field_name and c.value]
            if not field_candidates:
                return None
            field_candidates.sort(key=lambda c: c.score, reverse=True)
            return field_candidates[0].value

        gmfmc_best = get_best_value('gmfmc')
        xsfmc_best = get_best_value('xsfmc')
        gmfsh_best = get_best_value('gmfsh')
        xsfsh_best = get_best_value('xsfsh')

        if gmfmc_best and xsfmc_best and gmfmc_best == xsfmc_best:
            conflicts.add('gmfmc')
            conflicts.add('xsfmc')
            logger.warning("[PartyExtractor] 冲突：买卖方名称相同 %s", gmfmc_best)

        if gmfsh_best and xsfsh_best and gmfsh_best == xsfsh_best:
            conflicts.add('gmfsh')
            conflicts.add('xsfsh')
            logger.warning("[PartyExtractor] 冲突：买卖方税号相同 %s", gmfsh_best)

        if gmfmc_best and xsfmc_best and gmfmc_best != xsfmc_best:
            sim = self._name_similarity(gmfmc_best, xsfmc_best)
            if sim > _SIMILARITY_THRESHOLD:
                warnings.append(
                    f"疑似相同：买卖方名称相似度 {sim:.2f}，"
                    f"购买方={gmfmc_best}，销售方={xsfmc_best}")
                logger.warning(
                    "[PartyExtractor] 疑似相同：买卖方名称相似度 %.2f，"
                    "购买方=%s，销售方=%s", sim, gmfmc_best, xsfmc_best)

        if gmfsh_best and xsfsh_best and gmfsh_best != xsfsh_best:
            sh_sim = self._tax_similarity(gmfsh_best, xsfsh_best)
            if sh_sim > 0.8:
                warnings.append(
                    f"疑似相同：买卖方税号相似度 {sh_sim:.2f}，"
                    f"购买方={gmfsh_best}，销售方={xsfsh_best}")
                logger.warning(
                    "[PartyExtractor] 疑似相同：买卖方税号相似度 %.2f，"
                    "购买方=%s，销售方=%s", sh_sim, gmfsh_best, xsfsh_best)

        return conflicts, warnings

    def _name_similarity(self, name1, name2):
        if not name1 or not name2:
            return 0.0

        def normalize(s):
            for suffix in _COMPANY_SUFFIX_LIST:
                s = s.replace(suffix, '')
            chars = set(c for c in s if c.isalnum() or c in '（）()')
            return chars

        def char_seq(s):
            return [c for c in s if c.isalnum()]

        set1, set2 = normalize(name1), normalize(name2)
        if not set1 or not set2:
            return 0.0

        # Jaccard 相似度（字符集层面）
        intersection = len(set1 & set2)
        union = len(set1 | set2)
        jaccard = intersection / union if union > 0 else 0.0

        # [FIX] LCS 比率（保留顺序信息，防止"北京科技"与"科技北京"得分 1.0）
        seq1, seq2 = char_seq(name1), char_seq(name2)
        lcs_len = _lcs_length(seq1, seq2)
        max_len = max(len(seq1), len(seq2))
        lcs_ratio = lcs_len / max_len if max_len > 0 else 0.0

        return 0.5 * jaccard + 0.5 * lcs_ratio

    def _tax_similarity(self, tax1, tax2):
        if not tax1 or not tax2:
            return 0.0

        t1 = tax1.replace(' ', '').replace('-', '').upper()
        t2 = tax2.replace(' ', '').replace('-', '').upper()

        if len(t1) != len(t2):
            return 0.0

        if t1[:6] != t2[:6]:
            return 0.0

        sub1, sub2 = t1[6:], t2[6:]
        matches = sum(1 for a, b in zip(sub1, sub2) if a == b)
        return matches / len(sub1) if sub1 else 0.0

    def _build_field_meta(self, candidates, result, conflicts=None, warnings=None):
        field_meta = {}
        if conflicts is None or warnings is None:
            conflicts, warnings = self._detect_conflicts(candidates)

        for field in ['gmfmc', 'gmfsh', 'xsfmc', 'xsfsh']:
            field_candidates = [c for c in candidates if c.field == field and c.value]

            if not field_candidates:
                continue

            field_candidates.sort(key=lambda c: c.score, reverse=True)
            best = field_candidates[0]

            has_conflict = field in conflicts
            status = ('auto_pass' if best.confidence >= _CONFIDENCE_AUTO_PASS and not has_conflict
                      else 'need_confirm' if best.confidence >= _CONFIDENCE_NEED_CONFIRM or has_conflict
                      else 'failed')

            for c in field_candidates[1:]:
                c.rejected = True
                c.reject_reason = '得分低于最高候选'

            field_meta[field] = {
                'value': result.get(field, ''),
                'confidence': best.confidence,
                'source': best.source,
                'status': status,
                'has_conflict': has_conflict,
                'candidates': [c.to_dict() for c in field_candidates],
                'warnings': []
            }

            if has_conflict:
                if field in ('gmfmc', 'xsfmc'):
                    field_meta[field]['warnings'].append('买卖方名称相同，请确认')
                else:
                    field_meta[field]['warnings'].append('买卖方税号相同，请确认')

            if best.confidence < _CONFIDENCE_NEED_CONFIRM:
                field_meta[field]['warnings'].append(
                    f'置信度 {best.confidence:.2f} 低于阈值 {_CONFIDENCE_NEED_CONFIRM}')

        if warnings:
            field_meta['_warnings'] = warnings

        # 注入区域划分调试信息（读取 RegionContext 和 AnchorContext）
        region_debug = self._ctx.region.region_debug
        anchor_diag = self._ctx.anchor.anchor_diag
        if self._ctx and region_debug:
            if anchor_diag:
                region_debug['anchor_diag'] = anchor_diag
            field_meta['_region_debug'] = region_debug

        return field_meta

    # ═══════════════════════════════════════════════════════
    # 辅助方法
    # ═══════════════════════════════════════════════════════

    def _token_to_bbox(self, token):
        if not token:
            return None
        return {
            'x0': _get_token_attr(token, 'x0', 0),
            'y0': _get_token_attr(token, 'y0', 0),
            'x1': _get_token_attr(token, 'x1', 0),
            'y1': _get_token_attr(token, 'y1', 0),
        }

    # [FIX] 新增：备注区内容检测
    @staticmethod
    def _is_remark_content(text: str) -> bool:
        """判断文本是否属于备注区内容（订单号、收件地址、银行账户等）"""
        if not text:
            return False
        for kw in _REMARK_LINE_KEYWORDS:
            if kw in text:
                return True
        # 匹配"购方:"后面跟地址/电话/银行（备注中的购方信息）
        if re.search(r'购\s*方\s*[:：]\s*[\u4e00-\u9fa5].*\d{5,}', text):
            return True
        # 匹配"销方:"后面跟地址/电话/银行
        if re.search(r'销\s*方\s*[:：]\s*[\u4e00-\u9fa5].*\d{5,}', text):
            return True
        # 匹配银行账号（16-19位纯数字）
        if re.search(r'\b\d{16,19}\b', text):
            return True
        return False

    def _find_anchors(self, tokens, line_y=None, footer_y=None):
        """查找购买方和销售方锚点（委托到 AnchorDetector）
        
        写入: self._ctx.anchor (AnchorContext)
        """
        detector = AnchorDetector(
            line_y=line_y,
            footer_y=footer_y,
            buyer_anchors=_BUYER_ANCHORS,
            seller_anchors=_SELLER_ANCHORS,
            company_suffix_list=_COMPANY_SUFFIX_LIST,
        )
        ba, sa = detector.detect(tokens)
        # 将诊断信息写入 AnchorContext
        self._ctx.anchor.anchor_diag = detector.diagnostics.to_dict()
        return ba, sa

    def _page_bounds(self, tokens):
        valid = [t for t in tokens if _token_text(t)]
        if not valid:
            return 0, 0, 1000, 1000
        return (min(_get_token_attr(t, 'x0', 0) for t in valid),
                min(_get_token_attr(t, 'y0', 0) for t in valid),
                max(_get_token_attr(t, 'x1', 0) for t in valid),
                max(_get_token_attr(t, 'y1', 0) for t in valid))

    def _find_line_item_y(self, tokens) -> Optional[float]:
        best = None
        for t in tokens:
            if _token_text(t) in _LINE_ITEM_KEYWORDS:
                cy = _cy(t)
                if best is None or cy < best:
                    best = cy
        return best

    def _find_footer_y(self, tokens) -> Optional[float]:
        best = None
        for t in tokens:
            if any(kw in _token_text(t) for kw in _FOOTER_ANCHORS):
                cy = _cy(t)
                if best is None or cy < best:
                    best = cy
        return best

    def _precompute_inv_id_positions(self, tokens):
        return [(_cx(t), _cy(t)) for t in tokens
                if any(kw in _token_text(t) for kw in _INVOICE_ID_KEYWORDS)]

    def _near_inv_id(self, token, positions, radius=80):
        tcx, tcy = _cx(token), _cy(token)
        return any(math.hypot(tcx - ix, tcy - iy) < radius
                   for ix, iy in positions)

    def _find_right_label_x(self, tokens, anchor, labels):
        """[FIX] 找锚点右侧最近的标签 token 的 x0 坐标

        用于全电发票同行水平分割时确定 split_x。
        """
        acx, acy = _cx(anchor), _cy(anchor)
        best_x = None
        best_dist = float('inf')
        row_tol = 20  # 同行容差像素
        for t in tokens:
            text = _token_text(t).strip()
            if text not in labels:
                continue
            tcx, tcy = _cx(t), _cy(t)
            # 同行且在锚点右侧
            if abs(tcy - acy) < row_tol and tcx > acx:
                dist = tcx - acx
                if dist < best_dist:
                    best_dist = dist
                    best_x = _get_token_attr(t, 'x0', tcx)
        return best_x

    def _find_anchor_text(self, lines, anchors):
        """查找文本行中的锚点索引

        [FIX] 增加备注区过滤，防止 "购方:地址..." 被误匹配为锚点。
        [FIX] 字符级竖排检测，支持空行容错和锚点长度上限。
        """
        # 1. 水平匹配逻辑
        for i, line in enumerate(lines):
            stripped = line.strip()
            if not stripped:
                continue
            if self._is_remark_content(stripped):
                continue
            match = _fuzzy_match(stripped, anchors)
            if match:
                if len(stripped) > len(match) * 3:
                    continue
                return i

        # 2. 字符级竖排检测
        return self._detect_vertical_anchors(lines, anchors)

    def _detect_vertical_anchors(self, lines, anchors):
        """字符级竖排锚点检测
    
        [FIX] 拆分为单锚点检测方法，长锚点优先但允许短锚点 fallback。
        """
        for anchor in anchors:
            result = self._try_vertical_anchor(lines, anchor)
            if result >= 0:
                return result
    
        # 兆底：关键词匹配，精确计算偏移
        combined_all = ''.join(lines[i].strip() for i in range(len(lines)) if lines[i].strip())
        for kw in ['购买方', '销售方']:
            kw_pos = combined_all.find(kw)
            if kw_pos >= 0:
                char_count = 0
                for i, line in enumerate(lines):
                    stripped = line.strip()
                    if kw_pos < char_count + len(stripped):
                        return i
                    char_count += len(stripped)
    
        return -1
    
    def _try_vertical_anchor(self, lines, anchor):
        """尝试匹配单个竖排锚点"""
        anchor_len = len(anchor)
        candidate_start = -1
        candidate_chars = []
        gap_count = 0
        max_gap = 2  # 允许中间跳过1-2行
    
        for i, line in enumerate(lines):
            stripped = line.strip()
    
            is_vertical_candidate = (
                len(stripped) <= 2 and
                stripped and
                not stripped.isdigit() and
                not re.match(r'^[¥￥$]', stripped)
            )
    
            if is_vertical_candidate:
                if candidate_start == -1:
                    candidate_start = i
                candidate_chars.append(stripped)
                gap_count = 0
    
                # 超过锚点长度2倍还没匹配，重置（防止误合并）
                if len(candidate_chars) > anchor_len * 2:
                    candidate_start = -1
                    candidate_chars = []
                    continue
    
                combined = ''.join(candidate_chars)
                if combined == anchor:
                    return candidate_start
            else:
                gap_count += 1
                if gap_count <= max_gap:
                    continue
                candidate_start = -1
                candidate_chars = []
                gap_count = 0
    
        return -1

    def _detect_regions_by_bbox(self, doc):
        """当锚点识别失败时，使用bbox坐标判断买卖方区域

        支持两种分割模式：
        - 竖排模式（top-bottom）：名称/税号标签存在明显的 y 坐标分离（垂直布局发票）
        - 横排模式（left-right）：默认，按页面中线左右分割

        排除顶部10%和底部30%的token（票头票尾干扰）。
        使用中心点判断避免跨区域token的缝隙问题。

        Returns:
            (buyer_tokens, seller_tokens, split_info)
            split_info: str — 'vertical' / 'horizontal' / 'none'
        """
        if not doc.tokens:
            return None, None, 'none'

        # 计算票面边界
        all_y0 = [t.y for t in doc.tokens]
        all_y1 = [t.y1 for t in doc.tokens]
        y_min, y_max = min(all_y0), max(all_y1)
        y_range = y_max - y_min

        # 排除顶部10%和底部30%（票头票尾干扰）
        relevant_tokens = [t for t in doc.tokens
                           if t.y > y_min + y_range * 0.1
                           and t.y1 < y_max - y_range * 0.3]

        if not relevant_tokens:
            relevant_tokens = doc.tokens

        # ── 检测垂直布局：通过名称/税号标签的 y 坐标聚类 ──
        all_labels = set(NAME_LABELS + TAX_LABELS)
        label_tokens = [t for t in relevant_tokens
                        if _token_text(t).strip() in all_labels]

        if len(label_tokens) >= 2:
            # 按 y 坐标聚类（tolerance = 页面高度的 5%）
            y_tol = y_range * 0.05
            sorted_labels = sorted(label_tokens, key=lambda t: _cy(t))
            clusters = []
            current = [sorted_labels[0]]
            for t in sorted_labels[1:]:
                if _cy(t) - _cy(current[-1]) < y_tol:
                    current.append(t)
                else:
                    clusters.append(current)
                    current = [t]
            clusters.append(current)

            # 如果存在 >= 2 个明显分离的 y 簇 → 竖排模式
            if len(clusters) >= 2:
                split_y = (_cy(clusters[0][-1]) + _cy(clusters[1][0])) / 2
                buyer_tokens = [t for t in doc.tokens if _cy(t) <= split_y]
                seller_tokens = [t for t in doc.tokens if _cy(t) > split_y]
                logger.info("[DETECT_BBOX] 竖排分割(标签聚类): %d 个标签簇, split_y=%.1f",
                            len(clusters), split_y)
                return buyer_tokens, seller_tokens, 'vertical'

        # ── 布局方向判断：通过 x_spread / y_spread 比较 ──
        # 当标签缺失时，根据相关区域的几何扩散方向判断布局
        x_spread = max(_cx(t) for t in relevant_tokens) - min(_cx(t) for t in relevant_tokens)
        y_spread = max(_cy(t) for t in relevant_tokens) - min(_cy(t) for t in relevant_tokens)

        if x_spread > y_spread:
            # ── 横向布局：中线 X 分割，左=购买方 ──
            all_x0 = [t.x for t in relevant_tokens]
            all_x1 = [t.x1 for t in relevant_tokens]
            mid_x = (min(all_x0) + max(all_x1)) / 2

            buyer_tokens = [t for t in doc.tokens if t.cx < mid_x]
            seller_tokens = [t for t in doc.tokens if t.cx >= mid_x]

            logger.info("[DETECT_BBOX] 横排分割(坐标回退): mid_x=%.1f x_spread=%.1f y_spread=%.1f labels=%d",
                        mid_x, x_spread, y_spread, len(label_tokens))
            return buyer_tokens, seller_tokens, 'horizontal'
        else:
            # ── 竖排布局：中线 Y 分割，上=购买方 ──
            all_y0_rel = [t.y for t in relevant_tokens]
            all_y1_rel = [t.y1 for t in relevant_tokens]
            mid_y = (min(all_y0_rel) + max(all_y1_rel)) / 2

            buyer_tokens = [t for t in doc.tokens if _cy(t) < mid_y]
            seller_tokens = [t for t in doc.tokens if _cy(t) >= mid_y]

            logger.info("[DETECT_BBOX] 竖排分割(坐标回退): mid_y=%.1f x_spread=%.1f y_spread=%.1f labels=%d",
                        mid_y, x_spread, y_spread, len(label_tokens))
            return buyer_tokens, seller_tokens, 'vertical'

    @staticmethod
    def _skip_anchor_lines(lines, idx):
        if len(lines[idx].strip()) <= 2:
            c = 0
            for j in range(idx, len(lines)):
                if len(lines[j].strip()) <= 2:
                    c += 1
                else:
                    break
            return c
        return 1

    def _extract_tax_line(self, line):
        m = _UNIFIED_TAX_RE.search(line)
        if m and self._tax_ok(m.group(1).strip()):
            return m.group(1).strip()
        m = _TAX_ID_ONLY_RE.search(line)
        if m and self._tax_ok(m.group(1).strip()):
            return m.group(1).strip()
        m = re.search(r'税号[:：]\s*([A-Z0-9]{15,20})', line, re.IGNORECASE)
        if m and self._tax_ok(m.group(1).strip()):
            return m.group(1).strip()
        m = _STANDALONE_TAX_ID_RE.match(line)
        if m and self._tax_ok(m.group(0).strip().upper()):
            return m.group(0).strip().upper()
        return None

    def _extract_all_tax_lines(self, line, inv_positions=None):
        """提取行内所有税号候选

        [FIX] 税号必须包含至少一个字母；纯数字串一律不是税号（发票号码/代码）
        """
        tax_ids = []

        def _is_valid_tax(t):
            """校验：非空 + 格式合法 + 不是纯数字"""
            return self._tax_ok(t) and not t.isdigit()

        for m in re.finditer(r'税号[:：]\s*([A-Z0-9]{15,20})', line, re.IGNORECASE):
            t = m.group(1).strip()
            if _is_valid_tax(t):
                tax_ids.append(t)

        for m in _TAX_ID_ONLY_RE.finditer(line):
            t = m.group(1).strip()
            if _is_valid_tax(t) and t not in tax_ids:
                tax_ids.append(t)

        for m in _UNIFIED_TAX_RE.finditer(line):
            t = m.group(1).strip()
            if _is_valid_tax(t) and t not in tax_ids:
                tax_ids.append(t)

        for m in re.finditer(r'\b[A-Z0-9]{15,20}\b', line, re.IGNORECASE):
            t = m.group(0).strip().upper()
            if _is_valid_tax(t) and t not in tax_ids:
                tax_ids.append(t)

        return tax_ids

    # ═══════════════════════════════════════════════════════════
    # L4 坐标增强辅助方法
    # ═══════════════════════════════════════════════════════════

    def _find_label_in_line(self, line_obj, labels):
        if not line_obj or not hasattr(line_obj, 'tokens') or not line_obj.tokens:
            return None
        for token in line_obj.tokens:
            text = token.text.strip() if hasattr(token, 'text') else str(token).strip()
            for label in labels:
                if label in text:
                    return token
        return None

    @staticmethod
    def _is_right_of_label(value, label_token, line_obj=None):
        if not label_token:
            return False
        label_x1 = label_token.x1 if hasattr(label_token, 'x1') else 0
        if line_obj and hasattr(line_obj, 'tokens') and line_obj.tokens:
            for token in line_obj.tokens:
                t_text = token.text.strip() if hasattr(token, 'text') else ''
                t_x0 = token.x0 if hasattr(token, 'x0') else 0
                if t_text and t_text in value and t_x0 > label_x1 - 5:
                    return True
        return False

    def _vertical_position_score(self, line_cy, page_height, role):
        if page_height <= 0:
            return 0
        relative_y = line_cy / page_height
        if role == 'buyer' and relative_y < 0.5:
            return _SCORE_L4_POSITION
        if role == 'seller' and relative_y > 0.4:
            return _SCORE_L4_POSITION
        return 0

    def _find_nearest_anchor(self, line_obj, anchor_keywords, all_lines):
        if not line_obj or not all_lines:
            return 999999
        min_dist = 999999
        for other in all_lines:
            text = other.text if hasattr(other, 'text') else str(other)
            if any(kw in text for kw in anchor_keywords):
                dist = abs(line_obj.cy - other.cy)
                min_dist = min(min_dist, dist)
        return min_dist

    def _is_value_right_of_label_in_line(self, line_obj, value, label_keywords):
        if not line_obj or not hasattr(line_obj, 'tokens') or not line_obj.tokens:
            return False

        tokens = line_obj.tokens
        label_token = None
        for token in tokens:
            text = token.text.strip() if hasattr(token, 'text') else ''
            if any(kw in text for kw in label_keywords):
                label_token = token
                break

        if not label_token:
            return False

        label_x1 = label_token.x1 if hasattr(label_token, 'x1') else 0

        right_tokens = []
        for token in tokens:
            t_text = token.text.strip() if hasattr(token, 'text') else ''
            t_x0 = token.x0 if hasattr(token, 'x0') else 0
            if t_text and t_x0 >= label_x1 - 5:
                right_tokens.append(t_text)

        for t_text in right_tokens:
            if t_text == value:
                return True
            if len(t_text) >= 4 and value.startswith(t_text):
                return True
            if len(t_text) >= 4 and value.endswith(t_text):
                return True

        if right_tokens:
            combined = ''.join(right_tokens)
            if combined == value:
                return True
            if len(value) >= 4 and combined.startswith(value):
                return True

        return False

    def _extract_label_right_values(self, structured_lines,
                                     buyer_anchor_line=None,
                                     seller_anchor_line=None):
        results = []
        if not structured_lines:
            return results

        buyer_cy = buyer_anchor_line.cy if buyer_anchor_line else None
        seller_cy = seller_anchor_line.cy if seller_anchor_line else None
        if buyer_cy is None and seller_cy is None:
            return results

        for sl in structured_lines:
            if not hasattr(sl, 'tokens') or not sl.tokens:
                continue

            if buyer_cy is not None and seller_cy is not None:
                midpoint = (buyer_cy + seller_cy) / 2
                role = 'buyer' if sl.cy <= midpoint else 'seller'
            elif buyer_cy is not None:
                role = 'buyer'
            else:
                role = 'seller'

            name_field = 'gmfmc' if role == 'buyer' else 'xsfmc'
            tax_field = 'gmfsh' if role == 'buyer' else 'xsfsh'

            name_label = self._find_label_in_line(sl, _NAME_LABELS)
            if name_label:
                val = self._join_tokens_right_of_label(sl, name_label)
                label_text = name_label.text.strip() if hasattr(name_label, 'text') else ''
                if val and self._name_ok(self._clean_name(val)) \
                        and not self._is_value_similar_to_label(val, label_text):
                    results.append((name_field, self._clean_name(val),
                                    '全电发票标签右侧直接提取（名称）'))

            tax_label = self._find_label_in_line(sl, _TAX_LABELS)
            if tax_label:
                val = self._join_tokens_right_of_label(sl, tax_label)
                label_text = tax_label.text.strip() if hasattr(tax_label, 'text') else ''
                if val and self._tax_ok(val) \
                        and not self._is_value_similar_to_label(val, label_text):
                    results.append((tax_field, val,
                                    '全电发票标签右侧直接提取（税号）'))

        return results

    def _is_value_similar_to_label(self, value, label_text):
        if not value or not label_text:
            return False

        value_clean = value.strip()
        label_clean = label_text.strip()

        # [FIX] 最小长度约束：短值可能是合法提取，不做相似度检查
        if len(value_clean) < 4:
            return False

        if value_clean in label_clean:
            return True

        if label_clean in value_clean and len(label_clean) >= len(value_clean) * _LABEL_VALUE_RATIO_THRESHOLD:
            return True

        value_chars = set(value_clean)
        label_chars = set(label_clean)
        if not value_chars or not label_chars:
            return False

        intersection = value_chars & label_chars
        union = value_chars | label_chars
        jaccard_sim = len(intersection) / len(union)

        return jaccard_sim > _JACCARD_THRESHOLD

    @staticmethod
    def _join_tokens_right_of_label(line_obj, label_token):
        label_x1 = label_token.x1 if hasattr(label_token, 'x1') else 0
        label_cy = (
            (label_token.y0 + label_token.y1) / 2
            if hasattr(label_token, 'y0') and hasattr(label_token, 'y1')
            else 0
        )
        right_tokens = []
        for t in line_obj.tokens:
            t_x0 = t.x0 if hasattr(t, 'x0') else 0
            t_cy = (
                (t.y0 + t.y1) / 2
                if hasattr(t, 'y0') and hasattr(t, 'y1')
                else 0
            )
            if t_x0 >= label_x1 - 5 and abs(t_cy - label_cy) < 30:
                right_tokens.append(t)

        if not right_tokens:
            return ''

        right_tokens.sort(key=lambda t: t.x0 if hasattr(t, 'x0') else 0)
        return ''.join(
            t.text.strip() if hasattr(t, 'text') else '' for t in right_tokens
        )

    # ═══════════════════════════════════════════════════════════
    # 后置交叉验证
    # ═══════════════════════════════════════════════════════════

    def _find_name_center_x(self, name: str, tokens: List) -> Optional[float]:
        """在 tokens 中查找名称的中心 x 坐标"""
        if not name or not tokens:
            return None

        for t in tokens:
            token_text = _token_text(t).strip()
            if name in token_text or token_text in name:
                return _cx(t)

        return None

    def _validate_party_sides(self, buyer_name: str, seller_name: str, tokens: List) -> Tuple[Tuple[str, str], str]:
        """验证买卖方名称是否来自正确的页面半区

        如果买方在右、卖方在左，大概率反了，需要交换。

        Args:
            buyer_name: 购买方名称
            seller_name: 销售方名称
            tokens: 所有 token 列表

        Returns:
            (buyer_name, seller_name), status
            status: "ok" 或 "swapped"
        """
        if not buyer_name or not seller_name:
            return (buyer_name, seller_name), "ok"

        buyer_cx = self._find_name_center_x(buyer_name, tokens)
        seller_cx = self._find_name_center_x(seller_name, tokens)

        if buyer_cx is None or seller_cx is None:
            logger.warning("[VALIDATE_PARTY_SIDES] 无法找到名称的中心坐标: buyer=%s seller=%s",
                          buyer_name[:20] if buyer_name else 'None',
                          seller_name[:20] if seller_name else 'None')
            return (buyer_name, seller_name), "ok"

        if buyer_cx > seller_cx:
            # 买方在右、卖方在左 → 大概率反了
            logger.info("[VALIDATE_PARTY_SIDES] 检测到买卖方可能反了: buyer_cx=%.1f > seller_cx=%.1f",
                       buyer_cx, seller_cx)
            logger.info("[VALIDATE_PARTY_SIDES] 交换买卖方: %s <-> %s",
                       buyer_name[:20], seller_name[:20])
            return (seller_name, buyer_name), "swapped"

        return (buyer_name, seller_name), "ok"

    # ═══════════════════════════════════════════════════════════
    # 格式校验（委托到 NameCleaner）
    # ═══════════════════════════════════════════════════════════

    def _name_ok(self, name) -> bool:
        """判断文本是否可能是公司名（委托到 NameCleaner）"""
        return NameCleaner.name_ok(name, company_keywords=frozenset(self._COMPANY_KEYWORDS))

    def _is_likely_goods(self, name) -> bool:
        """判断文本是否可能是商品名（委托到 NameCleaner）"""
        return NameCleaner.is_likely_goods(name, goods_keywords=self._GOODS_KEYWORDS)

    def _is_bank_branch(self, name) -> bool:
        """判断是否为银行支行/分行（委托到 NameCleaner）"""
        return NameCleaner.is_bank_branch(name)

    def _tax_ok(self, tax) -> bool:
        """判断税号格式是否合法（委托到 NameCleaner）"""
        return NameCleaner.tax_ok(tax)

    @staticmethod
    def _clean_name(name: str) -> str:
        """清理公司名文本（委托到 NameCleaner）"""
        return NameCleaner.clean_name(name)

    @staticmethod
    def _remove_label_tokens(region: list) -> list:
        """过滤区域中的标签 token，避免污染名称/税号候选

        如"名称：""统一社会信用代码/纳税人识别号"等标签文本，
        不应作为公司名或税号的候选值。
        """
        _LABEL_PAT = re.compile(
            r'名称\s*[:：]|统一社会信用代码|纳税人识别号|'
            r'购买方信息|销售方信息|下载次数|全数'
        )
        filtered = [t for t in region if not _LABEL_PAT.search(_token_text(t))]
        if len(filtered) != len(region):
            removed = len(region) - len(filtered)
            logger.info("[RemoveLabelTokens] 移除%d个标签token: %s -> %s",
                        removed, len(region), len(filtered))
        return filtered

    # ═══════════════════════════════════════════════════════════
    # 区域构建
    # ═══════════════════════════════════════════════════════════

    def _build_regions(self, tokens, ba, sa, px0, py0, px1, py1, line_y, footer_y):
        """
        构建购买方/销售方区域（Strategy Pattern Dispatcher）
    
        前置处理：
        1. 锚点合理性验证（cy_diff > 45% 页面高度时怀疑锚点位置）
        2. 双锚点同行拆分（OCR 将买卖方合并为单个 token 时）
        3. 计算 cy_diff 和 ndx 用于策略选择
    
        策略委托：
        通过 select_region_strategy() 工厂选择具体策略类，然后调用 strategy.build()
        """
        logger.info("[BUILD_REGIONS] tokens=%d ba=%s sa=%s px0=%.1f py0=%.1f px1=%.1f py1=%.1f line_y=%s footer_y=%s",
                    len(tokens),
                    _get_token_attr(ba, 'text', '')[:30] if ba else 'None',
                    _get_token_attr(sa, 'text', '')[:30] if sa else 'None',
                    px0, py0, px1, py1, line_y, footer_y)
    
        # ── 锚点合理性验证 ──
        cy_diff = 0.0
        ndx = 0.0
        if ba and sa:
            cy_diff = abs(_cy(ba) - _cy(sa))
            ndx = abs(_cx(ba) - _cx(sa)) / max(px1 - px0, 1)
            page_height = py1 - py0
            y_threshold = min(_REGION_SPLIT_Y_THRESHOLD, page_height * _REGION_SPLIT_Y_RATIO)
    
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug(
                    "[BUILD_REGIONS] ba_text=%s cy=%.1f"
                    " | sa_text=%s cy=%.1f"
                    " | cy_diff=%.1f ndx=%.3f"
                    " | y_threshold=%.1f page_height=%.1f"
                    " | page_width=%.1f",
                    _get_token_attr(ba, 'text', '')[:20], _cy(ba),
                    _get_token_attr(sa, 'text', '')[:20], _cy(sa),
                    cy_diff, ndx, y_threshold, page_height,
                    px1 - px0,
                )
    
            # [FIX] 修复死代码：先计算再赋值，避免 ba=None 后 sa 判断失效
            if cy_diff > page_height * 0.45:
                ba_cy_saved = _cy(ba)
                sa_cy_saved = _cy(sa)
                lower_threshold = py0 + page_height * 0.55
    
                # 买家在下半页 → 锚点可疑
                ba_suspicious = ba_cy_saved > lower_threshold
                # 卖家在上半页（<35%）→ 锚点可疑
                sa_suspicious = sa_cy_saved < py0 + page_height * 0.35
    
                if ba_suspicious:
                    ba = None
                if sa_suspicious:
                    sa = None
    
            # [FIX] 双锚点同行拆分：当 ba 和 sa 是同一个 token 时
            # （OCR 将“购买方信息”和“销售方信息”合并为单个 token），
            # 根据文本中锚点关键词的位置拆分为两个合成锚点，
            # 使 ndx > 0.1 条件得以满足。
            if ba is not None and sa is not None and ba is sa:
                text = _get_token_attr(ba, 'text', '').strip()
                buyer_pos = -1
                seller_pos = -1
                for kw in _BUYER_ANCHORS:
                    pos = text.find(kw)
                    if pos >= 0:
                        buyer_pos = pos
                        break
                for kw in _SELLER_ANCHORS:
                    pos = text.find(kw)
                    if pos >= 0:
                        seller_pos = pos
                        break
    
                if buyer_pos >= 0 and seller_pos >= 0 and buyer_pos != seller_pos:
                    x0 = _get_token_attr(ba, 'x0', 0)
                    x1 = _get_token_attr(ba, 'x1', 0)
                    token_width = x1 - x0
                    text_len = max(len(text), 1)
                    cy = _cy(ba)
                    half_h = _h(ba) / 2
    
                    buyer_x = x0 + (buyer_pos / text_len) * token_width
                    seller_x = x0 + (seller_pos / text_len) * token_width
    
                    ba = {'text': 'buyer_split', 'x0': buyer_x, 'y0': cy - half_h,
                          'x1': buyer_x + 10, 'y1': cy + half_h}
                    sa = {'text': 'seller_split', 'x0': seller_x, 'y0': cy - half_h,
                          'x1': seller_x + 10, 'y1': cy + half_h}
    
                    cy_diff = abs(_cy(ba) - _cy(sa))
                    ndx = abs(_cx(ba) - _cx(sa)) / max(px1 - px0, 1)
    
        # ── 策略选择与委托 ──
        bounds = Bounds(px0=px0, py0=py0, px1=px1, py1=py1, line_y=line_y, footer_y=footer_y)
        strategy_cls = select_region_strategy(ba, sa, bounds, ndx, cy_diff)
    
        logger.info("[BUILD_REGIONS] → 选择策略: %s (cy_diff=%.1f, ndx=%.3f, ba=%s, sa=%s)",
                    strategy_cls.__name__, cy_diff, ndx, bool(ba), bool(sa))
    
        buyer_region, seller_region, region_debug = strategy_cls.build(tokens, ba, sa, bounds)
        # 将调试信息写入 RegionContext
        self._ctx.region.region_debug = region_debug
        return buyer_region, seller_region
