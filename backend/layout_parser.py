"""
布局解析器 - 区域驱动架构 v2.0

核心改进：
1. 区域划分使用表格锚点作为硬边界
2. 元素归属判定使用 overlap_ratio 替代严格 contains
3. 垂直锚点支持子字符串匹配
4. 增强 FieldTypeScore，支持政府机关、事业单位等
5. find_nearest_candidate() 支持多方向搜索（右、下、右下）
6. Region Grow 动态扩张直到遇到边界

发票结构：
┌─────────────────────────────────────────────────┐
│              购买方区域 (buyer_region)         │
│  名称：xxx公司                                 │
│  税号：913xxxx                                │
│  地址：xxx                                    │
├─────────────────────────────────────────────────┤
│              表格区域 (table_region)           │
│  商品名称 | 规格 | 数量 | 单价 | 金额          │
│  xxx     | xxx  | xxx  | xxx  | xxx          │
├─────────────────────────────────────────────────┤
│              页脚区域 (footer_region)          │
│  价税合计：xxx                                │
├─────────────────────────────────────────────────┤
│              销售方区域 (seller_region)        │
│  名称：xxx公司                                 │
│  税号：913xxxx                                │
└─────────────────────────────────────────────────┘
"""

import fitz
from dataclasses import dataclass, field
from typing import List, Dict, Tuple, Optional, Any
from enum import Enum
import math
import re

logger = __import__('logging').getLogger(__name__)


# ============================
# 统一数据结构
# ============================

class SourceType(Enum):
    PDF = "pdf"
    OCR = "ocr"


@dataclass
class LayoutElement:
    """统一的布局元素数据结构"""
    text: str
    box: List[List[float]]
    page: int = 0
    source: SourceType = SourceType.PDF
    
    @property
    def x0(self) -> float:
        return min(p[0] for p in self.box) if self.box else 0
    
    @property
    def y0(self) -> float:
        return min(p[1] for p in self.box) if self.box else 0
    
    @property
    def x1(self) -> float:
        return max(p[0] for p in self.box) if self.box else 0
    
    @property
    def y1(self) -> float:
        return max(p[1] for p in self.box) if self.box else 0
    
    @property
    def width(self) -> float:
        return self.x1 - self.x0
    
    @property
    def height(self) -> float:
        return self.y1 - self.y0
    
    @property
    def area(self) -> float:
        return self.width * self.height
    
    @property
    def center_x(self) -> float:
        return (self.x0 + self.x1) / 2
    
    @property
    def center_y(self) -> float:
        return (self.y0 + self.y1) / 2
    
    def distance_to(self, other: 'LayoutElement') -> float:
        dx = self.center_x - other.center_x
        dy = self.center_y - other.center_y
        return math.sqrt(dx * dx + dy * dy)
    
    def is_in_same_line(self, other: 'LayoutElement', tolerance: float = 15) -> bool:
        return abs(self.center_y - other.center_y) <= tolerance
    
    def iou(self, other: 'LayoutElement') -> float:
        if not self.box or not other.box:
            return 0.0
        inter_x0, inter_y0 = max(self.x0, other.x0), max(self.y0, other.y0)
        inter_x1, inter_y1 = min(self.x1, other.x1), min(self.y1, other.y1)
        inter_area = max(0, inter_x1 - inter_x0) * max(0, inter_y1 - inter_y0)
        if inter_area == 0:
            return 0.0
        union_area = self.area + other.area - inter_area
        return inter_area / union_area
    
    def overlap_ratio(self, region: 'LayoutRegion') -> float:
        """计算元素与区域的重叠比例（元素面积中有多少落入区域）"""
        if not self.box or self.area == 0:
            return 0.0
        
        inter_x0, inter_y0 = max(self.x0, region.x0), max(self.y0, region.y0)
        inter_x1, inter_y1 = min(self.x1, region.x1), min(self.y1, region.y1)
        inter_area = max(0, inter_x1 - inter_x0) * max(0, inter_y1 - inter_y0)
        
        return inter_area / self.area


