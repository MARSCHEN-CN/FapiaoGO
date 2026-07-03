"""
FieldValidator — validate extracted fields against Schema field definitions.

Validates:
  - presence: field must exist and have a non-empty value
  - type: value must be compatible with declared type
  - pattern (RegexValidator): value must match regex pattern
  - range (RangeValidator): numeric value within [min, max]

Outputs ValidationResult list AND sets ExtractedField.state on failures.
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from contracts.extracted_field import ExtractedField
from contracts.schema import FieldDefinition, RangeValidator, RegexValidator, Schema

logger = logging.getLogger(__name__)


@dataclass
class ValidationResult:
    """Result of validating a single field against a single rule."""
    field_name: str
    passed: bool
    rule_checked: str  # e.g. "presence", "type", "pattern", "range"
    message: str = ""


class FieldValidator:
    """Validate extracted fields against a Schema definition."""

    def validate(
        self,
        fields: List[ExtractedField],
        schema: Schema,
    ) -> List[ValidationResult]:
        """
        Validate each extracted field against its Schema FieldDefinition.

        Mutates: sets field.state = "INVALID" for failed fields,
                 field.state = "VALID" for passed fields,
                 field.state = "MISSING" for missing fields.

        Returns: list of ValidationResult (one per rule checked).
        """
        results: List[ValidationResult] = []

        # Build field-def lookup from schema
        field_defs: Dict[str, FieldDefinition] = {}
        for fd in schema.fields:
            field_defs[fd.id] = fd

        # Build field value lookup
        field_values: Dict[str, Any] = {}
        for field in fields:
            field_values[field.field_id] = field.value

        # First pass: mark MISSING fields
        for fd_id, fd in field_defs.items():
            found = False
            for field in fields:
                if field.field_id == fd_id:
                    found = True
                    break
            if not found:
                # 只有必填字段缺失时才创建 MISSING 占位符
                if fd.required:
                    fields.append(ExtractedField(
                        field_id=fd_id,
                        value=None,
                        state="MISSING",
                        source="RULE",  # Mark as from RULE since it's schema-defined
                        validator_status="FAIL",
                    ))
                # 非必填字段缺失 → 跳过，不创建占位符

        for field in fields:
            fd = field_defs.get(field.field_id)
            if fd is None:
                # No schema definition for this field → mark as VALID
                if field.state is None:
                    field.state = "VALID"
                continue

            # Skip validation for MISSING fields - they should remain MISSING
            if field.state == "MISSING":
                continue

            # Initialize state as VALID, will be set to INVALID if any check fails
            if field.state is None:
                field.state = "VALID"

            # 1) presence check
            result = self._check_presence(field, fd)
            results.append(result)
            if not result.passed:
                field.state = "INVALID"

            # 2) type check
            result = self._check_type(field, fd)
            results.append(result)
            if not result.passed:
                field.state = "INVALID"

            # 3) validators (regex, range)
            for validator in fd.validators:
                result = self._check_validator(field, fd, validator)
                results.append(result)
                if not result.passed:
                    field.state = "INVALID"

        # 4) Cross-field: uppercase amount consistency (amountHj ↔ amountHjDx)
        cross_result = self._check_uppercase_amount(field_values)
        if cross_result:
            results.append(cross_result)
            if not cross_result.passed:
                for field in fields:
                    if field.field_id == "amountHj" or field.field_id == "amountHjDx":
                        field.state = "INVALID"

        return results

    # ── individual checks ──────────────────────────────────────────────

    @staticmethod
    def _check_presence(field: ExtractedField, fd: FieldDefinition) -> ValidationResult:
        value = field.value
        if value is None or (isinstance(value, str) and value.strip() == ""):
            # 非必填字段的空值是合法的
            if not fd.required:
                return ValidationResult(
                    field_name=fd.id,
                    passed=True,
                    rule_checked="presence",
                    message="",
                )
            return ValidationResult(
                field_name=fd.id,
                passed=False,
                rule_checked="presence",
                message=f"字段 '{fd.id}' 值为空",
            )
        return ValidationResult(
            field_name=fd.id,
            passed=True,
            rule_checked="presence",
            message="",
        )

    @staticmethod
    def _check_type(field: ExtractedField, fd: FieldDefinition) -> ValidationResult:
        value = field.value
        if value is None:
            return ValidationResult(
                field_name=fd.id,
                passed=True,  # skip type check on None (required check covers it)
                rule_checked="type",
                message="",
            )

        str_val = str(value).strip()
        passed = True
        reason = ""

        if fd.type == "number":
            try:
                float(str_val)
            except (ValueError, TypeError):
                passed = False
                reason = f"字段 '{fd.id}' 类型为 number，值 '{str_val}' 无法解析为数字"
        elif fd.type == "date":
            # Accept YYYY-MM-DD, YYYY年MM月DD日, etc.
            if not re.search(r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}", str_val):
                passed = False
                reason = f"字段 '{fd.id}' 类型为 date，值 '{str_val}' 不符合日期格式"
        elif fd.type == "currency":
            # Must be parseable as a number
            cleaned = str_val.replace(",", "").replace("¥", "").replace("￥", "").strip()
            try:
                float(cleaned)
            except (ValueError, TypeError):
                passed = False
                reason = f"字段 '{fd.id}' 类型为 currency，值 '{str_val}' 无法解析为金额"
        # string — always passes type check

        return ValidationResult(
            field_name=fd.id,
            passed=passed,
            rule_checked="type",
            message=reason,
        )

    @staticmethod
    def _check_validator(
        field: ExtractedField,
        fd: FieldDefinition,
        validator: Any,
    ) -> ValidationResult:
        value = field.value
        if value is None:
            rule = "pattern" if isinstance(validator, RegexValidator) else "range"
            return ValidationResult(
                field_name=fd.id, passed=True, rule_checked=rule, message="",
            )

        str_val = str(value)

        # 非必填字段的空值跳过正则/范围校验
        if not fd.required and (value is None or (isinstance(value, str) and value.strip() == "")):
            rule = "pattern" if isinstance(validator, RegexValidator) else "range"
            return ValidationResult(
                field_name=fd.id, passed=True, rule_checked=rule, message="",
            )
        
        if isinstance(validator, RegexValidator) and validator.pattern:
            try:
                matches = bool(re.match(validator.pattern, str_val))
            except re.error:
                matches = False
            if not matches:
                msg = validator.message or f"字段 '{fd.id}' 不匹配正则: {validator.pattern}"
                return ValidationResult(
                    field_name=fd.id, passed=False,
                    rule_checked="pattern", message=msg,
                )
            return ValidationResult(
                field_name=fd.id, passed=True, rule_checked="pattern", message="",
            )

        elif isinstance(validator, RangeValidator):
            try:
                num_val = float(str_val.replace(",", "").replace("¥", "").replace("￥", ""))
            except (ValueError, TypeError):
                return ValidationResult(
                    field_name=fd.id, passed=True,
                    rule_checked="range",
                    message="无法解析为数字，跳过范围校验",
                )
            if validator.min is not None and num_val < float(validator.min):
                msg = validator.message or f"字段 '{fd.id}' 值 {num_val} 低于最小值 {validator.min}"
                return ValidationResult(
                    field_name=fd.id, passed=False,
                    rule_checked="range", message=msg,
                )
            if validator.max is not None and num_val > float(validator.max):
                msg = validator.message or f"字段 '{fd.id}' 值 {num_val} 超过最大值 {validator.max}"
                return ValidationResult(
                    field_name=fd.id, passed=False,
                    rule_checked="range", message=msg,
                )
            return ValidationResult(
                field_name=fd.id, passed=True, rule_checked="range", message="",
            )

        return ValidationResult(
            field_name=fd.id, passed=True, rule_checked="unknown", message="",
        )

    @staticmethod
    def _check_uppercase_amount(field_values: Dict[str, Any]) -> Optional[ValidationResult]:
        """
        Cross-field validation: ensure amountHjDx (Chinese uppercase) matches
        amountHj (digit amount).  Parses amountHjDx back to a number for
        numeric comparison, avoiding false positives from upstream data corruption.
        """
        hj = field_values.get("amountHj")
        je = field_values.get("amountJe")
        dx = field_values.get("amountHjDx")
        logger.debug("[FieldValidator] 大写校验: amountHj=%r amountJe=%r amountHjDx=%r", hj, je, dx)
        if not hj or not dx:
            return None

        # 方案A：将 amountHj 转为大写，与大写字符串比较
        try:
            from field_extractor import to_chinese_amount
            expected = to_chinese_amount(str(hj))
        except Exception:
            expected = None

        if expected:
            def _normalize(s: str) -> str:
                return s.replace(" ", "").replace("圆", "元").replace("正", "整").replace("零元", "元")
            expected_norm = _normalize(expected)
            dx_norm = _normalize(str(dx))
            if expected_norm == dx_norm:
                return ValidationResult(
                    field_name="amountHjDx", passed=True, rule_checked="cross_field", message="",
                )

        # 方案B：如果字符串比较失败，尝试将 amountHjDx 解析回数字，与 amountHj 数值比较
        # 这样可以避免上游 amountHj 被错误覆盖的情况
        try:
            # 复用 field_extractor 的 _parse_chinese_amount
            from field_extractor.validators import InvoiceValidator
            dx_value = InvoiceValidator._parse_chinese_amount(str(dx))
            if dx_value is not None:
                try:
                    hj_value = float(str(hj).replace(",", "").replace("¥", "").replace("￥", ""))
                except (ValueError, TypeError):
                    hj_value = None
                if hj_value is not None and abs(abs(dx_value) - abs(hj_value)) <= 0.5:
                    return ValidationResult(
                        field_name="amountHjDx", passed=True, rule_checked="cross_field", message="",
                    )
        except Exception:
            pass

        return ValidationResult(
            field_name="amountHjDx",
            passed=False,
            rule_checked="cross_field",
            message=f"大写金额不一致: 小写 {hj} 应转为 '{expected or '?'}', 实际提取 '{dx}'",
        )
