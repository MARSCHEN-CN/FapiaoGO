"""
Excel / CSV 导出模块

从 app.py 拆出，负责所有 Excel/CSV 导出的业务逻辑：
- 路径校验与安全清洗
- CSV 写入
- XLSX 写入（含样式、分组合并、quantity 字符串保留、金额右对齐）

app.py 中的 Flask 路由保留不变，仅调用本模块的导出函数。
"""

import re
import os
import csv
import logging
from pathlib import Path
from decimal import Decimal
from itertools import groupby

# openpyxl 样式（仅在 XLSX 导出时使用）
try:
    from openpyxl.styles import Font, PatternFill, Border, Side
except ImportError:
    Font = PatternFill = Border = Side = None

logger = logging.getLogger(__name__)

# 预编译正则表达式（模块加载时编译一次，避免每次调用重复编译）
_PATTERN_BUYER_SELLER = re.compile(r'\[(?:BUYER|SELLER)_(?:START|END)\]')
_PATTERN_AUX = re.compile(r'__AUX_[A-Za-z0-9_]+__')
_PATTERN_WHITESPACE = re.compile(r'\s+')

EXCEL_FORMULA_PREFIXES = ('=', '+', '-', '@')
EXPORT_ALLOWED_EXTENSIONS = {'xlsx', 'csv'}

EXPORT_ALLOWED_BASE_DIRS = [
    str(Path.home()),
    str(Path.home() / 'Desktop'),
    str(Path.home() / 'Documents'),
    str(Path.home() / 'Downloads'),
]


# ═══════════════════════════════════════════════════════════
#  导出列定义（字段选择 / 列驱动导出）
# ═══════════════════════════════════════════════════════════

# Excel 允许导出的字段白名单：exporter 不信任客户端传入的 columns，
# 越权 / 未知 key 一律丢弃（防止前端误传非导出字段）。
ALLOWED_EXPORT_KEYS = {
    'serialNo', 'invoiceType', 'invoiceDate', 'invoiceNumber',
    'amountWithoutTax', 'taxAmount', 'totalAmount',
    'buyerName', 'buyerTaxNo', 'sellerName', 'sellerTaxNo', 'issuer',
    'classificationCode', 'xmmc', 'ggxh', 'unit', 'quantity',
    'unitPrice', 'lineAmount', 'taxRate', 'lineTax',
    'note', 'originalFilename',
}

# 字段默认宽度（与前端 excelColumns.js 真源对齐，作宽度回退）。
MASTER_WIDTH = {
    'serialNo': 8, 'invoiceType': 12, 'invoiceDate': 12, 'invoiceNumber': 20,
    'amountWithoutTax': 12, 'taxAmount': 12, 'totalAmount': 12,
    'buyerName': 25, 'buyerTaxNo': 20, 'sellerName': 25, 'sellerTaxNo': 20, 'issuer': 10,
    'classificationCode': 18, 'xmmc': 35, 'ggxh': 20, 'unit': 8,
    'quantity': 10, 'unitPrice': 12, 'lineAmount': 12, 'taxRate': 12,
    'lineTax': 12, 'note': 30, 'originalFilename': 35,
}

# 发票级字段：同一发票多行明细时合并这些列（仅对当前列中存在的 key 生效）。
INVOICE_LEVEL_KEYS = {
    'serialNo', 'invoiceType', 'invoiceDate', 'invoiceNumber',
    'amountWithoutTax', 'taxAmount', 'totalAmount',
    'buyerName', 'buyerTaxNo', 'sellerName', 'sellerTaxNo', 'issuer',
    'note', 'originalFilename',
}


def _invoice_identity(rec):
    """发票去重 / 分组身份（前后端共用规则）。

    recordId → 原文件名 → 发票号 → __ANON_{id}（稳定，不每次生成新对象）。
    用于预览序号、合计行去重、XLSX 分组合并，保证「预览 == 导出」。
    """
    return rec.get('recordId') or rec.get('originalFilename') or rec.get('invoiceNumber') or f"__ANON_{id(rec)}"


