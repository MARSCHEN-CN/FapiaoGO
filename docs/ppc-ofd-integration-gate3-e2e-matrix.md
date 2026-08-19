# PPC-OFD Integration Gate 3 — Physical Print E2E Matrix（docs-only）

> **性质**：docs-only，纯验收矩阵设计。**不写测试代码、不执行、不修改任何生产代码**，不重开 R1 / PPC / Gate 4 / Gate 1 / Gate 2。
> **阶段定位**：Gate 1（seam 存在）= PASS、Gate 2（Producer Contract 满足）= PASS，本 Gate 3 验证的是**后半段闭环**——`RenderResource → Physical Print`。
> **核心定性（来自用户校准）**：本 Gate 不是再证「OFD 能不能渲染」，也不是再审计 `OFDAdapter`；而是验证「**已生成的 OFD RenderResource，经过现有 Print Pipeline 后，是否得到正确物理打印结果**」。

---

## 0. Scope Lock

| 项 | 状态 |
| --- | --- |
| Gate 1 (Architecture Seam) | ✅ PASS（前置条件） |
| Gate 2 (Producer Contract) | ✅ PASS（前置条件） |
| R1 Rotation Ownership | 🔒 CLOSED — 未触碰（仅消费，不改动） |
| PPC Architecture | ✅ RATIFIED — 未触碰 |
| Gate 4 (merge geometry) | 🔒 CLOSED — 复用其冻结几何 |
| `render_ofd_page` | 🔒 冻结（Gate 2 已证无隐藏旋转） |
| `OFDAdapter` / `sourceRotation` contract | 🔒 冻结（Gate 2 已证） |
| `RenderCommand` contract | 🔒 冻结（Gate 4 已锁） |
| `mergeFactory` | 🔒 冻结（Gate 4 已锁） |

**Gate 3 不验证 Producer 侧**：若失败，默认优先怀疑 **Consumer 侧**——

```
RenderResource Consumer
        ↓
PrintAdapter (buildPrintJobItem / fetchPrintRaster)
        ↓
Canvas composition (renderMultipleItemsToCanvas → createPlacement → drawRenderCommand)
        ↓
PDF/PNG materialization (printMergedImages → print-merged-images)
        ↓
Sumatra / OS printer
```

**而非**回头改 `render_ofd_page` / `OFDAdapter`。改 Producer 必须带 Gate 2 复审证据。

---

## 1. 单一验证命题（冻结）

> **OFD 作为 RenderResource 输入时，是否能够不经过任何 OFD 专用打印路径，复用现有 Print Pipeline，完成单页、多页、混合 merge 打印，并保持 rotation single-application？**

- 「不经过 OFD 专用打印路径」= consumer 链中**不得出现 `if(ofd)` 专属打印分支**（PDF 的 `print-source-file` 直送路径 OFD 必须不进入，见 `usePrint.js:915-916` 注释）。
- 「复用现有 Print Pipeline」= 与 Image/PDF 走同一个 `renderMultipleItemsToCanvas`（几何唯一发生处）+ `drawRenderCommand`（rotation 唯一落盘点）。

---

## 2. Consumer 链（已 grounding，Gate 3 的被测对象）

```
OFD file (fileFormat==='ofd')
        │  usePrint.js:202-264 (分支强制走 raster/canvas 管线)
        ↓
buildPrintJobItem(f)                              printAdapter.js:60
        │  → { docId, pages:[{index,url}] }
        ↓
fetchPrintRaster(docId, page.index+1)            printAdapter.js:104
        │  → Blob (OFD→WebP raster, source 取向, 200dpi print preset)
        ↓
RenderResource (image element / blob)
        │
        ↓
renderMultipleItemsToCanvas(...)                 usePrint.js:227 / 362
        │  内部：createPlacement（几何 owner） + drawRenderCommand（rotation 落盘点）
        │  注释 usePrint.js:910-916：「OFD == Image」「几何唯一发生处」
        ↓
canvas (物理页像素)
        │
        ↓
printMergedImages → print-merged-images (IPC)
        │  → PDF/PNG materialization
        ↓
Sumatra → OS printer
```

**Gate 3 验证范围边界**：

- 沙箱内可自动化：**至 `canvas` 输出**（即 Gate 3-A）。
- 需真实环境：**`materialization → Sumatra → 打印机`**（即 Gate 3-B，由用户在 Windows 手动执行）。

---

## 3. 验收矩阵

### A. 单 OFD 单页打印（最基础闭环）

链路：`OFD → buildPrintJobItem → fetchPrintRaster → renderMultipleItemsToCanvas → canvas`

