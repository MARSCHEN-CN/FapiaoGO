"""
发票解析服务层
从 app.py parse_invoice() 路由中抽取核心业务逻辑：
  格式检测 → 解析调度(OFD/图片/PDF) → OCR/字段提取 → DB 记录构建
"""

import io
import hashlib
import json
import logging
import os
import time
from werkzeug.utils import secure_filename
import magic
# fitz (PyMuPDF) 已由 ParserRegistry 解析器返回共享 doc，无需此处直接导入

from parsers import registry as parser_registry
from pdf_bbox_parser import parse_pdf_with_bbox_from_doc
from xml_parser import parse_xml
from ofd_parser import parse_ofd
from image_parser import parse_image_ocr
from field_extractor import extract_fields
from cache import get_fields_cache, set_fields_cache
from file_validator import validate_file
from timer_utils import (
    timer, check_timeout, MAX_PARSE_TIME, 
    check_image_size, check_pdf_pages,
    PerformanceMetrics
)
import db as db_module

logger = logging.getLogger(__name__)

# 允许的文件扩展名
ALLOWED_EXTENSIONS = {'pdf', 'ofd', 'jpg', 'jpeg', 'png', 'bmp', 'tiff', 'tif', 'xml'}

# 开发模式判断
is_debug = os.environ.get('APP_DEBUG', '0') == '1'


# =========================
# 工具函数
# =========================

def safe_float(v, default=0.0):
    """安全地将值转换为浮点数，避免崩溃"""
    if v is None:
        return default
    try:
        return float(
            str(v)
            .replace(',', '')
            .replace('¥', '')
            .replace('￥', '')
            .replace('*', '')
            .replace('-', '')
            .strip()
        )
    except (ValueError, TypeError):
        return default


# =========================
# 工具函数
# =========================

def allowed_file(filename):
    """检查文件扩展名是否在允许列表中"""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def sanitize_filename(filename):
    """清理文件名，防止路径遍历攻击"""
    if not filename:
        return 'unknown'
    safe_name = secure_filename(filename)
    if not safe_name or safe_name == '':
        return 'unknown'
    return safe_name


def detect_file_format(file_bytes, filename):
    """使用文件头 magic number 和扩展名检测文件真实格式
    
    内部调用 validate_file 进行验证，验证失败时返回 (None, {})。
    返回 (file_type, details)：details 中包含 pdf_kind 和 pdf_doc（PDF 格式时）。
    调用方无需再调用 validate_file，避免重复验证。
    
    Returns:
        tuple: (file_type or None, details dict)
    """
    validation = validate_file(file_bytes, filename)
    if not validation.get('valid'):
        logger.error(f"文件验证失败: {validation.get('error', '未知错误')}")
        return None, {}
    return validation.get('file_type'), validation.get('details', {})


def has_structured_data(inv_type, inv_number, amt):
    """
    检查是否提取到了有效的发票结构化数据。
    使用评分机制：至少需要 2 个有效字段才算成功。
    """
    score = 0

    # 发票类型有效
    if inv_type and inv_type != '其他':
        score += 1

    # 发票号码有效（8/10/12/20 位数字）
    if inv_number and inv_number not in ('未知号码', ''):
        digits_only = ''.join(c for c in inv_number if c.isdigit())
        if len(digits_only) in (8, 10, 12, 20):
            score += 1

    # 金额有效（> 0）
    if amt and amt not in ('0.00', '0', ''):
        try:
            if float(str(amt).replace(',', '').replace('¥', '')) > 0:
                score += 1
        except (ValueError, TypeError):
            pass

    return score >= 2


# =========================
# 核心解析逻辑
# =========================

