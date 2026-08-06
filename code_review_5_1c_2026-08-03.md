# 系统代码审查报告 — 5.1c 导入运行时 + 解析管线

> 审查时间：2026-08-03 ｜ 审查范围：最新 5.1c 导入运行时 + 解析管线（HEAD `41d1c96a`）
> 方法：以 `git diff --stat 8a240a74..HEAD` 锁定变更面，逐文件精读核心路径（后端 import/parse 生命周期、前端编排、electron 命名），对照项目冻结契约（Identity / IS-2/3 / Import-Model-Boundary）核对正确性。

## 一、整体结论

**健康。未发现 🔴 阻塞性缺陷。** 5.1c 的 timeout watchdog、生命周期推进、多页拆分回归修复、解析缓存消费修复均正确落地，关键不变量成立。

主要可改进项为：**已埋入代码、本应还原却残留的 5E 性能探针（违反项目自带清理纪律 + 生产日志噪声）**，以及一处**脆弱且会泄漏内存的页码启发式**。

---

## 二、正确性确认（关键不变量成立）

1. **AC2 timeout 守卫正确**（`parse_job_manager.py:84-103`）
   `ParseJob.update_status` 对 `failed/cancelled` 状态的 job 忽略迟到 `success` → 超时翻 `failed(timeout)` 后，迟到的成功结果无法"复活"。5.1c 的 timeout 生命周期优先级契约成立。

2. **队列满失败路径不重复计数**（`import_batch_manager.py:607-623` + `parse_job_manager.py:450-470`）
   `submit_job` 在队列满时把 job 标 `failed` 但**不**挂载 `add_done_callback`，故完成回调永不被触发；`import_batch_manager` 在此手动 `batch.failed += 1` 并 `release(ref_id)` 是**必要且唯一**的记账，无重复计数。

3. **超时翻转的 job 最终仍被正确计数**（`parse_job_manager.py:416-417` + `:593`）
   watchdog 把 job 翻 `failed(timeout)` 后，worker 真正结束时 `future.add_done_callback → _on_job_done` 仍会触发，`ParseJobManager._on_job_done` 据此递增 `batch.failed`（迟到 success 被 AC2 拦下，不会缓冲结果）。计数最终一致。

4. **PageResultStore 完成判定健壮**（`page_result_store.py:139-165`）
   `_is_complete` 用 `expected ⊆ received`（而非 `len >= total`），避免"数量够但缺中间页"的伪完成；并保留首尾页收齐的非连续兜底。配合 `entry['pages'][page_num]` 字典存储，能正确暴露缺页。

5. **页码契约自洽（已验证非 live bug）**
   实测 `/split_pdf` 返回 **1-based** `page_index`（`app.py:986` 由 `page_num = i+1` 得出），前端透传为 `pageNum=1,2,3`，后端 `_parse_page_info` 恒定走 1-based→0-based 的 `-1` 分支。`PageResultStore` 以 0-based 存储。链路一致。
   ⚠️ 见下方 🟡-2：该启发式存在脆弱面，只是当前契约恰好避开。

6. **PDF 字段缓存消费修复正确**（5F-0，`invoice_service.py:423-454`）
   `cached_fields` 命中时走 `extra_fields = cached_fields`（不再白读重提取）；miss 才 `extract_fields` + 写缓存。`config.py:54` 默认 `CACHE_DEBUG='0'`（上线遗留项已落实）。

7. **`runChunkedImport.js` 编排层整洁**
   纯函数、与 React 解耦、可 Node 验收；错误隔离正确（failed/cancelled 仅标记当前 chunk）；`onError` 用结构化 `{status:'error', error}` 收尾（修复了此前 `resolve(progress)` 引用 `progress` 导致 Promise 永不 settle 的卡死 bug）。

8. **`archive-names.js` 命名策略设计良好**
   `resolveArchiveFileNames` 的 strict 模式对重名**抛错**而非静默加 `_1` 后缀——避免掩盖上游命名 bug、保全"同票多页用 `_p2/_p3` 可辨页序"的业务语义。防御性 API 设计到位。

---

## 三、🟡 建议修复

### 🟡-1 残留的 5E 性能探针未还原（违反项目自带清理纪律 + 生产日志噪声）
- `import_batch_manager.py:849` `_5em2_t0 = time.perf_counter()  # 一次性探针 5E-M2（跑完还原，勿 commit）`
- `import_batch_manager.py:877-880` `logger.info("[5EM2-callback] job=%s status=%s cost_to_flush=%.1fms", ...)`
- `parse_job_manager.py:475` `logger.info("[5EM3-exec] job=%s start", job_id)  # 一次性探针 5E-M3（跑完还原，勿 commit）`

