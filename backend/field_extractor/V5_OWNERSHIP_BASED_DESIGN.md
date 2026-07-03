# 🎯 v5 Ownership-Based 重构设计文档

## 📊 当前状态分析（v4 Region-Based）

### 核心问题

```python
# 当前逻辑：先切区域，再提取
buyer_region = find_region(buyer_anchor)
seller_region = find_region(seller_anchor)

extract_name(buyer_region)  # ❌ 如果区域切错，提取就错
extract_tax(buyer_region)
```

**失败场景**：
1. OCR 错位 → 区域边界错误
2. 锚点识别错误 → 整个归属颠倒
3. 双栏布局混乱 → 区域重叠或遗漏

---

## 🚀 v5 设计方案：Ownership-Based

### 核心理念

```text
不是"这个字段在哪个区域"
而是"这个字段属于谁"
```

### 数据结构

```python
@dataclass
class Field:
    """带所有权信息的字段"""
    label: str          # "名称", "税号"
    value: str          # "杭州某某科技有限公司"
    bbox: BBox          # (x0, y0, x1, y1)
    confidence: float   # 0.0 - 1.0
    
    # ⭐ 新增：所有权评分
    owner_scores: Dict[str, float]  # {"buyer": 0.85, "seller": 0.15}
    
    @property
    def owner(self) -> Optional[str]:
        """返回最高分的拥有者"""
        if not self.owner_scores:
            return None
        return max(self.owner_scores, key=self.owner_scores.get)
```

### 工作流程

```text
Step 1: 检测所有候选字段
  ↓
Step 2: 计算每个字段的 owner_score
  ↓
Step 3: 根据 owner 分组
  ↓
Step 4: 输出 buyer/seller
```

---

## 🔧 实现细节

### Step 1: 检测所有候选字段

```python
def detect_all_fields(tokens: List[Token]) -> List[Field]:
    """检测所有名称和税号字段"""
    fields = []
    
    # 1. 检测公司名称
    for token in tokens:
        if _COMPANY_PATTERN.match(token.text):
            fields.append(Field(
                label="名称",
                value=token.text,
                bbox=token.bbox,
                confidence=0.9
            ))
    
    # 2. 检测税号
    for token in tokens:
        if _TAX_ID_PATTERN.match(token.text):
            fields.append(Field(
                label="税号",
                value=token.text,
                bbox=token.bbox,
                confidence=0.95
            ))
    
    return fields
```

### Step 2: 计算 Owner Score

```python
def calculate_owner_score(field: Field, anchors: Dict[str, BBox]) -> Dict[str, float]:
    """计算字段属于 buyer/seller 的评分"""
    
    scores = {"buyer": 0.0, "seller": 0.0}
    
    for owner, anchor_bbox in anchors.items():
        score = 0.0
        
        # 因子 1: 距离锚点的垂直距离（越近分数越高）
        vertical_dist = abs(field.bbox.cy - anchor_bbox.cy)
        if vertical_dist < 50:
            score += 0.4 * (1 - vertical_dist / 50)
        
        # 因子 2: 水平对齐（同一列加分）
        horizontal_overlap = _calculate_horizontal_overlap(field.bbox, anchor_bbox)
        if horizontal_overlap > 0.5:
            score += 0.3
        
        # 因子 3: 标签匹配（"购买方名称" vs "销售方名称"）
        if field.label == "名称":
            if _is_near_label(field.bbox, f"{owner}名称"):
                score += 0.3
        
        scores[owner] = score
    
    return scores
```

### Step 3: 分组与验证

```python
def group_by_owner(fields: List[Field]) -> Dict[str, Dict[str, Field]]:
    """按 owner 分组字段"""
    
    result = {
        "buyer": {"name": None, "tax": None},
        "seller": {"name": None, "tax": None}
    }
    
    for field in fields:
        owner = field.owner
        if not owner:
            continue
        
        if field.label == "名称":
            # 选择置信度最高的名称
            if (result[owner]["name"] is None or 
                field.confidence > result[owner]["name"].confidence):
                result[owner]["name"] = field
        
        elif field.label == "税号":
            if (result[owner]["tax"] is None or 
                field.confidence > result[owner]["tax"].confidence):
                result[owner]["tax"] = field
    
    return result
```

### Step 4: 交叉验证

```python
def cross_validate(result: Dict) -> bool:
    """验证 buyer/seller 是否合理"""
    
    # 规则 1: buyer 和 seller 不能相同
    if result["buyer"]["name"] and result["seller"]["name"]:
        if result["buyer"]["name"].value == result["seller"]["name"].value:
            logger.warning("Buyer 和 Seller 名称相同，可能识别错误")
            return False
    
    # 规则 2: 税号格式验证
    for owner in ["buyer", "seller"]:
        tax_field = result[owner]["tax"]
        if tax_field and not _validate_tax_format(tax_field.value):
            logger.warning(f"{owner} 税号格式无效: {tax_field.value}")
            return False
    
    return True
```

---

## 📈 预期收益

### 解决的问题

| 问题 | v4 (Region) | v5 (Ownership) |
|------|-------------|----------------|
| OCR 错位导致区域切错 | ❌ 严重 | ✅ 鲁棒 |
| 锚点识别错误 | ❌ 全错 | ✅ 部分容错 |
| 双栏布局混乱 | ❌ 不稳定 | ✅ 稳定 |
| 字段归属判断 | ⚠️ 依赖区域 | ✅ 直接判断 |

### 准确率提升

- **当前**：buyer/seller 错误率 ~22%（2/9 张发票）
- **预期 v5**：错误率 < 5%

---

## 🗺️ 实施路线图

### Phase 1: 基础框架（1-2 天）

- [ ] 定义 `Field` 数据类
- [ ] 实现 `detect_all_fields()` 
- [ ] 实现 `calculate_owner_score()`

### Phase 2: 评分优化（2-3 天）

- [ ] 添加更多评分因子
  - [ ] 垂直距离
  - [ ] 水平对齐
  - [ ] 标签匹配
  - [ ] 上下文关系
- [ ] 调整权重参数

### Phase 3: 集成测试（1-2 天）

- [ ] 替换现有 `_extract_full_electric()`
- [ ] 运行回归测试
- [ ] 对比 v4 vs v5 结果

### Phase 4: 边界处理（1-2 天）

- [ ] 处理无锚点情况
- [ ] 处理多名称冲突
- [ ] 处理税号缺失

---

## 💡 关键创新点

### 1. 软归属（Soft Assignment）

```python
# 不是硬性的 "属于 buyer" 或 "属于 seller"
# 而是概率分布
field.owner_scores = {"buyer": 0.75, "seller": 0.25}
```

### 2. 多因子评分

```python
score = (
    0.4 * vertical_proximity +
    0.3 * horizontal_alignment +
    0.3 * label_match
)
```

### 3. 全局最优解

```python
# 不是独立判断每个字段
# 而是寻找全局最优的 buyer/seller 配对
best_assignment = find_optimal_assignment(fields)
```

---

## 🎯 下一步行动

1. **立即开始**：创建 `Field` 数据类和基础检测函数
2. **并行工作**：保持 v4 代码不变，新增 v5 模块
3. **A/B 测试**：对比 v4 和 v5 的测试结果
4. **渐进迁移**：确认 v5 更优后，逐步替换 v4

---

## 📝 参考资源

- LayoutLM: https://github.com/microsoft/unilm
- DocFormer: https://arxiv.org/abs/2110.03146
- Donut: https://github.com/clovaai/donut

这些模型都采用了类似的 Graph-Based 思路，但我们可以先用轻量级的 Ownership-Based 方法快速见效。