def parse_invoice_service(file_bytes, filename, auto_orient=True, force_ocr=False, enable_auto_ocr=False, skip_db_write=False):
    """
    统一发票解析入口：根据文件格式调度解析器并构建 DB 记录。
    
    Args:
        file_bytes: 文件字节内容（由调用方读取，避免重复 I/O）
        filename: 文件名（用于格式检测和安全命名）
        auto_orient: 是否自动回正图片方向
        force_ocr: ⚠️ v5: 是否强制 OCR（用于获取 bbox_data）
        enable_auto_ocr: 是否启用自动 need_ocr 检测（默认关闭，仅 force_ocr 触发 OCR）
        skip_db_write: 为 True 时跳过单条 upsert，由调用方收集 db_record 后批量写入
    
    Returns:
        dict: {
            file_format, parse_method, invoice_type, invoice_number, amount,
            invoice_date, raw_text, preview_image, safe_filename,
            extra_fields, bbox_data, db_record, metrics
        }
    """
    start_time = time.perf_counter()
    metrics = PerformanceMetrics()
    
    # 直接使用传入的 bytes；构造 BytesIO 供向下兼容的解析器使用
    raw_bytes = file_bytes
    file = io.BytesIO(raw_bytes)
    # 文件内容标识：前 1KB + 文件长度的 SHA-256，降低大文件全量哈希开销
    # 缓存 key 不需要加密级防碰撞，截断哈希足以区分不同文件
    _head = raw_bytes[:1024]
    hash_sha256 = hashlib.sha256(_head + str(len(raw_bytes)).encode()).hexdigest()
    bbox_data = []
    from_cache = False

    # 文件格式检测（内部已包含验证，无需重复调用 validate_file）
    file_format, file_details = detect_file_format(raw_bytes, filename)
    if file_format is None:
        return None  # 验证失败，直接返回
    
    safe_filename = sanitize_filename(filename)

    invoice_type = '其他'
    invoice_number = '未知号码'
    amount = '0.00'
    invoice_date = '未知日期'
    raw_text = ''
    raw_text_for_extract = ''
    raw_text_original = ''
    preview_image = None
    extra_fields = None
    parse_method = '未知解析'
    source_type = ''  # pdf_text / pdf_ocr / image / ofd / xml
    auxiliary_blocks = []  # 初始化一次，所有分支共用，禁止后续重置
    pdf_doc = None  # 提前初始化，避免非 PDF 分支访问时报 UnboundLocalError

    # ====== 统一解析调度 ======
    if file_format == 'xml':
        parse_method = 'XML 解析'
        source_type = 'xml'
        with metrics.timer('xml_parse'):
            result = parse_xml(file)
        if result:
            invoice_type = result.get("invoice_type", "其他")
            invoice_number = result.get("invoice_number", "未知号码")
            amount = result.get("amount", "0.00")
            invoice_date = result.get("invoice_date", "未知日期")
            raw_text = result.get("text", "")
            raw_text_for_extract = raw_text
            preview_image = result.get("preview_image")

    elif file_format == 'ofd':
        parse_method = 'OFD 解析'
        source_type = 'ofd'
        with metrics.timer('ofd_parse'):
            result = parse_ofd(file)
        if result:
            invoice_type = result.get("invoice_type", "其他")
            invoice_number = result.get("invoice_number", "未知号码")
            amount = result.get("amount", "0.00")
            invoice_date = result.get("invoice_date", "未知日期")
            raw_text = result.get("text", "")
            raw_text_for_extract = raw_text
            preview_image = result.get("preview_image")

    elif file_format == 'image':
        parse_method = 'OCR 解析'
        source_type = 'image'
        try:
            with metrics.timer('image_ocr'):
                result = parse_image_ocr(file, auto_orient=auto_orient)
            if result:
                invoice_type = result.get("invoice_type", "其他")
                invoice_number = result.get("invoice_number", "未知号码")
                amount = result.get("amount", "0.00")
                invoice_date = result.get("invoice_date", "未知日期")
                raw_text = result.get("text", "")
                raw_text_for_extract = raw_text
                bbox_data = result.get("bbox_data", [])
                preview_image = result.get("preview_image")
        except Exception as e:
            import traceback
            logger.error("图片解析流程异常: %s\n%s", e, traceback.format_exc())

    # ====== 统一字段提取（XML/OFD/Image） ======
    if file_format in ('xml', 'ofd', 'image') and raw_text_for_extract:
        # ✅ hash_sha256 已在函数入口处计算，直接复用
        field_cache_key = hash_sha256
        field_cache_params = {
            'auto_orient': bool(auto_orient),
            'force_ocr': bool(force_ocr),
            'source_type': source_type,
            'has_bbox': bool(bbox_data),
            'has_auxiliary_blocks': False,
            'auxiliary_hash': '',
        }
        
        with metrics.timer('cache_read'):
            cached_fields = get_fields_cache(field_cache_key, params=field_cache_params)
        
        # 调试模式：强制绕过缓存，确保每次解析都走新管道
        from config import CACHE_DEBUG
        if CACHE_DEBUG:
            print("[DEBUG] 字段缓存命中 — 强制绕过，重新提取")
            cached_fields = None  # 忽略缓存
        
        if cached_fields:
            # ✅ 使用缓存结果，避免重复提取
            extra_fields = cached_fields
            parse_method += '（16步）'
        else:
            with metrics.timer('field_extract'):
                extra_fields = extract_fields(
                    raw_text_for_extract,
                    bbox_data=bbox_data,
                    source_type=source_type,
                    auxiliary_blocks=[],
                    pymupdf_page=None,
                )
                parse_method += '（16步）'

            with metrics.timer('cache_write'):
                try:
                    set_fields_cache(field_cache_key, extra_fields, params=field_cache_params)
                except Exception:
                    pass
        
        # 仅在提取器返回非默认值时才覆盖原有值，避免默认值覆盖正确解析结果
        ext_type = extra_fields.get('type', '')
        if ext_type and ext_type != '其他':
            invoice_type = ext_type
        
        ext_fphm = extra_fields.get('fphm', '')
        if ext_fphm and ext_fphm != '未知号码':
            invoice_number = ext_fphm

        ext_amount = extra_fields.get('amountHj', '')
        if ext_amount and ext_amount != '0.00':
            amount = ext_amount
        
        ext_kprq = extra_fields.get('kprq', '')
        if ext_kprq and ext_kprq != '未知日期':
            invoice_date = ext_kprq

    elif file_format == 'pdf':
        pdf_doc = None  # 在 try 外初始化，保证 finally 能访问
        try:
            # ── PDF 分类：复用 validate_pdf() 已完成的分类结果 ──
            pdf_kind = file_details.get('pdf_kind', 'image')
            pdf_doc = file_details.get('pdf_doc')  # 预打开的 doc（由 validate_pdf 返回）
            parser_name = 'pdf_text' if pdf_kind == 'text' else 'pdf_ocr'
            logger.info("[PDF 路由] classify=%s, parser=%s", pdf_kind, parser_name)
            
            # ── 顺序执行：PDF 文本解析 → bbox 解析（复用预提取 words） ──
            # [PERF] 放弃并行，让 _do_parse 返回的 words_data 直接被 _do_bbox 复用，
            # 避免两个线程各自调用 page.get_text("words") 的重复提取。
            bbox_result = None
            
            def _do_parse():
                return parser_registry.parse(
                    raw_bytes, filename,
                    options={
                        'auto_orient': auto_orient,
                        'force_ocr': force_ocr,
                        'parser_name': parser_name,
                        'pdf_doc': pdf_doc,  # 传入预打开的 doc，避免重新打开
                    }
                )
            
            def _do_bbox(pre_words):
                if pdf_doc is None:
                    return None
                try:
                    return parse_pdf_with_bbox_from_doc(pdf_doc, pre_words=pre_words)
                except Exception as e:
                    logger.warning(f"bbox 解析失败: {e}")
                    return None
            
            with metrics.timer('pdf_parse'):
                parse_result, _ = _do_parse()
                # 仅当非缓存命中时才做 bbox（缓存命中意味着无新 words_data）
                pre_words = parse_result.words_data or None
                if not parse_result.from_cache and pre_words is not None:
                    bbox_result = _do_bbox(pre_words)
            
            # 安全：优先使用 parser 返回的 doc 引用；若为 None 则保留原始引用供 finally 关闭
            if parse_result.pdf_doc is not None:
                pdf_doc = parse_result.pdf_doc
            from_cache = parse_result.from_cache
            
            if from_cache:
                parse_method = parse_result.parse_method + '（缓存命中）'
                metrics.add_metric('cache_read_ms', metrics._metrics.get('pdf_parse', 0))
                source_type = parse_result.source_type
            else:
                parse_method = parse_result.parse_method + ('(区域识别)' if bbox_result else '')
                source_type = parse_result.source_type
            
            raw_text_original = parse_result.text or ''
            raw_text_for_extract = raw_text_original
            
            # 准备辅助文本块（结构化 bbox 输入）
            auxiliary_blocks = []
            if bbox_result:
                buyer_text = bbox_result.get('buyer_text', '')
                seller_text = bbox_result.get('seller_text', '')
                
                # 结构化辅助块（用于来源追踪和置信度评分），不污染 raw_text_original。
                
                if buyer_text:
                    auxiliary_blocks.append({
                        "source": "bbox_party",
                        "role": "buyer",
                        "text": buyer_text,
                        "confidence": 0.85,  # bbox 识别的置信度
                    })
                if seller_text:
                    auxiliary_blocks.append({
                        "source": "bbox_party",
                        "role": "seller",
                        "text": seller_text,
                        "confidence": 0.85,
                    })
            
            # ── 复用已打开的 PyMuPDF 文档获取首页 Page 对象 ──
            pymupdf_page = None
            if pdf_doc is not None and len(pdf_doc) > 0:
                pymupdf_page = pdf_doc[0]
            
            # ====== 统一字段提取 ======
            bbox_data = []
            # 注意：auxiliary_blocks 已在上方 PDF 分支中从 bbox_result 填充，此处不能重置
            from_cache_field = False  # v10 新增：追踪是否来自缓存
            if raw_text_for_extract:
                # hash_sha256 在函数开头第 159 行已经计算过，直接复用
                field_cache_key = hash_sha256
                auxiliary_hash = hashlib.sha256(
                    json.dumps(auxiliary_blocks, ensure_ascii=False, sort_keys=True).encode('utf-8')
                ).hexdigest()[:16]
                field_cache_params = {
                    'auto_orient': bool(auto_orient),
                    'force_ocr': bool(force_ocr),
                    'source_type': source_type,
                    'has_bbox': bool(parse_result.bbox_data),
                    'has_auxiliary_blocks': bool(auxiliary_blocks),
                    'auxiliary_hash': auxiliary_hash,
                }
                
                with metrics.timer('cache_read'):
                    cached_fields = get_fields_cache(field_cache_key, params=field_cache_params)
                
                from config import CACHE_DEBUG
                if CACHE_DEBUG and cached_fields:
                    print("[DEBUG] 字段缓存命中 — 强制绕过，重新提取")
                    cached_fields = None
                
                bbox_data = parse_result.bbox_data
                
                # 字段提取：走旧提取（extract_fields），提供完整的字段数据。
                with metrics.timer('field_extract'):
                    extra_fields = extract_fields(
                        raw_text_for_extract, 
                        bbox_data=bbox_data, 
                        source_type=source_type,
                        auxiliary_blocks=auxiliary_blocks,
                        pymupdf_page=pymupdf_page,
                    )
                    parse_method += '（16步）'
                
                with metrics.timer('cache_write'):
                    try:
                        set_fields_cache(field_cache_key, extra_fields, params=field_cache_params)
                    except Exception:
                        pass
                # 仅在提取器返回非默认值时才覆盖原有值，避免默认值覆盖正确解析结果
                ext_type = extra_fields.get('type', '')
                if ext_type and ext_type != '其他':
                    invoice_type = ext_type
                
                ext_fphm = extra_fields.get('fphm', '')
                if ext_fphm and ext_fphm != '未知号码':
                    invoice_number = ext_fphm
                
                ext_amount = extra_fields.get('amountHj', '')
                if ext_amount and ext_amount != '0.00':
                    amount = ext_amount
                
                ext_kprq = extra_fields.get('kprq', '')
                if ext_kprq and ext_kprq != '未知日期':
                    invoice_date = ext_kprq
            
        finally:
            # ✅ 确保 pdf_doc 一定被关闭，即使中间抛异常
            if pdf_doc is not None:
                try:
                    pdf_doc.close()
                except Exception:
                    pass

    # 检查数据完整性
    if not has_structured_data(invoice_type, invoice_number, amount):
        parse_method += '（数据缺失）'

    # 检查超时
    if check_timeout(start_time, MAX_PARSE_TIME, f'解析文件 {safe_filename}'):
        parse_method += '（超时）'

    # 获取性能统计
    perf_summary = metrics.get_summary()
    logger.info("发票类型: %s, 号码: %s, 金额: %s, 解析方式: %s",
                invoice_type, invoice_number, amount, parse_method)
    
    # 详细打印各阶段耗时，便于和 vNext 对比分析重复计算
    # PerformanceMetrics.get_summary() 直接把计时器放在根层级，不是 timers 键下
    _stage_keys = ['pdf_parse', 'image_ocr', 'xml_parse', 'ofd_parse', 
                   'text_parse', 'bbox_parse', 'field_extract', 
                   'cache_read', 'cache_write', 'parallel_parse']
    _stages = []
    for k in _stage_keys:
        if k in perf_summary:
            _stages.append(f"{k}={perf_summary[k]:.0f}ms")
    logger.info("[PERF-LEGACY] 总耗时 %.0fms | 阶段: %s | bbox数=%d | text_len=%d",
                perf_summary.get('total_ms', 0),
                ' '.join(_stages) if _stages else '(无细分计时)',
                len(bbox_data),
                len(raw_text_for_extract))

    # 构建 DB 记录
    db_record = {
        'hash_sha256': hash_sha256,
        'file_name': filename,
        'file_format': file_format,
        'file_size': len(raw_bytes),
        'type': invoice_type,
        'number': invoice_number,
        'amount': safe_float(amount),
        'date': invoice_date if invoice_date and invoice_date != '未知日期' else '',
        'buyer': extra_fields.get('gmfmc', '') if extra_fields else '',
        'buyer_tax': extra_fields.get('gmfsh', '') if extra_fields else '',
        'seller': extra_fields.get('xsfmc', '') if extra_fields else '',
        'seller_tax': extra_fields.get('xsfsh', '') if extra_fields else '',
        'note': extra_fields.get('note', '') if extra_fields else '',
        'issuer': extra_fields.get('kpr', '') if extra_fields else '',
        'payee': extra_fields.get('skr', '') if extra_fields else '',
        'reviewer': extra_fields.get('fhr', '') if extra_fields else '',
        'tax_amount': safe_float(extra_fields.get('amountSe') if extra_fields else None),
        'parse_method': parse_method,
        'parse_ok': 1 if has_structured_data(invoice_type, invoice_number, amount) else 0,
        'raw_text': raw_text_original[:5000] if raw_text_original else '',
        'thumbnail': '',
        'line_items': extra_fields.get('line_items', []) if extra_fields else [],
        'line_items_excel_rows': extra_fields.get('line_items_excel_rows', []) if extra_fields else [],
    }

    # ====== 自动入库 ======
    db_result = None
    if not skip_db_write:
        try:
            db_result = db_module.upsert_invoice(db_record)
            logger.info("发票自动入库: id=%s, is_new=%s", db_result.get('id'), db_result.get('is_new'))
        except Exception as e:
            logger.warning("发票自动入库失败: %s", e)
    # skip_db_write=True 时 db_result 保持 None，db_record 由调用方批量处理

    return {
        'file_format': file_format,
        'parse_method': parse_method,
        'invoice_type': invoice_type,
        'invoice_number': invoice_number,
        'amount': amount,
        'invoice_date': invoice_date,
        'raw_text': raw_text_original,
        'raw_text_original': raw_text_original,
        'raw_text_for_extract': raw_text_for_extract,
        'preview_image': preview_image,
        'safe_filename': safe_filename,
        'extra_fields': extra_fields,
        'bbox_data': bbox_data,
        'source_type': source_type,
        'file_hash': hash_sha256,
        'db_record': db_record,
        'db_result': db_result,
        'from_cache': from_cache,  # v10 新增：标记是否来自缓存
        'metrics': perf_summary if is_debug else None,
    }
