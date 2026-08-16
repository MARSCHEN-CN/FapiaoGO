"""
发票表格识别模块

将明细行提取升级为表格识别，支持：
- 跨行项目名称
- 空规格型号
- 数量/单价/金额错位
- 折扣行和负数行
- 多税率
- 多明细

输出标准化的 InvoiceItem 列表。
"""

from __future__ import annotations

import re
import logging
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Tuple, Any

from ..models import OCRDocument, Token
from ..segments import SegmentedDocument, DocumentSegment

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════
# 数据模型
# ═══════════════════════════════════════════════════════

@dataclass
class InvoiceItem:
    """发票明细项目"""
    name: str = ''              # 项目名称
    spec: str = ''              # 规格型号
    unit: str = ''              # 单位
    quantity: str = ''          # 数量
    unit_price: str = ''        # 单价
    amount: str = ''            # 金额
    tax_rate: str = ''          # 税率
    tax_amount: str = ''        # 税额
    
    @property
    def has_data(self) -> bool:
        """判断是否有实质性数据"""
        return any([self.amount, self.quantity, self.unit_price, 
                    self.tax_rate, self.tax_amount])
    
    def to_dict(self) -> Dict[str, str]:
        """转换为字典格式"""
        return {
            'name': self.name,
            'spec': self.spec,
            'unit': self.unit,
            'quantity': self.quantity,
            'unit_price': self.unit_price,
            'amount': self.amount,
            'tax_rate': self.tax_rate,
            'tax_amount': self.tax_amount,
        }
    
    def __repr__(self) -> str:
        return (f"InvoiceItem(name={self.name!r}, spec={self.spec!r}, "
                f"unit={self.unit!r}, amount={self.amount!r})")


@dataclass
class TableColumn:
    """表格列定义"""
    name: str           # 列名（如 'name', 'spec', 'quantity'）
    label: str          # 显示标签
    start_x: float = 0  # 列起始 x 坐标
    end_x: float = 0    # 列结束 x 坐标
    tokens: List[Any] = field(default_factory=list)  # 该列的 tokens
    
    @property
    def center_x(self) -> float:
        return (self.start_x + self.end_x) / 2
    
    @property
    def width(self) -> float:
        return self.end_x - self.start_x


# ═══════════════════════════════════════════════════════
# 常量定义
# ═══════════════════════════════════════════════════════

# 表头字段映射
_HEADER_FIELD_MAP: List[Tuple[re.Pattern, str, str]] = [
    # (正则模式, 列名, 显示标签)
    (re.compile(r'项目名称|货物.*名称|服务名称|品名|商品名称'), 'name', '项目名称'),
    (re.compile(r'规格型号|型号|规格'), 'spec', '规格型号'),
    (re.compile(r'单\s*位|计量.*单位'), 'unit', '单位'),
    (re.compile(r'数\s*量'), 'quantity', '数量'),
    (re.compile(r'单\s*价'), 'unit_price', '单价'),
    (re.compile(r'金\s*额|价税合计|小计'), 'amount', '金额'),
    (re.compile(r'税\s*率|征收率'), 'tax_rate', '税率'),
    (re.compile(r'税\s*额'), 'tax_amount', '税额'),
]

# 常见单位
_COMMON_UNITS: frozenset[str] = frozenset({
    '台', '个', '次', '套', '件', '批', '项', '组', '条',
    '吨', 'kg', '千克', '克', 'g', '毫克', 'mg', '磅', '盎司',
    '米', 'm', '厘米', 'cm', '毫米', 'mm', '公里', 'km',
    '㎡', 'm²', '平方米', '平方', '立方米', '亩', '公顷',
    '升', 'L', '毫升', 'ml', '加仑',
    '箱', '包', '卷', '张', '本', '册', '份', '盒', '瓶',
    '袋', '桶', '罐', '壶', '根', '块', '粒', '颗', '只',
    '支', '坛', '筐', '篓', '令', '把', '片',
    '小时', '天', '年', '月',
    '人', '对', '双', '班', '课', '期', '轮', '场',
})

# 金额模式
_AMOUNT_RE = re.compile(r'^-?[\d,]+\.\d{2}$')
_AMOUNT_LOOSE_RE = re.compile(r'^-?[\d,]+(?:\.\d{1,4})?$')
_RATE_RE = re.compile(r'^-?\d+(?:\.\d+)?%$|^免税$')
_NUMBER_RE = re.compile(r'^[\d,]+(\.\d+)?$')

# 黑名单模式
_INVOICE_NUMBER_RE = re.compile(r'^\d{8,20}$')
_TAX_ID_RE = re.compile(r'^[0-9A-Za-z]{15,20}$')
_DATE_RE = re.compile(
    r'^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?$'
    r'|^\d{4}[-/]\d{1,2}[-/]\d{1,2}$'
    r'|^\d{4}\.\d{1,2}\.\d{1,2}$'
)
_SUMMARY_RE = re.compile(r'(?:^|(?<=[\s:：]))(?:合\s*计|价税合计|小计)(?:\s|$|[:：])')