| 验收项 | 断言 | 来源 |
| --- | --- | --- |
| 页面内容正确 | canvas 非空白；内容 bbox 占纸比例 ≥ 15%（沿用 Gate 4 `mask`/bbox 判定纪律，**禁** `mask.sum()` 失真法） | consumer |
| 尺寸比例正确 | `canvas.width === paperRectW(preset)` 且 `canvas.height === paperRectH(preset)`（**由 `previewState` paperRect × print preset dpi 推导，禁止硬编码魔法数**） | consumer |
| 无裁切 | 内容 bbox 完全落在 `paperRect` 内；contentRect 与 `slot.contentRect` 一致（复用 Gate 4.3 G3 锁） | consumer |
| rotation 正确 | 见矩阵 E | R1 |
| 与 preview 一致 | 同 doc+page 的 preview raster 与 print raster **取向一致**（Gate 2 §7 已证同源 `adapter.render`，此处 E2E 复核） | Gate 2 |

### B. OFD 多页打印（page contract）

链路：`OFDAdapter.pages` → 逐页 `fetchPrintRaster(page.index+1)` → 逐页 canvas → 逐物理页

重点验证 `page index` 稳定性（Gate 2 §5 已证有序枚举 + adapter 缓存）：

| 验收项 | 断言 |
| --- | --- |
| 顺序 | `canvas[k]` 内容 == `pages[k]` 内容（k=0,1,2…） |
| 尺寸 | 每页 canvas 尺寸一致（同 paperRect） |
| rotation | 每页 `contentRotation` 取自该页 `sourceRotation`（非跨页串扰） |
| 内容 | 逐页内容不串页、不丢页 |

### C. OFD + Image 混合 merge（最有价值）

Gate 4 已锁「merge geometry 不关心 source format」。本项证明该冻结在**真实 OFD 输入**下仍成立：

```
merge2:  slot0 = OFD,  slot1 = Image
merge4:  [OFD, PDF] / [Image, OFD]
```

| 验收项 | 断言 | 契约锚点 |
| --- | --- | --- |
| slot geometry | `slot.contentRect` 与纯 Image merge 时**同分区像素值**（复用 Gate 4.3 G1 冻结公式） | Gate 4.3 G1 |
| spacing | 槽间距 == `slotMarginPx`（无 OFD 专属偏移） | Gate 4 |
| crop | 各 slot 内容 bbox 落于各自 `contentRect`（无 OFD 溢出） | Gate 4.3 G3 |
| rotation | OFD slot 与 Image slot 各自 rotation 独立施加一次（无交叉污染） | Gate 4.3 R2/R3 |

### D. OFD + PDF 混合 merge（防双轨污染）

**本项的核心目的 = 检测「双轨污染」**，不是比对 PDF/OFD 内容：

| 验收项 | 断言 | 风险 |
| --- | --- | --- |
| 单执行路径 | OFD 与 PDF 都经 `renderMultipleItemsToCanvas` → `drawRenderCommand`（**不得**出现 OFD 走 raster 而 PDF 走 `print-source-file` 直送的分裂） | 双轨污染 |
| 几何同构 | 两 slot 的 `slot.contentRect` 使用**同一** `createPlacement` 公式 | Gate 4 |

> ⚠️ 若发现 PDF 走 native `print-source-file` 而 OFD 走 raster/canvas——这是**既有 PDF 单文件策略**（非 OFD 缺陷），但 merge 场景下二者必须汇入同一 composer。本项验证的是 merge 内无分裂，而非否定 PDF 单文件 native 捷径。

### E. Rotation Single Application（唯一必须保留的 R1 验证）

复用 Gate 4.3 §8 的 `R1–R3` 不变量，针对 OFD 输入：

| 输入 | 期望 | 禁戒 |
| --- | --- | --- |
| `sourceRotation=90, userRotation=0` | `contentRotation=90`；`drawRenderCommand` `ctx.rotate(90)` **恰好 1 次** | — |
| `sourceRotation=90, userRotation=90` | `effectiveRotation = resolve(source,user)`（按 R1 contract 归一）；仍**只一次**最终 rotation | ❌ OFD renderer 烤 90 + Canvas 再 90 = 180 |
| `sourceRotation=0, userRotation=0` | `contentRotation=0`；`ctx.rotate` 0 次 | — |

断言（沿用 Gate 4.3 R1–R3）：
- **R1**：`placement` 无内嵌旋转；`cmd.rotation===0`。
- **R2**：executor mock-ctx 验证 `cr=90 → rotate 恰好 1 次`、`cr=0 → 0 次`。
- **R3**：producer 的 `contentRotation` === executor 实际 `ctx.rotate` 角（producer→executor 无第二处旋转）。

