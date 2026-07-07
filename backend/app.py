import hashlib
import io
import json
import logging
import os
import queue
import re
import threading
import time
import traceback
from logging.handlers import RotatingFileHandler

from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
import base64

logger = logging.getLogger(__name__)

# 数据库模块
import db as db_module
DB_AVAILABLE = True

from response_builder import build_response
from services.invoice_service import (
    parse_invoice_service, allowed_file, sanitize_filename, detect_file_format
)
from parse_job_manager import job_manager
from services.decision_router import DecisionRouter
from render_engine import registry, engine
from render_engine.api import render_bp

# 全局实例（惰性初始化）
_decision_router = None
_init_lock = threading.Lock()

# 单页 PDF 缓存（用于拆分后的下载）
_page_cache: dict = {}  # {page_id: {"bytes": bytes, "created_at": timestamp}}
_page_cache_lock = threading.Lock()
_page_cache_ttl = 3600  # 缓存有效期（秒），默认 1 小时
_page_cache_max = 500   # 惰性清理阈值，超限时才扫描过期条目

# Document Pipeline 映射：page_id → {doc_id, page}（轻量，替代 _page_cache 直接引用）
_page_registry: dict = {}  # {page_id: {"doc_id": "...", "page": int}}
_page_registry_lock = threading.Lock()

def get_decision_router():
    global _decision_router
    if _decision_router is None:
        with _init_lock:
            if _decision_router is None:
                _decision_router = DecisionRouter()
    return _decision_router


def _normalize_invoice_for_export(inv: dict) -> dict:
    """
    将解析响应格式标准化为 Excel 导出所需的扁平结构。
    如果已经是扁平键（如 invoiceType, totalAmount），直接返回。
    如果包含 invoiceFields 嵌套，自动提取并映射。
    """
    if all(key in inv for key in ["invoiceType", "invoiceNumber", "totalAmount"]):
        return inv

    fields = inv.get("invoiceFields") or inv.get("invoice_fields") or inv

    # 新架构字段名 → 导出期望字段名 对齐
    _VNEXT_TO_EXPORT_MAP = {
        "type": "invoiceType",
        "fphm": "invoiceNumber",
        "kprq": "invoiceDate",
        "amountJe": "pretaxAmount",
        "amountSe": "taxAmount",
        "amountHj": "totalAmount",
        "gmfmc": "buyerName",
        "gmfsh": "buyerTaxId",
        "xsfmc": "sellerName",
        "xsfsh": "sellerTaxId",
        "xmmc": "itemName",
        "note": "remark",
    }
    for vnext_key, export_key in _VNEXT_TO_EXPORT_MAP.items():
        if vnext_key in fields and export_key not in fields:
            fields[export_key] = fields[vnext_key]

    def _get(*keys, default=""):
        for key in keys:
            value = fields.get(key)
            if value is not None and value != "":
                return value
        return default

    def _get_amount(*keys, default=0):
        value = _get(*keys, default=default)
        try:
            return float(value) if value != "" else default
        except (ValueError, TypeError):
            return default

    normalized = {
        "serialNo": inv.get("serialNo", ""),
        "invoiceType": _get("type", "invoiceType"),
        "invoiceNumber": _get("fphm", "invoiceNumber"),
        "invoiceDate": _get("kprq", "invoiceDate"),
        "buyerName": _get("gmfmc", "buyerName"),
        "buyerTaxNo": _get("gmfsh", "buyerTaxNo", "buyerTaxId"),
        "sellerName": _get("xsfmc", "sellerName"),
        "sellerTaxNo": _get("xsfsh", "sellerTaxNo", "sellerTaxId"),
        "amountWithoutTax": _get_amount("amountJe", "amountWithoutTax"),
        "taxAmount": _get_amount("amountSe", "taxAmount"),
        "totalAmount": _get_amount("amountHj", "amount", "totalAmount"),
        "amountDx": _get("amountHjDx", "amountDx"),
        "note": _get("note"),
        "xmmc": _get("xmmc"),
        "issuer": _get("kpr", "issuer"),
        "lineItems": inv.get("lineItems", fields.get("line_items", [])),
        "failed_fields": inv.get("failed_fields", fields.get("failed_fields", [])),
        "warning_fields": inv.get("warning_fields", fields.get("warning_fields", [])),
        "parse_success": inv.get("parse_success", fields.get("parse_success", True)),
        "originalFilename": inv.get("originalFilename", inv.get("fileName", "")),
    }
    return normalized


