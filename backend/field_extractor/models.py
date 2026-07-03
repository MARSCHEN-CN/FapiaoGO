"""
发票字段数据模型
"""
from dataclasses import dataclass, field
from typing import List, Optional, Dict

from contracts.document_layout import BBox


class Token:
    """带坐标和置信度的文本 token（统一中间模型）

    内部持有 contracts.BBox 实例，对外通过属性代理暴露
    x0/y0/x1/y1/cx/cy/width/height，保证旧代码零改动。
    """
    __slots__ = ('text', '_bbox', 'page', 'confidence')

    def __init__(self, text: str = '', x0: float = 0.0, y0: float = 0.0,
                 x1: float = 0.0, y1: float = 0.0,
                 page: int = 0, confidence: float = 1.0):
        self.text = text
        self._bbox = BBox(x=x0, y=y0, width=x1 - x0, height=y1 - y0)
        self.page = page
        self.confidence = confidence

    # ── coordinate property proxies ───────────────────────────────────

    @property
    def x(self) -> float:
        return self._bbox.x

    @x.setter
    def x(self, value: float) -> None:
        self._bbox.x = value

    @property
    def y(self) -> float:
        return self._bbox.y

    @y.setter
    def y(self, value: float) -> None:
        self._bbox.y = value

    @property
    def x0(self) -> float:
        return self._bbox.x0

    @x0.setter
    def x0(self, value: float) -> None:
        self._bbox.x0 = value

    @property
    def y0(self) -> float:
        return self._bbox.y0

    @y0.setter
    def y0(self, value: float) -> None:
        self._bbox.y0 = value

    @property
    def x1(self) -> float:
        return self._bbox.x1

    @x1.setter
    def x1(self, value: float) -> None:
        self._bbox.x1 = value

    @property
    def y1(self) -> float:
        return self._bbox.y1

    @y1.setter
    def y1(self, value: float) -> None:
        self._bbox.y1 = value

    @property
    def cx(self) -> float:
        return self._bbox.cx

    @property
    def cy(self) -> float:
        return self._bbox.cy

    @property
    def width(self) -> float:
        return self._bbox.width

    @property
    def height(self) -> float:
        # 最小高度 3，与原 @dataclass 行为一致
        return max(self._bbox.height, 3)

    def __repr__(self) -> str:
        return (f'Token(text={self.text!r}, x0={self.x0}, y0={self.y0},'
                f' x1={self.x1}, y1={self.y1},'
                f' page={self.page}, confidence={self.confidence})')

    def __eq__(self, other) -> bool:
        if not isinstance(other, Token):
            return NotImplemented
        return (self.text == other.text
                and self._bbox == other._bbox
                and self.page == other.page
                and self.confidence == other.confidence)


class Line:
    """一行文本（含 token 列表和包围盒）

    内部持有 contracts.BBox 实例，对外通过属性代理暴露坐标。
    """
    __slots__ = ('text', 'tokens', 'page', '_bbox')

    def __init__(self, text: str = '', tokens: list = None,
                 page: int = 0, x0: float = 0.0, y0: float = 0.0,
                 x1: float = 0.0, y1: float = 0.0):
        self.text = text
        self.tokens = tokens if tokens is not None else []
        self.page = page
        self._bbox = BBox(x=x0, y=y0, width=x1 - x0, height=y1 - y0)

    # ── coordinate property proxies ───────────────────────────────────

    @property
    def x(self) -> float:
        return self._bbox.x

    @x.setter
    def x(self, value: float) -> None:
        self._bbox.x = value

    @property
    def y(self) -> float:
        return self._bbox.y

    @y.setter
    def y(self, value: float) -> None:
        self._bbox.y = value

    @property
    def x0(self) -> float:
        return self._bbox.x0

    @x0.setter
    def x0(self, value: float) -> None:
        self._bbox.x0 = value

    @property
    def y0(self) -> float:
        return self._bbox.y0

    @y0.setter
    def y0(self, value: float) -> None:
        self._bbox.y0 = value

    @property
    def x1(self) -> float:
        return self._bbox.x1

    @x1.setter
    def x1(self, value: float) -> None:
        self._bbox.x1 = value

    @property
    def y1(self) -> float:
        return self._bbox.y1

    @y1.setter
    def y1(self, value: float) -> None:
        self._bbox.y1 = value

    @property
    def cx(self) -> float:
        return self._bbox.cx

    @property
    def cy(self) -> float:
        return self._bbox.cy

    @property
    def width(self) -> float:
        return self._bbox.width

    @property
    def height(self) -> float:
        # 最小高度 3，与原 @dataclass 行为一致
        return max(self._bbox.height, 3)

    def __repr__(self) -> str:
        return (f'Line(text={self.text!r}, x0={self.x0}, y0={self.y0},'
                f' x1={self.x1}, y1={self.y1}, page={self.page},'
                f' tokens=[{len(self.tokens)}])')

    def __eq__(self, other) -> bool:
        if not isinstance(other, Line):
            return NotImplemented
        return (self.text == other.text
                and self.tokens == other.tokens
                and self.page == other.page
                and self._bbox == other._bbox)