# ═══════════════════════════════════════════════════════
# 工具函数
# ═══════════════════════════════════════════════════════

def _is_blacklisted_token(token_text: str) -> bool:
    """检查 token 是否在黑名单中"""
    if not token_text:
        return True
    text = token_text.strip()
    if not text:
        return True
    
    # 发票号码
    if _INVOICE_NUMBER_RE.match(text):
        return True
    # 税号
    if _TAX_ID_RE.match(text):
        return True
    # 日期
    if _DATE_RE.match(text):
        return True
    # 中文大写金额
    if re.search(r'[零壹贰叁肆伍陆柒捌玖拾佰仟万亿元角分整负]', text):
        return True
    return False


def _is_amount(token: str) -> bool:
    """判断是否为金额"""
    return bool(_AMOUNT_RE.match(token)) or bool(_AMOUNT_LOOSE_RE.match(token))


def _is_rate(token: str) -> bool:
    """判断是否为税率"""
    return bool(_RATE_RE.match(token))


def _is_unit(token: str) -> bool:
    """判断是否为单位"""
    return token in _COMMON_UNITS


def _clean_amount(s: str) -> str:
    """清理金额字符串"""
    return s.replace(',', '').replace(' ', '').replace('¥', '').replace('￥', '')


# ═══════════════════════════════════════════════════════
# 表格识别器
# ═══════════════════════════════════════════════════════