**关键**：OFD raster 是 source 取向（`render_ofd_page` 不烤旋转，Gate 2 已证），故 rotation 只能来自 `sourceRotation`+`userRotation` 合并后在 `drawRenderCommand` 施加一次——与 PDF 同模型。

---

## 4. 执行方法论（分步，避免失败原因混叠）

### Gate 3-A：Print pipeline trace + output inspection（沙箱可自动化）

- 用 `env-shim.loader.mjs`（Gate 4.3 已建）加载含 `import.meta.env` 的模块图。
- `fetchPrintRaster` **可 mock**：返回已知尺寸的 OFD→WebP 测试栅格（或指向仓库内 sample OFD 经后端真实渲染的快照）；Image/PDF 同法 mock 为确定性 fixture。
- 驱动 `renderMultipleItemsToCanvas`（或 `usePrint` 的 OFD 打印入口）产出 canvas，断言 §3 全部项（尺寸/无裁切/rotation-once/merge 几何）。
- **不进入** materialization / Sumatra（沙箱无打印机）。
- 输出产物：断言报告 + 生成的 canvas 尺寸/方向日志（供 Gate 3-B 对照）。

### Gate 3-B：真实 Sumatra / Windows printer（用户手动）

- 在 Windows 实机：`OFD → 打印` 触发 `printMergedImages → print-merged-images → Sumatra → 物理打印机`。
- 验收：纸张尺寸正确、无裁切、rotation 与预览一致、merge 物理位置与 Gate 3-A canvas 一致。
- **理由**：若直接从物理打印失败，难定位是 OFD / Canvas / materialization / Sumatra 哪层——故 3-A 先把 consumer 链（至 canvas）钉死后，3-B 只验证末端。

---

## 5. 决策标准

| 情形 | Gate 3 判定 |
| --- | --- |
| §3 A–E 全 PASS（3-A 全过 + 3-B 实机确认） | ✅ PASS（Physical Print E2E 闭环） |
| 3-A 失败且根因在 Consumer（canvas 尺寸/裁切/双轨/rotation 二次） | ❌ BLOCKER，限 Consumer 侧最小修复（不动 Producer/R1/PPC） |
| 3-A 失败但根因指向 Producer（raster 已烤旋转 / `sourceRotation` 错） | ⚠️ 升级为 **Gate 2 复审**（带证据），不在 Gate 3 改 `render_ofd_page` |
| 3-B 物理打印与 3-A canvas 不一致 | ❌ materialization/Sumatra 层 defect（不在本 Gate 范围外推，单列） |

**Gate 3 PASS 前置**：A/B/C/D/E 全部 PASS，且 3-B 实机由用户确认。

---

## 6. Negative List（本阶段严禁）

| 禁做 | 原因 |
| --- | --- |
| ❌ 改 `render_ofd_page` / `OFDAdapter` / `sourceRotation` | Gate 2 已证 Producer 契约满足；改则须 Gate 2 复审 |
| ❌ 加 `if(ofd)` 打印专属分支 | 违反「OFD == Image」、Gate 4 Layer C 格式盲 |
| ❌ 改 `RenderCommand` / `mergeFactory` | Gate 4 已锁 |
| ❌ 重开 R1 rotation ownership | Gate 2 已证 rotation 模型统一 |
| ❌ 新建 OFD→PDF 长期链 | 与 PPC 原则冲突 |
| ❌ 把「3-A 失败」直接归因于 OFD renderer | 默认先查 Consumer；归因 Producer 须带 Gate 2 证据 |

---

## 7. 状态更新（待本 Gate 执行后填写）

```
[R1 CLOSED] [PPC RATIFIED] [Gate 4 CLOSED]
[PPC-OFD Integration]
  Gate 1: PASS (Architecture Seam Verified)
  Gate 2: PASS (RenderResource Producer Contract Verified)
  Gate 3: PENDING (Physical Print E2E — 本矩阵待执行)
```

---

## 8. 引用

- Gate 4.3 `docs/gate4-regression-matrix.md`（rotation-once R1–R3、slot geometry G1–G3）
- Gate 4 `docs/gate4-closure.md`（merge geometry 冻结、`createPlacement`/`drawRenderCommand` 唯一 owner）
- Gate 1 `docs/ppc-ofd-integration-gate1-seam-map.md`（consumer 链 seam）
- Gate 2 `docs/ppc-ofd-integration-gate2-contract-audit.md`（Producer Contract、rotation 无隐藏烘焙）
- 代码锚点：`usePrint.js:202-264,910-916` / `printAdapter.js:60,104` / `renderers.js` `renderMultipleItemsToCanvas` / `renderDraw.js:38`
