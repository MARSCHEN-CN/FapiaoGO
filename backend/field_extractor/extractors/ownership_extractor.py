# -*- coding: utf-8 -*-
"""
v5 Ownership-Based 字段提取器（实验性）

核心思想：不是"这个字段在哪个区域"，而是"这个字段属于谁"
"""
import logging
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Tuple

logger = logging.getLogger(__name__)


@dataclass
class BBox:
    """边界框"""
    x0: float
    y0: float
    x1: float
    y1: float
    
    @property
    def cx(self) -> float:
        """中心 X 坐标"""
        return (self.x0 + self.x1) / 2
    
    @property
    def cy(self) -> float:
        """中心 Y 坐标"""
        return (self.y0 + self.y1) / 2
    
    @property
    def width(self) -> float:
        return self.x1 - self.x0
    
    @property
    def height(self) -> float:
        return self.y1 - self.y0


@dataclass
class Field:
    """带所有权信息的字段
    
    v5 核心数据结构：每个字段都有 owner_scores，表示它属于 buyer/seller 的概率
    """
    label: str              # "名称", "税号"
    value: str              # "杭州某某科技有限公司"
    bbox: BBox              # 空间位置
    confidence: float = 0.9  # 检测置信度
    
    # ⭐ 所有权评分：{"buyer": 0.85, "seller": 0.15}
    owner_scores: Dict[str, float] = field(default_factory=dict)
    
    @property
    def owner(self) -> Optional[str]:
        """返回最高分的拥有者"""
        if not self.owner_scores:
            return None
        return max(self.owner_scores, key=self.owner_scores.get)
    
    @property
    def owner_confidence(self) -> float:
        """返回最高分的置信度"""
        if not self.owner_scores:
            return 0.0
        return max(self.owner_scores.values())
    
    def __repr__(self):
        return f"Field(label={self.label}, value={self.value[:20]}..., owner={self.owner})"


