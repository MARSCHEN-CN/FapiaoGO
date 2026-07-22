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
import tempfile
from logging.handlers import RotatingFileHandler

from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
import base64
from concurrent.futures import ThreadPoolExecutor
# fitz (PyMuPDF) 可能在某些运行时缺失，安全导入以避免整个模块加载失败
try:
    import fitz
except ImportError:
    fitz = None

logger = logging.getLogger(__name__)

# 数据库模块
import db as db_module
DB_AVAILABLE = True

from response_builder import build_response
from services.invoice_service import (
    parse_invoice_service, allowed_file, sanitize_filename, detect_file_format
)
from parse_job_manager import get_job_manager
from import_batch_manager import get_import_batch_manager
from services.decision_router import DecisionRouter
from render_engine import registry, engine
from render_engine.registry import _make_doc_id
from render_engine.api import render_bp

# 全局实例（惰性初始化）
_decision_router = None
_init_lock = threading.Lock()

# 单页 PDF 缓存（用于拆分后的下载）
_page_cache: dict = {}  # {page_id: {"bytes": bytes, "created_at": ts, "last_used": ts}}
_page_cache_lock = threading.Lock()
_page_cache_ttl = 3600  # 缓存有效期（秒），默认 1 小时
_page_cache_max = 500   # LRU 硬上限：超限时按 last_used 驱逐，杜绝无限增长
_page_cache_cleanup_interval = 300  # 后台清理间隔（秒），5分钟

# Document Pipeline 映射：page_id → {doc_id, page}（轻量，替代 _page_cache 直接引用）
_page_registry: dict = {}  # {page_id: {"doc_id": "...", "page": int}}
_page_registry_lock = threading.Lock()
_page_cache_stop_event = threading.Event()


def _page_cache_periodic_cleanup():
    """后台线程：定期清理过期缓存条目"""
    while not _page_cache_stop_event.is_set():
        try:
            _page_cache_evict(force_expired=True)
        except Exception:
            logger.debug("[page_cache] 定期清理异常", exc_info=True)
        _page_cache_stop_event.wait(_page_cache_cleanup_interval)


def _page_cache_evict(force_expired: bool = False):
    """
    单页缓存惰性清理 + LRU 硬上限。

    - force_expired=True 时：即使未超容量也清理过期项（供后台线程调用）。
    - 仅当 len(_page_cache) > _page_cache_max 时触发 LRU 驱逐（保持惰性）。
    - 触发后：先清过期项（created_at 超过 TTL），若仍超限，再按 last_used 升序
      驱逐最久未用项，直到 len 回到 _page_cache_max（真正的硬上限，杜绝无限增长）。
    - 任何被驱逐的 key，联动从 _page_registry 删除，避免 registry 悬空 / 无限增长。
    - 两个锁分两段独立获取（不嵌套），与 _register_and_collect / download_page 的
      加锁顺序兼容，不会引发死锁。
    """
    cutoff = time.time() - _page_cache_ttl
    evicted = []
    with _page_cache_lock:
        need_check = force_expired or len(_page_cache) > _page_cache_max
        if need_check:
            for k in [k for k, v in _page_cache.items()
                      if v.get("created_at", 0) < cutoff]:
                _page_cache.pop(k, None)
                evicted.append(k)
        if len(_page_cache) > _page_cache_max:
            over = len(_page_cache) - _page_cache_max
            if over > 0:
                lru = sorted(
                    _page_cache.keys(),
                    key=lambda k: _page_cache[k].get("last_used",
                                                     _page_cache[k].get("created_at", 0)),
                )
                for k in lru[:over]:
                    _page_cache.pop(k, None)
                    evicted.append(k)
    if evicted:
        with _page_registry_lock:
            for k in evicted:
                _page_registry.pop(k, None)
        logger.debug("[page_cache] 驱逐 %d 个条目（含 registry 联动清理）", len(evicted))


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
    CLASS_CODE_RE = re.compile(r'^\*[^*]+\*')

    def _extract_class_code(row):
        """从 xmmc 中提取 *xxx* 分类编码，不修改 xmmc 原始值"""
        raw = row.get('xmmc', '')
        m = CLASS_CODE_RE.match(raw)
        if m:
            row['classificationCode'] = m.group().strip('*')
        else:
            row['classificationCode'] = ''

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
            row = _build_header("")
            # 将中文键的值填入对应的导出键
            for cn_key, export_key in _EXCEL_KEY_MAP.items():
                val = item.get(cn_key, '')
                if val:
                    row[export_key] = val
            _extract_class_code(row)
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
        _extract_class_code(row)
        return [row]

    results = []
    for idx, item in enumerate(line_items):
        row = _build_header("")
        for db_key, export_key in _ITEM_MAP.items():
            row[export_key] = item.get(db_key, '')
        _extract_class_code(row)
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

    # 列驱动导出：校验并裁剪客户端 columns（白名单 + 保序 + 透传 virtual）
    columns = excel_exporter.sanitize_columns(data.get('columns'))
    if columns is not None:
        options = {**options, 'columns': columns}

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
        # 阻塞等待进度/结果：导出线程完成前 SSE 不提前断开（修复原实现只排空一次即结束，
        # 导致客户端收不到完成事件、误判导出失败）
        while True:
            # 先排空已就绪的进度消息
            while not progress_queue.empty():
                msg = progress_queue.get_nowait()
                yield f"data: {_json.dumps(msg, ensure_ascii=False)}\n\n"
            # 结果已就绪则发送并结束（成功或失败）
            if not result_queue.empty():
                msg = result_queue.get_nowait()
                yield f"data: {_json.dumps(msg, ensure_ascii=False)}\n\n"
                break
            # 阻塞等待下一个进度事件（最多 0.1s），避免忙轮询
            try:
                msg = progress_queue.get(timeout=0.1)
                yield f"data: {_json.dumps(msg, ensure_ascii=False)}\n\n"
            except queue.Empty:
                continue

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

    # 列驱动导出：校验并裁剪客户端 columns（白名单 + 保序 + 透传 virtual）
    columns = excel_exporter.sanitize_columns(data.get('columns'))
    if columns is not None:
        options = {**options, 'columns': columns}

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


