# G2 接线追踪（只读）：`landscape,rotate=0` Truth 为何变成 `landscape,rotate=90`

> 只读追踪，未修改任何代码，未 commit。
> 目标只回答一个问题：**为什么这个 Truth=`landscape,rotate=0` 的 case，最终被生成成 `landscape,rotate=90,noscale`？**

---

## 0. 结论（一句话）

命中的是**执行器层双重旋转（double-rotation）接线 bug**：Geometry Authority（`apply_pdf`）已经把旋转烤进 PDF，但 Sumatra 执行器仍从旧的 `sourceRotation` 权威独立再算一次 `rotate`。当前**生产 emitter 只认 `sourceRotation`，完全不消费你测出的 32 条 Truth**。因此：

```
landscape,rotate=90,noscale  ⟺  sourceRotation=90 到达了 emitter
```

你的 32-case Truth 目前是**无人认领的孤儿**——它既不在 emitter 里，也不在死代码 `ROTATE_MATRIX` 里（那是另一套只有 90/270 的旧矩阵）。

---

## 1. 生产链路（从 Truth 到命令）

```
① 前端 usePrint.js:881 / services/PrintService.js:59,69
   sourceRotation = fileRotations[file.key] || 0        ← 用户旋转 UI 的每文件角度
   landscape      = !!userSettings.landscape            ← 用户是否勾选横打
   paperOrientation = requestedPaperOrientation(...)     ← 用户请求方向

② IPC 'print-source-file' → electron/main.js:print-source-file

③ main.js:573-633  margin 分支（A4 + 有边距 → 走这里）
   geo = translateGeometry({orientation, rotate:sourceRotation, baseDims})   ← G1d：算 apply_pdf 几何
   pdfMargin.process(filePath, margins, isImage, orient,
                     {paperW_mm, paperH_mm, contentRotation})                ← apply_pdf 把 contentRotation 烤进 PDF
   printSettings = {...settings, scalePolicy:'none'}                          ← ⚠️ 保留原始 sourceRotation/paperOrientation

④ electron/print-backend.js:buildSumatraCommand
   buildSumatraCommand:128-132  normalizedSettings.paperOrientation
        = getPaperShapeOrientation(paper)   ← ⚠️ 用纸张自然方向覆盖用户请求（A4→portrait）
   buildPrintSettings(normalizedSettings)                                  ← L143

⑤ electron/print-settings.js:buildPrintSettings (唯一活 emitter)
   contentRotation = src.sourceRotation ?? src.rotation ?? 0   ← L183
   if (contentRotation !== 0) parts.push(`rotate=${contentRotation}`)  ← L292-294
   baseFlag = spec.paper.orientation==='landscape' ? 'landscape' : 'disable-auto-rotation'  ← L289-291
```

---

## 2. 关键发现 A：emitter 只吃 `sourceRotation`，不认 32-case Truth

- `print-settings.js:183` — `contentRotation = src.sourceRotation ?? src.rotation ?? 0`
- `print-settings.js:292-294` — `rotate` 唯一来源就是这个 `contentRotation`
- `sumatra-command-resolver.js:31-40` — `ROTATE_MATRIX`（旧 16-case，只有 90/270 两值）**是死代码**：全仓 grep 仅自身引用，无任何 `require`/`import` 消费它。
- 你贴出的 32-case 实测矩阵（含 `rotate=0/180`）在代码里**没有任何生产实现**在消费。

→ 现实中有 **三套互不协调的旋转模型**：
| 模型 | 位置 | 状态 |
| --- | --- | --- |
| A. 你的 32-case 实测 Truth | 对话/文档 | 权威但**未接入代码** |
| B. `ROTATE_MATRIX` | sumatra-command-resolver.js | **死代码**（90/270 仅） |
| C. `buildPrintSettings`/normalize | print-settings.js | **实时生效**，只认 `sourceRotation` |

实时生效的是 C，且 **C ≠ A**。这正是你抓的核心问题。

---

## 3. 关键发现 B：apply_pdf 烤旋转后，执行器又转一次（double-rotation）

- `margin_contract.py:240-301` `apply_pdf`：输出 `/Rotate` **硬写 0**（L298 `page.obj["/Rotate"] = 0`），`content_rotation` 烤进相似变换矩阵（L286 `phi=int(content_rotation)%360`）。
- `main.js:579-633` G1d 把 `contentRotation` 透传给 `pdfMargin.process` → Python 把旋转**烤进 PDF**。
- 但 `main.js:629` `printSettings = {...settings, scalePolicy:'none'}` **原样保留 `sourceRotation`**，透传给 backend。
- `print-backend → buildPrintSettings` 仍从 `sourceRotation` 算 `rotate`（L183/292）。