def sanitize_columns(columns):
    """校验并裁剪客户端传入的列定义。

    - 仅保留 ALLOWED_EXPORT_KEYS 内的 key，丢弃越权 key
    - 保持传入顺序（不排序，尊重用户字段选择顺序）
    - 透传 virtual 标记（serialNo 由写行序号生成，不读 inv）
    返回 None 表示未指定（调用方走默认全列）。
    """
    if not columns:
        return None
    out = []
    for c in columns:
        if not isinstance(c, dict):
            continue
        key = c.get('key')
        if key not in ALLOWED_EXPORT_KEYS:
            continue
        out.append({
            'key': key,
            'label': c.get('label') or key,
            'width': int(c.get('width') or MASTER_WIDTH.get(key, 12)),
            'virtual': bool(c.get('virtual')),
        })
    return out or None


# ═══════════════════════════════════════════════════════════
#  路径校验
# ═══════════════════════════════════════════════════════════

def _is_path_traversal(path: str) -> bool:
    """检测路径遍历攻击"""
    if not path:
        return False
    
    if '..' in path:
        if path.startswith('..'):
            return True
        if path.startswith('/..') or path.startswith('\\..'):
            return True
        if '/../' in path or '\\..\\' in path:
            return True
        if '/..' == path[-3:] or '\\..' == path[-3:]:
            return True
    
    normalized = os.path.normpath(path)
    parts = normalized.split(os.sep)
    for part in parts:
        if part == '..':
            return True
    
    return False


def _is_path_inside_bases(path: str, bases: list) -> bool:
    """验证路径是否在允许的基础目录列表内"""
    try:
        abs_path = os.path.abspath(os.path.normpath(path))
        for base in bases:
            abs_base = os.path.abspath(os.path.normpath(base))
            if not abs_base.endswith(os.sep):
                abs_base += os.sep
            if abs_path.startswith(abs_base):
                return True
        return False
    except (OSError, ValueError):
        return False


def validate_export_path(file_path, fmt):
    """校验导出路径和格式，避免错误扩展名与明显危险路径。"""
    if not isinstance(file_path, str) or not file_path.strip():
        raise ValueError("缺少 filePath 参数")

    raw_path = os.path.expanduser(file_path.strip())
    
    if _is_path_traversal(raw_path):
        raise ValueError("检测到路径遍历攻击")

    if not os.path.isabs(raw_path):
        raise ValueError("导出路径必须是绝对路径")

    normalized_path = os.path.abspath(raw_path)
    
    if not _is_path_inside_bases(normalized_path, EXPORT_ALLOWED_BASE_DIRS):
        raise ValueError(f"导出路径必须在以下目录内: {', '.join(EXPORT_ALLOWED_BASE_DIRS)}")

    requested_ext = str(fmt).lower().lstrip('.')
    actual_ext = os.path.splitext(normalized_path)[1].lower().lstrip('.')

    if requested_ext not in EXPORT_ALLOWED_EXTENSIONS:
        raise ValueError("不支持的导出格式")
    if actual_ext != requested_ext:
        raise ValueError(f"导出文件扩展名必须为 .{requested_ext}")

    parent_dir = os.path.dirname(normalized_path)
    if not parent_dir or not os.path.isdir(parent_dir):
        raise ValueError("导出目录不存在")

    return normalized_path, requested_ext


# ═══════════════════════════════════════════════════════════
#  安全清洗
# ═══════════════════════════════════════════════════════════

def sanitize_excel_text(value):
    """避免 CSV/XLSX 公式注入，并清理历史解析控制标记。"""
    if not isinstance(value, str):
        return value
    value = _PATTERN_BUYER_SELLER.sub(' ', value)  # 使用预编译正则
    value = _PATTERN_AUX.sub(' ', value)            # 使用预编译正则
    value = _PATTERN_WHITESPACE.sub(' ', value).strip()  # 使用预编译正则
    if value and value[0] in EXCEL_FORMULA_PREFIXES:
        return f"'{value}"
    return value


