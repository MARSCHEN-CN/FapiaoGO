# Document Identity Contract v1.1

> **架构冻结文档** — 禁止修改此文档定义的 Identity 契约，除非经过架构评审。
>
> 状态：只读设计冻结 | 2026-07-20 | 评审修订 v1.0→v1.1
> 关联：V16 Stage 4 (identity layer)
> 审计依据：2026-07-20 两轮只读审计 + 架构评审
>
> **v1.1 相对于 v1.0 的变更：**
> 1. 新增 `pageId` — 页面实例身份（Review 1）
> 2. `docId` 改为纯内容哈希 `sha256(bytes)[:24]`，不再包含 filename（Review 2）
> 3. `factKey`/`cacheKey` 移出 Identity 模型，改为 Builder（Review 3）

---

## 1. Identity Problem Statement

### 1.1 当前混乱

系统中存在五套身份字段，各模块自行选择消费：

| 身份 | 生成规则 | 稳定性 | 生命周期 |
|------|---------|--------|---------|
| `fileObj.key` | `name + Date.now() + crypto.randomUUID()` | ❌ 每次导入不同 | UI 会话（临时） |
| `fileObj.docId` | `sha256(bytes+filename)[:24]`（后端） | ⚠️ 文件名变化则变 | 文档生命周期 |
| `fileObj.path` | 文件系统绝对路径 | ⚠️ 受移动/重命名影响 | 文件系统生命周期 |
| `content_hash` | `sha256(file_bytes).hexdigest()`（64 字符） | ✅ 纯内容哈希 | 文档生命周期 |
| `session.id` | `session-{timestamp}-{counter}` | ❌ 每次导入不同 | 单次导入任务 |

### 1.2 各模块当前选择的身份

```
FileList 行定位     → key
handleRotate 状态    → key
removeFile           → key
DocumentState.id     → key || id || ''
DocFacts 持久化键     → docId || path || key（三级回退）
RenderSpec           → docId
Preview URL          → docId
L1/L2 缓存键         → key（不稳定）
后端缓存键           → docId（稳定，独立体系）
Print 进度           → key
```

### 1.3 问题表现

同一数据流中身份不统一：

```
用户拖入图片 → buildFileObj(file, name, path) → docId = null
  → DocumentState.id = key（不稳定）
  → saveDocFacts(key, {rotation:90}) ← 持久化到 key
  → 重新打开应用 → 新 key → DocFacts 找不到 → rotation 丢失
```

此外，`fileObj.docId` 当前包含 filename（`sha256(bytes+filename)[:24]`）：
```
文件 A.pdf 内容相同，改名为 B.pdf：
  A.pdf → docId = sha256(bytes + "A.pdf")[:24] = "111..."
  B.pdf → docId = sha256(bytes + "B.pdf")[:24] = "222..."
  → DocFacts 丢失（同一内容不同键）
  → Cache 失效
  → 后端 Registry 重新注册
```

这不是 UI bug。这是架构契约缺失。

### 1.4 结论

> **身份选择必须集中化，禁止各模块自行选择身份字段。**
>
> **docId 必须与内容绑定，不与文件名绑定。**

---

## 2. DocumentIdentity Model

### 2.1 TypeScript 定义

