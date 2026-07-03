import re
from flask import jsonify

from field_extractor import normalize_invoice_type, normalize_amount, normalize_date
from cache import get_cache_version_info
import logging

logger = logging.getLogger(__name__)


def sanitize_filename_segment(text):
    """清理文件名片段中的非法字符，防止路径遍历"""
    if not text:
        return '未知'
    safe = re.sub(r'[<>:"/\\|?*]', '', text)
    safe = re.sub(r'\.\.', '', safe)
    return safe.strip() or '未知'


# 响应数据大小限制
MAX_RAW_TEXT_LENGTH = 2000
MAX_BBOX_ITEMS = 200


def build_response(file_format, parse_method, invoice_type, invoice_number,
                   amount, invoice_date, raw_text, preview_image=None, filename='',
                   extra_fields=None, db_record=None, bbox_data=None,
                   include_preview=True, include_raw_text=True, mode='detail',
                   from_cache=False):
    """构建解析响应，包含完整发票字段

    Args:
        extra_fields: 从 extract_fields() 返回的完整字段字典，包含所有扩展字段
        db_record: 用于 Electron 端写入 datastore.js 的完整发票记录
        bbox_data: OCR tokens（v5 Ownership-Based 需要）
        include_preview: 是否包含预览图（base64）
        include_raw_text: 是否包含原始OCR文本
        mode: 'batch' 或 'detail'，批量模式下会自动禁用预览和完整文本
        from_cache: 是否来自缓存（v10 新增）
    """
    # 批量模式下自动禁用预览和完整文本（OFD 除外：浏览器无法直接渲染 OFD ZIP）
    if mode == 'batch':
        if file_format != 'ofd':
            include_preview = False
        include_raw_text = False

    clean_type = normalize_invoice_type(invoice_type)
    clean_number = invoice_number if invoice_number and invoice_number not in ('未知号码',) else None
    clean_amount = normalize_amount(amount)
    clean_date = normalize_date(invoice_date)

    # 初始化失败字段列表（兼容旧版字符串格式）
    failed_fields = []
    
    # 从 extra_fields 获取字段级失败/警告信息
    failed_field_objects = []
    warning_field_objects = []
    
    # 获取明细行修正记录（v10 新增）
    line_item_adjustments = []
    
    if extra_fields and isinstance(extra_fields, dict):
        # 优先使用新的字段级失败/警告结构
        if 'failed_fields' in extra_fields:
            failed_field_objects = extra_fields['failed_fields']
            # 转换为兼容旧版的字符串列表
            failed_fields = [f.get('field', '') for f in failed_field_objects if f.get('field')]
        if 'warning_fields' in extra_fields:
            warning_field_objects = extra_fields['warning_fields']
        # 获取明细行修正记录
        if 'line_item_adjustments' in extra_fields:
            line_item_adjustments = extra_fields['line_item_adjustments']
    
    # 基础字段校验（兜底）
    if clean_number is None:
        if 'fphm' not in failed_fields:
            failed_fields.append('invoiceNumber')
            failed_field_objects.append({
                'field': 'fphm',
                'label': '发票号码',
                'severity': 'error',
                'reason': '发票号码为空',
                'value': '',
                'confidence': 0.0,
            })
    if clean_amount is None:
        if 'amountHj' not in failed_fields:
            failed_fields.append('amount')
            failed_field_objects.append({
                'field': 'amountHj',
                'label': '价税合计',
                'severity': 'error',
                'reason': '金额为空',
                'value': '',
                'confidence': 0.0,
            })
    if clean_date is None:
        if 'kprq' not in failed_fields:
            failed_fields.append('invoiceDate')
            failed_field_objects.append({
                'field': 'kprq',
                'label': '开票日期',
                'severity': 'error',
                'reason': '开票日期为空',
                'value': '',
                'confidence': 0.0,
            })

    ext = '.' + filename.rsplit('.', 1)[-1] if '.' in filename else '.pdf'
    new_name = f"{sanitize_filename_segment(clean_type)}_{sanitize_filename_segment(clean_number or '未知')}_{sanitize_filename_segment(clean_amount or '0')}{ext}"

    logger.info("发票类型: %s, 号码: %s, 金额: %s, 日期: %s, 失败字段: %s, 模式: %s, 来源: %s",
                clean_type, clean_number, clean_amount, clean_date, failed_fields, mode, 
                "缓存" if from_cache else "解析")

    response = {
        "file_format": file_format,
        "parse_method": parse_method,
        "invoice_type": clean_type,
        "invoice_number": clean_number or '',
        "amount": clean_amount or '',
        "invoice_date": clean_date or '',
        "failed_fields": failed_fields,          # 兼容旧版：字符串列表
        "failed_fields_detail": failed_field_objects,  # 新增：字段级失败详情
        "warning_fields": warning_field_objects,       # 新增：警告字段列表
        "new_name": new_name,
        # v10 新增：缓存版本信息
        "from_cache": from_cache,
        **get_cache_version_info(),
        "invoice_json": {
            "type": clean_type,
            "number": clean_number or '',
            "amount": clean_amount or '',
            "date": clean_date or '',
            "source": parse_method,
            "failed_fields": failed_fields,
        }
    }

    # 按需返回 raw_text
    if include_raw_text and raw_text:
        response["raw_text"] = raw_text[:MAX_RAW_TEXT_LENGTH]
    else:
        response["raw_text"] = ""

    # 按需返回预览图
    if include_preview and preview_image:
        response["preview_image"] = preview_image
    else:
        response["preview_image"] = ""

    if extra_fields and isinstance(extra_fields, dict):
        line_items = extra_fields.get("line_items", [])
        if len(line_items) > 50:
            logger.debug("[ResponseBuilder] 截断: 明细行 %d 条超过上限 50, 保留前 50 条",
                         len(line_items))
            line_items = line_items[:50]
        
        invoice_fields_data = {
            "type": extra_fields.get("type", clean_type),
            "fphm": extra_fields.get("fphm", "") or (clean_number or ""),
            "kprq": extra_fields.get("kprq", "") or (clean_date or ""),
            "gmfmc": extra_fields.get("gmfmc", ""),
            "gmfsh": extra_fields.get("gmfsh", ""),
            "xsfmc": extra_fields.get("xsfmc", ""),
            "xsfsh": extra_fields.get("xsfsh", ""),
            "amountJe": extra_fields.get("amountJe", ""),
            "amountSe": extra_fields.get("amountSe", ""),
            "amountHj": extra_fields.get("amountHj", "") or (clean_amount or ""),
            "amountHjDx": extra_fields.get("amountHjDx", ""),
            "note": extra_fields.get("note", ""),
            "skr": extra_fields.get("skr", ""),
            "fhr": extra_fields.get("fhr", ""),
            "kpr": extra_fields.get("kpr", ""),
            "xmmc": extra_fields.get("xmmc", ""),
            "line_items": line_items,
        }

        # 透出字段元数据（候选、来源、置信度、拒绝原因）
        for key in ('field_meta', 'confidence', 'warnings',
                    'failed_fields', 'warning_fields'):
            if key in extra_fields and extra_fields[key]:
                invoice_fields_data[key] = extra_fields[key]

        # v10 新增：添加明细行修正记录
        if line_item_adjustments:
            invoice_fields_data["line_item_adjustments"] = line_item_adjustments

        response["invoice_fields"] = invoice_fields_data

    if db_record:
        response["db_record"] = db_record
    
    if bbox_data:
        if len(bbox_data) > MAX_BBOX_ITEMS:
            bbox_data = bbox_data[:MAX_BBOX_ITEMS]
        response["bbox_data"] = bbox_data

    return jsonify(response)
