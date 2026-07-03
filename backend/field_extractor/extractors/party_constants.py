"""
party_extractor 模块常量集中管理

设计原则：
- 所有常量集中在此文件，各模块通过 `from .party_constants import ...` 引用
- 向后兼容：party_extractor.py 中保留模块级别名（_XXX = C.XXX），
  使现有测试的 `from party_extractor import _XXX` 继续生效
"""
import re
from dataclasses import dataclass


# ═══════════════════════════════════════════════════════════
# 模块级常量（向后兼容旧 import 路径）
# ═══════════════════════════════════════════════════════════

# ── 锚点关键词 ──
BUYER_ANCHORS: tuple = (
    '购买方信息', '购方信息', '购买方', '购方',
)
SELLER_ANCHORS: tuple = (
    '销售方信息', '销方信息', '销售方', '销方',
)
FOOTER_ANCHORS: tuple = (
    '价税合计', '合计', '收款人', '复核人', '开票人', '备注',
)

# ── 标签关键词 ──
NAME_LABELS: tuple = ('名称', '公司名称', '单位名称')
TAX_LABELS: tuple = ('税号', '纳税人识别号', '统一社会信用代码')

# ── 公司后缀 ──
COMPANY_SUFFIX_LIST: tuple = (
    '有限公司', '有限责任公司', '股份有限公司', '集团有限公司', '集团股份有限公司',
    '集团', '厂', '店', '中心', '事务所', '工作室', '合伙', '合伙企业',
    '个人独资企业', '合作社', '部', '行', '室', '处', '协会', '商会',
    '学校', '医院', '银行', '研究院', '基金会',
    '加油站', '加气站', '充电站',
)

# 编译后的正则模式（基于 COMPANY_SUFFIX_LIST）
_COMPANY_SUFFIX_RE_PART = '(?:' + '|'.join(re.escape(s) for s in COMPANY_SUFFIX_LIST) + ')'
COMPANY_PATTERN = re.compile(
    r'[\u4e00-\u9fa5A-Za-z0-9()（）·\-&/.\s]{4,80}' + _COMPANY_SUFFIX_RE_PART
)
COMPANY_PATTERN_NO_SUFFIX = re.compile(
    r'[\u4e00-\u9fa5A-Za-z0-9()（）·\-&/.\s]{4,80}'
)

# ── 过滤关键词 ──
POLLUTION_KEYWORDS: tuple = (
    '项目名称', '规格型号', '单价', '金额', '税率', '税额',
    '合计', '价税合计', '开票人', '密码区', '机器编号',
    '发票', '电子发票', '增值税专用发票', '普通发票',
    '货物或应税劳务', '购买方', '销售方',
    '订单号', '订单编号',
)
INVOICE_ID_KEYWORDS: tuple = ('发票号码', '发票代码', '机器编号')
AMOUNT_DAXIE_KEYWORDS: tuple = (
    '零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖',
    '拾', '佰', '仟', '万', '圆', '整',
)
LINE_ITEM_KEYWORDS: tuple = (
    '项目名称', '规格型号', '单位', '数量', '单价', '金额', '税率', '税额',
)
REMARK_LINE_KEYWORDS: tuple = (
    '唯品会', '淘宝', '京东', '拼多多', '天猫', '苏宁', '抖音',
    '订单号', '订单编号', '快递单号', '物流单号',
    '仅限办公', '仅用于',
)

# ── 税号正则 ──
STANDALONE_TAX_ID_RE = re.compile(
    r'^(?=[0-9A-Z]*[A-Z])[0-9A-Z]{15,20}$|^\d{15,18}$', re.IGNORECASE
)

# ── 评分常量 ──
BASE_SCORE = 30
SCORE_LABEL_BINDING = 25
SCORE_REGION_LOCKED = 40
SCORE_COMPANY_FORMAT = 15
SCORE_TAX_FORMAT = 20
SCORE_NEAR_TAX = 10
SCORE_NEAR_INV_ID = -30
SCORE_IN_LINE_ITEM = -40
SCORE_GOODS_PENALTY = -15

# L4 坐标增强评分
SCORE_L4_LABEL_BIND = 25
SCORE_L4_LABEL_RIGHT = 20
SCORE_L4_ANCHOR_NEAR = 15
SCORE_L4_POSITION = 10
SCORE_L4_ORDER = 5

# ── 置信度阈值 ──
CONFIDENCE_AUTO_PASS = 0.85
CONFIDENCE_NEED_CONFIRM = 0.60

# ── 区域构建阈值 ──
REGION_SPLIT_Y_THRESHOLD = 80
REGION_SPLIT_Y_RATIO = 0.08

# ── 行聚类与匹配阈值 ──
LINE_CLUSTER_TOL = 0.6
FUZZY_MATCH_MIN_RATIO = 0.7
SIMILARITY_THRESHOLD = 0.85
JACCARD_THRESHOLD = 0.7
DIGIT_RATIO_THRESHOLD = 0.3
LABEL_VALUE_RATIO_THRESHOLD = 0.5

# ── 行内距离阈值 ──
ROW_HEIGHT_RATIO = 0.6
RIGHT_DIST_WEIGHT_DX = 2.0
RIGHT_DIST_WEIGHT_DY = 0.5

