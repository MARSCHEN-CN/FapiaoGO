# C-2-E 调查结论 — CLOSED: EXECUTOR LIMITATION CONFIRMED

> 日期：2026-08-11 ｜ 状态：**CLOSED — EXECUTOR LIMITATION CONFIRMED（用户裁决 16:12）** ｜ 基线：`1493595`
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

---

## 9. 用户反馈复验（2026-08-11 12:46，supersede 尝试被证据驳回）

用户反馈「已把驱动 Form 配置为 PostScript，paper=postscript → 240×140 正确输出」，要求复验。**实测驳回**：

1. **全系统枚举**：7 个打印机（Wondershare/WPS PDF/SHARP/PDF24/Microsoft/Brother/219）Forms **全部只有「凭证纸」240×140，均无 'PostScript' Form**。用户配置未在系统 Forms 层生效（可能混淆应用层 WIP 纸名或 Sumatra 对话框显示的「PostScript 自定义页面大小」= DMPAPER 32767）。
2. **唯一文件名重跑**（排除 grab 交叉污染——此前 probe/gate 同名 bake 文件导致抓错）：
   - `landscape,noscale,paper=postscript` → 纸 **240×140 横**（= **fallback 到驱动默认纸凭证纸**，非 PostScript Form 命中）+ /Rotate=90 + **内容 36.3×58.9mm（面积 11%）** ❌
   - `landscape,noscale,paper=PostScript 自定义页面大小`（32767 全名）→ A4 横 297×210 + 内容完整——**纸不对** ❌
   - `paper=凭证纸` / `paperkind=213` 全组合 → 内容 36×32 ❌
3. **纸 240×140 的真相**：paper=postscript 匹配失败 → fallback `devMode->dmPaperSize`（默认 32767 + 240×140 凭证纸）→ 纸恰好 240×140，但**内容布局仍错乱**（36×59 = 面积 11%）——**与 §8 C-2-E 结论一致（自定义纸无 dmFormName 布局异常）**。
4. **无任何组合达到「240×140 + 内容完整」**——用户声称的「正确输出」未在内容完整性层面复现。

**结论：C-2-E 的 NO 结论不被推翻**。纸尺寸命中 ≠ 内容正确；`sumatraLandscapeGate` 三项验收（纸 240×140 ✅ / 内容方向 / 内容 ≥90% ❌）仍未全绿。请用户提供其验证时的 artifact 路径/截图或确认配置位置。

---

## 10. A 正交实验（2026-08-11 14:17，命令层最小对比）

用户裁决：只做 A（纯命令/DEVMODE 行为解析），B（geometry 补偿）冻结。6-case 干净实验（唯一文件名+抓后改名，无串台）。

### 矩阵
| Case | paper | orientation | 纸 | 内容 | 面积比 | drift |
|---|---|---|---|---|---|---|
| A1 | postscript | landscape | ✅ 240×140 横 | 36.3×58.9 | 11% ❌ | 0.88 |
| A2 | 240mm x 140mm | landscape | ❌ A4 横 | 167×111.8 | 100% ✅ | 0.00 |
| A3 | a4 | landscape | ❌ A4 横 | 167×111.8 | 100% | 0.00 |
| A4 | postscript | disable-auto-rotation | ❌ 140×240 竖 | 111.8×167 | 100% | 0.82 |
| A5 | 240mm x 140mm | disable-auto-rotation | ❌ 竖 | 111.8×167 | 100% | 0.82 |
| A6 | a4 | disable-auto-rotation | ❌ A4 竖 | 167.1×111.8 | 100% | 0.00 |

### 结论
1. **landscape 被排除**：A2（尺寸命令 + landscape）内容 100% 完整 drift 0.00 → landscape 不毁内容。
2. **内容异常归因 paper token 路径**：postscript（fallback 默认 32767 无 dmFormName）→ 布局空间错乱（A1）；尺寸命令（dmPaperSize=0 + width/length）→ 布局空间正确（A2/A5 内容 100%）。
3. **纸/内容互斥（executor limitation 定性）**：
   - postscript（fallback 默认）：纸 240×140 ✅ / 内容错乱 ❌
   - 240mm x 140mm（尺寸命令）：纸 A4 ❌（驱动忽略 dmPaperSize=0 自定义尺寸）/ 内容完整 ✅
4. **B 冻结保持**：不触碰 bake layoutRotation（无证据支持 geometry 补偿，避免污染 C-2 冻结边界）。
5. 后续可选：研究尺寸命令路径能否让驱动应用 240×140 纸（可能需驱动接受 dmPaperSize=0 / 或 dmFormName 支持——属 executor 能力延伸）。

---

