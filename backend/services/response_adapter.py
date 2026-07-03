from typing import Any, Dict, List

from contracts.document_layout import DocumentLayout
from contracts.extracted_field import ExtractedField


# Map internal field IDs to export-layer-compatible keys.
# The export layer (_normalize_invoice_for_export) tries internal IDs first,
# then falls back to these aliases. Injecting both guarantees recognition.
_FIELD_TO_EXPORT_KEY = {
    "type": "invoiceType",
    "fphm": "invoiceNumber",
    "kprq": "invoiceDate",
    "amountJe": "amountWithoutTax",
    "amountSe": "taxAmount",
    "amountHj": "totalAmount",
    "amountHjDx": "amountDx",
    "gmfmc": "buyerName",
    "gmfsh": "buyerTaxNo",
    "xsfmc": "sellerName",
    "xsfsh": "sellerTaxNo",
    "xmmc": "itemName",
    "note": "remark",
    "kpr": "issuer",
    "skr": "skr",
    "fhr": "fhr",
}


def _enrich_for_export(fields: dict) -> dict:
    """Return a new dict that includes both internal IDs and export aliases."""
    enriched = dict(fields)
    for internal_key, export_key in _FIELD_TO_EXPORT_KEY.items():
        if internal_key in enriched and export_key not in enriched:
            enriched[export_key] = enriched[internal_key]
    return enriched


class ResponseAdapter:
    @staticmethod
    def to_legacy_response(
        document_layout: DocumentLayout,
        extracted_fields: List[ExtractedField],
        correlation_id: str = "",
    ) -> Dict[str, Any]:
        """
        Convert vNext pipeline outputs into the legacy /parse_invoice response shape.
        """
        field_map = {field.field_id: field for field in extracted_fields}

        def get_val(field_id, default=None):
            field = field_map.get(field_id)
            return field.value if field and field.value is not None else default

        invoice_fields = {
            "type": get_val("type", ""),
            "fphm": get_val("fphm", ""),
            "kprq": get_val("kprq", ""),
            "gmfmc": get_val("gmfmc", ""),
            "gmfsh": get_val("gmfsh", ""),
            "xsfmc": get_val("xsfmc", ""),
            "xsfsh": get_val("xsfsh", ""),
            "amountJe": get_val("amountJe", 0),
            "amountSe": get_val("amountSe", 0),
            "amountHj": get_val("amountHj", 0),
            "amountHjDx": get_val("amountHjDx", ""),
            "xmmc": get_val("xmmc", ""),
            "note": get_val("note", ""),
            "skr": get_val("skr", ""),
            "fhr": get_val("fhr", ""),
            "kpr": get_val("kpr", ""),
        }

        # Enrich with export-compatible aliases
        invoice_fields = _enrich_for_export(invoice_fields)

        failed_fields = [field.field_id for field in extracted_fields if field.validator_status == "FAIL"]
        warning_fields = [field.field_id for field in extracted_fields if field.validator_status == "WARN"]

        critical = ["type", "fphm", "kprq"]  # 必要字段
        parse_success = all(invoice_fields.get(field_id) and field_id not in failed_fields for field_id in critical)

        line_items = field_map.get("line_items")
        line_items_data = line_items.value if line_items and line_items.value else []

        invoice_type = invoice_fields.get("type", "")
        invoice_number = invoice_fields.get("fphm", "")
        amount = invoice_fields.get("amountHj", 0)
        safe_name = f"{invoice_type}_{invoice_number}_{amount}"

        return {
            "invoiceType": invoice_type,
            "invoiceNumber": invoice_number,
            "amount": amount,
            "invoiceFields": invoice_fields,
            "lineItems": line_items_data,
            "failed_fields": failed_fields,
            "warning_fields": warning_fields,
            "parse_success": parse_success,
            "fileName": safe_name,
            "correlation_id": correlation_id,
            "confidence_scores": {field.field_id: field.confidence for field in extracted_fields},
            "field_statuses": {field.field_id: field.validator_status for field in extracted_fields},
        }