# ── 来源优先级 ──
SOURCE_PRIORITY: dict = {
    'bbox_l1_label': 40,
    'bbox_l2_anchor': 30,
    'text_l4': 20,
    'bbox_l3_region': 10,
}

# ── 几何常量（PartyExtractor 类属性） ──
WINDOW_SIZE = 25
FULL_ELECTRIC_MAX_ANCHOR_GAP = 10
ANCHOR_TOP_MARGIN = 30
ANCHOR_BOTTOM_MARGIN = 300
TAX_ANCHOR_MAX_DIST = 300
L1_MAX_RIGHT_DIST_RATIO = 0.25
L2_WINDOW_RADIUS_RATIO = 0.25

# ── 商品关键词 ──
GOODS_KEYWORDS: tuple = (
    '手机', '充电宝', '数据线', '充电器', '风扇', '耳机',
    '电视', '冰箱', '洗衣机', '空调', '电脑', '笔记本',
    '华为', '荣耀', 'vivo', '小米', 'oppo', '三星', '苹果',
    '适用', '接口', 'MicroUSB', 'Type-C', 'USB',
)

# ── 公司特征词 ──
COMPANY_KEYWORDS: tuple = (
    '公司', '企业', '集团', '厂', '店', '中心', '事务所', '工作室',
    '银行', '医院', '学校', '协会', '商会', '合作社', '研究院',
    '基金会', '学会', '工会',
)


# ═══════════════════════════════════════════════════════════
# 不可变常量集合（推荐新代码使用此方式引用）
# ═══════════════════════════════════════════════════════════

@dataclass(frozen=True)
class PartyConstants:
    """不可变常量集合，推荐新代码通过 `from .party_constants import PartyConstants as C` 引用"""

    # 锚点关键词
    BUYER_ANCHORS: tuple = BUYER_ANCHORS
    SELLER_ANCHORS: tuple = SELLER_ANCHORS
    FOOTER_ANCHORS: tuple = FOOTER_ANCHORS

    # 标签关键词
    NAME_LABELS: tuple = NAME_LABELS
    TAX_LABELS: tuple = TAX_LABELS

    # 公司后缀
    COMPANY_SUFFIX_LIST: tuple = COMPANY_SUFFIX_LIST

    # 过滤关键词
    POLLUTION_KEYWORDS: tuple = POLLUTION_KEYWORDS
    INVOICE_ID_KEYWORDS: tuple = INVOICE_ID_KEYWORDS
    AMOUNT_DAXIE_KEYWORDS: tuple = AMOUNT_DAXIE_KEYWORDS
    LINE_ITEM_KEYWORDS: tuple = LINE_ITEM_KEYWORDS
    REMARK_LINE_KEYWORDS: tuple = REMARK_LINE_KEYWORDS

    # 评分
    BASE_SCORE: int = BASE_SCORE
    SCORE_LABEL_BINDING: int = SCORE_LABEL_BINDING
    SCORE_REGION_LOCKED: int = SCORE_REGION_LOCKED
    SCORE_COMPANY_FORMAT: int = SCORE_COMPANY_FORMAT
    SCORE_TAX_FORMAT: int = SCORE_TAX_FORMAT
    SCORE_NEAR_TAX: int = SCORE_NEAR_TAX
    SCORE_NEAR_INV_ID: int = SCORE_NEAR_INV_ID
    SCORE_IN_LINE_ITEM: int = SCORE_IN_LINE_ITEM
    SCORE_GOODS_PENALTY: int = SCORE_GOODS_PENALTY
    SCORE_L4_LABEL_BIND: int = SCORE_L4_LABEL_BIND
    SCORE_L4_LABEL_RIGHT: int = SCORE_L4_LABEL_RIGHT
    SCORE_L4_ANCHOR_NEAR: int = SCORE_L4_ANCHOR_NEAR
    SCORE_L4_POSITION: int = SCORE_L4_POSITION
    SCORE_L4_ORDER: int = SCORE_L4_ORDER

    # 置信度
    CONFIDENCE_AUTO_PASS: float = CONFIDENCE_AUTO_PASS
    CONFIDENCE_NEED_CONFIRM: float = CONFIDENCE_NEED_CONFIRM

    # 区域构建
    REGION_SPLIT_Y_THRESHOLD: int = REGION_SPLIT_Y_THRESHOLD
    REGION_SPLIT_Y_RATIO: float = REGION_SPLIT_Y_RATIO

    # 行聚类
    LINE_CLUSTER_TOL: float = LINE_CLUSTER_TOL
    FUZZY_MATCH_MIN_RATIO: float = FUZZY_MATCH_MIN_RATIO
    SIMILARITY_THRESHOLD: float = SIMILARITY_THRESHOLD
    JACCARD_THRESHOLD: float = JACCARD_THRESHOLD
    DIGIT_RATIO_THRESHOLD: float = DIGIT_RATIO_THRESHOLD
    LABEL_VALUE_RATIO_THRESHOLD: float = LABEL_VALUE_RATIO_THRESHOLD

    # 几何
    WINDOW_SIZE: int = WINDOW_SIZE
    ANCHOR_TOP_MARGIN: int = ANCHOR_TOP_MARGIN
    ANCHOR_BOTTOM_MARGIN: int = ANCHOR_BOTTOM_MARGIN
    TAX_ANCHOR_MAX_DIST: int = TAX_ANCHOR_MAX_DIST


# 单例（避免重复实例化）
C = PartyConstants()
