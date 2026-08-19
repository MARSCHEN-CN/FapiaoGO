# Gate 4 — CLOSED（封存记录）

> **状态**：`CLOSED`
> **性质**：docs-only，生产代码零改动
> **封存日期**：2026-08-19
> **前置锚点**：`docs/r1-decision-record.md` §12（R1 Sign-off）、`docs/print-pipeline-convergence-design.md` §0–§14（PPC RATIFIED）

---

## 0. 封口范围声明（Scope Lock）

Gate 4 的全部产出仅覆盖以下四项的验证结论：

| 项目 | 状态 |
| --- | --- |
| 4.1 Seam Map | ✅ PASS |
| 4.2 Contract Audit | ✅ PASS |
| 4.3 Regression Guard | ✅ PASS（15/15 实跑） |
| 4.4 Fix | NO-OP（无触发条件） |

**本封存文档不新增、不重开、不讨论：**

- ❌ rotation migration（属 Future Rotation Semantic Migration Gate）
- ❌ OFD path discussion（OFD = 第三种输入格式，非第三种打印模式，见 PPC §9）
- ❌ PPC redesign（PPC 已 RATIFIED，独立）
- ❌ VirtualPrintSource implementation（属 PPC Gate 未来实现）

---

## 1. 唯一验证命题（Single Proposition）

Gate 4 的验证目标在 R1/PPC 冻结后已压缩为唯一命题：

> 在 `effectiveRotation` ownership 已冻结（R1 CLOSED）前提下，
> **`merge per-slot geometry` 是否忠实消费 `RenderCommand` contract。**

不验证：rotation ownership 正确性 / OFD 可打印性 / PPC 资源生命周期 / VirtualPrintSource。

---

## 2. 四阶段封存结论

### 2.1 Gate 4.1 — Seam Map ✅ PASS

- 取证文档：`docs/gate4-merge-geometry-seam-map.md`（commit `6d98b40`）
- 结论：merge 存在两条 `RenderCommand` 生产者，均收敛于唯一几何 owner `createPlacement`：
  - **Path A** = `MultiTicketComposer.composePlans`（V16 / `RenderLayoutFactory`，消费 canonical `effectiveRotation`）
  - **Path B** = `mergeFactory.buildMergeRenderCommands`（Slice 1.3 / D1 canvas-bake，吃原始 `rotations[id]` 用户旋转）
- 唯一旋转落盘点 = `renderDraw.js:38` `ctx.rotate(...)`

### 2.2 Gate 4.2 — Contract Audit ✅ PASS

- 同一文档 §4 三禁止审计全部缺席：
  1. 无 double rotation（Path A 不二次 normalize B-10a；Path B 仅 snap 原始输入）
  2. 无 source format 分支（生产者 grep 零 `if ofd/pdf.rotate/image.exif`）
  3. slot 不修改 content geometry（slot 仅作 `createPlacement` fit 目标）
- 链路 fidelity 已证明：`effectiveRotation → RenderCommand.contentRotation → createPlacement → drawRenderCommand → physical page`

### 2.3 Gate 4.3 — Regression Guard ✅ PASS

- 设计文档：`docs/gate4-regression-matrix.md`（commit `723b96b`）
- 实现套件：`frontend/test/printGate/gate4Regression.test.mjs`（15 tests，commit `b123e8d`）
- 配套 loader：`frontend/test/printGate/env-shim.loader.mjs`（仅测试加载期 `import.meta.env` 中性替换，不改生产码）
- 运行命令：

  ```bash
  cd frontend
  node --loader ./test/printGate/env-shim.loader.mjs --test ./test/printGate/gate4Regression.test.mjs
  ```

