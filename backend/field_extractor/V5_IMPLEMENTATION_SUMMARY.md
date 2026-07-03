# 🚀 v5 Ownership-Based 实施总结（第一阶段完成）

## ✅ 已完成的工作

### 1. 核心架构设计
- 📄 [`V5_OWNERSHIP_BASED_DESIGN.md`](file://e:\print608\backend\field_extractor\V5_OWNERSHIP_BASED_DESIGN.md)
  - 完整的架构设计文档
  - 工作流程说明
  - 预期收益分析

### 2. 基础代码实现
- 📦 [`ownership_extractor.py`](file://e:\print608\backend\field_extractor\extractors\ownership_extractor.py) (270行)
  - ✅ `BBox` 数据类
  - ✅ `Field` 数据类（带 owner_scores）
  - ✅ `OwnershipBasedExtractor` 主类
  - ✅ 字段检测、评分、分组、验证

### 3. 测试验证
- 🧪 [`test_v5_ownership.py`](file://e:\print608\scripts\test_v5_ownership.py)
  - ✅ 基础功能测试通过
  - ✅ Buyer/Seller 正确识别
  - ✅ Owner scores 合理分布

**测试结果**：
```python
BUYER: 广州华栈天城科技有限公司
  Owner scores: {'buyer': 0.56, 'seller': 0.26}  ✅

SELLER: 广州灵感之茶餐饮管理有限公司  
  Owner scores: {'buyer': 0.26, 'seller': 0.56}  ✅
```

### 4. 进度报告
- 📊 [`V5_PROGRESS_REPORT.md`](file://e:\print608\backend\field_extractor\V5_PROGRESS_REPORT.md)

---

## 🔍 当前状态

### 已完成
- ✅ v5 基础框架搭建完成
- ✅ 核心数据结构定义完成
- ✅ 多因子评分系统实现
- ✅ 单元测试通过

### 待完成
- ⏳ 在真实发票上测试（需要访问 OCR tokens）
- ⏳ 添加标签匹配因子
- ⏳ 优化权重参数
- ⏳ 集成到现有系统
- ⏳ A/B 测试对比 v4 vs v5

---

## 🎯 技术亮点

### 1. Field 数据类（核心创新）

```python
@dataclass
class Field:
    label: str              # "名称", "税号"
    value: str              # "杭州某某科技有限公司"
    bbox: BBox              # 空间位置
    confidence: float       # 检测置信度
    
    # ⭐ 所有权评分：软归属机制
    owner_scores: Dict[str, float]  # {"buyer": 0.85, "seller": 0.15}
    
    @property
    def owner(self) -> Optional[str]:
        """返回最高分的拥有者"""
        return max(self.owner_scores, key=self.owner_scores.get)
```

**优势**：
- 支持模糊归属判断
- 便于调试和优化
- 可解释性强

### 2. 多因子评分系统

```python
def _calculate_owner_score(self, field, anchors):
    score = 0.0
    
    # 因子 1: 垂直距离（越近分数越高）
    vertical_dist = abs(field.bbox.cy - anchor_bbox.cy)
    if vertical_dist < threshold:
        score += 0.4 * (1 - vertical_dist / threshold)
    
    # 因子 2: 水平对齐（同一列加分）
    horizontal_overlap = calculate_overlap(field.bbox, anchor_bbox)
    if horizontal_overlap > 0.5:
        score += 0.3
    
    # 因子 3: 标签匹配（TODO）
    # if is_near_label(field.bbox, f"{owner}名称"):
    #     score += 0.3
    
    return score
```

**当前权重**：
- 垂直距离：0.4
- 水平对齐：0.3
- 标签匹配：0.3（待实现）

### 3. 模块化设计

```python
class OwnershipBasedExtractor:
    def extract_parties()         # 主入口
    def _detect_all_fields()      # Step 1: 检测
    def _calculate_owner_score()  # Step 2: 评分
    def _group_by_owner()         # Step 3: 分组
    def _cross_validate()         # Step 4: 验证
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

实现 `_is_near_label()` 函数，检查字段附近是否有对应的标签（如"购买方名称"）。

#### 2.2 优化权重参数

通过网格搜索找到最优权重组合：

```python
best_weights = grid_search(
    vertical_weight=[0.3, 0.4, 0.5],
    horizontal_weight=[0.2, 0.3, 0.4],
    label_weight=[0.2, 0.3, 0.4]
)
```

#### 2.3 在真实发票上测试

需要解决 OCR tokens 获取问题，或者创建适配器从现有系统中提取 tokens。

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

收集 100 张发票的 ground truth，使用网格搜索找到最优权重组合。

---

## 📝 总结

### 当前成果

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

### 主要挑战

1. **OCR tokens 获取**
   - 当前架构不直接暴露 tokens
   - 需要创建适配器或修改接口

2. **权重优化**
   - 需要在真实数据上调优
   - 需要大量测试样本

3. **边界情况处理**
   - 无锚点、多名称、税号缺失等

### 长期愿景

```text
v4 Region-Based (当前生产环境)
    ↓
v5 Ownership-Based (开发中，实验性) ⭐
    ↓
v6 Block-Based (未来规划)
    ↓
v7 Graph-Based (最终形态)
```

每一步都是在前一步的基础上增加抽象层，而不是推翻重来。这才是成熟的 OCR 文档理解系统的发展路径。

---

## 🎯 立即行动

**建议下一步**：

1. **优先**：解决 OCR tokens 获取问题
   - 选项 A：修改 `invoice_service.py` 暴露 tokens
   - 选项 B：从 `raw_text` 重新 tokenize
   
2. **并行**：实现标签匹配因子
   - 检测"购买方名称"/"销售方名称"标签
   - 计算标签与字段的距离

3. **后续**：在测试集上运行 A/B 测试
   - 对比 v4 vs v5 的准确率
   - 找出 v5 失败的案例并分析原因

---

**预计总工期**：5-7 天完成 Phase 2-4

**预期收益**：buyer/seller 准确率从 78% 提升到 95%+
