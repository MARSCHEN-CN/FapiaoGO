# -*- coding: utf-8 -*-
"""
Import Scale v1 — 批量导入管理器

职责：
- 管理一次用户导入行为的完整生命周期（ImportBatch）
- 通过 ParseJobManager 调度单文件解析任务
- Batch Admission Control：窗口式提交，禁止一次塞满队列
- ResultBuffer：累积解析结果，50 条一次 batch_upsert
- SSE 兼容：to_dict() 输出可被 stream_export_progress() 消费

设计约束（Phase 1 护栏）：
- ImportBatch 只存聚合状态，禁止存 per-file 状态
- 不修改 parse_job_manager.py 的 worker 语义
- 不修改 db.py
- 不继承 ExportTask
"""

import uuid
import logging
import threading
import time
import io
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, List, Callable

from time_utils import now
from temp_file_registry import TempFileRegistry, get_temp_registry

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════
# 配置常量
# ═══════════════════════════════════════════════════════════

SUBMIT_WINDOW = 50          # 每轮最多提交的任务数
QUEUE_LOW_WATER = 20        # 队列低于此值时继续提交
RESULT_BUFFER_SIZE = 50     # 结果缓冲达到此数量时触发 batch_upsert
SCHEDULER_POLL_INTERVAL = 0.2  # 调度器轮询间隔（秒）


# ═══════════════════════════════════════════════════════════
# 数据模型
# ═══════════════════════════════════════════════════════════

@dataclass
class ImportBatch:
    """批量导入聚合状态（纯计数器，不持有文件列表）
    
    唯一事实源：
    - 单文件状态 → ParseJobManager / JobStore
    - 批次聚合 → 本对象
    
    job_ids 是任务引用索引（非 per-file 状态），用于结果查询时避免全表扫描。
    """
    id: str
    total: int
    status: str = 'queued'  # queued / running / completed / failed / cancelled
    success: int = 0
    failed: int = 0
    created_at: str = ''
    updated_at: str = ''
    error: str = ''
    job_ids: List[str] = field(default_factory=list)  # 关联的 ParseJob ID 列表
    file_inputs: List[Dict] = field(default_factory=list)  # IS-2：文件引用元数据(refId/clientKey)，不含字节内容

    def __post_init__(self):
        if not self.created_at:
            self.created_at = now().isoformat()
        if not self.updated_at:
            self.updated_at = now().isoformat()

    @property
    def finished(self) -> int:
        """已完成数（成功 + 失败）"""
        return self.success + self.failed

    @property
    def percent(self) -> int:
        """完成百分比 0-100"""
        if self.total == 0:
            return 0
        return int(self.finished * 100 / self.total)

    def to_dict(self) -> Dict[str, Any]:
        """SSE 兼容输出（可被 stream_export_progress 消费）
        
        stream_export_progress 检查 TaskStatus(state['status']) in _TERMINAL_STATUSES
        因此 status 必须为: pending/running/completed/failed/cancelled
        映射: queued → pending（TaskStatus 无 queued 值）
        """
        # 映射内部状态到 TaskStatus 兼容值
        status_map = {
            'queued': 'pending',
            'running': 'running',
            'completed': 'completed',
            'failed': 'failed',
            'cancelled': 'cancelled',
        }
        return {
            'taskId': self.id,
            'status': status_map.get(self.status, self.status),
            'total': self.total,
            'current': self.finished,
            'percent': self.percent,
            'successCount': self.success,
            'failCount': self.failed,
            'error': self.error,
            'createdAt': self.created_at,
            'updatedAt': self.updated_at,
        }

    def touch(self):
        """更新 updated_at 时间戳"""
        self.updated_at = now().isoformat()


# ═══════════════════════════════════════════════════════════
# 结果缓冲器
# ═══════════════════════════════════════════════════════════

class ResultBuffer:
    """解析结果缓冲：累积 db_record，达到阈值时批量写入 DB
    
    线程安全：由 ImportBatchManager 的锁保护。
    """

    def __init__(self, flush_size: int = RESULT_BUFFER_SIZE):
        self._buffer: List[Dict] = []
        self._flush_size = flush_size
        self._total_flushed = 0

    def add(self, db_record: Dict):
        """添加一条 db_record 到缓冲"""
        self._buffer.append(db_record)

    @property
    def size(self) -> int:
        return len(self._buffer)

    @property
    def total_flushed(self) -> int:
        return self._total_flushed

    def should_flush(self) -> bool:
        """是否达到 flush 阈值"""
        return len(self._buffer) >= self._flush_size

    def drain(self) -> List[Dict]:
        """取出全部缓冲内容并清空"""
        items = self._buffer
        self._buffer = []
        self._total_flushed += len(items)
        return items