# ============================
# 区域定义（修复：使用 overlap_ratio 判断归属）
# ============================

@dataclass
class LayoutRegion:
    """布局区域"""
    name: str
    x0: float = 0.0
    y0: float = 0.0
    x1: float = 0.0
    y1: float = 0.0
    
    @property
    def width(self) -> float:
        return self.x1 - self.x0
    
    @property
    def height(self) -> float:
        return self.y1 - self.y0
    
    def contains(self, element: LayoutElement) -> bool:
        """严格判断：元素中心点是否在区域内"""
        return (self.x0 <= element.center_x <= self.x1 and
                self.y0 <= element.center_y <= self.y1)
    
    def intersects(self, element: LayoutElement) -> bool:
        """判断元素是否与区域相交"""
        return not (element.x1 < self.x0 or element.x0 > self.x1 or
                    element.y1 < self.y0 or element.y0 > self.y1)
    
    def contains_element(self, element: LayoutElement, min_overlap_ratio: float = 0.3) -> bool:
        """
        宽松判断：元素是否属于该区域
        
        Args:
            element: 待判断的元素
            min_overlap_ratio: 最小重叠比例（默认30%）
        
        Returns:
            bool: 是否属于该区域
        """
        # 严格包含优先
        if self.contains(element):
            return True
        
        # 重叠比例判断
        overlap = element.overlap_ratio(self)
        return overlap >= min_overlap_ratio


# ============================
# 区域分割器（全面重构）
# ============================

