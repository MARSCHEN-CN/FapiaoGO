"""
缓存服务 — CacheManager

从简单的工具函数升级为完整的缓存服务：
- namespace 分目录（pdf_text / ocr / fields / preview）
- 元数据追踪（version / params / 命中次数 / 体积）
- 按 namespace 独立失效
- TTL + 容量清理
- 旧缓存自动迁移到 _legacy/
- 缓存 schema 版本控制（v10新增）

调用方零修改：旧的 get_ocr_cache / set_ocr_cache 函数签名不变，
内部自动委托给 CacheManager 单例。

缓存 key 组成（v10）：
- file_hash: 文件内容哈希
- CACHE_SCHEMA_VERSION: 统一缓存 schema 版本
- engine_version: 引擎版本
- extractor_version: 字段提取器版本
- regex_version: 正则规则版本
- line_item_parser_version: 明细行解析器版本
- party_parser_version: 买卖方解析器版本
- amount_parser_version: 金额解析器版本

每次修改核心解析规则时必须升级对应版本号。
"""

import os
import hashlib
import json
import time
import tempfile
import shutil
import threading
import logging
from collections import OrderedDict
from datetime import timedelta
from time_utils import now, from_isoformat, to_timestamp
from typing import Any, Dict, Optional

try:
    import orjson
    _HAS_ORJSON = True
except ImportError:
    _HAS_ORJSON = False

from config import (
    OCR_CACHE_DIR, OCR_CACHE_MAX_SIZE, OCR_CACHE_MAX_BYTES,
    OCR_CACHE_EXPIRE_DAYS, CACHE_VERSIONS, ENABLE_CACHE, CACHE_DEBUG
)

logger = logging.getLogger(__name__)

# =============================================================================
# 缓存版本控制（v10 新增）
# =============================================================================

# 统一缓存 schema 版本 - 每次修改核心解析规则时必须升级
CACHE_SCHEMA_VERSION = "invoice-parse-v6.0.0"

# 各解析器版本 - 按需升级
ENGINE_VERSION = "v9.0.0"
EXTRACTOR_VERSION = "v6.0.0"
REGEX_VERSION = "v3.2.0"
LINE_ITEM_PARSER_VERSION = "v10.0.0"  # 新增修正记录功能
PARTY_PARSER_VERSION = "v4.1.0"
AMOUNT_PARSER_VERSION = "v2.3.0"

# 旧版缓存版本号（向后兼容）
CACHE_VERSION = "20260608-v9"

# 缓存总容量限制（字节）- 从配置读取
CACHE_MAX_BYTES = OCR_CACHE_MAX_BYTES

# 版本元数据（用于缓存 key 和响应返回）
VERSION_METADATA = {
    "cache_schema_version": CACHE_SCHEMA_VERSION,
    "engine_version": ENGINE_VERSION,
    "extractor_version": EXTRACTOR_VERSION,
    "regex_version": REGEX_VERSION,
    "line_item_parser_version": LINE_ITEM_PARSER_VERSION,
    "party_parser_version": PARTY_PARSER_VERSION,
    "amount_parser_version": AMOUNT_PARSER_VERSION,
}

# 版本键预计算（模块加载时计算一次，运行时不变）
_VERSION_KEY = hashlib.md5("-".join([
    CACHE_SCHEMA_VERSION,
    ENGINE_VERSION,
    EXTRACTOR_VERSION,
    REGEX_VERSION,
    LINE_ITEM_PARSER_VERSION,
    PARTY_PARSER_VERSION,
    AMOUNT_PARSER_VERSION,
]).encode()).hexdigest()[:16]


def get_version_key() -> str:
    """
    生成版本组合 key，用于缓存 key 的一部分。
    当任何解析器版本变化时，缓存会自动失效。
    [优化] 版本在运行时不变，返回预计算的模块常量。
    """
    return _VERSION_KEY


# =============================================================================
# 序列化辅助（orjson 加速，带 json 回退）
# =============================================================================

def _json_dumps(obj: Any, sort_keys: bool = False) -> str:
    """JSON 序列化，优先使用 orjson，回退到标准 json"""
    if _HAS_ORJSON:
        # orjson 默认按键排序，OPT_SERIALIZE_NUMPY 支持 numpy 类型
        return orjson.dumps(obj, option=orjson.OPT_SERIALIZE_NUMPY).decode('utf-8')
    else:
        return json.dumps(obj, ensure_ascii=False, sort_keys=sort_keys, separators=(',', ':'))