**Why：** 三处探针自身的注释都写明"跑完还原，勿 commit"，但已落入提交。项目 MEMORY 亦明确列出"待清理探针 backend [PROBE]/[ASSEMBLY_ENGINE]（结构性无效）"。它们会在每次导入回调 / 每个 job 启动时向生产日志刷噪声，且 `_5em2_t0` 在回调入口占位、结尾算耗时——纯调试产物。

**Suggestion：** 删除这三处（含 `_5em2_t0` 变量与其配套日志）。如需保留打点能力，应接入既有的 `PerformanceMetrics`（`parse_invoice_service` 已埋分段，受 `APP_DEBUG` 控制），而非散落 `logger.info`。

### 🟡-2 `_parse_page_info` 0-based 启发式脆弱 + `_zero_based_buckets` 内存泄漏/跨批次状态残留
`import_batch_manager.py:1087-1135`（尤其 `:1113-1117` 的 `startswith('0')` 嗅探与实例属性 `_zero_based_buckets`）。

**Why：**
- 该启发式靠"首个收到的 page 字符串是否以 `'0'` 开头"来猜测整桶是 0-based 还是 1-based。当前因为 `/split_pdf` 恒为 1-based，多页永远是 `'1','2','3'` → 嗅探分支（仅对 `'0'` 触发）实为**死代码**，恒走 1-based `-1`。
- 一旦任何路径（或未来 `/split_pdf` 改 0-based）给多页文档传入 0-based `pageNum`，在 `ThreadPool(4)` 乱序完成下，若首完成页不是 `page 0`，嗅探会把桶误判为 1-based，导致两页映射到同一 `page_num` key，`PageResultStore.put`（`page_result_store.py:109`）**静默覆盖 → 数据丢失**，`_is_complete` 的非连续兜底还可能判为"完成"。这是经典并发竞态数据损坏，且测试（同步 mock）往往按完成顺序通过、生产才暴露。
- `self._zero_based_buckets` 是 `ImportBatchManager` 单例的实例属性，**永不清除** → 长运行服务累积成千上万个 UUID 字符串（内存泄漏），且某个 `bucket_key`（instanceId）一旦被记入 0-based 决策，会跨批次残留影响后续导入（虽 UUID 碰撞概率极低，但属于不该存在的跨请求状态）。

**Suggestion：** 删除整段嗅探 + `_zero_based_buckets`。契约已明确 `/split_pdf` 返回 1-based，故"非 null 的 `pageNum` 一律按 1-based 减 1、null/空串按 0"即可，单一、明确、无状态。若想更稳，可让前端显式声明 0-based 标志位，而非靠字符串嗅探。

### 🟡-3 `_apply_job_timeouts` 的 TOCTOU 读-改竞态
`import_batch_manager.py:799-813`：`_apply_job_timeouts` 先 `self._job_manager.get_job(job_id)`（返回 `to_dict()` **副本**）读状态，再 `self._job_manager.update_status(...)` 改写**真实对象**。

**Why：** 两次 `store` 访问之间存在窗口。若某 job 已运行超 `JOB_RUNNING_TIMEOUT(120s)` 且恰好在"读副本"与"写失败"之间由 worker 翻成 `success`，watchdog 会把一个**实际成功**的 job 覆盖为 `failed(timeout)`。AC2 守卫只挡"success 覆盖 failed"，不挡"failed 覆盖 success"。

**Severity：** 近不可能触发——正常解析 ~0.8s，超时阈值 120s，需在微秒窗口内恰好完成。属理论正确性缺口。

**Suggestion：** 将超时判定移入 `ParseJob.update_status`（原子）：`update_status('failed', error='timeout')` 内部增加"若当前已是 `success` 则忽略"的对称守卫（与 AC2 反向）。或 watchdog 调用时传入期望当前状态做 CAS。

### 🟡-4 安全：归档导出文件名需确认 basename 落盘（防路径穿越）
`electron/archive-names.js` 的 `resolveArchiveFileNames` 已用 `path.basename(targetName, ext)` 构造 `finalName`（剥离目录），方向正确。但 `targetName` 来自 Document 层，而发票 `new_name` 可能源自**解析内容**（攻击者可控 PDF/OFD 文本）。

**Suggestion（验证项）：** 确认 `archive-utils.js` / `ipc-pack.js` 实际写盘时使用的是 `resolved[].finalName`（basename-only），而非原始 `targetName` 或拼回目录；并额外过滤 `..` 与 `\0`。当前 `resolveArchiveFileNames` 仅去重/抛错，未显式 sanitize 分隔符，建议写盘前再 `basename` 一次并拒绝含分隔符的输入。

---

