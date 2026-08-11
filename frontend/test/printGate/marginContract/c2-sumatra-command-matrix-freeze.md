# C-2 横向纸张 Command Mapping 冻结 — SumatraCommandResolver

> 日期：2026-08-11 ｜ 状态：**FROZEN（用户裁决 17:30）** ｜ 基线：`7472314` + 本报告 commit
> 前置：`c2-freeze-and-c2e-audit-scope.md`（C-2 冻结声明）、`c2e-executor-paper-selection-conclusion.md`（executor 调查终局）

---

## 1. 冻结声明

**C-2 横向纸张（landscape paper）Sumatra command mapping 正式冻结。**

- resolver 保持 **16-case 查表实现，不做动态推导重构**（用户裁决：查表把真实实测结果直接固化为 spec，最易审计和回归）。
- **竖向纸张 = golden baseline，永不漂移**（已有真实打印验证）。
- **对称性是验证约束（Symmetry Gate），不是运行时实现**。

```
                SumatraCommandResolver
                         │
            ┌────────────┴────────────┐
            │                         │
      竖向纸张 mapping           横向纸张 mapping
         Golden Base                  实测表
            │                         │
            └───────── symmetry ──────┘
                         │
                     8/8 PASS
```

---

## 2. 三层 Gate 结构（全部 PASS）

```
真实实测 Spec（16 表）
      ↓
Resolver mapping（16/16 command exact match）
      ↓
Symmetry invariant（8/8 双向）
      ↓
真实打印 artifact（16/16 客观属性）
```

| 层 | Gate | 判据 | 结果 |
|---|---|---|---|
| L1 Command Mapping | `sumatraCommandMatrixGate.mjs` L1 + `sumatraCommandResolver.test.mjs` | resolver 输出 vs 16-case 实测表逐项一致 | **16/16 PASS** |
| Symmetry | `sumatraCommandResolver.test.mjs`（新增断言） | 横向表 == 竖向 base + orientation swap（双向） | **8/8 PASS** |
| L2 Artifact | `sumatraCommandMatrixGate.mjs` L2 / `.out/verify-cmd-matrix-artifacts.mjs` | 纸方向正确 + 内容存在 + bbox面积/纸面积 ≥ 15%（方向无关防线） | **16/16 PASS** |

### L1 — Command Mapping（16/16）

`resolveSumatraRotation({contentOrientation, contentRotation, paperOrientation})` 输出与 16-case 实测表逐项一致。`portrait` 纸在 Sumatra 命令层编码为 `disable-auto-rotation`（Sumatra 无 portrait 参数名）。

### Symmetry — 8/8 双向（本轮新增）

**swap 规则**（2026-08-11 从 16 表实测归纳，非理论推导）：
```
内容有效方向 eff = (contentBase + rot) mod 180   （横 contentBase=0°，竖=90°）
  eff == 0（横向布局）→ rotate 不变
  eff == 90（竖向布局）→ rotate 翻转（90↔270，即 +180 mod 360）
```
- 竖→横 推导 vs 横纸实测表：**8/8 吻合**
- 横→竖 反向：**8/8 吻合**

**结论：16 表内部自洽，两纸型是 orientation swap 关系（情况 A）。** 竖纸表 = 单源 truth，横纸表由对称性断言锁死——未来单边改表会立刻 FAIL。

### L2 — Artifact（16/16，真实打印）

16 个 artifact（Wondershare 捕获）客观属性判定：

| 组 | bbox 占纸 | 判定 |
|---|---|---|
| 横内容 × 竖纸 | 84% | ✅ |
| 横内容 × 横纸 | 42% | ✅ |
| 竖内容 × 竖纸 | 29% | ✅（竖票 fixture 内容居中偏小，非异常） |
| 竖内容 × 横纸 | 29% | ✅ |

完整性判据 = **bbox面积/纸面积 ≥ 15%** 防线（检测严重缩放/裁切异常，方向无关）。
⚠️ 历史教训：`mask.sum()`（墨水覆盖面积）对发票失真（线框墨水量小），不可用作完整性指标。

---

## 3. 废弃项（Gate v2 修正）

- **废弃** `expectedContentOrient` 方向 oracle（自造公式，非用户规范，曾误判 4 case）。
- **废弃**「invoiceOrientation + rotate 推导最终内容方向」——rotate 是 executor 打印旋转参数，非内容方向直接计算量；内容最终 bbox 方向受 fit/驱动布局影响。
- L2 不再猜内容方向，只验实测可定义的客观属性。

---

## 4. 冻结边界

| 项 | 状态 |
|---|---|
| SumatraCommandResolver（16 表查表） | 🔒 FROZEN |
| 竖向纸张 mapping（golden base） | 🔒 FROZEN（不改） |
| 横向纸张 mapping（实测表） | 🔒 FROZEN |
| Symmetry invariant | 🔒 常驻测试断言 |
| C-2 geometry / placement / RotationResolver / bake / noscale | 🔒 FROZEN（沿用 C-2 冻结声明） |
| RotationResolver 职责（内容实际怎么旋转/放置） | 不受影响（resolver 是 executor command 层） |

**禁止**：因理论几何推导修改已通过真实打印验证的命令；重构 resolver 为动态推导。

---

## 5. 测试运行方式

```bash
# resolver 单测（含 Symmetry，6/6）
node --test frontend/test/printGate/sumatraCommandResolver.test.mjs

# Command Mapping Gate（L1 纯函数 + L2 真实打印）
node frontend/test/printGate/sumatraCommandMatrixGate.mjs            # 完整
node frontend/test/printGate/sumatraCommandMatrixGate.mjs --skip-print  # 仅 L1
```
