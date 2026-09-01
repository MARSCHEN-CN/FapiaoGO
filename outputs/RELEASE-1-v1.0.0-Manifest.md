# FapiaoGO v1.0.0 Release Manifest（RELEASE-1 · RC v5 · 正式打包）

- 发布日期：2026-08-31（RC v5 正式打包 = RC v4 + 真机修复 `98c432b`）
- Release Source（冻结）：**`98c432b`**（已 push 远端，经 `git ls-remote` 权威确认）
  - `562a989` 原基线（RC v2 Source）
  - `3bb809c` fix(sidebar): 缩小 brand logo 到 40px
  - `259426f` fix(party): 购销方括号补充说明/经营主体后缀解析失败
  - `6c1c6bf` build: SIZE-2 locales 裁剪至 zh-CN+en-US（-44MB）
  - `d2f670d` build: SIZE-2 P1 afterPack 钩子删 LICENSES+dxcompiler/dxil（-46.5MB）
  - `dde9f06` fix(preview): 首次导入自动预览 firstReady 守卫
  - `d7ecadf` build: SIZE-2-A pdf_tool 排除 numpy（-30MB）
  - **`98c432b` 日常更新：usePreview.js 合并预览优先用户点击文件 + SumatraPDF 换版（-31KB）**
- 体积基线：768.5 MB → 680 MB（SIZE-2 P1）→ **650 MB（+ SIZE-2-A，Δ 累计 -118.5 MB）**
  - locales 55→2 pak（-44MB）+ LICENSES.chromium.html（-19.4MB）+ dxcompiler/dxil（-25.8MB）
  - SIZE-2-A：pdf_tool 排除 numpy，dist/pdf_tool 119→90MB（-29MB），win-unpacked 680→650MB（-30MB）
  - **backend 侧 266MB 全程零变化**，cv2/rapidocr/models/onnxruntime 完好（OCR 未受影响）
  - 最终验收以 `du` 实测为准，不取理论值

## 交付物（release_final_v5/，两件套：1 个安装程序 + 1 个绿色版压缩包）

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `FapiaoGO-Setup-1.0.0.exe`（安装程序，未签名） | 234.1 MB | `5213a4411162719a6f22fb5acd0aeb2bfde5802f74bb52aa847cd88b32e61626` |
| `FapiaoGO-v1.0.0-Windows-x64-Portable.zip` | 300.3 MB | `488c398fdd5a706b73b26e0e6b77b98fdb6b45f65d34baccae28067568eb2520` |

（机器可读：`outputs/SHA256SUMS-v1.0.0.txt`，已覆盖为 v5 值；Release 附件还需 `latest.yml`）

- Portable.zip 顶层结构：`FapiaoGO.exe / resources/ / database/.keep / …`（绿色版，含初始化占位）
- `FapiaoGO-v1.0.0-Windows-x64-Installer.zip` **已废止**（与 Setup.exe 内容重复，纯冗余），本版不再产出
- 旧 `release_final/`（v1）、`release_final_v2/`（RC v2）、`release_final_v3/`（RC v3）、`release_final_v4/`（RC v4）产物作废，勿用于发布

## Gate 状态（RELEASE-1 · RC v5）

| Gate | 内容 | 状态 |
|---|---|---|
| R0 | Source Freeze：`98c432b`，SIZE-2-A 独立提交且已 push（远端经 ls-remote 确认） | ✅ PASS |
| R1 | Clean Build（前端 vite 重建 9.69s，`node vite.js build` 绕过沙箱 shim；usePreview.js 改动编译进 dist） | ✅ PASS |
| R2 | 后端 dist 复用：server.exe（15:16，含 party 修复）；pdf_tool（16:36，含 numpy 排除）——不受 98c432b 影响 | ✅ PASS |
| R3 | electron-builder 两目标（**nsis/dir**，两件套标准），afterPack 钩子实测执行 | ✅ PASS |
| R4 | 结构审计：locales 仅 zh-CN/en-US / P1 三目标已删 / GPU 栈保留 / cv2 83M+models 31M 完整 / **tools 内 numpy 0 残留** / **650MB** | ✅ PASS |
| R5 | Runtime Smoke：server /health=ok；真实发票 OCR amount=133.08 failed_fields=[]；prod 版 pdf_tool margin 冒烟 success:true rotation=0 | ✅ PASS（沙箱可做部分） |
| R6 | Core Regression（Display / Print Preview / 实际打印 / Merge-batch） | ⏳ 真机验收（见清单） |
| R7 | Portable.zip 单件压缩（两件套标准，Installer.zip 废止），300.3MB | ✅ PASS |
| R8 | SHA-256 + latest.yml（size 245427415 与 Setup.exe 字节数精确匹配，sha512 实测一致）+ Manifest | ✅ PASS |
| R10 | 产物完整性复核（2026-09-01）：Setup/Portable SHA-256 与 SHA256SUMS 逐字符匹配；**Portable.zip CRC 全量校验 PASS（536 条目，`testzip()` 返回 None）**；latest.yml 的 size+sha512 与 Setup.exe 实测双匹配 | ✅ PASS |
| R9 | Release Freeze | ⏳ 待真机 R6 通过后定 |

## SIZE-2 验证矩阵（RC v5 实测）