def _json_loads(s: str) -> Any:
    """JSON 反序列化，优先使用 orjson，回退到标准 json"""
    if _HAS_ORJSON:
        # orjson 支持 bytes 和 str
        return orjson.loads(s)
    else:
        return json.loads(s)


# =============================================================================
# CacheManager 核心类
# =============================================================================

class CacheManager:
    """
    缓存管理器
    
    目录结构:
        base_dir/
          pdf_text/
          ocr/
          fields/
          preview/
          _legacy/
    
    每个缓存条目格式:
    {
      "__meta__": {
        "namespace": "fields",
        "key": "abc123...",
        "version": "20260608-v9",
        "params": {...},
        "file_size": 524288,
        "data_size": 2048,
        "created_at": "2026-06-08T10:00:00Z",
        "accessed_at": "2026-06-08T12:00:00Z",
        "hit_count": 3
      },
      "data": { ... }
    }
    """

    NAMESPACES = ['pdf_text', 'ocr', 'fields', 'preview']
    LEGACY_DIR = '_legacy'

    def __init__(self, base_dir: str, version: str = CACHE_VERSION,
                 max_files: int = OCR_CACHE_MAX_SIZE,
                 ttl_days: int = OCR_CACHE_EXPIRE_DAYS,
                 max_bytes: int = OCR_CACHE_MAX_BYTES,
                 versions: Dict[str, str] = None):
        self.base_dir = base_dir
        self.default_version = version
        self.max_files = max_files
        self.ttl_days = ttl_days
        self.max_bytes = max_bytes
        self.versions = versions or CACHE_VERSIONS

        self._lock = threading.Lock()
        self._counter_lock = threading.Lock()  # 专用锁：保护 _hit_counters 的 RMW 操作
        # 内存中的命中计数器（避免每次 get 都写文件）。
        # 用 OrderedDict 实现 LRU：超出容量上限时淘汰最久未访问的条目，
        # 防止长期运行处理大量不同文件时本 dict 无界增长造成内存泄漏。
        self._hit_counters: "OrderedDict[str, int]" = OrderedDict()
        # LRU 容量上限：至少为 max_files 的若干倍（覆盖并发命名空间下的活跃 key），
        # 同时用绝对值封顶，避免 max_files 配置过大时本结构本身占用过高。
        self._hit_counter_max = min(50000, max(2000, self.max_files * 4))
        # 每 namespace 的内存统计计数器（增量维护，供 stats() 无扫描读取）。
        # files/size 在 set/删除/清理/失效时增量更新；hits 在 get 命中时递增。
        # 仅在 __init__ 与 migrate_legacy 后做一次性全量重建（_recompute_ns_stats）。
        self._ns_files: Dict[str, int] = {}
        self._ns_size: Dict[str, int] = {}
        self._ns_hits: Dict[str, int] = {}

        # ✅ 惰性清理：每 N 次写入才做一次目录遍历
        self._write_counter = 0
        self._cleanup_interval = 10  # 每 10 次 set() 扫描一次
        # 清理节流保护：计数器加锁防并发丢失；连续跳过超阈值则强制（阻塞）清理一次
        self._enforce_skips = 0
        self._enforce_skip_threshold = 3

        # 确保 namespace 子目录存在
        for ns in self.NAMESPACES:
            os.makedirs(os.path.join(self.base_dir, ns), exist_ok=True)
        os.makedirs(os.path.join(self.base_dir, self.LEGACY_DIR), exist_ok=True)

        # 启动时一次性从磁盘重建 per-namespace 文件数/体积统计（非 stats 热路径）
        self._recompute_ns_stats()

        # 后台定时 TTL 清理线程：即使没有写入流量，过期缓存也会被定期回收，
        # 不再仅依赖写入时触发的惰性清理（_enforce_capacity）。daemon 线程，
        # 进程退出时自动回收；亦可显式调用 stop() 优雅停止。
        self._ttl_sweep_interval = 3600  # 秒：默认每小时扫描一次
        self._stop_sweep = threading.Event()
        self._sweep_thread: Optional[threading.Thread] = None
        self._start_sweep()

    def _get_version(self, namespace: str) -> str:
        """获取 namespace 对应的版本号"""
        return self.versions.get(namespace, self.default_version)

    def _ns_dir(self, namespace: str) -> str:
        """获取 namespace 对应的目录路径"""
        if namespace in self.NAMESPACES:
            return os.path.join(self.base_dir, namespace)
        return os.path.join(self.base_dir, self.LEGACY_DIR)

    def _build_filename(self, key: str, params: Optional[Dict] = None) -> str:
        """
        构建缓存文件名。
        如果有 params，将参数编码到文件名后缀中（兼容旧命名习惯）。
        
        v10 新增：文件名包含版本 key，确保解析规则变更时缓存自动失效。
        """
        # 添加版本 key 到文件名前缀
        version_key = get_version_key()
        base_name = f"{key}_{version_key}"
        
        if params:
            # 按固定顺序拼接参数后缀，保证相同参数生成相同文件名
            suffix_parts = []
            if params.get('auto_orient') is False:
                suffix_parts.append('_no_orient')
            if params.get('force_ocr'):
                suffix_parts.append('_force_ocr')
            # 其他参数用简短哈希
            extra = {k: v for k, v in sorted(params.items())
                     if k not in ('auto_orient', 'force_ocr')}
            if extra:
                extra_hash = hashlib.md5(_json_dumps(extra, sort_keys=True).encode()).hexdigest()[:8]
                suffix_parts.append(f'_{extra_hash}')
            suffix = ''.join(suffix_parts)
            return f"{base_name}{suffix}.json"
        return f"{base_name}.json"

    def _cache_path(self, namespace: str, key: str, params: Optional[Dict] = None) -> str:
        """获取缓存文件的完整路径"""
        filename = self._build_filename(key, params)
        return os.path.join(self._ns_dir(namespace), filename)

    def _legacy_path(self, key: str) -> str:
        """获取旧格式缓存文件路径（兼容回退）"""
        return os.path.join(self._ns_dir(self.LEGACY_DIR),
                            f"{self.default_version}_{key}.json")

    def _read_entry(self, path: str) -> Optional[Dict]:
        """读取缓存条目，支持新旧两种格式"""
        if not os.path.exists(path):
            return None
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = _json_loads(f.read())
            # 新格式：有 __meta__ 包装
            if isinstance(data, dict) and '__meta__' in data:
                return data
            # 旧格式：裸数据
            return {'__meta__': {}, 'data': data}
        except (json.JSONDecodeError, ValueError, IOError):
            return None

    def get(self, namespace: str, key: str, params: Optional[Dict] = None) -> Any:
        """
        读取缓存。命中时更新内存中的命中计数器。
        找不到时回退到 _legacy/ 目录。
        """
        # 1. 尝试从 namespace 目录读取
        path = self._cache_path(namespace, key, params)
        entry = self._read_entry(path)

        # 2. 回退到 _legacy/ 目录
        if entry is None:
            legacy_key = self._build_filename(key, params).replace('.json', '')
            legacy_path = self._legacy_path(legacy_key)
            entry = self._read_entry(legacy_path)
            if entry is not None:
                # 旧格式也检查版本号
                meta = entry.get('__meta__', {})
                if meta and meta.get('version') != self._get_version(namespace):
                    return None  # 版本不匹配

        if entry is None:
            return None

        meta = entry.get('__meta__', {})
        data = entry.get('data')

        # 版本校验（新格式才有 meta）
        if meta and meta.get('version'):
            expected_version = self._get_version(namespace)
            if meta['version'] != expected_version:
                return None

        # 旧格式字段校验（fields 类型需要特定字段）
        if not meta and namespace == 'fields':
            if not isinstance(data, dict):
                return None

        # 更新内存命中计数器（加锁保护 RMW 操作，并维护 LRU 顺序）
        counter_key = f"{namespace}:{key}"
        with self._counter_lock:
            c = self._hit_counters
            c[counter_key] = c.get(counter_key, 0) + 1
            c.move_to_end(counter_key)  # 最近访问移到末尾
            # 超出容量上限时淘汰最久未访问（队首）条目，限制内存增长
            if len(c) > self._hit_counter_max:
                c.popitem(last=False)
            hits = c[counter_key]
            # 增量维护 namespace 级命中计数（供 stats() 无扫描读取）
            self._ns_hits[namespace] = self._ns_hits.get(namespace, 0) + 1

        logger.debug("[Cache] 命中 %s/%s (hits=%d)", namespace, key[:16], hits)
        return data

    def set(self, namespace: str, key: str, value: Any,
            params: Optional[Dict] = None, file_size: int = 0) -> None:
        """
        写入缓存。原子写入到 namespace 子目录。
        """
        if namespace not in self.NAMESPACES:
            namespace = 'ocr'  # 未知 namespace 归入 ocr

        ns_dir = self._ns_dir(namespace)
        os.makedirs(ns_dir, exist_ok=True)

        path = self._cache_path(namespace, key, params)
        version = self._get_version(namespace)

        now_str = now().isoformat()

        # 构建元数据包（v10 新增版本元数据）
        serialized = _json_dumps(value) if not isinstance(value, str) else value
        data_size = len(serialized.encode('utf-8')) if isinstance(serialized, str) else len(serialized)

        meta = {
            'namespace': namespace,
            'key': key,
            'version': version,
            'params': params or {},
            'file_size': file_size,
            'data_size': data_size,
            'created_at': now_str,
            'accessed_at': now_str,
            'hit_count': 0,
            # v10 新增：版本元数据，便于调试和追踪
            'schema_version': CACHE_SCHEMA_VERSION,
            'engine_version': ENGINE_VERSION,
            'extractor_version': EXTRACTOR_VERSION,
            'regex_version': REGEX_VERSION,
            'line_item_parser_version': LINE_ITEM_PARSER_VERSION,
            'party_parser_version': PARTY_PARSER_VERSION,
            'amount_parser_version': AMOUNT_PARSER_VERSION,
        }

        entry = {
            '__meta__': meta,
            'data': value,
        }

        try:
            # 容量检查
            self._enforce_capacity()

            with self._lock:
                pre_existed = os.path.exists(path)
                prev_size = os.path.getsize(path) if pre_existed else 0
                with tempfile.NamedTemporaryFile(
                    mode='w', suffix='.json', dir=ns_dir,
                    encoding='utf-8', delete=False
                ) as f:
                    f.write(_json_dumps(entry))
                    temp_path = f.name
                os.replace(temp_path, path)
                new_size = os.path.getsize(path)
                # 增量维护 per-namespace 内存统计（覆盖写只更新体积差，新建才加计数）
                if pre_existed:
                    self._ns_size[namespace] = self._ns_size.get(namespace, 0) + (new_size - prev_size)
                else:
                    self._ns_files[namespace] = self._ns_files.get(namespace, 0) + 1
                    self._ns_size[namespace] = self._ns_size.get(namespace, 0) + new_size

            logger.debug("[Cache] 写入 %s/%s (size=%d)", namespace, key[:16], data_size)
        except (IOError, OSError) as e:
            logger.warning("[Cache] 写入失败 %s/%s: %s", namespace, key[:16], e)

    def invalidate_namespace(self, namespace: str) -> int:
        """按 namespace 失效所有缓存"""
        ns_dir = self._ns_dir(namespace)
        if not os.path.exists(ns_dir):
            return 0

        count = 0
        with self._lock:
            for filename in os.listdir(ns_dir):
                if filename.endswith('.json'):
                    try:
                        os.remove(os.path.join(ns_dir, filename))
                        count += 1
                    except OSError:
                        pass
            # 清空该 namespace 的内存统计
            self._ns_files[namespace] = 0
            self._ns_size[namespace] = 0
            self._ns_hits[namespace] = 0
        logger.info("[Cache] 失效 namespace=%s, 删除 %d 个文件", namespace, count)
        return count

    def cleanup_by_ttl(self) -> int:
        """按 TTL 清理过期缓存（外部调用接口，自动加锁）"""
        with self._lock:
            return self._cleanup_by_ttl_locked()

    # ───────────────────────────────────────────────────────────
    # 后台定时 TTL 清理（补充写入时惰性清理的盲区）
    # ───────────────────────────────────────────────────────────
    def _start_sweep(self) -> None:
        """启动后台定时 TTL 清理线程（幂等，避免重复创建）"""
        if self._sweep_thread is not None and self._sweep_thread.is_alive():
            return
        self._stop_sweep.clear()
        t = threading.Thread(target=self._sweep_loop, daemon=True)
        t.name = "cache-ttl-sweep"
        self._sweep_thread = t
        t.start()

    def _sweep_loop(self) -> None:
        """后台循环：周期性调用 cleanup_by_ttl 回收过期缓存。

        wait() 返回 True 表示收到停止信号，返回 False 表示超时到点需工作；
        因此 `while not self._stop_sweep.wait(interval)` 在每次到点执行一次清理，
        收到 stop() 信号后优雅退出。
        """
        while not self._stop_sweep.wait(self._ttl_sweep_interval):
            try:
                removed = self.cleanup_by_ttl()
                if removed:
                    logger.debug("[Cache] 后台 TTL 清理: 删除 %d 个过期文件", removed)
            except Exception:
                # 后台线程异常不应拖垮主流程
                logger.exception("[Cache] 后台 TTL 清理异常")

    def stop(self) -> None:
        """停止后台定时清理线程（可选；daemon 线程在进程退出时自动回收）"""
        self._stop_sweep.set()
        if self._sweep_thread is not None:
            self._sweep_thread.join(timeout=5)
            self._sweep_thread = None

    def cleanup_by_size(self) -> int:
        """当总容量超过限制时，按最后访问时间淘汰"""
        total_size = 0
        all_files = []

        # 收集所有缓存文件
        dirs_to_scan = [self._ns_dir(ns) for ns in self.NAMESPACES]
        dirs_to_scan.append(self._ns_dir(self.LEGACY_DIR))

        for d in dirs_to_scan:
            if not os.path.exists(d):
                continue
            try:
                for filename in os.listdir(d):
                    filepath = os.path.join(d, filename)
                    if os.path.isfile(filepath) and filename.endswith('.json'):
                        try:
                            size = os.path.getsize(filepath)
                            mtime = os.path.getmtime(filepath)
                            total_size += size
                            all_files.append((filepath, size, mtime))
                        except OSError:
                            pass
            except OSError:
                pass

        if total_size <= self.max_bytes:
            return 0

        # 按修改时间排序，删除最旧的
        all_files.sort(key=lambda x: x[2])
        count = 0
        freed = 0

        with self._lock:
            for filepath, size, _ in all_files:
                if total_size <= self.max_bytes:
                    break
                try:
                    os.remove(filepath)
                    total_size -= size
                    freed += size
                    count += 1
                except OSError:
                    pass

        if count > 0:
            logger.info("[Cache] 容量清理: 删除 %d 个文件, 释放 %.1f MB", count, freed / 1024 / 1024)
        return count

    def _enforce_capacity(self):
        """写入前检查容量，必要时淘汰旧文件（惰性执行，非每次写入都遍历）

        清理策略：
        - 前 N-1 次写入直接跳过（靠定期/定时清理兜底）
        - 每第 N 次写入执行完整目录遍历 + TTL/容量清理
        - 使用 try_lock 模式：锁被持有时跳过本次清理，避免阻塞 get/set

        注意：周期性 TTL 清理已由 __init__ 启动的后台线程 _sweep_loop 补充
        （默认每小时调用一次 cleanup_by_ttl），不再依赖外部调用方。
        """
        # 计数与周期判定加锁，保证并发 set() 下计数不丢失、周期判定准确
        with self._counter_lock:
            self._write_counter += 1
            if self._write_counter % self._cleanup_interval != 0:
                return

        # try_lock 模式：锁空闲则非阻塞执行清理；锁忙则累计跳过次数，
        # 连续跳过超过阈值后改为阻塞等待一次，避免高并发下清理永不执行
        forced = False
        if not self._lock.acquire(blocking=False):
            with self._counter_lock:
                self._enforce_skips += 1
                force = self._enforce_skips >= self._enforce_skip_threshold
            if not force:
                logger.debug("[Cache] 容量清理被跳过（锁被占用）")
                return
            # 连续跳过过多，强制阻塞等待锁以执行一次清理（防高并发下永不清理）
            self._lock.acquire(blocking=True)
            forced = True

        try:
            # 1. 先按 TTL 清理
            self._cleanup_by_ttl_locked()

            # 2. 遍历目录统计文件总数和体积
            total_count = 0
            all_files = []

            for ns in self.NAMESPACES:
                ns_dir = self._ns_dir(ns)
                if not os.path.exists(ns_dir):
                    continue
                try:
                    for filename in os.listdir(ns_dir):
                        if filename.endswith('.json'):
                            filepath = os.path.join(ns_dir, filename)
                            try:
                                total_count += 1
                                mtime = os.path.getmtime(filepath)
                                size = os.path.getsize(filepath)
                                all_files.append((filepath, mtime, size, ns))
                            except OSError:
                                pass
                except OSError:
                    pass

            # 3. 检查体积
            total_size = sum(f[2] for f in all_files)

            # 4. 收集待删除文件（dict: filepath -> (ns, size)，避免重复与漏计）
            files_to_delete = {}

            # 按数量限制
            if total_count > self.max_files:
                for f in sorted(all_files, key=lambda x: x[1])[:total_count - self.max_files]:
                    files_to_delete[f[0]] = (f[3], f[2])

            # 按体积限制
            if total_size > self.max_bytes:
                sorted_files = sorted(all_files, key=lambda x: x[1])
                freed = 0
                target_freed = total_size - self.max_bytes
                for filepath, mtime, size, ns in sorted_files:
                    if freed >= target_freed:
                        break
                    files_to_delete[filepath] = (ns, size)
                    freed += size

            # 5. 执行删除并增量维护 per-namespace 内存统计
            for filepath, (ns, size) in files_to_delete.items():
                try:
                    os.remove(filepath)
                    self._ns_files[ns] = max(0, self._ns_files.get(ns, 0) - 1)
                    self._ns_size[ns] = max(0, self._ns_size.get(ns, 0) - size)
                except OSError:
                    pass

            if files_to_delete:
                logger.debug("[Cache] 容量清理: 删除 %d 个文件", len(files_to_delete))
        finally:
            self._lock.release()
            # 清理已执行：重置连续跳过计数（无论是否强制）
            with self._counter_lock:
                self._enforce_skips = 0

    def _cleanup_by_ttl_locked(self):
        """按 TTL 清理过期缓存（调用方须持有 self._lock）"""
        now = time.time()
        expire_seconds = self.ttl_days * 86400
        count = 0

        dirs_to_clean = [self._ns_dir(ns) for ns in self.NAMESPACES]
        dirs_to_clean.append(self._ns_dir(self.LEGACY_DIR))

        for d in dirs_to_clean:
            if not os.path.exists(d):
                continue
            try:
                for filename in os.listdir(d):
                    filepath = os.path.join(d, filename)
                    if os.path.isfile(filepath) and filename.endswith('.json'):
                        try:
                            mtime = os.path.getmtime(filepath)
                            if (now - mtime) > expire_seconds:
                                try:
                                    sz = os.path.getsize(filepath)
                                except OSError:
                                    sz = 0
                                os.remove(filepath)
                                count += 1
                                # 增量维护 per-namespace 内存统计
                                ns = self._ns_from_path(filepath)
                                if ns is not None:
                                    self._ns_files[ns] = max(0, self._ns_files.get(ns, 0) - 1)
                                    self._ns_size[ns] = max(0, self._ns_size.get(ns, 0) - sz)
                        except OSError:
                            pass
            except OSError:
                pass

        if count > 0:
            logger.info("[Cache] TTL 清理: 删除 %d 个过期文件", count)
        return count

    def _recompute_ns_stats(self):
        """从磁盘全量重建 per-namespace 文件数/体积统计。

        仅供初始化与 migrate_legacy 后调用（一次性成本，非 stats 热路径）。
        调用方不持锁——本方法内部自行获取 self._lock。
        """
        with self._lock:
            self._ns_files = {}
            self._ns_size = {}
            all_dirs = [self._ns_dir(ns) for ns in self.NAMESPACES]
            all_dirs.append(self._ns_dir(self.LEGACY_DIR))
            for ns, ns_dir in zip(self.NAMESPACES + [self.LEGACY_DIR], all_dirs):
                if not os.path.exists(ns_dir):
                    continue
                try:
                    for filename in os.listdir(ns_dir):
                        if filename.endswith('.json'):
                            filepath = os.path.join(ns_dir, filename)
                            try:
                                self._ns_files[ns] = self._ns_files.get(ns, 0) + 1
                                self._ns_size[ns] = self._ns_size.get(ns, 0) + os.path.getsize(filepath)
                            except OSError:
                                pass
                except OSError:
                    pass

    def _ns_from_path(self, filepath: str) -> Optional[str]:
        """根据文件路径反查其所属 namespace（用于删除时维护内存统计）"""
        for ns in self.NAMESPACES + [self.LEGACY_DIR]:
            ns_dir = self._ns_dir(ns)
            if filepath.startswith(ns_dir + os.sep):
                return ns
        return None

    def stats(self) -> Dict:
        """返回缓存统计信息。

        基于内存增量计数器，O(namespaces) 读取，无需全量扫描/解析磁盘 JSON。
        """
        result = {'namespaces': {}, 'total_files': 0, 'total_size': 0, 'total_hits': 0}

        all_dirs = self.NAMESPACES + [self.LEGACY_DIR]

        for ns in all_dirs:
            ns_files = self._ns_files.get(ns, 0)
            ns_size = self._ns_size.get(ns, 0)
            ns_hits = self._ns_hits.get(ns, 0)

            result['namespaces'][ns] = {
                'files': ns_files,
                'size': ns_size,
                'size_mb': round(ns_size / 1024 / 1024, 2),
                'hits': ns_hits,
                'version': self._get_version(ns) if ns != self.LEGACY_DIR else 'N/A',
            }

            if ns != self.LEGACY_DIR:
                result['total_files'] += ns_files
                result['total_size'] += ns_size
                result['total_hits'] += ns_hits

        result['total_size_mb'] = round(result['total_size'] / 1024 / 1024, 2)
        result['max_mb'] = round(self.max_bytes / 1024 / 1024, 2)
        result['max_files'] = self.max_files
        result['ttl_days'] = self.ttl_days
        return result

    def clear(self, namespace: Optional[str] = None) -> int:
        """清除缓存。namespace=None 清除全部。"""
        if namespace:
            return self.invalidate_namespace(namespace)

        count = 0
        for ns in self.NAMESPACES + [self.LEGACY_DIR]:
            count += self.invalidate_namespace(ns)
        logger.info("[Cache] 全部清除: %d 个文件", count)
        return count

    def migrate_legacy(self) -> int:
        """
        将根目录下的旧格式缓存文件移入 _legacy/ 目录。
        旧格式文件名特征: 以版本号开头 {VERSION}_{hash}.json
        """
        count = 0
        legacy_dir = self._ns_dir(self.LEGACY_DIR)
        version_prefix = f"{self.default_version}_"

        try:
            for filename in os.listdir(self.base_dir):
                if not filename.endswith('.json'):
                    continue
                if not filename.startswith(version_prefix):
                    continue
                src = os.path.join(self.base_dir, filename)
                if os.path.isfile(src):
                    dst = os.path.join(legacy_dir, filename)
                    try:
                        shutil.move(src, dst)
                        count += 1
                    except (OSError, shutil.Error):
                        pass
        except OSError:
            pass

        if count > 0:
            logger.info("[Cache] 迁移旧缓存: %d 个文件移入 %s/", count, self.LEGACY_DIR)
            # 迁移改变了文件布局，重建内存统计
            self._recompute_ns_stats()
        return count


