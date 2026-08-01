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
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, List, Callable

from time_utils import now
from temp_file_registry import TempFileRegistry, get_temp_registry
from config import ENABLE_IMPORT_WARMUP

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
    assembled_documents: List[Dict] = field(default_factory=list)  # 13-D.2：组装后的 InvoiceDocument 元信息（供前端 E-2.2 消费）

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

    # P6-C：终态批次保留窗口（小时），超时后由 evict_old_batches 回收。
    # running/queued 永不回收，保证活跃批次的 GET /import/batch/{id} 历史语义。
    _TERMINAL_EVICT_HOURS = {'completed': 0.5, 'failed': 2.0, 'cancelled': 10 / 60}

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

        # P10 Phase A: Preview Warmup Planner (lazy init — uses global render_engine singletons)
        self._warm_planner: Optional["WarmPlanner"] = None

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
                IS-3 起不再接受 bytes（仅 refId 形态）。
            auto_orient: 是否自动旋转
            enable_auto_ocr: 是否启用自动 OCR

        Returns:
            batch_id
        """
        batch_id = f"B{now().strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:6]}"

        # IS-3：/parse_batch 退役后，create_batch 只接受 refId 形态（INV-IS3-1）。
        # manager 不再在边界 spool bytes，调用方（/import/batch）已先行 spool 并传入 refId。
        normalized = []
        for fi in file_inputs:
            if 'refId' not in fi:
                raise ValueError(f"file input 必须含 refId: {fi}")
            normalized.append(fi)
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
        result = parse_invoice_service(
            file_bytes, filename,
            auto_orient=auto_orient,
            enable_auto_ocr=enable_auto_ocr,
            skip_db_write=skip_db_write,
        )
        # 注册到 Render Engine，使 /preview/{doc_id} 可服务，并回传 doc_id 供前端建链。
        # registry.open 幂等（content-hash → doc_id），重复注册返回已有条目。
        # 注册失败不阻塞解析主路径（图片/OFD 仍走 legacy 预览）。
        if result is not None:
            try:
                from render_engine import registry as re_registry
                doc = re_registry.open(file_bytes, filename=filename)
                result['doc_id'] = doc.doc_id
                # P10 Phase A: fire-and-forget preview warmup (non-blocking, best-effort)
                # P1: 受 ENABLE_IMPORT_WARMUP 控制（默认关）。warm 仅 cache warming，
                # 关闭后预览走 on-demand render，功能不受影响。WarmPlanner 能力保留。
                try:
                    if ENABLE_IMPORT_WARMUP:
                        if self._warm_planner is None:
                            from render_engine import engine, render_cache, render_queue
                            from render_engine.warmup import WarmPlanner
                            self._warm_planner = WarmPlanner(engine, render_queue, render_cache)
                        self._warm_planner.warm_after_import([
                            {"doc_id": doc.doc_id, "page_count": doc.page_count},
                        ])
                except Exception:
                    logger.debug("[ImportBatch] warmup skipped (non-fatal): %s", filename)
            except Exception:
                logger.debug("[ImportBatch] render engine 注册跳过: %s", filename)
        return result

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
            
            # 从 extra_fields 构建 invoiceFields（与 response_builder.py 保持一致）
            extra_fields = result.get('extra_fields') or {}
            invoice_fields = {
                "type": extra_fields.get("type", result.get('invoice_type', '')),
                "fphm": extra_fields.get("fphm", "") or (result.get('invoice_number', '') or ''),
                "kprq": extra_fields.get("kprq", "") or (result.get('invoice_date', '') or ''),
                "gmfmc": extra_fields.get("gmfmc", ""),
                "gmfsh": extra_fields.get("gmfsh", ""),
                "xsfmc": extra_fields.get("xsfmc", ""),
                "xsfsh": extra_fields.get("xsfsh", ""),
                "amountJe": extra_fields.get("amountJe", ""),
                "amountSe": extra_fields.get("amountSe", ""),
                "amountHj": extra_fields.get("amountHj", "") or (result.get('amount') or ''),
                "amountHjDx": extra_fields.get("amountHjDx", ""),
                "note": extra_fields.get("note", ""),
                "skr": extra_fields.get("skr", ""),
                "fhr": extra_fields.get("fhr", ""),
                "kpr": extra_fields.get("kpr", ""),
                "xmmc": extra_fields.get("xmmc", ""),
                "line_items": extra_fields.get("line_items", []),
            }
            
            items.append({
                'clientKey': job_info.get('metrics', {}).get('client_key', ''),
                'jobId': job_id,
                'fileName': job_info.get('file_name', ''),
                'fileHash': job_info.get('file_hash', ''),
                'docId': result.get('doc_id', ''),
                'invoiceType': result.get('invoice_type', ''),
                'invoiceNumber': result.get('invoice_number', ''),
                'amount': result.get('amount'),
                'invoiceDate': result.get('invoice_date', ''),
                'invoiceFields': invoice_fields,
                'parseMethod': result.get('parse_method', ''),
                'failedFields': result.get('failed_fields', []),
                'newName': result.get('new_name', ''),
            })  # 13-B.5 C2: 删除 previewImage 字段（import 表面停产，Render Contract 取代）
        
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
                # stop_at：本轮实际推进到的位置。正常完成 = window_end（行为不变）；
                # 若中途 submit_job 失败，置为 i+1（该 job 已就地记账），[i+1,window_end) 下轮重试。
                stop_at = window_end
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

                    # [Identity Bridge] 透传 source_doc_id / page_num / total_pages 到 job.metrics，
                    # 供 _on_job_done(:609) 触发 assembly 归并同票多页。
                    src_doc_id = fi.get('sourceDocId') or ''
                    if src_doc_id:
                        job.metrics['source_doc_id'] = src_doc_id
                        # FIX: 使用显式 None 检查而非 or，避免 pageNum=0（0-based）被误转为空字符串
                        pn = fi.get('pageNum')
                        tp = fi.get('totalPages')
                        job.metrics['page_num'] = str(pn) if pn is not None else ''
                        job.metrics['total_pages'] = str(tp) if tp is not None else ''

                    # IS-4.2 Step2：透传文档实例身份到 job.metrics，供 _on_job_done 后续按实例
                    # 归组（Step3 才消费）。与 source_doc_id（内容哈希）语义独立，故不嵌套在其 if 内。
                    # 纪律：不 fallback 到 source_doc_id、不后端生成 uuid——缺失记 warning，
                    # 不写入该 key（下游 .get('instance_id') 默认 '' 即 None 语义）。迁移期不兼容旧 identity。
                    instance_id = fi.get('instanceId') or ''
                    if instance_id:
                        job.metrics['instance_id'] = instance_id
                    else:
                        logger.warning(
                            "[ImportBatch] instanceId 缺失（迁移期告警，不 fallback）: "
                            "batch=%s file=%s", batch_id, rec.filename,
                        )

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
                        # 队列满：submit_job 已把该 job 标记为终态 failed（parse_job_manager:449），
                        # 但它从未入队 → 执行器完成回调永不触发 → _on_job_done 不会为它计数/释放 ref。
                        # 若不在此手动补账，batch.finished 永远到不了 total，_wait_for_completion 死循环、
                        # 批次卡死 running、temp 文件泄漏。此处镜像 _on_job_done 的 failed 分支补账。
                        logger.warning(
                            f"[ImportBatch] 队列满，job 提交失败，手动记账: {batch_id} job={job.id}"
                        )
                        self._temp_registry.release(ref_id)  # 幂等(INV-3)
                        with self._batch_lock:
                            b = self._batches.get(batch_id)
                            if b and b.status != 'cancelled':
                                b.failed += 1
                                b.touch()
                        # 该 job 已记账，从 i+1 续传；[i+1, window_end) 留待下轮重试，不跳过。
                        stop_at = i + 1
                        break

                submitted = stop_at

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
        _5em2_t0 = time.perf_counter()  # 一次性探针 5E-M2（跑完还原，勿 commit）
        
        # 查找 job 所属 batch
        job_info = self._job_manager.get_job(job_id)
        if not job_info:
            return
        batch_id = job_info.get('batch_id', '')
        if not batch_id:
            return  # 非批量任务，忽略

        # IS-2 Commit 5：本 job 的 temp 文件引用在此释放
        self._release_temp_file(job_info)

        # 读取解析结果
        db_record, full_result = self._extract_job_result(job_id, status)

        # 读取分组元信息
        metrics = job_info.get('metrics', {}) or {}
        src_doc_id = metrics.get('source_doc_id', '')
        instance_id = metrics.get('instance_id', '')

        # 更新聚合计数 + 缓冲结果
        should_flush = self._update_batch_and_buffer(
            batch_id, status, db_record, full_result, metrics,
            src_doc_id, instance_id
        )

        # 在锁外执行 DB 写入
        logger.info(
            "[5EM2-callback] job=%s status=%s cost_to_flush=%.1fms",
            job_id, status, (time.perf_counter() - _5em2_t0) * 1000,
        )
        if should_flush:
            self._flush_result_buffer(batch_id)

    def _release_temp_file(self, job_info: dict):
        """释放 job 关联的临时文件引用"""
        ref_id = job_info.get('metrics', {}).get('ref_id')
        if ref_id:
            self._temp_registry.release(ref_id)

    def _extract_job_result(self, job_id: str, status: str):
        """提取 job 执行结果"""
        db_record = None
        full_result = None
        if status == 'success':
            result = self._job_manager.get_job_result(job_id)
            if result and isinstance(result, dict):
                db_record = result.get('db_record')
                full_result = result
        return db_record, full_result

    def _update_batch_and_buffer(self, batch_id, status, db_record, full_result,
                                  metrics, src_doc_id, instance_id):
        """更新批次计数并缓冲解析结果

        Returns:
            bool: 是否需要触发 flush
        """
        should_flush = False
        with self._batch_lock:
            batch = self._batches.get(batch_id)
            if not batch:
                return False

            # 护栏：已取消的批次忽略迟到回调
            if batch.status == 'cancelled':
                logger.debug(f"[ImportBatch] 忽略已取消批次的回调: {batch_id}")
                return False

            # 更新聚合计数
            if status == 'success':
                batch.success += 1
            else:
                batch.failed += 1
            batch.touch()

            # 处理结果缓冲
            if db_record and full_result:
                should_flush = self._buffer_result(
                    batch, batch_id, db_record, full_result,
                    metrics, src_doc_id, instance_id
                )
            else:
                # 无有效结果（失败/取消），直接跳过缓冲
                pass

        return should_flush

    def _buffer_result(self, batch, batch_id, db_record, full_result,
                       metrics, src_doc_id, instance_id):
        """将解析结果加入缓冲区（带分组或直写）"""
        bucket_key = self._resolve_bucket_key(instance_id, src_doc_id, batch_id)
        
        if bucket_key:
            return self._buffer_with_assembly(
                batch, batch_id, db_record, full_result,
                metrics, src_doc_id, bucket_key
            )
        else:
            return self._buffer_directly(batch_id, db_record)

    def _resolve_bucket_key(self, instance_id, src_doc_id, batch_id):
        """确定分桶键（instance_id 优先，src_doc_id 兜底）"""
        bucket_key = instance_id
        if not bucket_key and src_doc_id:
            logger.warning(
                "[ImportBatch] instance_id 缺失，legacy 兜底用 source_doc_id 分桶: batch=%s source=%s",
                batch_id, src_doc_id,
            )
            bucket_key = src_doc_id
        return bucket_key

    def _buffer_with_assembly(self, batch, batch_id, db_record, full_result,
                               metrics, src_doc_id, bucket_key):
        """按桶处理页面组装和缓冲"""
        should_flush = False
        
        # 解析页面信息
        page_num, total_pages = self._parse_page_info(metrics, bucket_key)
        normalized_page_num = page_num - 1 if page_num > 0 else 0
        
        # 加入 PageResultStore
        from page_result_store import get_page_result_store
        from invoice_assembly_pipeline import (
            assemble as _assemble_invoice,
            invoice_document_to_db_record,
        )
        
        store = get_page_result_store()
        completed = store.put(
            bucket_key, normalized_page_num, total_pages,
            full_result, source_doc_id=src_doc_id
        )
        
        if completed:
            # 所有页收齐 → 组装 → 入库缓冲
            pages = store.get_pages(bucket_key)
            if pages:
                invoice_docs = _assemble_invoice(pages)
                for inv_doc in invoice_docs:
                    inv_db = invoice_document_to_db_record(
                        inv_doc,
                        fallback_hash=db_record.get('hash_sha256', ''),
                        fallback_filename=db_record.get('file_name', ''),
                        fallback_raw_text=db_record.get('raw_text', ''),
                    )
                    buf = self._result_buffers.get(batch_id)
                    if buf:
                        buf.add(inv_db)
                        should_flush = buf.should_flush()
                    # 存储组装后的 InvoiceDocument 元信息
                    batch.assembled_documents.append({
                        'instanceId': bucket_key,
                        'sourceDocId': src_doc_id,
                        'invoiceNumber': inv_doc.get('invoice_number', ''),
                        'invoiceType': inv_doc.get('invoice_type', ''),
                        'pageCount': len(pages) if isinstance(pages, list) else 0,
                    })
            store.remove(bucket_key)
        
        return should_flush

    def _parse_page_info(self, metrics, bucket_key):
        """解析页面页码和总页数"""
        page_num_str = metrics.get('page_num', '')
        total_pages_str = metrics.get('total_pages', '')
        page_num = int(page_num_str) if page_num_str.isdigit() else 0
        total_pages = int(total_pages_str) if total_pages_str.isdigit() else 1
        
        # 检查页码越界
        if page_num > total_pages:
            logger.warning(
                "[IMPORT] page_num 超出 total_pages（疑似契约异常）: "
                "page_num=%s total_pages=%s bucket=%s",
                page_num, total_pages, bucket_key,
            )
        
        return page_num, total_pages

    def _buffer_directly(self, batch_id, db_record):
        """无分组信息时直接写入缓冲"""
        buf = self._result_buffers.get(batch_id)
        if buf:
            buf.add(db_record)
            return buf.should_flush()
        return False

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
        # P6-C：每次批次清理后顺带回收超龄终态批次，避免 _batches 无限增长
        self.evict_old_batches()

    def evict_old_batches(self, now_ts: Optional[float] = None) -> int:
        """回收超龄终态批次（P6-C），防止 _batches 无限增长。

        分层 TTL（小时）：completed 0.5 / failed 2.0 / cancelled 10min。
        running/queued 永不回收，保证活跃批次的 GET /import/batch/{id} 历史语义。
        仅删除 _batches 条目（运行时数据已由 cleanup_batch 释放），不触碰磁盘结果。
        """
        from time_utils import from_isoformat, to_timestamp
        now_ts = now_ts if now_ts is not None else time.time()
        with self._batch_lock:
            stale = [
                bid for bid, b in self._batches.items()
                if b.status in self._TERMINAL_EVICT_HOURS
                and to_timestamp(from_isoformat(b.updated_at)) < now_ts - self._TERMINAL_EVICT_HOURS[b.status] * 3600
            ]
            for bid in stale:
                del self._batches[bid]
        if stale:
            logger.info(f"[ImportBatch] evicted {len(stale)} stale batches")
        return len(stale)

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
