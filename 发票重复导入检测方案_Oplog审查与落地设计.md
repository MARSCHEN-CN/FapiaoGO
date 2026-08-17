# 发票重复导入检测 —— Oplog 审查与落地方案（终版）

> 角色：Code Review（火眼眼）。先审查项目实际代码，再给出可行方案。
> 结论先行：**不要复用现有 Oplog 承载 `invoice_imported` 事件**——它本质是 WAL（写前日志），会被周期性压缩清空，复用会导致历史记录 100% 丢失。
> **终版存储选型：独立 JSON 文件 + 内存索引（不上 SQLite）**；生命周期按**开票日期 `invoiceDate + 3 年`** 清理。

---

## 1. 代码审查发现（基于 `backend/db.py` 实际实现，不变的核心论据）

### 🔴 Blocker 1：现有 `invoices.oplog` 是 WAL，不是审计日志，会被清空

| 证据 | 位置 | 含义 |
| --- | --- | --- |
| `COMPACT_THRESHOLD = 50` | `db.py:157` | oplog 累计 50 条 op 即触发压缩 |
| `_maybe_compact()` | `db.py:697-700` | `_oplog_count >= 50` 时调用 `_compact_oplog` |
| `_compact_oplog()` 清空文件 | `db.py:625-628`：`open(OPLOG_PATH, 'w').close()` | **压缩后 oplog 文件被整体截断** |
| `_handle_compact_markers()` | `db.py:743-762` | `COMPACT_READY` 存在时同样清空 oplog |
| `_replay_oplog()` 只重建 `_invoices` | `db.py:491-579` | 回放只还原"当前发票记录"，**不保留事件历史** |

**推论**：往 `invoices.oplog` 追加 `invoice_imported` 会在第 50 条 op 时随快照压缩被 `open(...,'w')` 抹掉 → 历史 100% 丢失。**Oplog 管"系统如何恢复当前状态"，Import History 管"这个号码历史上是否导入过"，两者生命周期完全不同，必须分开。**

### 🔴 Blocker 2：现有发票有 7 天保留期，且 `find_duplicates` 只查存活记录

| 证据 | 位置 | 含义 |
| --- | --- | --- |
| `INVOICE_RETENTION_DAYS = 7` | `db.py:54` | 发票记录默认只保留 7 天 |
| `cleanup_expired_invoices()` | `db.py:840-870` | 删除 `created_at` 超 7 天的发票 |
| 调用点 | `app.py:1951` | 周期性清理已接入 |
| `find_duplicates()` | `db.py:1548` | 只查存活 `_invoices`，过滤 `deleted_at` |

**推论**：基于发票表的重复检测只能覆盖最近 7 天；且 `find_duplicates` 是"当前共存重复"语义，与"历史是否导入过"不同。**Import History 必须独立存储、独立生命周期。**

### ✅ 注入点清晰：所有导入路径收口于两处

| 路径 | 位置 |
| --- | --- |
| 批量导入（主链路） | `app.py:1462` → `db.batch_upsert_invoices` |
| ImportBatchManager 缓冲落盘 | `import_batch_manager.py:1184` → `db.batch_upsert_invoices` |
| 单张 legacy 链路 | `app.py:511/1296/1334`、`invoice_service.py:539` → `db.upsert_invoice` |

在 `db.upsert_invoice` 与 `db.batch_upsert_invoices` 的"**新建记录**（`is_new=True`）"分支挂钩，即可覆盖 100% 入口，且写锁已持有。

---

## 2. 终版设计

### 2.1 数据模型（一个发票号码 = 一条记录，聚合而非事件日志）

```text
invoiceNumber       TEXT 唯一检测键（归一化后）
invoiceDate         DATE 开票日期（决定生命周期）
firstImportedAt     DATETIME 首次导入时间
lastImportedAt      DATETIME 最近导入时间
importCount         INT 累计导入次数
```

> **系统实体身份 ≠ 重复检测身份**：`InvoiceDocument.id`（uuid hex）继续承担"这次导入的实体"；本表的检测身份**只有 `invoiceNumber`**。越简单越不容易和现有 identity 体系再次耦合——**不要放入 `source_doc_id` / `invoiceDocumentId`**。

### 2.2 存储选型（终版结论：JSON + 内存索引，不上 SQLite）