```typescript
/**
 * DocumentIdentity — 文档身份统一出口
 *
 * 身份层次（稳定度递降）：
 *   sourceHash（纯内容，永远不变）
 *       ↓
 *   docId（内容身份，文件名变化不影响）
 *       ↓
 *   pageId（页面实例身份，多页 PDF 拆分后使用）
 *       ↓
 *   uiKey（UI 会话临时身份，每次导入不同）
 *
 * 使用规则：
 *   - 文档级事实（OCR 结果/发票号码/发票类型）→ docId
 *   - 页面级事实（旋转/裁剪/布局）→ pageId
 *   - UI 操作（FileList/选中/动画）→ uiKey
 */
interface DocumentIdentity {
  /**
   * UI 生命周期唯一标识。
   * 生命周期：当前 App Session。
   * 来源：generateFileKey(name) = name + Date.now() + uuid。
   * 用途：FileList 行定位、React key、旋转状态键、selection、动画。
   * 规则：永不进入持久化层或渲染层。
   */
  uiKey: string;

  /**
   * 文档永久身份（内容绑定）。
   * 生命周期：文档存在期间（跨 session、跨重命名不变）。
   * 来源：sha256(file_bytes).hexdigest()[:24] — 纯内容哈希，不含 filename。
   * 用途：DocumentState.id、RenderSpec、Preview URL、DocFacts 持久化键基。
   * 规则：所有文档类型（PDF/图片/OFD）必须存在。
   * 注意：后端 _make_doc_id 也需同步改为纯内容哈希。
   */
  docId: string;

  /**
   * 页面实例身份（文档拆分后使用）。
   * 生命周期：页面存在期间。
   * 来源：docId + pageNum（如 "abc123:p2"）。
   * 用途：页面级事实（旋转/裁剪/布局）的持久化键。
   * 规则：单页文档 pageId 省略，等于 docId。
   *
   * 关系：
   *   docId（原始文档）
   *     +-- pageId = docId:p1（page 1）
   *     +-- pageId = docId:p2（page 2）
   *     +-- pageId = docId:p3（page 3）
   *
   * DocFacts 分两层：
   *   - 文档级（pageId=docId，或省略 pageId）：
   *     { paperOrientation, ... }
   *   - 页面级（pageId=docId:pN）：
   *     { contentRotation, cropRect, ... }
   */
  pageId?: string;
  pageNum?: number;

  /**
   * 内容哈希（不可变源身份）。
   * 生命周期：文档内容生命周期（内容不变则不变）。
   * 来源：sha256(file_bytes).hexdigest()（完整 64 字符）。
   * 用途：后端去重、ETag 生成。
   * 规则：后端优先使用，前端保留透传。
   */
  sourceHash: string;
}
```

### 2.2 运行时 JS 版本

```javascript
/** @typedef {Object} DocumentIdentity
 * @property {string}  uiKey      - UI 会话临时身份
 * @property {string}  docId      - 文档永久身份（纯内容哈希）
 * @property {string}  [pageId]   - 页面实例身份（multi-page 时有值）
 * @property {number}  [pageNum]  - 页码（1-based）
 * @property {string}  sourceHash - 不可变源身份 */
```

### 2.3 与现有 fileObj 的关系

```javascript
// 当前（迁移前）:
fileObj = {
  key: 'invoice.jpg_172145123_abc-def',  // UI 临时身份
  docId: null,                           // 图片缺 docId
  name: 'invoice.jpg',
  path: '/Users/xxx/invoice.jpg',
  // ...业务字段
}

// 迁移后:
fileObj = {
  key: 'invoice.jpg_172145123_abc-def',  // 保留，仅用于 UI
  identity: {                             // 新增统一身份
    uiKey: 'invoice.jpg_172145123_abc-def',
    docId: 'sha256_24chars',
    pageId: 'sha256_24chars:p1',
    pageNum: 1,
    sourceHash: 'sha256_64_chars_full',
  },
  name: 'invoice.jpg',
  // ...业务字段（不变）
}

// 多页 PDF 拆分后:
fileObjs = [
  {
    key: 'invoice_p1.pdf_172145123_xxx',  // UI 身份（每个 page 不同）
    identity: {
      uiKey: 'invoice_p1.pdf_172145123_xxx',
      docId: 'same_24_chars',            // 同源 docId
      pageId: 'same_24_chars:p1',        // 页面级身份
      pageNum: 1,
      sourceHash: 'same_64_chars',
    },
    name: 'invoice_p1.pdf',
  },
  {
    key: 'invoice_p2.pdf_172145123_yyy',
    identity: {
      uiKey: 'invoice_p2.pdf_172145123_yyy',
      docId: 'same_24_chars',            // 同源 docId
      pageId: 'same_24_chars:p2',
      pageNum: 2,
      sourceHash: 'same_64_chars',
    },
    name: 'invoice_p2.pdf',
  },
]
```

---

## 3. Identity Priority Rules

### 3.1 稳定度递降

```
sourceHash         ─ 最稳定（纯内容哈希，64 字符）
   ↓
docId              ─ 主身份（纯内容哈希前 24 字符，不含文件名）
   ↓
pageId             ─ 页面实例（docId:pN，拆分后同源）
   ↓
path               ─ 文件系统身份（不稳定，仅迁移兼容）
   ↓
uiKey              ─ 最不稳定（每次导入不同）
```

### 3.2 docId 生成规则

