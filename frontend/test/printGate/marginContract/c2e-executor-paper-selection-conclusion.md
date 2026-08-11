# C-2-E 调查结论 — Sumatra 无法可靠选择自定义 Form（确定性定位）

> 日期：2026-08-11 ｜ 状态：**CLOSED（NO，确定性）** ｜ 基线：`2b6ec10`
> 结论一句话：**Sumatra 从不为自定义纸设置 `dmFormName`，而 Windows 对非标准 DMPAPER ID 的 Form 选纸强制要求 `dmFormName`——凭证纸（DMPAPER 213）因此无法被 Sumatra 可靠选中。这是 Sumatra 的确定性 executor 缺陷。**

## 1. 调查方法

① **Sumatra 源码**（GitHub master `src/Print.cpp`，WebFetch 原文分析）→ ② **本机 API 实测**（pywin32 EnumForms + winspool DeviceCapabilitiesW，隔离 venv）。

## 2. Sumatra DEVMODE 构造逻辑（源码引用，`Print.cpp`）

```cpp
// paper= 参数三分支：
// ① paper=<标准名> → dmPaperSize = GetPaperByName(...)   // 只返回 short ID
// ② paper=<w>mm x <h>mm → SetCustomPaperSize：dmPaperSize=0 + dmPaperWidth/Length
// ③ paper=<数字> → dmPaperSize = 数字

static void SetCustomPaperSize(Printer* printer, SizeF size) {
    devMode->dmPaperSize = 0;
    devMode->dmPaperWidth = (short)size.dx;    // 十分之一毫米
    devMode->dmPaperLength = (short)size.dy;
    devMode->dmFields |= DM_PAPERSIZE | DM_PAPERWIDTH | DM_PAPERLENGTH;
    // ⚠️ 不设置 dmFormName
}

// GetPaperByName：遍历 DeviceCapabilitiesW(DC_PAPERNAMES) 列表匹配，找不到 fallback 默认
// paperkind=<n> → dmPaperSize = n（含 32767=DMPAPER_USER），不设 dmFormName
```

**关键事实（源码确认）**：
- 纸名枚举 = `DeviceCapabilitiesW(DC_PAPERS / DC_PAPERNAMES / DC_PAPERSIZE)`（驱动标准纸列表）
- **整个代码库从不设置 `devMode->dmFormName`**

## 3. 本机实测（Wondershare PDFelement 驱动）

### 3.1 EnumForms（213 个 Form）
- 无 'PostScript' 纸；唯一 240×140 = **「凭证纸」**
- 默认 DEVMODE：`dmPaperSize=32767` + `dmPaperWidth=2400/dmPaperLength=1400`（驱动默认即凭证纸）

### 3.2 DeviceCapabilities DC_PAPERNAMES（71 个驱动标准纸）

| 纸名 | DMPAPER ID | 类型 |
|---|---|---|
| A4 | 9 | Windows 标准常量 |
| **凭证纸** | **213** | 驱动自定义 ID（非 Windows 标准） |
| **PostScript 自定义页面大小** | **32767** | DMPAPER_USER |

## 4. 确定性归因

**Windows 选纸机制**：`dmPaperSize` 为标准 DMPAPER 常量（如 A4=9）时，系统/驱动可直接解析尺寸；**非标准 ID（凭证纸=213、DMPAPER_USER=32767）必须同时提供 `dmFormName`（Form 名）**才能解析到正确 Form 尺寸。

**Sumatra 行为**：`paper=凭证纸` → GetPaperByName 匹配到 DC_PAPERNAMES 里的凭证纸 → 返回 213 → 设 `dmPaperSize=213` **但无 `dmFormName`** → 系统无法将 213 解析为「凭证纸」Form → 驱动 fallback（布局错乱/缩放/转置）。

**这解释了全部实验的对称性**：
| paper= | dmPaperSize | dmFormName | 结果 |
|---|---|---|---|
| a4 | 9（标准） | —（不需要） | ✅ 内容完整 |
| 凭证纸 | 213（自定义） | ❌ 缺失 | ❌ 布局错乱 |
| postscript | 匹配失败→fallback | — | ❌ |
| 240mm x 140mm | 0 + width/length | ❌ 缺失 | ❌ |
| paperkind=32767 | 32767（USER） | ❌ 缺失 | ❌ |
| （无 paper） | 默认 32767 | ❌ 缺失 | ❌ |

## 5. 决策树结论：**NO**

> **Sumatra 无法通过 `-print-settings` / DEVMODE 链可靠选择 Wondershare 自定义 Form「凭证纸」240×140。**

根因 = **Sumatra → GDI/driver custom-form interoperability 缺陷**（不设 dmFormName），非 C-2 geometry、非 noscale、非参数猜测。

## 6. 候选方案评估

| 方案 | 可行性 | 说明 |
|---|---|---|
| **A. 替代 executor（推荐）** | ✅ | 换支持 `dmFormName` 的打印路径（GDI StartDoc + DEVMODE 手工构造 / Ghostscript / 其他 PDF 打印工具），可完整控制 DEVMODE |
| B. 驱动注册标准纸 | ⚠️ 低 | 凭证纸已在 DC_PAPERS（ID 213）但 ID 非标准；需驱动将凭证纸映射到 Windows 标准常量——第三方驱动不可控 |
| C. Sumatra 升级 | ❌ | master 源码已确认不支持 dmFormName，升级无望 |
| D. 业务兜底 | ✅ 临时 | 凭证纸走 A4 横打（已验证 PASS，4-2b-2a + 本调查 M/N case） |

## 7. 验收状态

- `sumatraLandscapeGate`：**维持 EXPECTED FAIL**（凭证纸经 Sumatra 无正确输出路径）
- 替代 executor 方案落地后：Gate 转 PASS 即为验收

## 8. 边界声明

- **C-2 冻结不变**：geometry 链 / noscale / Gate 全部保持
- **PostScript WIP 保持未验证**：应用层改名 PostScript 与驱动「PostScript 自定义页面大小」（DMPAPER_USER 32767）语义不同，不可混用
- 本调查零生产代码改动；工具在 `.out`（gitignored）+ 隔离 venv（pywin32）