class RegionSegmenter:
    """区域分割器 - 基于边界检测的动态区域划分"""
    
    def __init__(self):
        # 垂直排列的锚点模式
        self.vertical_patterns = {
            'buyer': [
                ['购', '买', '方'],
                ['购', '买', '方', '信', '息'],
                ['购', '货', '单', '位'],
            ],
            'seller': [
                ['销', '售', '方'],
                ['销', '售', '方', '信', '息'],
                ['销', '货', '单', '位'],
            ]
        }
    
    def find_vertical_anchor(self, elements: List[LayoutElement], 
                            characters: List[str]) -> Optional[LayoutElement]:
        """
        寻找垂直排列的锚点（修复：支持子字符串匹配）
        
        例如：购/买/方/信/息 五个字垂直排列
        """
        if len(characters) < 2:
            return None
        
        # 找到第一个字符（支持子字符串匹配）
        first_char = None
        for elem in elements:
            if characters[0] in elem.text:
                first_char = elem
                break
        
        if not first_char:
            return None
        
        # 检查后续字符是否在其下方垂直排列
        current_x = first_char.center_x
        current_y = first_char.center_y
        found_chars = [first_char]
        matched_text = first_char.text
        
        for char in characters[1:]:
            found = False
            for elem in elements:
                # 支持子字符串匹配
                if char in elem.text:
                    # 检查是否在下方且 x 坐标接近
                    if elem.y0 > current_y and abs(elem.center_x - current_x) < 20:
                        found_chars.append(elem)
                        matched_text += elem.text
                        current_y = elem.center_y
                        found = True
                        break
            
            if not found:
                break
        
        # 至少找到3个连续字符才算匹配
        if len(found_chars) >= 3:
            # 返回第一个字符作为锚点代表
            return first_char
        
        return None
    
    def find_horizontal_anchor(self, elements: List[LayoutElement], 
                              patterns: List[str]) -> Optional[LayoutElement]:
        """寻找水平排列的锚点（支持子字符串匹配）"""
        for pattern in patterns:
            for elem in elements:
                if pattern in elem.text or elem.text in pattern:
                    return elem
        return None
    
    def find_buyer_anchor(self, elements: List[LayoutElement]) -> Optional[LayoutElement]:
        """寻找购买方锚点（支持垂直和水平排列）"""
        # 先尝试水平锚点
        horizontal_patterns = ['购买方信息', '购货单位', '购买方', '购方', '买方']
        anchor = self.find_horizontal_anchor(elements, horizontal_patterns)
        if anchor:
            return anchor
        
        # 再尝试垂直锚点
        for pattern in self.vertical_patterns['buyer']:
            anchor = self.find_vertical_anchor(elements, pattern)
            if anchor:
                return anchor
        
        return None
    
    def find_seller_anchor(self, elements: List[LayoutElement]) -> Optional[LayoutElement]:
        """寻找销售方锚点（支持垂直和水平排列）"""
        # 先尝试水平锚点
        horizontal_patterns = ['销售方信息', '销货单位', '销售方', '销方', '卖方']
        anchor = self.find_horizontal_anchor(elements, horizontal_patterns)
        if anchor:
            return anchor
        
        # 再尝试垂直锚点
        for pattern in self.vertical_patterns['seller']:
            anchor = self.find_vertical_anchor(elements, pattern)
            if anchor:
                return anchor
        
        return None
    
    def find_table_anchor(self, elements: List[LayoutElement]) -> Optional[LayoutElement]:
        """寻找表格区域锚点"""
        patterns = [ '规格型号', '单位', '数量', '单价', '金额', '税率']
        return self.find_horizontal_anchor(elements, patterns)
    
    def find_footer_anchor(self, elements: List[LayoutElement]) -> Optional[LayoutElement]:
        """寻找页脚区域锚点"""
        patterns = ['合计', '价税合计', '小写', '大写', '开票人', '复核', '收款人']
        return self.find_horizontal_anchor(elements, patterns)
    
    def segment(self, elements: List[LayoutElement]) -> Dict[str, LayoutRegion]:
        """
        划分布局区域（使用硬边界 + Region Grow）
        
        返回：
        {
            'buyer_region': LayoutRegion,
            'seller_region': LayoutRegion,
            'table_region': LayoutRegion,
            'footer_region': LayoutRegion
        }
        """
        if not elements:
            return {}
        
        # 获取页面边界
        min_x = min(e.x0 for e in elements)
        max_x = max(e.x1 for e in elements)
        min_y = min(e.y0 for e in elements)
        max_y = max(e.y1 for e in elements)
        
        # 找到所有锚点
        buyer_anchor = self.find_buyer_anchor(elements)
        seller_anchor = self.find_seller_anchor(elements)
        table_anchor = self.find_table_anchor(elements)
        footer_anchor = self.find_footer_anchor(elements)
        
        logger.info(f"区域锚点 - 购买方: {buyer_anchor.text if buyer_anchor else None}")
        logger.info(f"区域锚点 - 销售方: {seller_anchor.text if seller_anchor else None}")
        logger.info(f"区域锚点 - 表格: {table_anchor.text if table_anchor else None}")
        logger.info(f"区域锚点 - 页脚: {footer_anchor.text if footer_anchor else None}")
        
        regions = {}
        
        # ====================
        # 确定硬边界
        # ====================
        
        # 表格上边界（购买方区域的底部边界）
        table_top = table_anchor.y0 if table_anchor else (min_y + (max_y - min_y) * 0.4)
        
        # 表格下边界（销售方区域的顶部边界）
        table_bottom = table_anchor.y1 if table_anchor else (min_y + (max_y - min_y) * 0.6)
        
        # 页脚上边界
        footer_top = footer_anchor.y0 if footer_anchor else max_y
        
        # ====================
        # 购买方区域：顶部 ~ 表格上边界
        # ====================
        buyer_start_y = min_y
        
        # 如果有购买方锚点，从锚点上方开始
        if buyer_anchor:
            buyer_start_y = min(buyer_start_y, buyer_anchor.y0 - 50)
        
        regions['buyer_region'] = LayoutRegion(
            name='buyer_region',
            x0=min_x,
            y0=buyer_start_y,
            x1=max_x,
            y1=table_top
        )
        
        # ====================
        # 表格区域：表格上边界 ~ 页脚上边界
        # ====================
        if table_anchor:
            regions['table_region'] = LayoutRegion(
                name='table_region',
                x0=min_x,
                y0=table_top - 30,
                x1=max_x,
                y1=footer_top - 30
            )
        
        # ====================
        # 页脚区域：页脚上边界 ~ 底部
        # ====================
        if footer_anchor:
            regions['footer_region'] = LayoutRegion(
                name='footer_region',
                x0=min_x,
                y0=footer_top - 30,
                x1=max_x,
                y1=max_y
            )
        
        # ====================
        # 销售方区域：表格下边界 ~ 页脚上边界
        # ====================
        seller_end_y = footer_top
        
        # 如果有销售方锚点，调整结束位置
        if seller_anchor:
            seller_end_y = max(seller_end_y, seller_anchor.y1 + 50)
        
        # 如果没有页脚锚点，销售方区域延伸到底部
        if not footer_anchor:
            seller_end_y = max_y
        
        regions['seller_region'] = LayoutRegion(
            name='seller_region',
            x0=min_x,
            y0=table_bottom,
            x1=max_x,
            y1=seller_end_y
        )
        
        # ====================
        # 特殊情况处理：没有表格锚点时的回退策略
        # ====================
        if not table_anchor:
            # 尝试用购买方和销售方锚点来划分
            if buyer_anchor and seller_anchor:
                buyer_y = buyer_anchor.center_y
                seller_y = seller_anchor.center_y
                
                if buyer_y < seller_y:
                    # 购买方在上，销售方在下
                    mid_y = (buyer_y + seller_y) / 2
                    regions['buyer_region'].y1 = mid_y
                    regions['seller_region'].y0 = mid_y
                else:
                    # 销售方在上，购买方在下（少数情况）
                    mid_y = (buyer_y + seller_y) / 2
                    regions['seller_region'].y1 = mid_y
                    regions['buyer_region'].y0 = mid_y
        
        return regions