```
所有文件类型统一:
  docId = sha256(file_bytes).hexdigest()[:24]
  ≠ sha256(bytes + filename)（旧规则，包含文件名 → 重命名断裂）

PDF（后端 split_pdf）:
  docId = sha256(file_bytes).hexdigest()[:24]
  ← 需同步修改 render_engine/registry._make_doc_id，去掉 +filename

图片/OFD（本地生成）:
  docId = sha256(file_bytes).hexdigest()[:24]
  ← 前端实现（或通过后端 /api/documents/open 注册获取）
```

### 3.3 禁止规则

```
❌ uiKey       → 持久化数据（DocFacts / RenderSpec / Preview URL）
❌ docId       → UI 渲染（React key / FileList row identity）
❌ pageId      → 文档级事实（OCR / 发票号码）
❌ path        → 进入主链（仅当 docId 无法获取时作为迁移兼容 fallback）
❌ filename    → 参与身份计算（docId 必须纯内容哈希）
```

### 3.4 身份使用范围

```
uiKey:               docId:                 pageId:
✅ FileList 行定位    ✅ DocumentState.id    ✅ 页面旋转持久化
✅ React key prop     ✅ RenderSpec.docId    ✅ 页面裁剪持久化
✅ 旋转状态键          ✅ Preview URL          ✅ 页面布局持久化
✅ 选中/动画           ✅ DocFacts 持久化基键
✅ 删除操作            ✅ 后端 Registry
✅ Print 进度          ✅ RenderCache 键
```

---

## 4. IdentityResolver + Key Builders

### 4.1 IdentityResolver 接口

```typescript
interface IdentityResolver {
  /**
   * 从 fileObj 解析完整身份。
   * 不触发异步操作。如果 docId 缺失，返回 partial identity。
   */
  resolve(fileObj: any): DocumentIdentity;

  /**
   * 确保 docId 存在。
   * 如果 docId 缺失，通过后端注册或本地 hash 生成。
   * 返回完整的 DocumentIdentity。
   */
  ensureDocId(fileObj: any, ipc?: IPCRenderer): Promise<DocumentIdentity>;

  /**
   * 解析页面实例身份。
   * 单页文档：pageId = docId（省略 pageId）。
   * 多页拆分后：pageId = docId:p{pageNum}。
   */
  resolvePageId(identity: DocumentIdentity, pageNum: number): DocumentIdentity;
}
```

### 4.2 FactKeyBuilder（不在 Identity 模型内，作为 Adapter）

```typescript
/**
 * FactKeyBuilder — 从 DocumentIdentity 构建持久化键。
 *
 * 不在 Identity 模型内，因为它是 Persistence Adapter 的职责。
 * 未来 DocFacts 从 JSON 迁移到 SQLite 时，只改此 builder，不改 Identity 模型。
 *
 * 当前实现：
 *   factKey = pageId ?? docId
 *
 * 示例：
 *   单页：     "abc123def456"
 *   多页 p2：  "abc123def456:p2"
 */
function buildFactKey(identity: DocumentIdentity): string {
  return identity.pageId || identity.docId;
}

/**
 * CacheKeyBuilder — 从 DocumentIdentity + render params 构建缓存键。
 */
function buildCacheKey(identity: DocumentIdentity, renderParams: any): string {
  const pagePart = identity.pageId ? `_${identity.pageId}` : '';
  // docId + renderParams 作为缓存身份
  return `${identity.docId}${pagePart}_r${renderParams.rotation}_p${renderParams.paperSize}_l${renderParams.isLandscape}`;
}
```

### 4.3 实现原则

```
IdentityResolver 不负责:
  ❌ 文件读取（那是 FileResolver 的职责）
  ❌ OCR/解析（那是 parseRunner 的职责）
  ❌ 状态管理（那是 ImportSession/React state 的职责）
  ❌ 渲染（那是 RenderLayoutFactory 的职责）
  ❌ 持久化键构建（那是 FactKeyBuilder 的职责）
  ❌ 缓存键构建（那是 CacheKeyBuilder 的职责）

IdentityResolver 只负责:
  输入: fileObj（或部分身份信息）
  输出: 完整、规范的 DocumentIdentity
```

---

## 5. 生命周期图

