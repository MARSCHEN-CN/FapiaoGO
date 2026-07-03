from typing import Dict, List, Optional

from contracts.document_layout import BBox, DocumentLayout, Page, Region, Table
from contracts.geometry_domain import GeometryReport, RegionProposal, TextLine
from layout_domain.coordinate_utils import from_ocr_bbox, from_points


class DocumentLayoutBuilder:
    """Build a standard DocumentLayout from various legacy outputs."""

    @staticmethod
    def from_ocr_result(ocr_result, document_id: str) -> DocumentLayout:
        """
        Convert backend.ocr_models.OCRResult -> DocumentLayout.
        ocr_result: an instance of OCRResult (with .pages list of OCRPage).
        """
        regions = []
        pages = []
        region_id = 0
        for ocr_page in ocr_result.pages:
            page_regions = []
            for line in ocr_page.lines:
                region_id += 1
                rid = f"R{region_id}"
                bbox = from_ocr_bbox(line.bbox) if line.bbox else BBox(0, 0, 0, 0)
                region = Region(
                    id=rid,
                    source={"extractor": "ocr", "page": ocr_page.page_number},
                    bbox=bbox,
                    type="text",
                    text=line.text,
                )
                regions.append(region)
                page_regions.append(rid)
            pages.append(
                Page(
                    page_number=ocr_page.page_number,
                    width=0,
                    height=0,
                    regions=page_regions,
                )
            )
        return DocumentLayout(
            document_id=document_id,
            pages=pages,
            regions=regions,
        )

    @staticmethod
    def from_pdf_text_blocks(blocks: list, document_id: str) -> DocumentLayout:
        """
        Convert list of dicts (e.g., from PyMuPDF) -> DocumentLayout.
        Each block dict expected to have: 'text', 'bbox' (x1,y1,x2,y2), 'page'.
        """
        regions = []
        pages_dict = {}
        for i, block in enumerate(blocks):
            rid = f"R{i + 1}"
            bbox = from_points(
                block["bbox"][0],
                block["bbox"][1],
                block["bbox"][2],
                block["bbox"][3],
            )
            page_num = block.get("page", 1)
            region = Region(
                id=rid,
                source={"extractor": "pdf", "page": page_num},
                bbox=bbox,
                type="text",
                text=block.get("text", ""),
            )
            regions.append(region)
            pages_dict.setdefault(page_num, []).append(rid)

        pages = [
            Page(page_number=page_number, width=0, height=0, regions=region_ids)
            for page_number, region_ids in sorted(pages_dict.items())
        ]
        return DocumentLayout(
            document_id=document_id,
            pages=pages,
            regions=regions,
        )

    @staticmethod
    def from_ofd_xml_fields(fields: list, document_id: str) -> DocumentLayout:
        """
        Convert structured field list from OFD/XML -> DocumentLayout.
        Each field: {'name':..., 'value':..., 'page':..., 'bbox': (x1,y1,x2,y2) optional}
        """
        regions = []
        pages_dict = {}
        for i, field in enumerate(fields):
            rid = f"R{i + 1}"
            bbox = BBox(0, 0, 0, 0)
            if field.get("bbox"):
                bbox = from_points(*field["bbox"])
            page_num = field.get("page", 1)
            region = Region(
                id=rid,
                source={"extractor": field.get("source", "xml"), "page": page_num},
                bbox=bbox,
                type="text",
                text=f"{field.get('name', '')}: {field.get('value', '')}",
            )
            regions.append(region)
            pages_dict.setdefault(page_num, []).append(rid)

        pages = [
            Page(page_number=page_number, width=0, height=0, regions=region_ids)
            for page_number, region_ids in sorted(pages_dict.items())
        ]
        return DocumentLayout(
            document_id=document_id,
            pages=pages,
            regions=regions,
        )

    # ── GeometryReport-based build (vNext path) ───────────────────────

    @staticmethod
    def build_from_geometry(
        geometry_report: GeometryReport,
        document_id: str = "geo",
        metadata: dict = None,
    ) -> DocumentLayout:
        """
        Build a DocumentLayout from a GeometryReport (produced by GeometryAnalyzer).

        Mapping:
          - Each TextLine -> Region with type="text", bbox from TextLine.bbox
          - Regions are assigned a `role` (header/body/footer/table) based on
            which RegionProposal contains the line (by y-coordinate overlap).
          - Regions are grouped by page_num -> Page objects.
          - Table proposals -> Table entries referencing the corresponding Region IDs.
          - Column proposals are stored in metadata.
        """
        from collections import defaultdict

        metadata_ = metadata or {}
        regions: List[Region] = []
        pages_dict: Dict[int, List[str]] = defaultdict(list)
        region_id = 0

        # Build a lookup: y-range -> role from region_proposals
        role_lookup: List[tuple] = []
        for rp in geometry_report.region_proposals:
            role_lookup.append((rp.y_start, rp.y_end, rp.region_type))

        def _find_role(tl: TextLine) -> Optional[str]:
            """Determine which region role a TextLine belongs to by y overlap."""
            y_mid = tl.bbox.y + tl.bbox.height / 2.0
            for y_start, y_end, rtype in role_lookup:
                if y_start <= y_mid < y_end:
                    return rtype
            return None

        # Build table-line set for quick lookup
        table_line_ids: set = set()
        table_proposal_regions: List[tuple] = []

        for rp in geometry_report.region_proposals:
            if rp.region_type == "table":
                tids: List[str] = []
                for tl in rp.lines:
                    region_id += 1
                    rid = f"R{region_id}"
                    tids.append(rid)
                    table_line_ids.add(id(tl))
                    page_num = tl.page_num
                    region = Region(
                        id=rid,
                        source={"extractor": "geometry_analyzer", "page": page_num},
                        bbox=BBox(tl.bbox.x, tl.bbox.y, tl.bbox.width, tl.bbox.height),
                        type="text",
                        text=tl.text,
                        role="table",
                    )
                    regions.append(region)
                    pages_dict[page_num].append(rid)
                table_proposal_regions.append((rp, tids))

        # Convert remaining lines (non-table) to Regions
        for tl in geometry_report.lines:
            if id(tl) in table_line_ids:
                continue

            region_id += 1
            rid = f"R{region_id}"
            page_num = tl.page_num
            role = _find_role(tl)

            region = Region(
                id=rid,
                source={"extractor": "geometry_analyzer", "page": page_num},
                bbox=BBox(tl.bbox.x, tl.bbox.y, tl.bbox.width, tl.bbox.height),
                type="text",
                text=tl.text,
                role=role,  # type: ignore[arg-type]
            )
            regions.append(region)
            pages_dict[page_num].append(rid)

        # Build Page objects
        pages = [
            Page(page_number=page_num, width=0, height=0, regions=region_ids)
            for page_num, region_ids in sorted(pages_dict.items())
        ]

        # Build Table objects
        tables: List[Table] = []
        for rp, tids in table_proposal_regions:
            if not rp.lines:
                continue
            table_bbox = BBox(
                x=min(tl.bbox.x for tl in rp.lines),
                y=rp.y_start,
                width=0,
                height=rp.y_end - rp.y_start,
            )
            max_x1 = max(tl.bbox.x + tl.bbox.width for tl in rp.lines)
            table_bbox.width = max_x1 - table_bbox.x if max_x1 > table_bbox.x else 0
            table_page = rp.lines[0].page_num

            # Each region ID becomes its own row for now
            tables.append(Table(
                id=f"T{len(tables) + 1}",
                regions=[[tid] for tid in tids],
                bbox=table_bbox,
                page=table_page,
            ))

        # Pack column proposals into metadata
        enriched_metadata = dict(metadata_)
        enriched_metadata["column_proposals"] = [
            {"x_start": cp.x_start, "x_end": cp.x_end, "header_hint": cp.header_hint}
            for cp in geometry_report.column_proposals
        ]
        enriched_metadata["aligned_group_count"] = len(geometry_report.aligned_groups)

        return DocumentLayout(
            document_id=document_id,
            pages=pages,
            regions=regions,
            tables=tables,
            metadata=enriched_metadata,
        )