| 方案 | 终版结论 | 原因 |
| --- | --- | --- |
| 复用现有 Oplog `invoice_imported` | ❌ | `db.py:625` 压缩清空，历史必丢 |
| **独立 `invoice_import_history.json` + 内存 `Dict`** | 🥇 **采用** | 与项目既有「JSON + 内存索引 + 原子写」架构一致；O(1) 查询；1 万~10 万条毫无压力；不引入新范式 |
| SQLite 独立表 | ⚠️ 备选升级路径 | >100 万条 / 多进程并发写入时才需要；当前业务只有 `number → 是否存在` 的 O(1) 查询，提前引入反而增加 schema/migration/连接/备份/打包/测试重量 |
| 塞进 InvoiceDocument | ⭐ | 生命周期语义错 + 随 7 天清理丢失 |
| 文件 JSON snapshot | ⭐ | 不适合全局去重 |

**文件**：`database/invoice_import_history.json`（顶层为一个 dict，key=归一化号码）。
**内存**：`_history_by_number: Dict[str, {invoiceDate, first, last, count}]`，启动时整文件加载（10 万条约几 MB，毫秒级）。
**持久化**：内存即时更新（O(1)）；落盘用**原子写**（临时文件 + `os.replace`）——为降低高频导入时的整文件重写开销，**每个 batch upsert 或单张 upsert 结束时各 flush 一次**（而非每条记录重写一次）。

```json
{
  "123456789012": {
    "invoiceDate": "2026-08-09",
    "firstImportedAt": "2026-08-10T09:12:31+08:00",
    "lastImportedAt": "2026-08-17T15:32:10+08:00",
    "importCount": 2
  },
  "987654321098": {
    "invoiceDate": "2026-08-10",
    "firstImportedAt": "2026-08-11T10:20:00+08:00",
    "lastImportedAt": "2026-08-11T10:20:00+08:00",
    "importCount": 1
  }
}
```

### 2.3 🔴 生命周期红线（务必写进注释与测试）

> **`invoice_import_history.json` 独立于 `invoices`、独立于 Oplog、独立于现有 7 天清理机制。任何压缩/清理逻辑都只许作用在发票体系，不得波及本文件。**

- 绝不参与 `_compact_oplog`（`db.py:625` 的清空）。
- 绝不参与 `cleanup_expired_invoices`（`db.py:840`，7 天规则）。

### 2.4 🟢 3 年清理规则（按 `invoiceDate`，不按导入时间）

**业务目标**：防止同一张发票被重复报销 → 生命周期应围绕**发票本身**，不是"最后一次导入"。

```text
保留截止日 = invoiceDate + 3 年
DELETE WHERE invoiceDate + 3 年 < 今天
```

| 发票号码 | 开票日期 | 最近导入 | 是否保留 |
| --- | --- | --- | --- |
| A001 | 2026-08-01 | 2026-08-10 | ✅ |
| A002 | 2025-01-10 | 2026-08-10 | ✅ |
| A003 | 2023-08-01 | 2026-08-10 | ❌ 超 3 年 |
| A004 | 2022-01-01 | 2026-08-10 | ❌ |

- **边界明确**：`invoiceDate + 3 年 < 今天` 才删；未到 3 年（哪怕差 1 天）必须保留。例：`invoiceDate=2023-08-20, today=2026-08-17` → 未满 3 年，保留。
- **惰性清理**：不在每次导入时判定，而是在"下一次维护周期"执行（启动时 / 接现有清理 cron 时调用 `import_history.cleanup_expired()`）。
- **`invoiceDate` 缺失的兜底**（解析失败无日期）：用 `firstImportedAt` 作为 cutoff 依据并记 warning，避免记录被永久保留或误删；不允许 `invoiceDate` 缺失却按"永不清理"静默放过。

### 2.5 写入时机（满足"不要假记录"）

在 `upsert_invoice` / `batch_upsert_invoices` 的**"新建记录"（`is_new=True`）分支成功后**调用 `record_import(number, invoice_date)`：

- ✅ 不命中"同文件重解析（update 分支）" → 不产生假历史。
- ✅ 不命中"文件拖入即取消" → `upsert` 只在解析成功 + 提交时触发。
- ✅ 内容重复的另一份文件（新建 `is_duplicate` 记录）也会写入 → 正是真实报销风险场景。
- `record_import` 逻辑：已存在则 `importCount += 1`、`lastImportedAt = now`（**首导入时间保留**）；不存在则新建，`first=last=now, count=1`。

**`invoiceDate` 取值**：`row.get('date') or row.get('invoiceDate')`（现有发票日期字段为 `date`，见 oplog 样本 `"date":"2026-05-02"`）。号码归一化：`normalize_invoice_number()`（strip + 去内部空白 + 可选大写），为空则不记录。

### 2.6 查询与 UX（风险提醒，**不拦截**）