# ============================
# 字段锚点和定义（增强）
# ============================

@dataclass
class FieldAnchor:
    """字段锚点定义"""
    name: str
    anchors: List[str]
    pattern_type: str = None


class FieldDefinitions:
    """字段定义集合（增强：增加更多组织机构特征）"""
    
    # 公司名称关键词（扩展到政府机关、事业单位等）
    COMPANY_KEYWORDS = [
        # 企业类型
        '有限公司', '股份有限公司', '集团', '科技', '实业', '发展', '贸易', '投资',
        '有限责任', '有限', '股份',
        
        # 政府机关
        '税务局', '税务', '海关', '财政局', '工商局', '公安局', '法院', '检察院',
        '政府', '厅', '局', '委员会', '办公室',
        
        # 事业单位
        '医院', '学校', '大学', '学院', '中学', '小学', '幼儿园',
        '研究院', '研究所', '科学院', '中心', '协会', '学会', '联合会',
        
        # 金融机构
        '银行', '证券', '保险', '基金',
        
        # 其他
        '公司', '厂', '矿', '场', '站', '所', '队', '部', '处', '科', '室'
    ]
    
    TAX_ID_PATTERN = r'^[0-9A-Z]{15,20}$'
    
    ADDRESS_KEYWORDS = ['路', '街', '号', '区', '市', '省', '大厦', '楼', '巷', '镇', '村', '弄']
    
    BANK_KEYWORDS = ['银行', '支行', '账号', '账户', '开户行', '开户银行', '网点']
    
    FIELDS = [
        FieldAnchor(
            name='company_name',
            anchors=['名称', '公司名称', '单位名称'],
            pattern_type='company'
        ),
        FieldAnchor(
            name='tax_id',
            anchors=['纳税人识别号', '统一社会信用代码', '税号', '识别号'],
            pattern_type='tax_id'
        ),
        FieldAnchor(
            name='address',
            anchors=['地址', '地址电话', '注册地址'],
            pattern_type='address'
        ),
        FieldAnchor(
            name='bank',
            anchors=['开户行', '开户银行', '银行账号', '账号'],
            pattern_type='bank'
        ),
    ]


# ============================
# 字段类型评分（增强）
# ============================