class Region:
    """文档语义区域（header/buyer/items/summary/seller/footer/remark）

    内部持有 contracts.BBox 实例，对外通过属性代理暴露坐标。
    """
    __slots__ = ('name', 'page', '_bbox', 'lines', 'tokens')

    def __init__(self, name: str = '', page: int = 0,
                 x0: float = 0.0, y0: float = 0.0,
                 x1: float = 0.0, y1: float = 0.0,
                 lines: list = None, tokens: list = None):
        self.name = name
        self.page = page
        self._bbox = BBox(x=x0, y=y0, width=x1 - x0, height=y1 - y0)
        self.lines = lines if lines is not None else []
        self.tokens = tokens if tokens is not None else []

    # ── coordinate property proxies ───────────────────────────────────

    @property
    def x(self) -> float:
        return self._bbox.x

    @x.setter
    def x(self, value: float) -> None:
        self._bbox.x = value

    @property
    def y(self) -> float:
        return self._bbox.y

    @y.setter
    def y(self, value: float) -> None:
        self._bbox.y = value

    @property
    def x0(self) -> float:
        return self._bbox.x0

    @x0.setter
    def x0(self, value: float) -> None:
        self._bbox.x0 = value

    @property
    def y0(self) -> float:
        return self._bbox.y0

    @y0.setter
    def y0(self, value: float) -> None:
        self._bbox.y0 = value

    @property
    def x1(self) -> float:
        return self._bbox.x1

    @x1.setter
    def x1(self, value: float) -> None:
        self._bbox.x1 = value

    @property
    def y1(self) -> float:
        return self._bbox.y1

    @y1.setter
    def y1(self, value: float) -> None:
        self._bbox.y1 = value

    @property
    def cx(self) -> float:
        return self._bbox.cx

    @property
    def cy(self) -> float:
        return self._bbox.cy

    @property
    def width(self) -> float:
        return self._bbox.width

    @property
    def height(self) -> float:
        return self._bbox.height

    def __repr__(self) -> str:
        return (f'Region(name={self.name!r}, x0={self.x0}, y0={self.y0},'
                f' x1={self.x1}, y1={self.y1}, page={self.page},'
                f' lines=[{len(self.lines)}], tokens=[{len(self.tokens)}])')

    def __eq__(self, other) -> bool:
        if not isinstance(other, Region):
            return NotImplemented
        return (self.name == other.name
                and self.page == other.page
                and self._bbox == other._bbox
                and self.lines == other.lines
                and self.tokens == other.tokens)