```
File Import（拖入/打开）
    |
    v
Temporary File Object
    {key, name, path, file}
    |
    v
IdentityResolver.resolve(fileObj)
    |                          ← 如果 docId 缺失，先 ensureDocId()
    |
    +------------------------------------------+
    |                    |                      |
    v                    v                      v
  uiKey               docId                  pageId（可能省略）
    |                    |                      |
    |                    |                      |
FileList            DocumentState.id         PageState（未来）
  - rowProps           - 渲染身份              - page-level rotation
  - onRemove(uiKey)    - RenderSpec.docId      - page-level crop
  - onRotate(uiKey)    - Preview URL           - page-level layout
  - fileRotations[uiKey]                       |
    |                    |                      |
    |                    v                      |
    |             FactKeyBuilder               |
    |                    |                      |
    |               +---+---+                  |
    |               |       |                  |
    |               v       v                  |
    |          DocFacts  RenderCache           |
    |           (factKey) (cacheKey)           |
    |                                          |
    v                                          |
Print Progress（uiKey 追踪）                   |
                                               |
    V16 Render 层不受 Identity 影响            |
    (PaperSpec → PaperLayout → RenderCommand → RenderSpec → Renderer)
```

---

## 6. Consumer Migration Map

### 6.1 迁移清单

| 消费者 | 当前使用身份 | 目标身份 | 优先级 | 迁移策略 |
|--------|------------|---------|--------|---------|
| FileList 行定位 | `fileObj.key` | `identity.uiKey` | P1 | Phase 2 改 |
| FileCardRow memo | `fileObj.key` | `identity.uiKey` | P1 | 随 FileList 一起改 |
| fileRotations 状态键 | `fileRotations[key]` | `fileRotations[identity.uiKey]` | P1 | 键不变，语义固化 |
| handleRemove | `removeFile(fileObj.key)` | `removeFile(identity.uiKey)` | P1 | 参数语义固化 |
| DocumentState.id | `loadedFile.key\|\|''` | `identity.docId` | **P0** | Phase 1 即改 |
| DocFacts factKey | `docId\|\|path\|\|key` 三级回退 | `buildFactKey(identity)` | **P0** | Phase 1 即改 |
| RenderSpec | `{docId: previewFile.docId}` | `{docId: identity.docId}` | **P0** | 验证 docId 是否存在 |
| Preview URL | `buildPreviewUrl(docId)` | `buildPreviewUrl(identity.docId)` | **P0** | 同 RenderSpec |
| 页面级 DocFacts（旋转） | `docId`（页间冲突） | `buildFactKey({pageId})` | **P0** | Phase 1 即改 |
| L1 previewLoadCache | `blob_${key}` | `blob_${docId}` | P2 | 缓存命中率优化 |
| L2 fullCache | `buildPreviewCacheKey({fileKey,...})` | `buildCacheKey(identity, params)` | P2 | 缓存命中率优化 |
| Print Progress | `printProgress[fileObj.key]` | `printProgress[identity.uiKey]` | P1 | 键不变，语义固化 |
| Merge 配对 | `getMergePair(files, fileObj.key)` | `getMergePair(files, identity.uiKey)` | P1 | 配对基于 uiKey |
| duplicateInfo | `duplicateInfo.get(fileObj.key)` | `duplicateInfo.get(identity.uiKey)` | P1 | 同 session 内稳定 |
| renameTransaction | `transactionKeys.has(f.key)` | `transactionKeys.has(identity.uiKey)` | P1 | 同 session 内稳定 |

### 6.2 迁移阶段

```
Phase 1（当前 P0）
  1. 更新 identity.js / 创建 IdentityResolver：定义 DocumentIdentity + FactKeyBuilder
  2. 修改 backend _make_doc_id：去掉 +filename，docId = sha256(bytes)[:24]
  3. 在 buildFileObj 中注入 identity（本地计算 sourceHash 和 docId，对齐后端规则）
  4. 补齐图片/OFD/单页 PDF 的 docId
  5. DocumentState.id = identity.docId（从 key fallback 改为 docId）
  6. DocFacts factKey = buildFactKey(identity)（从三级回退改为单一路径）
     - 读兼容：旧键（path/key）仍可读取
     - 写新键：新数据写入 identity.factKey
  7. 页面级旋转/裁剪：切换到 pageId 维度

Phase 2（后续 P1）
  8. FileList 从 identity.uiKey 获取身份
  9. rotate/remove 统一用 identity.uiKey
  10. Print/rename/duplicate 统一

Phase 3（后续 P2）
  11. Cache 键迁移到 buildCacheKey(identity, params)
  12. 审计 fileObj.key 的直接访问，加 eslint 规则
  13. 清理所有旧回退逻辑
```

---

## 7. Migration Rules

### 7.1 大爆炸禁止