def _db_record_to_export(rec: dict) -> list:
    """将数据库记录转换为 Excel 导出所需的扁平字段格式列表
    
    每行明细对应一个导出行，多行明细返回多个 dict。
    优先使用 line_items_excel_rows（字符级通路的精确结果），
    回退到传统 line_items。
    """
    def _build_header(serial_no=""):
        try:
            total_amount = float(rec.get('amount', 0) or 0)
        except (ValueError, TypeError):
            total_amount = 0
        try:
            tax_amount = float(rec.get('tax_amount', 0) or 0)
        except (ValueError, TypeError):
            tax_amount = 0
        amount_wo_tax = round(total_amount - tax_amount, 2)
        return {
            "serialNo": serial_no,
            "invoiceType": rec.get('type', ''),
            "invoiceNumber": rec.get('number', ''),
            "invoiceDate": rec.get('date', ''),
            "buyerName": rec.get('buyer', ''),
            "buyerTaxNo": rec.get('buyer_tax', ''),
            "sellerName": rec.get('seller', ''),
            "sellerTaxNo": rec.get('seller_tax', ''),
            "amountWithoutTax": amount_wo_tax,
            "taxAmount": tax_amount,
            "totalAmount": total_amount,
            "amountDx": rec.get('amount_dx', ''),
            "note": rec.get('note', ''),
            "issuer": rec.get('issuer', ''),
            "failed_fields": [],
            "warning_fields": [],
            "parse_success": True,
            "originalFilename": rec.get('file_name', ''),
        }

    # ── 优先使用字符级通路的精确结果 ──
    excel_rows = rec.get('line_items_excel_rows') or []
    if excel_rows:
        # 中文键名 → 导出字段键名映射
        _EXCEL_KEY_MAP = {
            '项目名称': 'xmmc',
            '规格型号': 'ggxh',
            '单位': 'unit',
            '数量': 'quantity',
            '单价': 'unitPrice',
            '金额': 'lineAmount',
            '税率/征收率': 'taxRate',
            '税额': 'lineTax',
        }
        results = []
        for idx, item in enumerate(excel_rows):
            row = _build_header(str(idx + 1) if idx == 0 else "")
            # 将中文键的值填入对应的导出键
            for cn_key, export_key in _EXCEL_KEY_MAP.items():
                val = item.get(cn_key, '')
                if val:
                    row[export_key] = val
            results.append(row)
        return results

    # ── 传统 path：使用 line_items ──
    line_items = rec.get('line_items') or []

    # DB 明细字段名 → 导出字段名映射
    _ITEM_MAP = {
        "xmmc": "xmmc",
        "ggxh": "ggxh",
        "dw": "unit",
        "sl": "quantity",
        "dj": "unitPrice",
        "je": "lineAmount",
        "slv": "taxRate",
        "se": "lineTax",
    }

    if not line_items:
        # 无明细行：返回单行，xmmc 从顶层字段取
        row = _build_header("")
        row["xmmc"] = rec.get('xmmc', '')
        return [row]

    results = []
    for idx, item in enumerate(line_items):
        row = _build_header(str(idx + 1) if idx == 0 else "")
        for db_key, export_key in _ITEM_MAP.items():
            row[export_key] = item.get(db_key, '')
        results.append(row)
    return results


app = Flask(__name__)

# CORS
CORS(app, origins=["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"])
app.register_blueprint(render_bp)

# 流式导出专用 json.dumps
_json = json


# ═══════════════════════════════════════════════════════════
#  Excel 导出 API
# ═══════════════════════════════════════════════════════════

import excel_exporter