@app.route('/api/export-excel-rows', methods=['POST'])
def api_export_excel_rows():
    """返回与最终导出同源的扁平行（复用 _db_record_to_export）。

    用于「导出为 Excel」确认页的实时预览，保证预览 == 导出。
    version 字段便于后续字段模型升级时做兼容性判断。
    """
    data = request.get_json() or {}
    file_names = data.get('fileNames', [])
    if not file_names:
        return jsonify({'success': False, 'error': '缺少 fileNames'}), 400
    rows = []
    for rec in db_module.get_invoices_by_filenames(file_names):
        rows.extend(_db_record_to_export(rec))
    return jsonify({
        'success': True,
        'version': 'excel-export-v1',
        'rows': rows,
    })


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
    # invoice_id 直接使用 URL 中的字符串（迁移后 id 为 uuid hex）
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
    integer_part = int(amount)
    decimal_part = round(amount - integer_part, 2)
    
    def _convert_section(n, has_wan=False):
        if n == 0:
            return ""
        section_units = ["", "拾", "佰", "仟"]
        s = ""
        zero_flag = False
        for i in range(4):
            d = n % 10
            if d == 0:
                if zero_flag and s and not s.startswith("零"):
                    s = "零" + s
                zero_flag = True
            else:
                s = digits[d] + section_units[i] + s
                zero_flag = False
            n //= 10
            if n == 0:
                break
        return s
    
    def _convert_integer(n):
        if n == 0:
            return "零"
        sections = []
        yi = n // 100000000
        wan = (n // 10000) % 10000
        ge = n % 10000
        zero_pending = False
        if yi > 0:
            sections.append(_convert_section(yi) + "亿")
        if wan > 0:
            if yi > 0 and wan < 1000:
                sections.append("零")
            sections.append(_convert_section(wan) + "万")
        elif yi > 0 and ge > 0:
            sections.append("零")
        if ge > 0:
            if (yi > 0 or wan > 0) and ge < 1000:
                sections.append("零")
            sections.append(_convert_section(ge))
        result = "".join(sections)
        while "零零" in result:
            result = result.replace("零零", "零")
        return result.rstrip("零")
    
    result = _convert_integer(integer_part) + "元"
    dec = int(round(decimal_part * 100))
    if dec == 0:
        result += "整"
    else:
        jiao = dec // 10
        fen = dec % 10
        if jiao > 0:
            result += digits[jiao] + "角"
        elif fen > 0:
            result += "零"
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

        # 解析分页参数（缺失/非法时回退默认值，不报错）
        def _parse_int(name, default):
            raw = request.args.get(name)
            if raw is None:
                return default
            try:
                return int(raw)
            except (ValueError, TypeError):
                return default

        limit = _parse_int('limit', None)
        if limit is not None and limit < 0:
            limit = None
        offset = max(0, _parse_int('offset', 0))

        router = get_decision_router()
        records, total = router.list_review_queue(
            status=status_filter, limit=limit, offset=offset)
        return jsonify({
            "success": True,
            "data": records,
            "count": total,
            "limit": limit,
            "offset": offset,
        })
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

        def _parse_int(name, default):
            raw = request.args.get(name)
            if raw is None:
                return default
            try:
                return int(raw)
            except (ValueError, TypeError):
                return default

        limit = _parse_int('limit', None)
        if limit is not None and limit < 0:
            limit = None
        offset = max(0, _parse_int('offset', 0))

        router = get_decision_router()
        records, total = router.list_exception_queue(
            status=status_filter, limit=limit, offset=offset)
        return jsonify({
            "success": True,
            "data": records,
            "count": total,
            "limit": limit,
            "offset": offset,
        })
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

        # 惰性清理 + LRU 硬上限（过期项与超限 LRU 驱逐，联动清理 registry）
        _page_cache_evict()

        # ── Commit 2: page task -> chunk task ──
        # 旧实现每页任务都 fitz.open 整本 PDF（open 次数 = 页数，整本重复解析）。
        # 现改为「chunk 任务」：每个 worker 仅打开一次整本，处理自己页码块内多页。
        # fitz.Document 仍只属于单个 worker 线程（不可跨线程共享），不提升为全局对象；
        # 不依赖线程与 chunk 的绑定关系（ThreadPoolExecutor 调度任意分配，open 数由
        # chunk_count 上限决定，与调度无关）。
        # chunk_count 上限 = SPLIT_MAX_WORKERS，故总 fitz.open 次数 = min(页数, 8)：
        #   8 页 -> 8 次（与旧持平，无回归）；100 页 -> 8 次（旧 100）；500 页 -> 8 次。
        # page_id 仍 = f"{file_hash}_{i}"（i=0-based 页序），输出 pages[] 顺序不变。
        SPLIT_MAX_WORKERS = 8
        page_count = doc.page_count
        chunk_count = min(page_count, SPLIT_MAX_WORKERS)
        chunk_size = (page_count + chunk_count - 1) // chunk_count if chunk_count else 1
        chunks = []
        for c in range(chunk_count):
            start = c * chunk_size
            end = min(start + chunk_size, page_count)
            if start >= end:
                continue  # 防御性，page_count>=1 时不触发
            chunks.append([(i, i + 1, f"{file_hash}_{i}") for i in range(start, end)])

        def _process_chunk(page_items):
            # 一个 worker 内只打开一次整本 PDF，循环处理块内所有页。
            # 引擎对 pdf_doc 只读（extract_page_pdf/render 仅读 src），块内复用同一句柄安全。
            with fitz.open(stream=file_bytes, filetype="pdf") as local_pdf:
                chunk_out = []
                for (i, page_num, page_id) in page_items:
                    page_bytes = engine.extract_page_pdf(
                        doc.doc_id, page_num, pdf_doc=local_pdf)
                    preview_data, _, _ = engine.render(
                        doc_id=doc.doc_id,
                        preset_name="preview",
                        page=page_num,
                        override_params={"dpi": 200, "fmt": "jpeg"},
                        pdf_doc=local_pdf,
                    )
                    preview_b64 = base64.b64encode(preview_data).decode('ascii')
                    chunk_out.append((i, page_num, page_id, page_bytes, preview_b64))
            return chunk_out

        def _register_and_collect(chunk_results):
            # 主线程写 registry/cache，保证字典写入集中、顺序稳定。
            # chunk_results 为「list of per-chunk lists」，按 chunk 顺序展开即文档序
            # （ex.map 保 chunk 序；每个 chunk 内部按页序产出）。
            for chunk in chunk_results:
                for (i, page_num, page_id, page_bytes, preview_b64) in chunk:
                    with _page_registry_lock:
                        _page_registry[page_id] = {"doc_id": doc.doc_id, "page": page_num}
                    with _page_cache_lock:
                        _page_cache[page_id] = {
                            "bytes": page_bytes,
                            "created_at": now,
                            "last_used": now,
                        }
                    pages.append({
                        "page_index": page_num,
                        "page_id": page_id,
                        "preview_image": preview_b64,
                        "page_bytes": base64.b64encode(page_bytes).decode('ascii'),
                    })

        # 并行渲染：多 chunk 并发处理，消除串行瓶颈；每 worker 仅开一次整本副本，
        # 并发上限约束同时持有的整本副本数，避免内存峰值过高。
        if fitz is not None and doc.page_count > 1:
            max_workers = min(chunk_count, SPLIT_MAX_WORKERS)
            with ThreadPoolExecutor(max_workers=max_workers) as ex:
                # ex.map 按 chunk 顺序返回结果
                results = list(ex.map(_process_chunk, chunks))
            _register_and_collect(results)
        else:
            # 串行回退：fitz 不可用或单页文档（与原行为一致）
            results = [_process_chunk(c) for c in chunks]
            _register_and_collect(results)

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
                _page_cache[page_id] = {
                    "bytes": page_bytes,
                    "created_at": now,
                    "last_used": now,
                }
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
            # 过期：同步清理 cache 与 registry，避免悬空条目
            _page_cache.pop(page_id, None)
            with _page_registry_lock:
                _page_registry.pop(page_id, None)
            return jsonify({"success": False, "error": "页面已过期，请重新拆分"}), 410
        # 命中：刷新 LRU 时间戳
        cache_entry["last_used"] = time.time()

    return _respond_pdf(cache_entry["bytes"], page_id)


# ── 并发解析限流 + OCR 执行器 ──
# 原实现在 Flask 请求线程上同步执行 OCR（CPU/GPU 密集），且并发上限硬编码为 10。
# 在普通 CPU 上，10 个并发 OCR 会因 ONNX 内部 intra_op 线程而严重「超卖」、互相争抢物理核。
# 现改为：
#   (1) 将解析提交到执行器（优先 ProcessPoolExecutor 绕过 GIL；不可用时回退 ThreadPoolExecutor），
#       释放 Flask 请求线程；
#   (2) 并发上限降为 CPU 核数相关值（OCR_WORKERS，默认 2：2 × ONNX(cpu_count//2) ≈ cpu_count，避免超卖）；
#   (3) DB 写入改在主进程完成（worker 内 skip_db_write=True），避免多进程写库与跨进程回传连接。
from concurrent.futures import ThreadPoolExecutor, as_completed  # 仍供 parse_batch 使用
from timer_utils import MAX_PARSE_TIME

import os as _os
import atexit
import ocr_pool_task

# OCR 并发度：默认 2。若需提高，请同步将 OCR 引擎 ONNX intra_op_num_threads 调小，
# 否则多进程各自拉满 cpu_count//2 线程会导致整体超卖。可用 MARSPRINT_OCR_WORKERS 覆盖。
OCR_WORKERS = int(_os.environ.get('MARSPRINT_OCR_WORKERS', max(1, min(_os.cpu_count() or 4, 2))))
_parse_semaphore = threading.Semaphore(OCR_WORKERS)

# 执行器（懒加载，带锁）：优先进程池，回退线程池，再回退同步。
_ocr_executor = None
_ocr_executor_kind = None  # None=未初始化 | 'process' | 'thread' | False=不可用
_executor_lock = threading.Lock()


def _get_executor():
    """返回 OCR 执行器；不可用时返回 None（调用方应同步执行）。"""
    global _ocr_executor, _ocr_executor_kind
    if _ocr_executor_kind is not None:
        return _ocr_executor
    with _executor_lock:
        if _ocr_executor_kind is not None:
            return _ocr_executor
        try:
            from concurrent.futures import ProcessPoolExecutor
            _ocr_executor = ProcessPoolExecutor(
                max_workers=OCR_WORKERS,
                initializer=ocr_pool_task.init_ocr,
            )
            _ocr_executor_kind = 'process'
            atexit.register(lambda: _ocr_executor.shutdown(wait=False))
            logger.info("OCR 执行器: ProcessPoolExecutor (workers=%d)", OCR_WORKERS)
        except Exception as e:
            logger.warning("ProcessPoolExecutor 不可用，回退 ThreadPoolExecutor: %s", e)
            try:
                _ocr_executor = ThreadPoolExecutor(max_workers=OCR_WORKERS, thread_name_prefix='ocr')
                _ocr_executor_kind = 'thread'
                atexit.register(lambda: _ocr_executor.shutdown(wait=False))
                logger.info("OCR 执行器: ThreadPoolExecutor (workers=%d)", OCR_WORKERS)
            except Exception as e2:
                logger.error("OCR 执行器创建失败，将同步执行: %s", e2)
                _ocr_executor = None
                _ocr_executor_kind = False
    return _ocr_executor


def _get_executor_kind():
    """返回 OCR 执行器类型名，用于生产可观测性。

    无执行器（_ocr_executor 为 None，即回退到同步执行）时返回 'none'。
    统一覆盖 ProcessPoolExecutor / ThreadPoolExecutor / sync / disabled 各模式，
    避免散落 type(_ocr_executor).__name__。
    """
    if _ocr_executor is None:
        return "none"
    return type(_ocr_executor).__name__


def _parse_sync(file_bytes, filename, auto_orient, enable_auto_ocr):
    """请求线程内同步解析（回退路径，等价于改造前的行为）。"""
    return parse_invoice_service(
        file_bytes, filename,
        auto_orient=auto_orient, enable_auto_ocr=enable_auto_ocr,
        skip_db_write=True,
    )


def _run_parse_offthread(file_bytes, filename, auto_orient, enable_auto_ocr):
    """将解析任务提交到执行器，释放 Flask 请求线程。

    返回 parse_invoice_service 的结果字典（worker 内 skip_db_write=True）。
    任何异常（进程池不可用 / 任务超时 / 子进程故障）均回退为同步执行，保证端点不中断。
    """
    executor = _get_executor()
    if executor is None:
        return _parse_sync(file_bytes, filename, auto_orient, enable_auto_ocr)
    try:
        # 超时略大于 MAX_PARSE_TIME，避免单任务无限挂起占用信号量
        timeout = MAX_PARSE_TIME / 1000.0 + 30.0
        future = executor.submit(ocr_pool_task.run_parse, file_bytes, filename, auto_orient, enable_auto_ocr)
        return future.result(timeout=timeout)
    except Exception as e:
        logger.warning("OCR 执行器执行失败，回退同步解析: %s", e)
        return _parse_sync(file_bytes, filename, auto_orient, enable_auto_ocr)


# 供 parse_batch 使用的「提交层」并发限流（外层 ThreadPool 仅为调度层）。
# 注意：OCR 实际并行度由 _get_executor() 的 ProcessPoolExecutor + OCR_WORKERS 决定，
# 与 BATCH_WORKERS / parse_semaphore 解耦——调参时不要混淆两者。
# 该 semaphore 仅限制「同时向进程池提交的任务数」，上限与 CPU 核数挂钩：
# max(2, cpu_count())；cpu_count() 为 None 时回退到 2。
parse_semaphore = threading.Semaphore(max(2, os.cpu_count() or 1))


@app.route('/parse_invoice', methods=['POST'])
def parse_invoice():
    _route_start = time.time()
    if 'file' not in request.files:
        return jsonify({"success": False, "error": "没有上传文件"}), 400

    file = request.files['file']
    if not allowed_file(file.filename):
        return jsonify({"success": False, "error": "不支持的文件格式"}), 400

    if not _parse_semaphore.acquire(blocking=False):
        return jsonify({"success": False, "error": "当前解析任务较多，请稍后重试"}), 429

    try:
        file.seek(0)
        file_bytes = file.read()  # 只读取一次，后续复用
        # Identity Contract v1.1：文档永久身份 = sha256(file_bytes)[:24]（content-only，filename 不进哈希）。
        # 与 /split_pdf、/preview/{doc_id} 共用同一 doc_id，使单文件 parse 也能闭合身份链（4.2.1-c）。
        doc_id = _make_doc_id(file_bytes, file.filename or "")

        auto_orient = request.form.get('autoOrient', '1') == '1'
        enable_auto_ocr = request.form.get('enableAutoOcr', '0') == '1'
        _legacy_start = time.time()
        # 交由执行器（进程池/线程池）执行，释放 Flask 请求线程；
        # worker 内 skip_db_write=True，DB 写入改在主线程完成（见下方）。
        result = _run_parse_offthread(file_bytes, file.filename, auto_orient, enable_auto_ocr)
        _legacy_ms = round((time.time() - _legacy_start) * 1000, 2)
        logger.info("[PERF] 旧管道 parse_invoice_service 耗时: %.2fms (executor=%s)",
                    _legacy_ms, _ocr_executor_kind or 'sync')
    except Exception as e:
        logger.exception("发票解析失败")
        return jsonify({"success": False, "error": "发票解析失败"}), 500
    finally:
        _parse_semaphore.release()

    # ── 主进程完成 DB 写入（worker 中 skip_db_write=True，避免跨进程写库） ──
    if result is not None:
        db_record = result.get('db_record')
        if db_record:
            try:
                result['db_result'] = db_module.upsert_invoice(db_record)
            except Exception as e:
                logger.warning("发票自动入库失败: %s", e)
                result['db_result'] = None

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
        doc_id=doc_id,
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
                # P1-3: 收敛到已有 OCR 进程池（ProcessPoolExecutor，绕过 GIL），与单文件
                # /parse_invoice 共用同一执行器与 OCR_WORKERS 并行度。外层 ThreadPool +
                # parse_semaphore 仅做调度/提交限流，不再在 batch 线程内直接跑 OCR。
                # _run_parse_offthread 内部 skip_db_write=True，DB 写入仍由主进程批量完成。
                svc_result = _run_parse_offthread(
                    fi['bytes'], fi['filename'],
                    auto_orient, enable_auto_ocr,
                )
                if svc_result is None:
                    return index, None, f"无法识别的文件格式: {fi['filename']}"
                return index, svc_result, None
            except Exception as e:
                logger.error("[parse_batch] 解析失败 [%d] %s: %s", index, fi['filename'], e)
                return index, None, str(e)
            finally:
                parse_semaphore.release()

        # P1-3-b: 一次 batch 仅记录一次执行器类型，便于生产确认 batch OCR 实际跑在哪个
        # 执行器上（ProcessPoolExecutor / ThreadPoolExecutor / none=sync 回退）。目的仅为
        # 可观测——若静默回退到 ThreadPool/sync，优化等于未生效，INFO 级才能在生产日志发现。
        # 注意：OCR 并行度由 OCR_WORKERS 决定，与 BATCH_WORKERS / parse_semaphore 解耦。
        logger.info("parse_batch OCR executor=%s workers=%s",
                    _get_executor_kind(), OCR_WORKERS)

        with ThreadPoolExecutor(max_workers=BATCH_WORKERS,
                                thread_name_prefix='batch-parse') as pool:
            futures = {pool.submit(_parse_one, i, fi): i
                       for i, fi in enumerate(file_inputs)}
            completed = 0
            for fut in as_completed(futures):
                idx, svc_result, error = fut.result()
                results[idx] = (idx, svc_result, error)
                completed += 1
                progress_queue.put({'current': completed, 'total': total})

        # 批量入库
        db_records = []
        record_index_map = {}
        for i, (idx, svc_result, error) in enumerate(results):
            if svc_result and svc_result.get('db_record'):
                record_index_map[len(db_records)] = idx
                db_records.append(svc_result['db_record'])

        # 预构建反向映射 {file_idx: db_record 位置}，把下方「逐个文件匹配 db 结果」从 O(N·M) 降为 O(N)。
        # 依赖 batch_upsert_invoices 返回顺序与入参 rows 对应的契约（见 db.py 文档）。
        file_db_map = {idx: pos for pos, idx in record_index_map.items()}

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
                rec_idx = file_db_map.get(idx)
                if rec_idx is not None and rec_idx < len(db_results):
                    db_res = db_results[rec_idx]
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
        # 阻塞等待事件：进度到达即唤醒（零额外延迟），而非 time.sleep 忙轮询
        while True:
            # 先消费已就绪的进度消息
            while not progress_queue.empty():
                msg = progress_queue.get_nowait()
                yield f"data: {_json.dumps(msg, ensure_ascii=False)}\n\n"
            # 结果已就绪则发送并结束（解析完成）
            if not result_queue.empty():
                msg = result_queue.get_nowait()
                yield f"data: {_json.dumps(msg, ensure_ascii=False)}\n\n"
                break
            # 阻塞等待下一个进度事件（最多 0.1s），超时再探活 result_queue；无空转
            try:
                msg = progress_queue.get(timeout=0.1)
                yield f"data: {_json.dumps(msg, ensure_ascii=False)}\n\n"
            except queue.Empty:
                continue

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'},
    )


