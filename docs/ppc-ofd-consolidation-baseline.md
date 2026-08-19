# PPC-OFD Integration — Consolidation Baseline（3-A 系列归档）

> 性质：docs-only，Phase 3-A 封存归档
> **FINAL BASELINE = `c615b2d`**（可作为 Gate 3-B 起始基线）
> 前置：R1 CLOSED / PPC RATIFIED / Gate 4 CLOSED / PPC-OFD Gate 1-2 PASS / Gate 3-A.1~3-A.5 PASS

---

## 1. Phase 3-A 验收矩阵汇总

| Gate | 状态 | 测试数 | 验证要点 |
| --- | --- | --- | --- |
| 3-A.1 Single OFD Consumer Path | ✅ PASS | 6/6 | 无 OFD 专属分支 / canvas=normalize(paperRect) / bbox≥15% / 无裁切 / rotation-once / preview-print 参数一致 |
| 3-A.2 Rotation Single Application | ✅ PASS | 4/4 | userRotation 0/90/180/270→rotate 0/1/1/1 / sourceRotation sentinel（watchpoint）/ V16 fallback 语义 / preview-print contentRotation contract |
| 3-A.3 OFD+Image Merge Geometry | ✅ PASS | 8/8 | 混合组 vs 纯 Image 逐槽 deepEqual（格式无关）/ merge2·merge4 分区=computeSlots / 无 if(ofd) 偏移 / rotation isolation |
| 3-A.4 OFD+PDF Merge Isolation | ✅ PASS | 7/7 | 无双轨（PDF raster 统一）/ merge4 grid / native bypass sentinel（isSinglePdfNative 单文件限定）/ rotation isolation |
| 3-A.5 OFD Multi-Page Contract | ✅ PASS | 6/6 | page index 映射（fetch 1/2/3）/ per-page raster identity / 无 page[0] 复用 / 文件级 rotation 逐页独立 / render isolation / **cache identity sentinel（PPC-OFD-3A5-C1）** |

**累计**：31/31 PASS。Gate 4.3 回归 15/15 PASS（全程无损）。

## 2. PPC-OFD Defect Ledger

| ID | Severity | 状态 | 根因 | 修复 | 验证 |
| --- | --- | --- | --- | --- | --- |
| **PPC-OFD-3A5-C1** | High | ✅ CLOSED（c615b2d） | Multi-page render cache key missing page identity：`buildCacheKey`（L2）只含 items key、L1 `itemRenderCache` key 同缺页维度；usePrint 多页循环每页 pageItem 同 key（usePrint.js:226）→ 第 2+ 页 L2 命中返回第 1 页 canvas → **多页 OFD 打印 N 张全部第一页** | `buildCacheKey` + L1 key 追加 `getRenderCachePageId(item)`（优先级 renderPage→pageNum→pageIndex→_previewImageUrl→''） | A5.1-A5.6 全 PASS（修复前 A5.2-A5.5 FAIL 暴露，修复后翻转）；全回归绿 |

**其他观察项（非缺陷，未来 Gate）**：
- OFD `sourceRotation` 当前无前端消费点（Option A 裁决，sentinel T2 保留；待真实 Rotate≠0 票据出现再开 R1 review）。
- V16 `fileObjToComposePagePlan` rotations `{key:0}` falsy → fallback item.rotation 生效（与旧路径「显式 0 即 0」差异，观察哨非缺陷）。

## 3. Production Diff 清单（基线 c615b2d 内全部生产改动）

**唯一生产文件：`frontend/src/renderers.js`**（PPC-OFD-3A5-C1 修复，cache identity 层）

| 位置 | 改动 |
| --- | --- |
| 新增 `getRenderCachePageId(item)` | 页身份提取：`renderPage（renderDocId:renderPage）→ pageNum → pageIndex → _previewImageUrl（兜底）→ ''` |
| `buildCacheKey`（L2） | item 段 `key` → `key|pageId`（无页语义与旧 key 一致） |
| L1 `itemRenderCache` key ×2（_renderDirect / _renderViaWorker） | 追加 pageId（与 L2 同步，防 L1 二次污染） |

**其余全部为 test-infra / docs**：`frontend/test/printGate/`（gate3A1-A5 + nodePolyfill + env-shim.loader 扩展）、`docs/ppc-ofd-*`。

## 4. Test Infra 收敛状态

```
frontend/test/printGate/
 ├─ env-shim.loader.mjs    import.meta.env shim + ?url 虚拟模块 + extensionless → +.js（resolve hook）
 ├─ nodePolyfill.mjs       DOMMatrix / document / Image / window / HTMLCanvasElement / MockCtx（含 source 记录）/ MockImage
 ├─ gate3A1SingleOfd.test.mjs   6 tests
 ├─ gate3A2Rotation.test.mjs    4 tests
 ├─ gate3A3OfdImageMerge.test.mjs  8 tests
 ├─ gate3A4OfdPdfMerge.test.mjs   7 tests
 ├─ gate3A5OfdMultiPage.test.mjs  6 tests
 └─ gate4Regression.test.mjs     15 tests
```

运行命令（统一）：
```
cd frontend
node --loader ./test/printGate/env-shim.loader.mjs --test ./test/printGate/<file>.test.mjs
```
⚠️ 勿跑 `node --test test/`（捞到 import.meta.env 技术债）。

## 5. 工作树隔离确认（2026-08-19 22:0x 快照）

- ✅ **已跟踪文件工作树干净**（无未提交修改）。
- ✅ 用户独立改动已入库：`9286f91`（Electron 应用图标 + 自动预览解耦文件状态，usePreview.js / electron/main.js）；FileList.jsx 属 filelist 系列（9633b85 等）已提交。
- ✅ Gate 链提交与用户提交互不交叉：`... 9286f91 → c615b2d`。
- ⚠️ untracked 历史残留（**按纪律不处理**）：`.git.broken2/`、`.git.corrupt_20260817/`（仓库事故遗留）、`_ap_dr_*` / `ap_dr*.py`（AP-DR 探针）、`_check_pikepdf.py` 等。

## 6. Gate 3-B 起始前置条件（引用）

- **基线**：`c615b2d`（3-A 全 PASS + Gate 4.3 15/15）。
- **验证范围**（docs/ppc-ofd-integration-gate3-e2e-matrix.md §3-B）：真实 Sumatra/Windows printer E2E——纸张尺寸/无裁切/rotation 与预览一致/merge 物理位置与 3-A canvas 一致。
- **失败归因**（矩阵 §5）：3-B 与 3-A canvas 不一致 → materialization/Sumatra 层 defect（单列）；根因指向 Producer 需 Gate 2 证据。
- **新外部变量**（用户提示）：Windows printer driver / Sumatra CLI / spooler / physical media geometry——3-A 归档后物理问题不再混入 render contract。

## 7. 状态

```
[R1 CLOSED] [PPC RATIFIED] [Gate 4 CLOSED]
[PPC-OFD Integration]
  Gate 1: PASS / Gate 2: PASS
  Gate 3-A.1~3-A.5: 全 PASS（31/31，含 PPC-OFD-3A5-C1 修复）
  Phase 3-A FINAL BASELINE = c615b2d
  下一步: Gate 3-B（真实打印 E2E，用户实机）或 PPC Consolidation 后续项
```

待用户 push 链：`... 6acd487 → 7ab55e1 → c615b2d`（远程 tip 1681b60）。
