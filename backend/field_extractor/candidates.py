"""
统一候选评分模型

所有 extractor 的提取结果统一为 FieldCandidate 列表，
由 FieldResolver 做全局决策。

候选评分规则：
| 证据 | 加分 |
| --- | --- |
| 与明确标签同行右侧绑定 | +0.40 |
| 位于购买方/销售方锁定区域 | +0.25 |
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
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class FieldCandidate:
    """字段候选项"""
    field: str                          # 字段名: 'fphm', 'gmfmc', 'amountHj' 等
    value: str                          # 候选值
    score: float = 0.0                  # 综合得分 0-100
    confidence: float = 0.0             # 置信度 0.0-1.0
    source: str = ''                    # 来源: bbox_l1_label / bbox_l2_anchor / bbox_l3_region / text_l4
    region: str = ''                    # 来源区域: 'header', 'buyer' 等
    bbox: Optional[dict] = None         # 边界框坐标: {'x0', 'y0', 'x1', 'y1'}
    line_index: Optional[int] = None    # 行索引
    reason: str = ''                    # 评分理由
    rejected: bool = False              # 是否被拒绝
    reject_reason: str = ''             # 拒绝原因
    token_ids: list = field(default_factory=list)  # 关联 token ID（用于排斥）
    meta: dict = field(default_factory=dict)     # 额外元数据

    def __post_init__(self):
        """强制 confidence 与 score 同步（score 是主评分字段，0-100）

        仅在 score > 1 时归一化（避免对已归一化的值做重复计算）。
        """
        if self.score > 1:
            self.confidence = round(self.score / 100.0, 4)
        elif self.confidence:
            self.score = round(self.confidence * 100.0, 2)

    def __repr__(self) -> str:
        return (f"FieldCandidate(field={self.field!r}, value={self.value!r}, "
                f"score={self.score:.1f}, conf={self.confidence:.2f}, "
                f"source={self.source!r}, rejected={self.rejected})")

    def to_dict(self) -> dict:
        """转换为字典，用于输出"""
        result = {
            'field': self.field,
            'value': self.value,
            'score': self.score,
            'confidence': self.confidence,
            'source': self.source,
            'reason': self.reason,
            'rejected': self.rejected,
        }
        if self.bbox:
            result['bbox'] = self.bbox
        if self.line_index is not None:
            result['line_index'] = self.line_index
        if self.reject_reason:
            result['reject_reason'] = self.reject_reason
        if self.region:
            result['region'] = self.region
        return result

    # ─── 工厂方法 ───

    @classmethod
    def simple(cls, field_name: str, value: str, score: float,
               source: str = '', region: str = '') -> 'FieldCandidate':
        """创建简单候选（仅含核心字段）"""
        return cls(
            field=field_name,
            value=value,
            score=score,
            confidence=score / 100.0,
            source=source,
            region=region,
        )

    @classmethod
    def from_amount(cls, candidate, field_name: str = 'amountHj') -> 'FieldCandidate':
        """从 AmountCandidate 转换"""
        return cls(
            field=field_name,
            value=candidate.value,
            score=float(candidate.confidence),
            confidence=candidate.confidence / 100.0,
            source=candidate.source,
            region='summary',
        )

    @classmethod
    def from_tuple(cls, tup: tuple, field_name: str, region: str = '') -> 'FieldCandidate':
        """从 (value, score, source) 元组转换"""
        value, score, source = tup
        return cls(
            field=field_name,
            value=str(value),
            score=float(score),
            confidence=float(score) / 100.0,
            source=source,
            region=region,
        )