# ============================
#  PDF 导出 SSE
# ============================

from services.pdf_export import PdfExportService, ExportItem
from services.task import task_registry
from services.export_stream import stream_export_progress
import base64

_export_pdf_service = PdfExportService()
_export_pdf_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='pdf-export')


def _build_export_items(files, mode, merge_output):
    """将请求中的 files 列表转为 ExportItem 列表，同时做参数校验。"""
    items = []
    for f in files:
        filename = f.get('name', '')

        # 合并模式：不要求每文件 outputPath
        output_path = f.get('outputPath', '')
        if mode != 'merge' and not output_path:
            return None, f"缺少 outputPath: {filename}"

        # 优先读取本地文件路径
        file_path = f.get('path', '')
        if file_path and os.path.isfile(file_path):
            with open(file_path, 'rb') as fh:
                source = fh.read()
        elif f.get('data'):
            source = base64.b64decode(f['data'])
        else:
            return None, f"缺少 source: {filename}"

        items.append(ExportItem(
            source=source,
            output_path=output_path or merge_output,
            filename=filename,
        ))
    return items, None


def _run_export_task(task_id, items, mode, merge_output):
    """后台执行导出任务（不阻塞请求线程）。"""
    task = task_registry.get(task_id)
    if task is None:
        logger.error("[PDF Export] task %s not found on execution start", task_id[:8])
        return

    try:
        if mode == 'merge':
            _export_pdf_service.merge_files(items, merge_output, task=task)
        else:
            _export_pdf_service.export_files(items, task=task)
    except Exception:
        logger.exception("[PDF Export] 后台导出异常 task=%s", task_id[:8])