@app.route('/api/export-excel-sse', methods=['POST'])
def api_export_excel_sse():
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "error": "无效的请求数据"}), 400

    file_path = data.get('filePath', '')
    options = data.get('options', {})
    fmt = data.get('format', 'xlsx')

    # 优先从数据库读取（fileNames），兼容旧版 invoices 传参
    file_names = data.get('fileNames', [])
    if file_names:
        invoices = []
        for rec in db_module.get_invoices_by_filenames(file_names):
            invoices.extend(_db_record_to_export(rec))
        if not invoices:
            return jsonify({"success": False, "error": "数据库中没有找到匹配的发票记录"}), 404
    else:
        invoices = data.get('invoices', [])
        if not invoices:
            return jsonify({"success": False, "error": "没有可导出的数据"}), 400
        invoices = [_normalize_invoice_for_export(inv) for inv in invoices]

    try:
        file_path, fmt = excel_exporter.validate_export_path(file_path, fmt)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

    progress_queue = queue.Queue()
    result_queue = queue.Queue()

    def run_export():
        try:
            def on_progress(current, total, stage):
                progress_queue.put({'current': current, 'total': total, 'stage': stage})
            if fmt == 'csv':
                excel_exporter.export_csv(file_path, invoices, options, on_progress=on_progress)
            else:
                excel_exporter.export_xlsx(file_path, invoices, options, on_progress=on_progress)
            result_queue.put({'result': {'success': True, 'filePath': file_path}})
        except Exception as e:
            logger.error('[Export SSE] 导出失败: %s\n%s', e, traceback.format_exc())
            result_queue.put({'error': str(e)})

    thread = threading.Thread(target=run_export, daemon=True)
    thread.start()

    def generate():
        yield ": keepalive\n\n"
        while not progress_queue.empty():
            msg = progress_queue.get_nowait()
            yield f"data: {_json.dumps(msg, ensure_ascii=False)}\n\n"
        while not result_queue.empty():
            msg = result_queue.get_nowait()
            yield f"data: {_json.dumps(msg, ensure_ascii=False)}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'},
    )


@app.route('/api/export-excel', methods=['POST'])
def api_export_excel():
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "error": "无效的请求数据"}), 400

    file_path = data.get('filePath', '')
    options = data.get('options', {})
    fmt = data.get('format', 'xlsx')

    # 优先从数据库读取（fileNames），兼容旧版 invoices 传参
    file_names = data.get('fileNames', [])
    if file_names:
        invoices = []
        for rec in db_module.get_invoices_by_filenames(file_names):
            invoices.extend(_db_record_to_export(rec))
        if not invoices:
            return jsonify({"success": False, "error": "数据库中没有找到匹配的发票记录"}), 404
    else:
        invoices = data.get('invoices', [])
        if not invoices:
            return jsonify({"success": False, "error": "没有可导出的数据"}), 400
        invoices = [_normalize_invoice_for_export(inv) for inv in invoices]

    try:
        file_path, fmt = excel_exporter.validate_export_path(file_path, fmt)
        if fmt == 'csv':
            excel_exporter.export_csv(file_path, invoices, options)
        else:
            excel_exporter.export_xlsx(file_path, invoices, options)
        return jsonify({"success": True, "filePath": file_path})
    except Exception as e:
        logger.error('[Export] 导出失败: %s\n%s', e, traceback.format_exc())
        return jsonify({"success": False, "error": str(e)}), 500


# ============================
#  DB API (前端 db.js 调用)
# ============================

@app.route('/api/db/upsert', methods=['POST', 'OPTIONS'])
def api_db_upsert():
    if request.method == 'OPTIONS':
        return jsonify({}), 200
    try:
        row = request.get_json(silent=True) or {}
        result = db_module.upsert_invoice(row)
        return jsonify({"success": True, "data": result})
    except Exception as e:
        logger.exception("DB upsert 失败")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/db/path', methods=['GET'])
def api_db_path():
    return jsonify({"success": True, "data": db_module.get_db_path()})


@app.route('/api/db/search', methods=['GET'])
def api_db_search():
    keyword = request.args.get('keyword', '')
    type_filter = request.args.get('type', '')
    date_from = request.args.get('date_from', '')
    date_to = request.args.get('date_to', '')
    order_by = request.args.get('order_by', 'created_at')
    order_dir = request.args.get('order_dir', 'DESC')
    limit = int(request.args.get('limit', 50))
    offset = int(request.args.get('offset', 0))
    result = db_module.search_invoices(
        keyword=keyword, type_filter=type_filter,
        date_from=date_from, date_to=date_to,
        order_by=order_by, order_dir=order_dir,
        limit=limit, offset=offset,
    )
    return jsonify({"success": True, "data": result})