# ═══════════════════════════════════════════════════════════
# 批量导入管理器
# ═══════════════════════════════════════════════════════════

class ImportBatchManager:
    """批量导入生命周期管理器
    
    调用链：
        前端 POST files
          → create_batch(file_inputs)
            → 创建 ImportBatch（聚合状态）
            → 启动 scheduler 线程
              → 窗口式 create_job + submit_job → ParseJobManager
                → Worker 执行 parse_invoice_service(skip_db_write=True)
                  → _on_job_done 回调
                    → 读取 result → ResultBuffer.add(db_record)
                    → buffer 满 → batch_upsert_invoices
                    → 更新 ImportBatch 计数
            → 全部完成 → flush 剩余 buffer → status='completed'
    
    状态源分离：
        - 单文件状态：ParseJobManager.store（JobStore）
        - 批次聚合：ImportBatch（本模块内存）
        - 解析结果：ocr_cache（由 ParseJobManager._execute_job 写入）
    """

    def __init__(self, job_manager):
        """
        Args:
            job_manager: ParseJobManager 实例（全局单例）
        """
        self._job_manager = job_manager
        self._batches: Dict[str, ImportBatch] = {}
        self._batch_lock = threading.Lock()  # 保护 _batches 和 ImportBatch 计数器
        # 每个 batch 的结果缓冲
        self._result_buffers: Dict[str, ResultBuffer] = {}
        # 调度器线程
        self._scheduler_threads: Dict[str, threading.Thread] = {}
        # 取消标志
        self._cancel_flags: Dict[str, bool] = {}

        # IS-3 P3-A：temp 文件所有权统一为跨端点单例 get_temp_registry()（R1 blocker 修复）。
        # /parse_invoice 与 /import/batch 共用同一 TempFileRegistry 实例，确保 spool 登记的
        # ref 与 release 查找落在同一 _records（INV-IS3-6 lifecycle mutation owner 唯一）。
        # 释放点仍由 Commit 5 接线（_on_job_done/cancel/cleanup），owner 关系不变。
        self._temp_registry = get_temp_registry()

        # 注册完成回调（ParseJobManager 每个 job 终态时触发）
        self._job_manager.on_job_complete(self._on_job_done)

        logger.info("[ImportBatch] 初始化完成")

    @property
    def temp_file_registry(self) -> TempFileRegistry:
        """供 app.py 在上传边界 spool 使用（opaque ref 入口）。"""
        return self._temp_registry

    # ─── 公开 API ───────────────────────────────────────────

    def create_batch(self, file_inputs: List[Dict],
                     auto_orient: bool = True,
                     enable_auto_ocr: bool = False) -> str:
        """创建批量导入任务

        Args:
            file_inputs: IS-2 起为 refId 形态：
                [{'refId': 'imp-xxx', 'filename': 'xxx.pdf', 'clientKey': '...'}, ...]
                兼容回退（Commit 3 删除）：也可含 'bytes'（旧路径/手动脚本）。
            auto_orient: 是否自动旋转
            enable_auto_ocr: 是否启用自动 OCR

        Returns:
            batch_id
        """
        batch_id = f"B{now().strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:6]}"

        # IS-2（Commit 3）：输入归一化为 refId 形态，manager 不再常驻 bytes。
        # 旧 bytes 形态（手动脚本 test_step2_batch.py）在边界立即 spool 为 temp 文件
        # 并替换为 refId，不进 RAM 峰值。此 transitional 分支在 IS-3 弃用 /parse_batch 时移除。
        normalized = []
        try:
            for fi in file_inputs:
                if 'refId' in fi:
                    normalized.append(fi)
                elif 'bytes' in fi:
                    # 兼容回退（IS-3 移除）：旧 bytes 形态在边界立即 spool 为 temp 文件
                    rec = self._temp_registry.spool(io.BytesIO(fi['bytes']), fi.get('filename', ''))
                    normalized.append({
                        'refId': rec.refId,
                        'filename': rec.filename,
                        'clientKey': fi.get('clientKey', ''),
                    })
                else:
                    raise ValueError(f"file input 必须含 refId 或 bytes: {fi}")
        except Exception:
            # 归一化失败：已 spool 的 temp 文件引用立即释放，避免孤立文件泄漏。
            # （例如 file_inputs 中第 N 个非法，前 N-1 个已 spool 的 ref 必须回收）
            for fi in normalized:
                ref = fi.get('refId')
                if ref:
                    self._temp_registry.release(ref)
            raise
        file_inputs = normalized
        total = len(file_inputs)

        batch = ImportBatch(id=batch_id, total=total, status='queued', file_inputs=file_inputs)

        with self._batch_lock:
            self._batches[batch_id] = batch
            self._result_buffers[batch_id] = ResultBuffer()
            self._cancel_flags[batch_id] = False

        # 启动调度器线程
        t = threading.Thread(
            target=self._scheduler_loop,
            args=(batch_id, auto_orient, enable_auto_ocr),
            daemon=True,
            name=f'BatchScheduler-{batch_id}',
        )
        self._scheduler_threads[batch_id] = t
        t.start()

        logger.info(f"[ImportBatch] 创建批次: {batch_id} (total={total})")
        return batch_id

    # ─── IS-2：ref → bytes 适配壳（Commit 3） ──────────────────

    def _parse_via_registry(self, input_ref: str, filename: str,
                            auto_orient: bool = True, enable_auto_ocr: bool = False,
                            skip_db_write: bool = False):
        """ref→bytes 适配壳：scheduler 只传 ref_id，此处按需读 temp 文件字节喂给 worker。

        IS-2（Commit 3）：
        - 这是"消灭生命周期级 bytes 持有"的关键边界——manager 调度时只搬运 refId，
          bytes 在真正进 worker 的前一刻才从 temp 文件读出（瞬时、不常驻）。
        - `parse_invoice_service` 签名保持不变（OCR 执行模型冻结，INV 边界不可破）。
        - 释放点（_on_job_done / cancel / cleanup / startup sweep）由 Commit 5 接线。
        """
        file_bytes = self._temp_registry.read_bytes(input_ref)
        from services.invoice_service import parse_invoice_service
        return parse_invoice_service(
            file_bytes, filename,
            auto_orient=auto_orient,
            enable_auto_ocr=enable_auto_ocr,
            skip_db_write=skip_db_write,
        )

    # ─── IS-2：temp 文件释放（Commit 5） ─────────────────────

    def _release_inputs(self, inputs):
        """释放一组 file input 的 temp 文件引用（按 refId）。幂等、可重入。

        IS-2 Commit 5（谁拥有 temp / 何时释放 temp）：集中释放点。调用方必须保证
        这些 ref 对应的 worker 已不会再去读取文件（pending / 已终态），否则会与 worker
        竞态删文件(FileNotFoundError)。释放点分布：
        - _on_job_done：释放单个已完成 job 的 ref（inflight 终态）
        - scheduler cancel 检测：释放尚未提交的 pending ref（scheduler 是这些 ref
          的唯一提交方，此刻绝无 worker 在读取）
        - scheduler 异常：释放尚未提交的 pending ref
        - cleanup_batch(terminal)：释放残留 pending ref
        """
        for fi in inputs:
            ref_id = fi.get('refId') if isinstance(fi, dict) else None
            if ref_id:
                self._temp_registry.release(ref_id)

    def get_batch(self, batch_id: str) -> Optional[ImportBatch]:
        """获取批次状态"""
        with self._batch_lock:
            return self._batches.get(batch_id)

    def get_batch_dict(self, batch_id: str) -> Optional[Dict[str, Any]]:
        """获取批次状态（dict 形式，供 SSE 使用）"""
        batch = self.get_batch(batch_id)
        if batch:
            with self._batch_lock:
                return batch.to_dict()
        return None

    def get_batch_results(self, batch_id: str) -> List[Dict[str, Any]]:
        """获取批次所有成功任务的解析结果
        
        用于前端 hydration：batch completed 后拉取字段数据。
        使用 batch.job_ids 索引，避免 JobStore 全表扫描。
        
        Returns:
            [{
                'clientKey': 'frontend_file_key',
                'jobId': 'job_id',
                'fileName': 'xxx.pdf',
                'fileHash': 'sha256...',
                'invoiceType': '专票',
                'invoiceNumber': 'xxx',
                'amount': 100.0,
                'invoiceDate': '2026-01-01',
                'invoiceFields': {...},
                'parseMethod': 'ocr',
                'failedFields': [],
            }, ...]
        """
        with self._batch_lock:
            batch = self._batches.get(batch_id)
            if not batch:
                return []
            job_ids = list(batch.job_ids)  # 复制，避免持锁遍历
        
        jm = self._job_manager
        items = []
        
        for job_id in job_ids:
            job_info = jm.get_job(job_id)
            if not job_info:
                continue
            if job_info.get('status') != 'success':
                continue
            
            result = jm.get_job_result(job_id)
            if not result:
                continue
            
            items.append({
                'clientKey': job_info.get('metrics', {}).get('client_key', ''),
                'jobId': job_id,
                'fileName': job_info.get('file_name', ''),
                'fileHash': job_info.get('file_hash', ''),
                'invoiceType': result.get('invoice_type', ''),
                'invoiceNumber': result.get('invoice_number', ''),
                'amount': result.get('amount'),
                'invoiceDate': result.get('invoice_date', ''),
                'invoiceFields': result.get('invoice_fields', {}),
                'parseMethod': result.get('parse_method', ''),
                'failedFields': result.get('failed_fields', []),
                'newName': result.get('new_name', ''),
                'previewImage': result.get('preview_image'),
            })
        
        return items

    def cancel_batch(self, batch_id: str) -> bool:
        """取消批次（停止调度 + 取消所有未完成 job）"""
        with self._batch_lock:
            batch = self._batches.get(batch_id)
            if not batch:
                return False
            if batch.status in ('completed', 'failed', 'cancelled'):
                return False
            self._cancel_flags[batch_id] = True
            batch.status = 'cancelled'
            batch.error = '用户取消'
            batch.touch()

        logger.info(f"[ImportBatch] 取消批次: {batch_id}")
        # 注意：已提交的 job 会由 ParseJobManager 的 cancel 机制处理
        # 调度器线程检测到 cancel_flag 后停止提交新 job
        return True

    # ─── 调度器（Admission Control）─────────────────────────

    def _scheduler_loop(self, batch_id: str, auto_orient: bool, enable_auto_ocr: bool):
        """窗口式调度：按 SUBMIT_WINDOW 分批提交，队列低于 LOW_WATER 时继续
        
        生命周期：
            queued → running → (全部提交完) → 等待完成 → completed/failed
        """
        jm = self._job_manager

        with self._batch_lock:
            batch = self._batches[batch_id]
            inputs = batch.file_inputs  # IS-2：refId 元数据随 batch 走，manager 无独立持有 dict
            batch.status = 'running'
            batch.touch()

        submitted = 0
        total = len(inputs)

        try:
            while submitted < total:
                # 检查取消
                if self._cancel_flags.get(batch_id, False):
                    logger.info(f"[ImportBatch] 调度器检测到取消: {batch_id}")
                    # 释放尚未提交的 pending 引用（scheduler 是这些 ref 的唯一提交方，
                    # 此刻它们绝无 worker 在读取，可安全删除）；已提交的 inflight 引用
                    # 交由 _on_job_done 在 worker 终态时释放，避免竞态删文件(FileNotFoundError)。
                    self._release_inputs(inputs[submitted:])
                    return

                # Admission Control：队列深度超过阈值时等待
                if jm.queue_size() >= QUEUE_LOW_WATER:
                    time.sleep(SCHEDULER_POLL_INTERVAL)
                    continue

                # 窗口提交
                window_end = min(submitted + SUBMIT_WINDOW, total)
                for i in range(submitted, window_end):
                    if self._cancel_flags.get(batch_id, False):
                        # 释放本窗口尚未提交的 pending 引用（inputs[i:]），已提交的 inflight
                        # 由 _on_job_done 释放（避免竞态删文件，见上方 while 顶部注释）。
                        self._release_inputs(inputs[i:])
                        return

                    fi = inputs[i]
                    ref_id = fi.get('refId')
                    if not ref_id:
                        raise KeyError(f"file input 缺少 refId: {fi}")
                    rec = self._temp_registry.get(ref_id)
                    if rec is None:
                        raise KeyError(f"refId not retained in registry: {ref_id}")
                    client_key = fi.get('clientKey', '')  # 护栏A：可选

                    # 创建 job（携带 batch_id）；file_hash 直接用 spool 物化的 sha256（INV-2，不重算）
                    job = jm.create_job(rec.filename, rec.sha256, batch_id=batch_id)

                    # 存储 clientKey 到 job.metrics（_execute_job 已修复为保留已有 key）
                    if client_key:
                        job.metrics['client_key'] = client_key

                    # IS-2 Commit 5：把 refId 随 job 携带，_on_job_done 释放时据其定位 temp 文件
                    job.metrics['ref_id'] = ref_id

                    # 记录 job_id 到批次索引（用于结果查询，避免全表扫描）
                    with self._batch_lock:
                        batch = self._batches.get(batch_id)
                        if batch:
                            batch.job_ids.append(job.id)

                    # 提交到 ParseJobManager：只传 ref_id，bytes 由 _parse_via_registry 适配壳
                    # 在 worker 边界按需读出（INV-1：manager 不再持 bytes；worker 签名不变）。
                    ok = jm.submit_job(
                        job, self._parse_via_registry,
                        ref_id, rec.filename,
                        auto_orient=auto_orient,
                        enable_auto_ocr=enable_auto_ocr,
                        skip_db_write=True,
                    )
                    if not ok:
                        # 队列满，等一轮再试
                        logger.warning(f"[ImportBatch] 队列满，暂停提交: {batch_id}")
                        break

                submitted = window_end

                # 释放已提交的文件引用（只留未提交的 refId 元数据，字节从不在 manager 常驻）
                with self._batch_lock:
                    batch = self._batches.get(batch_id)
                    if batch:
                        batch.file_inputs = inputs[submitted:]

            # 全部提交完成，清空文件引用元数据（bytes 早已不在 manager）
            with self._batch_lock:
                batch = self._batches.get(batch_id)
                if batch:
                    batch.file_inputs = []

            logger.info(f"[ImportBatch] 全部提交完成: {batch_id} ({submitted}/{total})")

            # 等待所有 job 完成（由 _on_job_done 回调驱动计数）
            self._wait_for_completion(batch_id)

        except Exception as e:
            logger.error(f"[ImportBatch] 调度器异常: {batch_id}: {e}", exc_info=True)
            # IS-2 Commit 5：调度异常时释放尚未提交的 pending 引用，避免 temp 文件泄漏
            self._release_inputs(inputs[submitted:])
            with self._batch_lock:
                batch = self._batches.get(batch_id)
                if batch and batch.status == 'running':
                    batch.status = 'failed'
                    batch.error = str(e)
                    batch.touch()

    def _wait_for_completion(self, batch_id: str):
        """轮询等待批次完成（所有 job 到达终态）"""
        while True:
            if self._cancel_flags.get(batch_id, False):
                return

            with self._batch_lock:
                batch = self._batches.get(batch_id)
                if not batch:
                    return
                if batch.status in ('completed', 'failed', 'cancelled'):
                    return
                finished = batch.finished
                total = batch.total

            if finished >= total:
                # 全部完成 → flush 剩余 buffer → 标记 completed
                self._flush_result_buffer(batch_id)
                with self._batch_lock:
                    batch = self._batches.get(batch_id)
                    if batch and batch.status == 'running':
                        if batch.failed > 0 and batch.success == 0:
                            batch.status = 'failed'
                            batch.error = '全部解析失败'
                        else:
                            batch.status = 'completed'
                        batch.touch()
                logger.info(
                    f"[ImportBatch] 批次完成: {batch_id} "
                    f"(success={batch.success}, failed={batch.failed})"
                )
                return

            time.sleep(SCHEDULER_POLL_INTERVAL)

    # ─── 完成回调 ───────────────────────────────────────────

    def _on_job_done(self, job_id: str, status: str):
        """ParseJobManager 完成回调（在 executor 回调线程中执行）
        
        职责：
        1. 读取解析结果 → 提取 db_record → 加入 ResultBuffer
        2. 更新 ImportBatch 聚合计数
        3. Buffer 满时触发 batch_upsert
        
        注意：必须线程安全、不可阻塞。
        """
        # 查找 job 所属 batch
        job_info = self._job_manager.get_job(job_id)
        if not job_info:
            return
        batch_id = job_info.get('batch_id', '')
        if not batch_id:
            return  # 非批量任务，忽略

        # IS-2 Commit 5：本 job 的 temp 文件引用在此释放（无论 success/failed/cancelled）。
        # 释放时机 = worker 已到达终态这一刻，故绝不会在 worker 仍在读取文件时删文件。
        # release() 幂等：即便完成回调被重复触发，也不会二次删除（INV-3）。
        ref_id = job_info.get('metrics', {}).get('ref_id')
        if ref_id:
            self._temp_registry.release(ref_id)

        # 读取解析结果（从 ocr_cache）
        db_record = None
        if status == 'success':
            result = self._job_manager.get_job_result(job_id)
            if result and isinstance(result, dict):
                db_record = result.get('db_record')

        # 更新聚合计数 + 缓冲结果
        should_flush = False
        with self._batch_lock:
            batch = self._batches.get(batch_id)
            if not batch:
                return

            # 护栏：已取消的批次忽略迟到回调（防止 cancelled → success++ 状态污染）
            # 场景：用户取消后，正在运行的 OCR 非 cooperative cancel，完成后回调到达
            if batch.status == 'cancelled':
                logger.debug(f"[ImportBatch] 忽略已取消批次的回调: {batch_id}, job={job_id}")
                return

            if status == 'success':
                batch.success += 1
            else:
                batch.failed += 1
            batch.touch()

            # 加入结果缓冲
            if db_record:
                buf = self._result_buffers.get(batch_id)
                if buf:
                    buf.add(db_record)
                    should_flush = buf.should_flush()

        # 在锁外执行 DB 写入（避免持锁时间过长）
        if should_flush:
            self._flush_result_buffer(batch_id)

    # ─── 结果写入 ───────────────────────────────────────────

    def _flush_result_buffer(self, batch_id: str):
        """将缓冲的 db_record 批量写入 DB"""
        with self._batch_lock:
            buf = self._result_buffers.get(batch_id)
            if not buf or buf.size == 0:
                return
            records = buf.drain()

        if not records:
            return

        try:
            import db as db_module
            results = db_module.batch_upsert_invoices(records)
            logger.info(
                f"[ImportBatch] 批量入库: batch={batch_id}, "
                f"count={len(records)}, flushed_total={buf.total_flushed}"
            )
        except Exception as e:
            logger.error(f"[ImportBatch] 批量入库失败: batch={batch_id}: {e}")
            # 入库失败不阻塞批次完成（结果已在 ocr_cache 中，可重试）

    # ─── 清理 ───────────────────────────────────────────────

    def cleanup_batch(self, batch_id: str):
        """清理已完成批次的运行时数据（SSE 断开后调用）。

        IS-2 Commit 5（谁拥有 temp / 何时释放 temp）：
        - 仅对已终态(terminal: completed/failed/cancelled)批次释放残留 pending 引用——
          这些引用从未被 scheduler 提交，绝无 worker 在读取，可安全删除。
        - 仍在运行(running/queued)的批次其 temp 文件由 scheduler / _on_job_done 拥有，
          此处不碰，否则会与正在提交的 worker 竞态删文件(FileNotFoundError)。
        - _batches 保留（供 get_batch 查询历史状态）。
        - startup sweep / TTL 属 IS-4，不在本 commit 范围。
        """
        with self._batch_lock:
            batch = self._batches.get(batch_id)
            if batch and batch.status in ('completed', 'failed', 'cancelled'):
                pending = list(batch.file_inputs)  # 已终态：残留 pending 可安全释放
            else:
                pending = []  # 运行态：scheduler 仍持有，禁止此处释放
            self._result_buffers.pop(batch_id, None)
            self._cancel_flags.pop(batch_id, None)
            self._scheduler_threads.pop(batch_id, None)
        # 在锁外释放（registry.release 幂等，重复释放无害）
        self._release_inputs(pending)

    def shutdown(self):
        """关闭管理器（取消所有活跃批次）"""
        with self._batch_lock:
            active_ids = [
                bid for bid, b in self._batches.items()
                if b.status in ('queued', 'running')
            ]
        for bid in active_ids:
            self.cancel_batch(bid)
        logger.info("[ImportBatch] 已关闭")


# ═══════════════════════════════════════════════════════════
# 全局单例
# ═══════════════════════════════════════════════════════════

_import_batch_manager: Optional[ImportBatchManager] = None
_import_batch_lock = threading.Lock()


def get_import_batch_manager() -> ImportBatchManager:
    """获取全局 ImportBatchManager 单例（惰性初始化）"""
    global _import_batch_manager
    if _import_batch_manager is None:
        with _import_batch_lock:
            if _import_batch_manager is None:
                from parse_job_manager import get_job_manager
                _import_batch_manager = ImportBatchManager(get_job_manager())
    return _import_batch_manager