## 四、💭 细节 / 优化

- **`invoice_service.py:407` `from_cache_field = False` 为死变量**：赋值后无任何读取（全文件仅此一处）。建议删除或确实接上"来自缓存"的溯源标记。
- **`runChunkedImport.js:75` `eventSources` 跨 chunk 累积不清理**：每次 chunk 的 `eventSource` 在 resolve 后 `push` 进数组但从不移除（已关闭对象堆积）。超大导入（多 chunk）下轻微泄漏。可在 onComplete/onError 中 `eventSources.delete(es)`。
- **`fileHelpers.js:151-153` 拆分失败静默回退**：`/split_pdf` 异常时仅 `console.error` 并把整 PDF 当单文件处理。多页 PDF 拆分会静默退化为"拆成独立发票"且无用户可见告警。建议至少在 UI 给出非阻塞提示。
- **`get_batch_dict` 每次 SSE 轮询对非终态批次跑 `_collect_batch_page_health`**（`import_batch_manager.py:362`），遍历全部 `job_ids`（逐 `get_job`）。N=100、轮询频繁时每 tick O(N)。当前 N 可接受；若后续批次规模放大，建议缓存 health 或增量更新。
- **测试保真度**：`splitPageFileNameInvariant.test.mjs` 的 `makeSplitResponse` 用 **0-based** `page_index` mock，而真实 `/split_pdf` 返回 1-based（app.py:986）。"拆分页名互异"不变式在两种基下都成立，故测试仍有效；但 mock 与 prod 契约不一致，建议把 mock 调成 1-based 以真正锁定生产路径（否则 5F-1 若改回 0-based，此测试不会报警）。

---

## 五、安全 / 正确性（导入流总览）

| 维度 | 状态 | 说明 |
|---|---|---|
| 上传字节隔离（IS-2/3） | ✅ | manager 仅持 refId，bytes 在 worker 边界瞬时读出；temp 释放点多且幂等 |
| 临时文件清理 | ✅ | `_release_inputs` 在 scheduler cancel / 异常 / cleanup / 迟到回调均有释放点，幂等 |
| 解析入口校验 | ✅ | `create_batch` 强制 `refId` 存在，否则 `ValueError` |
| 批级取消语义 | ✅ | `cancel_batch` 置 `cancelled`；`_wait_for_completion` 顶部检查 cancel 先于 timeout，避免误翻 stale job |
| 并发页码安全 | ✅（脆弱） | 见 🟡-2，当前契约规避，但启发式是隐患 |
| 归档路径穿越 | 🟡 待验证 | 见 🟡-4 |
| SSE 鉴权 | 💭 | 批 ID 形如 `B{timestamp}_{uuid6}`，本地 Electron 后端风险低；若后端外暴露需加鉴权 |

---

## 六、涉及文件清单

**后端（核心路径）**
- `backend/import_batch_manager.py`（watchdog / 生命周期 / 页码启发式 / 队列满记账）
- `backend/parse_job_manager.py`（AC2 守卫 / 完成回调 / 队列满路径 / 5E 探针）
- `backend/page_result_store.py`（完成判定）
- `backend/services/invoice_service.py`（PDF 缓存消费 / 死变量）
- `backend/config.py`（`CACHE_DEBUG` 默认已为 `'0'`）
- `backend/app.py`（`/split_pdf` 1-based `page_index`，5F-1 单页提前返回）

**前端（编排 / 身份 / 命名）**
- `frontend/src/import/runChunkedImport.js`（编排层，整洁）
- `frontend/src/hooks/useFileOps.js`（导入主 hook，hydrate + assembly 接线）
- `frontend/src/utils/fileHelpers.js`（`buildSplitPageName` / `processPdfFile`）
- `frontend/src/utils/identity.js`、`groupDocuments.js`（身份/分组，符合冻结契约）
- `frontend/test/splitPageFileNameInvariant.test.mjs`（不变式测试，mock 基与 prod 不符，💭）

**Electron**
- `electron/archive-names.js`（`resolveArchiveFileNames`，设计良好；写盘 sanitize 待验证 🟡-4）

---

## 七、建议处理顺序

1. **🟡-1** 删除 3 处 5E 探针（低风险、立即可做、恢复项目纪律）。
2. **🟡-2** 删除 `_parse_page_info` 启发式 + `_zero_based_buckets`（消除并发数据损坏隐患 + 内存泄漏）。
3. **🟡-4** 验证归档写盘用 basename-only `finalName`，补齐分隔符 sanitize。
4. **🟡-3** 把超时判定原子化（对称性 AC2 守卫）。
5. **💭** 清理死变量、补拆分失败 UI 提示、对齐测试 mock 基。
