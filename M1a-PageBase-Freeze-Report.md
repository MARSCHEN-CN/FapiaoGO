# M1-a · 页码基数「当前真实行为」锁定报告

> **日期**：2026-08-09
> **范围**：只新增测试文件，**未修改任何生产代码、未创建 `SourcePageResolver.js`、未提交 commit**
> **判定基准**：`SourcePageResolver-Design-Audit.md` v2 冻结的 `SourcePageIdentity` 契约
> **性质**：本轮锁定的是**当前事实（fact lock）**，不是目标契约（contract lock）

---

## 0. 一句话结论

**32 个用例全绿，当前页码基数事实已被可执行地钉死。**
但运行过程中暴露出 **4 项原计划外的发现**，其中 **F1 与 F2 直接影响 M1-a 的有效性**，需你裁决后才算真正闭环。

---

## 1. 交付物

| 文件 | 通道 | 用例数 | 结果 |
|---|---|---|---|
| `backend/tests/test_m1a_split_pdf_page_base.py` | A：`/split_pdf.page_index` | 7 | ✅ 7 passed |
| `backend/tests/test_m1a_batch_import_page_base.py` | B：批量导入 `page_num` | 10 | ✅ 10 passed |
| `frontend/test/pageBaseContract.m1a.test.mjs` | 前端 #3 / #3b / #4 / #5 | 15 | ✅ 15 passed |
| **合计** | | **32** | **✅ 32 / 32** |

三个文件均在文件头显式声明：

> ⚠️ 本文件锁定的是【当前真实行为】，**不是目标契约**。
> 若将来 M1-c 统一页码基数，本文件【预期失败】——失败即「我们正在改 base」的明确信号。
> 届时应连同 `SourcePageIdentity` 契约一起显式更新断言，**而不是悄悄放宽/删除断言**。

**两条通道在测试层强制隔离**：Channel A 与 Channel B 分属两个文件，文件头互相声明「禁止表述为同一 contract」。这正是漂移潜伏的根源——Commit 4.1/4.3 归一了表单通道却漏掉 `/split_pdf`，恰因二者曾被当成同一个契约。

---

## 2. 事实表（可执行版）

以下每一行都有对应断言，而非文档声明：

| 层 | 当前真实语义 | 锁定处 |
|---|---|---|
| `/split_pdf.page_index` | **1-based**（首页 = 1，N 页 = `1..N`） | A · `test_fact_first_page_index_is_one_not_zero` |
| `/split_pdf.page_id` 后缀 | **0-based**（`{hash}_{i}`，与同响应内 `page_index` 反向） | A · `test_fact_page_id_suffix_is_zero_based_while_page_index_is_one_based` |
| 批量导入 `page_num`（默认分支） | **按 1-based 归一**（`n → n-1`） | B · `test_fact_default_branch_normalizes_one_based_by_minus_one` |
| 批量导入 `page_num`（`'0'` 前缀分支） | **按 0-based 透传**（`'01' → 1`） | B · `test_fact_zero_prefixed_string_is_treated_as_zero_based_passthrough` |
| `fileObj.pageNum` | **1-based**（原样透传，无任何 ±1） | 前端 · `现状：fileObj.pageNum === page.page_index，无任何 ±1 变换` |
| `fileObj.pageCount` | **恒为 1**（硬编码，与真实页数无关） | 前端 · `现状：pageCount 硬编码 1…` |
| `DocumentStore.pages[].index`（多页分支） | **0-based**（`pageNum - 1`） | 前端 · `现状 · 多页分支…` |
| `DocumentStore.renderPage`（多页分支） | **1-based**（`index + 1`） | 同上 |
| `DocumentStore`（**单页分支**） | **pageNum 被丢弃**，恒 `index=0 / renderPage=1` | 前端 · `现状 · 单页分支…` |
| `PageMeta.pageId` | **0-based**（`docId:p{index}`） | 前端 · `现状：PageMeta.pageId 使用 0-based index…` |
| `SourcePageIdentity.sourcePageIndex` | *未来契约：0-based*（尚未实现） | — |

