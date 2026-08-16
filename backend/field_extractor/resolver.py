"""
字段决策器（FieldResolver）

从所有 extractor 返回的候选列表中，做全局决策：
  1. 按字段分组
  2. 同组内按 score 排序，选最高分
  3. 跨字段排斥检测（token_ids 重叠时保留高分字段）
  4. 输出最终字段值 + 置信度
"""
import logging
from typing import Dict, List, Tuple
from collections import defaultdict

from .candidates import FieldCandidate
from .models import OCRDocument

logger = logging.getLogger(__name__)

# 互斥规则：这些字段不能共享相同的值或 token
_MUTUAL_EXCLUSION_RULES = [
    # (field_a, field_b, exclusion_type)
    ('fphm', 'gmfsh', 'value'),        # 发票号码 ≠ 购买方税号
    ('fphm', 'xsfsh', 'value'),        # 发票号码 ≠ 销售方税号
    ('gmfmc', 'xsfmc', 'value'),       # 购买方名称 ≠ 销售方名称
    ('gmfsh', 'xsfsh', 'value'),       # 购买方税号 ≠ 销售方税号（允许但需警告）
]


class FieldResolver:
    """全局字段决策器"""

    def resolve(
        self,
        candidates: List[FieldCandidate],
        doc: OCRDocument = None,
    ) -> Tuple[Dict[str, str], Dict[str, float], List[FieldCandidate]]:
        """从候选列表中决策最终字段值。

        Args:
            candidates: 所有 extractor 返回的候选列表
            doc: OCRDocument（用于上下文校验）

        Returns:
            (resolved_fields, confidence_map, all_candidates)
            - resolved_fields: {field_name: value}
            - confidence_map: {field_name: confidence}
            - all_candidates: 原始候选列表（供 Validator 使用）
        """
        if not candidates:
            return {}, {}, []

        # Step 1: 按字段分组
        grouped: Dict[str, List[FieldCandidate]] = defaultdict(list)
        for c in candidates:
            if c.value:  # 跳过空值候选
                grouped[c.field].append(c)

        # Step 2: 每组选最高置信度候选（统一用 confidence，0-1 归一化）
        selected: Dict[str, FieldCandidate] = {}
        for field_name, cands in grouped.items():
            cands.sort(key=lambda c: c.confidence, reverse=True)
            selected[field_name] = cands[0]
            if len(cands) > 1:
                logger.debug(
                    "[Resolver] %s: selected '%s' (score=%.1f) over %d alternatives",
                    field_name, cands[0].value, cands[0].score, len(cands) - 1,
                )

        # Step 3: 跨字段排斥检测
        self._apply_exclusion(selected)

        # Step 4: 构建输出
        resolved_fields = {}
        confidence_map = {}
        for field_name, cand in selected.items():
            resolved_fields[field_name] = cand.value
            confidence_map[field_name] = cand.confidence

        return resolved_fields, confidence_map, candidates

    def _apply_exclusion(self, selected: Dict[str, FieldCandidate]) -> None:
        """跨字段排斥检测：当两个字段选中相同值时，保留高分字段的候选。"""
        if not selected:
            return

        # [PERF] 预构建值到字段的映射，用于快速检测值冲突
        value_fields = {}
        for field_name, cand in selected.items():
            if cand.value:
                if cand.value not in value_fields:
                    value_fields[cand.value] = []
                value_fields[cand.value].append((field_name, cand))

        # [PERF] 检测值冲突：同一值被多个字段使用
        for value, field_list in value_fields.items():
            if len(field_list) < 2:
                continue

            # 按 score 降序排序，保留最高分字段
            field_list.sort(key=lambda x: x[1].score, reverse=True)
            best_field, best_cand = field_list[0]

            for field_name, cand in field_list[1:]:
                logger.warning(
                    "[Resolver] 值冲突: %s=%r(score=%.1f) vs %s(score=%.1f), 清空 %s",
                    best_field, value, best_cand.score, field_name, cand.score, field_name,
                )
                del selected[field_name]

        # [PERF] token_ids 重叠检测：使用集合进行快速交集操作
        for field_a, field_b, excl_type in _MUTUAL_EXCLUSION_RULES:
            if excl_type != 'token':
                continue

            cand_a = selected.get(field_a)
            cand_b = selected.get(field_b)

            if not cand_a or not cand_b:
                continue

            if cand_a.token_ids and cand_b.token_ids:
                overlap = set(cand_a.token_ids) & set(cand_b.token_ids)
                if overlap:
                    if cand_a.score >= cand_b.score:
                        logger.warning(
                            "[Resolver] Token重叠: %s(score=%.1f) vs %s(score=%.1f), 清空 %s",
                            field_a, cand_a.score, field_b, cand_b.score, field_b,
                        )
                        del selected[field_b]
                    else:
                        logger.warning(
                            "[Resolver] Token重叠: %s(score=%.1f) vs %s(score=%.1f), 清空 %s",
                            field_a, cand_a.score, field_b, cand_b.score, field_a,
                        )
                        del selected[field_a]