class FieldTypeScore:
    """字段类型评分 - 判定候选值属于哪种字段类型"""
    
    def __init__(self, element: LayoutElement):
        self.element = element
        self.scores = {}
    
    def score_company(self) -> float:
        """公司名称评分（增强：支持政府机关、事业单位等）"""
        text = self.element.text
        matches = sum(1 for kw in FieldDefinitions.COMPANY_KEYWORDS if kw in text)
        
        # 基础评分
        score = matches * 0.15
        
        # 长度加分（至少4个字符）
        if len(text) >= 4:
            score += 0.3
        
        # 长度越长越可能是公司名
        if len(text) >= 8:
            score += 0.2
        if len(text) >= 12:
            score += 0.1
        
        return min(score, 1.0)
    
    def score_tax_id(self) -> float:
        """税号评分"""
        text = self.element.text
        if re.match(FieldDefinitions.TAX_ID_PATTERN, text):
            return 1.0
        return 0.0
    
    def score_address(self) -> float:
        """地址评分"""
        text = self.element.text
        matches = sum(1 for kw in FieldDefinitions.ADDRESS_KEYWORDS if kw in text)
        score = matches * 0.2
        
        # 长度加分
        if len(text) >= 8:
            score += 0.4
        if len(text) >= 12:
            score += 0.2
        
        return min(score, 1.0)
    
    def score_bank(self) -> float:
        """银行信息评分"""
        text = self.element.text
        matches = sum(1 for kw in FieldDefinitions.BANK_KEYWORDS if kw in text)
        score = matches * 0.3
        
        # 账号格式加分
        if re.search(r'\d{10,}', text):
            score += 0.3
        
        return min(score, 1.0)
    
    def get_best_field_type(self) -> Tuple[str, float]:
        """获取最匹配的字段类型"""
        self.scores['company'] = self.score_company()
        self.scores['tax_id'] = self.score_tax_id()
        self.scores['address'] = self.score_address()
        self.scores['bank'] = self.score_bank()
        
        best_type = max(self.scores.items(), key=lambda x: x[1])
        return best_type[0], best_type[1]


# ============================
# 字段提取器（修复：支持多方向搜索）
# ============================