@app.route('/api/db/invoice/<invoice_id>', methods=['GET', 'PUT', 'DELETE'])
def api_db_invoice(invoice_id):
    try:
        invoice_id = int(invoice_id)
    except (ValueError, TypeError):
        return jsonify({"success": False, "error": "无效的 ID"}), 400
    if request.method == 'GET':
        inv = db_module.get_invoice(invoice_id)
        if not inv:
            return jsonify({"success": False, "error": "未找到"}), 404
        return jsonify({"success": True, "data": inv})
    elif request.method == 'PUT':
        fields = request.get_json(silent=True) or {}
        result = db_module.update_invoice_fields(invoice_id, fields)
        if not result:
            return jsonify({"success": False, "error": "未找到"}), 404
        return jsonify({"success": True, "data": result})
    elif request.method == 'DELETE':
        result = db_module.soft_delete_invoice(invoice_id)
        if not result:
            return jsonify({"success": False, "error": "未找到"}), 404
        return jsonify({"success": True, "data": result})


@app.route('/api/db/invoice/<invoice_id>/restore', methods=['POST'])
def api_db_restore(invoice_id):
    try:
        invoice_id = int(invoice_id)
    except (ValueError, TypeError):
        return jsonify({"success": False, "error": "无效的 ID"}), 400
    result = db_module.restore_invoice(invoice_id)
    if not result:
        return jsonify({"success": False, "error": "未找到"}), 404
    return jsonify({"success": True, "data": result})


@app.route('/api/db/statistics', methods=['GET'])
def api_db_statistics():
    stats = db_module.get_statistics()
    return jsonify({"success": True, "data": stats})


@app.route('/api/db/duplicates/<number>', methods=['GET'])
def api_db_duplicates(number):
    from urllib.parse import unquote
    number = unquote(number)
    result = db_module.find_duplicates(number)
    return jsonify({"success": True, "data": result})


@app.route('/api/config/get', methods=['GET'])
def api_config_get():
    key = request.args.get('key', '')
    value = db_module.get_config(key)
    return jsonify({"success": True, "data": value})


@app.route('/api/config/<path:key>', methods=['PUT'])
def api_config_set(key):
    data = request.get_json(silent=True) or {}
    value = data.get('value')
    result = db_module.set_config(key, value)
    return jsonify({"success": True, "data": result})


@app.route('/api/to_chinese_amount', methods=['POST'])
def api_to_chinese_amount():
    try:
        data = request.get_json(silent=True) or {}
        amount = float(data.get('amount', 0))
        chinese = _amount_to_chinese(amount)
        return jsonify({"success": True, "chinese": chinese})
    except (ValueError, TypeError):
        return jsonify({"success": False, "error": "无效的金额"}), 400


def _amount_to_chinese(amount: float) -> str:
    """将数字金额转换为中文大写"""
    if amount == 0:
        return "零元整"
    digits = "零壹贰叁肆伍陆柒捌玖"
    units = ["", "拾", "佰", "仟", "万", "拾", "佰", "仟", "亿"]
    decimal_units = ["角", "分", "厘"]
    integer_part = int(amount)
    decimal_part = round(amount - integer_part, 2)
    
    def _convert_integer(n):
        if n == 0:
            return "零"
        s = ""
        i = 0
        while n > 0:
            s = digits[n % 10] + units[i] + s if n % 10 != 0 else digits[n % 10] + s
            n //= 10
            i += 1
        return s
    
    result = _convert_integer(integer_part) + "元"
    dec = int(round(decimal_part * 100))
    if dec == 0:
        result += "整"
    else:
        jiao = dec // 10
        fen = dec % 10
        if jiao > 0:
            result += digits[jiao] + "角"
        if fen > 0:
            result += digits[fen] + "分"
    return result


@app.route('/api/invoice/export-data', methods=['GET'])
def api_invoice_export_data():
    """返回指定文件的导出数据（与导出 Excel 使用的是同一套字段映射）"""
    file_name = request.args.get('file_name', '')
    if not file_name:
        return jsonify({"success": False, "error": "缺少 file_name 参数"}), 400
    rec = db_module.get_invoice_by_filename(file_name)
    if not rec:
        return jsonify({"success": False, "error": "数据库中没有找到该文件"}), 404
    export_rows = _db_record_to_export(rec)
    return jsonify({"success": True, "data": {"invoice": export_rows[0] if export_rows else {}, "rows": export_rows}})


