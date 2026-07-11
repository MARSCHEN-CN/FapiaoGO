# -*- coding: utf-8 -*-
"""
发票解析任务队列管理器

提供异步任务管理功能：
- 任务创建、查询、取消
- 并发控制（ThreadPoolExecutor）
- 任务状态跟踪（pending/running/success/failed/cancelled）
- 进度报告
- 结果缓存
"""

import os
import uuid
import json
import time
import bisect
import logging
from dataclasses import dataclass, field
from time_utils import now, now_timestamp
from queue import Queue
from concurrent.futures import ThreadPoolExecutor, Future
from typing import Optional, Dict, Any
from threading import Lock
from pathlib import Path

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════
# 数据模型
# ═══════════════════════════════════════════════════════════

@dataclass
class ParseJob:
    """解析任务数据模型"""
    id: str
    file_name: str
    file_hash: str
    status: str  # pending/running/success/failed/cancelled
    progress: int = 0  # 0-100
    error: str = ''
    result_id: str = ''  # 解析结果在缓存中的 key
    created_at: str = ''
    updated_at: str = ''
    
    # 性能指标
    metrics: Dict[str, Any] = field(default_factory=dict)
    
    def __post_init__(self):
        if not self.created_at:
            self.created_at = now().isoformat()
        if not self.updated_at:
            self.updated_at = now().isoformat()
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典（用于 JSON 序列化）

        显式构造、仅浅拷贝，避免 dataclasses.asdict 的递归深拷贝开销
        （asdict 会逐层深复制 metrics 等嵌套结构，list_jobs 每次调用都要付出）。
        """
        return {
            'id': self.id,
            'file_name': self.file_name,
            'file_hash': self.file_hash,
            'status': self.status,
            'progress': self.progress,
            'error': self.error,
            'result_id': self.result_id,
            'created_at': self.created_at,
            'updated_at': self.updated_at,
            'metrics': dict(self.metrics),  # 浅拷贝，防调用方误改 job.metrics
        }
    
    def update_status(self, status: str, progress: Optional[int] = None, error: str = ''):
        """更新任务状态"""
        self.status = status
        self.updated_at = now().isoformat()
        if progress is not None:
            self.progress = progress
        if error:
            self.error = error


# ═══════════════════════════════════════════════════════════
# 任务存储（JSON 文件持久化）
# ═══════════════════════════════════════════════════════════

class JobStore:
    """任务存储管理器（基于 JSON 文件）"""
    
    def __init__(self, storage_path: str = None):
        if storage_path is None:
            backend_dir = os.path.dirname(os.path.abspath(__file__))
            project_root = os.path.dirname(backend_dir)
            database_dir = os.path.join(project_root, 'database')
            storage_path = os.path.join(database_dir, 'parse_jobs.json')
        
        self.storage_path = storage_path
        self._oplog_path = storage_path + '.oplog'  # 增量操作日志（append-only）
        self._lock = Lock()
        self._jobs: Dict[str, ParseJob] = {}
        # 维护按 created_at 升序的有序表 [(created_at, job_id), ...]，
        # list_jobs 倒序遍历即得「最新优先」且无需每次全量排序（O(limit)）。
        self._job_order: list = []
        self._pending_save = False  # 延迟写入标记
        self._dirty_ids: set = set()  # 待刷盘的脏任务 id（用于增量追加）
        self._save_interval = 5     # 批量保存间隔（秒）
        self._last_save_time = 0    # 上次保存时间
        self._oplog_count = 0       # oplog 当前条目数
        self._compact_threshold = 200            # oplog 条目数超过此值触发压缩
        self._compact_max_bytes = 1024 * 1024    # 或 oplog 体积超过 1MB 触发压缩
        self._load()
    
    def _load(self):
        """从快照 + oplog 加载任务数据

        加载顺序：先读全量快照 parse_jobs.json（上一次压缩的产物），
        再回放增量日志 parse_jobs.json.oplog 得到最新状态。
        回放时跳过损坏行，保证进程崩溃后仍可恢复。
        """
        try:
            if os.path.exists(self.storage_path):
                with open(self.storage_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    for job_id, job_data in data.items():
                        self._jobs[job_id] = ParseJob(**job_data)
                logger.info(f"[JobStore] 加载快照: {len(self._jobs)} 个任务")
            else:
                logger.info(f"[JobStore] 存储文件不存在，创建新存储")
                self._write_snapshot()

            # 回放增量日志
            if os.path.exists(self._oplog_path):
                with open(self._oplog_path, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except Exception:
                            continue  # 跳过损坏/截断的行
                        op = entry.get('op')
                        jid = entry.get('id')
                        if op == 'put' and jid and entry.get('data') is not None:
                            try:
                                self._jobs[jid] = ParseJob(**entry['data'])
                            except Exception:
                                continue
                        elif op == 'del' and jid:
                            self._jobs.pop(jid, None)
                        self._oplog_count += 1
                logger.info(f"[JobStore] 回放 oplog: {self._oplog_count} 条")

            # 从最终状态重建有序表（启动期一次性 O(n log n)，热路径不再排序）
            self._job_order = sorted(
                ((j.created_at, jid) for jid, j in self._jobs.items()),
                key=lambda x: x[0],
            )
        except Exception as e:
            logger.error(f"[JobStore] 加载任务数据失败: {e}")
            self._jobs = {}
            self._job_order = []
    
    def _write_snapshot(self):
        """写全量快照到 parse_jobs.json（原子替换，崩溃安全）

        此即「压缩」产物：oplog 增量日志累积到阈值后由 _maybe_compact_locked 调用，
        将内存最新状态落盘为单一文件，随后清空 oplog。
        """
        try:
            os.makedirs(os.path.dirname(self.storage_path), exist_ok=True)
            data = {job_id: job.to_dict() for job_id, job in self._jobs.items()}
            tmp = self.storage_path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, separators=(',', ':'))  # 紧凑格式
            os.replace(tmp, self.storage_path)  # 原子替换，避免写一半崩溃导致文件损坏
        except Exception as e:
            logger.error(f"[JobStore] 写快照失败: {e}")

    def _append_op(self, op: str, job_id: str, job_data: Optional[dict] = None):
        """追加一条增量操作到 oplog（O(1)，不再全量重写文件）

        caller 必须持有 self._lock。
        """
        entry = {'op': op, 'id': job_id}
        if job_data is not None:
            entry['data'] = job_data
        line = json.dumps(entry, ensure_ascii=False, separators=(',', ':')) + '\n'
        try:
            os.makedirs(os.path.dirname(self._oplog_path), exist_ok=True)
            with open(self._oplog_path, 'a', encoding='utf-8') as f:
                f.write(line)
            self._oplog_count += 1
        except Exception as e:
            # oplog 不可用时降级：直接落全量快照并清空 oplog，保证不丢数据
            logger.error(f"[JobStore] 追加 oplog 失败，降级为全量快照: {e}")
            try:
                self._write_snapshot()
                open(self._oplog_path, 'w', encoding='utf-8').close()
                self._oplog_count = 0
            except Exception as e2:
                logger.error(f"[JobStore] 降级快照也失败: {e2}")

    def _maybe_compact_locked(self):
        """oplog 达到阈值时压缩：写快照 + 清空 oplog。caller 必须持有 self._lock。"""
        try:
            size = os.path.getsize(self._oplog_path) if os.path.exists(self._oplog_path) else 0
        except OSError:
            size = 0
        if self._oplog_count >= self._compact_threshold or size >= self._compact_max_bytes:
            self._write_snapshot()
            try:
                open(self._oplog_path, 'w', encoding='utf-8').close()  # 先快照后清空，保证一致
                self._oplog_count = 0
            except Exception as e:
                logger.error(f"[JobStore] 清空 oplog 失败: {e}")

    def _mark_dirty(self, job_id: Optional[str] = None):
        """标记需要保存（延迟写入）"""
        self._pending_save = True
        if job_id is not None:
            self._dirty_ids.add(job_id)

    def _flush_if_needed(self):
        """按需批量保存（超过间隔时间且有待保存数据）

        只把脏任务增量追加到 oplog，不重写全量文件；触发压缩阈值时由
        _maybe_compact_locked 写一次快照。
        """
        with self._lock:
            now = time.time()
            if self._pending_save and now - self._last_save_time >= self._save_interval:
                for jid in self._dirty_ids:
                    job = self._jobs.get(jid)
                    if job is not None:
                        self._append_op('put', jid, job.to_dict())
                self._dirty_ids.clear()
                self._pending_save = False
                self._last_save_time = now
                self._maybe_compact_locked()
    
    def add(self, job: ParseJob):
        """添加任务"""
        with self._lock:
            self._jobs[job.id] = job
            bisect.insort(self._job_order, (job.created_at, job.id))
            self._append_op('put', job.id, job.to_dict())  # 增量追加，无需全量重写
            self._maybe_compact_locked()
    
    def get(self, job_id: str) -> Optional[ParseJob]:
        """获取任务"""
        with self._lock:
            return self._jobs.get(job_id)
    
    def update(self, job: ParseJob, force_save: bool = False):
        """更新任务

        Args:
            job: 任务对象
            force_save: 是否立即持久化（用于终态变更）。
                无论是否 force，均采用 oplog 增量追加；
                force 表示立即落盘（追加一行），非 force 则进入延迟刷盘窗口。
        """
        with self._lock:
            self._jobs[job.id] = job
            if force_save:
                self._append_op('put', job.id, job.to_dict())  # 终态：增量追加（O(1)）
                self._maybe_compact_locked()
            else:
                self._mark_dirty(job.id)  # 延迟写入
    
    def list_jobs(self, limit: int = 50, offset: int = 0) -> list:
        """列出任务（按创建时间倒序）

        直接倒序遍历 _job_order（按 created_at 升序维护），切片后即得最新优先，
        避免每次调用对全量任务做 sorted() 全量排序；复杂度为 O(limit)。
        """
        with self._lock:
            n = len(self._job_order)
            end = n - offset
            if end <= 0:
                return []
            start = max(0, end - limit)
            window = self._job_order[start:end]   # 升序窗口
            window.reverse()                        # 降序：最新优先
            return [self._jobs[jid].to_dict() for _, jid in window]
    
    def cleanup_old_jobs(self, max_age_hours: int = 24) -> int:
        """清理旧任务（保留最近的任务）"""
        from time_utils import from_isoformat, to_timestamp
        with self._lock:
            cutoff = now_timestamp() - (max_age_hours * 3600)
            old_jobs = [
                job_id for job_id, job in self._jobs.items()
                if to_timestamp(from_isoformat(job.created_at)) < cutoff
                and job.status in ('success', 'failed', 'cancelled')
            ]
            for job_id in old_jobs:
                del self._jobs[job_id]
                self._append_op('del', job_id)  # 增量记录删除
            # 重建有序表（仅在清理这种低频路径做全量重排，热路径 list_jobs 不再排序）
            self._job_order = sorted(
                ((j.created_at, jid) for jid, j in self._jobs.items()),
                key=lambda x: x[0],
            )
            if old_jobs:
                self._maybe_compact_locked()  # 删除较多时顺带压缩
                logger.info(f"[JobStore] 清理了 {len(old_jobs)} 个旧任务")
            return len(old_jobs)


# ═══════════════════════════════════════════════════════════
# 任务队列管理器
# ═══════════════════════════════════════════════════════════

class ParseJobManager:
    """解析任务队列管理器
    
    执行模型：
    - QueueProcessor 线程：从队列取任务，提交到 ThreadPoolExecutor
    - ThreadPoolExecutor：并发执行解析任务（默认 4 个 worker）
    - 支持任务取消、状态追踪、结果缓存
    """
    
    def __init__(self, max_workers: int = 4, max_queue_size: int = 100):
        self.store = JobStore()
        self.queue = Queue(maxsize=max_queue_size)
        self.executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix='ParseWorker'
        )
        self._active_tasks: Dict[str, bool] = {}  # 用于取消任务
        self._cancel_flags: Dict[str, bool] = {}  # 取消标志，供执行中的任务检查
        self._futures: Dict[str, Future] = {}  # 追踪提交的 future，用于取消
        self._lock = Lock()
        
        # 启动队列处理器
        self._start_queue_processor()
        
        logger.info(f"[JobManager] 初始化完成 (workers={max_workers}, queue_size={max_queue_size})")
    
    def _start_queue_processor(self):
        """启动队列处理线程
        
        QueueProcessor 线程负责：
        1. 从 Queue 取出 job_id
        2. 检查任务状态（pending 才执行）
        3. 提交到 ThreadPoolExecutor 并发执行
        4. 注册回调：任务完成后清理状态 + 批量刷盘
        """
        def process_queue():
            while True:
                try:
                    job_id = self.queue.get()
                    if job_id is None:  # 退出信号
                        break
                    
                    job = self.store.get(job_id)
                    if job and job.status == 'pending':
                        # 提交到线程池并发执行
                        future = self.executor.submit(self._execute_job, job)
                        with self._lock:
                            self._futures[job_id] = future
                        # 注册完成回调
                        future.add_done_callback(
                            lambda f, jid=job_id: self._on_job_done(jid)
                        )
                    
                    self.queue.task_done()
                except Exception as e:
                    logger.error(f"[JobManager] 队列处理异常: {e}")
        
        # 启动一个后台线程处理队列
        import threading
        self._queue_thread = threading.Thread(target=process_queue, daemon=True, name='QueueProcessor')
        self._queue_thread.start()
    
    def create_job(self, file_name: str, file_hash: str) -> ParseJob:
        """创建新的解析任务"""
        job = ParseJob(
            id=str(uuid.uuid4()),
            file_name=file_name,
            file_hash=file_hash,
            status='pending',
            progress=0
        )
        self.store.add(job)
        logger.info(f"[JobManager] 创建任务: {job.id} ({file_name})")
        return job
    
    def submit_job(self, job: ParseJob, parse_func, *args, **kwargs):
        """提交任务到队列"""
        # 存储解析函数和参数
        job._parse_func = parse_func
        job._parse_args = args
        job._parse_kwargs = kwargs
        
        try:
            self.queue.put_nowait(job.id)
            logger.info(f"[JobManager] 提交任务到队列: {job.id}")
        except Exception as e:
            job.update_status('failed', error=f'队列已满，请稍后重试')
            self.store.update(job, force_save=True)  # 终态立即保存
            logger.error(f"[JobManager] 提交任务失败: {e}")
    
    def _execute_job(self, job: ParseJob):
        """执行解析任务（在线程池中）"""
        job_id = job.id

        with self._lock:
            self._active_tasks[job_id] = True

        try:
            # 更新状态为 running
            job.update_status('running', progress=10)
            self.store.update(job)

            # 关键检查点①：执行前再次确认未被取消
            # （cancel 可能发生在任务提交之后、worker 真正开始之前）
            if self._is_cancelled(job_id):
                self._finalize_cancelled(job)
                return

            # 执行解析
            start_time = time.time()

            # 调用解析函数
            parse_func = job._parse_func
            parse_args = job._parse_args
            parse_kwargs = job._parse_kwargs

            # 执行解析并获取结果（阻塞调用，无法被 future.cancel 中断）
            result = parse_func(*parse_args, **parse_kwargs)

            # 关键检查点②：阻塞调用返回后再次确认取消标志
            # future.cancel() 只能取消尚未开始执行的任务；已进入 worker 线程的任务
            # 必须在此处检查标志，确保「取消」优先于 success/failed，避免覆盖状态。
            if self._is_cancelled(job_id):
                self._finalize_cancelled(job)
                return

            elapsed = time.time() - start_time

            if result is None:
                job.update_status('failed', progress=100, error='解析失败：无法识别文件')
            else:
                # 保存结果
                result_id = f"result_{job_id}"
                job.result_id = result_id
                job.update_status('success', progress=100)

                # 记录性能指标
                job.metrics = {
                    'elapsed_seconds': round(elapsed, 2),
                    'file_size': parse_kwargs.get('file_size', 0),
                    'parse_method': result.get('parse_method', 'unknown'),
                }

                # 缓存结果
                from cache import set_ocr_cache
                set_ocr_cache(result_id, result)

            self.store.update(job, force_save=True)  # 终态立即保存
            logger.info(f"[JobManager] 任务完成: {job_id} (status={job.status}, elapsed={elapsed:.2f}s)")

        except Exception as e:
            # 若已取消，则不覆盖为 failed
            if self._is_cancelled(job_id):
                self._finalize_cancelled(job)
                return
            job.update_status('failed', progress=100, error=str(e))
            self.store.update(job, force_save=True)  # 终态立即保存
            logger.error(f"[JobManager] 任务失败: {job_id}, error={e}", exc_info=True)

        finally:
            with self._lock:
                self._active_tasks.pop(job_id, None)
                self._cancel_flags.pop(job_id, None)  # 清理取消标志

    def _is_cancelled(self, job_id: str) -> bool:
        """读取取消标志（线程安全）"""
        with self._lock:
            return self._cancel_flags.get(job_id, False)

    def _finalize_cancelled(self, job: ParseJob):
        """将任务收敛为 cancelled 状态并落盘（幂等）"""
        job.update_status('cancelled', error='任务已取消')
        self.store.update(job, force_save=True)
        logger.info(f"[JobManager] 任务已在执行中被取消: {job.id}")
    
    def cancel_job(self, job_id: str) -> bool:
        """取消任务
        
        取消策略：
        - pending：直接标记为 cancelled（还未进入线程池）
        - running：尝试取消 future，并标记取消标志（执行器内部检查）
        """
        job = self.store.get(job_id)
        if not job:
            return False
        
        if job.status == 'pending':
            # 从队列中移除（标记为 cancelled）
            job.update_status('cancelled', error='任务已取消')
            self.store.update(job, force_save=True)  # 终态立即保存
            logger.info(f"[JobManager] 取消 pending 任务: {job_id}")
            return True
        
        elif job.status == 'running':
            # 尝试取消 future（仅对尚未开始执行的任务有效），
            # 同时设置取消标志供执行中的任务在关键检查点读取。
            cancelled = False
            with self._lock:
                self._cancel_flags[job_id] = True  # 供 _execute_job 检查
                future = self._futures.get(job_id)
                if future and not future.done():
                    cancelled = future.cancel()
            job.update_status('cancelled', error='任务已取消')
            self.store.update(job, force_save=True)  # 终态立即保存
            logger.info(f"[JobManager] 取消 running 任务: {job_id}, future_cancelled={cancelled}")
            return True
        
        return False
    
    def _on_job_done(self, job_id: str):
        """任务完成回调（在线程池的回调线程中执行）
        
        负责：
        1. 清理 _futures 追踪
        2. 触发批量刷盘
        """
        with self._lock:
            self._futures.pop(job_id, None)
        # 检查是否需要批量保存
        self.store._flush_if_needed()
    
    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        """获取任务状态"""
        job = self.store.get(job_id)
        if job:
            return job.to_dict()
        return None
    
    def get_job_result(self, job_id: str) -> Optional[Dict[str, Any]]:
        """获取任务结果"""
        job = self.store.get(job_id)
        if not job or job.status != 'success' or not job.result_id:
            return None
        
        from cache import get_ocr_cache
        result = get_ocr_cache(job.result_id)
        return result
    
    def list_jobs(self, limit: int = 50, offset: int = 0) -> list:
        """列出任务"""
        return self.store.list_jobs(limit, offset)
    
    def shutdown(self):
        """关闭任务管理器"""
        logger.info("[JobManager] 关闭中...")
        self.queue.put(None)  # 发送退出信号
        self.executor.shutdown(wait=False)
        logger.info("[JobManager] 已关闭")


# ═══════════════════════════════════════════════════════════
# 全局单例
# ═══════════════════════════════════════════════════════════

# 默认配置：自适应并发 worker（至少 2，最多 4），队列最大 100 个任务
_CPU_COUNT = os.cpu_count() or 1

# 全局单例（惰性初始化）：模块被 import 时不立即构造，避免 import 链
# （如 app.py 顶层 `from parse_job_manager import job_manager`）在加载期就拉起
# ThreadPoolExecutor、启动队列处理线程并加载任务存储文件。仅在首次
# get_job_manager() 调用时才真正创建实例。
_job_manager_singleton = None
_job_manager_lock = Lock()

def get_job_manager() -> 'ParseJobManager':
    """获取全局任务管理器单例（线程安全惰性初始化）"""
    global _job_manager_singleton
    if _job_manager_singleton is None:
        with _job_manager_lock:
            if _job_manager_singleton is None:  # 双重检查锁定，防并发重复构造
                _job_manager_singleton = ParseJobManager(
                    max_workers=min(_CPU_COUNT, 4), max_queue_size=100
                )
    return _job_manager_singleton
