"""发票重复导入历史（Invoice Import History）

独立业务历史表，用于「防止重复报销」的风险提醒：
记录「这个发票号码曾经导入过 + 开票日期 + 首次/最近导入时间」，再次导入时做软提醒（不拦截）。

─────────────────────────────────────────────────────────────────────────
架构边界（冻结）：
  - Oplog          只负责恢复当前数据库状态（invoices.oplog 是 WAL，会被压缩清空）
  - InvoiceDocument 只负责当前导入实体（7 天生命周期）
  - InvoiceImportHistory 只负责「这个发票号码过去是否导入过」
三者生命周期不同，本模块的数据文件 **独立于** invoices / Oplog / 现有 7 天清理机制：
  - 绝不参与 db._compact_oplog（invoices.oplog 的清空）
  - 绝不参与 db.cleanup_expired_invoices（7 天清理）
本文件在导入成功（新建发票记录）后才追加，文件拖入即取消不会产生假记录。

数据模型（一个发票号码 = 一条聚合记录，非事件日志）：
  invoiceNumber    TEXT 唯一检测键（归一化后）
  invoiceDate      DATE 开票日期（决定 3 年生命周期；一旦首次记录则不可被后续导入覆盖）
  firstImportedAt  DATETIME 首次导入时间（不可覆盖）
  lastImportedAt   DATETIME 最近导入时间（每次导入更新）
  importCount      INT 累计导入次数（每次导入 +1）
  dateMismatchCount INT 同号码再次导入时开票日期不一致的次数（仅观测，不污染业务字段）

生命周期：按 invoiceDate + 3 年 < 今天 清理；边界明确（差 1 天也保留）。
"""

import atexit
import json
import logging
import os
import re
import time
from datetime import date, datetime, timedelta

from readerwriterlock import rwlock as _rwlock_mod

import time_utils

logger = logging.getLogger(__name__)

# 写盘节流：同一进程内 0.5s 内多次导入只落盘一次（批量导入场景摊薄开销）
_FLUSH_INTERVAL = 0.5

_rw = _rwlock_mod.RWLockFair()
_history_by_number = {}          # {normalized_number: record_dict}
_history_path = None            # 持久化 JSON 路径（懒加载时解析）
_dirty = False
_last_flush = 0.0


# ──────────────────────────────────────────────────────────────────────────
# 路径解析
# ──────────────────────────────────────────────────────────────────────────

def _resolve_path():
    env = os.environ.get('FAPIAOGO_DB_PATH')
    if env:
        base = env
    else:
        # 开发/兜底：相对于本文件向上两层的 database/ 目录
        base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'database')
    return os.path.join(base, 'invoice_import_history.json')


def configure(path=None):
    """设置持久化路径并（重新）加载。测试可传入临时目录。"""
    global _history_path
    _history_path = path or _resolve_path()
    _load()


def _get_path():
    return _history_path or _resolve_path()


# ──────────────────────────────────────────────────────────────────────────
# 归一化 / 日期工具
# ──────────────────────────────────────────────────────────────────────────

def normalize_invoice_number(raw):
    """发票号码检测键归一化：去首尾空白、折叠内部空白、转大写。空值返回 None。"""
    if raw is None:
        return None
    s = str(raw).strip()
    s = re.sub(r'\s+', '', s)
    if not s:
        return None
    return s.upper()


def _parse_date(s):
    """解析开票日期为 date；支持 YYYY-MM-DD / YYYY/MM/DD / YYYYMMDD。失败返回 None。"""
    if not s:
        return None
    s = str(s).strip()
    for fmt in ('%Y-%m-%d', '%Y/%m/%d', '%Y%m%d'):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _add_years(d, years):
    """日期加减年，正确处理 2/29（非闰年回退到 2/28）。"""
    try:
        return d.replace(year=d.year + years)
    except ValueError:
        return d.replace(year=d.year + years, month=2, day=28)


def _parse_datetime(s):
    """解析 ISO datetime（如 firstImportedAt）为 date，失败返回 None。"""
    if not s:
        return None
    try:
        return time_utils.from_isoformat(s).date()
    except Exception:  # noqa: BLE001
        return None


# ──────────────────────────────────────────────────────────────────────────
# 加载 / 持久化
# ──────────────────────────────────────────────────────────────────────────

