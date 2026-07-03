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
        # 内存中的命中计数器（避免每次 get 都写文件）
        self._hit_counters: Dict[str, int] = {}
        self._stats_cache: Dict[str, Dict] = {}

        # ✅ 惰性清理：每 N 次写入才做一次目录遍历
        self._write_counter = 0
        self._cleanup_interval = 10  # 每 10 次 set() 扫描一次

        # 确保 namespace 子目录存在
        for ns in self.NAMESPACES:
            os.makedirs(os.path.join(self.base_dir, ns), exist_ok=True)
        os.makedirs(os.path.join(self.base_dir, self.LEGACY_DIR), exist_ok=True)

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

        # 更新内存命中计数器（加锁保护 RMW 操作）
        counter_key = f"{namespace}:{key}"
        with self._counter_lock:
            self._hit_counters[counter_key] = self._hit_counters.get(counter_key, 0) + 1
            hits = self._hit_counters[counter_key]

        # 每 10 次命中刷盘一次（更新 accessed_at 和 hit_count）
        if hits % 10 == 0 and meta:
            self._flush_meta(path, entry)

        logger.debug("[Cache] 命中 %s/%s (hits=%d)", namespace, key[:16], hits)
        return data

    def _flush_meta(self, path: str, entry: Dict):
        """刷写元数据到磁盘"""
        try:
            meta = entry.get('__meta__', {})
            meta['accessed_at'] = now().isoformat()
            # 加锁读取命中计数（避免并发修改）
            with self._counter_lock:
                counter_value = self._hit_counters.get(
                    f"{meta.get('namespace', '')}:{meta.get('key', '')}", 0)
            meta['hit_count'] = meta.get('hit_count', 0) + counter_value
            entry['__meta__'] = meta

            with self._lock:
                with tempfile.NamedTemporaryFile(
                    mode='w', suffix='.json', dir=os.path.dirname(path),
                    encoding='utf-8', delete=False
                ) as f:
                    f.write(_json_dumps(entry))
                    temp_path = f.name
                os.replace(temp_path, path)
        except (IOError, OSError) as e:
            logger.warning("[Cache] 刷写元数据失败: %s", e)

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
                with tempfile.NamedTemporaryFile(
                    mode='w', suffix='.json', dir=ns_dir,
                    encoding='utf-8', delete=False
                ) as f:
                    f.write(_json_dumps(entry))
                    temp_path = f.name
                os.replace(temp_path, path)

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
        logger.info("[Cache] 失效 namespace=%s, 删除 %d 个文件", namespace, count)
        return count

    def cleanup_by_ttl(self) -> int:
        """按 TTL 清理过期缓存（外部调用接口，自动加锁）"""
        with self._lock:
            return self._cleanup_by_ttl_locked()

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

        注意：定时清理靠外部调用方（如 cleanup_by_ttl）补充。
        """
        self._write_counter += 1
        if self._write_counter % self._cleanup_interval != 0:
            return  # ✅ 跳过扫描，仅计数

        # try_lock 模式：获取不到锁时跳过本次清理，不阻塞 get/set
        if not self._lock.acquire(blocking=False):
            logger.debug("[Cache] 容量清理被跳过（锁被占用）")
            return

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
                                all_files.append((filepath, mtime, size))
                            except OSError:
                                pass
                except OSError:
                    pass

            # 3. 检查体积
            total_size = sum(f[2] for f in all_files)

            # 4. 收集待删除文件
            files_to_delete = set()

            # 按数量限制
            if total_count > self.max_files:
                for f in sorted(all_files, key=lambda x: x[1])[:total_count - self.max_files]:
                    files_to_delete.add(f[0])

            # 按体积限制
            if total_size > self.max_bytes:
                sorted_files = sorted(all_files, key=lambda x: x[1])
                freed = 0
                target_freed = total_size - self.max_bytes
                for filepath, mtime, size in sorted_files:
                    if freed >= target_freed:
                        break
                    files_to_delete.add(filepath)
                    freed += size

            # 5. 执行删除
            for filepath in files_to_delete:
                try:
                    os.remove(filepath)
                except OSError:
                    pass

            if files_to_delete:
                logger.debug("[Cache] 容量清理: 删除 %d 个文件", len(files_to_delete))
        finally:
            self._lock.release()

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
                                os.remove(filepath)
                                count += 1
                        except OSError:
                            pass
            except OSError:
                pass

        if count > 0:
            logger.info("[Cache] TTL 清理: 删除 %d 个过期文件", count)
        return count

    def stats(self) -> Dict:
        """返回缓存统计信息"""
        result = {'namespaces': {}, 'total_files': 0, 'total_size': 0, 'total_hits': 0}

        all_dirs = self.NAMESPACES + [self.LEGACY_DIR]

        for ns in all_dirs:
            ns_dir = self._ns_dir(ns)
            if not os.path.exists(ns_dir):
                continue

            ns_files = 0
            ns_size = 0
            ns_hits = 0

            try:
                for filename in os.listdir(ns_dir):
                    if filename.endswith('.json'):
                        filepath = os.path.join(ns_dir, filename)
                        try:
                            ns_files += 1
                            ns_size += os.path.getsize(filepath)
                            # 尝试从元数据中读取 hit_count
                            try:
                                with open(filepath, 'r', encoding='utf-8') as f:
                                    entry = _json_loads(f.read())
                                if isinstance(entry, dict) and '__meta__' in entry:
                                    ns_hits += entry['__meta__'].get('hit_count', 0)
                            except (json.JSONDecodeError, ValueError, IOError):
                                pass
                        except OSError:
                            pass
            except OSError:
                pass

            # 加上内存中的命中计数（加锁保护，避免遍历过程中被并发修改）
            with self._counter_lock:
                hit_counters_snapshot = dict(self._hit_counters.items())
            for counter_key, count in hit_counters_snapshot.items():
                if counter_key.startswith(f"{ns}:"):
                    ns_hits += count

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