@dataclass
class OCRDocument:
    """OCR 文档：一次解析后供所有提取器复用"""
    raw: str                                          # 原始 OCR 文本
    collapsed: str = ''                               # 去多余空白的单行文本
    lines: List[str] = field(default_factory=list)     # 行级文本（向后兼容）
    bbox_tokens: list = field(default_factory=list)  # 带边界框的 tokens（向后兼容）

    # --- 新增：统一中间模型 ---
    structured_lines: list = field(default_factory=list)  # List[Line] — 结构化行（含 token）
    tokens: list = field(default_factory=list)            # List[Token] — 统一 token 列表
    regions: dict = field(default_factory=dict)           # Dict[str, Region] — 语义区域
    pages: list = field(default_factory=list)             # List[int] — 页码列表
    source_type: str = ''                                  # pdf_text / pdf_ocr / image / ofd
    meta: dict = field(default_factory=dict)              # 额外元数据

    # --- 新增：字符级通路输出 ---
    page: object = None                                    # PyMuPDF Page 对象（由调用方设置）
    line_items_grid: list = field(default_factory=list)    # grid: List[List[str]]
    line_items_header_indices: list = field(default_factory=list)  # 表头行索引
    line_items_excel_rows: list = field(default_factory=list)      # grid_to_excel_rows 结果

    def __post_init__(self):
        if self.raw:
            import re
            # 区域控制标记仅供内部调试/辅助分区使用，不能进入字段解析与明细导出。
            self.raw = re.sub(r'\[(?:BUYER|SELLER)_(?:START|END)\]', ' ', self.raw)
            self.raw = re.sub(r'__AUX_[A-Za-z0-9_]+__(?:\s*)?', ' ', self.raw)
        if not self.collapsed:
            import re
            clean = self.raw.replace('：', ':').replace('\u3000', ' ').replace('\xa0', ' ')
            normalized = re.sub(r'[ \t\r]+', ' ', clean)
            self.collapsed = re.sub(r'\s+', ' ', normalized)
            self.lines = [l.strip() for l in normalized.split('\n') if l.strip()]
        # 单向兼容：如果外部传入了 bbox_tokens 但 tokens 为空，则同步
        if not self.tokens and self.bbox_tokens:
            self.tokens = self.bbox_tokens

    # --- 便捷方法 ---

    def get_region(self, name: str) -> Optional['Region']:
        """获取指定语义区域"""
        return self.regions.get(name)

    def region_text(self, name: str) -> str:
        """获取区域的文本内容"""
        region = self.regions.get(name)
        if not region:
            return ''
        if region.lines:
            return '\n'.join(
                l.text if isinstance(l, Line) else str(l)
                for l in region.lines
            )
        if region.tokens:
            return ' '.join(t.text for t in region.tokens)
        return ''

    # ─── 正则缓存：避免多个提取器重复扫描同一文本 ───
    # 适用场景：TypeExtractor 和 DateExtractor 各自对 doc.collapsed
    # 执行 re.search，缓存后第二个提取器直接命中，无需再扫。
    _re_cache: dict = None

    def _ensure_re_cache(self):
        if self._re_cache is None:
            self._re_cache = {}

    def cached_search(self, pattern, text=None, flags=0):
        """缓存版的 re.search。
        
        对同一 (pattern.pattern, text_id, flags) 三元组只执行一次搜索，
        后续调用直接返回缓存结果。
        
        Args:
            pattern: 编译好的 re.Pattern 对象或正则字符串
            text: 要搜索的文本，默认为 self.collapsed
            flags: 正则标志（仅对字符串模式生效）
        Returns:
            re.Match 或 None
        """
        self._ensure_re_cache()
        if text is None:
            text = self.collapsed
        # 预编译 pattern 优先取 .pattern 属性
        pat_str = getattr(pattern, 'pattern', pattern) if hasattr(pattern, 'pattern') else pattern
        key = (pat_str, id(text), flags)
        if key not in self._re_cache:
            compiled = pattern if hasattr(pattern, 'search') else re.compile(pat_str, flags)
            self._re_cache[key] = compiled.search(text)
        return self._re_cache[key]

    def cached_findall(self, pattern, text=None, flags=0):
        """缓存版的 re.findall，逻辑同 cached_search。"""
        self._ensure_re_cache()
        if text is None:
            text = self.collapsed
        pat_str = getattr(pattern, 'pattern', pattern) if hasattr(pattern, 'pattern') else pattern
        key = ('findall', pat_str, id(text), flags)
        if key not in self._re_cache:
            compiled = pattern if hasattr(pattern, 'findall') else re.compile(pat_str, flags)
            self._re_cache[key] = compiled.findall(text)
        return self._re_cache[key]

@dataclass
class AmountCandidate:
    """金额候选，带置信度评分，由 extractor 统一决策"""
    value: str
    confidence: int       # 0-100，越高越可信
    source: str           # 来源描述，如 "价税合计(小写)"、"合计行"、"末尾金额"

    def as_float(self) -> float:
        try:
            return float(self.value.replace(',', '').replace('¥', '').replace('￥', '').replace(' ', ''))
        except (ValueError, TypeError):
            return 0.0


@dataclass
class PartyCandidate:
    """购买方/销售方候选"""
    party_type: str       # "buyer" 或 "seller"
    field_type: str       # "name" 或 "tax_id"
    value: str
    confidence: int       # 0-100
    source: str           # 来源描述


@dataclass
class InvoiceLineItem:
    """发票明细行项目"""
    xmmc: str = ''       # 项目名称
    ggxh: str = ''       # 规格型号
    dw: str = ''         # 单位
    sl: str = ''         # 数量
    dj: str = ''         # 单价
    je: str = ''         # 金额（不含税）
    slv: str = ''        # 税率/征收率
    se: str = ''         # 税额

    def to_dict(self) -> dict:
        return {
            'xmmc': self.xmmc,
            'ggxh': self.ggxh,
            'dw': self.dw,
            'sl': self.sl,
            'dj': self.dj,
            'je': self.je,
            'slv': self.slv,
            'se': self.se,
        }


@dataclass
class FieldIssue:
    """字段级问题记录（失败/警告）"""
    field: str       # 字段名
    label: str       # 中文标签
    severity: str    # error / warning
    reason: str      # 失败/警告原因
    value: str = ''  # 当前值
    confidence: float = 0.0  # 置信度
    
    def to_dict(self) -> dict:
        return {
            'field': self.field,
            'label': self.label,
            'severity': self.severity,
            'reason': self.reason,
            'value': self.value,
            'confidence': self.confidence,
        }


