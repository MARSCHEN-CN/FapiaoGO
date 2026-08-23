# FapiaoGO 打包 — Gate 0 环境审计（2026-08-11）

> 目的：打包前真实环境盘点，不做代码改动、不执行打包。结论用于决定 Phase 1 修复顺序。

## 致命阻断项（优先级高于 R1–R4）

### G0-ENV-1：打包所用的 backend/venv 缺少全部运行时依赖
- `backend/venv`（Python 3.13.14）仅含：`pikepdf`、`PIL`、`img2pdf`、`orjson`（及其传递依赖）。
- import 失败（缺失）：`numpy`、`flask`、`flask_cors`、`pdfplumber`、`rapidocr`、`onnxruntime`、`cv2`、`fitz`(PyMuPDF)、`sklearn`、`cryptography`、`magic`、`openpyxl`、`yaml`。
- electron-builder 通过 `extraResources: backend` 打包的正是此 venv → 打包后后端连 `flask` 都 import 不了，必然启动失败。
- 根 `.venv`（Python 3.13.3）含 `numpy`/`flask`/`rapidocr 3.9.0`/`cv2`/`fitz`/`openpyxl` 等，但同样**缺失 `onnxruntime`**（OCR 推理引擎）→ 开发态 OCR 也已不可用。
- `backend/requirements.txt` 声明：`rapidocr==3.9.2`、`onnxruntime==1.20.1`、`flask`、`flask-cors`、`numpy`、`PyMuPDF` 等。
- 结论：打包前必须 `backend/venv/Scripts/pip install -r backend/requirements.txt`（含 onnxruntime），并实测 `python app.py` 起服务、`/health=200`、OCR 可跑。

## Gate 表（G0-1 ~ G0-8）

| Gate | 检查 | 结果 |
|------|------|------|
| G0-1 | 当前 branch / HEAD | branch=`rotation-b1-hardening`，HEAD=`97446eb4 fix(rename): 重命名后同步 originalName 并触发装配结果重建`；存在未跟踪探针文件（`_c3_probe.mjs`、`backend/_tmp_json_test.py`、`frontend/_page_order_probe*.mjs` 等）。发布基线需确认。 |
| G0-2 | electron-builder.yml 当前真实配置 | 已读：`appId=com.FapiaoGO.app`，`win.icon: resources/icon.ico`（文件不存在），`files` 排除全部 node_modules 后仅回灌 electron-updater 系，`extraResources` 含 `backend`/`pyscripts`/`cmaps`/`standard_fonts`/`wasm`/`sumatra`。 |
| G0-3 | archiver/exceljs 是否被主进程依赖 | `archiver`：`electron/archive-utils.js:9` `require('archiver')` → 必需。`exceljs`：`electron/package.json` 声明，主进程源码无任何 `require('exceljs')` → 遗留未用依赖，可排除。 |
| G0-4 | resources/icon.ico 是否存在 | 不存在（`resources/` 仅 `sumatra/`）→ R1 确认。源图 `frontend/public/icon/app-icon.png` 可用。 |
| G0-5 | frontend/public/fonts 实际结构 | 4 个 woff2（MiSans-Regular/Semibold、NotoSansSymbols/NotoSansSymbols2）；另 `icon/`(22)、`cmaps/`(109)、`standard_fonts/`(16)、`wasm/`(13)、`test/`(dev demo，应排除)。 |
| G0-6 | RapidOCR 版本 + Py3.13 匹配 | 根 `.venv` `rapidocr=3.9.0`（requirements 要求 3.9.2）；rapidocr 3.x **支持 Py3.13** ✅（用户假设成立，非旧 rapidocr-onnxruntime/<3.13）。但 `onnxruntime` 两 venv 均未装 → OCR 引擎缺失。架构 AMD64 / 64bit ✅。 |
| G0-7 | /icon/ /fonts/ process.env 生产路径风险 | 确认：`ActionBar.jsx:94/101/108` 写死 `/icon/PDF.svg`/`xlsx.svg`/`zip.svg`；`index.css:89/98/107/116` 与 `index.html:12-15` 写死 `/fonts/*.woff2`。`process.env.NODE_ENV` 由 Vite 静态替换，安全；真正需改的是 `/icon/` 与 `/fonts/` 绝对路径。 |
| G0-8 | backend/Sumatra/PDF.js/OCR 资源树 | OCR 模型 `backend/models/{det,rec,cls,keys}` 存在 ✅；`resources/sumatra` ✅；`cmaps/standard_fonts/wasm` 经 extraResources ✅。OFD 字体：`ofd_parser/ofd_constants.py:17` 用 `parent.parent.parent/'frontend'/'public'/'fonts'` 构造 dev 路径（R3 确认）；`ofd_renderer.py:46` 先试 `./fonts/`（backend cwd）可作缓解。`backend/venv` 不完整（见 G0-ENV-1）为最大隐患。 |

## 对原打包方案 R1–R4 的修正
- **R1 维持**：icon.ico 缺失 + BrowserWindow 未设 icon。
- **R2 修正**：`archiver` 必须进包（主进程确实需要）；`exceljs` 经核查主进程从未 require，是遗留依赖，可安全排除（减小体积）。
- **R3 维持**，路径机制已确认（构造式 dev 路径）。
- **R4 维持**；`process.env.NODE_ENV` 风险剔除（Vite 处理）。

## Phase 1 修复顺序（待确认后执行）
1. **补全 backend/venv**：`pip install -r backend/requirements.txt`（含 onnxruntime），验证后端启动 + `/health=200` + OCR 可跑。
2. **R1 图标**：用 `app-icon.png` 生成 `resources/icon.ico`；`main.js` BrowserWindow 加 `icon`。
3. **R2**：调整 electron-builder `files` 使 `archiver` 进包（建议 `npm install --production` 后整体保留 electron 生产依赖，排除 electron/electron-builder/@electron/rebuild/electron-rebuild/typescript）。
4. **R3**：extraResources 加 `frontend/public/fonts → fonts`；`ofd_constants.py` 改从 `resourcesPath` 解析（透传 `FAPIAO_RESOURCE_PATH`）。
5. **R4**：前端 `/icon/`、`/fonts/` 改相对（`PUBLIC_BASE`）。
6. 排除 `frontend/public/test`（dev-only 资产）。
7. 确认 G0-1 发布基线分支。