# =============================================================================
# 全局单例
# =============================================================================

_cache_manager: Optional[CacheManager] = None


def _get_manager() -> CacheManager:
    """获取或创建 CacheManager 全局单例"""
    global _cache_manager
    if _cache_manager is None:
        _cache_manager = CacheManager(
            base_dir=OCR_CACHE_DIR,
            version=CACHE_VERSION,
            max_files=OCR_CACHE_MAX_SIZE,
            ttl_days=OCR_CACHE_EXPIRE_DAYS,
            max_bytes=CACHE_MAX_BYTES,
            versions=CACHE_VERSIONS,
        )
    return _cache_manager


# =============================================================================
# 向后兼容的旧函数（调用方零修改）
# =============================================================================

def get_file_hash(file_bytes):
    """计算文件内容的 MD5 哈希"""
    hasher = hashlib.md5()
    if isinstance(file_bytes, str):
        return file_bytes
    hasher.update(file_bytes)
    return hasher.hexdigest()


def get_cache_path(file_hash):
    """获取缓存文件路径（旧格式，兼容）"""
    return os.path.join(OCR_CACHE_DIR, f"{CACHE_VERSION}_{file_hash}.json")


# --- 命名空间推断 ---

# 后缀 → namespace 映射（按后缀长度降序，优先匹配更长的后缀）
_NS_SUFFIXES = [
    ('_unified_no_orient', 'pdf_text'),
    ('_unified_force_ocr', 'pdf_text'),
    ('_force_ocr', 'pdf_text'),
    ('_unified', 'pdf_text'),
    ('_fields', 'fields'),
    ('_no_orient', 'ocr'),
]


