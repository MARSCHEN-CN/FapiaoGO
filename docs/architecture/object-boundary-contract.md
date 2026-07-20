# Object Boundary Contract（对象替换边界契约）

> **状态**：设计基线（只读，无代码改动）
> **适用阶段**：Phase 4.2.2 ImportSession 最小恢复的设计基线
> **前置契约**：`docs/architecture/identity-contract-v1.1.md`（Identity Law 1~3）

---

## 0. 为什么需要这条契约

Phase 4.1 + 4.2.1 把「身份语义」从隐式约定收敛成了可验证的 **Identity Law 1~3**（Resolver 局部性 / doc_id 唯一来源 / 生命周期单向）。

但 4.2.2 审计（Owner/Mutator + 可替换性）暴露了另一维问题，与身份**正交**：

> 一个对象，到底允许被**整体替换（Replace）**，还是只允许被**逐字段富化（Enrich）**？

4.2.1 的三条 Law 管的是「身份值是否正确」；
本契约管的是「对象拓扑如何被允许变更」。

**这条约束比 API 更稳定**：函数会被重命名、重写、拆分；但一个领域对象的生命周期语义（什么能替换、什么只能富化）是领域不变量，重写 Pipeline 也不会变。只要 Replace Boundary 与 Identity Law 同时成立，整个架构依然成立。

---

## 1. Law 4 — Object Replacement Boundary

```
任何核心对象的变更，必须属于且仅属于以下两类之一：

  (R) Replace  —— 销毁旧实例、创建新实例（整体替换）
  (E) Enrich  —— 保留同一实例，逐字段修改（富化）

不允许：
  - 对「Enrich-only」对象做整体替换（会引入第二写入者 / 误 splice）
  - 对「Replace-only」对象做逐字段富化（其语义是 Destroy+Create，无 enrich）
  - 任何对象绕过其 Owner 直接写入（见 §3 每对象 Forbidden）
```

Law 4 与 Identity Law 1~3 **正交且同时必须成立**：
- 若 Replace Boundary 成立 → SessionFile 永不被整体替换 → 没有第二写入者能覆盖其中的 identity。
- 若 Identity Law 成立 → SessionFile 内携带的 identity 值永远权威。

两者合起来，4.2.2 的 ImportSession 恢复才不会把 Placeholder / SessionFile / Identity 再次混在一起。

---

## 2. Boundary Table（5 个核心对象）

| Object | Replace | Enrich | Owner |
|---|---|---|---|
| **Placeholder** | ✅ | ❌ | Import Pipeline |
| **SessionFile** | ❌ | ✅ | ImportSession |
| **Identity** | ❌ | docId only | Identity Layer |
| **DocumentState** | ✅ | ❌ | Preview |
| **RenderState** | ✅ | ❌ | Renderer |

> 注：**ParseResult 不在此表**。它是 RPC DTO（Backend → Mapper → Discard），从不进入系统状态，故不需要边界约束。真正长期存在、需要约束的是上表的 5 个。
>
> 注：**RenderState** 来自 V16 Render 层（非 Import 范围），但因服从同一条 Law 而纳入——它证明了本契约跨层通用，而非仅限 Import。

---

## 3. 每对象契约（含代码锚点）

### 3.1 Placeholder — Replace ✅ / Enrich ❌
- **Owner**：Import Pipeline（`processFilesForAddition` → `placeholderGenerator.createPlaceholders`）
- **Lifecycle**：Import → Split（短暂 UI 加载实体，非 Document）
- **Replace ✅**：由 `replaceFileItems` 整体 splice 出去，换成 split 产物
  - 锚点：`ImportSessionStore.js:140` `session.files.splice(idx, 1, ...newItems.map(i => createSessionFile(i)))`
  - 入口：`useFileOps.js:264` `createPlaceholders(files)` → `:284` `replaceFileItems(...)`
- **Enrich ❌**：占位项不应被逐字段富化，它只该被替换。
- **Forbidden**：
  - 把 placeholder 当作 FileObject 使用（如读取 `.identity` 当作文档身份）
  - Session 恢复时把 placeholder 持久化为文档
  - 在 split 之外对它做整体替换（idx 错位会误 splice 真实 SessionFile）

### 3.2 SessionFile — Replace ❌ / Enrich ✅
- **Owner**：ImportSession（`ImportSessionStore` 是状态根）
- **Lifecycle**：Split → Close（持久对象，长期存活于 `sessions` Map）
- **Replace ❌**：**绝不允许**对真实 SessionFile 做整体替换。
- **Enrich ✅**：逐字段修改，经统一入口
  - 工厂：`ImportSession.js:104` `createSessionFile(input)`
  - 富化入口：`ImportSessionStore.js:123` `updateFileStatus`（`Object.assign(file, updates)`）/ `fileStateTransitions.js:37` `applyFileUpdate`
