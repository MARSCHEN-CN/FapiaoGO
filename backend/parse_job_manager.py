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
import logging
from dataclasses import dataclass, field, asdict
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
        """转换为字典（用于 JSON 序列化）"""
        return asdict(self)
    
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
        self._lock = Lock()
        self._jobs: Dict[str, ParseJob] = {}
        self._pending_save = False  # 延迟写入标记
        self._save_interval = 5     # 批量保存间隔（秒）
        self._last_save_time = 0    # 上次保存时间
        self._load()
    
    def _load(self):
        """从文件加载任务数据"""
        try:
            if os.path.exists(self.storage_path):
                with open(self.storage_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    for job_id, job_data in data.items():
                        self._jobs[job_id] = ParseJob(**job_data)
                logger.info(f"[JobStore] 加载了 {len(self._jobs)} 个任务")
            else:
                logger.info(f"[JobStore] 存储文件不存在，创建新存储")
                self._save()
        except Exception as e:
            logger.error(f"[JobStore] 加载任务数据失败: {e}")
            self._jobs = {}
    
    def _save(self):
        """保存任务数据到文件（紧凑格式，减少 I/O）"""
        try:
            os.makedirs(os.path.dirname(self.storage_path), exist_ok=True)
            data = {job_id: job.to_dict() for job_id, job in self._jobs.items()}
            with open(self.storage_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, separators=(',', ':'))  # 紧凑格式
            self._pending_save = False
            self._last_save_time = time.time()
        except Exception as e:
            logger.error(f"[JobStore] 保存任务数据失败: {e}")
    
    def _mark_dirty(self):
        """标记需要保存（延迟写入）"""
        self._pending_save = True
    
    def _flush_if_needed(self):
        """按需批量保存（超过间隔时间且有待保存数据）"""
        now = time.time()
        if self._pending_save and now - self._last_save_time >= self._save_interval:
            self._save()
    
    def add(self, job: ParseJob):
        """添加任务"""
        with self._lock:
            self._jobs[job.id] = job
            self._mark_dirty()  # 延迟写入
    
    def get(self, job_id: str) -> Optional[ParseJob]:
        """获取任务"""
        with self._lock:
            return self._jobs.get(job_id)
    
    def update(self, job: ParseJob, force_save: bool = False):
        """更新任务
        
        Args:
            job: 任务对象
            force_save: 是否立即保存（用于终态变更）
        """
        with self._lock:
            self._jobs[job.id] = job
            if force_save:
                self._save()  # 终态立即保存
            else:
                self._mark_dirty()  # 延迟写入
    
    def list_jobs(self, limit: int = 50, offset: int = 0) -> list:
        """列出任务（按创建时间倒序）"""
        with self._lock:
            sorted_jobs = sorted(
                self._jobs.values(),
                key=lambda j: j.created_at,
                reverse=True
            )
            return [job.to_dict() for job in sorted_jobs[offset:offset+limit]]
    
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
            if old_jobs:
                self._save()
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
            
            # 执行解析
            start_time = time.time()
            
            # 调用解析函数
            parse_func = job._parse_func
            parse_args = job._parse_args
            parse_kwargs = job._parse_kwargs
            
            # 执行解析并获取结果
            result = parse_func(*parse_args, **parse_kwargs)
            
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
            job.update_status('failed', progress=100, error=str(e))
            self.store.update(job, force_save=True)  # 终态立即保存
            logger.error(f"[JobManager] 任务失败: {job_id}, error={e}", exc_info=True)
        
        finally:
            with self._lock:
                self._active_tasks.pop(job_id, None)
    
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
            # 尝试取消 future，并标记取消标志
            cancelled = False
            with self._lock:
                future = self._futures.get(job_id)
                if future and not future.done():
                    cancelled = future.cancel()
                if job_id in self._active_tasks:
                    self._active_tasks[job_id] = False
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
job_manager = ParseJobManager(max_workers=min(_CPU_COUNT, 4), max_queue_size=100)