```
❌ 不允许一次性替换所有 fileObj.key 为 identity.uiKey
❌ 不允许一次性修改所有消费者

✅ Phase 1: fileObj.identity 作为新字段加入，旧字段保留
✅ Phase 2: 逐个消费者迁移，每个迁移可单独验证
✅ Phase 3: 旧字段只读，禁止新代码直接访问
```

### 7.2 兼容期规则

```
Phase 1 期间:
  - fileObj.identity 存在但可选（旧数据无 identity）
  - 消费者优先读取 identity，不存在时回退旧字段
  - 所有新代码必须使用 identity

Phase 2 期间:
  - 每个消费者迁移完成后删除该消费者的回退逻辑
  - 消费者只读 identity，不再直接读 fileObj.key/docId

Phase 3:
  - 添加 lint 规则禁止直接访问 fileObj.key / fileObj.docId
  - 清理所有旧回退逻辑
```

### 7.3 docId 生成兼容性（后端变更注意事项）

```
旧规则：docId = sha256(file_bytes + filename).hexdigest()[:24]
新规则：docId = sha256(file_bytes).hexdigest()[:24]

影响：
  - 后端 RenderCache 键变化 → 旧缓存失效（一次性，无累积损失）
  - 后端 DocRegistry doc_id 变化 → 旧 session 中已注册的文档与新 docId 不匹配
  - 后端 _make_doc_id 修改后，需要前端同步变更（统一 hash 算法）

迁移策略：
  Step 1: 后端 _make_doc_id 在返回 doc_id 的同时，返回旧 doc_id 兼容映射
  Step 2: 前端使用新 doc_id，旧 doc_id 作为 301 重定向键
  Step 3: 过渡期后删除旧 doc_id 映射
```

---

## 8. Validation Checklist

### 8.1 Identity 正确性

- [ ] 同一个 PDF 两次导入的 docId 相同
- [ ] 同一张图片两次导入的 docId 相同
- [ ] OFD 文件导入后有 docId
- [ ] 文件重命名后 docId 不变（新规则不含 filename）
- [ ] 多页 PDF 拆分后所有 page 共享同源 docId，但有不同 pageId
- [ ] `identity.uiKey` 仍保持每次导入不同（不退化）

### 8.2 Render 正确性

- [ ] `DocumentState.id === identity.docId`
- [ ] RenderSpec 中不含 uiKey
- [ ] Preview URL 使用 docId
- [ ] 同样的 docId → 同样的预览缓存键
- [ ] 多页文档每页独立渲染，不相互影响

### 8.3 持久化正确性

- [ ] DocFacts 的键永不包含 uiKey
- [ ] DocFacts 分文档级（docId）和页面级（pageId）
- [ ] 重启 App 后旋转恢复
- [ ] 重启 App 后纸张方向恢复
- [ ] 图片的旋转设置跨 session 保持
- [ ] 多页 PDF 各 page 独立旋转跨 session 保持

### 8.4 UI 正确性

- [ ] FileList 仍使用 uiKey 定位行
- [ ] 删除操作不依赖 docId
- [ ] 旋转操作的状态键与持久化键分离
- [ ] FileCardRow memo 浅比较在 uiKey 不变时正常工作

### 8.5 回退兼容性

- [ ] 旧数据（无 identity 字段）不崩溃
- [ ] 旧数据在首次操作后自动补齐 identity
- [ ] DocFacts 旧键（path/key）在迁移期间仍可读取
- [ ] 后端旧 docId（含 filename）在迁移期间可重定向到新 docId

### 8.6 docId 算法变更（后端 + 前端对齐）

- [ ] 后端 `_make_doc_id` 改为 `sha256(bytes)[:24]`
- [ ] 前端图片/OFD 的 docId 使用相同算法
- [ ] 后端 `/api/documents/open` 在常规路径也返回纯内容哈希 docId
- [ ] 前端的本地 hash 实现与后端算法一致（无跨语言偏差）

---

## 9. 与 V16 架构关系

### 9.1 最终层次结构

```
PaperSpec                    ← 纸张规格
    |
PaperLayout                  ← 纸张布局
    |
DocumentIdentity             ← 新增第 0.5 层（Identity Resolver + Key Builders）
    |
    +--- DocumentState       ← 文档级事实（docId）
    |       |
    |       +--- RenderCommand → RenderSpec → Renderer
    |
    +--- PageState           ← 页面级事实（pageId，未来层）
    |
    +--- DocFacts            ← 持久化（factKey = pageId ?? docId）
    |
    +--- Cache               ← 缓存（cacheKey = docId + params）
    |
    +--- FileList            ← UI（uiKey）
```