def _infer_namespace_and_key(raw_key: str):
    """
    从旧的缓存 key 推断 namespace 和纯净 key。
    
    返回 (namespace, clean_key, params_hint)
    - namespace: 推断出的命名空间
    - clean_key: 去掉后缀后的纯净 key
    - params_hint: 从后缀推断出的参数（用于 CacheManager._build_filename）
    """
    for suffix, ns in _NS_SUFFIXES:
        if raw_key.endswith(suffix):
            clean_key = raw_key[:-len(suffix)]
            # 从后缀反推参数
            params = {}
            if 'no_orient' in suffix:
                params['auto_orient'] = False
            if 'force_ocr' in suffix:
                params['force_ocr'] = True
            return ns, clean_key, params

    # 无后缀：默认归入 ocr
    return 'ocr', raw_key, None


def get_ocr_cache(file_bytes, params=None):
    """从缓存读取（向后兼容）

    Args:
        file_bytes: 文件内容（bytes）、文件路径（str）、或预计算缓存 key（str）
        params: 可选，缓存参数（用于版本校验）
    """
    if not ENABLE_CACHE:
        return None
    raw_key = get_file_hash(file_bytes)
    ns, clean_key, inferred_params = _infer_namespace_and_key(raw_key)
    if params is not None:
        inferred_params = params
    return _get_manager().get(ns, clean_key, inferred_params)