class FieldExtractor:
    """字段提取器 - 在指定区域内提取字段"""
    
    def __init__(self):
        self.field_defs = FieldDefinitions.FIELDS
        # 预构建「锚点→字段名」有序列表（field_def 顺序 → anchor 顺序），
        # 供 find_field_labels 扁平化遍历。保留原始遍历顺序可确保输出顺序与原
        # 三重循环逐字节一致——extract_fields 按 labels 顺序对每字段取「首个有效
        # label」胜出，顺序改变会改变字段取值（准确性风险），故不可翻转循环。
        self._anchor_pairs = [
            (fd.name, a) for fd in self.field_defs for a in fd.anchors
        ]

    def find_field_labels(self, elements: List[LayoutElement]) -> List[Tuple[str, LayoutElement]]:
        """找到所有字段标签

        复杂度 O(F*A*E)，但 F（字段数，固定=4）、A（锚点总数，固定≈14）为常数，
        E 为区域内元素数（通常数十），且本函数每次区域提取仅调用一次，实际开销极小，
        远小于 find_nearest_candidate / 字段评分。因此保持「field→anchor→element」
        的原始遍历顺序，保证输出与原实现完全一致。
        """
        labels = []
        for name, anchor in self._anchor_pairs:
            for elem in elements:
                if anchor in elem.text or elem.text in anchor:
                    labels.append((name, elem))
        return labels
    
    def find_nearest_candidate(self, label: LayoutElement, elements: List[LayoutElement],
                              max_distance: float = 300,
                              label_elements: Optional[set] = None) -> Optional[LayoutElement]:
        """
        找到标签附近的候选值（支持多方向搜索）

        搜索方向：
        1. 右侧（优先）
        2. 下方
        3. 右下方

        Args:
            label: 标签元素
            elements: 候选元素列表
            max_distance: 最大搜索距离
            label_elements: 预计算的「标签类元素」集合（可选）。is_label 仅取决于
                elem.text 与 field_defs（与位置/距离无关），可一次性算出后在候选循环中
                O(1) 查表；多次调用同一 elements 时复用它可避免每候选重复 O(F×A) 锚点匹配。
                不提供则内部等价计算一次，行为不变。

        Returns:
            LayoutElement: 最匹配的候选值
        """
        # 预计算「标签类元素」集合：is_label 谓词（anchor in elem.text，任一锚点命中）
        # 只依赖 elem.text 与 field_defs，与 label/位置/距离无关，因此一次性算出后
        # 在候选循环里 O(1) 查表。与原实现逐元素嵌套匹配结果完全一致。
        if label_elements is None:
            label_elements = {
                elem for elem in elements
                if any(anchor in elem.text
                       for field_def in self.field_defs
                       for anchor in field_def.anchors)
            }

        candidates = []

        for elem in elements:
            if elem is label:
                continue

            # 排除标签类元素（预计算集合，O(1) 查表）
            if elem in label_elements:
                continue
            
            dx = elem.center_x - label.center_x
            dy = elem.center_y - label.center_y
            distance = math.sqrt(dx * dx + dy * dy)
            
            if distance > max_distance:
                continue
            
            # 计算方向评分
            # 右侧优先（dx > 0），下方次之（dy > 0），右下方也可
            direction_score = 0
            
            # 右侧加分
            if dx > 10:
                direction_score += 0.5
            
            # 同一行或下方加分
            if -10 <= dy <= 40:
                direction_score += 0.3
            elif dy > 0:
                direction_score += 0.2
            
            # 综合评分：距离越近越好，方向越对越好
            score = (1.0 - distance / max_distance) * 0.6 + direction_score * 0.4
            
            candidates.append((score, distance, elem))
        
        if candidates:
            # 按评分排序，选择最高分
            candidates.sort(key=lambda x: (-x[0], x[1]))
            return candidates[0][2]
        
        return None
    
    def extract_fields(self, region_elements: List[LayoutElement]) -> Dict[str, str]:
        """在区域内提取字段"""
        result = {
            'company_name': '',
            'tax_id': '',
            'address': '',
            'bank': ''
        }
        
        if not region_elements:
            return result
        
        labels = self.find_field_labels(region_elements)

        # 预计算「标签类元素」集合，传入 find_nearest_candidate 复用：
        # 避免对每个 label 重复执行 O(F×A) 的锚点匹配（is_label 仅取决于
        # elem.text 与 field_defs，与位置/距离无关，结果与原实现完全一致）。
        label_elements = {
            elem for elem in region_elements
            if any(anchor in elem.text
                   for field_def in self.field_defs
                   for anchor in field_def.anchors)
        }

        for field_name, label_elem in labels:
            if result[field_name]:
                continue

            # 找到附近的候选值（支持多方向搜索）
            value_elem = self.find_nearest_candidate(
                label_elem, region_elements, label_elements=label_elements)
            
            if value_elem:
                scorer = FieldTypeScore(value_elem)
                best_type, confidence = scorer.get_best_field_type()
                
                # 只接受高置信度匹配或字段类型一致
                if confidence >= 0.3 or best_type == field_name:
                    result[field_name] = value_elem.text
        
        return result


# ============================
# 布局解析器（主入口）
# ============================