### 9.2 Identity 层不触及的层

```
以下层与 Identity 无关，不做任何修改:
  - PaperSpec / PAPER_SIZE_MAP
  - computePaperLayout
  - buildRenderCommand / RenderLayoutFactory
  - renderDraw.js / drawRenderCommand
  - renderers.js 的缩放/绘制逻辑
  - backend/render_engine/ 渲染管线
  - Compose / Slot 布局
```

### 9.3 需要同步修改的模块

```
frontend:
  - fileHelpers.js: buildFileObj → 注入 identity
  - identity.js: 升级为 IdentityResolver（含 resolve/ensureDocId/resolvePageId）
  - usePreview.js: DocumentState.id 切换
  - electron/preload.js: DocFacts factKey 切换
  - DocFacts 消费者（factKey → buildFactKey(identity)）

backend:
  - render_engine/registry.py: _make_doc_id 去掉 +filename
  - app.py: split_pdf 返回新 docId
  - api.py: /api/documents/open 返回新 docId
  - cache.py: cache key 更新（如依赖旧 docId）
```

---

## 10. 风险登记

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 图片 docId 补齐引入后端注册延迟 | 预览首次加载变慢 | 前端本地实现 sha256 hash，可选异步注册 |
| OFD 文件可能不支持后端注册 | docId 缺失 | 本地 hash 作为 docId 来源 |
| 旧数据无 identity 字段 | Phase 1 兼容期判断 | 消费者使用 `identity ?? fallback` 模式 |
| DocFacts 旧键迁移（path/key 键） | 旧用户数据丢失 | Phase 1 保留两级回退读取，Phase 2 写回新键 |
| docId 算法变更（去掉 filename） | 后端旧 docId 与前端新 docId 不匹配 | 后端返回新 docId + 旧 docId 兼容映射 |
| 多页 PDF 拆分后 page 的 pageId 语义 | Compose/Print 需要区分文档级 vs 页面级 | pageId = docId:p{num}，文档级省略 pageId |
| 页面级旋转持久化与当前 fileRotations 状态键冲突 | 持久化写 pageId，UI 状态用 uiKey，两套不冲突 | UI 状态仅用于当前 session，持久化读 pageId |

---

## 附录：关键代码位置参考

| 组件 | 文件 | 行号 |
|------|------|------|
| generateFileKey（key 产生） | `frontend/src/utils/fileHelpers.js` | 12-14 |
| buildFileObj | `frontend/src/utils/fileHelpers.js` | 17-40 |
| identity.js（当前身份工具） | `frontend/src/utils/identity.js` | 全部 |
| ImportSession（数据模型） | `frontend/src/models/ImportSession.js` | 全部 |
| ImportSessionStore（运行时） | `frontend/src/stores/ImportSessionStore.js` | 全部 |
| useFileOps（导入编排） | `frontend/src/hooks/useFileOps.js` | 全部 |
| FileList（文件列表） | `frontend/src/components/FileList.jsx` | 全部 |
| FileCardRow（行组件） | `frontend/src/components/FileList.jsx` | 9-155 |
| usePreview（预览编排） | `frontend/src/hooks/usePreview.js` | 全部 |
| DocumentState 构造 | `frontend/src/hooks/usePreview.js` | 1418-1433 |
| DocFacts 持久化（主进程） | `electron/main.js` | 978-1034 |
| DocFacts IPC（preload） | `electron/preload.js` | 20, 73-75 |
| previewCacheKey（缓存键） | `frontend/src/utils/previewCacheKey.js` | 全部 |
| stripIdentity（身份剥离） | `frontend/src/utils/identity.js` | 12-23 |
| backend _make_doc_id（docId 生成） | `backend/render_engine/registry.py` | 230-233 |
| backend split_pdf | `backend/app.py` | 783-856 |
| backend cache key | `backend/render_engine/cache.py` | 152-160 |

---

## 修订记录

| 版本 | 日期 | 变更内容 | 评审人 |
|------|------|---------|--------|
| v1.0 | 2026-07-20 | 初版冻结 | — |
| v1.1 | 2026-07-20 | 1. 新增 pageId；2. docId 改为纯内容哈希；3. factKey/cacheKey 移出 Identity 模型，改为 Builder | 架构评审 |

---

> **本契约已于 2026-07-20 v1.1 冻结。任何修改必须经过架构评审，并在修订记录中注明变更原因。**
