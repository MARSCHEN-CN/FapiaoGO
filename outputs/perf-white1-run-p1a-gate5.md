# PERF-WHITE-1 / P1-A — Gate 5 热路径 A/B 复跑说明

> P1-A 已落地（commit `39f49b9`）：importHistory 响应不再逐条发布 Map state，
> 改为 pending 合并 + 50ms debounce 单 flush，内容无变化不发布（noop）。
> Gate 5 = **同一热路径状态下**再导入同批 261 张，量化 P1-A 前后差异。

## 与 1B 复跑的唯一差异

**不要重置导入历史**。1B 那次跑完，`database/invoice_import_history.json` 是
40KB / 266 条 / 262 条 `importCount≥2` 的热路径状态 —— **正是 P1-A 要压的场景**。
重置了就变成冷路径（那是 Gate 6），A/B 对比就没了。

除「跳过重置」外，其余照 `outputs/perf-white1-run-1B.md`（dev 三件套热服新代码，无需打包）。

## 复跑前核查（30 秒）

停后端前先确认历史状态还在热路径：

```powershell
cd E:\print706; python -c "import json;d=json.load(open('database/invoice_import_history.json',encoding='utf-8'));c2=sum(1 for v in d.values() if isinstance(v,dict) and (v.get('importCount') or 0)>=2);print('entries',len(d),'count>=2',c2)"
```

- 输出 `entries 266 count>=2 262`（左右均可）→ 热路径就绪，直接跑
- 若 entries 很小 / count>=2=0 → 历史已被某次清理重置。两种选择：
  - 想复现热路径：导入一次 261 张让 count 涨到 ≥2（但那就是 Gate6 前的「预热跑」，本轮不算数）
  - 或直接接受冷路径数据（判读器会报 🔴 热路径告警 → 说明该轮是冷路径基准，也有价值）

## 复跑步骤（顺序不能乱）

1. **停** Electron + 后端（三件套全停）
2. 起三件套（`npm run dev` + 后端 + `npm start`）→ 应用重启
3. 列表**已有 261 张**（上轮导入的）→ 直接再导入**同一批 261 张**
   （重复导入 = 每张都命中 importCount≥2 → 触发热路径更新风暴场景）
4. 进度弹窗关闭后**等 ≥20s**（观察窗 15s + 余量）
5. 剪贴板 JSON 报告贴回来（或存文件给路径）

## 这轮报告会看到什么（P1-A 新判据）

| 字段 | 1B（P1-A 前） | P1-A 后预期 | 含义 |
|---|---|---|---|
| `importHistoryResponse` | —（旧名 Write=454） | ~454 | 响应命中数（**不变**，查询语义冻结） |
| `importHistoryPublish` | —（旧 Write 即此） | **显著 < 454**（可能个位数~几十） | flush 真实发布次数 |
| `importHistoryNoop` | 0 | >0 | 重复数据被合并放弃的批次数 |
| `applySort` | 195 | 下降 | sig 只在真实 key 增长时变 |
| `T5→T6`（白屏） | 30166ms | 下降？ | **主 KPI** |
| `longTasks` | 300（截断） | 下降？ | 主线程阻塞下界 |

KPI 判定标准（用户批准）：**N（Publish）显著小于 454 即成功**，不要求 =1
（HTTP 异步回包 + 主线程繁忙会把 flush 自然合并，N 取决于响应到达节奏）。

## 判读

```powershell
cd E:\print706; node outputs\perf-white1-adjudicate.mjs <报告文件或--stdin>
```

判读器会自动对比 run-261 基线并显示 publication 观察行
（`Response=454 → Publish=N（Noop=M）`）。
注意：本轮是**热路径**，可比性守卫会报 🔴 热路径告警 —— 这是**预期**的，
说明对比对象应是 1B 热路径报告（`outputs/perf-runs/run-261-1B-20260903.json`），
而非 run-261 冷路径基线。判读时以 T5→T6 绝对值 + Publish/Noop 相对 1B 的变化为准。

## 判读器已知边界

- 判读器硬编码签名检查的是 1B 探针字段（15s 窗 + preview 锚点），P1-A 未动探针 →
  签名校验依然通过
- cold-path guard 现兼容双字段：旧报告 `importHistoryWrite` / 新报告 `importHistoryResponse`
