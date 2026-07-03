# 发票字段提取器全面重构

## 时间
2026-06-04

## 目标
将 `_extractor.py` 中的 1000+ 行上帝函数 `extract_fields()` 拆分为独立的提取器模块，解决职责混乱、重复扫描、规则泥球等问题。

## 架构变更

### 重构前
```
_extractor.py (1000+ 行)
  ├── extract_fields()  — 上帝函数，包含所有逻辑
  ├── to_chinese_amount()
  ├── _fix_ocr_text()
  ├── _fix_ocr_digit_field()
  ├── extract_project_name()
  └── 杂项工具函数
```

### 重构后
```
field_extractor/
├── models.py              — @dataclass: InvoiceFields, OCRDocument, AmountCandidate, PartyCandidate
├── normalizer.py          — TextNormalizer (文本预处理+OCR纠错), DigitCorrector (字段级纠错), CompanyNameCleaner
├── regex_patterns.py      — 预编译正则（不变）
├── _extractor.py          — 薄层编排（50行），兼容旧版API
├── __init__.py            — 包入口，导出符号不变
└── extractors/
    ├── __init__.py        — InvoiceExtractor 编排器
    ├── type_extractor.py  — TypeExtractor
    ├── number_extractor.py— NumberExtractor (fphm)
    ├── amount_extractor.py— AmountExtractor (候选评分制)
    ├── date_extractor.py  — DateExtractor (kprq)
    ├── party_extractor.py — PartyExtractor (4策略，名称/税号)
    ├── project_extractor.py— ProjectExtractor (xmmc, 4策略)
    └── misc_extractor.py  — MiscExtractor (备注/人员)
```

## 关键设计

### 1. OCRDocument 一次构建
所有提取器共享同一个 `OCRDocument`（包含 `collapsed` 文本和 `lines` 列表），避免重复扫描全文。

### 2. 候选评分制（金额提取）
`AmountExtractor` 定义了 `AmountCandidate(value, confidence, source)`，5 种候选策略各自产出候选+置信度分，最后 `max(candidates)` 选最优。替代原来的 `if not tax_total: if not tax_total: if not tax_total:` 五层回退。

### 3. 策略链（购买方/销售方）
`PartyExtractor` 保持原来的 4 策略不变，但各策略独立方法：
- 策略1: 传统发票（购买方名称:/销售方名称:）
- 策略2: 全电发票（名称: 配对）
- 策略3: 税号位置推断
- 策略4: 公司名回退（检测垃圾数据）

### 4. 语义明确的提取器接口
每个提取器都有 `extract(doc: OCRDocument)` 接口，职责清晰。

## 向后兼容
- `from field_extractor import extract_fields` ✓
- `from field_extractor import extract_fields_legacy` ✓
- `from field_extractor import to_chinese_amount` ✓
- `from field_extractor import normalize_invoice_type` ✓
- `from field_extractor import extract_project_name` ✓
- `from field_extractor import normalize_amount, normalize_date` ✓
- `response_builder.py`, `invoice_service.py`, `image_parser.py`, `pdf_utils.py`, `app.py`, `xml_parser.py` 无需修改

## 验证
- 完整发票 OCR → dict 测试通过
- 旧版 4-tuple API 测试通过
- 空输入测试通过
- 所有外部调用方导入测试通过

## 涉及文件
- `backend/field_extractor/models.py` (新建)
- `backend/field_extractor/normalizer.py` (新建)
- `backend/field_extractor/extractors/__init__.py` (新建)
- `backend/field_extractor/extractors/type_extractor.py` (新建)
- `backend/field_extractor/extractors/number_extractor.py` (新建)
- `backend/field_extractor/extractors/amount_extractor.py` (新建)
- `backend/field_extractor/extractors/date_extractor.py` (新建)
- `backend/field_extractor/extractors/party_extractor.py` (新建)
- `backend/field_extractor/extractors/project_extractor.py` (新建)
- `backend/field_extractor/extractors/misc_extractor.py` (新建)
- `backend/field_extractor/_extractor.py` (重写为薄编排层)
- `backend/field_extractor/__init__.py` (更新导出)
- `electron/rename-utils.js` (文件名清洗，独立修复)