- **Forbidden**：
  - `files[idx] = newFile`（整体替换真实 SessionFile）→ 违反 Replace❌
  - 经 `replaceFileItems` 替换非占位项（`replaceFileItems` 的 splice 目标**只应是 placeholder key**）

### 3.3 Identity — Replace ❌ / Enrich(docId only) ✅
- **Owner**：Identity Layer（`utils/identity.js`）
- **Lifecycle**：整文档（创建一次，富化一次）
- **Replace ❌**：identity 对象本身永不被重新构造。
- **Enrich ✅（仅 docId）**：
  - 创建：`buildFileObj` → `resolveIdentity`（`fileHelpers.js:22` / `identity.js:60`）
  - 富化：`updateDocumentIdentity`（`identity.js:109` / `parseResultMapper.js:68`，只刷 docId）
- **Forbidden**：
  - `identity = { ... }` 写在 `identity.js:116` 之外
  - `resolveIdentity` 出现在 Import 创建阶段之外（Normal Path 不应触发；仅在 `updateDocumentIdentity` 内的 identity-缺失异常兜底）
  - 从 path / key / filename / uiKey 重新推导 doc_id（Law 2）

### 3.4 DocumentState — Replace ✅ / Enrich ❌
- **Owner**：Preview Session（`usePreview`），**不是 Document**
- **Lifecycle**：Preview（每次加载一个文件即一次重建）
- **Replace ✅**：切换文件 = Destroy(old) + Create(new)，**不存在 enrich 语义**
  - 锚点：`usePreview.js:218` / `:1437` `DocumentState.id = loadedFile.identity?.docId`（每次加载重建）
- **Enrich ❌**：DocumentState 不是长期对象，不应被逐字段富化；它的正确变更方式是整体重建。
- **Forbidden**：把 DocumentState 当作跨 Preview 会话的持久事实容器（持久事实应落在 DocFacts / DocumentState 之外的持久层）。

### 3.5 RenderState — Replace ✅ / Enrich ❌
- **Owner**：Renderer（`renderers.js` / `render.worker.js` / `previewState.js`）
- **Lifecycle**：每次 draw（由 RenderCommand 纯执行重建）
- **Replace ✅**：每帧由 `RenderCommand` 推导重建，纯执行、无自算
  - 初始：`previewState.js:94` `initialRenderState()`
  - 执行器：`renderers.js:1228` / `render.worker.js:33` `drawRenderCommand(ctx, cmd, source)`（与 Preview / Worker 同构）
- **Enrich ❌**：渲染几何（fit/rotate/center/placement）必须由 `createPlacement` → `drawRenderCommand` 单一决策，**禁止**在 Renderer 内自算（D1 收敛不变式）。
- **Forbidden**：各渲染位置自行计算 fit/rotate/center/swap。

---

## 4. PR 审查清单（如何使用本契约）

任何触碰核心对象的 PR，先问一句：

> **这个对象到底属于 Replace 型，还是 Enrich 型？**

| 代码形态 | 判定 | 合法性 |
|---|---|---|
| `files[idx] = newFile` | 整体替换 SessionFile | ❌ 违反 SessionFile Replace❌ |
| `identity = { ... }`（非 identity.js:116） | 整体替换 Identity | ❌ 违反 Identity Replace❌ |
| `replaceFileItems(key, ...)` 且 key 是占位项 | 整体替换 Placeholder | ✅ 合法 Placeholder Replace✅ |
| 切换预览文件重建 DocumentState | 整体替换 DocumentState | ✅ 合法 DocumentState Replace✅ |
| 每帧 `drawRenderCommand` 重建 RenderState | 整体替换 RenderState | ✅ 合法 RenderState Replace✅ |
| `updateFileStatus` / `applyFileUpdate` 逐字段 | 富化 SessionFile | ✅ 合法 SessionFile Enrich✅ |
| `updateDocumentIdentity` 只刷 docId | 富化 Identity | ✅ 合法 Identity Enrich✅ |

---

## 5. 与 4.2.2 的关系

4.2.2 的 F-0~F-3 最小集恢复，**逐条对照本契约验证**，而不是靠实现细节判断是否符合架构：

- 恢复的 Session 必须重建为 **SessionFile（Enrich-only）**，不得整体替换；
- Session 恢复不得把 **Placeholder** 当成文档持久化；
- 恢复的 SessionFile 内 **Identity** 必须原样携带（Enrich-only，docId 由 buildFileObj/updateDocumentIdentity 写入，恢复逻辑不重算）；
- Preview 在恢复后加载文件时，按 **DocumentState Replace-only** 语义重建，而非富化旧状态。

只要 Replace Boundary（Law 4）与 Identity Law（1~3）同时成立，4.2.2 即为架构安全。