# ============================
# Review Queue API
# ============================

@app.route('/api/review-queue', methods=['GET'])
def get_review_queue():
    try:
        status_filter = request.args.get('status', 'pending')
        router = get_decision_router()
        records = router.list_review_queue(status=status_filter)
        return jsonify({"success": True, "data": records, "count": len(records)})
    except Exception as e:
        logger.exception("查询审核队列失败")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/review-queue/<record_id>/resolve', methods=['POST'])
def resolve_review(record_id):
    try:
        data = request.get_json(silent=True) or {}
        corrected_fields = data.get('corrected_fields', {})
        line_items = data.get('line_items')
        router = get_decision_router()
        # 直接读取单个记录（O(1) 复杂度）
        review_record = router.get_review_by_id(record_id)
        
        if not review_record:
            return jsonify({"success": False, "error": "记录不存在"}), 404

        all_fields = dict(corrected_fields or {})
        if line_items is not None:
            all_fields['line_items'] = line_items

        success = router.resolve_review(record_id, all_fields or None)
        if not success:
            return jsonify({"success": False, "error": "记录不存在"}), 404

        msg = "审核已标记为已解决"
        if corrected_fields:
            msg += f"，已记录 {len(corrected_fields)} 条字段修正"
        if line_items:
            msg += f"，已记录 {len(line_items)} 条明细行"
        return jsonify({"success": True, "message": msg})
    except Exception as e:
        logger.exception("审核解决失败")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/review-queue/resolve_manual', methods=['POST'])
def resolve_review_manual():
    """前端发票详情页手动修正入口：按文件名查找记录并提交修正"""
    try:
        data = request.get_json(silent=True) or {}
        file_name = data.get('file_name', '')
        corrected_fields = data.get('corrected_fields', {})
        line_items = data.get('line_items')

        if not file_name:
            return jsonify({"success": False, "error": "缺少 file_name"}), 400

        router = get_decision_router()
        # 使用索引查找（O(1) 复杂度）
        review_record = router.get_review_by_file_name(file_name)
        record_id = review_record.get("id") if review_record else None

        all_fields = dict(corrected_fields or {})
        if line_items is not None:
            all_fields['line_items'] = line_items

        # 如有匹配的审核记录则标记解决
        if record_id:
            router.resolve_review(record_id, all_fields or None)

        msg = "修正已记录"
        if corrected_fields:
            msg += f"，{len(corrected_fields)} 个字段"
        if line_items:
            msg += f"，{len(line_items)} 条明细行"

        return jsonify({"success": True, "message": msg})
    except Exception as e:
        logger.exception("手动修正失败")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/exception-queue', methods=['GET'])
def get_exception_queue():
    try:
        status_filter = request.args.get('status', 'pending')
        router = get_decision_router()
        records = router.list_exception_queue(status=status_filter)
        return jsonify({"success": True, "data": records, "count": len(records)})
    except Exception as e:
        logger.exception("查询异常队列失败")
        return jsonify({"success": False, "error": str(e)}), 500


# ============================
# 原有的 parse_invoice 等路由
# ============================




@app.route('/get_pdf_pages', methods=['POST'])
def get_pdf_pages():
    """检测 PDF 页数（通过 render_engine Registry）"""
    if 'file' not in request.files:
        return jsonify({"success": False, "error": "没有上传文件"}), 400
    file = request.files['file']
    file_bytes = file.read()
    if not file_bytes:
        return jsonify({"success": False, "error": "空文件"}), 400
    try:
        doc = registry.open(file_bytes, filename=file.filename or "")
        return jsonify({"success": True, "total_pages": doc.page_count})
    except Exception as e:
        logger.exception("读取 PDF 页数失败")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/split_pdf', methods=['POST'])