**跨层链路锁**（你指定的 #5）已通过：

```
backend page_index=1  →  fileObj.pageNum=1  →  pages[0].index=0  →  renderPage=1   ✅
backend page_index=2  →  fileObj.pageNum=2  →  pages[1].index=1  →  renderPage=2   ✅
```

---

## 3. 运行方式（含一处必须记录的环境事实）

```bash
# 后端（⚠️ 不能用 backend/venv —— 见 F3）
cd backend
"C:/Users/Mars_chen/AppData/Local/Programs/Python/Python311/python.exe" -m pytest \
    tests/test_m1a_split_pdf_page_base.py \
    tests/test_m1a_batch_import_page_base.py -q
# → 17 passed

# 前端（复用仓库既有 loader，未自造）
cd frontend
node --test --experimental-loader=./test/resolve-js-loader.mjs test/pageBaseContract.m1a.test.mjs
# → 15 pass / 0 fail
```

---

## 4. 运行期新发现（原计划外，共 4 项）

### 🔴 F1 —— `/split_pdf` 的 1-based **从未被任何在跑的测试守护**

Migration Audit v1 称既有测试「把 1-based 焊死」。**实测为误**，该断言从未执行：

```python
# backend/tests/test_split_pdf_chunk.py
L123    assert counter["n"] == 1 + expected_chunk_opens      # ← 在此先失败
L132    _assert_order_and_content(pdf_bytes, pages)          # ← base 断言在函数内，永不到达
```

实跑 `test_split_pdf_chunk.py`：**8 failed / 1 passed**。失败原因全为 `KeyError: 'preview_image'` 与 `fitz.open` 次数不符——**`/split_pdf` 响应结构已漂移，与页码基数无关**。唯一通过的 `test_split_download_page_after_chunk` 不含 base 断言。

**这不是削弱 M1，而是加强它**：base 与「核心原则 3」长期矛盾却无人察觉，正因为它处于**无测试覆盖**状态。`test_m1a_split_pdf_page_base.py` 是目前**唯一在跑的 base 守护**。

> 已回写勘误到 `SourcePage-Migration-Audit.md` §1.1。
> `test_split_pdf_chunk.py` 的 8 项断裂**仅登记，未修**（与页码基数无关，属独立议题）。

### 🔴 F2 —— `.gitignore` 会让新增的后端测试**进不了版本控制**

```
.gitignore:16   **/tests/*
.gitignore:17-35  !backend/tests/<15 个文件的白名单>
```

`backend/tests/` 下 33 个文件 tracked，但白名单只有 15 条——其余 18 个是历史 `git add -f` 进去的（tracked 后 gitignore 失效）。

`git check-ignore -v` 确认，我新写的两个文件**当前处于被忽略状态**：

```
.gitignore:16:**/tests/*    backend/tests/test_m1a_split_pdf_page_base.py
.gitignore:16:**/tests/*    backend/tests/test_m1a_batch_import_page_base.py
```

**后果**：若直接 `git add .`，这两个「唯一在跑的 base 守护」会被静默丢弃，M1-a 等于没做。

前端 `frontend/test/pageBaseContract.m1a.test.mjs` **不受影响**（正常 untracked，可直接 add）。

