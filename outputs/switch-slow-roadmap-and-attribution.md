# Preview Switch 优化：路线锁定 + Phase 2 归因门槛

日期：2026-09-11 · 分支 `rotation-b1-hardening` · **生产逻辑零变更**
状态：**⏹ 已终结（用户决定打包新版本）** —— 313ms Attribution Gate 未完成，主动终止

---

## 1. 已达成的共识边界

| 场景 | 当前 | 合理目标 | 剩余空间 |
|---|---:|---:|---|
| 已命中浏览器缓存 | 6–8 ms | ~6–8 ms | **≈0** |
| 矢量 PDF，首次切换 | 500–750 ms | ~150–300 ms | **约 40–70%** |
| 矢量 PDF，313 ms 档 | 313 ms | ~10 ms | **归因待定**（Phase 2 Gate §3：Proxy / Queue / TTFB / Download 四分支未定性） |
| 扫描件 | 1.19 s | ~0.61 s | **约 1.9×** |
| 高拍仪 | 2.62 s | ~0.85 s | **约 3.1×** |
| 12MP 照片 | 6.81 s | ~0.96 s | **约 7.1×** |
| 16MP 照片 | 27.7 s | ~0.96 s | **约 29×** |

### 路线划分

```text
Phase 1  已完成
├─ R3：重复渲染 2 → 1            ✅ MISS 2→1，ETag/执行路径均已证实
├─ R2：前后台竞争实测 +113%       ✅
└─ R7 等旧结论修正               ✅ RenderCache 挤压已证伪

Phase 2  ⛔ 313ms Constant-Latency Attribution Gate（归因门槛，非实现阶段）
   ├─ 先证明 313ms 属于 Proxy / Queue / TTFB / Download
   ├─ 归因未出 ⇒ 不写任何 QoS 代码
   └─ 归属 Proxy ⇒ 降级为「启动配置级修复」；归属 Queue ⇒ 才进 QoS 实现

Phase 3  R1 图片输出上限
├─ 扫描件 / 高拍仪 / 12MP / 16MP
└─ 收益 1.9× ~ 29×，已由「预期」转为「实测」

Phase 4  收尾验收
├─ 已命中 ≤10 ms
├─ 矢量首次 ≤300 ms
└─ 图片 ≈1 s
```

**超出 Phase 4 之后**（编码格式、浏览器 decode、`<img>` 生命周期、纹理上传、HTTP 传输层）
为几十~几百毫秒的收益，收益/风险比明显下降，**不再投入**。

### 结构性成果（比 29× 更重要）

问题已按三个维度分离，**后续不会再出现「看起来快了，实际痛点没变」**：

```
① 矢量 / 位图      —— R1 只对位图有效；矢量误用位图公式会退化到 0.41×
② CPU / 排队 / decode —— 96% 在资源获取(T1→T4)；decode 5~12ms、上屏 0~26ms
③ 首次 / warm cache —— 后端 warm 时 0 渲染；313ms 只在「第 2 次访问」档
```

---

## 2. Phase 3 的顺序建议（与默认路线的一处偏差）

若你的 200+ 发票**含**拍照/扫描件，**R1 应优先于 QoS**：

| 项 | 收益量级 | 确定性 |
|---|---|---|
| R1（图片） | **6.8s → 0.96s**（29×，16MP） | 已实测（交叉验证 0.0% 误差） |
| QoS（矢量 313ms） | 313ms → ~10ms | **归因未证实**（见 §3） |

差两个数量级。Phase 2 的归因实验只需 5 分钟且零改动，**先跑归因，再决定谁先**。

---

## 3. ⛔ Phase 2 = 313 ms Constant-Latency Attribution Gate

**Phase 2 的入口不是「实现 QoS」，而是一道归因门槛。**
在归因出结果之前，**不写任何 Phase 2 生产代码**，也不据此设计 QoS 架构。

理由是下方决策树的四个分支，解法成本相差两个数量级：

```text
                     313 ms 恒定延迟
                            │
   ┌────────────┬───────────┴────────────┬──────────────┐
   │            │                        │              │
Timing:      Timing:                 Timing:        Timing:
Proxy        Stalled/Queueing        Waiting/TTFB   Content Download
negotiation
   │            │                        │              │
   H2           H1                       H3             H4
代理路径      真正的资源竞争          后端请求路径      传输/连接层
   │            │                        │              │
Electron/      QoS 隔离              重追 Flask/      查代理、
Chromium       （架构改动）          render/cache     连接复用、
loopback                                              协议路径
bypass
（一行配置）
```