def split_pdf():
    """拆分 PDF 为单页文件（走 render_engine 管道，响应格式不变）"""
    if 'file' not in request.files:
        return jsonify({"success": False, "error": "没有上传文件"}), 400
    file = request.files['file']
    file_bytes = file.read()
    if not file_bytes:
        return jsonify({"success": False, "error": "空文件"}), 400
    try:
        # 生成文件哈希作为 page_id 基础（保持向后兼容）
        file_hash = hashlib.sha256(file_bytes).hexdigest()[:16]

        # 注册文档到 render_engine（fitz 句柄由 Registry 持有）
        doc = registry.open(file_bytes, filename=file.filename or "")

        pages = []
        now = time.time()

        # 清理过期缓存（惰性清理逻辑不变）
        with _page_cache_lock:
            if len(_page_cache) > _page_cache_max:
                cutoff = now - _page_cache_ttl
                expired = [k for k, v in _page_cache.items() if v["created_at"] < cutoff]
                for k in expired:
                    del _page_cache[k]
                if expired:
                    logger.debug("[page_cache] 惰性清理 %d 个过期条目", len(expired))

        for i in range(doc.page_count):
            page_num = i + 1

            # 拆出单页 PDF（走引擎）
            page_bytes = engine.extract_page_pdf(doc.doc_id, page_num)

            # 渲染预览图（走引擎，200dpi JPEG 向后兼容）
            preview_data, preview_fmt, _ = engine.render(
                doc_id=doc.doc_id,
                preset_name="preview",
                page=page_num,
                override_params={"dpi": 200, "fmt": "jpeg"},
            )
            preview_b64 = base64.b64encode(preview_data).decode('ascii')

            # 生成唯一 page_id（格式不变，向后兼容 download_page）
            page_id = f"{file_hash}_{i}"

            # 注册 Document Pipeline 映射（新 download_page 走引擎）
            with _page_registry_lock:
                _page_registry[page_id] = {"doc_id": doc.doc_id, "page": page_num}

            # 缓存单页 PDF（供 download_page 使用 / 旧管线回退）
            with _page_cache_lock:
                _page_cache[page_id] = {
                    "bytes": page_bytes,
                    "created_at": now,
                }

            pages.append({
                "page_index": i + 1,
                "page_id": page_id,
                "preview_image": preview_b64,
            })

        return jsonify({
            "success": True,
            "doc_id": doc.doc_id,
            "total_pages": len(pages),
            "pages": pages,
            "expires_in": _page_cache_ttl,
        })
    except Exception as e:
        logger.exception("拆分 PDF 失败")
        return jsonify({"success": False, "error": str(e)}), 500


def _respond_pdf(page_bytes: bytes, page_id: str):
    """构造 PDF 二进制响应（download_page 复用）"""
    return Response(
        page_bytes,
        mimetype='application/pdf',
        headers={
            'Content-Disposition': f'attachment; filename="page_{page_id}.pdf"',
            'Content-Length': str(len(page_bytes)),
        }
    )


@app.route('/download_page/<page_id>', methods=['GET'])
def download_page(page_id):
    """下载单页 PDF（优先 Document Pipeline，回退旧缓存）"""

    # ── ① 新管道：Registry + Engine ──
    with _page_registry_lock:
        reg_entry = _page_registry.get(page_id)

    if reg_entry:
        try:
            # 按需从 Registry 持有的 fitz 句柄拆出单页 PDF
            page_bytes = engine.extract_page_pdf(
                reg_entry["doc_id"], reg_entry["page"]
            )
            # 写入 _page_cache（后续请求直接命中旧缓存路径）
            now = time.time()
            with _page_cache_lock:
                _page_cache[page_id] = {"bytes": page_bytes, "created_at": now}
            return _respond_pdf(page_bytes, page_id)
        except Exception as e:
            logger.debug("download_page pipeline fallback for %s: %s", page_id, e)
            # 引擎失败 → 回退到旧 _page_cache

    # ── ② 回退：旧 _page_cache ──
    with _page_cache_lock:
        cache_entry = _page_cache.get(page_id)

    if not cache_entry:
        return jsonify({"success": False, "error": "页面不存在或已过期，请重新拆分"}), 404

    if time.time() - cache_entry["created_at"] > _page_cache_ttl:
        with _page_cache_lock:
            _page_cache.pop(page_id, None)
        return jsonify({"success": False, "error": "页面已过期，请重新拆分"}), 410

    return _respond_pdf(cache_entry["bytes"], page_id)


# 并发解析限流
import asyncio
from concurrent.futures import ThreadPoolExecutor, as_completed
parse_semaphore = threading.Semaphore(10)


