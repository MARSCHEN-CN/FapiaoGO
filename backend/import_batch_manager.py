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

# 5.1c-2 timeout 阈值（秒）：超过即视为 stale，由 _apply_job_timeouts 翻 failed(timeout)
# 仅作默认兜底，具体数值后续可由配置覆盖；此处冻结初值不引入 heartbeat/retry 等扩展。
JOB_RUNNING_TIMEOUT = 120    # running 状态超过 120s 无终态 → 视为卡死
JOB_QUEUED_TIMEOUT = 300     # pending 状态超过 300s 未开始 → 视为排队卡死


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
            'completed_with_errors': 'completed_with_errors',  # 5.1b：缺页/失败页终态（import SSE 须识别）
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
        """获取批次状态（dict 形式，供 SSE 使用）

        5.1b-3a：终态暴露缺页/失败页。completed 保持旧 payload（不强行新增空字段，
        向后兼容旧 SSE 消费者）；completed_with_errors / failed / cancelled 携带
        missingPages / failedPages（由 _collect_batch_page_health 从 JobStore 推导）。
        在批次锁外计算 health，避免持锁调用 job_manager。
        """
        batch = self.get_batch(batch_id)
        if not batch:
            return None
        with self._batch_lock:
            state = batch.to_dict()
        if batch.status != 'completed':
            health = self._collect_batch_page_health(batch, self._job_manager)
            state['missingPages'] = health['missingPages']
            state['failedPages'] = health['failedPages']
        return state

    def get_batch_results(self, batch_id: str) -> Dict[str, Any]:
        """获取批次解析结果（batch-level 聚合，供前端 hydration 与生命周期消费）

        使用 batch.job_ids 索引，避免 JobStore 全表扫描。

        返回（5.1b-3a batch-level 契约，见 LIFECYCLE_STATE_CONTRACT_5_1b0.md §3）：
            {
                'items':       [ per-page 解析结果（clientKey/jobId/amount/...）],
                'documents':   [ 组装后的 InvoiceDocument 元信息 ],
                'status':      batch 终态（completed / completed_with_errors / failed / ...）,
                'missingPages':[ {'sourceDocId': str, 'pages': [int, ...]} ],  # 从未到达的页
                'failedPages': [ {'sourceDocId': str, 'pages': [int, ...]} ],  # worker 抛错的页
            }
        missingPages / failedPages 由 _collect_batch_page_health 从 JobStore 推导，
        按 source_doc_id 归组；缺页与失败页互斥（优先级 FAILED > MISSING）。
        """
        with self._batch_lock:
            batch = self._batches.get(batch_id)
            if not batch:
                return []
            job_ids = list(batch.job_ids)  # 复制，避免持锁遍历
            # ── 构建 clientKey → 合并后价税合计 的映射 ──
            # get_batch_results 遍历 job_ids，每个 job 对应一页的解析结果。
            # 多页发票的 amountHj 只在末尾页有意义，其他页可能是空或小计。
            # 用 assembled_documents 中的合并后价税合计替换单页值，
            # 确保 fc-amount 与导出数据使用同一数据源。
            assembled_amount_map = {}
            assembled_date_map = {}
            for doc in (batch.assembled_documents or []):
                amount = doc.get('amount')
                invoice_date = doc.get('invoiceDate')
                for page_key in (doc.get('pageClientKeys') or []):
                    if not page_key:
                        # 护栏：clientKey 在 scheduler 处可选，缺省为空串。
                        # 空串不可作为 map 键，否则多篇文档以 "" 互相覆盖 → 跨文档金额错配。
                        continue
                    if amount:
                        assembled_amount_map[page_key] = amount
                    if invoice_date:
                        assembled_date_map[page_key] = invoice_date

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

            client_key = job_info.get('metrics', {}).get('client_key', '')

            # 两层防御（对应上方 map 构建）：仅当 client_key 非空且确实命中 map 时才采用
            # assembled 值，避免空串键泄漏，也避免合法空值（如 {"ck": ""}）被 truthy 误回退。
            assembled_amount = assembled_amount_map[client_key] if (client_key and client_key in assembled_amount_map) else None
            assembled_date = assembled_date_map[client_key] if (client_key and client_key in assembled_date_map) else None

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
                # 多页发票使用合并后的价税合计，确保 invoiceFields.amountHj 与 fc-amount 一致
                "amountHj": (assembled_amount if assembled_amount is not None else (extra_fields.get("amountHj", "") or (result.get('amount') or ''))),
                "amountHjDx": extra_fields.get("amountHjDx", ""),
                "note": extra_fields.get("note", ""),
                "skr": extra_fields.get("skr", ""),
                "fhr": extra_fields.get("fhr", ""),
                "kpr": extra_fields.get("kpr", ""),
                "xmmc": extra_fields.get("xmmc", ""),
                "line_items": extra_fields.get("line_items", []),
            }
            # 透出字段级失败/警告明细（dict 列表，含真实 reason），
            # 供前端 failedFieldsDetail 显示准确失败原因（与 response_builder.py 同构）
            for _key in ('failed_fields', 'warning_fields'):
                if extra_fields.get(_key):
                    invoice_fields[_key] = extra_fields[_key]

            items.append({
                'clientKey': client_key,
                'jobId': job_id,
                'fileName': job_info.get('file_name', ''),
                'fileHash': job_info.get('file_hash', ''),
                'docId': result.get('doc_id', ''),
                'invoiceType': result.get('invoice_type', ''),
                'invoiceNumber': result.get('invoice_number', ''),
                # ── 统一金额数据源：优先使用合并后的价税合计 ──
                # 多页发票的每一页在 JobStore 中存储的是单页解析结果，
                # amountHj 可能是空（非末尾页）或小计。
                # assembled_documents 中的 amount 是经过 merge_page_results
                # 合并后的真实价税合计（来自末尾页的 amountHj）。
                'amount': (assembled_amount if assembled_amount is not None else (extra_fields.get('amountHj') or result.get('amount'))),
                'invoiceDate': (assembled_date if assembled_date is not None else result.get('invoice_date', '')),
                'invoiceFields': invoice_fields,
                'parseMethod': result.get('parse_method', ''),
                # failed_fields 只嵌在 extra_fields 内（invoice_service 返回 dict 无顶层键），
                # 顶层 result.get('failed_fields') 恒为 [] → 失败字段静默丢失、
                # 前端 isFailedFile 永不为真（缺失购买方名称等不判失败）。
                # 与 app.py parse_batch（:1478-1480）同构：dict 列表 → 字段名列表。
                'failedFields': [
                    f.get('field', '') for f in (extra_fields.get('failed_fields') or [])
                    if isinstance(f, dict) and f.get('field')
                ],
                'newName': result.get('new_name', ''),
            })  # 13-B.5 C2: 删除 previewImage 字段（import 表面停产，Render Contract 取代）

        # 5.1b-3a：batch-level 健康（缺页/失败页）从 JobStore 推导，归组到缺失/失败集合，
        # 不塞进每个 invoice item（per-page 数据在 items 中）。
        health = self._collect_batch_page_health(batch, self._job_manager)
        return {
            'items': items,
            'documents': batch.assembled_documents or [],
            'status': batch.status,
            'missingPages': health['missingPages'],
            'failedPages': health['failedPages'],
        }

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

    def _collect_batch_page_health(self, batch: 'ImportBatch', job_manager) -> Dict[str, Any]:
        """汇总批次内每页终态健康度，推导终态 status（5.1b 生命周期契约 §4/§5）。

        数据权威源 = JobStore（非 PageResultStore）：assemble 完成后 store.remove(bucket_key)，
        已完成文档的成功页已从 store 移除，不能据此判定 SUCCESS（§4.1 注记：数据 ownership 澄清）。

        分类（§4.1）：
          SUCCESS = job.status == 'success'
          FAILED  = job.status == 'failed'
          MISSING = expected - success - failed
          expected = set(range(total_pages))，按 source_doc_id 分组
        优先级 FAILED > MISSING（failed 页绝不进 missingPages，否则违反冻结契约）。

        终态（§5）：cancelled(外部) > failed(allFailed) > completed_with_errors(hasErrors) > completed
          failed 唯一条件：failed_pages == 全部 expected 页（!= success_count == 0，
          避免污染未来 retry/timeout 语义）。
        """
        doc_expected: Dict[str, set] = {}
        doc_success: Dict[str, set] = {}
        doc_failed: Dict[str, set] = {}

        for job_id in batch.job_ids:
            job = job_manager.get_job(job_id)
            if not job:
                continue
            metrics = job.get('metrics') or {}
            try:
                page_num = int(metrics.get('page_num', 0))
            except (TypeError, ValueError):
                page_num = 0
            try:
                total_pages = int(metrics.get('total_pages', 1))
            except (TypeError, ValueError):
                total_pages = 1
            source_doc_id = metrics.get('source_doc_id') or 'unknown'

            doc_expected.setdefault(source_doc_id, set()).update(range(total_pages))
            if job.get('status') == 'success':
                doc_success.setdefault(source_doc_id, set()).add(page_num)
            elif job.get('status') == 'failed':
                doc_failed.setdefault(source_doc_id, set()).add(page_num)

        missing_pages: List[Dict] = []
        failed_pages: List[Dict] = []
        total_expected = 0
        total_success = 0
        total_failed = 0
        for source_doc_id, expected in doc_expected.items():
            success = doc_success.get(source_doc_id, set())
            failed = doc_failed.get(source_doc_id, set())
            missing = expected - success - failed
            total_expected += len(expected)
            total_success += len(success)
            total_failed += len(failed)
            if missing:
                missing_pages.append({'sourceDocId': source_doc_id, 'pages': sorted(missing)})
            if failed:
                failed_pages.append({'sourceDocId': source_doc_id, 'pages': sorted(failed)})

        missing_pages.sort(key=lambda x: x['sourceDocId'])
        failed_pages.sort(key=lambda x: x['sourceDocId'])

        has_errors = bool(missing_pages) or bool(failed_pages)
        all_failed = (total_expected > 0) and (total_failed == total_expected)

        if all_failed:
            status = 'failed'
        elif has_errors:
            status = 'completed_with_errors'
        else:
            status = 'completed'

        return {
            'status': status,
            'missingPages': missing_pages,
            'failedPages': failed_pages,
            'hasErrors': has_errors,
            'allFailed': all_failed,
        }

    def _wait_for_completion(self, batch_id: str):
        """轮询等待批次完成（所有 job 到达终态）。

        5.1c-2：在轮询循环内嵌入 timeout watchdog（Batch assembly timeout owner，
        见 TIMEOUT_CONTRACT_5_1c0.md §2.2）。仅委托 ParseJobManager 将 stale job 翻为
        failed(timeout)，不直接写 batch 状态机——终态由 _collect_batch_page_health
        （FAILED>MISSING）自然推导，保护 5.1b contract。
        """
        while True:
            if self._cancel_flags.get(batch_id, False):
                return

            with self._batch_lock:
                batch = self._batches.get(batch_id)
                if not batch:
                    return
                if batch.status in ('completed', 'failed', 'cancelled'):
                    return

            # 5.1c-2：检测 stale job 并翻 failed(timeout)（委托 Job 级 ownership，不直写 batch）
            self._apply_job_timeouts(batch)

            with self._batch_lock:
                batch = self._batches.get(batch_id)
                if not batch:
                    return
                if batch.status in ('completed', 'failed', 'cancelled'):
                    return
                finished = batch.finished
                total = batch.total

            # 完成判定：finished 计数 或 所有 job 已终态（测试 / timeout 场景用后者）
            all_terminal = self._all_jobs_terminal(batch)
            if finished >= total or all_terminal:
                # 全部完成 → flush 剩余 buffer → 标记 completed
                self._flush_result_buffer(batch_id)
                with self._batch_lock:
                    batch = self._batches.get(batch_id)
                    if batch and batch.status == 'running':
                        health = self._collect_batch_page_health(batch, self._job_manager)
                        batch.status = health['status']
                        if health['allFailed']:
                            batch.error = '全部解析失败'
                        elif health['hasErrors']:
                            batch.error = '部分页面解析失败或缺失'
                        batch.touch()
                logger.info(
                    f"[ImportBatch] 批次完成: {batch_id} "
                    f"(success={batch.success}, failed={batch.failed})"
                )
                return

            time.sleep(SCHEDULER_POLL_INTERVAL)

    # ─── 5.1c-2 timeout watchdog helpers ────────────────────

    def _apply_job_timeouts(self, batch: 'ImportBatch'):
        """将 batch 内 stale job 翻为 failed(timeout)。

        仅负责「检测 + 委托」：调用 ParseJobManager.update_status 应用 Job 级 ownership
        （set timed_out / failure_reason，并按 AC2 守卫阻止迟到 success 复活）。
        不在此直接改 batch.status——终态由 _collect_batch_page_health 推导。
        """
        now_ts = time.time()
        for job_id in batch.job_ids:
            job = self._job_manager.get_job(job_id)
            if not job:
                continue
            status = job.get('status')
            # 已标记 timed_out 但状态未对齐（迟到 success 竞态，Case 2）→ 强制对齐为 failed
            if job.get('timed_out') and status != 'failed':
                self._job_manager.update_status(job_id, 'failed', error='timeout')
                continue
            if status in ('pending', 'running'):
                ref = job.get('started_at') if status == 'running' else job.get('created_at')
                elapsed = self._job_elapsed_seconds(ref, now_ts)
                timeout = JOB_RUNNING_TIMEOUT if status == 'running' else JOB_QUEUED_TIMEOUT
                if elapsed is not None and elapsed > timeout:
                    self._job_manager.update_status(job_id, 'failed', error='timeout')

    def _job_elapsed_seconds(self, ref, now_ts: float):
        """兼容 float（测试）与 ISO 字符串（生产）两种时间戳，返回已耗时秒数。"""
        if ref is None or ref == '':
            return None
        if isinstance(ref, (int, float)):
            return now_ts - float(ref)
        try:
            from time_utils import from_isoformat, to_timestamp
            return now_ts - to_timestamp(from_isoformat(ref))
        except Exception:
            return None

    def _all_jobs_terminal(self, batch: 'ImportBatch') -> bool:
        """所有 job 是否都到达终态（success/failed/cancelled）。"""
        for job_id in batch.job_ids:
            job = self._job_manager.get_job(job_id)
            if not job:
                continue
            if job.get('status') not in ('success', 'failed', 'cancelled'):
                return False
        return True

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
        # page_num 已由 _parse_page_info 解析为 0-based（与 /split_pdf 的 page_index、
        # 前端的 pageNum、PageResultStore 的 0-based 契约一致）。Commit 4.1 之前这里曾做
        # `page_num - 1` 归一化（误当作 1-based），导致批量多页导入首两页在 store 落同一
        # key=0 互相覆盖、assembly 永不触发、首页数据丢失。现直接用 0-based page_num。
        page_num, total_pages = self._parse_page_info(metrics, bucket_key)

        # 加入 PageResultStore
        from page_result_store import get_page_result_store
        from invoice_assembly_pipeline import (
            assemble as _assemble_invoice,
            invoice_document_to_db_record,
        )

        # Commit 2：将前端 clientKey 透传到页面解析结果。
        # assemble() 据此声明每个 InvoiceDocument 的精确页面成员（pageClientKeys），
        # 前端 hydrate 不再需按 invoiceNumber 反推页身份。
        # metrics.client_key 即前端 fileObj.key（见 create_batch 的 file_inputs）。
        if metrics and not full_result.get('clientKey'):
            ck = (metrics.get('client_key') or '').strip()
            if ck:
                full_result['clientKey'] = ck

        store = get_page_result_store()
        completed = store.put(
            bucket_key, page_num, total_pages,
            full_result, source_doc_id=src_doc_id
        )
        
        logger.info(
            f'[ImportBatch] 页面存储: bucket={bucket_key}, '
            f'page_num={page_num}, total_pages={total_pages}, '
            f'completed={completed}'
        )
        
        if completed:
            # 所有页收齐 → 组装 → 入库缓冲
            pages = store.get_pages(bucket_key)
            if pages:
                logger.info(
                    f'[ImportBatch] 所有页收齐，开始组装: '
                    f'bucket={bucket_key}, pages_count={len(pages)}'
                )
                invoice_docs = _assemble_invoice(pages)
                logger.info(
                    f'[ImportBatch] 组装完成: '
                    f'bucket={bucket_key}, doc_count={len(invoice_docs)}, '
                    f'pages_per_doc={[len(d.get("pages", [])) for d in invoice_docs]}'
                )
                for inv_doc in invoice_docs:
                    # FIX: 从 inv_doc 或其页面中提取对应的文件名，而不是使用统一的 fallback_filename
                    # 原因：当多页发票被拆分为多个单页文档时，每个文档需要使用各自页面的文件名

                    # 1. 优先从 inv_doc.db_record 获取文件名（单页文档时有效）
                    inv_db_record = inv_doc.get('db_record', {}) or {}
                    inv_filename = inv_db_record.get('file_name', '')
                    inv_hash = inv_db_record.get('hash_sha256', '')
                    inv_raw_text = inv_db_record.get('raw_text', '')

                    # 2. 如果 inv_doc 有 pages 字段，从第一个页面获取文件名（多页文档或拆分后的单页）
                    if not inv_filename:
                        inv_pages = inv_doc.get('pages', [])
                        if inv_pages:
                            first_page = inv_pages[0] if isinstance(inv_pages, list) else inv_pages
                            if isinstance(first_page, dict):
                                # 从页面的 db_record 获取
                                page_db_record = first_page.get('db_record', {}) or {}
                                inv_filename = page_db_record.get('file_name', '')
                                if not inv_hash:
                                    inv_hash = page_db_record.get('hash_sha256', '')
                                if not inv_raw_text:
                                    inv_raw_text = page_db_record.get('raw_text', '')
                                # 或者从页面直接获取 file_name
                                if not inv_filename:
                                    inv_filename = first_page.get('file_name', '')
                    
                    # 3. 最后回退到传入的 db_record（仅用于日志，不应作为主路径）
                    if not inv_filename:
                        inv_filename = db_record.get('file_name', '')
                        logger.warning(
                            f'[ImportBatch] 无法从 inv_doc 提取文件名，回退到传入的 db_record: '
                            f'invoice={inv_doc.get("invoice_number", "")}, '
                            f'file_name={inv_filename}'
                        )
                    
                    logger.info(
                        f'[ImportBatch] inv_doc 文件名: '
                        f'invoice={inv_doc.get("invoice_number", "")}, '
                        f'file_name={inv_filename}, '
                        f'source_file={db_record.get("file_name", "")}'
                    )
                    
                    inv_db = invoice_document_to_db_record(
                        inv_doc,
                        fallback_hash=inv_hash or db_record.get('hash_sha256', ''),
                        fallback_filename=inv_filename,
                        fallback_raw_text=inv_raw_text or db_record.get('raw_text', ''),
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
                        # Commit 2：补全业务字段，避免前端被迫用 rep=page1 取金额/日期
                        # amount/invoiceDate 来自 assemble 合并结果（末页金额 / 首页开票日期）
                        'amount': inv_doc.get('amount'),
                        'invoiceDate': inv_doc.get('invoice_date', ''),
                        # 精确页面成员（前端 clientKey 列表），hydrate 直接消费
                        'pageClientKeys': inv_doc.get('_assembly', {}).get('page_client_keys', []),
                    })
            store.remove(bucket_key)
        
        return should_flush

    def _parse_page_info(self, metrics, bucket_key):
        """解析页面页码和总页数
        
        注意：前端传来的 page_num 可能是 1-based（第1页=1），
        但 PageResultStore 要求 0-based（第1页=0）。
        这里统一转换为 0-based。
        
        检测逻辑（基于实际日志分析，兼顾 0-based 直传场景）：
        - 若同 bucket 已被判定为 0-based（由首个以 '0' 开头的 page_num
          字符串触发），后续所有页一律不再做 -1 归一化
        - 否则默认视为 1-based 做 -1 归一化（兼容历史批量导入路径）
        """
        page_num_str = metrics.get('page_num', '')
        total_pages_str = metrics.get('total_pages', '')
        page_num = int(page_num_str) if page_num_str.isdigit() else 0
        total_pages = int(total_pages_str) if total_pages_str.isdigit() else 1

        # 同 bucket 一旦被标记为 0-based，就持续使用 0-based（避免后续页被误 -1 碰撞）
        if hasattr(self, '_zero_based_buckets') and bucket_key in self._zero_based_buckets:
            if page_num >= total_pages:
                logger.warning(
                    "[IMPORT] page_num 越界(0-based): page_num=%s total_pages=%s bucket=%s",
                    page_num, total_pages, bucket_key,
                )
            return page_num, total_pages

        # 检测到明确 0-based 信号：page_num 字符串以 '0' 开头（如 '0'/'001'/'01'）
        if page_num_str.startswith('0') and page_num_str:
            if not hasattr(self, '_zero_based_buckets'):
                self._zero_based_buckets = set()
            self._zero_based_buckets.add(bucket_key)
            return page_num, total_pages

        # 默认视为 1-based：做 -1 归一化
        if 1 <= page_num <= total_pages:
            page_num = page_num - 1
            logger.info(
                f"[ImportBatch] page_num 1-based → 0-based: "
                f"original={page_num + 1}, converted={page_num}, total={total_pages}"
            )
        
        # 检查页码越界
        if page_num >= total_pages or page_num < 0:
            logger.warning(
                "[IMPORT] page_num 无效: page_num=%s total_pages=%s bucket=%s",
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
