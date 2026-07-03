# 🚀 v5 Ownership-Based 实施进度报告

## ✅ 已完成的工作

### 1. 设计文档
- 📄 [`V5_OWNERSHIP_BASED_DESIGN.md`](file://e:\print608\backend\field_extractor\V5_OWNERSHIP_BASED_DESIGN.md)
  - 完整的架构设计
  - 工作流程说明
  - 预期收益分析

### 2. 核心代码实现
- 📦 [`ownership_extractor.py`](file://e:\print608\backend\field_extractor\extractors\ownership_extractor.py) (270 行)
  - ✅ `BBox` 数据类
  - ✅ `Field` 数据类（带 owner_scores）
  - ✅ `OwnershipBasedExtractor` 主类
  - ✅ `_detect_all_fields()` - 字段检测
  - ✅ `_calculate_owner_score()` - 所有权评分
  - ✅ `_group_by_owner()` - 按 owner 分组
  - ✅ `_cross_validate()` - 交叉验证

### 3. 测试验证
- 🧪 [`test_v5_ownership.py`](file://e:\print608\scripts\test_v5_ownership.py)
  - ✅ 基础功能测试通过
  - ✅ Buyer/Seller 正确识别
  - ✅ Owner scores 合理分布

---

## 📊 测试结果

### 测试场景：双栏布局发票

**输入**：
```python
tokens = [
    # 购买方（左侧）
    {'text': '广州华栈天城科技有限公司', 'x0': 50, ...},
    {'text': '91440106068698695J', 'x0': 50, ...},
    
    # 销售方（右侧）
    {'text': '广州灵感之茶餐饮管理有限公司', 'x0': 350, ...},
    {'text': '91440101MA5AL52Y44', 'x0': 350, ...},
]
```

**输出**：
```
BUYER:
  名称: 广州华栈天城科技有限公司
    Owner scores: {'buyer': 0.56, 'seller': 0.26}  ✅
  
SELLER:
  名称: 广州灵感之茶餐饮管理有限公司
    Owner scores: {'buyer': 0.26, 'seller': 0.56}  ✅
```

**结论**：✅ 所有字段正确归属！

---

## 🔍 技术亮点

### 1. 软归属（Soft Assignment）

```python
# 不是硬性的 "属于 buyer" 或 "属于 seller"
# 而是概率分布
field.owner_scores = {"buyer": 0.56, "seller": 0.26}
```

**优势**：
- 可以处理模糊情况
- 支持置信度排序
- 便于调试和优化

### 2. 多因子评分系统

```python
score = (
    0.4 * vertical_proximity +      # 垂直距离
    0.3 * horizontal_alignment +     # 水平对齐
    0.3 * label_match                # 标签匹配（TODO）
)
```

**当前效果**：
- 垂直距离：主导因子（权重 0.4）
- 水平对齐：辅助因子（权重 0.3）
- 标签匹配：待实现（权重 0.3）

### 3. 模块化设计

```python
class OwnershipBasedExtractor:
    def extract_parties()      # 主入口
    def _detect_all_fields()   # Step 1: 检测
    def _calculate_owner_score() # Step 2: 评分
    def _group_by_owner()      # Step 3: 分组
    def _cross_validate()      # Step 4: 验证
```

**优势**：
- 每个步骤独立可测试
- 易于替换和优化
- 清晰的职责分离

---

## 📈 与 v4 对比

| 特性 | v4 (Region-Based) | v5 (Ownership-Based) |
|------|-------------------|----------------------|
| 核心思想 | 先切区域，再提取 | 先检测字段，再判断归属 |
| 数据结构 | 区域边界 (x0,y0,x1,y1) | Field {label, value, bbox, owner_scores} |
| 容错能力 | ❌ 区域切错就全错 | ✅ 部分字段错误不影响整体 |
| 可扩展性 | ⚠️ 需要调整多个参数 | ✅ 只需调整评分权重 |
| 调试难度 | ❌ 难以定位问题 | ✅ 可查看每个字段的 scores |
| 当前准确率 | ~78% (7/9) | 待集成测试 |

---

## 🗺️ 下一步计划

### Phase 2: 评分优化（预计 2-3 天）

#### 2.1 添加标签匹配因子

```python
def _is_near_label(field_bbox, label_text):
    """检查字段附近是否有对应的标签"""
    # 例如：检查"名称"字段附近是否有"购买方名称"
    pass
```

#### 2.2 优化权重参数

通过回归测试集调整：
- `vertical_distance` 权重
- `horizontal_alignment` 权重
- `label_match` 权重

#### 2.3 添加更多评分因子

- [ ] 上下文关系（同一行的其他字段）
- [ ] 字体大小一致性
- [ ] 文本长度合理性

### Phase 3: 集成到现有系统（预计 1-2 天）

#### 3.1 创建适配器

```python
def ownership_based_adapter(tokens, anchors):
    """将 v5 提取器适配到现有接口"""
    extractor = OwnershipBasedExtractor()
    result = extractor.extract_parties(tokens, anchors)
    
    # 转换为现有格式
    return {
        'buyer_name': result['buyer']['name'].value,
        'buyer_tax': result['buyer']['tax'].value,
        'seller_name': result['seller']['name'].value,
        'seller_tax': result['seller']['tax'].value,
    }
```

#### 3.2 A/B 测试

在 `party_extractor.py` 中添加开关：

```python
if USE_V5_OWNERSHIP:
    return ownership_based_adapter(tokens, anchors)
else:
    return region_based_extract(lines, anchors)
```

#### 3.3 运行回归测试

```bash
pytest tests/test_regression.py::TestInvoiceRegression::test_buyer_seller_assignment -v
```

对比 v4 vs v5 的结果。

### Phase 4: 边界处理（预计 1-2 天）

- [ ] 处理无锚点情况
- [ ] 处理多名称冲突
- [ ] 处理税号缺失
- [ ] 处理 OCR 严重错位

---

## 💡 关键洞察

### 1. v5 的核心优势

**不是更复杂的算法，而是更合理的抽象**

v4 的问题：
```python
# 假设区域是正确的
buyer_region = find_region(buyer_anchor)
# 如果区域错了，后面全错
extract_name(buyer_region)  # ❌
```

v5 的思路：
```python
# 不依赖区域，直接判断每个字段
for field in all_fields:
    field.owner = calculate_owner(field)  # ✅
```

### 2. 渐进式迁移策略

**不要一次性替换 v4**

```text
Step 1: 并行运行 v4 和 v5
Step 2: 对比结果，找出差异
Step 3: 分析差异原因，优化 v5
Step 4: 确认 v5 更优后，逐步替换
```

### 3. 数据驱动的优化

**通过测试集反推最优权重**

```python
# 收集 100 张发票的 ground truth
# 使用网格搜索找到最优权重组合
best_weights = grid_search(
    vertical_weight=[0.3, 0.4, 0.5],
    horizontal_weight=[0.2, 0.3, 0.4],
    label_weight=[0.2, 0.3, 0.4]
)
```

---

## 📝 总结

### 当前状态

- ✅ v5 基础框架完成
- ✅ 核心逻辑验证通过
- ✅ 测试结果符合预期

### 主要成果

1. **建立了 Ownership-Based 的抽象层**
   - `Field` 数据类
   - `owner_scores` 机制
   
2. **实现了多因子评分系统**
   - 垂直距离
   - 水平对齐
   - （待实现）标签匹配

3. **验证了可行性**
   - 测试用例 100% 通过
   - Owner scores 合理分布

### 下一步

立即开始 **Phase 2: 评分优化**，重点是：
1. 实现标签匹配因子
2. 在真实发票上测试
3. 调整权重参数

---

## 🎯 长期愿景

```text
v4 Region-Based (当前)
    ↓
v5 Ownership-Based (进行中)
    ↓
v6 Block-Based (未来)
    ↓
v7 Graph-Based (最终形态)
```

每一步都是在前一步的基础上增加抽象层，而不是推翻重来。这才是成熟的 OCR 文档理解系统的发展路径。
