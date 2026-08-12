# Rotation Semantic Audit — 横票 90° × 横纸侧躺根因（2026-08-12）

> 状态：**AUDIT 完成（只读，未改任何代码）** ｜ 用户裁决（12:32）：C-2-G 暂停冻结，查清前不选 A/B、不改 bake 几何/resolver/layoutRotation。

---

## 1. 触发

用户截图（`C:\Users\it01\Desktop\问题发票`）：横票 + 用户旋转 90° + 横纸 → **发票文字侧向（侧躺）**。业务验收标准（用户澄清）：**无论源票 rotation 0/90/180/270，最终打印都应正向可读**——侧躺 = 明确 FAIL。

## 2. 完整语义链（逐层读实）

```
源 PDF page.rotation = 0（fixture 25952000000127675627.pdf 实测 /Rotate=0）
    ↓
fileRotations[f.key] = 用户 UI 旋转输入（usePrint L881-888 → sourceRotation）
    ↓
resolveContentPlacement（RotationResolver）：
    先用 contentRotation 旋转内容尺寸（横票 210×140 + 90° → 有效竖 140×210）
    → effectiveContentOrientation = 竖 → 横纸 → layoutRotation 适配（-90/0）
    ↓
placement-bake-processor.buildBakeSpec：layoutRotation + placedRect 原样搬运
    ↓
placement_bake.py：layoutRotation 烤进 PDF 内容（L95-96：-90 = 内容横放竖纸逆时针 90）
    → MediaBox==paper /Rotate=0，内容已含旋转
    ↓
真实产物（temp）：横票90° → 680.3×396.9pt（240×140 横纸）内容 122.4×133.9mm（竖）
    ↓
main.js 注入 rotate=90（恒 90，抵消 Sumatra landscape 隐含 -90°）
    ↓
Sumatra landscape + rotate=90 + noscale
    ↓
最终视觉 = bake 内容方向 = 用户旋转后的方向 → 90° = 侧躺 ❌（截图证实）
```

## 3. 最终视觉公式

```
最终视觉方向 = contentRotation（用户，烤进 bake）
             + layoutRotation（纸向适配，非消除）
             + Sumatra rotate（恒 90，抵消 landscape 隐含 -90°）
             = 用户旋转后的内容方向
```

**Sumatra rotate + 隐含旋转互相抵消（净 0°），layoutRotation 只是适配不消除用户旋转 → 最终视觉 = 用户旋转方向。** 用户旋转 90° → 侧躺；180° → 倒置；270° → 倒立侧躺。**用户旋转 0° 是唯一正确 case**（与 C-2-G 之前验证一致）。

## 4. 语义错位点（根因）

**用户"rotation"输入被生产当成"内容旋转意图"烤进 bake，但其业务语义是"校正源票方向使最终正向可读"。**

| 层 | 16 表（直打模型，golden） | 生产 bake 链 |
|---|---|---|
| rotation 语义 | **源 PDF page.rotation**（测试不同源票状态，rotate 命令补偿使其正向） | **用户 UI 旋转输入**（fileRotations） |
| 旋转作用点 | Sumatra rotate（命令层，不烤进内容） | **bake 烤进内容**（layoutRotation + placedRect） |
| 最终视觉 | 命令补偿 → 正向 | 内容已旋转 → **侧躺** |

**两个错位**：
1. **输入语义**：16 表的 rotation=源 PDF 状态；生产 sourceRotation=用户 UI 输入——同一字段名，不同语义。
2. **作用层**：16 表 rotate 在命令层（可补偿）；bake 把用户旋转烤进内容（不可补偿——Sumatra 恒 90 只抵消隐含旋转）。

## 5. 对照 16 表（为什么 16 表"正确"但生产侧躺）

16 表直打模型：源 PDF 直打（用户旋转**不烤进**）→ Sumatra `rotate=N` 施加在源 PDF 上 → 命令层补偿 → 最终由命令决定。**用户实测 16 表时 rotation 是源 PDF 状态变量**（不同旋转的源票），命令 rotate=90/270 是其补偿值 → 全正向。

生产 bake 模型：用户旋转**烤进 bake 内容** → 命令恒 90 只能抵消隐含旋转 → 最终 = 烤进方向。**两模型对"用户旋转"的处理位置不同，导致相同输入不同视觉。**

## 6. 修复选项（audit 后，待用户裁决）

- **A. bake 不烤进用户旋转**（layoutRotation 恒 0 或按"消除"语义烤进反向）→ 用户旋转只在命令层补偿（rotate = f(用户旋转)）——**解冻 bake 几何**
- **B. 命令层动态 rotate**：`rotate = f(用户旋转, 纸向)` 使最终正向（bake 保持烤进）——**改 main.js 注入逻辑**
- **C. 语义重定义**：用户 rotation 输入 = "最终方向偏好"（不是校正）——**需产品确认**

⚠️ A/B 都触碰此前冻结层（bake / command）；C 是产品层。**查清前不实施。**

## 7. 验收 Oracle（audit 后 Gate 需含）

1. 纸方向正确
2. 内容方向：**最终视觉正向可读**（非"相对 bake 模板匹配"——P2 的 IoU 0.719 是相对侧躺模板的伪正向）
3. 内容完整无裁切（面积比 vs 期望）
4. 等比 fit（宽高比 drift ≤3%）