@dataclass
class LineItemAdjustment:
    """明细行自动修正记录"""
    row: int              # 行号（从0开始）
    field: str            # 修正的字段名（sl/dj/je/slv/se）
    old_value: str        # 原值
    new_value: str        # 新值
    reason: str           # 修正原因
    auto_applied: bool    # 是否自动应用
    confidence: float     # 修正置信度（0-1）
    
    def to_dict(self) -> dict:
        return {
            'row': self.row,
            'field': self.field,
            'old_value': self.old_value,
            'new_value': self.new_value,
            'reason': self.reason,
            'auto_applied': self.auto_applied,
            'confidence': self.confidence,
        }


@dataclass
class InvoiceFields:
    """发票结构化字段"""
    type: str = '其他'              # 专票 / 普票 / 其他
    fphm: str = '未知号码'           # 发票号码
    kprq: str = '未知日期'           # 开票日期
    gmfmc: str = ''                 # 购买方名称
    gmfsh: str = ''                 # 购买方税号
    xsfmc: str = ''                 # 销售方名称
    xsfsh: str = ''                 # 销售方税号
    amountJe: str = ''              # 不含税金额
    amountSe: str = ''              # 税额
    amountHj: str = '0.00'          # 价税合计
    amountHjDx: str = ''            # 价税合计大写
    note: str = ''                  # 备注
    skr: str = ''                   # 收款人
    fhr: str = ''                   # 复核人
    kpr: str = ''                   # 开票人
    xmmc: str = ''                  # 项目名称（向后兼容，取第一条明细）
    line_items: List['InvoiceLineItem'] = field(default_factory=list)  # 明细行列表

    # --- 新增：校验与置信度 ---
    confidence: Dict[str, float] = field(default_factory=dict)   # 字段级置信度
    warnings: List[str] = field(default_factory=list)            # 校验警告
    corrections: List[str] = field(default_factory=list)         # 自动纠正记录
    
    # --- 新增：字段元数据（候选信息）---
    field_meta: Dict[str, dict] = field(default_factory=dict)     # 字段元数据，包含候选列表和警告
    
    # --- 新增：字段级失败/警告 ---
    failed_fields: List['FieldIssue'] = field(default_factory=list)     # 失败字段列表
    warning_fields: List['FieldIssue'] = field(default_factory=list)    # 警告字段列表
    
    # --- 新增：明细行修正记录 ---
    line_item_adjustments: List['LineItemAdjustment'] = field(default_factory=list)  # 明细行自动修正记录

    # --- 新增：字符级通路的 Excel 行数据 ---
    line_items_excel_rows: list = field(default_factory=list)  # grid_to_excel_rows 结果

    def to_dict(self, lightweight: bool = False) -> dict:
        # [PERF] 轻量模式：仅返回关键字段，跳过全量深拷贝
        if lightweight:
            return {
                'type': self.type,
                'fphm': self.fphm,
                'kprq': self.kprq,
                'gmfmc': self.gmfmc,
                'gmfsh': self.gmfsh,
                'xsfmc': self.xsfmc,
                'xsfsh': self.xsfsh,
                'amountJe': self.amountJe,
                'amountSe': self.amountSe,
                'amountHj': self.amountHj,
                'xmmc': self.xmmc,
                'line_items': [
                    {'xmmc': it.xmmc, 'je': it.je, 'se': it.se, 'slv': it.slv}
                    for it in self.line_items
                ],
            }

        result = {
            'type': self.type,
            'fphm': self.fphm,
            'kprq': self.kprq,
            'gmfmc': self.gmfmc,
            'gmfsh': self.gmfsh,
            'xsfmc': self.xsfmc,
            'xsfsh': self.xsfsh,
            'amountJe': self.amountJe,
            'amountSe': self.amountSe,
            'amountHj': self.amountHj,
            'amountHjDx': self.amountHjDx,
            'note': self.note,
            'skr': self.skr,
            'fhr': self.fhr,
            'kpr': self.kpr,
            'xmmc': self.xmmc,
            'line_items': [item.to_dict() for item in self.line_items],
        }
        # 新增字段：仅在有值时输出（向后兼容）
        if self.confidence:
            result['confidence'] = self.confidence
        if self.warnings:
            result['warnings'] = self.warnings
        if self.corrections:
            result['corrections'] = self.corrections
        if self.field_meta:
            result['field_meta'] = self.field_meta
        if self.failed_fields:
            result['failed_fields'] = [issue.to_dict() for issue in self.failed_fields]
        if self.warning_fields:
            result['warning_fields'] = [issue.to_dict() for issue in self.warning_fields]
        if self.line_item_adjustments:
            result['line_item_adjustments'] = [adj.to_dict() for adj in self.line_item_adjustments]
        if self.line_items_excel_rows:
            result['line_items_excel_rows'] = self.line_items_excel_rows
        return result