class InvoiceTableExtractor:
    """发票表格识别器
    
    核心能力：
    1. 检测表头行
    2. 推断列结构
    3. 将 tokens 分配到列
    4. 构建完整行数据
    5. 规范化输出
    """
    
    def __init__(self):
        self._logger = logging.getLogger(__name__)
    
    def extract(self, seg: DocumentSegment) -> List[InvoiceItem]:
        """从分段中提取表格数据
        
        Args:
            seg: DocumentSegment，包含 lines 和 tokens
        
        Returns:
            List[InvoiceItem]: 提取的明细项目列表
        """
        # 优先使用 bbox 数据（更精确的坐标信息）
        if seg.tokens:
            items = self._extract_from_bbox(seg)
            if items:
                return items
        
        # 回退到纯文本解析
        return self._extract_from_text(seg)
    
    def _extract_from_bbox(self, seg: DocumentSegment) -> List[InvoiceItem]:
        """使用 bbox 坐标提取表格"""
        tokens = [t for t in seg.tokens if not _is_blacklisted_token(t.text)]
        if not tokens:
            return []
        
        # Step 1: 行聚类
        rows = self._cluster_rows_by_y(tokens)
        if len(rows) < 2:  # 至少需要表头 + 一行数据
            return []
        
        # Step 2: 检测表头行
        header_idx = self._detect_header_row(rows)
        if header_idx < 0:
            return []
        
        # Step 3: 推断列结构
        columns = self._infer_columns_from_header(rows[header_idx])
        if not columns:
            return []
        
        # Step 4: 分配 tokens 到列并构建行
        items = []
        for row_tokens in rows[header_idx + 1:]:
            row_text = ' '.join(t.text for t in row_tokens)
            if _SUMMARY_RE.search(row_text):
                break
            
            item = self._assign_tokens_to_item(row_tokens, columns)
            if item and item.has_data:
                items.append(item)
        
        # Step 5: 规范化和后处理
        return self._normalize_items(items)
    
    def _extract_from_text(self, seg: DocumentSegment) -> List[InvoiceItem]:
        """从纯文本提取表格（回退方案）"""
        if not seg.lines:
            return []
        
        # 预处理：合并跨行项目名称
        merged_lines = self._preprocess_merged_lines(seg.lines)
        
        items = []
        for line in merged_lines:
            line = line.strip()
            if not line:
                continue
            if _SUMMARY_RE.search(line):
                break
            
            item = self._parse_line_to_item(line)
            if item and item.has_data:
                items.append(item)
        
        return self._normalize_items(items)
    
    def _cluster_rows_by_y(self, tokens: List[Token]) -> List[List[Token]]:
        """按 y 坐标聚类 tokens 到行"""
        if not tokens:
            return []
        
        # 按 y 坐标排序
        sorted_tokens = sorted(tokens, key=lambda t: t.cy)
        
        rows = []
        current_row = [sorted_tokens[0]]
        current_min_y = sorted_tokens[0].y0
        current_max_y = sorted_tokens[0].y1
        
        for token in sorted_tokens[1:]:
            # 计算重叠度
            overlap_start = max(token.y0, current_min_y)
            overlap_end = min(token.y1, current_max_y)
            overlap = max(0.0, overlap_end - overlap_start)
            token_height = token.y1 - token.y0
            
            if token_height == 0:
                overlap_ratio = 1.0
            else:
                overlap_ratio = overlap / token_height
            
            if overlap_ratio >= 0.4:
                # 属于同一行
                current_row.append(token)
                current_min_y = min(current_min_y, token.y0)
                current_max_y = max(current_max_y, token.y1)
            else:
                # 新行
                rows.append(sorted(current_row, key=lambda t: t.x0))
                current_row = [token]
                current_min_y = token.y0
                current_max_y = token.y1
        
        if current_row:
            rows.append(sorted(current_row, key=lambda t: t.x0))
        
        return rows
    
    def _detect_header_row(self, rows: List[List[Token]]) -> int:
        """检测表头行"""
        for idx, row in enumerate(rows):
            row_text = ' '.join(t.text for t in row)
            hits = 0
            for pattern, _, _ in _HEADER_FIELD_MAP:
                if pattern.search(row_text):
                    hits += 1
            if hits >= 2:
                return idx
        return -1
    
    def _infer_columns_from_header(self, header_tokens: List[Token]) -> List[TableColumn]:
        """从表头推断列结构"""
        columns = []
        
        # 找出所有表头字段的位置
        field_positions = []
        for token in header_tokens:
            text = token.text.strip()
            for pattern, col_name, label in _HEADER_FIELD_MAP:
                if pattern.search(text):
                    field_positions.append({
                        'col_name': col_name,
                        'label': label,
                        'x0': token.x0,
                        'x1': token.x1,
                    })
                    break
        
        if not field_positions:
            return []
        
        # 按 x 坐标排序
        field_positions.sort(key=lambda x: x['x0'])
        
        # 推断列边界
        for i, pos in enumerate(field_positions):
            start_x = pos['x0']
            if i < len(field_positions) - 1:
                # 与下一列平分
                next_x = field_positions[i + 1]['x0']
                end_x = (pos['x1'] + next_x) / 2
            else:
                # 最后一列延伸到最右端
                end_x = header_tokens[-1].x1 + 100  # 扩展边界
            
            columns.append(TableColumn(
                name=pos['col_name'],
                label=pos['label'],
                start_x=start_x,
                end_x=end_x,
            ))
        
        return columns
    
    def _assign_tokens_to_item(self, row_tokens: List[Token], 
                               columns: List[TableColumn]) -> InvoiceItem:
        """将 tokens 分配到列并构建 InvoiceItem"""
        item = InvoiceItem()
        col_tokens: Dict[str, List[str]] = {}
        
        # 按列分配 tokens
        for token in row_tokens:
            token_center_x = token.cx
            assigned = False
            
            for col in columns:
                if col.start_x <= token_center_x <= col.end_x:
                    if col.name not in col_tokens:
                        col_tokens[col.name] = []
                    col_tokens[col.name].append(token.text)
                    assigned = True
                    break
            
            # 如果没有分配到任何列，尝试作为项目名称（跨行情况）
            if not assigned and item.name:
                item.name += ' ' + token.text
        
        # 填充字段
        for col_name, tokens in col_tokens.items():
            value = ' '.join(tokens).strip()
            if col_name == 'name':
                item.name = value
            elif col_name == 'spec':
                item.spec = value
            elif col_name == 'unit':
                item.unit = value
            elif col_name == 'quantity':
                item.quantity = _clean_amount(value)
            elif col_name == 'unit_price':
                item.unit_price = _clean_amount(value)
            elif col_name == 'amount':
                item.amount = _clean_amount(value)
            elif col_name == 'tax_rate':
                item.tax_rate = value
            elif col_name == 'tax_amount':
                item.tax_amount = _clean_amount(value)
        
        return item
    
    def _preprocess_merged_lines(self, lines: List[str]) -> List[str]:
        """预处理：合并跨行项目名称"""
        result = []
        pending_name = []
        
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            
            # 检测是否为数据行（包含金额/税率/单位）
            has_amount = _is_amount(stripped) or _is_rate(stripped)
            has_unit = any(unit in stripped for unit in _COMMON_UNITS)
            has_number = re.search(r'^\d+$', stripped)
            
            if has_amount or has_unit or has_number:
                # 数据行：合并之前的名称
                if pending_name:
                    result.append(' '.join(pending_name) + ' ' + stripped)
                    pending_name = []
                else:
                    result.append(stripped)
            else:
                # 名称行：暂存
                pending_name.append(stripped)
        
        # 处理尾部残留
        if pending_name:
            if result:
                result[-1] += ' ' + ' '.join(pending_name)
            else:
                result.extend(pending_name)
        
        return result
    
    def _parse_line_to_item(self, line: str) -> InvoiceItem:
        """解析单行文本为 InvoiceItem"""
        item = InvoiceItem()
        
        # 简单的从右向左解析
        parts = line.split()
        if not parts:
            return item
        
        # 从右向左找数值字段
        remaining = parts.copy()
        
        # 找税额（通常在最右边）
        for i in reversed(range(len(remaining))):
            if _is_amount(remaining[i]):
                item.tax_amount = _clean_amount(remaining[i])
                del remaining[i]
                break
        
        # 找税率
        for i in reversed(range(len(remaining))):
            if _is_rate(remaining[i]):
                item.tax_rate = remaining[i]
                del remaining[i]
                break
        
        # 找金额
        for i in reversed(range(len(remaining))):
            if _is_amount(remaining[i]):
                item.amount = _clean_amount(remaining[i])
                del remaining[i]
                break
        
        # 找单价
        for i in reversed(range(len(remaining))):
            if _is_amount(remaining[i]) or re.match(r'^\d+\.?\d*$', remaining[i]):
                item.unit_price = _clean_amount(remaining[i])
                del remaining[i]
                break
        
        # 找数量
        for i in reversed(range(len(remaining))):
            if re.match(r'^\d+\.?\d*$', remaining[i]):
                item.quantity = _clean_amount(remaining[i])
                del remaining[i]
                break
        
        # 找单位
        for i in reversed(range(len(remaining))):
            if _is_unit(remaining[i]):
                item.unit = remaining[i]
                del remaining[i]
                break
        
        # 剩下的作为项目名称和规格
        if remaining:
            # 尝试分离名称和规格
            name_parts = []
            spec_parts = []
            
            for part in remaining:
                # 规格通常包含数字、字母组合或符号
                if re.search(r'[\d×xX/-]', part) and len(part) <= 20:
                    spec_parts.append(part)
                else:
                    name_parts.append(part)
            
            item.name = ' '.join(name_parts).strip()
            item.spec = ' '.join(spec_parts).strip()
        
        return item
    
    def _normalize_items(self, items: List[InvoiceItem]) -> List[InvoiceItem]:
        """规范化项目列表"""
        if not items:
            return []
        
        # 后处理：派生缺失字段、交叉校验
        for item in items:
            self._derive_missing_fields(item)
            self._cross_validate(item)
        
        # 过滤无效项目
        return [item for item in items if item.has_data]
    
    def _derive_missing_fields(self, item: InvoiceItem) -> None:
        """派生缺失字段"""
        # 从金额和税率派生税额
        if item.amount and item.tax_rate and not item.tax_amount:
            try:
                amount = float(item.amount)
                rate = float(item.tax_rate.rstrip('%'))
                item.tax_amount = f"{amount * rate / 100:.2f}"
            except (ValueError, TypeError):
                pass
        
        # 从金额和税额派生税率
        if item.amount and item.tax_amount and not item.tax_rate:
            try:
                amount = float(item.amount)
                tax = float(item.tax_amount)
                if amount > 0:
                    rate = tax / amount * 100
                    item.tax_rate = f"{rate:.2f}%"
            except (ValueError, TypeError):
                pass
        
        # 从数量和单价计算金额
        if item.quantity and item.unit_price and not item.amount:
            try:
                qty = float(item.quantity)
                price = float(item.unit_price)
                item.amount = f"{qty * price:.2f}"
            except (ValueError, TypeError):
                pass
    
    def _cross_validate(self, item: InvoiceItem) -> None:
        """交叉校验字段"""
        if not item.amount:
            return
        
        # 校验数量 × 单价 = 金额
        if item.quantity and item.unit_price and item.amount:
            try:
                qty = float(item.quantity)
                price = float(item.unit_price)
                expected = qty * price
                actual = float(item.amount)
                
                if abs(expected - actual) > 0.01:
                    # 修正金额
                    item.amount = f"{expected:.2f}"
            except (ValueError, TypeError):
                pass
        
        # 校验金额 × 税率 = 税额
        if item.tax_rate and item.tax_amount:
            try:
                amount = float(item.amount)
                rate = float(item.tax_rate.rstrip('%'))
                expected_tax = amount * rate / 100
                actual_tax = float(item.tax_amount)
                
                if abs(expected_tax - actual_tax) > 0.01:
                    item.tax_amount = f"{expected_tax:.2f}"
            except (ValueError, TypeError):
                pass
    
    def get_summary(self, items: List[InvoiceItem]) -> Dict[str, float]:
        """计算汇总信息"""
        summary = {
            'total_amount': 0.0,
            'total_tax': 0.0,
            'item_count': len(items),
        }
        
        for item in items:
            if item.amount:
                try:
                    summary['total_amount'] += float(item.amount)
                except (ValueError, TypeError):
                    pass
            if item.tax_amount:
                try:
                    summary['total_tax'] += float(item.tax_amount)
                except (ValueError, TypeError):
                    pass
        
        return summary
