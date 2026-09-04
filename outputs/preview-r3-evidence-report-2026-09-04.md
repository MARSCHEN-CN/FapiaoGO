# R3 Runtime Evidence Report —— P2 X1/X2/X3 实机回归裁决

> 日期：2026-09-04　分支：`rotation-b1-hardening`　基线 HEAD：`42bbf44`（X1 `7e30453` / X2 `2d2c814`+hotfix `42bbf44` / X3 `4203d2a`）
> 原始证据：`outputs/perf-runs/preview-r3-x123-8files-20260904.json`（104 events，8 PDF，dev 模式 localhost:5173）
> 对照基线：R2 dump `outputs/perf-runs/preview-r2-8files-20260904.json`（79 events，修复前）
> 纪律：只 commit docs/evidence，生产代码零改动；不 push。OBS-1/OBS-2 记录为 P2 后候选项，不修。

---

## 0. 证据卫生

- counters 与 events 完全自洽：**13/13 OK**（AUTO_PREVIEW 18 / HANDLE_PREVIEW 18 / SCHED_DECISION 10 / START 10 / LOAD_START 10 / LOAD_RETURN 10 / DEBOUNCED 11 / COMMIT_ATTEMPT 4 / COMMIT_SUCCESS 4 / FUSE_BLOCK 3 / TERMINATED 3 / DOCID_RETRY_EVAL 1 / DOCID_RETRY_SKIP 2），eventCount=104=dropped 0。
- 附注（trace 格式小漂移，不影响事件语义，审计脚本已兼容）：seq 43 的 `key` 落在 fields 之外；seq 100 用 `options` 包装而非 `fields`——两处观测点参数命名不一致，属 previewTrace 自身格式问题，非调度缺陷。

---

## 1. R2 → R3 对照（核心反事实）

| 环节 | R2（修复前，79 events） | R3（修复后，104 events） |
|---|---|---|
| 半壳结局 | v6 半壳 `COMMIT_SUCCESS`（docId=null）→ 空白凝固 | v6/v7/v8 半壳 → **`FUSE_BLOCK why='not-displayable'` ×3**，零半壳 commit |
| execution 生命周期 | commit 后残留 `post-load` 僵尸 | 每次 FUSE_BLOCK/COMMIT 后 execution=null（X1） |
| refresh 命运 | 5 次 `MERGE_DEFERRED` 扑空（seq 45/49/65/69/73，39s 静默） | **`MERGE_DEFERRED = 0`**；每次后续 select 直接 `SCHED_DECISION action='start'` |
| debounce 窗口 | refresh 顶掉 docId-ready select → 意图丢失 | docId-ready 窗口内 8×HANDLE_PREVIEW + 6×DEBOUNCED **全 select**，无降级 |
| docId 后到结局 | 只能靠用户点击（v7 click 走 immediate） | **零点击自动恢复**：v9 COMMIT_SUCCESS @7712.2 |

---

## 2. X1 runtime evidence（僵尸死锁消失）—— PASS

判据：`MERGE_DEFERRED execAction=restart-required` 趋零；FUSE_BLOCK 后能重新 START。

- dump 全程 **0 次 MERGE_DEFERRED**（counters 中该键甚至不存在）。
- 三次 FUSE_BLOCK（v6 @seq41 / v7 @seq53 / v8 @seq58）后，下一次 select 均干净重启：
  - v6 FUSE(3692.9) → v7 START(3843.5)
  - v7 FUSE(3846.8) → v8 START(3995.7)（debounce timer）
  - v8 FUSE(3996.1) → v9 START(7593.0)（docId 就绪后）
- R2 中同位置（seq 45→47/49→51/65/69/73）是 `restart-required → MERGE_DEFERRED` 吞掉；R3 全部 `action='start'`。

**结论：X1（commit/FUSE 后 execution 终态化）被运行时证据证实。**

## 3. X2 runtime evidence（debounce select 保真）—— PASS

判据：pending select 不被同窗口 refresh 降级。

- docId-ready 窗口（t≥7591）内，App scenario-2（seq 67-68）+ scenario-3（seq 70-71）+ usePreview files-effect/auto-nav（seq 59-60/64-65/73-74/76-77）叠加触发 **8 次 HANDLE_PREVIEW，intent 全部 = select**。
- 对应的 6 次 DEBOUNCED（seq 66/69/72/75/78）intent 全部 = select，`hadPendingTimer=true` 5 次（多意图叠加于同一窗口）。
- 全程无「pending select → timer 执行 refresh」形态；窗口内**无任何 refresh 插队**（本 dump 的 refresh 全部出现在 v9/v10 COMMIT_SUCCESS 之后，属 auto-nav-3 的正常合并重刷，见 OBS-1 上下文）。
- 仲裁结果最终以 select 语义进入执行：seq 61/83 SCHED_DECISION `intent='select'`。

**结论：X2（同窗口 select 意图保真）已实机覆盖。**

## 4. X3 runtime evidence（半壳 commit gate）—— PASS

判据：pdf-backed + 无有效 docId → FUSE_BLOCK，无 COMMIT_SUCCESS；docId 后到后有新调度机会。

- 三次被拦快照形态与 R2 v6 半壳**完全一致**：`LOAD_RETURN docId=null + hasPdfData=true + hasPreviewImageUrl=false`（seq 40/52/57）→ `FUSE_BLOCK caller='commit-fuse:P2-X3' why='not-displayable'`（seq 41/53/58）。
- **半壳 COMMIT_SUCCESS/COMMIT_ATTEMPT = 0**。
- 4 次 COMMIT_SUCCESS（seq 81/88/96/104）全部：`docId=d8bf968f4381db391a45cea6`（就绪）+ `hasPreviewImageUrl=true`（真可展示）。
- docId 后到后有新 START（v9 @7593），无卡死。