> **✅ F2 已裁决并执行（2026-08-09）——采用白名单方式，不用 `git add -f`。**
> 理由（用户裁决原文要点）：这两个测试已属**正式架构契约测试**而非临时实验文件；
> `backend/tests` 既有白名单策略更符合仓库长期维护方式。
>
> `.gitignore` 新增**恰好 2 条精确路径**（第 38-39 行）+ 2 行来源注释，
> **未放开整个 `backend/tests`**：
>
> ```gitignore
> # M1-a 页码基数现状锁定（backend）：架构契约测试，与上方同策略刻意纳入版本控制。
> # 仅放行这两个精确路径，不放开整个 backend/tests。A/B 两通道刻意分文件，禁止合并表述。
> !backend/tests/test_m1a_split_pdf_page_base.py
> !backend/tests/test_m1a_batch_import_page_base.py
> ```
>
> **验证（只读）**：
> - `git check-ignore -v` 现由 `.gitignore:38/39` 的 `!` 规则命中 → 已解除忽略
> - `git status --porcelain` 三个测试文件均为 `??`
> - **反向验证**：`git status --untracked-files=all backend/tests/` 输出**恰好只有这两个文件**，
>   证明未连带放开其它任何测试
>
> 附带发现（既有问题，仅登记不修）：根 `.gitattributes` 里粘的是 **gitignore 模板内容**
> （`.env` / `!.env.example` / parcel 缓存注释等），导致任何 attributes 查询都打印
> `warning: Negative patterns are ignored in git attributes`。已用
> `git check-attr text -- backend/app.py`（完全不涉及 gitignore）复现，**证明与本轮改动无关**。

### 🟡 F3 —— `backend/venv` 缺 `fitz`，后端测试须用系统 Python 3.11

`backend/venv` 基于 managed Python 3.13.12 构建，**无 `fitz`/PyMuPDF**，导致 `test_split_pdf_chunk.py` 与 Channel A 在 venv 下**收集阶段即失败**。系统 Python 3.11.9 具备完整依赖（`pytest`/`flask`/`fitz`/`PIL`/`requests`，且 `import app` 成功）。

**未安装任何包**，仅切换解释器。这是个既有环境事实，非本轮引入。

### 🟡 F4 —— `DocumentStore` 的映射是**分支相关**的，「`pageNum - 1`」不是普适规则

写测试时发现，`pageNum → index` 有两条互不相同的路径：

| 分支 | 条件 | 行为 |
|---|---|---|
| 多页 | `pageNums.length > 1` | `index = pageNum - 1`，`renderPage = pageNum` |
| **单页** | `pageNums.length === 1` | **`pageNum` 被整个丢弃**，恒 `index = 0 / renderPage = 1` |

且 `pageNum = null` 会 `?? 1` 落入单页分支。

**对 M1-b 的直接影响**：Resolver 若写成无条件 `sourcePageIndex = pageNum - 1`，在单页分支下与现状不一致；而「单页分支丢弃 pageNum」在 `pageCount` 恒为 1（v2 已记录）的前提下，可能让**多页 OFD/PDF 静默退化为单页**。这条必须进 M1-b 的 normalization boundary 设计。

---

## 5. 本轮为 M1-b 准备好的输入

M1-b 要回答「**哪一层是唯一的 base normalization boundary**」。现在已有可执行的候选面：

```
外部 evidence（多基数并存）
  ├── /split_pdf.page_index      1-based
  ├── /split_pdf.page_id 后缀     0-based      ← 同一响应内自相矛盾
  └── 批量导入 page_num           运行时猜测（'0' 前缀 → 0-based，否则 1-based）
                  ↓
        ？ normalization boundary ？        ← M1-b 待定
                  ↓
        sourcePageIndex: 0-based
                  ↓
    所有 SourcePage / Plan / Consumer（禁止再 ±1）
```

三个候选边界及其代价，供 M1-b 讨论（**本轮不做选择**）：

| 候选 | 位置 | 优点 | 代价 |
|---|---|---|---|
| B1 | 后端 emit 处（`app.py:987`） | 一处改完，源头干净 | 破坏所有既有前端消费端；跨前后端同步发布 |
| B2 | 前端入口（`fileHelpers.buildFileObj`） | 前端内部从此单一基数 | 后端仍双基数；`page_id` 后缀矛盾未解；`pageNum` legacy 与 `pageIndex` new **双轨迁移** |
| B3 | Resolver 内（`resolveSourcePages`） | 不动任何既有链路，增量安全，最贴合「身份层不倒逼生产架构」 | Resolver 必须**知道各 evidence 的来源语义**，不能做成 `pageNum - 1` 的简单 helper |

