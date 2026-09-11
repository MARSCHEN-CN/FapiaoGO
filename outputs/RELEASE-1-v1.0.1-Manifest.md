# FapiaoGO v1.0.1 Release Manifest（RELEASE-1 · RC v6）

- 发布日期：2026-09-11（RC v6）
- Release Source（冻结）：**`7cc4a53`**（版本号 1.0.0 → 1.0.1），基线 `149fff7`
  - 版本改动仅 2 行：`package.json:3` `"version"`、`frontend/src/config.js:6` `APP_VERSION`
  - 前端三处版本显示（侧栏 `sb-brand-badge`、关于框 `tb-about-version`、更新弹窗 `tb-update-version`）**共用 `APP_VERSION` 单一来源**，改一处即全局同步
  - 后端零改动 → `backend/dist`（server.exe + pdf_tool）**完全复用 RC-v5 产物**，未重建
- 体积：win-unpacked **650MB**（与 RC-v5 持平；SIZE-2 优化已固化：locales 2 pak / LICENSES+dxcompiler+dxil 已删）

## 交付物（release_final_v6/，两件套）

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `FapiaoGO-Setup-1.0.1.exe`（安装程序，未签名） | 234.1 MB / 245,433,568 B | `ab7c12478f25ae88e24e10c2259413efc16902ebf04ed637718448db69905a71` |
| `FapiaoGO-v1.0.1-Windows-x64-Portable.zip` | 300.3 MB / 314,857,104 B | `8da3be6cc40b0c7b737d85a9a0a3cf16eda499df58f0676e661b84fb04723d85` |

（机器可读：`outputs/SHA256SUMS-v1.0.1.txt`、`release_final_v6/_asset_verify.json`；Release 附件还需 `latest.yml`）

## Gate 状态

| Gate | 内容 | 状态 |
|---|---|---|
| R0 | Source Freeze：`7cc4a53`，工作区干净 | ✅ PASS |
| R1 | Clean Build：前端 vite 重建 8.39s（`node vite.js build` 绕沙箱 shim），**dist 内已实证 `1.0.1`** | ✅ PASS |
| R2 | 后端 dist 复用 RC-v5（后端零改动，无需重建） | ✅ PASS（N/A） |
| R3 | electron-builder `--win nsis dir`，afterPack 钩子实测执行（-46.2MB），耗时 1m37s | ✅ PASS |
| R4 | 结构审计：650MB / locales 仅 2 个 / P1 三目标已删 / GPU 栈保留 / **asar 内 config chunk 含 `1.0.1`、旧 `1.0.0` 已消失** | ✅ PASS |
| R5 | Runtime Smoke：server `/health`=ok；**PDF margin success:true**；**图片 png→pdf success:true**（numpy 排除后关键链路） | ✅ PASS |
| R6 | Portable.zip 压缩 301MB（528 条目） | ✅ PASS |
| R7 | SHA-256 + latest.yml（version 1.0.1，size 245433568 与 Setup 精确匹配，sha512 实测一致） | ✅ PASS |
| R8 | 归档 release_final_v6/（Setup + Portable + latest.yml + builder-debug.yml） | ✅ PASS |
| R9 | Release Freeze（tag `v1.0.1` + GitHub Release 上传 3 件） | ⏳ 待真机 |

## 产物完整性实证（机器可读：`release_final_v6/_asset_verify.json`）

| 校验项 | 预期 | 实测 |
|---|---|---|
| Setup.exe SHA-256 | `ab7c1247…05a71` | ✅ 匹配 |
| Portable.zip SHA-256 | `8da3be6c…23d85` | ✅ 匹配 |
| Portable.zip CRC 全量解压 | `testzip()` 返回 `None` | ✅ PASS（528 条目，0 损坏） |
| latest.yml `size` vs Setup 字节数 | 245,433,568 | ✅ 匹配 |
| latest.yml `sha512`(base64) vs 实测 | `VnMG6udA…lCjw==` | ✅ 匹配 |
| latest.yml `version` | 1.0.1 | ✅ |
| **Setup.exe NSIS 结构自洽** | `fh_offset + lofd == file_size` | ✅ **delta = 0**（`427008 + 245006560`，`NullsoftInst`） |

## 构建期环境问题（本次踩坑，已解决）

打包一度失败于 `No JSON content found in output`。逐层排除后定位：

1. 不是 npm.ps1 的 `$LASTEXITCODE` 问题（虽真实存在，已顺手加默认值保护）
2. **真因：沙箱内 `powershell.exe` 的 stdout 管道被拦截**。electron-builder 在 Windows 上用 `powershell.exe -EncodedCommand` 包裹 `npm list` 收集依赖树，实测 4 种调用变体（含直接 `node npm-cli.js`）**stdout 一律 0 字节**；改用 `shell:true` 直接 spawn 则可正常拿到 1439B JSON。
3. 处置：调整 `app-builder-lib/out/node-module-collector/nodeModulesCollector.js`，win32 下改为 shell 模式直调包管理器（仅影响沙箱内构建，收集结果等价）。
   - ⚠️ 该改动位于 `node_modules/`（未入库），`npm install` 会被覆盖；若在本机直接打包则无需此改（本机 PowerShell 未被拦截）。

## 真机验收清单

1. **版本号显示**（本次改动点，必测）：侧栏徽标显示 `V1.0.1`；「关于」弹窗显示 `版本 V1.0.1`；检查更新弹窗显示 `当前版本 V1.0.1`。
2. 绿色版：解压 Portable.zip → 双击 FapiaoGO.exe → 无黑窗、DevTools 不可呼出；首启创建 `database/` 与 `userdata/`。
3. 安装版：运行 Setup → 安装 → 卸载时 **database/userdata 不被删除**。
4. 首次导入自动预览；打印链（含横向纸 + margin）；**图片类文件边距打印**（png→pdf，沙箱已冒烟 success，真机再确认视觉效果）。
5. 自动更新：已装 v1.0.0 的机器应能检测到 1.0.1（依赖 Release 同传 `latest.yml`）。

## 备注

- 🔴 **R4-C 代码签名未做**：Setup / FapiaoGO.exe / server.exe / pdf_tool.exe 均 NOT SIGNED（SumatraPDF.exe 保留上游签名）→ SmartScreen 会警告，需在发布说明中写明。
- `latest.yml` 的 `url` 是相对路径，必须与 Setup.exe 在**同一 Release**下，否则自动更新下载+校验双失败。
- 旧 `release_final_v2~v5` 产物作废。
