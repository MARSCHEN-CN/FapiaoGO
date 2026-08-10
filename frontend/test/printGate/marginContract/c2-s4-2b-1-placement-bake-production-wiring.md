# C-2 Step 4-2b-1 — 生产 placement bake 接线（executor consumption）

> 日期：2026-08-10 ｜ 阶段：Phase 1-C-2 Step 4-2b-1 ｜ 基线：4-2a 冻结（`65a483b`）
> 关联 Gate：`placementBakeProductionGate.mjs`（生产接线回归基线，**A3-03 的 4-2b-1 侧扩展**）

## 1. 本步交付什么（vs 4-2a）

| | 4-2a（DEV 验证，已冻结） | **4-2b-1（本步）** |
|---|---|---|
| 证明 | Placement → PDF bake 几何可行 | **生产 `print-source-file` 真的消费了 executionPlacement** |
| 载体 | `placement_bake.py`（CLI）+ `placementBakeGate.mjs`（DEV） | `placement-bake-processor.js`（生产消费层）+ main.js 接线 |
| Sumatra 模式 | noscale（验证 bake 语义） | **仍 fit**（4-2b-1 冻结：只验 bake 接线，不切 noscale） |
| 验收 | A3-03：竖纸 + 居中 + 正确 margin | 接线判定 + bake 契约 + **fit 未二次变换 bake 几何** |

**4-2a 没有证明**：生产路径调用 bake。本步把它接上，且**不改变 Sumatra 的 fit 行为**（4-2b-2 单独裁决）。

## 2. 实现

### 2.1 `electron/print-service/placement-bake-processor.js`（新增，生产消费层）

```
settings.placement + settings.executionPaper（IPC，Step 4-1 已透传）
        │
        ▼
hasPlacement(settings, filePath)   决策：placement 字段完整 + executionPaper 有纸 + 源是 .pdf
        │                            + canBakeSafely（Sumatra 派生纸 == executionPaper）
        ▼
buildBakeSpec(input, settings, out) 字段搬运 → PlacementBakeSpec（4-2a 冻结输入契约）
        │
        ▼
process(input, settings, {outputDir})  spawn placement_bake.py → 临时 PDF；失败降级原路径
```

- **仅 PDF 源**：placement_bake 依赖 pikepdf Form XObject；OFD/图片降级原路径。
- **dpi 契约**：`BAKE_DPI = 300`，与前端 `PREVIEW_DPI` 对齐（placement 坐标域）。⚠️ 耦合点：PREVIEW_DPI 变更需同步。
- **优雅降级**：脚本缺失 / venv python 缺失 / bake 失败 → 返回原路径（Sumatra fit 兜底），绝不让 bake 成为打印硬依赖。
- **outputDir 参数注入**：不 require `temp-manager`（其依赖 electron，纯 node 无法测试 Gate）；main.js 传 `TEMP_DIR`。

### 2.2 `electron/main.js` `print-source-file` handler 接线

```js
const bakeEnabled = placementBake.hasPlacement(settings, target.filePath)
if (bakeEnabled) {
  // 4-2b-1：bake 接线（保留 fit，不切 noscale）
  const bakeResult = await placementBake.process(target.filePath, settings)
  if (bakeResult.path !== target.filePath) printTarget = { ...target, filePath: bakeResult.path }
} else if (hasMargins && imgExts.includes(fileExt)) {
  // 原 pdfMargin 路径（零变化）
}
```

关键决策：
1. **bake 优先并跳过 pdfMargin**：pdfMargin 的 expand_box 会撑大 MediaBox，与 bake 的 contain-fit 语义互斥，双重烘焙破坏源尺寸。placement 存在 = 前端已走新 Plan 路径，旧 margin processor 不再适用。
2. **无 placement 的旧调用零变化**（OFD/图片/旧路径全部原样）。
3. **顺手修复既有 TDZ bug**：旧代码 `let printSettings` 声明在 margin if 块内、块外引用——OFD/无 margins 走 else 时 ReferenceError。提升声明（默认值不变，零行为变化）。

## 3. 关键设计决策：`canBakeSafely`（纸一致性守卫）

bake 产物 MediaBox == executionPaper（Plan truth）。若 Sumatra 的 paper 命令（normalize 派生）与该尺寸错位，fit 会二次变换破坏几何。守卫：

```js
const spec = normalize(settings)          // Sumatra 纸（needSwap 后）
spec.paper.widthMM/heightMM ≈ executionPaper.widthMM/heightMM（±0.1mm）
```

source 轨（mergeMode='none'）下 normalize 与 resolvePaperSpec 同构、同源，正常相等；**printSettings 覆盖 / paperOrientation 显式字段**等偏差由守卫捕获 → 降级。这是生产接线的安全阀。