class LayoutParser:
    """布局解析器 - 整合区域分割和字段提取"""
    
    def __init__(self):
        self.segmenter = RegionSegmenter()
        self.extractor = FieldExtractor()
    
    def parse_pdf(self, pdf_bytes: bytes) -> List[LayoutElement]:
        """使用 PyMuPDF dict 模式解析 PDF"""
        elements = []
        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            try:
                for page_idx, page in enumerate(doc):
                    layout = page.get_text("dict")
                    for block in layout.get("blocks", []):
                        if block.get("type") != 0:
                            continue
                        for line in block.get("lines", []):
                            for span in line.get("spans", []):
                                text = span.get("text", "").strip()
                                if not text:
                                    continue
                                bbox = span.get("bbox", [])
                                if len(bbox) >= 4:
                                    x0, y0, x1, y1 = bbox
                                    box = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
                                else:
                                    box = []
                                elements.append(LayoutElement(
                                    text=text,
                                    box=box,
                                    page=page_idx,
                                    source=SourceType.PDF
                                ))
            finally:
                doc.close()
        except Exception as e:
            logger.error(f"PDF 解析失败: {e}")
        return elements
    
    def parse_ocr(self, ocr_result: List) -> List[LayoutElement]:
        """解析 OCR 结果"""
        elements = []
        for item in ocr_result:
            if len(item) < 2:
                continue
            box, text = item[0], item[1]
            if not text or not isinstance(text, str):
                continue
            if isinstance(box, list) and len(box) >= 4:
                if len(box) == 8:
                    formatted_box = [[box[i], box[i+1]] for i in range(0, 8, 2)]
                elif len(box) == 4:
                    formatted_box = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]
                else:
                    formatted_box = []
            else:
                formatted_box = []
            elements.append(LayoutElement(
                text=text.strip(),
                box=formatted_box,
                page=0,
                source=SourceType.OCR
            ))
        return elements
    
    def merge_elements(self, pdf_elements: List[LayoutElement], 
                      ocr_elements: List[LayoutElement]) -> List[LayoutElement]:
        """合并 PDF 和 OCR 元素（去重）"""
        merged = []
        for pdf_elem in pdf_elements:
            merged.append(pdf_elem)
        
        for ocr_elem in ocr_elements:
            is_duplicate = False
            for merged_elem in merged:
                if ocr_elem.iou(merged_elem) > 0.5:
                    is_duplicate = True
                    break
                if (ocr_elem.text in merged_elem.text or merged_elem.text in ocr_elem.text):
                    if ocr_elem.distance_to(merged_elem) < 30:
                        is_duplicate = True
                        break
            if not is_duplicate:
                merged.append(ocr_elem)
        
        merged.sort(key=lambda e: (e.page, e.y0, e.x0))
        return merged
    
    def extract(self, pdf_bytes: bytes = None, ocr_result: List = None) -> Dict:
        """
        完整提取流程
        
        核心算法：
        1. 解析 PDF 和 OCR
        2. 合并元素
        3. 区域分割（使用硬边界 + Region Grow）
        4. 在各自区域内提取字段（使用宽松归属判定）
        """
        # 解析
        pdf_elements = self.parse_pdf(pdf_bytes) if pdf_bytes else []
        ocr_elements = self.parse_ocr(ocr_result) if ocr_result else []
        
        # 合并
        elements = self.merge_elements(pdf_elements, ocr_elements)
        
        # 区域分割（关键步骤：使用硬边界）
        regions = self.segmenter.segment(elements)
        
        # 获取各区域内的元素（使用宽松归属判定）
        buyer_elements = []
        seller_elements = []
        
        if 'buyer_region' in regions:
            buyer_region = regions['buyer_region']
            buyer_elements = [e for e in elements if buyer_region.contains_element(e)]
        
        if 'seller_region' in regions:
            seller_region = regions['seller_region']
            seller_elements = [e for e in elements if seller_region.contains_element(e)]
        
        # 在各自区域内提取字段（100%区域隔离）
        buyer_info = self.extractor.extract_fields(buyer_elements)
        seller_info = self.extractor.extract_fields(seller_elements)
        
        return {
            'buyer': buyer_info,
            'seller': seller_info,
            'regions': regions,
            'buyer_elements_count': len(buyer_elements),
            'seller_elements_count': len(seller_elements)
        }


# ============================
# 全局单例
# ============================

_layout_parser = None

def get_layout_parser() -> LayoutParser:
    global _layout_parser
    if _layout_parser is None:
        _layout_parser = LayoutParser()
    return _layout_parser

def parse_layout(pdf_bytes: bytes = None, ocr_result: List = None) -> Dict:
    return get_layout_parser().extract(pdf_bytes, ocr_result)