@app.route('/api/export-pdf', methods=['POST'])
def api_export_pdf():
    """创建导出任务，返回 taskId。任务在后台执行，不阻塞请求。"""
    data = request.get_json(silent=True) or {}
    files = data.get('files', [])
    mode = data.get('mode', 'single')
    merge_output = data.get('outputPath', '')

    if not files:
        return jsonify({"success": False, "error": "缺少 files 参数"}), 400

    if mode == 'merge' and not merge_output:
        return jsonify({"success": False, "error": "合并模式缺少 outputPath"}), 400

    items, err = _build_export_items(files, mode, merge_output)
    if err:
        return jsonify({"success": False, "error": err}), 400

    # 创建任务（无 progress_queue，任务状态由 ExportTask 本身承载）
    task = task_registry.create(total=len(items))

    # 后台线程执行
    _export_pdf_executor.submit(
        _run_export_task, task.id, items, mode, merge_output
    )

    return jsonify({"success": True, "taskId": task.id})


@app.route('/api/export-pdf/events/<task_id>', methods=['GET'])
def api_export_pdf_events(task_id):
    """SSE 流式读取任务状态（只读，不参与业务执行）。

    职责边界（Phase 3.1.3-B 冻结）：
      - 本路由只负责 HTTP 状态码、SSE 帧封装与 headers
      - 状态读取 / 轮询 / 终态停止由 services.export_stream.stream_export_progress 承担
      - 状态的唯一来源是 ExportTask.to_dict()
    """
    if task_registry.get(task_id) is None:
        return jsonify({"success": False, "error": "任务不存在"}), 404

    def generate():
        for state in stream_export_progress(task_id, task_registry):
            yield f"data: {_json.dumps(state, ensure_ascii=False)}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'},
    )