def _load():
    global _history_by_number
    p = _get_path()
    try:
        if os.path.exists(p):
            with open(p, 'r', encoding='utf-8') as f:
                data = json.load(f)
            _history_by_number = data if isinstance(data, dict) else {}
        else:
            _history_by_number = {}
    except Exception as e:  # noqa: BLE001 - 损坏文件不应阻断启动
        logger.warning("[import_history] 加载失败，以空历史启动: %s", e)
        _history_by_number = {}


def _save_locked():
    """在调用方已持有写锁时，原子写盘。"""
    global _dirty, _last_flush
    p = _get_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(_history_by_number, f, ensure_ascii=False)
    os.replace(tmp, p)
    _dirty = False
    _last_flush = time.time()


def flush():
    """强制落盘（供调用方在批量导入结束后显式调用，保证耐久）。"""
    with _rw.gen_wlock():
        if _dirty:
            _save_locked()


atexit.register(flush)


# ──────────────────────────────────────────────────────────────────────────
# 核心 API
# ──────────────────────────────────────────────────────────────────────────

def record_import(number, invoice_date=None):
    """记录一次成功导入（仅在发票新建成功后调用）。

    规则（冻结）：
      - invoiceDate / firstImportedAt 一旦首次记录，**不可被后续导入覆盖**；
      - 后续导入只更新 lastImportedAt、importCount += 1；
      - 若后续导入的开票日期与历史不同，保留首次日期、累计 dateMismatchCount、记 warning
        （首版仅日志，不做 UI；保证数据不被污染）。
    """
    norm = normalize_invoice_number(number)
    if not norm:
        return  # 无号码不记录
    now_iso = time_utils.now().isoformat()
    parsed = _parse_date(invoice_date)
    date_iso = parsed.isoformat() if parsed else None

    with _rw.gen_wlock():
        rec = _history_by_number.get(norm)
        if rec is None:
            _history_by_number[norm] = {
                'invoiceDate': date_iso,
                'firstImportedAt': now_iso,
                'lastImportedAt': now_iso,
                'importCount': 1,
                'dateMismatchCount': 0,
            }
        else:
            # invoiceDate / firstImportedAt 不可变
            if date_iso and rec.get('invoiceDate') and date_iso != rec['invoiceDate']:
                rec['dateMismatchCount'] = rec.get('dateMismatchCount', 0) + 1
                logger.warning(
                    "[import_history] 发票号码 %s 再次导入时开票日期不一致: "
                    "历史=%s 本次=%s，保留首次日期，已记录 warning（可能 OCR 错误或异常票种）",
                    norm, rec['invoiceDate'], date_iso,
                )
            rec['lastImportedAt'] = now_iso
            rec['importCount'] = rec.get('importCount', 0) + 1

        # 节流落盘：0.5s 内只写一次
        if time.time() - _last_flush >= _FLUSH_INTERVAL:
            _save_locked()
        else:
            global _dirty
            _dirty = True


def get_import_history(number):
    """返回 {invoiceDate, firstImportedAt, lastImportedAt, importCount, dateMismatchCount}
    或 None（未导入过）。"""
    norm = normalize_invoice_number(number)
    if not norm:
        return None
    with _rw.gen_rlock():
        rec = _history_by_number.get(norm)
        return dict(rec) if rec else None


def has_imported(number):
    norm = normalize_invoice_number(number)
    if not norm:
        return False
    with _rw.gen_rlock():
        return norm in _history_by_number


def cleanup_expired(today=None):
    """按开票日期 + 3 年清理：DELETE WHERE invoiceDate + 3y < today。

    边界：差 1 天也保留。invoiceDate 缺失时回退到 firstImportedAt 作 cutoff 并告警。
    返回删除条数。独立函数，与 db.cleanup_expired_invoices（7 天）互不影响。
    """
    today = today or datetime.now().date()
    removed = 0
    with _rw.gen_wlock():
        to_del = []
        for num, rec in _history_by_number.items():
            eff = _parse_date(rec.get('invoiceDate')) or _parse_datetime(rec.get('firstImportedAt'))
            if eff is None:
                logger.warning("[import_history] 记录 %s 无可用日期，跳过清理（保留）", num)
                continue
            if _add_years(eff, 3) < today:
                to_del.append(num)
        for num in to_del:
            del _history_by_number[num]
            removed += 1
        if removed:
            _save_locked()
    if removed:
        logger.info("[import_history] 3年清理完成，删除 %d 条（基于开票日期）", removed)
    return removed


# 模块导入即尝试加载（路径未配置时按默认解析；文件不存在则空历史）
_load()
