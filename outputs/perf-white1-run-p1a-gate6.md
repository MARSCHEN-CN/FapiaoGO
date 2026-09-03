# PERF-WHITE-1 / P1-A — Gate 6 冷路径复跑说明

> Gate 5（热路径 A/B）已裁决：Publish 454→43、白屏窗口零长任务 → 机制 PASS（`perf-white1-run-p1a-gate5-verdict.md`）。
> Gate 6 = **冷路径回归**：重置导入历史（importCount=1）后导入同批 261 张，
> 目的有二：
> 1. **P1-A 无回归**：冷路径下列表渲染/导入链路与基线 run-261 可比（该轮就是冷路径跑的）；
> 2. **刷新冷路径基线**：run-261-user-raw.json 是 P1-A 前旧代码基线，本轮刷新后可直接裁决「前端改动对冷路径零副作用」。
>
> ⚠️ 前置条件：Gate 5 眼证确认无异常（弹窗关闭即见完整列表 / 列表总数 523）。
> 若眼证为 C（仍白 >5s）或 D（新文件未出现），**先不要跑 Gate 6**，回查 P1-A。

## 与 Gate 5 的唯一差异

**Gate 6 = 先重置导入历史，再导入。** 其余照 Gate 5 流程（dev 三件套热服，无需打包）。

## 导入历史存储点（已核实，2026-09-03）

- **单点**：`database/invoice_import_history.json`（后端 `import_history.py`：启动载入内存 Dict + 原子写）
- **独立于** sqlite invoices / Oplog / 7 天清理（冻结约束，设计文档写明任何清理不得波及本文件）
- 前端永不直接读写（`前端P1接线冻结规格.md:101`）
- ⚠️ 上次「删 database/ 数据复活」是 **sqlite WAL oplog 回放**，与 import history 无关 —— 清这个 JSON 不会复活任何东西

## 复跑步骤（顺序不能乱）

1. **停** Electron + 后端（三件套全停）
2. **备份 + 清空历史**（先备份再写 `{}`，不删文件）：
   ```powershell
   cd E:\print706; Copy-Item database\invoice_import_history.json database\invoice_import_history.backup-gate6.json; Set-Content -Path database\invoice_import_history.json -Value '{}' -Encoding UTF8
   ```
3. 起三件套（`npm run dev` + 后端 + `npm start`）→ 应用重启
4. **核查冷路径就绪**（后端起来后再跑一次）：
   ```powershell
   cd E:\print706; python -c "import json;d=json.load(open('database/invoice_import_history.json',encoding='utf-8'));print('entries',len(d))"
   ```
   - 输出 `entries 0` → 冷路径就绪
   - 若 >0 → 有东西在启动时写回了（异常，停，别往下跑，回报）
5. 导入**同一批 261 张**（此时每张都是首次导入 → importCount=1 → 不命中热更新分支）
6. 进度弹窗关闭后**等 ≥20s**（观察窗 15s + 余量）
7. 剪贴板 JSON 报告贴回来（或存文件给路径）

## 这轮报告会看到什么

| 字段 | run-261 冷基线（旧代码） | Gate 6 预期（P1-A 后） | 含义 |
|---|---|---|---|
| `importHistoryResponse` | —（旧名 Write） | **≈ 0** | 冷路径无既有条目可更新 → 查询全空 |
| `importHistoryPublish` | — | ≈ 0 | 无发布 |
| `applySort` | （1B=195 / Gate5=51） | 小 | 冷路径排序触发应比热路径少 |
| `T5→T6`（白屏） | 旧基线数据 | 与旧基线同量级或更好 | **冷路径无回归判据** |
| `invoiceDocumentToRow` | 561 | ~同量级 | 负载可比性 |

## 判读

```powershell
cd E:\print706; node outputs\perf-white1-adjudicate.mjs <报告文件或--stdin>
```

本轮是**冷路径** → 可比性守卫应 **✅ 通过**（importHistory 命中≈0），
并与 run-261 冷基线自动出新旧对比表。若守卫报 🔴 热路径告警 → 说明历史没清干净，回步骤 2。

## 通过标准（Gate 6）

1. 可比性守卫 ✅（冷路径，命中≈0）
2. T5→T6 / 白屏窗口长任务与 run-261 冷基线同量级或更好（P1-A 对冷路径零副作用）
3. 眼证：弹窗关闭即见完整列表，总数 261（本轮为全新历史，列表从导入前的状态 +261）
4. Gate 6 之后：PERF-WHITE-1 P1-A 全部 Gate（1–6）收口，可出总结论；P1-B/C 维持 DEFERRED