@app.route('/api/export-pdf/cancel', methods=['POST'])
def api_export_pdf_cancel():
    """请求取消一个导出任务。"""
    data = request.get_json(silent=True) or {}
    task_id = data.get('taskId', '')
    if not task_id:
        return jsonify({"success": False, "error": "缺少 taskId"}), 400
    if task_registry.cancel(task_id):
        return jsonify({"success": True})
    return jsonify({"success": False, "error": "任务不存在"}), 404


# ============================
#  Export Render SSE（D3-3a：RenderCommand → Raster/PDF 布局级导出）
# ============================

from services.export_render_schema import validate_export_render_request
from services.export_render_service import execute_export_render

_export_render_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='export-render')


def _export_render_output_path(task_id):
    """Deterministic on-disk location for the generated PDF.

    D3-3b-3 keeps the request envelope unchanged (no outputPath field), so the
    produced file lands at a task-id-derived temp path. Client delivery
    (download endpoint / caller-provided outputPath) is an explicit out-of-scope
    follow-up; the file's existence is what closes the source -> executor -> PDF
    loop and what the tests assert.
    """
    return os.path.join(tempfile.gettempdir(), f'export-render-{task_id}.pdf')


def _run_export_render_task(task_id, commands):
    """D3-3b-3 real executor — command -> fitz page -> merged PDF on disk.

    Orchestration is delegated to services.export_render_service.execute_export_render
    (Source/Geometry/Output layers stay separate, mirroring export-pdf). This
    function only owns the task lifecycle + persistence. It MUST NOT compute
    fit / scale / center / rotation -- geometry ownership is the frontend's
    RenderCommand. Grep ban: _apply_margins / calculateFit / fit_scale.

    Args:
        task_id:  任务 ID。
        commands: 已通过 validate_export_render_request 的归一化命令列表
                  （sourceRef + paper 已在 POST 边界校验完成）。
    """
    task = task_registry.get(task_id)
    if task is None:
        logger.error("[Export Render] task %s not found on execution start", task_id[:8])
        return

    try:
        task.start()
        pdf_bytes = execute_export_render(commands, progress=lambda lbl: task.advance(lbl))
        out_path = _export_render_output_path(task_id)
        with open(out_path, 'wb') as fh:
            fh.write(pdf_bytes)
        task.complete()
    except Exception as e:
        logger.exception("[Export Render] task %s 生成异常", task_id[:8])
        task.fail(str(e) or "export-render generation failure")