@app.route('/parse_invoice', methods=['POST'])
def parse_invoice():
    _route_start = time.time()
    if 'file' not in request.files:
        return jsonify({"success": False, "error": "没有上传文件"}), 400

    file = request.files['file']
    if not allowed_file(file.filename):
        return jsonify({"success": False, "error": "不支持的文件格式"}), 400

    if not parse_semaphore.acquire(blocking=False):
        return jsonify({"success": False, "error": "当前解析任务较多，请稍后重试"}), 429

    try:
        file.seek(0)
        file_bytes = file.read()  # 只读取一次，后续复用

        auto_orient = request.form.get('autoOrient', '1') == '1'
        enable_auto_ocr = request.form.get('enableAutoOcr', '0') == '1'
        _legacy_start = time.time()
        result = parse_invoice_service(file_bytes, file.filename, auto_orient=auto_orient, enable_auto_ocr=enable_auto_ocr)
        _legacy_ms = round((time.time() - _legacy_start) * 1000, 2)
        logger.info("[PERF] 旧管道 parse_invoice_service 耗时: %.2fms", _legacy_ms)
    except Exception as e:
        logger.exception("发票解析失败")
        return jsonify({"success": False, "error": "发票解析失败"}), 500
    finally:
        parse_semaphore.release()

    if result is None:
        return jsonify({"success": False, "error": "无法识别的文件格式"}), 400

    include_preview = request.form.get('includePreview', '1') == '1'
    include_raw_text = request.form.get('includeRawText', '1') == '1'
    mode = request.form.get('mode', 'detail')

    return build_response(
        file_format=result['file_format'],
        parse_method=result['parse_method'],
        invoice_type=result['invoice_type'],
        invoice_number=result.get('invoice_number', ''),
        amount=result.get('amount', ''),
        invoice_date=result.get('invoice_date', ''),
        extra_fields=result.get('extra_fields', {}),
        preview_image=result.get('preview_image') if include_preview else None,
        raw_text=result.get('raw_text', '') if include_raw_text else None,
        bbox_data=result.get('bbox_data', []),
        mode=mode,
        from_cache=result.get('from_cache', False),
        filename=result.get('safe_filename', ''),
    )


