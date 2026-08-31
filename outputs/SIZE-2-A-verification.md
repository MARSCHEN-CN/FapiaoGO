# SIZE-2-A 验证报告：pdf_tool 排除 numpy

- **日期**：2026-08-31
- **Commit**：`d7ecadf` — `SIZE-2-A: pdf_tool.spec exclude numpy (-29MB)`
- **范围**：仅 `backend/pdf_tool.spec`（执行范围严格冻结，见文末「未触碰清单」）
- **结论**：**通过。采用最小改动方案（`excludes` 增列 `numpy`），无需退回精准 PIL 收集。**

---

## 1. 改动内容

`backend/pdf_tool.spec` 的 `excludes` 列表增列一项：

```python
excludes=[
    'tkinter', '_tkinter', 'tcl', 'tk', 'PIL.ImageTk', 'PIL._tkinter_finder', 'PIL._imagingtk',
    'numpy',          # ← SIZE-2-A 新增
],
```

未修改 `collect_submodules('PIL')` 本身（若最小方案验证失败，才退回精准 PIL 收集——本次未触发）。

## 2. 根因

`collect_submodules('PIL')` **无差别收集 PIL 全部子模块** → 命中 `PyInstaller/hooks/hook-PIL.ImageFilter.py`（该 hook 把 numpy 声明为可选依赖）→ 拖入 `numpy` 7MB + `numpy.libs` 21MB（OpenBLAS）。

这与 2026-08-28 的 SIZE-1B-1（拖入整套 Tcl/Tk，−6.36MB / 835 文件）是**同一个 spec、同一行代码、同一个机制**——上次只堵了 tkinter，没堵 numpy。

三层证据：

| 层 | 检查 | 结果 |
|---|---|---|
| ① 业务代码 | `pyscripts/` + `scripts/` 内 pdf_tool 闭包脚本 | 零 numpy 引用（唯一命中 `scripts/show_ocr_lines.py` 是 OCR 调试脚本，**不在 pdf_tool 闭包内**） |
| ② 第三方包 | `pikepdf` / `pymupdf` / `img2pdf` | 零 numpy 引用（`img2pdf` 为单文件模块，仅依赖 PIL） |
| ③ PyInstaller hook | `hook-PIL.ImageFilter.py` | 命中 numpy 可选依赖声明 |

## 3. 验证结果（用户预设三证据标准）

### 证据 1 — numpy 确实消失 ✅

| 检查点 | 结果 |
|---|---|
| `backend/dist/pdf_tool/_internal/numpy` | 已消失 |
| `backend/dist/pdf_tool/_internal/numpy.libs` | 已消失 |
| `dist/pdf_tool` 全目录 `find -iname "numpy*"` | **0 个文件** |
| prod 路径 `release_r38/.../resources/tools` 内 `find -iname "numpy*"` | **0 个文件** |

### 证据 2 — 三条 JSON IPC 冒烟全 PASS ✅

**dev 版**（`backend/dist/pdf_tool/pdf_tool.exe`，重建后立即验证）与 **prod 版**（`release_r38/win-unpacked/resources/tools/pdf_tool/pdf_tool.exe`，最终产物验收）**各跑一遍，结果一致 PASS**。

| # | 冒烟 | 判据 | 结果 |
|---|---|---|---|
| ① | `margin_contract` | `success:true`、`margin=[28.346]*4`（10mm）、`contentRotated:true`、矩阵 `[0, −0.6095, 0.6095, 0]`、`pageRotate=0` | ✅ |
| ② | `placement-bake` | `success:true`、MediaBox `[419.5276, 595.2756]`（=A5 148×210mm）、`rotate=0`、`phi=90` | ✅ |
| ③ | `png-to-pdf` | `success:true`、`action:"png-to-pdf-with-margin"`、产物 PDF 存在 | ✅ |

冒烟 ② 走的是 pikepdf **完整路径**（`open` → `Page` → `add_resource(XObject)` → `contents_add` → 输出前 `verify` 回读断言 MediaBox/CropBox//Rotate），因此**正面证伪**了构建告警中 `pikepdf._core → numpy (conditional)` 的条件分支触发风险。