@app.route('/api/export-render', methods=['POST'])
def api_export_render():
    """D3-3a 布局级导出入口：接收前端 RenderCommand，后台执行，立即返回 taskId。

    Additive：不碰 /api/export-pdf / insert_pdf / pdf_handlers / render_engine._apply_margins。
    语义与 /api/export-pdf 不同：本端点消费**布局级 RenderCommand**（几何已由前端算好），
    而非文件级透传。
    """
    data = request.get_json(silent=True) or {}
    commands, err = validate_export_render_request(data)
    if err:
        return jsonify({"success": False, "error": err}), 400

    task = task_registry.create(total=len(commands))
    _export_render_executor.submit(_run_export_render_task, task.id, commands)
    return jsonify({"success": True, "taskId": task.id})


@app.route('/api/export-render/events/<task_id>', methods=['GET'])
def api_export_render_events(task_id):
    """SSE 流式读取导出渲染任务状态（只读，与 /api/export-pdf/events 同构）。"""
    if task_registry.get(task_id) is None:
        return jsonify({"success": False, "error": "任务不存在"}), 404

    def generate():
        for state in stream_export_progress(task_id, task_registry):
            yield f"data: {_json.dumps(state, ensure_ascii=False)}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'},
    )


# ============================
#  Import Scale v1（批量导入任务生命周期）
# ============================