### 5.1 M1-b 必答的三个问题（用户 2026-08-09 裁决时追加，为本轮冻结口径）

M1-b **先做 Boundary Audit，不直接选方案**。必须先回答：

1. **page-base normalization 的唯一 boundary 到底在哪里？**
2. **OFD 的真实 page evidence 谁负责提供给该 boundary？**
   （v2 已证：`buildFileObj:56` 硬编码 `pageCount: 1`，全仓无一处回写 `fileObj.pageCount`；
   `PrintPreviewModel:348` `f?.pageCount || 1` → 多页 OFD 在打印链恒不展开）
3. **「单页默认 page 0」与「缺失 page evidence」如何严格区分？**
   （F4 已证两条错误路径：无条件 `pageNum - 1` 会把 `pageNum = null` 的单页 PDF/Image
   误判为 evidence 缺失；而无条件 `pageNum ?? 1` 又会把多页 OFD / metadata 未完成 /
   evidence 真缺失**一律伪装成单页**）

### 5.2 倾向与保留（**本轮不拍板**）

初步倾向 **B3 最稳**，但明确不拍板。因为 F4 暴露出比 boundary 选址更深的一层：

> **`SourcePageResolver` 可能根本不应是「FileObj → 一个 SourcePageIdentity」的函数，
> 而应是「已知 source document + page evidence → 一个或多个 SourcePageIdentity」的规范化器。**

这与 v2 已记录的两点属**同一组问题**，需一并求解：
OFD `pageCount` 未进入 FileObj；`PrintPreviewModel` 因 `pageCount || 1` 把多页 OFD 退化为单页。

∴ 三个问题解决后，Resolver 的输入/输出会自然收敛——**顺序不能倒过来**。

---

## 6. 严格未做清单

- ❌ 未修改任何生产代码（`git status` 中 25 个 M 文件全为既有 WIP）
- ❌ 未创建 `SourcePageResolver.js`
- ❌ 未修 `pageNum - 1`，未改任何 base
- ❌ 未修 `test_split_pdf_chunk.py` 的 8 项既有断裂
- ❌ 未 `pip install` / 未改 venv
- ❌ 未 commit / 未 push
- ❌ 未修 `.gitattributes` 的既有 negative-pattern 问题（仅登记）
- ✅ 新增 3 个测试文件 + 勘误 `SourcePage-Migration-Audit.md` §1.1 + 本报告
- ✅ **F2 裁决执行**：`.gitignore` 增 2 条精确白名单（测试基础设施维护，**不属生产代码修改**）

---

## 7. 当前状态与下一步

**冻结状态（2026-08-09）**：

| 项 | 状态 |
|---|---|
| M1-a 页码基数现状锁定 | ✅ 完成（32 用例全绿） |
| F1 审计结论纠正 | ✅ 已正式表述（Migration Audit §1.1-F1），并标注至项目记忆核心原则 3 |
| F2 测试可追踪性 | ✅ 已处理（白名单方式） |
| F4 分支相关映射 | 📌 已登记，纳入 M1-b 输入，**本轮不修** |
| Resolver | ⛔ 未进入，未创建 |

**下一步只做 M1-b Boundary Audit**：先回答 §5.1 三个问题，**不写 Resolver、不修生产代码、不选方案**。

冻结顺序不变：`M1-b → M1-c → M3 → M4 → Resolver → Plan 携带 → M5 → M2`
（M2 已按裁决延后至 SourcePage 主链建立之后——`pageId` 是旧表示层 identity 问题，
M1 是更底层的 page coordinate contract 问题，先钉坐标系风险最低。）

**F1/F4 纳入 M1-b 输入，不单独修**——它们都是「base 未被规范化」的症状，
boundary 定下来之前单独修任何一处，都只是搬运问题。
