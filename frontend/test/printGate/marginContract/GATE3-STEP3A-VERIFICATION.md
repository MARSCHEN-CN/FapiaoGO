# Gate 复验 — Phase 1-B Step 3-A（2026-08-10）

> 纯验证 commit：**不改任何生产代码**。目的：固化 `c7e25fd → 7330323` 迁移的正确性证据。
> 契约：`docs/print_margin_contract.md` v1.1 (FROZEN)

## Baseline Hashes（固化）

| 里程碑 | commit | hash |
|---|---|---|
| legacy archive（迁移前旧实现入库） | `c7e25fd` | `c7e25fd96fda3aa61f1405a99e55926f61f806bf` |
| Phase 1-B Step 2（compatibility shell） | `7330323` | `7330323e049d1781982bfe36bd2f38838256efa5` |
| 本次复验时 HEAD | = 7330323 | 同上 |

production RED 基线在 runGate.mjs 中以 `LEGACY_COMMIT = 'c7e25fd'` 硬编码，
`git show c7e25fd:scripts/add-pdf-margins.py` 提取快照 —— 旧行为基线永久可复现，
不随工作区漂移。

## 三连复验结果（2026-08-10 16:03）

| target | 被测对象 | 结果 | 判据 |
|---|---|---|---|
| production | c7e25fd 快照（旧实现） | **PASS=1 FAIL=7** | 7 RED @ INV_1_MEDIABOX，V-05 唯一 PASS |
| phase1b | 工作区兼容壳 → margin_contract | **PASS=9 FAIL=0** | 9/9 GREEN（含 V-04 rot90 --force-pending） |
| correct | makeFixture 已知正确输出 | **PASS=8** | 基础设施自检 GREEN |

production 7 RED 与 phase1b 9 GREEN 并存 ⇒ 迁移差异证明成立：
**旧实现仍然错误（expand_box 撑大 MediaBox），新实现正确（contain-fit + INV-1）**。

## 配套验证

| 项 | 结果 |
|---|---|
| INV-4 环境一致性（pdf-adapter / img2pdf / PIL-fallback 三路） | PASS，全字段 Δ=0.0000pt |
| 纯几何回归（9 向量 expected） | ALL OK（0.01pt 容差） |
| B1 `grep -rn expand_box scripts/` | 0 matches |
| B2 关键词（shell 内 min(/scale =/translate =/mediabox =） | 0 matches（Step 3-B guard 固化） |

## 复现命令

```bash
cd frontend/test/printGate/marginContract
node runGate.mjs --target production                # c7e25fd 快照 → 7 RED
node runGate.mjs --target phase1b --force-pending   # 兼容壳 → 9 GREEN
node runGate.mjs --target correct                   # 自检 → 8 GREEN
cd ../../..
python scripts/verify_inv4_env_consistency.py       # INV-4 → PASS
python scripts/verify_executor_geometry.py          # 纯几何 → ALL OK
```

## 冻结状态

```
Phase 0.5 archive      ✅
Phase 1-A executor     ✅
Phase 1-B Step 2       ✅
Phase 1-B Step 3-A     ✅（本 commit）
Phase 1-B Step 3-B     ⏳（源码 guard 扩展，下一 commit）
Phase 1-B Step 4       ⏸ 暂缓（等 Phase 1-C wiring 完成，防旧调用残留）
Phase 1-C              ⏸ 待裁决（fit/noscale + PrintSpec.paper 接线 + 图片边距恢复）
```