## 4. Gate 验收结果（`placementBakeProductionGate.mjs`，端到端 PASS）

生产形态 settings（placements useMemo 同源真实 placement + executionPaper）→ processor 判定 → 真跑 bake → Sumatra **fit**：

| 项 | 结果 | 判定 |
|---|---|---|
| hasPlacement(PDF) | true | ✅ |
| hasPlacement(OFD) | false（降级守卫） | ✅ |
| hasPlacement(纸型错位) | false（canBakeSafely） | ✅ |
| bake MediaBox | 595.28×841.89pt（210.06×297.01mm） | ✅ ==paper |
| bake /Rotate | 0（phi=270 内容烤进） | ✅ |
| Sumatra fit artifact | 209.97×297.1mm /Rotate=0 | ✅ |
| 内容中心漂移 vs 纸中心 | 0.92mm（容差 2mm） | ✅ |
| **fit 逐边增量**（artifact vs bake） | max 0.26mm（容差 0.5mm） | ✅ **fit 未二次变换** |

结论：**bake 后仍 fit 不破坏 bake 几何**（fit 引入的最大边距增量 0.26mm = 驱动舍入级）。这为 4-2b-2（fit→noscale）铺平：4-2b-2 只需单独裁决 D2，无需再怀疑 bake。

> ⚠️ 对称性（|L-R|=1.52mm）不作为判定项：受**源发票自身非对称内边距**影响（bake 产物本身 L-R=1.44mm），非 fit 问题。4-2a（A3-03 noscale）已验对称语义。4-2b-1 的精确验收 = 逐边增量。

## 5. ⚠️ 仓库事故与恢复（必须知晓）

**现象**：本轮回归时 `git status` 报 `not a git repository`；诊断发现 `.git/refs/` 目录 + 大量 loose objects 丢失（reflog 链上最近 8 个 commit `038b3dd`→`65a483b` 对象全部消失；pack 里只有早期历史）。

**诱因线索**：时间戳 22:00 与 `git stash` 失败（`unresolved deltas`）重合；`git stash` 触发时对象已缺失（stash 是受害者）。**并发 push 痕迹**：远端 `rotation-b1-hardening` = `ef9f2349` = merge(`c2baa59 优化导入速度`, `65a483b`)——`c2baa59` 基于 `d73f942` 与 4-2a 线分叉后合并，为其他会话并发提交。**疑似并发 git 操作互相破坏对象库**（具体破坏进程无法 100% 归因）。

**恢复过程**（数据零丢失）：
1. 重建 `.git/refs/` 骨架（heads/tags/remotes/origin）
2. 临时把分支 ref 指向 pack 内对象完整的 tag commit（`v16.0.1`）→ 修复 have 链
3. `git fetch origin rotation-b1-hardening` → 远端完整历史拉回，**8 个丢失 commit 全部恢复**（`65a483b` 等均在远端）
4. 本地分支指向远端 tip `ef9f2349`，同步 `c2baa59` 的 3 个文件（ImportProgressModal/useFileOps/modals.css）
5. 备份：`E:\print706\.workbuddy\backup\git-refs-recovery-20260810\`

**教训/建议**：
- 并发 git 写操作（尤其两个会话同时 push/merge/stash）危险；建议单会话操作或 push 前 `git fetch` 检查远端。
- 关键 commit 已 push 是本次零损失的前提——**push 纪律保护了我们**。

## 6. 回归与遗留

- gate 套件 **77/77 全绿**（含 equivalence 修复）；4 guard 全 PASS；新 4-2b-1 Gate 端到端 PASS。
- **equivalence 快照修复（独立 commit）**：`legacy_executePrint_snapshot.json` 的 13 处 `paper` 从 `{size}` 更新为完整 resolvePaperSpec 输出（C-2 Step 1/2 的 G-C2-1 扩展后快照未同步的**既有债**）；测试加 `stripUndefined`（JSON 快照无法表达 `paperkind: undefined`）与 legacy 的 normalizePlan 面比较（legacy oracle 的 paper 保持旧形态属忠实镜像，非 bug）。
- 遗留：4-2b-2（fit→noscale，D2）待单独裁决；Phase 1-B Step 4（删 add-pdf-margins.py）待 wiring 完成后。

## 7. 下一步（4-2b-2 提示）

4-2b-1 已证明「bake 后 fit 不破坏几何」。4-2b-2 将把 `fit` → `noscale`（D2 触碰点）：bake 产物 MediaBox==paper 时 noscale 与 fit 语义等价，但 noscale 消除驱动二次采样的理论风险。**必须单独 commit + 重跑 A3-01/02/03/04/07**。