| 验证项 | 预期 | 实测 |
|---|---|---|
| electronLanguages 生效 | 仅 zh-CN/en-US 两个 pak | ✅ `locales/` 仅 2 个 |
| afterPack 删 P1 三目标 | LICENSES/dxcompiler/dxil 不存在 | ✅ 构建 log + 磁盘双证 |
| GPU 栈保留 | libGLESv2/libEGL/d3dcompiler/vulkan 存在 | ✅ 6 个 DLL 齐全 |
| cv2 / OCR models 完整 | 83M / 31M | ✅ |
| server 启动 + OCR 链 | /health ok，真实发票可解析 | ✅ amount=133.08 |
| SIZE-2-A：pdf_tool numpy 消失 | tools 内 numpy/numpy.libs 0 残留 | ✅ 0 文件（dist + prod 双查） |
| SIZE-2-A：三条 JSON IPC 冒烟 | margin / placement-bake / png-to-pdf 全 PASS | ✅ dist 版 + prod 版各跑一遍全 PASS |
| SIZE-2-A：backend 侧不受影响 | 266MB 零变化，cv2/rapidocr/models 完好 | ✅ 严格不变 |
| SIZE-2-A：构建 warn 无隐藏异常 | 无新缺失模块 | ✅ 仅 `numpy.typing`(optional) + 有意 excluded |
| 总体积 | ≈650MB | ✅ **650MB（du 实测）** |

## 真机验收清单（R6 / 发布前必测）

1. **绿色版**：解压 Portable.zip → 双击 FapiaoGO.exe → 默认浅色、无黑窗、DevTools 不可呼出（F12/Ctrl+Shift+I/Ctrl+Shift+J）；首启自动创建 `database/` 与 `userdata/`（EXE 同级）；导入一张发票 → 重启 → 数据仍在。
2. **安装版**：运行 `FapiaoGO-Setup-1.0.0.exe` → 安装 → 首启同 1；卸载时确认 **database/userdata 不被删除**（Update Gate ⑦）。
3. **UI 尺寸**：1080p 下主窗口 1000×660（内容 1:1）、计算器 360×660、侧栏 logo 40px + 间隔 8px（2K）/6px（1080p）。
4. **首次导入自动预览**（V4 FIX 回归）：导入文件列表出现后自动预览不空白。
5. **打印**：pdf_tool / placement-bake / pdf-margin / SumatraPDF 无黑窗、打印正常（含横向纸+margin 用例）。
   - **SIZE-2-A 专项回归**（pdf_tool 已排除 numpy）：重点验证**图片类文件**的边距打印（png-to-pdf 走 PIL/pikepdf 路径，是 numpy 排除后最需实证的链路）；若出现图像相关报错，立即回退 `d7ecadf`。
   - **预览优先回归**（98c432b）：合并预览与文件点击的优先级——点击列表文件应立即切换预览，不被合并预览遮挡。
6. **压缩导出**：7z/rar/where 无黑窗。
7. **Legacy Migration** + 签名状态确认（Setup/FapiaoGO.exe 未签名，SmartScreen 可能警告，发布时说明）。

## 产物完整性实证（2026-09-01 复核，机器可读：`outputs/_v5_asset_verify.json`）

| 校验项 | 预期 | 实测 |
|---|---|---|
| `FapiaoGO-Setup-1.0.0.exe` SHA-256 | `5213a441…e61626` | ✅ 逐字符匹配 |
| `FapiaoGO-v1.0.0-Windows-x64-Portable.zip` SHA-256 | `488c398f…b2520` | ✅ 逐字符匹配 |
| Portable.zip CRC 全量解压校验 | `testzip()` 返回 `None` | ✅ **PASS**（536 条目，0 损坏） |
| `latest.yml` size vs Setup.exe 字节数 | 245427415 | ✅ 匹配（Setup 245,427,415 B） |
| `latest.yml` sha512(base64) vs Setup.exe 实测 | `/8Y7v4Vw…WJeg==` | ✅ 匹配 |
| `latest.yml` version | 1.0.0 | ✅ |

结论：RC-v5 两件套 + latest.yml 三件完整可用，可直接上传 Release。

## 备注

- SIZE-2 P2（d3dcompiler/vk_swiftshader/vulkan-1，-10.8MB）按纪律**待真机删除实验**（启动+渲染+预览+打印完整回归）后再定；SIZE-1C（双 runtime 合并，-101.5MB 实证上限）**保持冻结**，独立 SIZE-2 阶段。
- 前端零 WebGL + 全 2D canvas 是 P1 三项删除的强证据（`outputs/SIZE-2-readonly-audit.md`）。
- ✅ **push 已完成**：远端 `rotation-b1-hardening` = `98c432b`（`git ls-remote origin rotation-b1-hardening` 权威确认）。
  - ⚠️ 沙箱环境的 gitconfig 锁错误导致 fetch 无法回写本地 remote-tracking ref，本地 `origin/rotation-b1-hardening` 缓存可能显示旧值。真机执行 `git fetch origin` 即可刷新，**不影响远端实际状态**（勿手动改 `.git/refs`，2026-08-10 有事故教训）。
- `default_app.asar`（111KB，Electron 发行版自带死文件）各版本均存在，app.asar 存在时不加载，不影响发布。
