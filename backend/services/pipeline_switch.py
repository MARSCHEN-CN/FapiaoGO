import logging
from crosscutting.feature_flags import FeatureFlags
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class PipelineSwitch:
    """
    Feature Flag for switching between legacy and vNext pipelines.
    Reads from config/features.yml via FeatureFlags (USE_VNEXT_PIPELINE).
    """

    _new_pipeline = None

    @staticmethod
    def is_vnext_enabled() -> bool:
        return FeatureFlags.get_instance().is_enabled("USE_VNEXT_PIPELINE")

    @staticmethod
    def get_new_pipeline():
        if PipelineSwitch._new_pipeline is None:
            from services.document_pipeline import DocumentPipeline

            PipelineSwitch._new_pipeline = DocumentPipeline()
            logger.info("VNext DocumentPipeline initialized (lazy)")
        return PipelineSwitch._new_pipeline

    @staticmethod
    def process_via_vnext(
        file_bytes: bytes,
        file_name: str,
        legacy_invoice_fields: Dict[str, Any],
        legacy_field_meta: Optional[Dict[str, Any]] = None,
        correlation_id: str = "",
    ) -> Dict[str, Any]:
        """
        Process through the vNext pipeline and return a legacy-compatible response.
        """
        pipeline = PipelineSwitch.get_new_pipeline()
        return pipeline.process_with_legacy_result(
            file_bytes=file_bytes,
            file_name=file_name,
            legacy_invoice_fields=legacy_invoice_fields,
            legacy_field_meta=legacy_field_meta,
            correlation_id=correlation_id,
        )