### 证据 3 — 构建日志无隐藏异常 ✅

`build/pdf_tool/pdf_tool/warn-pdf_tool.txt`（78 行）中 numpy 相关仅 2 条：

- `missing module named 'numpy.typing' - imported by PIL._typing (conditional, optional)` — PIL 类型注解用，运行时不触发
- `excluded module named numpy - imported by pikepdf._core (conditional)` — **有意为之**，经冒烟 ② 证伪

其余告警为 Windows 平台噪声（`pwd`/`grp`/`fcntl`/`termios`/`_posixsubprocess` 等 posix-only 模块）与 PyInstaller 内部模块，非本次引入。

## 4. 体积实测（验收值，非理论估算）

| 对象 | 前（RC-v3 / r37） | 后（r38） | 差值 |
|---|---|---|---|
| `backend/dist/pdf_tool` | 119 MB | **90 MB** | **−29 MB** |
| `win-unpacked` **（最终验收对象）** | 680 MB | **650 MB** | **−30 MB** |
| `win-unpacked/resources/tools/pdf_tool` | 119 MB | 90 MB | −29 MB |
| `win-unpacked/resources/backend` | 266 MB | **266 MB** | **0（严格不变）** |
| `FapiaoGO-Setup-1.0.0.exe` | 253.6 MB | **234.1 MB** | −19.5 MB |

## 5. 冻结项完好性（证明未误伤）

| 项 | 状态 |
|---|---|
| `backend/server/_internal/numpy`（server 侧 numpy 为 cv2/rapidocr 真依赖） | ✅ 保留 |
| `cv2` / `rapidocr` / `models` / `onnxruntime` | ✅ 全部完好 |
| `resources/backend` 体积 | ✅ 266MB 零变化 |
| 打印几何逻辑 / margin 契约 / placement bake 语义 | ✅ 未改动一行 |

## 6. 未触碰清单（执行范围冻结遵守情况）

- ❌ 未改 `backend/server.spec`（server / OCR / RapidOCR / ONNX）
- ❌ 未删 `lxml`
- ❌ 未删 `ffmpeg.dll`
- ❌ 未改任何打印几何逻辑
- ❌ 未做精准 PIL 收集（E）——最小方案已通过，按规则不扩 scope

## 7. 遗留事项

1. **RC-v4（`release_r38`）尚未成为发布资产**：Portable.zip 未压缩、SHA/latest.yml 未生成、**真机验收未做**（Display / 打印预览 / 实际打印 / Merge-batch）。
2. **本地 remote-tracking ref 缓存 stale**：`origin/rotation-b1-hardening` 停留在 `209f0c4`，因沙箱 gitconfig 锁错误导致 fetch 无法回写 ref。**远端真实状态已由 `git ls-remote` 权威确认为 `d7ecadf`**（推送成功）。真机执行 `git fetch` 即可刷新。
3. **临时冒烟目录 `_smoke_A/` 未删除**：产物 PDF 被宿主 file-history watcher 锁住（既有沙箱限制），留在 untracked，不入库。
4. **剩余候选保持冻结**（等 v1.0.0 发布后再议）：server `lxml` 7MB / Electron `ffmpeg.dll` 3MB / GPU 栈 10.8MB / SIZE-1C 双 runtime 合并 101.5MB。

## 8. 新增工程经验（已沉淀至技能 `fapiaogo-sandbox-build`）

1. `placement-bake` 子命令**即使传 `--placement-file`（完整 spec），`--source/--output/--paper-width-mm/--paper-height-mm` 仍是 argparse required**，漏传直接 `exit=2` 只输出 usage。
2. Git Bash 偶发 fork 崩溃（`fatal error - add_item ... errno 1`）→ 素材生成等改用 PowerShell 工具。
3. `--clean` **配合独立 `--workpath`** 是安全的（旧 toc 在默认 `build/`，新 workpath 为空无旧 toc 可删）——修正了此前「勿用 `--clean`」的绝对结论。
4. pdf_tool 三条冒烟的完整命令、参数契约与 PASS 判据已写入技能，下次改 spec/几何脚本可直接复用。
