# 展示区自动预览失效 · Git 回归取证（Provenance Layer）

> 日期：2026-09-04 · 分支 rotation-b1-hardening（HEAD e6bbb89）· 纯只读，零代码改动
> 症状：导入后列表正常，展示区空白，**点一次文件列表才显示**（实机复现 B 类）。
> 用户定性：回归性（此前某版本正常）。本文档回答：哪些修复叠出了当前洞。

## 0. 前提事实（先钉死）

- R2 计数器（import:8 实机）：`AUTO_PREVIEW 18` → `SCHED 10` → `START 6` → `COMMIT_SUCCESS 2`，
  空白仍在。→ **自动预览确实触发了（18 次），但最终提交的快照不可显示或目标错误**。不是「没触发」。
- 一致性校验全过 → 探针无漏事件，时间轴可信。
- 用户实机已复现 B（空白需点击），本次=失效样本。

## 1. 就绪链「空白修复」叠层史（按时间）

| commit | 日期 | 改了什么 | 在链中的角色 |
|---|---|---|---|
| `4438760` 更新 | 07-14 | **引入 docId 异步就绪→重预览 effect**（usePreview）。原注释自述根因：自动预览在 files.length 增加时触发，占位 docId=null → pdf.js Canvas；点击时 docId 已就绪 → RE。修复=监听 docId 跃迁重走 doLoadPreview | 第一层修补：给「提前触发」兜底 |
| `0ba816a` 多页导入预览为空 | 08-01 | 引入场景 2（prevDocIdPresenceRef：documentId 从无到有→重预览）+ 页码 1-based→0-based | 第二层：App 侧兜底 |
| `8afd1e1` 单页导入竞态 | 08-02 | DocumentStore GC 过渡态跳过（rows 无 docId 时不删注册文档） | 保护注册不被误删（间接） |
| `c711a1d` 搜索后空白 | 08-25 | 场景 4 由 `f.key` 比较改为 `resolveDocumentIdentity` 比较（App + DisplayAdapter） | 第三层：身份口径统一 |
| `dde9f06` firstReady 守卫 | 08-31 | **场景 1 加 firstReady 门**：displayFiles[0] 有 documentId/docId 才自动预览；注释自述「等场景 2 自然接管」 | 第四层：把「提前触发」改成「延后到就绪」，**依赖场景 2 接力** |

→ 行为演进主线：**提前触发 + docId 兜底重试（7 月）→ 延后就绪触发 + 场景 2/3/4 接力（8/31 起）**。

## 2. 头号嫌疑：`dde9f06`（唯一改变「何时自动预览」语义的近期 commit）

**改动**（App.jsx 场景 1，diff 仅 6 行）：
```diff
-    if (lenIncreased && !previewFile) {
+    const firstReady = !!(firstItem?.documentId || firstItem?.docId)
+    if (lenIncreased && !previewFile && firstReady) {
       handlePreview(displayFiles[0])
     }
```
**引入的隐式契约**：场景 1 不再在 placeholder 阶段触发；触发权整体交给场景 2
（`firstHasDocId && !prevDocIdPresenceRef.current`）。**场景 2 有洞时 = 永不自动预览**。

**场景 2 的洞（当前代码 App.jsx:1009-1020 逐行走查）**：
```js
if (firstHasDocId && !prevDocIdPresenceRef.current) {   // 只认 index0 的 documentId
  const pvHasDocumentId = !!previewFile?.documentId
  if (!previewFile || !pvHasDocumentId) handlePreview(displayFiles[0])
}
```
- 只覆盖 **displayFiles[0]** 的 documentId 跃迁；index0 若一直是同一占位行（documentId 已存在但
  **载荷未就绪**：printPath / _pdfData 源 / RE 图未好），场景 2/3/4 全部**不会再触发**——
  `DOCID_RETRY_EVAL` 只在 `live.docId !== pf.docId` 时救（载荷就绪但 docId 未变 → 不救）。

## 3. 放大器（非起源，但决定症状形态）：`loadFilePreview` 永不返回 null

- usePreview.js:1584 兜底 `return fObj`——docId 就绪但载荷未就绪时返回**空壳**（无
  `_previewImageUrl`/`_pdfData`），commit 保险丝（INV-PS6）只查 `phase==='post-load'` 不查就绪度
  → 空壳照常 commit → `previewFile` 非 null 但内容空 → **所有 `!previewFile` 型重试被屏蔽**。
- 点一次为什么好：点击发生时载荷已就绪 → 同一函数拿到真数据。自动预览跑在「docId 先到、载荷后到」
  的窗口 → 空壳。**格式分叉**：RE URL 只给 image-like（含 OFD）；**PDF 走 pdf.js 需要 file/printPath
  载荷**，对 PDF 的「docId 就绪但载荷未到」窗口更宽。

## 4. 分层判定（regression-truth-probe 纪律）

| 层 | 判定 | 证据 |
|---|---|---|
| 探针可靠性 | ✅ PASS | 计数器账目全平（19=12+7 / 10=6+4 / 6=2+3+1） |
| 「没触发」假设 | ✅ 排除 | AUTO_PREVIEW 18、START 6、COMMIT 2——触发了 |
| 「渲染慢」假设 | ✅ 排除 | completed 计数正常、点击即好 |
| 就绪链触发语义 | 🔴 **主嫌疑=dde9f06**（延后触发+依赖场景2），前置=4438760/0ba816a 的兜底链在「载荷就绪」维度无覆盖 | commit diff + 当前代码走查 |
| 空壳 commit 放大 | 🔴 放大器=loadFilePreview:1584 兜底 + 保险丝不就绪度检查 | 行号实读 |

## 5. 判定所需的最后两件证据（缺口）

1. **R2 dump 时间轴**（用户剪贴板已有）：看最后一次 `START` 的结局、2 次 `COMMIT_SUCCESS` 的
   `docId`+三 flag、`AUTO_PREVIEW` 18 次的 branch 分布、`DOCID_RETRY_EVAL=1` 是否=第 19 次调用。
   - 若最后一次 COMMIT_SUCCESS 是**空壳** → 坐实「docId 先到/载荷后到」窗口 + 空壳屏蔽重试 →
   修复落点 = 快照就绪度 gate（不 commit 空壳）+ 载荷就绪再预览触发。
   - 若最后一次 START 被 TERMINATED/ABORTED → 坐实 supersede 时序，与 dde9f06 无关。
2. **回归锚点**（用户记忆）：哪个版本是「好的」？决定在哪个 commit 窗口做 A/B（dde9f06^ 或更早）。

## 6. 下一步选项（等你选）

- **A（推荐，零猜测）**：贴 dump + 回答锚点 → 我出最终归因与最小修复方案（仍不动手）。
- **B（实证 A/B）**：我出 dde9f06 单行回退的 scratch commit（`6a6bd1f` 前基线的同款场景1），
  你实机导 8 张对比——若回退后仍空白，则 dde9f06 排除，洞在场景2→3→4 或载荷窗口，方向随之改变。
- 格式问题（影响 PDF 特有窗口判定）：本次导入的 8 张是 **PDF / OFD / 图片 / 混合**？
