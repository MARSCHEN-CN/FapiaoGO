# Commit 3 完成报告 + Git 仓库事故处置说明

日期：2026-08-08 20:00
分支（原）：`rotation-refactor`

---

## 一、Commit 3（修 B2）——代码层已完成并验证通过

### 目标达成

`resolveContentPlacement` 不再同时相信「几何 `paperSize`」与「可能矛盾的标签 `paperOrientation`」。

```
改造前（B2 语义分裂）          改造后（单一可信坐标系）
paperSize ────┐                requestedPaperOrientation
              ├─→ Resolver            ↓ needSwap（调用方）
paperOrientation ┘              physicalPaper
                                      ↓ 纯几何派生
                                physicalPaperOrientation → Resolver
```

### 实际改动

| 文件 | 改动 |
| --- | --- |
| `frontend/src/layout/RotationResolver.js` | 签名 `paperSize`+`requestedPaperOrientation` → `physicalPaper`；新增 4 个旧键 fail-fast 护栏；`physicalPaperOrientation = detectPaperOrientation(physicalPaper)`；返回字段改名 |
| `frontend/src/print/PrintPreviewModel.js` | 调用点只传 `physicalPaper`（needSwap 产物即最终物理纸张） |
| `frontend/src/hooks/usePrint.js` | 同步改名 + 记录 Issue P11 死代码 |
| 9 个测试/脚本 | Group A 死键改名删键；Group B 新增 `toPhysicalPaper()` needSwap 归一化；Group C 同 A |

**实现体零改动**：`computeLayoutRotation` 逻辑、统一 `-90` 约定、`renderTransform`/scale 公式全部原样。
**边界严守**：未新增 `resolvePaperTransform()`、未动 `ROTATE_LOOKUP`、未碰缓存与 Sumatra 链。

### 验收：行为对照完全不变

冻结 Gate 表 A 四象限（与 Commit 2 逐字节一致）：

| 纸型 / UI 方向 | 几何 | 一致 | layoutRotation | scale |
| --- | --- | --- | --- | --- |
| A4 / portrait | 209.97×297.01 | ✅ | -90 | 1.386 |
| A4 / landscape | 297.01×209.97 | ✅ | 0 | 1.386 |
| Voucher240x140 / portrait | 140.04×240.03 | ✅ | -90 | 1.115 |
| Voucher240x140 / landscape | 240.03×140.04 | ✅ | 0 | 1.115 |

测试套件：

| 套件 | 结果 | 基线 | 判定 |
| --- | --- | --- | --- |
| paperOrientationFreezeGate | 22/22 绿 | 22/22 | ✅ |
| rotationResolver | 37 pass / 0 fail | 36/0 | ✅ +1 为新增契约护栏测试 |
| orientationFitGate | 15/0 | 15/0 | ✅ |
| fitScaleAudit | 8/0 | 8/0 | ✅ |
| singleVsMultiInputMatrix | 1/0 | 1/0 | ✅ |
| rotationAudit | 5 pass / 2 fail | 5/2 | ✅ 红数不变（M7/M8 未落地，设计意图） |
| rotation3LayerGate | 4 / 5 | 4/5 | ✅ 同上 |
| rotationPaperTransformGate | 3 / 5 | 3/5 | ✅ 同上 |
| printPreviewModel | 14 / 3 | 14/3 | ⚠️ 3 个失败为 **Commit 1-A 改名遗留**（测试仍断言 `p.orientation`，模型已改 `p.requestedPaperOrientation`），文件本次未修改 |

### 附带发现：Issue P11（预存死代码，刻意未修）

`usePrint.js:550` 传 `contentSize` 而契约要求 `contentPhysicalSize` → 每次抛错被 catch 静默吞 → `placements` 恒为 `{}`。
且该处 `paperSize` 是**未经 needSwap 归一化**的原生纸型 —— 修 ① 时必须同时补归一化，否则会把 B1 老 bug 带回来。
按 bisect 纪律本次仅同步改名并加注释。

---

## 二、⚠️ Git 仓库事故（19:47 前后）

### 现象与根因

`git` 报 `fatal: not a git repository`，但 `.git` 目录存在。

排查结论：
- `.git/refs/` 被**整个删除**（所有 loose 分支引用丢失）
- `.git/logs/` 内容清空（reflog 全丢，只剩空目录骨架）
- 8/8 当天新增的 loose object 几乎全被清除

非本会话 git 命令所致（当时执行的 `git stash push` 已中断、未生效）。疑为外部进程（杀毒 / 文件同步 / IDE 内置 git 工具）在 D 盘工作区上的清理动作。

### 损失清单

- 4 个提交对象全部不可读：`71e55dbb`(C0) / `4916b1a1`(C1-A) / `9bb5c483`(C1-B) / `834a87a2`(C2)
- 分支 ref `rotation-refactor` 丢失 → `HEAD` 变为未出生分支
- 对象库有空洞（`git fsck`: `Could not read c72a2866…` / `4265a194…`），`git diff` 不可用
- 悬空提交最新只到 **2026-08-07** ⇒ 7/26 → 8/8 约两周的提交历史本地不可达

### 完好部分（关键）

- ✅ **工作区源码 100% 完好** —— Commit 0→3 的全部改动都在磁盘上，且已由测试验证
- ✅ `.git/objects/pack/` 与 `packed-refs` 健康：`master`(a087afc8, 7/26)、`main`、`ui` 等全部可读
- ✅ `FETCH_HEAD` 显示**远端存在 `rotation-refactor` 分支**（`c7bb9db4`，今日 18:01 fetch 成功过）

> 结论：丢的是**提交历史与引用**，不是代码。

### 已执行的恢复动作（纯增量，零删除）

1. `mkdir -p .git/refs/heads .git/refs/tags` → git 重新识别仓库，packed-refs 分支恢复可见
2. 全量备份 19 个旋转重构相关文件至
   `backups/rotation-refactor-recovery-20260808-195409/`

### 待决策的恢复方案

| 方案 | 做法 | 优点 | 代价 |
| --- | --- | --- | --- |
| **A. 探测远端** | 先 `git fetch origin` | 可能找回大量历史与对象，信息量最大 | 需凭据（今日 push 一直失败，fetch 曾成功） |
| **B. 就地重建** | 基于 `master`(7/26) 新建 `rotation-refactor`，把工作区提交 | 不依赖网络，立刻恢复可提交状态 | master 太旧，单次提交会混入两周无关改动 |
| **C. 重新 clone** | 克隆到新目录，再把工作区文件覆盖过去 | git 元数据全新最干净 | 需网络+凭据，且要人工核对覆盖范围 |

**建议顺序：A → 视结果决定 B 或 C。**

### 🚨 恢复前禁止操作

在方案确定前，**不要执行** `git checkout` / `git reset --hard` / `git clean` ——
当前工作区是所有旋转重构成果的唯一可信副本。
