# Identity Migration Note v1.1

> docId 生成规则变更 — 此备忘录记录旧 docId 与 新 docId 的关系及兼容策略。

---

## 变更

| 项目 | 旧 | 新 |
|------|----|----|
| 公式 | `sha256(file_bytes + filename)[:24]` | `sha256(file_bytes)[:24]` |
| 函数 | `_make_doc_id(bytes, filename)` | `_make_doc_id(bytes, filename=None)` — 忽略 filename 参数 |
| 结果 | 同一内容不同文件名 → 不同 docId | 同一内容不同文件名 → 相同 docId |

## 影响范围

| 模块 | 影响 | 是否需要迁移 |
|------|------|-------------|
| 后端 RenderCache | 旧缓存键（含 filename）与新 docId 不匹配 | ✅ 旧缓存自动过期（LRU），不迁移 |
| 后端 DocRegistry (`self._docs`) | 进程级内存，重启即清 | ✅ 无需迁移 |
| 后端 DocFacts（`DocFacts.json`） | 旧 factKey 含 filename，与新 factKey 不匹配 | ⚠️ 前端 Phase 1.5 处理回退读取 |
| 前端 Preview URL | 透传 docId，不受影响 | ✅ 无动作 |
| 前端 DocumentState | 读 `identity.docId`（新 docId） | ✅ Phase 1.4 消费 |

## 兼容策略

```
DocFacts 回退读取（前端 Phase 1.5 实现）:
  1. 先用新 factKey = buildFactKey(identity) 读
  2. 未命中 → 用旧兼容键（如 path 或旧 docId 规则）回退读
  3. 回退命中 → 写回新 factKey + 删除旧键
  4. 两次都未命中 → 新数据初始化
```

## 验收确认

- [x] 同文件两次注册 → docId 相同（Case 1）
- [x] 改名后注册 → docId 相同（Case 2）— 本次变更核心
- [ ] 改内容后注册 → docId 不同（Case 3）
- [ ] 多页 PDF 拆分后各 page docId 相同（Case 4）

---

> 迁移完成日期：本备忘录随 Stage 4.1.1 提交。
> 此文件是只读记录，修改需经 Identity Contract 架构评审。