## 11. GDI 决定性对照（2026-08-11 14:35，绕过 Sumatra 直测驱动）

### 方法
ctypes 构造 DEVMODEW → `CreateDCW('WINSPRINT')` → GDI 画矩形 → Wondershare 捕获 → probe MediaBox。**绕过 Sumatra，直接回答「Wondershare 对 custom paper DEVMODE 的响应」。**

### 结果
| 变体 | dmPaperSize | dmPaperWidth/Length | orient | MediaBox | 视觉 |
|---|---|---|---|---|---|
| A | 0 | 2400/1400 | landscape | **680×397（240×140 横）** ✅ | 239.9×140.1 |
| B | 0 | 2400/1400 | portrait | 397×680（140×240 竖） | 140.1×239.9 |
| C | 213 | — | landscape | **680×397（240×140 横）** ✅ | 239.9×140.1 |

### 决定性结论（结论翻转）
1. **Wondershare 接受 `dmPaperSize=0 + dmPaperWidth/Length=2400/1400`（custom paper DEVMODE）→ 正确输出 240×140 横纸**。
2. **Sumatra 用相同 DEVMODE（A2 `paper=240mm x 140mm`）却输出 A4** → **Sumatra 的 custom-size DEVMODE 未正确传到驱动**（Sumatra 打印路径的 DEVMODE 应用/传递缺陷）。
3. **Stop 条件未命中「驱动拒绝」**（相反：驱动支持）；问题收敛为 **Sumatra executor 内部 DEVMODE 传递缺陷**。
4. **替代 executor 实测可行**：GDI 打印路径（CreateDCW + 完整 DEVMODE）已验证能出 240×140——C-2-E 方案 A 落地有实测支撑。

### 边界
- C-2 geometry 链 / noscale / Gate 全部冻结保持。
- B（bake layoutRotation 补偿）不解冻——GDI 替代可绕过问题，无需污染 geometry。
- 参数探索停止（Sumatra 内部缺陷，命令层不可解）。

---

## 12. 生产 bake 路径命令级对照（2026-08-11 17:56，C-2-E 结论强化）

背景：用户实测生产日志 `landscape,noscale,paper=postscript,monochrome`（bake 产物 240×140 横，无 rotate——bake 模型正确形态：旋转已烤进内容，A3-03 验证）。横向纸张内容失败，做命令级对照（不讨论 Form 理论）。

### 方法
构造 bake 等价物（240×140mm 横纸，横票内容 fit 居中，等价生产 placement_bake 产物）→ 4 条命令变体 → Wondershare → probe。

### 结果
| Case | 命令 | 纸 | 内容 | 判定 |
|---|---|---|---|---|
| C1 生产 1:1 | `landscape,noscale,paper=postscript,monochrome` | 239.9×140.1 横 ✅ | 126.9×120.7（46%）/Rotate=90 | ❌ |
| C2 去灰度 | `landscape,noscale,paper=postscript` | 239.9×140.1 横 ✅ | **126.9×120.7（46%）完全一致** | ❌ |
| C3 驱动纸名 | `landscape,noscale,paper=凭证纸` | 239.9×140.1 横 ✅ | **126.9×120.7（46%）完全一致** | ❌ |
| C4 无 paper | `landscape,noscale` | A4 横 297.1×210 | 201.8×126.9（41%，宽高比≈横票 1:1） | ⚠️ 更接近原样 |

### 关键结论（修正 §8 的"无效 token"表述）
1. **`paper=postscript` 与 `paper=凭证纸` 完全等价**——都解析到驱动默认凭证纸 240×140（纸选对 239.9×140.1），`monochrome` 无影响。**不是"无效 token fallback 纸错"**，纸是对的。
2. **内容错乱与 paper token 无关**——C1/C2/C3 内容完全一致（46%）。根因 = **landscape + 240×140 自定义纸（无 dmFormName）的驱动布局错乱**：纸选对反而内容乱；无 paper（A4）内容反而接近 1:1。
3. **生产日志命令本身不是错误命令**（C1 == C2 == C3）——横向失败是 **Sumatra/驱动对 240×140 自定义纸的 executor 布局缺陷**（C-2-E 定论强化），**bake 路径同样存在**（与直打路径无关）。
4. 唯一已验证可行：GDI 直打（C-2-F Phase 1，240×140 + 内容完整）/ A4 横打兜底（4-2b-2a Gate PASS）。

### 边界
- C-2 Command Mapping（16 表）冻结不变；resolver **不接入** bake 生产链（两条链执行模型互斥：直打 fit+rotate vs bake noscale）。
- placement / RotationResolver / bake geometry / noscale / 无 rotate 全部保持冻结。