→ **apply_pdf 转一次 + Sumatra 再转一次 = double rotation**。`noscale` 下不再有 `fit` 兜底 → 裁切。这与你观察到的 `landscape,rotate=90,noscale` + 仍然裁切 **完全自洽**。

---

## 4. 关键发现 C：上一版 G1d 只修了几何链，没修执行器

我上一版的 G1d 接线（main.js:579-602 + geometry-translator.js）只把 `contentRotation` 喂给 `apply_pdf`，**从未把执行器的 `rotate` 归零或与几何输出协调**。这恰好是你说的那句：

> "我们修了 PDF 几何链，但 Sumatra 命令链仍然在自己计算 rotate。"

所以 G1d 不是"接好了"，是"几何接了、执行器脱节"。

---

## 5. 关键发现 D：`landscape` 基标志也由另一个独立权威决定（第二个 bug）

- `print-backend.js:128-132` `buildSumatraCommand` 把 `paperOrientation` **覆盖成纸张自然方向** `getPaperShapeOrientation(paper)`（A4→`portrait`），**丢弃用户请求的 landscape**。
- 仅当 `normalize` 经 `src.landscape`（来自 `services/PrintService.js:75` `landscape: !!userSettings.landscape`）才勉强保留 `landscape` 基标志。

→ 纸张方向也有两个不协调权威（用户请求 vs 纸张自然方向），与旋转是同一类根因。

---

## 6. `rotate=90` 的两个具体注入点（定位）

要产生 `landscape,rotate=90`，必须 **`landscape` 基标志命中 + `sourceRotation=90` 到达 emitter**。两个注入点：

1. **`electron/main.js:567-569`（烘焙路径，C-2-G 横纸执行器补偿）**
   ```js
   const execOrient = settings?.executionPaper?.orientation
   printSettings = { ...printSettings, sourceRotation: execOrient === 'landscape' ? 90 : 0 }
   ```
   硬编码 `90`。只要 `executionPaper.orientation==='landscape'` 即注入 90。

2. **前端 `fileRotations`**（`usePrint.js:881` / `services/PrintService.js:69`）
   ```js
   const fileRotation = fileRotations?.[file.key] || 0
   sourceRotation: fileRotation
   ```
   用户旋转 UI 把该文件设成 90 → 注入 90。

> 你确证"用户旋转=0"时，最可能命中 **点 1 的烘焙路径**（若当时该文件走了 placement/executionPaper=landscape），或该文件 `fileRotations` 实际被设成了 90。
> **下一步确证手段**：单 case 打印，抓取日志 `main.js:518 [print-source-file] settings=%j` 与 `print-backend.js:152 [CommandBuilder] ...`，直接看 `sourceRotation` 实值。

---

## 7. 修复方向（待你批准后实施，本次不做）

把"执行器命令"的派生源从【原始 Truth/sourceRotation】改为【apply_pdf 的已烘焙输出】：

- **apply_pdf 路径（新 Geometry Authority）**：执行器只发 `noscale` + 正确的物理纸选择；`rotate` **强制 0**（或读烘焙后 PDF 的 MediaBox 方向），绝不从 `sourceRotation` 再算。
- **旧纯 source 直打路径**：保留你的 32-case Truth（`landscape/portrait + rotate=N + fit`）作为该路径的**唯一权威**。
- 把 32-case 实测矩阵提升为**唯一可调度 Rotation Truth 源**；`ROTATE_MATRIX` 死代码删除或并入。
- `buildSumatraCommand` 不得再覆盖 `paperOrientation`（方向权威收口到用户请求 / apply_pdf 输出，单一来源）。
- 清理 `usePrint.js:886` 与 `services/PrintService.js:58` 两个并存的 `ps` 构造器（代码发散风险）。

---

## 8. 纪律守约

- ✅ 本次只读追踪，未改任何代码，未 commit。
- ✅ 边界未破：`margin_contract.py` / `add-pdf-margins.py` / bake / 16表 / `RotationResolver` / `normalize` 均未动。
- ✅ 未复用 `normalize()` 当 Translator（上一版已规避）。
- 🔴 当前状态裁定：**G2 wiring FAIL**（非 margin 算法、非打印机物理层）。`landscape,rotate=90,noscale` 即该 FAIL 的直接证据。