class OwnershipBasedExtractor:
    """Ownership-Based 提取器（v5 实验版）"""
    
    def __init__(self):
        # 评分权重配置
        self.weights = {
            'vertical_distance': 0.4,   # 垂直距离权重
            'horizontal_alignment': 0.3, # 水平对齐权重
            'label_match': 0.3           # 标签匹配权重
        }
        
        # 距离阈值
        self.vertical_threshold = 100.0  # 垂直距离阈值（像素）
        self.horizontal_overlap_threshold = 0.5  # 水平重叠阈值
    
    def extract_parties(self, tokens: List[Dict], anchors: Dict[str, BBox]) -> Dict[str, Dict[str, Field]]:
        """提取购买方和销售方信息
        
        Args:
            tokens: OCR 识别的 token 列表
            anchors: 锚点位置 {"buyer": BBox, "seller": BBox}
        
        Returns:
            {
                "buyer": {"name": Field, "tax": Field},
                "seller": {"name": Field, "tax": Field}
            }
        """
        logger.info("[OwnershipExtractor] Starting extraction with %d tokens", len(tokens))
        
        # Step 1: 检测所有候选字段
        fields = self._detect_all_fields(tokens)
        logger.info("[OwnershipExtractor] Detected %d candidate fields", len(fields))
        
        if not fields:
            logger.warning("[OwnershipExtractor] No fields detected")
            return {"buyer": {}, "seller": {}}
        
        # Step 2: 计算每个字段的 owner score
        for f in fields:
            f.owner_scores = self._calculate_owner_score(f, anchors)
            logger.debug(
                "[OwnershipExtractor] Field '%s' scores: %s",
                f.value[:30], f.owner_scores
            )
        
        # Step 3: 按 owner 分组
        result = self._group_by_owner(fields)
        
        # Step 4: 交叉验证
        if not self._cross_validate(result):
            logger.warning("[OwnershipExtractor] Cross-validation failed")
        
        logger.info(
            "[OwnershipExtractor] Result: buyer=%s, seller=%s",
            result.get("buyer", {}).get("name"),
            result.get("seller", {}).get("name")
        )
        
        return result
    
    def _detect_all_fields(self, tokens: List[Dict]) -> List[Field]:
        """检测所有名称和税号字段"""
        fields = []
        
        import re
        _COMPANY_PATTERN = re.compile(
            r'[\u4e00-\u9fa5A-Za-z0-9()（）·\-&/.\s]{4,80}'
            r'(?:有限公司|有限责任公司|股份有限公司|集团|厂|店|中心|事务所|'
            r'工作室|合伙|合作社|部|行|室|处|协会|商会|学校|医院|银行)'
        )
        _TAX_ID_PATTERN = re.compile(r'^[0-9A-Z]{15,20}$')
        
        for token in tokens:
            text = token.get('text', '').strip()
            if not text:
                continue
            
            # 检测公司名称
            if _COMPANY_PATTERN.search(text):
                bbox = BBox(
                    x0=token.get('x0', 0),
                    y0=token.get('y0', 0),
                    x1=token.get('x1', 0),
                    y1=token.get('y1', 0)
                )
                fields.append(Field(
                    label="名称",
                    value=text,
                    bbox=bbox,
                    confidence=0.9
                ))
            
            # 检测税号
            elif _TAX_ID_PATTERN.match(text):
                bbox = BBox(
                    x0=token.get('x0', 0),
                    y0=token.get('y0', 0),
                    x1=token.get('x1', 0),
                    y1=token.get('y1', 0)
                )
                fields.append(Field(
                    label="税号",
                    value=text,
                    bbox=bbox,
                    confidence=0.95
                ))
        
        return fields
    
    def _calculate_owner_score(self, f: Field, anchors: Dict[str, BBox]) -> Dict[str, float]:
        """计算字段属于 buyer/seller 的评分"""
        scores = {"buyer": 0.0, "seller": 0.0}
        
        for owner, anchor_bbox in anchors.items():
            score = 0.0
            
            # 因子 1: 垂直距离（越近分数越高）
            vertical_dist = abs(f.bbox.cy - anchor_bbox.cy)
            if vertical_dist < self.vertical_threshold:
                proximity_score = 1.0 - (vertical_dist / self.vertical_threshold)
                score += self.weights['vertical_distance'] * proximity_score
            
            # 因子 2: 水平对齐（同一列加分）
            horizontal_overlap = self._calculate_horizontal_overlap(f.bbox, anchor_bbox)
            if horizontal_overlap > self.horizontal_overlap_threshold:
                score += self.weights['horizontal_alignment']
            
            # 因子 3: 标签匹配（如果附近有"购买方名称"/"销售方名称"标签）
            # TODO: 需要传入 labels 参数
            # if self._is_near_label(f.bbox, f"{owner}名称"):
            #     score += self.weights['label_match']
            
            scores[owner] = score
        
        return scores
    
    def _calculate_horizontal_overlap(self, bbox1: BBox, bbox2: BBox) -> float:
        """计算两个 bbox 的水平重叠率"""
        overlap_x0 = max(bbox1.x0, bbox2.x0)
        overlap_x1 = min(bbox1.x1, bbox2.x1)
        
        if overlap_x1 <= overlap_x0:
            return 0.0
        
        overlap_width = overlap_x1 - overlap_x0
        min_width = min(bbox1.width, bbox2.width)
        
        if min_width == 0:
            return 0.0
        
        return overlap_width / min_width
    
    def _group_by_owner(self, fields: List[Field]) -> Dict[str, Dict[str, Field]]:
        """按 owner 分组字段"""
        result = {
            "buyer": {"name": None, "tax": None},
            "seller": {"name": None, "tax": None}
        }
        
        for f in fields:
            owner = f.owner
            if not owner or owner not in result:
                continue
            
            if f.label == "名称":
                # 选择置信度最高的名称
                if (result[owner]["name"] is None or 
                    f.owner_confidence > result[owner]["name"].owner_confidence):
                    result[owner]["name"] = f
            
            elif f.label == "税号":
                if (result[owner]["tax"] is None or 
                    f.owner_confidence > result[owner]["tax"].owner_confidence):
                    result[owner]["tax"] = f
        
        return result
    
    def _cross_validate(self, result: Dict) -> bool:
        """交叉验证结果合理性"""
        import re
        
        # 规则 1: buyer 和 seller 不能相同
        if result["buyer"].get("name") and result["seller"].get("name"):
            if result["buyer"]["name"].value == result["seller"]["name"].value:
                logger.warning("Buyer 和 Seller 名称相同，可能识别错误")
                return False
        
        # 规则 2: 税号格式验证
        tax_pattern = re.compile(r'^[0-9A-Z]{15,20}$')
        for owner in ["buyer", "seller"]:
            tax_field = result[owner].get("tax")
            if tax_field and not tax_pattern.match(tax_field.value):
                logger.warning("%s 税号格式无效: %s", owner, tax_field.value)
                return False
        
        return True
