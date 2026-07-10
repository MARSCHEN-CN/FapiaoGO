"""JSON 数据存储模块（oplog + 定期压缩）

本模块提供完整的发票 CRUD 和数据管理能力，替代原 Electron 主进程的
datastore.js，作为唯一的数据存储层。

数据存储路径：
  - 发票快照：{数据目录}/invoices.json（全量 + 定期压缩）
  - 操作日志：{数据目录}/invoices.oplog（增量，append-only）
  - 配置数据：{数据目录}/config.json

写策略：单字段更新（如 PUT /api/db/invoice/<id>）仅追加 ~200B 的 oplog 条目
到 invoices.oplog，不再序列化全量 invoices.json。当 oplog 达到阈值时自动触发
压缩（全量快照 + 清空 oplog）。崩溃恢复：启动时加载 invoices.json 后回放
oplog，保证数据不丢失。

路径解析优先级：
  1. 环境变量 MARSPRINT_DB_PATH（兼容 Electron 注入）
  2. 开发模式兜底：相对于本文件向上两层的 database/ 目录
  3. 用户主目录 ~/.marsprint/（最终兜底）

并发控制：
  - 使用 threading.Lock 保证线程安全
  - 使用原子写入（写临时文件再 rename）防止数据损坏
  - 懒加载模式减少启动时间
  - 返回数据时做深拷贝，防止外部修改内部状态
"""

import copy
import json
import os
import threading
import uuid
import shutil
from threading import Timer as _Timer
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from time_utils import now, now_ms, now_timestamp, from_isoformat, to_timestamp
from pathlib import Path
from typing import Optional, Dict, List, Any
import threading
import logging

logger = logging.getLogger(__name__)

# ============================
# 数据存储路径解析
# ============================

INVOICE_RETENTION_DAYS = 7
ALLOWED_UPDATE_FIELDS = [
    'category', 'tags', 'memo', 'type', 'amount', 'date',
    'buyer', 'seller', 'buyer_tax', 'seller_tax', 'note',
    'issuer', 'payee', 'reviewer', 'tax_amount', 'file_name',
]


def _resolve_db_dir() -> str:
    """按优先级解析数据库目录"""
    env_path = os.environ.get('MARSPRINT_DB_PATH', '').strip()
    if env_path:
        if os.path.isfile(env_path):
            return os.path.dirname(env_path)
        if os.path.isdir(env_path):
            return env_path
        parent = os.path.dirname(env_path)
        if parent:
            return parent

    dev_path = Path(__file__).resolve().parent.parent / 'database'
    if dev_path.exists():
        return str(dev_path)

    return str(Path.home() / '.marsprint')


DB_DIR = _resolve_db_dir()
os.makedirs(DB_DIR, exist_ok=True)

INVOICES_PATH = os.path.join(DB_DIR, 'invoices.json')
OPLOG_PATH = os.path.join(DB_DIR, 'invoices.oplog')
CONFIG_PATH = os.path.join(DB_DIR, 'config.json')

# oplog 触发压缩的阈值（条目数）
COMPACT_THRESHOLD = 50
_oplog_count = 0

# oplog 写入缓冲（批量优化：延迟 flush 减少 I/O）
_oplog_buffer: List[str] = []
_oplog_flush_timer: Optional[_Timer] = None
_OPLOG_FLUSH_DELAY = 0.5   # 秒：缓冲延迟
_OPLOG_FLUSH_THRESHOLD = 20  # 条：立即 flush 阈值

# 压缩标记文件（两阶段提交，防止崩溃后操作双重应用）
COMPACT_MARKER = os.path.join(DB_DIR, '.compact_writing')  # 阶段1: 准备写快照
COMPACT_READY = os.path.join(DB_DIR, '.compact_done')      # 阶段2: 快照已提交

# 向后兼容
DB_PATH = INVOICES_PATH

# 搜索缓存（LRU 简化版）：减少重复关键词搜索的全表遍历
# 每次写操作（upsert/delete/update）时自动失效
_SEARCH_CACHE: Dict[str, List[Dict]] = {}  # cache_key → filtered results
_SEARCH_CACHE_MAX = 32
_SEARCH_CACHE_ORDER: List[str] = []  # 用于 LRU 淘汰

logger.info("数据目录: %s", DB_DIR)
logger.info("发票数据: %s", INVOICES_PATH)
logger.info("配置数据: %s", CONFIG_PATH)

# ============================
# 内存缓存 + 读写锁
# ============================

_invoices: List[Dict] = []
_config: Dict = {}

# 内存索引：用于 O(1) 查找，避免全表扫描
_invoice_index_by_id: Dict[str, int] = {}      # id → list index
_invoice_index_by_hash: Dict[str, int] = {}    # hash_sha256 → list index
_invoice_index_by_filename: Dict[str, int] = {}  # file_name (lowercase) → list index
_invoice_index_by_number: Dict[str, List[int]] = {}  # number → [list_index, ...]（一对多）

# 分离读写锁：读操作使用共享锁，写操作使用排他锁
# 注意：threading 模块没有 RLock 的读写锁，使用普通锁保证简单性和安全性
_lock = threading.Lock()
_loaded = False


# ============================
# 持久化（原子写入）
# ============================


SCHEMA_VERSION = 2  # 发票快照结构版本；未来再次迁移时递增，便于识别旧格式


