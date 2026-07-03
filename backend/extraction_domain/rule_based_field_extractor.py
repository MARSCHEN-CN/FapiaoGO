"""
RuleBasedFieldExtractor — extract fields from a DocumentLayout using
Template extraction_rules (keyword, regex, position, region, table).

Each rule produces an ExtractedField. Results are returned as a list
compatible with ConfidenceEngine.merge().
"""

import logging
import re
from typing import Any, Callable, Dict, List, Optional

from contracts.document_layout import BBox, DocumentLayout, Region
from contracts.extracted_field import ExtractedField
from contracts.template import ExtractionRule

logger = logging.getLogger(__name__)


class RuleBasedFieldExtractor:
    """Extract fields by executing extraction_rules against a DocumentLayout."""

    def __init__(self, extractor_id: str = "rule_based"):
        self.extractor_id = extractor_id

    def extract(
        self,
        document: DocumentLayout,
        rules: List[ExtractionRule],
        schema: dict = None,
    ) -> List[ExtractedField]:
        """Execute each rule against the document, collect ExtractedFields."""
        results: List[ExtractedField] = []
        for rule in rules:
            field = self._execute_rule(document, rule)
            if field is not None:
                results.append(field)
        return self._dedup_fields(results)

    # ── Hybrid extraction: rules + legacy fallback ────────────────────

    def extract_with_fallback(
        self,
        document: DocumentLayout,
        rules: List[ExtractionRule],
        schema: Any = None,
        legacy_input: dict = None,
    ) -> List[ExtractedField]:
        """
        Hybrid extraction: rule-driven + legacy fallback for missing/invalid fields.

        1. Run rule-based extraction
        2. Identify fields needing fallback (MISSING or INVALID)
        3. Fall back to old extract_fields() for those fields
           - 如果 legacy_input 中包含 precomputed_legacy_result（旧管道已提取好的结果），
             直接复用，避免重复调用 extract_fields() 造成双重计算
        4. Merge and return
        """
        import time
        _fb_start = time.time()
        
        # Step 1: rule-based extraction
        rule_fields = self.extract(document, rules)
        field_dict: Dict[str, ExtractedField] = {f.field_id: f for f in rule_fields}
        logger.debug("规则提取完成: %d 个字段 — %s", len(rule_fields), list(field_dict.keys()))
        # DEBUG: 追踪规则提取的金额
        for f in rule_fields:
            if f.field_id in ('amountHj', 'amountJe', 'amountHjDx', 'amountSe'):
                logger.debug("[RULE EXTRACT] %s = %r (state=%s)", f.field_id, f.value, f.state)

        # Step 2: identify fields needing fallback (MISSING or INVALID)
        needs_fallback: List[str] = []
        if schema and hasattr(schema, 'fields'):
            for fd in schema.fields:
                field = field_dict.get(fd.id)
                if field is None:
                    # MISSING: field not extracted
                    needs_fallback.append(fd.id)
                elif field.state == "INVALID":
                    # INVALID: field extracted but failed validation
                    needs_fallback.append(fd.id)

        # ── 强制金额字段走 legacy fallback ─────────────────────────────
        # 规则提取器对金额字段的提取（基于区域/布局）常与 OCR 实际值不一致，
        # 而 legacy extract_fields() 经过多重校验（小写锚点、双¥对齐、算术校验），
        # 结果更可靠。因此始终用 legacy 结果覆盖规则提取的金额字段。
        for amt_field in ('amountHj', 'amountJe', 'amountSe', 'amountHjDx'):
            if amt_field in field_dict and amt_field not in needs_fallback:
                # 从规则结果中移除，加入 fallback 列表
                rule_fields = [f for f in rule_fields if f.field_id != amt_field]
                needs_fallback.append(amt_field)
                logger.debug("[FALLBACK] 强制金额字段 %s 使用 legacy 结果", amt_field)

        if not needs_fallback:
            logger.debug("无需要回退的字段, 直接返回 (规则提取耗时 %.2fms)",
                         (time.time() - _fb_start) * 1000)
            return rule_fields

        logger.debug("需要回退的字段: %s", needs_fallback)

        # Step 3: fall back to legacy extractor
        if legacy_input:
            try:
                # 优先使用预计算结果（旧管道已经调用过 extract_fields 了）
                precomputed = legacy_input.get("precomputed_legacy_result")
                if precomputed is not None:
                    logger.info("[FALLBACK] 使用预计算的 legacy 结果（避免重复调用 extract_fields）")
                    legacy_result = precomputed
                else:
                    # 没有预计算结果才重新调用
                    from field_extractor import extract_fields as legacy_extract
                    logger.info("[FALLBACK] 重新调用 extract_fields (未提供预计算结果)")
                    raw_text = legacy_input.get("raw_text", "") or ""
                    bbox_data = legacy_input.get("bbox_data", [])
                    source_type = legacy_input.get("source_type", "pdf_text")
                    legacy_result = legacy_extract(
                        raw_text,
                        bbox_data=bbox_data,
                        source_type=source_type,
                        auxiliary_blocks=legacy_input.get("auxiliary_blocks", []),
                    )
                
                # DEBUG: fallback 金额值
                for k in ('amountHj', 'amountJe', 'amountHjDx', 'amountSe'):
                    if k in legacy_result:
                        logger.debug("[FALLBACK LEGACY] %s = %r", k, legacy_result[k])
                
                filled = 0
                for field_name in needs_fallback:
                    # 先检查是否已存在（防止重复添加）
                    existing_idx = None
                    for i, f in enumerate(rule_fields):
                        if f.field_id == field_name:
                            existing_idx = i
                            break
                    
                    if field_name in legacy_result:
                        val = legacy_result[field_name]
                        new_field = ExtractedField(
                            field_id=field_name,
                            value=val if val else '',
                            state='CORRECTED',
                            source='FALLBACK',
                            source_region_id='',
                            evidence=None,
                            validator_status='WARN' if val else 'PASS',
                        )
                        if existing_idx is not None:
                            # 已存在则替换（fallback 结果来自完整提取，更可信）
                            rule_fields[existing_idx] = new_field
                        else:
                            rule_fields.append(new_field)
                        filled += 1
                fb_ms = round((time.time() - _fb_start) * 1000, 2)
                logger.info("[FALLBACK] 补充了 %d 个字段, 总耗时 %.2fms: %s", filled, fb_ms,
                             [f for f in needs_fallback if f in legacy_result and legacy_result[f]])
            except Exception as e:
                logger.debug("旧架构回退异常: %s", e)

        return rule_fields

    @staticmethod
    def _dedup_fields(fields: List[ExtractedField]) -> List[ExtractedField]:
        """Deduplicate by field_id: keep the best candidate per field.

        Selection heuristics (per field type):
        - amount*: prefer value that survives clean_amount parsing (valid float)
        - *number*/*fphm*: prefer longer value
        - *name*/*mc*: prefer longer value, penalize short/generic words
        - default: prefer longer value
        """
        from collections import OrderedDict

        groups: Dict[str, List[ExtractedField]] = OrderedDict()
        for f in fields:
            groups.setdefault(f.field_id, []).append(f)

        result: List[ExtractedField] = []
        for field_id, candidates in groups.items():
            if len(candidates) == 1:
                result.append(candidates[0])
            else:
                best = RuleBasedFieldExtractor._pick_best(candidates, field_id)
                result.append(best)
                extras = len(candidates) - 1
                if extras:
                    logger.debug("字段 '%s' 去重: 保留最优, 丢弃 %d 个冗余候选", field_id, extras)
        return result

    @staticmethod
    def _pick_best(candidates: List[ExtractedField], field_id: str) -> ExtractedField:
        """Pick the best candidate for a field from multiple matches."""
        # Short-circuit: if only one, return it
        if len(candidates) == 1:
            return candidates[0]

        field_lower = field_id.lower()

        # amount* fields: prefer value parseable as a clean number
        if field_lower.startswith("amount") or "hj" in field_lower:
            for c in candidates:
                val = str(c.value or "")
                cleaned = val.replace(",", "").replace("¥", "").replace("￥", "").strip()
                try:
                    float(cleaned)
                    return c  # first parseable = best
                except (ValueError, TypeError):
                    continue

        # *name*/*mc* fields: prefer longer, filter generic
        if "name" in field_lower or "mc" in field_lower or "gmf" in field_lower or "xsf" in field_lower:
            # Filter out short/generic words
            generic_words = {"信息", "名称", "单位", "购买方", "销售方", "纳税人", "识别号", "税号"}
            scored = []
            for c in candidates:
                val = str(c.value or "").strip()
                if val in generic_words or len(val) < 2:
                    scored.append((0, c))
                else:
                    scored.append((len(val), c))
            scored.sort(key=lambda x: -x[0])
            return scored[0][1]

        # *number*/*fphm* fields: prefer longer
        if "number" in field_lower or "fphm" in field_lower or "code" in field_lower:
            candidates.sort(key=lambda c: len(str(c.value or "")), reverse=True)
            return candidates[0]

        def _apply(v):
            try:
                return float(str(v).replace(",", "").replace("¥", "").replace("￥", ""))
            except (ValueError, TypeError):
                return v

        # Default: prefer longer, with numeric preference
        candidates.sort(key=lambda c: (len(str(c.value or "")), _apply(c.value) if isinstance(_apply(c.value), (int, float)) else 0), reverse=True)
        return candidates[0]

    def _execute_rule(self, doc: DocumentLayout, rule: ExtractionRule) -> Optional[ExtractedField]:
        """Execute a single extraction rule."""
        locator_type = rule.locator_type or self._strategy_to_locator(rule.strategy)
        locator_config = rule.locator_config if rule.locator_config is not None else rule.config

        # Dispatch to the appropriate locator
        candidates: List[tuple] = []  # list of (text, bbox, region_id)

        if locator_type == "keyword" or locator_type == "anchor":
            candidates = self._locate_keyword(doc, locator_config)
        elif locator_type == "regex":
            candidates = self._locate_regex(doc, locator_config)
        elif locator_type == "position":
            candidates = self._locate_position(doc, locator_config)
        elif locator_type == "region":
            candidates = self._locate_region(doc, locator_config)
        elif locator_type == "table":
            candidates = self._locate_table(doc, locator_config)

        if not candidates:
            return None

        # Pick the best candidate (highest confidence or first)
        text, bbox, region_id = candidates[0]

        # Apply post-processor
        if rule.post_process:
            processor = self._get_post_processor(rule.post_process)
            if processor:
                text = processor(text)

        return ExtractedField(
            field_id=rule.field_id,
            value=text,
            state=None,
            source="RULE",
            source_region_id=region_id,
            evidence={"text": text, "bbox": bbox} if bbox else None,
            validator_status="PASS",
        )

    # ── Locators ───────────────────────────────────────────────────────

    @staticmethod
    def _locate_keyword(doc: DocumentLayout, config: dict) -> List[tuple]:
        """Locate by keywords with optional offset.

        Config:
            keywords: List[str] — words to search for
            offset_x: float — x offset to look right of the keyword
            offset_y: float — y offset to look below/beside
        """
        keywords = config.get("keywords", [])
        offset_x = config.get("offset_x", 0)
        offset_y = config.get("offset_y", 0)
        if not keywords:
            return []

        candidates: List[tuple] = []

        for region in doc.regions:
            region_text = region.text or ""
            region_bbox = region.bbox

            for kw in keywords:
                if kw in region_text:
                    # Found keyword region — check if value is embedded in same text
                    # Try to extract after keyword
                    idx = region_text.find(kw)
                    after_kw = region_text[idx + len(kw):].strip()
                    if after_kw and after_kw != kw:
                        candidates.append((after_kw, region_bbox, region.id))
                        continue

                    # Try offset-based neighbor
                    if offset_x or offset_y:
                        target_box = BBox(
                            x=region_bbox.x + offset_x,
                            y=region_bbox.y + offset_y,
                            width=region_bbox.width,
                            height=region_bbox.height,
                        )
                        neighbor = RuleBasedFieldExtractor._find_region_at(
                            doc.regions, target_box
                        )
                        if neighbor:
                            candidates.append((neighbor.text, neighbor.bbox, neighbor.id))

        return candidates

    @staticmethod
    def _locate_regex(doc: DocumentLayout, config: dict) -> List[tuple]:
        """Locate by regex pattern applied to all region text.

        Config:
            pattern: str — regex pattern
            group: int — capture group to return (default 0 = full match)
        """
        pattern = config.get("pattern", "")
        group = config.get("group", 0)
        if not pattern:
            return []
        try:
            compiled = re.compile(pattern)
        except re.error:
            return []

        candidates: List[tuple] = []
        for region in doc.regions:
            text = region.text or ""
            m = compiled.search(text)
            if m:
                try:
                    value = m.group(group)
                except IndexError:
                    value = m.group(0)
                candidates.append((value, region.bbox, region.id))
        return candidates

    @staticmethod
    def _locate_position(doc: DocumentLayout, config: dict) -> List[tuple]:
        """Locate by position (bbox range).

        Config:
            x_range: [min_x, max_x]
            y_range: [min_y, max_y]
        """
        x_range = config.get("x_range", [0, 9999])
        y_range = config.get("y_range", [0, 9999])
        x_min, x_max = x_range
        y_min, y_max = y_range

        candidates: List[tuple] = []
        for region in doc.regions:
            b = region.bbox
            if (x_min <= b.x + b.width / 2 <= x_max and
                    y_min <= b.y + b.height / 2 <= y_max):
                candidates.append((region.text, region.bbox, region.id))
        return candidates

    @staticmethod
    def _locate_region(doc: DocumentLayout, config: dict) -> List[tuple]:
        """Locate by region role.

        Config:
            region_name: str — role to filter by ("header", "body", "footer", "table")
        """
        region_name = config.get("region_name", "")
        if not region_name:
            return []

        candidates: List[tuple] = []
        for region in doc.regions:
            if region.role == region_name:
                candidates.append((region.text, region.bbox, region.id))
        return candidates

    @staticmethod
    def _locate_table(doc: DocumentLayout, config: dict) -> List[tuple]:
        """Locate from table regions.

        Config:
            column: int — which column (index) to extract from
            row_pattern: str — optional regex to filter rows
        """
        column = config.get("column", 0)
        row_pattern = config.get("row_pattern", "")
        compiled_row = re.compile(row_pattern) if row_pattern else None

        candidates: List[tuple] = []
        for table in doc.tables:
            for row_idx, row in enumerate(table.regions):
                if compiled_row and not compiled_row.search(str(row)):
                    continue
                # Collect text from regions in the desired column
                if column < len(row):
                    rid = row[column]
                    region = RuleBasedFieldExtractor._find_region_by_id(
                        doc.regions, rid
                    )
                    if region:
                        candidates.append((region.text, region.bbox, region.id))
        return candidates

    # ── Helpers ────────────────────────────────────────────────────────

    @staticmethod
    def _find_region_at(regions: List[Region], bbox: BBox) -> Optional[Region]:
        """Find the region whose bbox overlaps most with target bbox."""
        best = None
        best_overlap = -1.0
        for r in regions:
            overlap = RuleBasedFieldExtractor._overlap_area(r.bbox, bbox)
            if overlap > best_overlap:
                best_overlap = overlap
                best = r
        return best

    @staticmethod
    def _find_region_by_id(regions: List[Region], rid: str) -> Optional[Region]:
        for r in regions:
            if r.id == rid:
                return r
        return None

    @staticmethod
    def _overlap_area(a: BBox, b: BBox) -> float:
        ox = max(0.0, min(a.x + a.width, b.x + b.width) - max(a.x, b.x))
        oy = max(0.0, min(a.y + a.height, b.y + b.height) - max(a.y, b.y))
        return ox * oy

    # ── Strategy mapping & confidence ──────────────────────────────────

    @staticmethod
    def _strategy_to_locator(strategy: str) -> str:
        mapping = {
            "anchor": "keyword",
            "table": "table",
            "regex": "regex",
            "llm": "region",
        }
        return mapping.get(strategy, "keyword")

    @staticmethod
    def _compute_confidence(candidate: tuple, locator_type: str) -> float:
        """Heuristic confidence based on locator type."""
        conf_map = {
            "keyword": 0.85,
            "regex": 0.90,
            "position": 0.70,
            "region": 0.75,
            "table": 0.80,
            "anchor": 0.85,
        }
        return conf_map.get(locator_type, 0.70)

    # ── Post-processors ────────────────────────────────────────────────

    _POST_PROCESSORS: Dict[str, Callable[[str], str]] = {}

    @classmethod
    def _get_post_processor(cls, name: str) -> Optional[Callable[[str], str]]:
        if not cls._POST_PROCESSORS:
            cls._register_builtin_processors()
        return cls._POST_PROCESSORS.get(name)

    @classmethod
    def _register_builtin_processors(cls):
        cls._POST_PROCESSORS["clean_amount"] = cls._clean_amount
        cls._POST_PROCESSORS["parse_date"] = cls._parse_date
        cls._POST_PROCESSORS["strip_whitespace"] = lambda s: s.strip()
        cls._POST_PROCESSORS["extract_digits"] = cls._extract_digits

    @staticmethod
    def _clean_amount(value: str) -> str:
        """Remove commas, currency symbols, colons; return clean number string."""
        cleaned = re.sub(r'[¥￥,:：\s]', '', value)
        try:
            f = float(cleaned)
            return f"{f:.2f}"
        except (ValueError, TypeError):
            return cleaned.strip()

    @staticmethod
    def _parse_date(value: str) -> str:
        """Normalize various date formats to YYYY-MM-DD."""
        # 2024年01月15日 → 2024-01-15
        m = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", value)
        if m:
            return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
        # 2024-01-15 or 2024/01/15 → 2024-01-15
        m = re.search(r"(\d{4})\D(\d{1,2})\D(\d{1,2})", value)
        if m:
            return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
        return value.strip()

    @staticmethod
    def _extract_digits(value: str) -> str:
        return "".join(c for c in value if c.isdigit())