def set_ocr_cache(file_bytes, result, params=None):
    """将结果写入缓存（向后兼容）"""
    if not ENABLE_CACHE:
        return
    raw_key = get_file_hash(file_bytes)
    ns, clean_key, inferred_params = _infer_namespace_and_key(raw_key)
    if params is not None:
        inferred_params = params
    _get_manager().set(ns, clean_key, result, params=inferred_params)


def get_fields_cache(key, params=None):
    """从字段提取缓存读取（fields 命名空间）

    Args:
        key: 预计算的缓存 key（通常是文件内容的 SHA256 hex digest）
        params: 可选，缓存参数（用于版本校验，如解析参数、辅助块 hash 等）
    """
    if not ENABLE_CACHE:
        return None
    return _get_manager().get("fields", key, params)


def set_fields_cache(key, result, params=None):
    """将字段提取结果写入缓存（fields 命名空间）"""
    if not ENABLE_CACHE:
        return
    _get_manager().set("fields", key, result, params=params)


def cleanup_expired_cache(cache_dir=None):
    """清理过期缓存（向后兼容）"""
    manager = _get_manager()
    if cache_dir and cache_dir != OCR_CACHE_DIR:
        # 对自定义目录执行旧式清理
        if not os.path.exists(cache_dir):
            return 0
        now = time.time()
        expire_seconds = CACHE_EXPIRE_DAYS * 86400
        count = 0
        try:
            for filename in os.listdir(cache_dir):
                filepath = os.path.join(cache_dir, filename)
                if os.path.isfile(filepath) and filename.endswith('.json'):
                    try:
                        if (now - os.path.getmtime(filepath)) > expire_seconds:
                            os.remove(filepath)
                            count += 1
                    except OSError:
                        pass
        except Exception:
            return 0
        return count
    return manager.cleanup_by_ttl()


