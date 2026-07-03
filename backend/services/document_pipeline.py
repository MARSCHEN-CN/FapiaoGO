import hashlib
import logging
import os
import time
from typing import Any, Dict, Optional

from contracts.document_layout import BBox, DocumentLayout, Page, Region, Table
from crosscutting.audit_logger import AuditLogger
from crosscutting.feature_flags import FeatureFlags
from layout_domain.document_layout_builder import DocumentLayoutBuilder
from layout_domain.geometry_analyzer import GeometryAnalyzer, LegacyParserToTextLines
from quality_domain.confidence_engine import ConfidenceEngine
from quality_domain.decision_engine import DecisionEngine
from services.response_adapter import ResponseAdapter
from understanding_domain.extraction_adapter import ExtractionAdapter
from understanding_domain.fingerprint_builder import FingerprintBuilder
from understanding_domain.schema_registry import SchemaRegistry
from understanding_domain.template_matcher import TemplateMatcher
from understanding_domain.template_repository import TemplateRepository
from extraction_domain.rule_based_field_extractor import RuleBasedFieldExtractor
from validation_domain.field_validator import FieldValidator
from services.decision_router import DecisionRouter

logger = logging.getLogger(__name__)


class DocumentPipeline:
    """Top-level vNext orchestration pipeline."""

    def __init__(
        self,
        schemas_dir: str = None,
        templates_dir: str = None,
        feature_flags: FeatureFlags | None = None,
        audit_logger: AuditLogger | None = None,
    ):
        base = os.path.dirname(os.path.dirname(__file__))
        schemas_dir = schemas_dir or os.path.join(base, "schemas")
        templates_dir = templates_dir or os.path.join(base, "templates")

        self.schema_registry = SchemaRegistry(schemas_dir)
        self.template_repo = TemplateRepository(templates_dir)
        self.template_matcher = TemplateMatcher(self.template_repo)
        self.confidence_engine = ConfidenceEngine()
        self.decision_engine = DecisionEngine()
        self.feature_flags = feature_flags or FeatureFlags()
        self.audit_logger = audit_logger or AuditLogger()
        self.geometry_analyzer = GeometryAnalyzer()
        self.rule_extractor = RuleBasedFieldExtractor()
        self.field_validator = FieldValidator()
        self.decision_router = DecisionRouter()

    def _feature_flag_snapshot(self) -> dict[str, bool]:
        return {
            FeatureFlags.USE_VNEXT_PIPELINE: self.feature_flags.is_enabled(FeatureFlags.USE_VNEXT_PIPELINE),
            FeatureFlags.VNEXT_USE_GEOMETRY_ANALYZER: self.feature_flags.is_enabled(FeatureFlags.VNEXT_USE_GEOMETRY_ANALYZER),
            FeatureFlags.VNEXT_USE_NEW_FIELD_EXTRACTOR: self.feature_flags.is_enabled(FeatureFlags.VNEXT_USE_NEW_FIELD_EXTRACTOR),
            FeatureFlags.VNEXT_USE_FIELD_VALIDATOR: self.feature_flags.is_enabled(FeatureFlags.VNEXT_USE_FIELD_VALIDATOR),
            FeatureFlags.VNEXT_USE_DECISION_ROUTER: self.feature_flags.is_enabled(FeatureFlags.VNEXT_USE_DECISION_ROUTER),
        }

    @staticmethod
    def _guess_type_from_text(raw_text: str) -> str:
        """
        从原始文本快速猜测发票类型，用于模板匹配（不依赖旧管道字段提取结果）。
        仅做关键词匹配，速度极快。
        """
        if not raw_text:
            return ""
        text = raw_text[:2000]
        if "电子发票" in text and "普通发票" in text:
            return "电子发票"
        if "电子发票" in text and "专用发票" in text:
            return "电子发票"
        if "电子发票" in text:
            return "电子发票"
        if "增值税专用发票" in text:
            return "专票"
        if "增值税普通发票" in text:
            return "普票"
        if "机动车销售统一发票" in text:
            return "机动车"
        if "二手车销售统一发票" in text:
            return "二手车"
        if "通行费" in text:
            return "通行费"
        return ""

    def process_with_legacy_result(
        self,
        file_bytes: bytes,
        file_name: str,
        legacy_invoice_fields: Dict[str, Any],
        legacy_field_meta: Optional[Dict[str, Any]] = None,
        legacy_raw_text: str = "",
        legacy_bbox_data: Optional[list] = None,
        source_type: str = "",
        precomputed_legacy_result: Optional[Dict[str, Any]] = None,
        correlation_id: str = "",
        legacy_warning_fields: Optional[list[Dict[str, Any]]] = None,
        precomputed_file_hash: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Transitional end-to-end path using legacy extraction results.
        
        Args:
            legacy_bbox_data: 传入 bbox_data（避免 GEOMETRY 阶段退化为 dummy bbox）
            source_type: 来源类型 (pdf_text/pdf_ocr/image/ofd/xml)
            precomputed_legacy_result: 旧管道已提取好的完整字段结果，传入后避免重复调用 extract_fields()
            precomputed_file_hash: 预计算的文件 SHA-256 哈希（避免重复计算）
        """
        _vnext_start = time.time()
        logger.info("[VNEXT PIPELINE] 开始处理文件: %s, 旧字段数: %d, 有bbox=%s, source_type=%s",
                     file_name, len(legacy_invoice_fields),
                     bool(legacy_bbox_data), source_type)
        logger.debug("FeatureFlags: USE_VNEXT_PIPELINE=%s, GEOMETRY=%s, NEW_EXTRACTOR=%s, VALIDATOR=%s",
                     self.feature_flags.is_enabled(FeatureFlags.USE_VNEXT_PIPELINE),
                     self.feature_flags.is_enabled(FeatureFlags.VNEXT_USE_GEOMETRY_ANALYZER),
                     self.feature_flags.is_enabled(FeatureFlags.VNEXT_USE_NEW_FIELD_EXTRACTOR),
                     self.feature_flags.is_enabled(FeatureFlags.VNEXT_USE_FIELD_VALIDATOR))

        # 复用预计算的 file_hash，避免重复 SHA-256 计算
        if precomputed_file_hash:
            file_hash = precomputed_file_hash
            logger.debug("[VNEXT] 复用预计算 file_hash (跳过 SHA-256 计算)")
        else:
            file_hash = hashlib.sha256(file_bytes).hexdigest()
        document_id = file_hash[:16]
        if not correlation_id:
            correlation_id = document_id

        # ====== PARSE ======
        parse_output_hash = hashlib.sha256(
            repr({
                "file_name": file_name,
                "field_keys": sorted(legacy_invoice_fields.keys()),
                "warning_count": len(legacy_warning_fields or []),
            }).encode()
        ).hexdigest()
        self.audit_logger.log_event(
            correlation_id=correlation_id, document_id=document_id,
            stage="PARSE",
            input_hash=file_hash, output_hash=parse_output_hash,
            context={"duration_ms": 0, "file_name": file_name},
            status="SUCCESS",
        )

        # ====== CLEAN (TextNormalizer 已在 extract_fields 中清洗) ======
        clean_start = time.time()
        # legacy_raw_text 已由 TextNormalizer 清洗（包含关键词合并、OCR 纠错、垂直文字合并）
        cleaned_raw_text = legacy_raw_text
        blocks = [{"text": cleaned_raw_text, "bbox": (0, 0, 100, 20), "page": 1}]
        clean_output_hash = hashlib.sha256(cleaned_raw_text.encode()).hexdigest()
        self.audit_logger.log_event(
            correlation_id=correlation_id, document_id=document_id,
            stage="CLEAN",
            input_hash=parse_output_hash, output_hash=clean_output_hash,
            context={"duration_ms": round((time.time() - clean_start) * 1000, 2)},
            status="SUCCESS",
        )

        # ====== GEOMETRY (GeometryAnalyzer) ======
        geo_start = time.time()
        geometry_report = None
        if self.feature_flags.is_enabled(FeatureFlags.VNEXT_USE_GEOMETRY_ANALYZER):
            logger.info("[VNEXT] GEOMETRY 阶段开始（几何布局分析）")
            adapter = LegacyParserToTextLines()
            # 优先使用传入的 bbox_data（真正的坐标信息），而不是从 legacy_invoice_fields 猜测
            geo_input = {}
            if legacy_bbox_data:
                geo_input = {"bbox_data": legacy_bbox_data}
            else:
                geo_input = legacy_invoice_fields
            text_lines = adapter.convert(geo_input)
            if not text_lines and legacy_raw_text:
                text_lines = adapter.convert({"raw_text": legacy_raw_text})
            # 调试：打印前3行确认bbox正确解析
            if text_lines:
                sample = []
                for i, tl in enumerate(text_lines[:5]):
                    sample.append(f"'{tl.text[:20]}' bbox=({tl.bbox.x0:.0f},{tl.bbox.y0:.0f},{tl.bbox.x1:.0f},{tl.bbox.y1:.0f})")
                logger.debug("[VNEXT] GEOMETRY text_lines 样本(%d行): %s", len(text_lines), ' | '.join(sample))
            geometry_report = self.geometry_analyzer.analyze(text_lines)
            geo_ms = round((time.time() - geo_start) * 1000, 2)
            logger.info("[VNEXT] GEOMETRY 完成: %d 行, %d 区域, %d 对齐组, 耗时 %.2fms",
                         len(geometry_report.lines),
                         len(geometry_report.region_proposals),
                         len(geometry_report.aligned_groups), geo_ms)
            geo_output_hash = hashlib.sha256(repr(geometry_report).encode()).hexdigest()
            self.audit_logger.log_event(
                correlation_id=correlation_id, document_id=document_id,
                stage="GEOMETRY",
                input_hash=clean_output_hash, output_hash=geo_output_hash,
                context={"duration_ms": round((time.time() - geo_start) * 1000, 2)},
                status="SUCCESS",
            )
        else:
            logger.debug("VNEXT_USE_GEOMETRY_ANALYZER=OFF — 跳过几何分析")
            geo_output_hash = clean_output_hash
            self.audit_logger.log_event(
                correlation_id=correlation_id, document_id=document_id,
                stage="GEOMETRY",
                input_hash=clean_output_hash, output_hash=geo_output_hash,
                context={"duration_ms": 0},
                status="SKIPPED",
            )

        # ====== LAYOUT ======
        layout_start = time.time()
        if geometry_report is not None:
            logger.debug("使用 build_from_geometry 构建 DocumentLayout")
            doc_layout = DocumentLayoutBuilder.build_from_geometry(
                geometry_report, document_id=document_id,
                metadata={"file_name": file_name},
            )
        else:
            logger.debug("使用 from_pdf_text_blocks 构建 DocumentLayout")
            doc_layout = DocumentLayoutBuilder.from_pdf_text_blocks(blocks, document_id)
        
        layout_ms = round((time.time() - layout_start) * 1000, 2)
        logger.info("[VNEXT] LAYOUT 完成: %d 个区域, 耗时 %.2fms", len(doc_layout.regions), layout_ms)
        for i, r in enumerate(doc_layout.regions):
            if r.text and r.text.strip():
                logger.debug("  区域[%d] type=%s bbox=(%.0f,%.0f,%.0f,%.0f) text='%s...'",
                             i, r.type, r.bbox.x0, r.bbox.y0, r.bbox.x1, r.bbox.y1,
                             r.text[:40].replace('\n', ' '))

        layout_output_hash = hashlib.sha256(repr(doc_layout).encode()).hexdigest()
        self.audit_logger.log_event(
            correlation_id=correlation_id, document_id=document_id,
            stage="LAYOUT",
            input_hash=geo_output_hash, output_hash=layout_output_hash,
            context={"duration_ms": round((time.time() - layout_start) * 1000, 2)},
            status="SUCCESS",
        )

        # ====== FINGERPRINT (SKIPPED - 单一模板不需要指纹匹配) ======
        match_start = time.time()
        fingerprint_hash = layout_output_hash
        self.audit_logger.log_event(
            correlation_id=correlation_id, document_id=document_id,
            stage="FINGERPRINT",
            input_hash=layout_output_hash, output_hash=fingerprint_hash,
            context={"duration_ms": 0, "skipped": True, "reason": "single_template_mode"},
            status="SKIPPED",
        )

        # ====== TEMPLATE (直接使用 digital_invoice v1，不再做匹配) ======
        logger.info("[VNEXT] TEMPLATE: 直接使用 digital_invoice v1")
        template = self.template_repo.get_active_template("digital_invoice")
        
        if template is None:
            logger.error("[VNEXT] TEMPLATE 错误: digital_invoice 模板未找到")
            route_result = self.decision_router.route_exception(
                correlation_id=correlation_id, document_id=document_id,
                file_name=file_name, reason="digital_invoice 模板未找到",
            )
            return {
                "invoiceType": "", "invoiceNumber": "", "amount": 0,
                "invoiceFields": {}, "lineItems": [],
                "failed_fields": [], "warning_fields": [],
                "parse_success": False, "fileName": file_name,
                "correlation_id": correlation_id,
                "status": "template_miss",
                "route_status": route_result["status"],
            }
        
        logger.debug("[VNEXT] TEMPLATE 加载成功: %s v%d, 规则数: %d",
                     template.template_id, template.version, len(template.extraction_rules))
        template_ms = round((time.time() - match_start) * 1000, 2)
        logger.info("[VNEXT] TEMPLATE 完成, 耗时 %.2fms", template_ms)
        
        template_output_hash = hashlib.sha256(repr({
            "template_id": template.template_id,
            "template_version": template.version,
        }).encode()).hexdigest()
        self.audit_logger.log_event(
            correlation_id=correlation_id, document_id=document_id,
            stage="TEMPLATE",
            input_hash=fingerprint_hash, output_hash=template_output_hash,
            context={"duration_ms": template_ms, "direct_load": True},
            status="SUCCESS",
        )

        # ====== EXTRACT ======
        extraction_start = time.time()
        meta_field_keys = {"confidence", "field_meta", "warning_fields", "failed_fields"}
        filtered_legacy_fields = {
            key: value for key, value in legacy_invoice_fields.items() if key not in meta_field_keys
        }
        if self.feature_flags.is_enabled(FeatureFlags.VNEXT_USE_NEW_FIELD_EXTRACTOR):
            rules = template.extraction_rules if template else []
            if rules:
                logger.info("[VNEXT] EXTRACT 阶段开始（规则提取），%d 条规则", len(rules))
                schema = None
                try:
                    schema = self.schema_registry.get_schema(
                        template.schema_id, template.schema_version
                    )
                except Exception:
                    pass
                extracted_fields = self.rule_extractor.extract_with_fallback(
                    document=doc_layout, rules=rules, schema=schema,
                    legacy_input={
                        "raw_text": legacy_raw_text,
                        "bbox_data": legacy_bbox_data or [],
                        "source_type": source_type or "pdf_text",
                        "auxiliary_blocks": [],
                        "precomputed_legacy_result": precomputed_legacy_result,
                    },
                )
                extract_ms = round((time.time() - extraction_start) * 1000, 2)
                logger.info("[VNEXT] EXTRACT 完成: %d 个字段, 耗时 %.2fms — %s",
                             len(extracted_fields), extract_ms,
                             [f.field_id + '=' + str(f.value or '')[:30] for f in extracted_fields])
            else:
                logger.debug("VNEXT_USE_NEW_FIELD_EXTRACTOR=ON 但模板无规则 — 回退")
                extracted_fields = ExtractionAdapter.from_legacy_result(
                    filtered_legacy_fields, legacy_field_meta
                )
        else:
            logger.debug("VNEXT_USE_NEW_FIELD_EXTRACTOR=OFF — 使用旧 ExtractionAdapter")
            extracted_fields = ExtractionAdapter.from_legacy_result(
                filtered_legacy_fields, legacy_field_meta
            )

        extract_output_hash = hashlib.sha256(repr(extracted_fields).encode()).hexdigest()
        # DEBUG: 追踪 amount 字段值
        for f in extracted_fields:
            if f.field_id in ('amountHj', 'amountJe', 'amountHjDx', 'amountSe'):
                logger.debug("[VNEXT EXTRACT] %s = %r", f.field_id, f.value)
        self.audit_logger.log_event(
            correlation_id=correlation_id, document_id=document_id,
            stage="EXTRACT",
            input_hash=template_output_hash, output_hash=extract_output_hash,
            context={"duration_ms": round((time.time() - extraction_start) * 1000, 2)},
            status="SUCCESS",
        )

        # ====== QUALITY (Confidence → Decision → Validate) ======
        quality_start = time.time()
        merged = self.confidence_engine.merge(extracted_fields)
        logger.debug("ConfidenceEngine.merge 完成, %d 个字段", len(merged))

        # 第一步：DecisionEngine 根据置信度设置初始状态
        decided = self.decision_engine.evaluate(merged)
        logger.debug("DecisionEngine: PASS=%d, WARN=%d, FAIL=%d",
                     sum(1 for f in decided if f.validator_status == 'PASS'),
                     sum(1 for f in decided if f.validator_status == 'WARN'),
                     sum(1 for f in decided if f.validator_status == 'FAIL'))

        decision_output_hash = hashlib.sha256(repr(decided).encode()).hexdigest()
        self.audit_logger.log_event(
            correlation_id=correlation_id, document_id=document_id,
            stage="DECISION",
            input_hash=extract_output_hash, output_hash=decision_output_hash,
            context={"duration_ms": round((time.time() - quality_start) * 1000, 2)},
            status="SUCCESS",
        )

        # 第二步：FieldValidator 校验必填字段等，其 FAIL 结果不可被覆盖
        # （因此 FieldValidator 必须放在 DecisionEngine 之后执行）
        if self.feature_flags.is_enabled(FeatureFlags.VNEXT_USE_FIELD_VALIDATOR):
            logger.debug("VNEXT_USE_FIELD_VALIDATOR=ON — 正在校验字段")
            try:
                schema = self.schema_registry.get_schema(
                    template.schema_id, template.schema_version
                )
                validation_results = self.field_validator.validate(decided, schema)
                logger.debug("FieldValidator 完成: %d 条校验, %d 条失败",
                             len(validation_results),
                             sum(1 for v in validation_results if not v.passed))
                for vr in validation_results:
                    if not vr.passed:
                        logger.debug("  [VALIDATION FAIL] %s: %s", vr.field_name, vr.message)
                for vr in validation_results:
                    for field in decided:
                        if field.field_id == vr.field_name:
                            if field.evidence is None:
                                field.evidence = {}
                            if "validation" not in field.evidence:
                                field.evidence["validation"] = []
                            field.evidence["validation"].append({
                                "rule": vr.rule_checked,
                                "passed": vr.passed,
                                "message": vr.message,
                            })
            except Exception as e:
                logger.debug("FieldValidator 异常: %s", e)

            # ── 同步 validator_status 与 FieldValidator 更新后的 field.state ──
            # DecisionEngine 在 FieldValidator 之前运行，validator_status
            # 仅反映初始 state。FieldValidator 可能将 state 改为 INVALID/MISSING，
            # 这里重新同步，确保响应中的 validator_status 与最终 state 一致。
            _STATE_TO_STATUS = {
                'VALID': 'PASS', 'CORRECTED': 'WARN',
                'INVALID': 'FAIL', 'MISSING': 'FAIL',
            }
            for field in decided:
                if field.state is not None:
                    new_status = _STATE_TO_STATUS.get(field.state, 'PASS')
                    # 仅升级（PASS→WARN/FAIL、WARN→FAIL），不降级
                    _rank = {'PASS': 0, 'WARN': 1, 'FAIL': 2}
                    if _rank.get(new_status, 0) > _rank.get(field.validator_status, 0):
                        field.validator_status = new_status
            validate_output_hash = hashlib.sha256(repr(validation_results if 'validation_results' in dir() else []).encode()).hexdigest()
        else:
            logger.debug("VNEXT_USE_FIELD_VALIDATOR=OFF — 跳过字段校验")
            validate_output_hash = decision_output_hash

        # FieldValidator audit
        v_status = "SUCCESS" if self.feature_flags.is_enabled(FeatureFlags.VNEXT_USE_FIELD_VALIDATOR) else "SKIPPED"
        self.audit_logger.log_event(
            correlation_id=correlation_id, document_id=document_id,
            stage="VALIDATE",
            input_hash=decision_output_hash, output_hash=validate_output_hash,
            context={"duration_ms": round((time.time() - quality_start) * 1000, 2)},
            status=v_status,
        )

        # ====== ROUTE ======
        route_result = None
        if self.feature_flags.is_enabled(FeatureFlags.VNEXT_USE_DECISION_ROUTER):
            route_result = self.decision_router.route(
                fields=decided, correlation_id=correlation_id,
                document_id=document_id, file_name=file_name,
            )
            logger.debug("路由结果: %s — %s", route_result['status'], route_result['reason'])
            route_status = route_result['status']
        else:
            logger.debug("VNEXT_USE_DECISION_ROUTER=OFF — 跳过路由")
            route_status = "SKIPPED"

        route_output_hash = hashlib.sha256(repr(route_result or {}).encode()).hexdigest()
        r_status = "SUCCESS" if route_result else "SKIPPED"
        self.audit_logger.log_event(
            correlation_id=correlation_id, document_id=document_id,
            stage="ROUTE",
            input_hash=decision_output_hash, output_hash=route_output_hash,
            context={"duration_ms": 0},
            status=r_status,
        )

        # Legacy warnings
        legacy_warnings = legacy_warning_fields or []
        for warning in legacy_warnings:
            field_id = warning.get("field") or warning.get("field_id")
            reason = warning.get("reason", "")
            if not field_id:
                continue
            for field in decided:
                if field.field_id == field_id:
                    if field.validator_status == "PASS":
                        field.validator_status = "WARN"
                    if field.evidence is None:
                        field.evidence = {}
                    field.evidence["legacy_warning"] = reason
                    break

        # Response
        response = ResponseAdapter.to_legacy_response(
            document_layout=doc_layout, extracted_fields=decided,
            correlation_id=correlation_id,
        )
        if legacy_warnings:
            response["warning_fields"] = legacy_warnings

        if route_result:
            response["route_status"] = route_result["status"]
            response["route_reason"] = route_result["reason"]
        
        vnext_total_ms = round((time.time() - _vnext_start) * 1000, 2)
        logger.info("[VNEXT PIPELINE] 完成, 总耗时 %.2fms", vnext_total_ms)
        return response