def sanitize_export_row(row):
    """清洗整行数据（用于 CSV）。"""
    return [sanitize_excel_text(value) for value in row]


# ═══════════════════════════════════════════════════════════
#  sheet 名称清洗
# ═══════════════════════════════════════════════════════════

def sanitize_sheet_name(name, max_len=31):
    """清理 Excel sheet 名称（去除非法字符，限制长度）。"""
    sanitized = re.sub(r'[\[\]\*\/\\\?:]', '_', name)[:max_len]
    return sanitized or 'Sheet'


# ═══════════════════════════════════════════════════════════
#  XLSX 写入器
# ═══════════════════════════════════════════════════════════

class XlsxWriter:
    """XLSX 导出器，封装样式、清洗、分组写入逻辑。

    用法::

        writer = XlsxWriter(include_remark=True,
                            on_progress=callback, sanitize_fn=sanitize_excel_text)
        writer.write_summary_sheet(ws, invoices, sheet_label='发票汇总')
    """

    def __init__(self, include_remark, on_progress, sanitize_fn):
        try:
            from openpyxl.styles import Alignment
            from openpyxl.utils import get_column_letter
        except ImportError:
            raise RuntimeError("需要安装 openpyxl: pip install openpyxl")

        self.include_remark = include_remark
        self.on_progress = on_progress
        self._sanitize = sanitize_fn

        # ── 样式常量 ──
        thin_side = Side(style='thin')
        self.thin_border = Border(
            left=thin_side, right=thin_side,
            top=thin_side, bottom=thin_side,
        )
        self.header_font = Font(bold=True, size=11)
        self.header_fill = PatternFill(start_color='DDEBF7', end_color='DDEBF7', fill_type='solid')
        self.header_align = Alignment(vertical='center', horizontal='center')
        self.data_align = Alignment(vertical='center')
        self._right_align = Alignment(vertical='center', horizontal='right')
        self.money_fmt = '#,##0.00'
        self.money_keys = {
            'amountWithoutTax', 'taxAmount', 'totalAmount',
            'unitPrice', 'lineAmount', 'lineTax',
        }
        self._get_column_letter = get_column_letter

    # ── 内部工具 ──

    def _safe_num(self, val):
        """安全转为数值（金额用）；不可转时走文本清洗。"""
        if val is None or val == '':
            return None
        try:
            return float(str(val).replace(',', ''))
        except (ValueError, TypeError):
            return self._sanitize(val)

    # ── 核心写入 ──

    def write_summary_sheet(self, ws, sheet_invoices, serial_start=1, sheet_label='', columns=None):
        """设置汇总 sheet（含发票级字段合并 + quantity 原始字符串保留）。

        columns: 可选，由调用方指定的列定义列表
                 [{key, label, width, virtual}, ...]，顺序即用户选择顺序。
                 为 None 时走历史默认列（含 include_remark 控制备注/原文件名）。
        """
        get_col = self._get_column_letter
        on_progress = self.on_progress

        if columns:
            # 新路径：列由调用方指定（顺序即用户选择顺序，不排序）
            cols = [(c['label'], c['key'], c['width'], bool(c.get('virtual')))
                    for c in columns]
            group_key_fn = _invoice_identity
        else:
            # 旧路径：保持历史默认列序（含 include_remark 控制备注/原文件名）
            cols = [
                ('序号', 'serialNo', 8, False),
                ('发票类型', 'invoiceType', 12, False),
                ('开票日期', 'invoiceDate', 12, False),
                ('发票号码', 'invoiceNumber', 20, False),
                ('税前金额', 'amountWithoutTax', 12, False),
                ('税额合计', 'taxAmount', 12, False),
                ('价税合计', 'totalAmount', 12, False),
                ('购买方名称', 'buyerName', 25, False),
                ('购买方税号', 'buyerTaxNo', 20, False),
                ('销售方名称', 'sellerName', 25, False),
                ('销售方税号', 'sellerTaxNo', 20, False),
                ('开票人', 'issuer', 10, False),
                ('分类编码', 'classificationCode', 18, False),
                ('项目名称', 'xmmc', 35, False),
                ('规格型号', 'ggxh', 20, False),
                ('单位', 'unit', 8, False),
                ('数量', 'quantity', 10, False),
                ('单价', 'unitPrice', 12, False),
                ('金额', 'lineAmount', 12, False),
                ('税率/征收率', 'taxRate', 12, False),
                ('税额', 'lineTax', 12, False),
            ]
            if self.include_remark:
                cols.extend([('备注', 'note', 30, False), ('原文件名', 'originalFilename', 35, False)])
            group_key_fn = lambda inv: inv.get('invoiceNumber') or f'__UNIQUE_{id(inv)}'

        # key → 列序号 映射（用于 merge_cells）
        col_index_map = {}
        for c, (_, key, _, _) in enumerate(cols, 1):
            col_index_map[key] = c

        # 写表头
        for c, (header, _, width, _virtual) in enumerate(cols, 1):
            cell = ws.cell(row=1, column=c, value=header)
            cell.font = self.header_font
            cell.fill = self.header_fill
            cell.alignment = self.header_align
            cell.border = self.thin_border
            ws.column_dimensions[get_col(c)].width = width

        # 按发票身份分组（同一发票多明细分组合并）
        group_map = {}
        for inv in sheet_invoices:
            key = group_key_fn(inv)
            if key not in group_map:
                group_map[key] = []
            group_map[key].append(inv)

        sheet_total = len(sheet_invoices)
        update_interval = max(1, sheet_total // 15)

        serial = serial_start
        row_idx = 2
        written = 0

        for group in group_map.values():
            start_row = row_idx
            row_count = len(group)

            for inv in group:
                for c, (_, key, _, virtual) in enumerate(cols, 1):
                    if key == 'serialNo' or virtual:
                        val = serial   # 序号 / 虚拟列由计数器生成，不读 inv
                    else:
                        raw = inv.get(key, '')
                        if key in self.money_keys:
                            val = self._safe_num(raw)
                        elif key == 'quantity':
                            # 借鉴 ExcelJS：整数保持字符串（防 "001" → 1）
                            q_str = str(raw) if raw else ''
                            try:
                                q_num = float(q_str.replace(',', ''))
                                if q_num != int(q_num):
                                    val = q_num
                                else:
                                    val = q_str
                            except (ValueError, TypeError):
                                val = self._sanitize(raw)
                        else:
                            val = self._sanitize(raw)
                    cell = ws.cell(row=row_idx, column=c, value=val)
                    cell.border = self.thin_border
                    if key in self.money_keys and isinstance(val, (int, float)):
                        cell.number_format = self.money_fmt
                        cell.alignment = self._right_align
                    else:
                        cell.alignment = self.data_align
                row_idx += 1
                written += 1

                if on_progress and written % update_interval == 0:
                    on_progress(15 + int(55 * written / max(sheet_total, 1)), 100,
                               f'写入{sheet_label} ({written}/{sheet_total})...')
            serial += 1  # 每张发票递增序号
            if row_count > 1:
                end_row = start_row + row_count - 1
                for ikey in INVOICE_LEVEL_KEYS:
                    ci = col_index_map.get(ikey)
                    if ci:
                        cl = get_col(ci)
                        ws.merge_cells(f'{cl}{start_row}:{cl}{end_row}')

        # ── 写合计行 ──
        seen_invoices = set()
        total_amount_without_tax = Decimal('0')
        total_tax_amount = Decimal('0')
        total_total_amount = Decimal('0')
        total_line_amount = Decimal('0')
        total_line_tax = Decimal('0')

        for group in group_map.values():
            for inv in group:
                inv_id = group_key_fn(inv)
                if inv_id not in seen_invoices:
                    seen_invoices.add(inv_id)
                    total_amount_without_tax += Decimal(str(
                        self._safe_num(inv.get('amountWithoutTax', 0))))
                    total_tax_amount += Decimal(str(
                        self._safe_num(inv.get('taxAmount', 0))))
                    total_total_amount += Decimal(str(
                        self._safe_num(inv.get('totalAmount', 0))))
                total_line_amount += Decimal(str(
                    self._safe_num(inv.get('lineAmount', 0))))
                total_line_tax += Decimal(str(
                    self._safe_num(inv.get('lineTax', 0))))

        # 列名→列号映射（防硬编码错位）
        col_map = {cell.value: cell.column for cell in ws[1] if cell.value}

        # 合计行样式
        total_font = Font(bold=True, size=11)
        total_fill = PatternFill(start_color='E2EFDA', end_color='E2EFDA', fill_type='solid')
        total_border = Border(
            top=Side(style='thin'),
            bottom=Side(style='double'),
        )

        # 写入合计行
        ws.cell(row=row_idx, column=1, value='合计')
        ws.cell(row=row_idx, column=1).font = total_font
        ws.cell(row=row_idx, column=1).fill = total_fill

        # 按列名映射写入合计金额（不存在则跳过，不报错）
        total_money_map = {
            '税前金额': total_amount_without_tax,
            '税额合计': total_tax_amount,
            '价税合计': total_total_amount,
            '金额': total_line_amount,
            '税额': total_line_tax,
        }
        for col_name, amount in total_money_map.items():
            if col_name in col_map:
                cell = ws.cell(row=row_idx, column=col_map[col_name],
                               value=float(round(amount, 2)))
                cell.font = total_font
                cell.fill = total_fill
                cell.border = total_border
                cell.number_format = self.money_fmt

        # 合计行整行底部加粗边框
        for col in range(1, len(cols) + 1):
            ws.cell(row=row_idx, column=col).border = total_border

        # 冻结首行 + 自动筛选
        ws.freeze_panes = 'A2'
        last_col = get_col(len(cols))
        ws.auto_filter.ref = f'A1:{last_col}1'

    # write_detail_sheet 已移除：商品明细已在发票汇总 sheet 中完整体现


# ═══════════════════════════════════════════════════════════
#  CSV 导出
# ═══════════════════════════════════════════════════════════

def export_csv(file_path, invoices, options, on_progress=None):
    """导出 CSV 文件。

    Args:
        file_path: 目标绝对路径
        invoices: 发票数据列表
        options: { includeRemark, columns }
                 columns: 可选，[{key,label,width,virtual}, ...] 指定列（顺序即选择顺序，不排序）
        on_progress: 可选回调 (current, total, stage) -> None
    """
    include_remark = options.get('includeRemark', True)
    columns = options.get('columns')
    total = len(invoices)

    if columns:
        # 新路径：列由调用方指定（顺序即用户选择顺序，不排序，与预览同源）
        headers = [c['label'] for c in columns]
        ordered = list(invoices)
        group_key_fn = _invoice_identity
    else:
        # 旧路径：保持历史默认列
        headers = [
            '序号', '发票类型', '开票日期', '发票号码',
            '税前金额', '税额合计', '价税合计',
            '购买方名称', '购买方纳税人识别号',
            '销售方名称', '销售方纳税人识别号',
        ]
        if include_remark:
            headers.extend(['备注', '原文件名'])
        headers.extend([
            '分类编码', '项目名称', '规格型号', '单位', '数量', '单价', '金额', '税率/征收率', '税额'
        ])
        ordered = sorted(invoices, key=lambda x: x.get('invoiceNumber', ''))
        group_key_fn = lambda inv: inv.get('invoiceNumber', '')

    if on_progress:
        on_progress(10, 100, f'正在写入 CSV ({total} 行)...')

    update_interval = max(1, total // 20)

    with open(file_path, 'w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(headers)

        # 按发票身份分组（保持出现顺序，同发票行连续）
        groups = []
        group_index = {}
        for inv in ordered:
            key = group_key_fn(inv)
            if key not in group_index:
                group_index[key] = len(groups)
                groups.append([])
            groups[group_index[key]].append(inv)

        serial = 1
        written = 0
        for group in groups:
            for inv in group:
                if columns:
                    row = []
                    for c in columns:
                        key = c['key']
                        if key == 'serialNo' or c.get('virtual'):
                            row.append(serial)   # 虚拟列由计数器生成
                        else:
                            row.append(inv.get(key, ''))
                else:
                    row = [
                        serial,
                        inv.get('invoiceType', ''),
                        inv.get('invoiceDate', ''),
                        inv.get('invoiceNumber', ''),
                        inv.get('amountWithoutTax', ''),
                        inv.get('taxAmount', ''),
                        inv.get('totalAmount', ''),
                        inv.get('buyerName', ''),
                        inv.get('buyerTaxNo', ''),
                        inv.get('sellerName', ''),
                        inv.get('sellerTaxNo', ''),
                    ]
                    if include_remark:
                        row.extend([inv.get('note', ''), inv.get('originalFilename', '')])
                    row.extend([
                        inv.get('classificationCode', ''),
                        inv.get('xmmc', ''),
                        inv.get('ggxh', ''),
                        inv.get('unit', ''),
                        inv.get('quantity', ''),
                        inv.get('unitPrice', ''),
                        inv.get('lineAmount', ''),
                        inv.get('taxRate', ''),
                        inv.get('lineTax', ''),
                    ])
                writer.writerow(sanitize_export_row(row))
                written += 1

                if on_progress and written % update_interval == 0:
                    pct = 10 + int(85 * written / max(total, 1))
                    on_progress(pct, 100, f'写入 CSV ({written}/{total})...')
            serial += 1  # 每张发票递增序号

    if on_progress:
        on_progress(95, 100, 'CSV 写入完成')


# ═══════════════════════════════════════════════════════════
#  XLSX 导出（编排入口）
# ═══════════════════════════════════════════════════════════

def export_xlsx(file_path, invoices, options, on_progress=None):
    """导出 XLSX 文件（使用 openpyxl）。

    Args:
        file_path: 目标绝对路径
        invoices: 发票数据列表
        options: { includeRemark, splitByType }
        on_progress: 可选回调 (current, total, stage) -> None
    """
    try:
        from openpyxl import Workbook
    except ImportError:
        raise RuntimeError("需要安装 openpyxl: pip install openpyxl")

    include_remark = options.get('includeRemark', True)
    split_by_type = options.get('splitByType', False)
    columns = options.get('columns')

    if on_progress:
        on_progress(5, 100, '创建 Excel 工作簿...')

    wb = Workbook()
    wb.remove(wb.active)

    writer = XlsxWriter(
        include_remark=include_remark,
        on_progress=on_progress,
        sanitize_fn=sanitize_excel_text,
    )

    # 构建 sheets（仅发票汇总，商品明细已在汇总 sheet 中完整体现）
    if split_by_type:
        type_groups = {}
        for inv in invoices:
            t = inv.get('invoiceType', '未知类型')
            type_groups.setdefault(t, []).append(inv)
        used_names = set()

        if on_progress:
            on_progress(10, 100, f'分类整理 ({len(type_groups)} 种类型)...')

        for type_name, type_invs in type_groups.items():
            name = sanitize_sheet_name(type_name, 27)
            if name in used_names:
                i = 2
                while f'{name}({i})' in used_names:
                    i += 1
                name = f'{name}({i})'
            used_names.add(name)
            ws = wb.create_sheet(title=name)
            writer.write_summary_sheet(ws, type_invs, sheet_label=f'[{name}]', columns=columns)

        if on_progress:
            on_progress(90, 100, '汇总数据写入完成')
    else:
        ws = wb.create_sheet(title='发票汇总')
        writer.write_summary_sheet(ws, invoices, sheet_label='发票汇总', columns=columns)

        if on_progress:
            on_progress(90, 100, '汇总数据写入完成')

    if on_progress:
        on_progress(95, 100, '正在保存文件...')

    wb.save(file_path)

    if on_progress:
        on_progress(100, 100, '导出完成')