- 覆盖（按用户批准的 Core Mandatory）：
  - **Layer A 双路径**：Path A `A1-A4`（`contentRotation = effectiveRotation` 透传，B-10a 无第二 resolver）、Path B `B1-B4`（`= normalizeRotation(rotations[id])` + 45→90 snap）
  - **Layer B Slot Geometry**：`G1` merge none/2/4 冻结分区像素值、`G2` slot 几何与 rotation 解耦、`G3` `clip === slot.contentRect` 所有权锁、`orientation` portrait/landscape
  - **Layer C Format-blind**：PDF/Image/OFD-label 同像素 `deepStrictEqual` + 静态零 `if(pdf|ofd|image)` 分支；**OFD 仅 label，未引入真实 renderer**
  - **§7 Guard（sentinel 风格）**：`guardPathBSourceInvariant` + `guardPathBDivergenceWatch` —— 当前 PASS 输出 `ℹ ... PASS (frozen state intact)`；若未来 `rotations[id]` 被改成 `effectiveRotation`，抛 `⚠ Architecture Watch: ... requires Future Rotation Semantic Migration review.`，**非 `FAIL: rotation bug`**
  - **§8 rotation-once**：`R1` placement 无内嵌旋转 / `cmd.rotation===0`；`R2` 执行器 mock-ctx 验证 `cr=90→rotate 1 次`、`cr=0→0 次`；`R3` producer rotation === executor rotate 角

### 2.4 Gate 4.4 — Fix NO-OP

触发条件判定（无一项触发）：

| 发现 | 结果 |
| --- | --- |
| double rotation | 未发现 |
| source format branch | 未发现 |
| slot 修改 content geometry | 未发现 |
| RenderCommand contract 破坏 | 未发现 |
| Path B rotation divergence | observation，不属于 Gate 4 defect（归 Future Migration Gate） |

**结论**：`Gate 4.4 = NO-OP`。无生产代码修改。

---

## 3. 架构位置（Two-Axis Model）

```
                 R1 (CLOSED)
                  |
       Rotation Semantic Ownership
                  |
                  v
      RenderPlacementResult   <--- 唯一跨域对象
                  |
                  |
                  v
                 PPC (RATIFIED)
       Print Resource Ownership


                  ^
                  |
             Gate 4 verifies
   (merge geometry consumes RenderCommand correctly)
```

- R1 拥有 `sourceRotation / contentRotation / effectiveRotation / RotationResolver`，不拥有 PrintResource / PrintPDF / Executor。
- PPC 拥有 `PrintResource / NativePrintSource / VirtualPrintSource / PrintPDF / Executor`，不拥有 rotation ownership。
- **Gate 4 验证目标已完成**：merge geometry 忠实消费 `RenderCommand`，职责边界无倒流。

---

## 4. 冻结状态表（Final）

| 项目 | 状态 |
| --- | --- |
| R1 Rotation Ownership | 🔒 CLOSED |
| PPC Architecture | ✅ RATIFIED |
| Gate 4.1 Seam Map | ✅ PASS |
| Gate 4.2 Contract Audit | ✅ PASS |
| Gate 4.3 Matrix Design | ✅ APPROVED |
| Gate 4.3 Implementation | ✅ PASS（15/15） |
| Gate 4.4 Fix | NO-OP |
| **Gate 4** | **🔒 CLOSED** |
| Path B divergence | ⚠ Architecture Observation（Future Migration Gate） |

---

## 5. 后续路线（不在本 Gate 范围）

```
R1 CLOSED → Gate 4 CLOSED → 三格式回归护栏已就位 → PPC Gate → VirtualPrintSource impl → Future Rotation Semantic Migration
```

- Path B divergence（独立 rotation source）作为**架构观察点**保留，归 Future Rotation Semantic Migration Gate 统一；Gate 4 内不修复、不迁移。
- 所有 Gate 4 产物（seam map / regression matrix / 回归测试 / 本封存）均为 docs/test-only，生产代码零改动。

---

## 6. 交付物索引（本地提交链，待 push）

| Commit | 内容 | 性质 |
| --- | --- | --- |
| `6d98b40` | `docs/gate4-merge-geometry-seam-map.md`（4.1/4.2） | docs |
| `723b96b` | `docs/gate4-regression-matrix.md`（4.3 设计） | docs |
| `b123e8d` | `frontend/test/printGate/gate4Regression.test.mjs` + `env-shim.loader.mjs` + matrix §10.2 修正 | test / docs |

> 远程 tip 现 `1681b60`；本地待推送链 `6d98b40 → 723b96b → b123e8d` 由用户本机手动推送：
> `git -c lfs.locksverify=false push origin rotation-b1-hardening`