| 分支 | 真因 | 解法 | 成本 |
|---|---|---|---|
| **H2** | 代理协商 / PAC 求值 | loopback bypass，一行配置 | **极低** |
| **H1** | 连接池排队（预取占满 6 连接） | QoS 隔离 / 优先级队列 | **架构改动** |
| **H3** | disk cache `must-revalidate` I/O | 缓存策略调整 | 中等 |
| **H4** | 传输 / 连接复用 / 协议路径 | 查代理与连接复用 | 中等 |

**⇒ 归因错了，Phase 2 会做一件成本差几十倍的事。**
典型误判形态：把一个尚未证明是 Queue 的 313ms，直接拿去设计一套 QoS 架构。

### 3.1 为什么怀疑不是排队

| 线索 | 内容 |
|---|---|
| ① 数值恒定 | `313.3 / 313.7 / 313.9`，极差 **0.6 ms**，且分布在第 5、7、14 次切换（时间点完全不同）。排队耗时应随后台任务剩余时间波动，不该恒定 |
| ② 环境有代理 | `_switch_bench_http.py:61` 原注释：「沙箱/**公司环境有 HTTP 代理，会拦截 127.0.0.1 请求** → 强制直连」 |
| ③ Electron 未配代理 | `electron/main.js`、`preload.js` 全文无 `proxy` / `setProxy` 配置 ⇒ **继承系统代理** |

⇒ 若每次 `/preview/` 都要跑一次代理协商（或 PAC 脚本求值），会产生**固定常数级**开销，且完全符合 313ms 的特征。

### 3.2 为什么优先怀疑 H2（而非排队）

三条线索**一致指向代理协商**，且与「排队」的行为特征相冲突：

- 排队耗时应**随后台任务剩余时间波动**；313ms 却在不同负载、不同时间点保持 **极差 0.6ms** 的常数
- 代理协商 / PAC 求值天然是**固定常数级**开销
- 环境侧证实存在代理拦截 loopback 的先例（`_switch_bench_http.py:61`）

⚠️ 这只是**先验排序**，不是结论 —— 定性仍以 §3.3 的 Timing 面板为准。

### 3.3 归因步骤（零改动，5 分钟）

DevTools → Network，**勾上 Preserve log**，切一张发票制造 313ms 档，点开 `/preview/` 请求 → **Timing** 面板：

| Timing 字段 | 若这里 ≈313ms | 结论 |
|---|---|---|
| **Proxy negotiation** | ✅ | → **H2**，一行参数解决，QoS 不必做 |
| Stalled | ✅ | → H1，确认 QoS 隔离路线 |
| Queueing | ✅ | → H1 |
| Waiting (TTFB) | ✅ | → 后端，但已实测 2~3ms，**基本可排除** |
| Content Download | ✅ | → 传输；矢量产物仅 56KB，**可排除** |

> 提示：若 Timing 面板没有 Proxy negotiation 项，说明该请求未走代理 ⇒ H2 不成立。

### 3.4 H2 确认后的候选解法

⚠️ **先纠正一个易错点**：Chromium **默认已 bypass loopback**。
`--proxy-bypass-list=<-loopback>` 的 `<-loopback>` 是**反转**语义——让 loopback **走代理**，
与我们想要的效果相反，**切勿误用**。

所以若归因显示确有 Proxy negotiation，说明环境里有强制配置（PAC 脚本 / 组策略）覆盖了默认 bypass，
候选手段如下，**具体选哪个要等归因结果确认**：

| 手段 | 说明 | 副作用 |
|---|---|---|
| `--no-proxy-server` | 完全禁用代理，验证用最直接 | 影响联网功能（更新等） |
| `session.defaultSession.setProxy({ mode: 'direct' })` | 代码层等价手段 | 同上 |
| 显式补全 bypass 规则（保留 loopback） | 精准，需先查清当前覆盖来源 | 无 |

> 以上均为**候选**，尚未实施，也未验证。§3.3 的归因结果出来前不要落地任何一项。

### 3.5 交叉验证：Timing 阶段 + Prefetch ON/OFF **两者缺一不可**

第一实验只看 DevTools Timing —— 捕获到一个典型 ~313ms 样本即可定性。
若 Timing 能把这 313ms 定位到某个阶段，其证据强度已经超过目前所有「推测是排队」的间接证据。

第二实验用已落地的开关反证 —— DevTools **单行**：

```text
localStorage.setItem('fapiao.perf.disableFrontendPrefetch','1')
```

再测同一序列：313ms 档**消失** ⇒ 指向 H1；**仍在** ⇒ 与预取无关，转向 H2/H3/H4。

> ⚠️ **判定纪律**
> 「关预取后 313ms 消失」只能证明**预取与这 313ms 存在因果关系**，
> **不能直接证明它就是 Queueing**（也可能是预取请求触发了额外的代理协商次数）。
>
> 最终定性必须以 **Timing 阶段 + Prefetch ON/OFF 交叉**为准，不能以单一开关的结果下结论。

### 3.6 🔴 红线：不要为了验证 H2 而先改变生产网络行为

在 §3.3 的 DevTools Timing 归因出结果之前：

- **不要**改 Electron 启动参数
- **不要**改 `session.setProxy`
- **不要**动系统代理 / PAC

原因：Chromium **默认已 bypass loopback**，若环境里确有某处强制覆盖（PAC / 组策略），
必须先查清**覆盖来源**再选手段，而不是先改 HOST 行为试错——后者会把实验污染成生产事故。

同理，`--proxy-bypass-list=<-loopback>` 是**反转**语义（让 loopback **走**代理），
与 H2 的修复目标正好相反，**任何情况下都不要直接拿来当修复方案**。

---

## 4. 待办（按收益确定性排序）

**已证实 / 可直接排期**

- [ ] **R1 图片输出上限** —— 仅当发票清单含拍照/扫描件才有意义；收益 1.9× ~ 29×，已实测
- [ ] R1 契约冻结草案（不含代码改动）—— Pattern 见
      `outputs/switch-slow-optimization-ceiling.md` §3.1

**待证实 / 阻塞中**

- [ ] 🔴 **313ms Attribution Gate**（§3）—— 阻塞 QoS 隔离的**全部**后续工作
- [ ] 确认发票构成（是否含拍照/扫描件）—— 决定 R1 与 QoS 的先后

**已剥离**

- [ ] R7 registry 句柄治理 —— 与「切换慢」无证据关联，单独立项
- [ ] `immutable` 缓存 —— 已否决（`api.py:100-103` 注释：URL 不含 isLandscape）
- [ ] dimensions cache —— 只能省 T5→T6 的 0~26ms，非主矛盾

---

## 5. 终态：已终结（2026-09-11 14:5x，用户决定打包新版本）

**本条优化线到此终结，不再推进。** 313ms Attribution Gate **未完成**，属**主动终止**而非解决。

| 类别 | 项 | 状态 |
|---|---|---|
| 已证实 | R1 位图输出上限 1.9×~29× | ✅ 收益由预期转实测（交叉验证 0.0% 误差）—— **未实施** |
| 已证实 | 浏览器 warm cache 6–8ms | ✅ 无值得动的空间 |
| 已证实 | 后端 RenderCache 非瓶颈 | ✅ 证伪 + 304 实测 2~3ms |
| 已证实 | R3 双渲染 CPU 2→1 | ✅ —— **未正式实施**（仅实验开关） |
| 已证实 | R2 前后台竞争 +113% | ✅（≠313ms 成因）—— **未实施** |
| **未决** | **313ms 恒定延迟成因** | ⏹ **主动终止，归因未完成** |

### 终结时的实际代码状态

**生产逻辑零变更**，仅新增「默认 OFF 的观测/实验设施」：

| 文件 | 性质 | 默认行为 |
|---|---|---|
| `frontend/src/utils/perfExperimentFlags.js` | 新增 | 全 OFF，无行为变化 |
| `frontend/src/utils/previewSwitchTrace.js` | 新增 | 全 OFF，mark* 为 no-op |
| `frontend/src/components/ViewerViewport.jsx` | 3 处埋点 | 同上 |
| `frontend/src/App.jsx` | 2 处门控/透传 | 同上 |
| `frontend/src/hooks/usePreview.js` | RE probe 门控 | 同上 |
| `backend/render_engine/api.py` | `RE_PREFETCH_ENABLED` / `RE_TIMING_ALLOW_ORIGIN` | 均默认原行为 |

⚠️ **打包决策**（留给打包人）：以上代码**会随包发布**。全部默认 OFF，功能上零风险；
若要求发布包纯净，可剔除这 3 个 commit（`5280fa4` / `e4e56f9` / `46c3f23`），
剔除后行为与诊断开始前**完全一致**——但后续任何真机取证都要重新植入探针。

### 若日后重启本线

唯一入口是 §3.3 的 DevTools Timing 归因（零改动，5 分钟）。
在此之前不要设计 QoS 架构，也不要改网络行为。

---

## 6. 相关产物

| 内容 | 路径 |
|---|---|
| 优化上限评估 | `outputs/switch-slow-optimization-ceiling.md` |
| R1 收益实测脚本 | `outputs/perf-runs/switch-slow/_phase3_r1_gain_bench.py` |
| Phase 1 双管线/竞争实测 | `outputs/perf-runs/switch-slow/_phase1_verify.py` |
| 304 归属排除法 | `outputs/perf-runs/switch-slow/_phase2_304_bench.py` |
| Phase 2 分层测量手册 | `outputs/switch-slow-phase2-measurement.md` |
| Phase 2 首轮真机判读 | `outputs/switch-slow-phase2-round1-findings.md` |