- 新增 `GET /api/import-history/<number>`（参考 `app.py:577` `/api/db/duplicates/<number>`，注意 `unquote`）。
- **前端流程**：解析完成、拿到 `number` 后**预查询**历史；若 `exists`：

  > ⚠️ 发现重复发票
  > 发票号码：12345678　开票日期：2026-08-01　首次导入：2026-08-10
  > 该发票此前已导入过，可能存在重复报销风险。
  > `[取消]` `[仍然导入]`

- **取消** → 不提交 → 不写历史（无假记录）。
- **仍然导入** → 正常提交 → `record_import` 累积（`importCount += 1`，更新 `lastImportedAt`），历史不被覆盖。

---

## 3. 实施步骤（可直接落地）

1. **`backend/import_history.py`**（独立模块，自带 rwlock + 懒加载）：
   - `load()`：读 JSON → 内存 dict；文件不存在则空。
   - `record_import(number, invoice_date)`：归一化 → 更新/新建内存记录 → 标记 dirty → 落盘（原子写，throttled）。
   - `get_import_history(number) -> Optional[{invoiceDate,first,last,count}]`、`has_imported(number) -> bool`。
   - `cleanup_expired(today=None)`：**按 `invoiceDate + 3 年 < today` 过滤删除**，缺日期回退 `firstImportedAt`，返回删除条数；清理后原子重写。
   - `normalize_invoice_number()`。
2. **`db.py` 挂钩**：在 `upsert_invoice`（新建分支 `db.py:931-959`）与 `batch_upsert_invoices`（新建分支 `db.py:1017-1039`）成功后调用 `import_history.record_import(number, invoice_date)`（仅 `is_new` 且 `number` 非空）。
3. **`app.py` 接口**：新增 `GET /api/import-history/<number>`，读锁返回 `{exists, invoiceDate, first, last, count}`。
4. **`app.py:1951` 附近**：在 `cleanup_expired_invoices()` 调用旁，新增 `import_history.cleanup_expired()`（**独立 3 年规则**，与 7 天清理并列但互不影响）。
5. **前端导入流程**：解析完成 → 预查询 → 软警告（`[取消]/[仍然导入]`）。
6. **测试**（`backend/tests/`）：
   - `record/get/has` 基本链路；`importCount` 累积、`first` 不被覆盖；
   - **压缩豁免**：调 `_compact_oplog` 后历史文件仍在、可查（防回归核心）；
   - **7 天清理豁免**：调 `cleanup_expired_invoices` 后历史仍在；
   - **3 年清理**：构造 `invoiceDate` 跨 3 年边界的记录，验证 `invoiceDate+3y<today` 才删、差 1 天保留、缺日期回退；
   - **号码归一化**；空 number 不记录。

---

## 4. 风险与边界

- **多进程/多 worker**：当前单进程 Flask + rwlock 足够；若未来多 worker 并发写同一 JSON，需加文件锁——届时直接切 SQLite（见 2.2 备选），无需改接口。
- **整文件重写开销**：10 万约几 MB；已用"每 batch/每单张 upsert 末 flush 一次"摊薄。若未来单批极大，可再改 throttled 定时器。
- **号码缺失**：解析失败无 `number` 不记录；无 `invoiceDate` 时清理回退 `firstImportedAt` 并告警。
- **历史回填（可选）**：若要让"已存在的发票"也进入历史，可写一次性脚本扫描 `invoices.json` 的 `created_at`/`date` 回填，不在首版范围。

---

## 5. 对你推荐表的终版修正

| 方案 | 终版结论 |
| --- | --- |
| 复用 Oplog `invoice_imported` | ❌（`db.py:625` 压缩清空，历史必丢） |
| **独立 `invoice_import_history.json` + 内存 `Dict`（按 `invoiceDate+3年` 清理）** | 🥇 采用 |
| SQLite 独立表 | ⚠️ 仅当 >100 万条 / 多进程写入时升级 |
| 塞进 InvoiceDocument | ⭐（叠加 7 天清理，实际更差） |
| 文件 JSON snapshot | ⭐ |

**架构边界一句话**：`Oplog` 管"系统如何恢复当前状态"，`InvoiceDocument` 管"这次导入的实体"，`InvoiceImportHistory` 管"这个发票号码历史上是否曾经被导入"——三者生命周期不同，分开是正确的。

**下一步**：如认可，我可直接实现 `import_history.py` + `db.py` 两处挂钩 + `GET /api/import-history/<number>` + `app.py:1951` 的 3 年清理调用，并补齐上述 6 类回归测试。