@app.route('/parse_batch', methods=['POST'])
def parse_batch():
    """批量解析多个发票文件（并行解析 + SSE 流式进度 + 批量 DB 写入）

    前端通过 multipart/form-data 提交多个文件（字段名 'files'），
    后端用线程池并行解析，通过 SSE 流实时推送进度。
    """
    files = request.files.getlist('files')
    if not files:
        return jsonify({"success": False, "error": "没有上传文件"}), 400

    auto_orient = request.form.get('autoOrient', '1') == '1'
    enable_auto_ocr = request.form.get('enableAutoOcr', '0') == '1'

    MAX_BATCH_SIZE = 100
    if len(files) > MAX_BATCH_SIZE:
        return jsonify({"success": False,
                        "error": f"单次最多处理 {MAX_BATCH_SIZE} 个文件"}), 400

    # 在主线程预读取所有文件字节（Flask request context 不可跨线程访问）
    file_inputs = []
    for f in files:
        f.seek(0)
        file_inputs.append({
            'bytes': f.read(),
            'filename': f.filename,
        })

    progress_queue = queue.Queue()
    result_queue = queue.Queue()

    def run_batch():
        total = len(file_inputs)
        BATCH_WORKERS = min(4, total)
        results = [None] * total

        def _parse_one(index, fi):
            if not parse_semaphore.acquire(timeout=30):
                return index, None, "服务器繁忙，请稍后重试"
            try:
                if not allowed_file(fi['filename']):
                    return index, None, f"不支持的文件格式: {fi['filename']}"
                svc_result = parse_invoice_service(
                    fi['bytes'], fi['filename'],
                    auto_orient=auto_orient,
                    enable_auto_ocr=enable_auto_ocr,
                    skip_db_write=True,
                )
                if svc_result is None:
                    return index, None, f"无法识别的文件格式: {fi['filename']}"
                return index, svc_result, None
            except Exception as e:
                logger.error("[parse_batch] 解析失败 [%d] %s: %s", index, fi['filename'], e)
                return index, None, str(e)
            finally:
                parse_semaphore.release()

        with ThreadPoolExecutor(max_workers=BATCH_WORKERS,
                                thread_name_prefix='batch-parse') as pool:
            futures = {pool.submit(_parse_one, i, fi): i
                       for i, fi in enumerate(file_inputs)}
            for fut in as_completed(futures):
                idx, svc_result, error = fut.result()
                results[idx] = (idx, svc_result, error)
                progress_queue.put({'current': sum(1 for r in results if r is not None), 'total': total})

        # 批量入库
        db_records = []
        record_index_map = {}
        for i, (idx, svc_result, error) in enumerate(results):
            if svc_result and svc_result.get('db_record'):
                record_index_map[len(db_records)] = idx
                db_records.append(svc_result['db_record'])

        db_results = []
        if db_records:
            try:
                db_results = db_module.batch_upsert_invoices(db_records)
                logger.info("[parse_batch] 批量入库 %d 条记录", len(db_results))
            except Exception as e:
                logger.warning("[parse_batch] 批量入库失败: %s", e)

        # 构建每个文件的响应项
        response_items = []
        for i, (idx, svc_result, error) in enumerate(results):
            item = {
                'index': idx,
                'file_name': file_inputs[idx]['filename'],
                'success': svc_result is not None,
            }
            if svc_result:
                db_res = None
                for rec_idx, file_idx in record_index_map.items():
                    if file_idx == idx and rec_idx < len(db_results):
                        db_res = db_results[rec_idx]
                        break
                item['db_result'] = db_res

                extra = svc_result.get('extra_fields', {}) or {}
                raw_failed = extra.get('failed_fields', [])
                failed_ids = [f.get('field', '') for f in raw_failed
                              if isinstance(f, dict) and f.get('field')] if raw_failed else []

                item['data'] = {
                    'db_record': svc_result.get('db_record'),
                    'invoice_type': svc_result.get('invoice_type', ''),
                    'invoice_number': svc_result.get('invoice_number', ''),
                    'amount': svc_result.get('amount', ''),
                    'invoice_date': svc_result.get('invoice_date', ''),
                    'new_name': svc_result.get('safe_filename', ''),
                    'parse_method': svc_result.get('parse_method', ''),
                    'file_format': svc_result.get('file_format', ''),
                    'failed_fields': failed_ids,
                    'preview_image': svc_result.get('preview_image', '') if svc_result.get('file_format') == 'ofd' else '',
                    'invoice_fields': extra,
                    'from_cache': svc_result.get('from_cache', False),
                }
            else:
                item['error'] = error or '解析失败'
            response_items.append(item)

        success_count = sum(1 for it in response_items if it['success'])
        logger.info("[parse_batch] 完成: %d/%d 成功", success_count, total)
        result_queue.put({
            'success': True,
            'total': total,
            'success_count': success_count,
            'fail_count': total - success_count,
            'items': response_items,
        })

    thread = threading.Thread(target=run_batch, daemon=True)
    thread.start()

    def generate():
        yield ": keepalive\n\n"
        while True:
            # 先消费 progress_queue
            while not progress_queue.empty():
                msg = progress_queue.get_nowait()
                yield f"data: {_json.dumps(msg, ensure_ascii=False)}\n\n"
            # 检查 result_queue（有结果说明解析完成）
            if not result_queue.empty():
                msg = result_queue.get_nowait()
                yield f"data: {_json.dumps(msg, ensure_ascii=False)}\n\n"
                break
            # 没有数据时短暂休眠，避免 busy loop
            time.sleep(0.05)

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'},
    )


# ============================
# 入口
# ============================

if __name__ == '__main__':
    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s %(levelname)s %(name)s - %(message)s',
    )
    from cache import _get_manager
    _cache_mgr = _get_manager()
    migrated = _cache_mgr.migrate_legacy()
    if migrated > 0:
        logger.info("[Cache] 启动迁移: %d 个旧缓存文件已移入 _legacy/", migrated)
    ttl_cleaned = _cache_mgr.cleanup_by_ttl()
    if ttl_cleaned > 0:
        logger.info("[Cache] TTL 清理: %d 个过期文件", ttl_cleaned)
    db_module.cleanup_expired_invoices()
    import atexit
    @atexit.register
    def shutdown_job_manager():
        logger.info("[App] 正在关闭任务队列管理器...")
        job_manager.shutdown()
        logger.info("[App] 任务队列管理器已关闭")
    app.run(port=5000, debug=True, threaded=True)