@app.route('/import/batch', methods=['POST'])
def import_batch_create():
    """创建批量导入任务（Import Scale v1）

    接收 multipart/form-data 文件列表，创建 ImportBatch 并异步调度解析。
    客户端随后通过 GET /import/batch/{batchId}/events 监听 SSE 进度。

    与旧 /parse_batch 的区别：
    - 不绑定 HTTP 生命周期（POST 立即返回 batchId）
    - 无 100 文件硬限制（由 BatchManager 窗口式调度）
    - 结果经 ResultBuffer 批量入库（非逐条 upsert）
    """
    files = request.files.getlist('files')
    if not files:
        return jsonify({"success": False, "error": "没有上传文件"}), 400

    auto_orient = request.form.get('autoOrient', '1') == '1'
    enable_auto_ocr = request.form.get('enableAutoOcr', '0') == '1'
    client_keys = request.form.getlist('clientKeys')  # 护栏A：可选，与 files 按索引对齐

    # 在主线程预读取所有文件字节（Flask request context 不可跨线程访问）
    file_inputs = []
    for i, f in enumerate(files):
        f.seek(0)
        file_inputs.append({
            'bytes': f.read(),
            'filename': f.filename,
            'clientKey': client_keys[i] if i < len(client_keys) else '',
        })

    mgr = get_import_batch_manager()
    batch_id = mgr.create_batch(file_inputs, auto_orient=auto_orient,
                                enable_auto_ocr=enable_auto_ocr)

    return jsonify({
        "success": True,
        "batchId": batch_id,
        "total": len(file_inputs),
    })