def _atomic_write(file_path: str, data: Any) -> None:
    """原子写入 JSON 文件（先写临时文件再 rename，防止数据损坏）"""
    temp_path = file_path + '.tmp'
    try:
        with open(temp_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        os.replace(temp_path, file_path)
    except Exception:
        if os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
            except OSError:
                pass
        raise


def _atomic_write_text(file_path: str, text: str) -> None:
    """原子写入文本文件（先写临时文件再 os.replace），用于 oplog 等行格式文件。"""
    temp_path = file_path + '.tmp'
    try:
        with open(temp_path, 'w', encoding='utf-8') as f:
            f.write(text)
        os.replace(temp_path, file_path)
    except Exception:
        if os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
            except OSError:
                pass
        raise


def _backup_before_migration() -> None:
    """迁移前备份 invoices.json / oplog 原文件（仅首迁时创建 .bak，幂等）。

    便于老数据库升级异常时手动回滚到迁移前状态。
    """
    for p in (INVOICES_PATH, OPLOG_PATH):
        bak = p + '.bak'
        if os.path.exists(p) and not os.path.exists(bak):
            try:
                shutil.copy2(p, bak)
            except IOError as e:
                logger.warning("迁移备份 %s 失败: %s", p, e)


def _write_snapshot(invoices: List[Dict]) -> None:
    """原子写入发票快照，统一带 schemaVersion 信封（SCHEMA_VERSION）。

    所有写发票快照的路径（_save_invoices / _compact_oplog / _migrate_legacy_ids）
    都必须经过此函数，未来递增 SCHEMA_VERSION 时只需改一处，避免漏写信封。
    """
    _atomic_write(INVOICES_PATH, {"schemaVersion": SCHEMA_VERSION, "invoices": invoices})


def _save_invoices() -> None:
    """持久化发票数据到磁盘（调用方须持有 _lock）；写入带 schemaVersion 信封"""
    _write_snapshot(_invoices)


def _append_oplog(op_type: str, invoice_id: str, data: dict = None) -> None:
    """追加一条操作日志到缓冲区（调用方须持有 _lock，且数据已加载）

    缓冲策略：累积到 _oplog_buffer，延迟 0.5s 或达 20 条时批量写入磁盘。
    相比逐条写入，批量场景下 I/O 次数减少 ~N 倍。

    注意：调用方必须在调用前确保 _ensure_loaded() 已完成，
    因为所有调用路径（CRUD 函数）都在函数开头调用了 _ensure_loaded()，
    此处不再重复调用以避免不必要的 _loaded 检查开销和潜在的锁嵌套风险。
    """
    global _oplog_flush_timer
    entry = json.dumps({
        "op": op_type, "id": invoice_id, "ts": now().isoformat(),
        "data": data,
    }, ensure_ascii=False, separators=(",", ":"))
    _oplog_buffer.append(entry)

    # 达到阈值立即 flush
    if len(_oplog_buffer) >= _OPLOG_FLUSH_THRESHOLD:
        _flush_oplog_buffer_locked()
        return

    # 否则启动延迟 flush（取消之前的定时器）
    if _oplog_flush_timer is not None:
        _oplog_flush_timer.cancel()
    _oplog_flush_timer = _Timer(_OPLOG_FLUSH_DELAY, _flush_oplog_buffer)
    _oplog_flush_timer.daemon = True
    _oplog_flush_timer.start()


def _flush_oplog_buffer_locked() -> None:
    """将缓冲区批量写入 oplog 文件（调用方须持有 _lock）"""
    global _oplog_count, _oplog_flush_timer
    if not _oplog_buffer:
        return
    try:
        with open(OPLOG_PATH, 'a', encoding='utf-8') as f:
            f.write('\n'.join(_oplog_buffer) + '\n')
        _oplog_count += len(_oplog_buffer)
    except IOError:
        logger.warning("oplog 批量写入失败: %s", OPLOG_PATH)
    _oplog_buffer.clear()
    _oplog_flush_timer = None


def _flush_oplog_buffer() -> None:
    """Timer 回调：获取锁后 flush 缓冲区"""
    with _lock:
        _flush_oplog_buffer_locked()


def flush_oplog_buffer() -> None:
    """公开接口：立即将 oplog 缓冲区刷盘（批量操作后可主动调用）"""
    with _lock:
        _flush_oplog_buffer_locked()


def _rebuild_indexes() -> None:
    """重建所有内存索引（通常在批量操作后调用）"""
    global _invoice_index_by_id, _invoice_index_by_hash, _invoice_index_by_filename, _invoice_index_by_number
    _invoice_index_by_id.clear()
    _invoice_index_by_hash.clear()
    _invoice_index_by_filename.clear()
    _invoice_index_by_number.clear()
    for i, inv in enumerate(_invoices):
        if inv.get("deleted_at"):
            continue
        if inv.get("id"):
            _invoice_index_by_id[inv["id"]] = i
        if inv.get("hash_sha256"):
            _invoice_index_by_hash[inv["hash_sha256"]] = i
        if inv.get("file_name"):
            _invoice_index_by_filename[str(inv["file_name"]).strip().lower()] = i
        if inv.get("number"):
            num = str(inv["number"])
            _invoice_index_by_number.setdefault(num, []).append(i)


def _validate_invoice_ids() -> None:
    """启动时一致性检查：确保内存中所有 invoice id 均为 str。

    若发现非 str（如某处又写了 int），仅告警并就地归一化，避免在运行期
    才暴露 int/str 混用导致的 _invoice_index_by_id 查找失败。
    """
    for inv in _invoices:
        if not isinstance(inv, dict):
            continue
        inv_id = inv.get('id')
        if inv_id is not None and not isinstance(inv_id, str):
            fname = inv.get('file_name') or '<unknown>'
            logger.error(
                "启动一致性检查失败: 发票 id 应为 str，实为 %s（invoice=%r, id=%r）",
                type(inv_id).__name__, fname, inv_id,
            )
            inv['id'] = str(inv_id)   # 安全网：就地归一化，避免运行期 _invoice_index_by_id 查找失败


def _to_hex_id(raw: object) -> Optional[str]:
    """将遗留 id（int 或十进制字符串）转换为 uuid hex；已是合法 uuid 则返回 None（无需迁移）。

    幂等：传入已为 hex 的 id 时返回 None，调用方据此判断是否需要落盘。
    """
    if raw is None:
        return None
    if isinstance(raw, int):
        try:
            return uuid.UUID(int=raw).hex
        except (ValueError, OverflowError):
            return None
    if isinstance(raw, str):
        # 已是合法 uuid（hex 形式）则跳过迁移
        try:
            uuid.UUID(raw)
            return None
        except (ValueError, AttributeError):
            pass
        # 否则尝试按十进制整数解释，再转 hex
        try:
            return uuid.UUID(int=int(raw)).hex
        except (ValueError, OverflowError):
            return None
    return None


def _migrate_legacy_ids() -> None:
    """将历史 int / 十进制字符串 id 物理升级为 uuid hex。

    在 _load_invoices 中、索引重建前调用：先把内存中的 id 统一为 hex，
    再同步重写 oplog 文件中的 id（含 data.id），最后仅在确有变更时备份原文件
    并以原子方式重写快照/oplog。幂等：纯 hex 数据库不会触发任何落盘。
    """
    snapshot_changed = False
    oplog_changed = False

    # 1) 内存归一：int / 十进制字符串 -> hex
    for inv in _invoices:
        if not isinstance(inv, dict):
            continue
        old = inv.get("id")
        new = _to_hex_id(old)
        if new is not None and new != old:
            inv["id"] = new
            snapshot_changed = True

    # 2) oplog 文件中的 id 同步升级（含 data.id），先构建新内容再原子写回
    oplog_lines = None
    if os.path.exists(OPLOG_PATH):
        try:
            with open(OPLOG_PATH, "r", encoding="utf-8") as f:
                lines = f.readlines()
            out_lines = []
            for line in lines:
                s = line.strip()
                if not s:
                    out_lines.append(s)
                    continue
                try:
                    entry = json.loads(s)
                except (json.JSONDecodeError, ValueError):
                    out_lines.append(s)
                    continue
                eid = entry.get("id")
                h = _to_hex_id(eid)
                if h is not None and h != eid:
                    entry["id"] = h
                    data = entry.get("data")
                    if isinstance(data, dict) and data.get("id") is not None:
                        hd = _to_hex_id(data["id"])
                        if hd is not None and hd != data["id"]:
                            data["id"] = hd
                    oplog_changed = True
                out_lines.append(json.dumps(entry, ensure_ascii=False, separators=(",", ":")))
            oplog_lines = out_lines
        except IOError as e:
            logger.warning("读取 oplog 失败: %s", e)

    # 3) 仅在确有变更时备份原文件 + 原子重写（快照带 schemaVersion 信封）
    if snapshot_changed or oplog_changed:
        _backup_before_migration()
        if snapshot_changed:
            try:
                _write_snapshot(_invoices)
            except IOError as e:
                logger.warning("重写快照 id 失败: %s", e)
        if oplog_changed and oplog_lines is not None:
            try:
                _atomic_write_text(OPLOG_PATH, "\n".join(oplog_lines) + "\n")
            except IOError as e:
                logger.warning("重写 oplog id 失败: %s", e)
        # 迁移摘要日志：便于排查「首次启动打不开」是否由迁移引起
        oplog_n = len(oplog_lines) if oplog_lines is not None else 0
        logger.info(
            "发票数据库迁移完成: 升级至 schemaVersion=%s, 快照 %d 条, oplog %d 条, 备份=%s",
            SCHEMA_VERSION, len(_invoices), oplog_n, INVOICES_PATH + '.bak',
        )


def _replay_oplog() -> None:
    """回放 oplog 到内存中的 _invoices（启动时调用，调用方须持有 _lock）

    容错机制：单行损坏不影响后续回放，损坏行跳过并记录警告，
    避免因一次磁盘故障导致整个恢复流程中止。

    前置条件：调用方（_load_invoices）须在 _load_snapshot 之后、本函数之前
    已调用 _rebuild_indexes()，使回放过程中的 upsert/update/soft_delete/
    restore 查找基于「本次加载的快照」而非历史残留索引——否则在进程内二次
    加载（如 _load_data）时，旧索引的 idx 会越界到已被 _load_snapshot 重置的
    _invoices 上，触发 IndexError。本函数不再隐式重建索引，生命周期由
    _load_invoices 显式管理（Option A）。
    """
    global _oplog_count
    if not os.path.exists(OPLOG_PATH):
        return
    corrupted_lines = 0
    replayed_count = 0
    try:
        with open(OPLOG_PATH, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                # 单行容错：损坏行跳过，不影响后续
                try:
                    entry = json.loads(line)
                except (json.JSONDecodeError, ValueError) as e:
                    corrupted_lines += 1
                    logger.warning("oplog 损坏行跳过 (line ~%d): %s", _oplog_count + corrupted_lines + 1, e)
                    continue

                op = entry.get("op")
                entry_id = str(entry.get("id"))  # 归一化：历史 oplog 中 id 为 int
                data = entry.get("data") or {}

                if op == "upsert":
                    hash_val = data.get("hash_sha256")
                    if hash_val and hash_val in _invoice_index_by_hash:
                        idx = _invoice_index_by_hash[hash_val]
                        _invoices[idx].update({
                            k: v for k, v in data.items()
                            if k not in ("id", "created_at", "deleted_at")
                        })
                    else:
                        # 归一化：历史 oplog 中 data["id"] 为 int
                        if not isinstance(data.get("id"), str):
                            data["id"] = str(data.get("id"))
                        _invoices.append(data)
                        # 维护索引，使同批后续 oplog 操作能定位刚追加的记录
                        _idx = len(_invoices) - 1
                        if data.get("id"):
                            _invoice_index_by_id[data["id"]] = _idx
                        if data.get("hash_sha256"):
                            _invoice_index_by_hash[data["hash_sha256"]] = _idx
                        if data.get("file_name"):
                            _invoice_index_by_filename[str(data["file_name"]).strip().lower()] = _idx
                        if data.get("number"):
                            _invoice_index_by_number.setdefault(str(data["number"]), []).append(_idx)

                elif op == "update":
                    if entry_id in _invoice_index_by_id:
                        _invoices[_invoice_index_by_id[entry_id]].update(data)

                elif op == "soft_delete":
                    if entry_id in _invoice_index_by_id:
                        _invoices[_invoice_index_by_id[entry_id]]["deleted_at"] = entry.get("ts")

                elif op == "hard_delete":
                    if entry_id in _invoice_index_by_id:
                        idx = _invoice_index_by_id.pop(entry_id)
                        _invoices.pop(idx)

                elif op == "restore":
                    if entry_id in _invoice_index_by_id:
                        _invoices[_invoice_index_by_id[entry_id]]["deleted_at"] = None

                replayed_count += 1

        _oplog_count = replayed_count
        if corrupted_lines:
            logger.warning("oplog 回放完成: %d 条成功, %d 条损坏已跳过", replayed_count, corrupted_lines)
        else:
            logger.info("oplog 回放完成: %d 条", replayed_count)

    except Exception as e:
        logger.exception("oplog 回放失败: %s", e)


def _compact_oplog() -> None:
    """压缩 oplog：两阶段提交（崩溃安全）

    流程：
      1. flush 缓冲区到磁盘 oplog
      2. 写入 .compact_writing 标记 → 阶段1："准备写快照"
      3. 原子写入全量快照 invoices.json
      4. rename .compact_writing → .compact_done  → 阶段2："快照已提交"
      5. 清空 oplog
      6. 删除 .compact_done 标记

    崩溃恢复（在 _load_invoices 中处理）：
      - .compact_done 存在 → 快照已提交，不重复回放 oplog
      - 仅 .compact_writing 存在 → 快照未提交，正常回放
      - 两者都不存在 → 正常回放
    """
    global _oplog_count
    _flush_oplog_buffer_locked()  # 确保缓冲区内容写入磁盘

    # 阶段1：标记压缩开始
    _touch_marker(COMPACT_MARKER)

    # 写入全量快照（原子操作：写临时文件 → rename，带 schemaVersion 信封）
    _write_snapshot(_invoices)

    # 阶段2：标记快照已提交（原子 rename，确保阶段1→阶段2的切换是原子的）
    try:
        os.replace(COMPACT_MARKER, COMPACT_READY)
    except OSError:
        # 如果 rename 失败（如磁盘满），删除旧标记，兜底到可恢复状态
        _remove_marker(COMPACT_MARKER)
        _remove_marker(COMPACT_READY)
        logger.error("compact 标记 rename 失败，回退到未标记状态")
        return

    # 清空 oplog
    try:
        open(OPLOG_PATH, 'w').close()
    except IOError:
        pass

    # 清理标记
    _remove_marker(COMPACT_READY)
    _oplog_count = 0


def _touch_marker(path: str) -> None:
    """创建标记文件并确保刷盘"""
    try:
        with open(path, 'w') as f:
            f.write('')
            f.flush()
            os.fsync(f.fileno())
    except OSError:
        pass


def _remove_marker(path: str) -> None:
    """安全删除标记文件"""
    try:
        if os.path.exists(path):
            os.unlink(path)
    except OSError:
        pass


# ─── 搜索缓存 ────────────────────────────────────────────
# 减少重复关键词搜索的全表遍历，每次写操作后自动失效


def _invalidate_search_cache() -> None:
    """失效搜索缓存（每次写操作后调用）"""
    _SEARCH_CACHE.clear()
    _SEARCH_CACHE_ORDER.clear()


def _search_cache_get(key: str) -> Optional[List[Dict]]:
    """获取搜索缓存，命中时更新 LRU 顺序"""
    result = _SEARCH_CACHE.get(key)
    if result is not None:
        try:
            _SEARCH_CACHE_ORDER.remove(key)
            _SEARCH_CACHE_ORDER.append(key)
        except ValueError:
            pass
    return result


def _search_cache_set(key: str, results: List[Dict]) -> None:
    """设置搜索缓存，超出上限时淘汰最旧条目"""
    if key in _SEARCH_CACHE:
        try:
            _SEARCH_CACHE_ORDER.remove(key)
        except ValueError:
            pass
    _SEARCH_CACHE[key] = results
    _SEARCH_CACHE_ORDER.append(key)
    while len(_SEARCH_CACHE) > _SEARCH_CACHE_MAX:
        oldest = _SEARCH_CACHE_ORDER.pop(0)
        _SEARCH_CACHE.pop(oldest, None)


def _build_search_cache_key(keyword: str, type_filter: str, date_from: str, date_to: str,
                              order_by: str, order_dir: str) -> str:
    """构建搜索缓存键"""
    return f"{keyword}|{type_filter}|{date_from}|{date_to}|{order_by}|{order_dir}"


def _maybe_compact() -> None:
    """oplog 达到阈值时触发压缩（调用方须持有 _lock）"""
    if _oplog_count >= COMPACT_THRESHOLD:
        _compact_oplog()


def _save_config() -> None:
    """持久化配置数据到磁盘（调用方须持有 _lock）"""
    _atomic_write(CONFIG_PATH, _config)


# ============================
# 数据加载
# ============================


def _load_invoices() -> None:
    """从 invoices.json + oplog 恢复发票数据到内存

    流程固定为三段，无论是否存在快照 / oplog / compact 标记，
    最后一步 _rebuild_indexes() 永远执行一次 —— 避免某个提前 return
    绕过后索引为空，导致全量查找 miss（历史 COMPACT_READY 分支即有此缺口）。

    崩溃恢复：
    1. _handle_compact_markers: 清理 compact 标记文件（必要时清空 oplog）
    2. _load_snapshot:          加载 invoices.json 快照（并归一化 id 为 str）
    3. _rebuild_indexes:        基于快照建索引，供 _replay_oplog 查找（显式，Option A）
    4. _replay_oplog:           回放 oplog 恢复增量（并归一化 id 为 str）
    5. _migrate_legacy_ids:     历史 int/十进制 id -> uuid hex（幂等，会改变 id 字符串）
    6. _rebuild_indexes:        以规范后的 hex id 重建索引（无条件）
    7. _validate_invoice_ids:   启动时一致性检查
    """
    _handle_compact_markers()
    _load_snapshot()
    _rebuild_indexes()      # 基于刚加载的快照建索引，供 _replay_oplog 查找（Option A：显式生命周期）
    _replay_oplog()         # 内部不再隐式 rebuild，依赖上方索引
    _migrate_legacy_ids()   # 历史 int/十进制 id -> uuid hex（幂等，会改变 id 字符串）
    _rebuild_indexes()      # 最终以规范后的 hex id 重建索引
    _validate_invoice_ids()


def _handle_compact_markers() -> None:
    """处理 compact 两阶段提交标记，清理残余状态。

    - COMPACT_READY 存在：快照已包含 oplog 操作，清空 oplog 文件并移除标记。
    - COMPACT_MARKER 存在：上次压缩异常中断，快照可能不完整，移除标记后
      交由 _replay_oplog() 正常回放补偿。
    两种情况都不影响后续「_replay_oplog + _rebuild_indexes 永远执行」的流程。
    """
    if os.path.exists(COMPACT_READY):
        logger.info("检测到 compact_done 标记，oplog 操作已包含在快照中，清空 oplog")
        try:
            open(OPLOG_PATH, 'w').close()
        except IOError:
            pass
        _remove_marker(COMPACT_READY)
        _remove_marker(COMPACT_MARKER)
    elif os.path.exists(COMPACT_MARKER):
        logger.warning("检测到 compact_writing 标记（上次压缩异常中断），"
                       "快照可能不完整，回退到正常 oplog 回放")
        _remove_marker(COMPACT_MARKER)


def _load_snapshot() -> None:
    """加载 invoices.json 快照到内存，并将 id 归一化为 str（防 int/str 混用）"""
    global _invoices
    if os.path.exists(INVOICES_PATH):
        try:
            with open(INVOICES_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if isinstance(data, list):
                    # 旧格式（无 schemaVersion 信封）：视为 legacy 文件，兼容加载
                    _invoices = data
                elif isinstance(data, dict):
                    sv = data.get("schemaVersion")
                    if sv is not None and sv > SCHEMA_VERSION:
                        raise RuntimeError(
                            f"发票数据库 schemaVersion={sv} 高于本程序支持的版本 "
                            f"{SCHEMA_VERSION}；请用更新版本的程序打开，或先迁移该数据库"
                            f"（文件: {INVOICES_PATH}）"
                        )
                    _invoices = data.get('invoices', [])
                else:
                    _invoices = []
        except (json.JSONDecodeError, IOError) as e:
            logger.warning("加载发票数据失败 (%s): %s", INVOICES_PATH, e)
            _invoices = []
    else:
        _invoices = []
    # 归一化：历史数据 id 为 int（uuid4().int），统一转为 str，
    # 避免运行期 int/str 混用导致 _invoice_index_by_id 查找失败（123456 != "123456"）。
    for inv in _invoices:
        if isinstance(inv, dict) and 'id' in inv and not isinstance(inv['id'], str):
            inv['id'] = str(inv['id'])


def _load_config() -> None:
    """从 config.json 加载配置数据到内存"""
    global _config
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                _config = json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            logger.warning("加载配置数据失败 (%s): %s", CONFIG_PATH, e)
            _config = {}
    else:
        _config = {}


def _ensure_loaded() -> None:
    """确保数据已加载（懒加载）"""
    global _loaded
    if not _loaded:
        with _lock:
            if not _loaded:
                _load_invoices()
                _load_config()
                _loaded = True


def _load_data() -> None:
    """加载所有数据（线程安全，兼容旧接口）"""
    with _lock:
        _load_invoices()
        _load_config()


def _connect() -> None:
    """兼容旧接口"""
    _ensure_loaded()


# ============================
# 过期清理
# ============================


def cleanup_expired_invoices(days: int = INVOICE_RETENTION_DAYS) -> int:
    """清理过期发票记录，返回清理数量"""
    _ensure_loaded()
    now_ts = now_timestamp()
    retention_seconds = days * 86400

    with _lock:
        original_count = len(_invoices)
        kept = []
        for inv in _invoices:
            try:
                created = inv.get('created_at', '')
                if created:
                    # 解析 ISO 8601 时间戳（使用北京时间工具）
                    dt = from_isoformat(created)
                    age = now_ts - to_timestamp(dt)
                    if age > retention_seconds:
                        continue  # 过期，跳过
            except (ValueError, TypeError):
                pass
            kept.append(inv)

        deleted_count = original_count - len(kept)
        if deleted_count > 0:
            _invoices.clear()
            _invoices.extend(kept)
            _rebuild_indexes()  # 重建索引
            _save_invoices()
            logger.info("清理了 %d 条过期发票记录", deleted_count)

    return deleted_count


# ═══════════════════════════════════════════════════════════
#  发票 CRUD
# ═══════════════════════════════════════════════════════════


def upsert_invoice(row: Dict) -> Dict:
    """插入或更新发票记录（按 hash_sha256 去重）

    当 hash 命中已有记录时，用新数据覆盖解析字段（保留 id/created_at 等元数据），
    防止首次解析的错误值被永久锁定。

    Returns:
        {'id': int, 'is_new': bool}
    """
    _ensure_loaded()
    now_str = now().isoformat()

    # 不可被覆盖的内部元数据字段
    _PRESERVED_KEYS = {'id', 'created_at', 'deleted_at', 'is_duplicate', 'duplicate_of'}

    with _lock:
        # 按 hash 去重（使用索引）
        hash_val = row.get('hash_sha256')
        if hash_val and hash_val in _invoice_index_by_hash:
            idx = _invoice_index_by_hash[hash_val]
            inv = _invoices[idx]
            if not inv.get('deleted_at'):
                # 用新解析数据覆盖旧记录（保留内部元数据）
                for key, value in row.items():
                    if key not in _PRESERVED_KEYS:
                        inv[key] = value
                inv['updated_at'] = now_str
                _append_oplog("update", inv['id'], {k: v for k, v in row.items() if k not in _PRESERVED_KEYS})
                _maybe_compact()
                _invalidate_search_cache()
                return {'id': inv['id'], 'is_new': False}

        # 新建记录
        new_id = uuid.uuid4().hex
        new_invoice = {
            **row,
            'id': new_id,
            'created_at': now_str,
            'updated_at': now_str,
            'deleted_at': None,
            'is_duplicate': 0,
            'duplicate_of': None,
        }
        _invoices.append(new_invoice)
        # 更新索引
        idx = len(_invoices) - 1
        if new_invoice.get('id'):
            _invoice_index_by_id[new_invoice['id']] = idx
        if new_invoice.get('hash_sha256'):
            _invoice_index_by_hash[new_invoice['hash_sha256']] = idx
        if new_invoice.get('file_name'):
            _invoice_index_by_filename[str(new_invoice['file_name']).strip().lower()] = idx
        if new_invoice.get('number'):
            _invoice_index_by_number.setdefault(str(new_invoice['number']), []).append(idx)
        _append_oplog("upsert", new_id, new_invoice)
        _maybe_compact()
        _invalidate_search_cache()
        return {'id': new_id, 'is_new': True}


def batch_upsert_invoices(rows: List[Dict]) -> List[Dict]:
    """批量插入或更新发票记录（单次锁、批量 oplog、单次压缩检查）

    与逐条调用 upsert_invoice() 相比：
    - 锁获取：N 次 → 1 次
    - oplog I/O：N 次 → 1 次批量写入
    - 压缩检查：N 次 → 1 次

    Args:
        rows: 发票记录列表，每条按 hash_sha256 去重

    Returns:
        [{'id': int, 'is_new': bool}, ...]（顺序与 rows 对应）
    """
    if not rows:
        return []

    _ensure_loaded()
    now_str = now().isoformat()
    _PRESERVED_KEYS = {'id', 'created_at', 'deleted_at', 'is_duplicate', 'duplicate_of'}
    results = []

    with _lock:
        for row in rows:
            hash_val = row.get('hash_sha256')
            if hash_val and hash_val in _invoice_index_by_hash:
                idx = _invoice_index_by_hash[hash_val]
                inv = _invoices[idx]
                if not inv.get('deleted_at'):
                    for key, value in row.items():
                        if key not in _PRESERVED_KEYS:
                            inv[key] = value
                    inv['updated_at'] = now_str
                    _append_oplog("update", inv['id'],
                                  {k: v for k, v in row.items() if k not in _PRESERVED_KEYS})
                    results.append({'id': inv['id'], 'is_new': False})
                    continue

            new_id = uuid.uuid4().hex
            new_invoice = {
                **row,
                'id': new_id,
                'created_at': now_str,
                'updated_at': now_str,
                'deleted_at': None,
                'is_duplicate': 0,
                'duplicate_of': None,
            }
            _invoices.append(new_invoice)
            idx = len(_invoices) - 1
            if new_invoice.get('id'):
                _invoice_index_by_id[new_invoice['id']] = idx
            if new_invoice.get('hash_sha256'):
                _invoice_index_by_hash[new_invoice['hash_sha256']] = idx
            if new_invoice.get('file_name'):
                _invoice_index_by_filename[str(new_invoice['file_name']).strip().lower()] = idx
            if new_invoice.get('number'):
                _invoice_index_by_number.setdefault(str(new_invoice['number']), []).append(idx)
            _append_oplog("upsert", new_id, new_invoice)
            results.append({'id': new_id, 'is_new': True})

        # 批量操作后主动 flush + 单次压缩检查
        _flush_oplog_buffer_locked()
        _maybe_compact()
        _invalidate_search_cache()

    new_count = sum(1 for r in results if r['is_new'])
    logger.info("批量入库完成: %d 条（新增 %d，更新 %d）",
                len(results), new_count, len(results) - new_count)
    return results


def get_invoice(invoice_id: str) -> Optional[Dict]:
    """按 ID 查询单条发票记录"""
    _ensure_loaded()
    idx = _invoice_index_by_id.get(invoice_id)
    if idx is None:
        return None
    return _invoices[idx].copy()


def soft_delete_invoice(invoice_id: str) -> Optional[Dict]:
    """软删除发票"""
    _ensure_loaded()
    now_str = now().isoformat()
    with _lock:
        if invoice_id in _invoice_index_by_id:
            idx = _invoice_index_by_id[invoice_id]
            _invoices[idx]['deleted_at'] = now_str
            _invoices[idx]['updated_at'] = now_str
            _append_oplog("soft_delete", invoice_id)
            _maybe_compact()
            _invalidate_search_cache()
            return {'ok': True}
    return None


def hard_delete_invoice(invoice_id: str) -> Optional[Dict]:
    """硬删除发票（从数组中移除）"""
    _ensure_loaded()
    with _lock:
        if invoice_id in _invoice_index_by_id:
            idx = _invoice_index_by_id.pop(invoice_id)
            inv = _invoices[idx]
            # 从 number 索引中移除
            num = inv.get('number')
            if num:
                num_key = str(num)
                if num_key in _invoice_index_by_number:
                    try:
                        _invoice_index_by_number[num_key].remove(idx)
                        if not _invoice_index_by_number[num_key]:
                            del _invoice_index_by_number[num_key]
                    except ValueError:
                        pass
            _invoices.pop(idx)
            _append_oplog("hard_delete", invoice_id)
            _maybe_compact()
            return {'ok': True}
    return None


def restore_invoice(invoice_id: str) -> Optional[Dict]:
    """恢复软删除的发票"""
    _ensure_loaded()
    now_str = now().isoformat()
    with _lock:
        if invoice_id in _invoice_index_by_id:
            idx = _invoice_index_by_id[invoice_id]
            _invoices[idx]['deleted_at'] = None
            _invoices[idx]['updated_at'] = now_str
            _append_oplog("restore", invoice_id)
            _maybe_compact()
            return {'ok': True}
    return None


def update_invoice_fields(invoice_id: str, fields: Dict) -> Optional[Dict]:
    """更新发票的指定字段"""
    _ensure_loaded()
    now_str = now().isoformat()
    with _lock:
        if invoice_id in _invoice_index_by_id:
            idx = _invoice_index_by_id[invoice_id]
            inv = _invoices[idx]
            if not inv.get('deleted_at'):
                updated = {}
                for key, value in fields.items():
                    if key in ALLOWED_UPDATE_FIELDS:
                        inv[key] = value
                        updated[key] = value
                inv['updated_at'] = now_str
                _append_oplog("update", invoice_id, updated)
                # 如果更新了 hash 或 filename，需要重建索引
                if 'hash_sha256' in fields or 'file_name' in fields:
                    _rebuild_indexes()
                _maybe_compact()
                return {'ok': True}
    return None


# ═══════════════════════════════════════════════════════════
#  查询 & 搜索
# ═══════════════════════════════════════════════════════════


def get_invoice_by_filename(filename: str) -> Optional[Dict]:
    """按文件名（file_name）查找发票记录
    
    Args:
        filename: 文件名（含路径或纯文件名均可）
    
    Returns:
        匹配的发票记录（深拷贝），未找到返回 None
    """
    if not filename:
        return None
    _ensure_loaded()
    target = filename.strip().lower()
    
    # 先尝试精确匹配（索引查找）
    idx = _invoice_index_by_filename.get(target)
    if idx is not None and not _invoices[idx].get('deleted_at'):
        return _invoices[idx].copy()
    
    # 再尝试纯文件名匹配（路径提取后）
    pure_name = target.split('/')[-1].split('\\')[-1]
    if pure_name != target:
        idx = _invoice_index_by_filename.get(pure_name)
        if idx is not None and not _invoices[idx].get('deleted_at'):
            return _invoices[idx].copy()
    
    return None


def get_invoices_by_filenames(filenames: List[str]) -> List[Dict]:
    """批量按文件名查找发票（使用索引，O(K) 替代 O(N×K)）

    Args:
        filenames: 文件名列表

    Returns:
        匹配的发票记录列表（保持 filenames 传入顺序）
    """
    if not filenames:
        return []
    _ensure_loaded()

    results = []
    for fname in filenames:
        if not fname:
            continue
        key = fname.strip().lower()
        # 先尝试精确匹配
        idx = _invoice_index_by_filename.get(key)
        if idx is not None and not _invoices[idx].get('deleted_at'):
            results.append(_invoices[idx].copy())
            continue
        # 再尝试纯文件名匹配
        pure_name = key.split('/')[-1].split('\\')[-1]
        if pure_name != key:
            idx = _invoice_index_by_filename.get(pure_name)
            if idx is not None and not _invoices[idx].get('deleted_at'):
                results.append(_invoices[idx].copy())
    return results


def get_all_invoices() -> List[Dict]:
    """获取所有未删除的发票记录"""
    _ensure_loaded()
    return [inv.copy() for inv in _invoices if not inv.get('deleted_at')]


def search_invoices(
    keyword: str = '',
    type_filter: str = '',
    date_from: str = '',
    date_to: str = '',
    order_by: str = 'created_at',
    order_dir: str = 'DESC',
    limit: int = 50,
    offset: int = 0,
) -> Dict:
    """搜索发票（支持多条件过滤、排序、分页）

    使用搜索缓存减少重复搜索的全表遍历开销。
    缓存键基于搜索条件构建，写操作时自动失效。

    Returns:
        {'rows': [...], 'total': int}
    """
    _ensure_loaded()

    # 预先计算过滤值，避免在 comprehension 中反复计算
    kw = keyword.lower() if keyword else None

    # 尝试搜索缓存
    cache_key = _build_search_cache_key(
        kw or '', type_filter, date_from or '', date_to or '',
        order_by, order_dir,
    )
    cached = _search_cache_get(cache_key)
    if cached is not None:
        logger.debug("[Search] 缓存命中: %s", cache_key[:40])
        results = cached
    else:
        # ✅ 单次遍历 + 组合条件，避免多个中间临时列表
        results = [
            inv for inv in _invoices
            if not inv.get('deleted_at')
            and (not kw or (
                (inv.get('number') and kw in str(inv['number']).lower()) or
                (inv.get('buyer') and kw in str(inv['buyer']).lower()) or
                (inv.get('seller') and kw in str(inv['seller']).lower()) or
                (inv.get('note') and kw in str(inv['note']).lower()) or
                (inv.get('file_name') and kw in str(inv['file_name']).lower())
            ))
            and (not type_filter or inv.get('type') == type_filter)
            and (not date_from or (inv.get('date') or '') >= date_from)
            and (not date_to or (inv.get('date') or '') <= date_to)
        ]
        _search_cache_set(cache_key, results)

    # 排序
    valid_order_fields = {'date', 'amount', 'created_at', 'file_name'}
    sort_field = order_by if order_by in valid_order_fields else 'created_at'
    reverse = order_dir.upper() != 'ASC'

    def sort_key(inv):
        val = inv.get(sort_field, '') or ''
        if sort_field == 'amount':
            try:
                return float(val)
            except (ValueError, TypeError):
                return 0.0
        return val

    results.sort(key=sort_key, reverse=reverse)

    total = len(results)
    limit = min(max(limit, 1), 1000)
    rows = [inv.copy() for inv in results[offset:offset + limit]]

    return {'rows': rows, 'total': total}


def find_by_hash(hash_val: str) -> Optional[Dict]:
    """按 SHA256 查找已有发票，用于去重"""
    if not hash_val:
        return None
    _ensure_loaded()
    idx = _invoice_index_by_hash.get(hash_val)
    if idx is not None and not _invoices[idx].get('deleted_at'):
        return _invoices[idx].copy()
    return None


def find_duplicates(number: str) -> List[Dict]:
    """查找重复发票（按号码）

    使用 _invoice_index_by_number 索引，O(K) 替代 O(N)。
    返回按创建时间降序排列的结果。
    """
    if not number:
        return []
    _ensure_loaded()

    indices = _invoice_index_by_number.get(str(number), [])
    if not indices:
        return []

    duplicates = []
    for idx in indices:
        inv = _invoices[idx]
        if inv.get('deleted_at'):
            continue
        duplicates.append(dict({
            'id': inv['id'],
            'file_name': inv.get('file_name', ''),
            'amount': inv.get('amount', 0),
            'date': inv.get('date', ''),
            'created_at': inv.get('created_at', '')
        }))
    duplicates.sort(key=lambda x: x.get('created_at', ''), reverse=True)
    return duplicates


def get_statistics() -> Dict:
    """获取统计数据"""
    _ensure_loaded()

    active = [inv for inv in _invoices if not inv.get('deleted_at')]
    total_count = len(active)
    total_amount = sum(float(inv.get('amount', 0)) for inv in active)
    ok_count = sum(1 for inv in active if inv.get('parse_ok') == 1)
    fail_count = total_count - ok_count

    by_type = {}
    for inv in active:
        inv_type = inv.get('type', '其他')
        if inv_type not in by_type:
            by_type[inv_type] = {'count': 0, 'total': 0}
        by_type[inv_type]['count'] += 1
        by_type[inv_type]['total'] += float(inv.get('amount', 0))

    by_type_array = [
        {'type': t, **data}
        for t, data in sorted(by_type.items(), key=lambda x: x[1]['total'], reverse=True)
    ]

    return {
        'summary': {
            'total_count': total_count,
            'total_amount': total_amount,
            'ok_count': ok_count,
            'fail_count': fail_count,
        },
        'byType': [dict(item) for item in by_type_array],
    }


# ═══════════════════════════════════════════════════════════
#  配置管理
# ═══════════════════════════════════════════════════════════


def get_config(key: str = '') -> Any:
    """读取配置。key 为空时返回所有配置（深拷贝，防止外部修改）"""
    _ensure_loaded()
    if not key:
        # 使用深拷贝确保嵌套结构也被复制，防止外部修改影响内部状态
        return copy.deepcopy(_config)
    value = _config.get(key)
    # 如果值是可变类型，返回深拷贝
    if isinstance(value, (dict, list)):
        return copy.deepcopy(value)
    return value


def set_config(key: str, value: Any) -> Dict:
    """写入配置项"""
    _ensure_loaded()
    with _lock:
        _config[key] = value
        _save_config()
    return {'ok': True}


def get_db_path() -> str:
    """获取数据库目录路径"""
    return DB_DIR


# ============================
# 兼容旧接口
# ============================

__all__ = [
    # 路径
    'DB_DIR', 'DB_PATH', 'INVOICES_PATH', 'CONFIG_PATH',
    # CRUD
    'upsert_invoice', 'batch_upsert_invoices', 'get_invoice', 'soft_delete_invoice',
    'hard_delete_invoice', 'restore_invoice', 'update_invoice_fields',
    # 查询
    'search_invoices', 'find_by_hash', 'find_duplicates', 'get_statistics',
    'get_invoice_by_filename', 'get_all_invoices',
    # 配置
    'get_config', 'set_config',
    # 维护
    'cleanup_expired_invoices', 'get_db_path', 'flush_oplog_buffer',
    # 兼容
    '_connect', '_config',
]