def clear_ocr_cache():
    """清除所有缓存（向后兼容）"""
    return _get_manager().clear()


# =============================================================================
# v10 新增：缓存版本信息 API
# =============================================================================

def get_cache_version_info() -> Dict:
    """
    获取当前缓存版本信息，用于 API 响应返回。
    
    返回格式：
    {
        "cache_schema_version": "invoice-parse-v6.0.0",
        "engine_version": "v9.0.0",
        "extractor_version": "v6.0.0",
        "regex_version": "v3.2.0",
        "line_item_parser_version": "v10.0.0",
        "party_parser_version": "v4.1.0",
        "amount_parser_version": "v2.3.0",
        "version_key": "abc123def456..."
    }
    """
    return {
        **VERSION_METADATA,
        "version_key": get_version_key(),
    }


def get_cached_with_version(namespace: str, key: str, params: Optional[Dict] = None) -> Dict:
    """
    获取缓存数据并附带版本信息。
    
    返回格式：
    {
        "data": ...,
        "from_cache": true/false,
        "cache_schema_version": "invoice-parse-v6.0.0",
        ...其他版本信息...
    }
    """
    data = _get_manager().get(namespace, key, params)
    
    result = {
        **VERSION_METADATA,
        "data": data,
        "from_cache": data is not None,
    }
    
    return result