**结论：X3（commit eligibility gate）获直接运行时证据。**

## 5. D 判据（用户体验）—— PASS（P2 最有价值的验收）

> docId 后到 → 无需点击 → 自动恢复并成功展示。

事实链（全部自动源）：

```text
docId ready @ t=7591（后端解析完成，seq 59 前 3.6s 为业务等待）
  ↓ files-effect no-preview-first（seq 59-60，docId=d8bf…）
v9 START @7593（SCHED action='start'，execution 空 = X1 让路）
  ↓ LOAD_RETURN @7624.5（docId + previewImageUrl=true —— 有 docId 才渲染出真图像）
COMMIT_SUCCESS @7712.2（seq 81，version 9 == currentVersion 9）
  ↓ 自动展示成功
```

- 导入触发（t=3116）→ 首次自动 COMMIT_SUCCESS（t=7712.2）：**约 4.6s**。
- HANDLE_PREVIEW caller 集合 = {usePreview files-effect(2342) / auto-nav(2477,2490) / App scenario-2(993) / scenario-3(1005)} —— **无任何 click 来源**。
- 最大事件间隙 3.6s（seq 58→59，docId 解析期）；无 30s+ 静默空洞。
- DOCID_RETRY_EVAL @seq82：pfDocId==liveDocId，changed=false（收敛后不再空转）。

**结论：R2 的「导入后需点一次才显示」用户故障已消失。**

---

## 6. 裁决

| 项 | 判定 |
|---|---|
| X1 commit 后 execution 终态化 | **PASS**（runtime） |
| X2 debounce select 意图保真 | **PASS**（runtime） |
| X3 半壳 commit gate | **PASS**（runtime） |
| D 自动预览自恢复 | **PASS**（runtime） |
| counters 卫生 | 13/13 自洽 |
| 生产代码改动 | 本轮零改动（修复本身见 7e30453/2d2c814/42bbf44/4203d2a） |

**P2 修复闭环 = 运行时 PASS。**

---

## 7. 观察项（DEFER，不入 P2 验收）

### OBS-1：v10 stale debounce → 冗余 commit

现象：v9 COMMIT_SUCCESS @7712.2 后，v9 加载期间累积的 debounce timer（seq 78 @7623.6 设定，150ms）仍存活，@7799.6 fire → 以 select 语义再启动 v10 → 同 key 同 docId 重复完整加载（LOAD_RETURN @7800，0.2ms 缓存命中）→ COMMIT_SUCCESS @7813.2。同文件共 commit 4 次（v9 select + v10 select + auto-nav-3 refresh ×2 @8722/@9829）。

性质：**非 X1/X2/X3 失败**——无白屏、无死锁、无点击、终态正确。X1 清了 execution 但 COMMIT_SUCCESS/COMMIT_CACHE 路径不清 `switchTimeoutRef`（timer 只被 doLoadPreview 入口与 cleanup 清理）。

后续只读审计问题清单（暂不实施）：
1. commit 成功时是否应取消 pending timer（当 timer 的 key == committed key）？
2. v10 是否与 v9 完全同 key/version/snapshot（本 dump：同 key、version 9→10、同 docId）？
3. 无条件清 timer 会否误杀「commit 后紧接着的合法新 select」debounce？
4. 更正确的方案是 timer ownership/version guard（timer fire 时若 currentVersion 已推进则跳过）而非简单 clear？
5. seq 89-104 两次 auto-nav-3 refresh（merge，version 不推进）是否为 files 对象渐进更新的合法重刷（对比 OBS-1 defect 需区分）？

### OBS-2：docId 未就绪时的无谓完整 load

现象：X3 是 commit gate 而非 load admission gate——docId 未到期间 v6/v7/v8 每次都真实执行 loadFilePreview 到 LOAD_RETURN（半壳）才被 fuse 拦。加载耗时：v6 36.8ms（真渲染）、v7 2.7ms、v8 0.1ms（后两次部分缓存/去重）。频率：3 次 / ~875ms 内（3692→3996），之后 docId 等待期（3996→7591）无新触发（files 稳定）。

性质：正确但不经济。每次重试必然失败（docId 没到，pdf-backed 无有效 docId），却先付了加载成本。

后续研究方向（新状态机优化，**绝不顺手塞入**）：
- loading admission：docId 不可用且 pdf-backed 时是否根本不应启动某类 PDF preview load；
- 或 loading loop 内提前 fuse（docId 就绪检查前置于加载前）；
- 涉及 loading admission / docId arrival / retry scheduling 的联动语义，需独立冻结契约 + 红测。

---

## 8. 收尾状态

- Step R3-1 冻结原始 dump：✅ `outputs/perf-runs/preview-r3-x123-8files-20260904.json`（40,166 B，SHA 以 git 记录为准）。
- Step R3-2 本报告：✅。
- Step R3-3 docs/evidence commit：本 commit（dump + report，与生产代码隔离）。
- Step R3-4 清 trace：用户真机执行 `localStorage.removeItem('FAPIAOGO_PREVIEW_TRACE')` + 刷新，验证 `__PREVIEW_TRACE__.enabled() === false`（或 dump 里 enabled:false）。
- Step R3-5 停：不进入 OBS 修复。

> OBS-1 / OBS-2 记录为 P2 之后的新优化候选项，不污染 X1/X2/X3 的成功判定。
