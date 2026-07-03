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

logger = logging.getLogger(__name__)

# 预编译正则表达式（模块加载时编译一次，避免每次调用重复编译）
_PATTERN_BUYER_SELLER = re.compile(r'\[(?:BUYER|SELLER)_(?:START|END)\]')
_PATTERN_AUX = re.compile(r'__AUX_[A-Za-z0-9_]+__')
_PATTERN_WHITESPACE = re.compile(r'\s+')

EXCEL_FORMULA_PREFIXES = ('=', '+', '-', '@')
EXPORT_ALLOWED_EXTENSIONS = {'xlsx', 'csv'}


# ═══════════════════════════════════════════════════════════
#  路径校验
# ═══════════════════════════════════════════════════════════

def validate_export_path(file_path, fmt):
    """校验导出路径和格式，避免错误扩展名与明显危险路径。"""
    if not isinstance(file_path, str) or not file_path.strip():
        raise ValueError("缺少 filePath 参数")

    raw_path = os.path.expanduser(file_path.strip())
    if not os.path.isabs(raw_path):
        raise ValueError("导出路径必须是绝对路径")

    normalized_path = os.path.abspath(raw_path)
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
            from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
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

    def write_summary_sheet(self, ws, sheet_invoices, serial_start=1, sheet_label=''):
        """设置汇总 sheet（含发票级字段合并 + quantity 原始字符串保留）。"""
        get_col = self._get_column_letter
        on_progress = self.on_progress

        cols = [
            ('序号', 'serialNo', 8),
            ('发票类型', 'invoiceType', 12),
            ('开票日期', 'invoiceDate', 12),
            ('发票号码', 'invoiceNumber', 20),
            ('税前金额', 'amountWithoutTax', 12),
            ('税额合计', 'taxAmount', 12),
            ('价税合计', 'totalAmount', 12),
            ('购买方名称', 'buyerName', 25),
            ('购买方税号', 'buyerTaxNo', 20),
            ('销售方名称', 'sellerName', 25),
            ('销售方税号', 'sellerTaxNo', 20),
            ('开票人', 'issuer', 10),
            ('项目名称', 'xmmc', 35),
            ('规格型号', 'ggxh', 20),
            ('单位', 'unit', 8),
            ('数量', 'quantity', 10),
            ('单价', 'unitPrice', 12),
            ('金额', 'lineAmount', 12),
            ('税率/征收率', 'taxRate', 12),
            ('税额', 'lineTax', 12),
        ]
        if self.include_remark:
            cols.extend([('备注', 'note', 30), ('原文件名', 'originalFilename', 35)])

        # 发票级字段：同一发票多行明细时合并这些列
        invoice_level_keys = [
            'serialNo', 'invoiceType', 'invoiceDate', 'invoiceNumber',
            'amountWithoutTax', 'taxAmount', 'totalAmount',
            'buyerName', 'buyerTaxNo', 'sellerName', 'sellerTaxNo',
            'issuer',
        ]
        if self.include_remark:
            invoice_level_keys.extend(['note', 'originalFilename'])

        # key → 列序号 映射（用于 merge_cells）
        col_index_map = {}
        for c, (_, key, _) in enumerate(cols, 1):
            col_index_map[key] = c

        # 写表头
        for c, (header, _, width) in enumerate(cols, 1):
            cell = ws.cell(row=1, column=c, value=header)
            cell.font = self.header_font
            cell.fill = self.header_fill
            cell.alignment = self.header_align
            cell.border = self.thin_border
            ws.column_dimensions[get_col(c)].width = width

        # 按发票号分组（同一发票多明细分组合并）
        group_map = {}
        for idx, inv in enumerate(sheet_invoices):
            key = inv.get('invoiceNumber') or f'__UNIQUE_{idx}'
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
                for c, (_, key, _) in enumerate(cols, 1):
                    val = inv.get(key, '')
                    if key == 'serialNo':
                        val = val if val else serial
                    elif key in self.money_keys:
                        val = self._safe_num(val)
                    elif key == 'quantity':
                        # 借鉴 ExcelJS：整数保持字符串（防 "001" → 1）
                        q_str = str(val) if val else ''
                        try:
                            q_num = float(q_str.replace(',', ''))
                            if q_num != int(q_num):
                                val = q_num
                            else:
                                val = q_str
                        except (ValueError, TypeError):
                            val = self._sanitize(val)
                    else:
                        val = self._sanitize(val)
                    cell = ws.cell(row=row_idx, column=c, value=val)
                    cell.border = self.thin_border
                    if key in self.money_keys and isinstance(val, (int, float)):
                        cell.number_format = self.money_fmt
                        cell.alignment = self._right_align
                    else:
                        cell.alignment = self.data_align
                row_idx += 1
                serial += 1
                written += 1

                if on_progress and written % update_interval == 0:
                    on_progress(15 + int(55 * written / max(sheet_total, 1)), 100,
                               f'写入{sheet_label} ({written}/{sheet_total})...')

            # 同一发票多行时立即合并发票级字段，避免批量收集合并字符串
            if row_count > 1:
                end_row = start_row + row_count - 1
                for ikey in invoice_level_keys:
                    ci = col_index_map.get(ikey)
                    if ci:
                        cl = get_col(ci)
                        ws.merge_cells(f'{cl}{start_row}:{cl}{end_row}')

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
        options: { includeRemark, ... }
        on_progress: 可选回调 (current, total, stage) -> None
    """
    include_remark = options.get('includeRemark', True)
    total = len(invoices)

    headers = [
        '序号', '发票类型', '开票日期', '发票号码',
        '税前金额', '税额合计', '价税合计',
        '购买方名称', '购买方纳税人识别号',
        '销售方名称', '销售方纳税人识别号',
    ]
    if include_remark:
        headers.extend(['备注', '原文件名'])
    headers.extend([
        '项目名称', '规格型号', '单位', '数量', '单价', '金额', '税率/征收率', '税额'
    ])

    if on_progress:
        on_progress(10, 100, f'正在写入 CSV ({total} 行)...')

    update_interval = max(1, total // 20)

    with open(file_path, 'w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        for idx, inv in enumerate(invoices):
            row = [
                inv.get('serialNo', ''),
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

            if on_progress and idx % update_interval == 0:
                pct = 10 + int(85 * (idx + 1) / max(total, 1))
                on_progress(pct, 100, f'写入 CSV ({idx + 1}/{total})...')

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
            writer.write_summary_sheet(ws, type_invs, sheet_label=f'[{name}]')

        if on_progress:
            on_progress(90, 100, '汇总数据写入完成')
    else:
        ws = wb.create_sheet(title='发票汇总')
        writer.write_summary_sheet(ws, invoices, sheet_label='发票汇总')

        if on_progress:
            on_progress(90, 100, '汇总数据写入完成')

    if on_progress:
        on_progress(95, 100, '正在保存文件...')

    wb.save(file_path)

    if on_progress:
        on_progress(100, 100, '导出完成')
