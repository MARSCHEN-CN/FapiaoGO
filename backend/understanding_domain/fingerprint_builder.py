from typing import Any, Dict

from contracts.document_layout import DocumentLayout


class FingerprintBuilder:
    @staticmethod
    def build(doc: DocumentLayout) -> Dict[str, Any]:
        """Build a fingerprint dictionary from DocumentLayout."""
        table_count = len(doc.tables)
        region_count = len(doc.regions)
        region_types = list(set(region.type for region in doc.regions))
        return {
            "structural": {
                "table_count": table_count,
                "region_count": region_count,
                "region_types": region_types,
            },
            "visual": {
                "simhash": "",
                "embedding": [],
            },
        }
