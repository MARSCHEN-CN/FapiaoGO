# P2-GATE —— X1 契约收紧 + seam 位置审计（2026-09-04）

> 前置：`outputs/preview-p2-fix-design-2026-09-04.md`（已按本 GATE 结论同步修订）。
> 范围：**只审计与调整测试契约 + 设计文档，生产代码零改动**。不 push、不实机。
> 触发：X1 原方案引入 `committed` phase —— 被判定为「为修残留状态再造一个残留状态类型」。

---

## G1：X1 RED 契约审计 —— committed phase 否决，收紧为「三出口 → execution terminated」

### G1.1 否决原 RED（`committed phase + refresh → start-execution`）

- 该测试**钉死的是实现方案**（scheduler 必须理解 `committed`），而非根行为；
- 根行为 = 「已完成 commit 的 execution 不得继续阻塞后续 refresh」——兑现 Contract §1.4 `commit → terminated` 后，execution 直接是 `null`，scheduler 不需要新增任何相位理解；
- 你已证明 committed execution 不再有任何 consumer = 本质上就是 terminated——继续在 ref 保留 `{ phase:'committed' }` 是**引入一个三处都要解释的新状态**。

### G1.2 收紧后的契约（两层 seam）

| 层 | 契约 | 测试形态 | 状态 |
|---|---|---|---|
| Scheduler 边界 | `execution=null + refresh → start-execution` | T10（已存在）+ **P2-X1-ANCHOR-2**（X1 叙事显式绑定） | 🟢 绿（scheduler 无需改动） |
| Scheduler 边界 | 在途 `post-load/committing + refresh → restart-required` | T12 + **P2-X1-ANCHOR-1**（锁定 X1 修复不得误伤在途 restart） | 🟢 绿 |
| Hook 生命周期 | `COMMIT_SUCCESS / COMMIT_CACHE / FUSE_BLOCK` 三出口 → `previewExecutionRef.current = null` | **无行为红测形态**（见 G1.3） | 实施时一次性验收脚本 |

### G1.3 关键发现：hook 层行为红测在当前设施下不可行（如实披露）

审计证据：
- `usePreview.js` 是 React hook（`useEffect/useRef/setState` + electronAPIRef），node --test 无法挂载；
- `frontend/package.json` **无** `@testing-library/react` / `react-test-renderer` / jsdom（hook harness 需新增依赖，违背最小原则）；
- 仓库全部测试为「import 真实模块 + 断言行为」（抽查 `rotationAudit`/`fitScaleAudit`），**无读源码做断言（源码审计）的先例**；
- hook「三出口置 null」是纯副作用赋值，无值得下沉的纯决策（下沉 = 恒等返回 null，无意义）。

结论：X1 最小修复（三出口一行赋值）在**现有纪律与设施下只能以「实施时一次性验收脚本」核对**（PASS 后删除——与仓库「验收脚本用完即删」纪律一致，见工作记忆），**不留常驻结构护栏**（避免无先例的源码审计测试 + 脆弱性）。scheduler 侧用 ANCHOR-1/ANCHOR-2 永久锁定收敛语义。

### G1.4 实施清单（X1，step 5 执行）

```
① COMMIT_SUCCESS 段末（L2034-2053，committedPreviewVersionRef 记录后）→ previewExecutionRef.current = null
② COMMIT_CACHE 段末（L1947-1979，同上）                                 → previewExecutionRef.current = null
③ FUSE_BLOCK（L1766-1769）                                              → previewExecutionRef.current = null
模板：merge 模式分支 L1715（唯一正确出口）
验收：一次性脚本 grep 三锚点各 25 行窗口内存在赋值；previewScheduler.test.js 全绿（ANCHOR-1/2）
```

---

## G2：X2/X3 seam 位置审计

| 纯函数 | seam 位置 | 理由 | 测试文件 |
|---|---|---|---|
| `resolveDebouncePrecedence(pending, incoming) → { intent, key }` | `previewScheduler.js` ✅ | debounce 意图仲裁与 select/refresh supersession（INV-PS1/PS3）同源，属 transaction intent 语义 | `previewP2RedContracts.test.js`（X2，5 测，per-test TypeError 红） |
| `isDisplayablePreview(file) → boolean` | **新纯模块 `previewPolicy.js`** ✅（采纳） | preview snapshot **policy**，不属于 transaction scheduler；避免 scheduler 同时承担 transition / execution / debounce / displayability 四类职责 | `previewPolicyRedContracts.test.js`（X3，5 测，module-not-found 文件级红） |

### X3 范围纪律（重申并锁定）

`isDisplayablePreview` 是 **commit eligibility predicate**，只回答「这个 snapshot 能不能成为 committed preview」，**不得滚成第二套渲染判断**。只依赖冻结事实：
- effective docId：`identity.docId` / `docId` / split-page（`sourceDocId && docId !== sourceDocId`）→ `sourceDocId`（对齐 usePreview L1993-1994）；
- `_pdfData` / `_fileFormat==='pdf'` = pdf-backed 判定；
- `_previewImageUrl` = 纯图像豁免（不经 DocumentStore）；
- **不 import、不触碰 DisplayAdapter**。

---

## 最终判定与顺序

- X1 根因判断：**成立**；`committed` phase 方案：**否决（不够最小）**；改为三出口直接 `null`。
- X2 根因判断：**成立**；设计（select 保真、payload 可升级、intent 不降级、version 规则不变）：**保留**。
- X3 防御层判断：**成立**；seam 迁 `previewPolicy.js`；范围纪律锁定。
- 实施顺序：**P2-GATE（本文件）→ X1 三出口终态化 → X2 debounce select 保真 → X3 displayability gate → 8 PDF 实机回归**。
- 暂不 push；暂不实机；生产代码零改动。

## 交付（本地 commit，不 push）

- 测试：`previewScheduler.test.js`（删 committed RED，改 ANCHOR-1/ANCHOR-2）；`previewP2RedContracts.test.js`（仅 X2）；`previewPolicyRedContracts.test.js`（X3，新 seam）。
- 文档：本 GATE 文件 + 主设计文档同步修订（§1.2/§1.3/§1.4/§4/§5/顶部修订注）。