@app.route('/import/batch/<batch_id>/events', methods=['GET'])
def import_batch_events(batch_id):
    """SSE 流式读取批量导入进度（只读，不参与业务执行）

    模式与 /api/export-pdf/events/<task_id> 同构：
    - 轮询 ImportBatch.to_dict()
    - 终态（completed/failed/cancelled）后停止
    """
    mgr = get_import_batch_manager()
    if mgr.get_batch(batch_id) is None:
        return jsonify({"success": False, "error": "批次不存在"}), 404

    def generate():
        try:
            while True:
                state = mgr.get_batch_dict(batch_id)
                if state is None:
                    break
                yield f"data: {_json.dumps(state, ensure_ascii=False)}\n\n"
                if state['status'] in ('completed', 'failed', 'cancelled'):
                    logger.info(f"[SSE] batch={batch_id} 终态={state['status']}，generator 正常退出")
                    break
                time.sleep(0.5)
        except GeneratorExit:
            logger.info(f"[SSE] batch={batch_id} client disconnected (GeneratorExit)")
            raise

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'},
    )


@app.route('/import/batch/cancel', methods=['POST'])
def import_batch_cancel():
    """取消批量导入任务"""
    data = request.get_json(silent=True) or {}
    batch_id = data.get('batchId', '')
    if not batch_id:
        return jsonify({"success": False, "error": "缺少 batchId"}), 400
    mgr = get_import_batch_manager()
    if mgr.cancel_batch(batch_id):
        return jsonify({"success": True})
    return jsonify({"success": False, "error": "批次不存在或已完成"}), 404


@app.route('/import/batch/<batch_id>/results', methods=['GET'])
def import_batch_results(batch_id):
    """获取批量导入的解析结果（用于前端 hydration）
    
    batch completed 后，前端调用此接口拉取字段数据。
    返回 clientKey 用于精确匹配前端 fileObj。
    """
    mgr = get_import_batch_manager()
    if mgr.get_batch(batch_id) is None:
        return jsonify({"success": False, "error": "批次不存在"}), 404
    
    items = mgr.get_batch_results(batch_id)
    return jsonify({"success": True, "items": items})


if __name__ == '__main__':
    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s %(levelname)s %(name)s - %(message)s',
    )
    # ── 冷启动诊断：确认运行时实际使用的数据库路径 ──
    # 注意：db.py 模块级 logger.info（DB_DIR/INVOICES_PATH）在 import 时执行，
    # 早于本 basicConfig，会被 lastResort(WARNING) 静默丢弃；此处补足可见输出。
    logger.info("[DB-PATH] DB_DIR        = %s", db_module.DB_DIR)
    logger.info("[DB-PATH] INVOICES_PATH = %s", db_module.INVOICES_PATH)
    logger.info("[DB-PATH] OPLOG_PATH    = %s", db_module.OPLOG_PATH)
    logger.info("[DB-PATH] MARSPRINT_DB_PATH env = %r", os.environ.get('MARSPRINT_DB_PATH', ''))
    from cache import _get_manager
    _cache_mgr = _get_manager()
    migrated = _cache_mgr.migrate_legacy()
    if migrated > 0:
        logger.info("[Cache] 启动迁移: %d 个旧缓存文件已移入 _legacy/", migrated)
    ttl_cleaned = _cache_mgr.cleanup_by_ttl()
    if ttl_cleaned > 0:
        logger.info("[Cache] TTL 清理: %d 个过期文件", ttl_cleaned)
    db_module.cleanup_expired_invoices()
    _page_cache_cleanup_thread = threading.Thread(
        target=_page_cache_periodic_cleanup, daemon=True, name="page-cache-cleanup"
    )
    _page_cache_cleanup_thread.start()
    logger.info("[App] 页面缓存后台清理线程已启动")
    import atexit
    @atexit.register
    def shutdown_job_manager():
        logger.info("[App] 正在关闭任务队列管理器...")
        get_job_manager().shutdown()
        logger.info("[App] 任务队列管理器已关闭")
    @atexit.register
    def stop_page_cache_cleanup():
        _page_cache_stop_event.set()
    app.run(port=5000, debug=True, threaded=True)
