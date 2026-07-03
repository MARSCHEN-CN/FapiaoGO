"""
GeometryAnalyzer – understand physical document layout from text lines and bboxes.

Receives text lines with bounding boxes and produces a GeometryReport:
- aligned_groups: lines sharing the same left/right/center alignment
- column_proposals: column boundary clusters (from x0/x1 clustering)
- region_proposals: vertical region divisions (header/body/footer/table)
"""

from collections import defaultdict
from typing import Dict, List, Tuple

from contracts.document_layout import BBox
from contracts.geometry_domain import (
    AlignedGroup,
    ColumnProposal,
    GeometryReport,
    RegionProposal,
    TextLine,
)
from layout_domain.coordinate_utils import from_points


# ── Legacy adapter ──────────────────────────────────────────────────────────

class LegacyParserToTextLines:
    """Convert legacy parser output (dict with bbox_data) to List[TextLine].

    Known bbox_data format (from pdf_utils.py / parse_invoice_unified):
        [
            {'text': 'word1', 'box': [[x0,y0],[x1,y0],[x1,y1],[x0,y1]], 'page': 0},
            ...
        ]
    """

    def convert(self, parsed_result: dict) -> List[TextLine]:
        lines: List[TextLine] = []
        bbox_data = parsed_result.get("bbox_data") if "bbox_data" in parsed_result else None

        if not bbox_data or not isinstance(bbox_data, list) or len(bbox_data) == 0:
            # Fallback: try raw_text with a dummy bbox
            raw_text = parsed_result.get("raw_text", "") or parsed_result.get("text", "")
            if raw_text:
                lines.append(TextLine(
                    text=raw_text,
                    bbox=BBox(0, 0, 0, 0),
                    page_num=0,
                ))
            return lines

        for item in bbox_data:
            text = item.get("text", "") or ""
            if not text.strip():
                continue

            box_points = item.get("box")
            if box_points and len(box_points) >= 4:
                # box format: [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]
                x_coords = [p[0] for p in box_points[:4]]
                y_coords = [p[1] for p in box_points[:4]]
                bbox = from_points(min(x_coords), min(y_coords), max(x_coords), max(y_coords))
            else:
                bbox = BBox(0, 0, 0, 0)

            page_num = item.get("page", 0)
            if page_num is None:
                page_num = 0

            lines.append(TextLine(text=text, bbox=bbox, page_num=page_num))

        return lines


# ── Geometry Analyzer ───────────────────────────────────────────────────────

_ALIGNMENT_TOLERANCE = 2.0     # px: tolerance for same x0/x1
_COLUMN_CLUSTER_TOLERANCE = 5.0  # px: tolerance for x0/x1 clustering


class GeometryAnalyzer:
    """Analyze document geometry from text lines with bounding boxes."""

    def analyze(self, text_lines: List[TextLine], page_info: dict = None) -> GeometryReport:
        return GeometryReport(
            lines=text_lines,
            aligned_groups=self._find_aligned_groups(text_lines),
            column_proposals=self._propose_columns(text_lines),
            region_proposals=self._propose_regions(text_lines),
        )

    # ── aligned groups ──────────────────────────────────────────────────

    def _find_aligned_groups(self, text_lines: List[TextLine]) -> List[AlignedGroup]:
        if not text_lines:
            return []

        # group by page first
        by_page: Dict[int, List[TextLine]] = defaultdict(list)
        for tl in text_lines:
            by_page[tl.page_num].append(tl)

        result: List[AlignedGroup] = []
        for _page, page_lines in by_page.items():
            result.extend(self._align_group_single_page(page_lines))
        return result

    def _align_group_single_page(self, page_lines: List[TextLine]) -> List[AlignedGroup]:
        groups: List[AlignedGroup] = []

        # Left alignment: share same x0
        left_map: Dict[str, List[TextLine]] = defaultdict(list)
        for tl in page_lines:
            key = f"L{round(tl.bbox.x / _ALIGNMENT_TOLERANCE) * _ALIGNMENT_TOLERANCE}"
            left_map[key].append(tl)
        for key, lines in left_map.items():
            if len(lines) >= 2:
                x_val = lines[0].bbox.x
                groups.append(AlignedGroup(lines=list(lines), alignment="left", x_value=x_val))

        # Right alignment: share same x1 (x + width)
        right_map: Dict[str, List[TextLine]] = defaultdict(list)
        for tl in page_lines:
            rx = tl.bbox.x + tl.bbox.width
            key = f"R{round(rx / _ALIGNMENT_TOLERANCE) * _ALIGNMENT_TOLERANCE}"
            right_map[key].append(tl)
        for key, lines in right_map.items():
            if len(lines) >= 2:
                rx = lines[0].bbox.x + lines[0].bbox.width
                groups.append(AlignedGroup(lines=list(lines), alignment="right", x_value=rx))

        # Center alignment: share same horizontal midpoint
        center_map: Dict[str, List[TextLine]] = defaultdict(list)
        for tl in page_lines:
            cx = tl.bbox.x + tl.bbox.width / 2.0
            key = f"C{round(cx / _ALIGNMENT_TOLERANCE) * _ALIGNMENT_TOLERANCE}"
            center_map[key].append(tl)
        for key, lines in center_map.items():
            if len(lines) >= 2:
                cx = lines[0].bbox.x + lines[0].bbox.width / 2.0
                groups.append(AlignedGroup(lines=list(lines), alignment="center", x_value=cx))

        return groups

    # ── column proposals ────────────────────────────────────────────────

    def _propose_columns(self, text_lines: List[TextLine]) -> List[ColumnProposal]:
        if not text_lines:
            return []

        # Cluster x0 values
        x0_vals = sorted([tl.bbox.x for tl in text_lines])
        # Cluster x1 values (x + width)
        x1_vals = sorted([tl.bbox.x + tl.bbox.width for tl in text_lines])

        x0_clusters = self._cluster_values(x0_vals, _COLUMN_CLUSTER_TOLERANCE)
        x1_clusters = self._cluster_values(x1_vals, _COLUMN_CLUSTER_TOLERANCE)

        proposals: List[ColumnProposal] = []
        # Pair each x0 cluster with the nearest x1 cluster to form columns
        for x0 in sorted(x0_clusters):
            nearest_x1 = None
            for x1 in sorted(x1_clusters):
                if x1 > x0:
                    nearest_x1 = x1
                    break
            if nearest_x1 is not None:
                proposals.append(ColumnProposal(x_start=x0, x_end=nearest_x1))
            else:
                proposals.append(ColumnProposal(x_start=x0, x_end=x0 + 100.0))

        # Deduplicate by (x_start, x_end)
        seen = set()
        deduped: List[ColumnProposal] = []
        for cp in proposals:
            key = (round(cp.x_start, 1), round(cp.x_end, 1))
            if key not in seen:
                seen.add(key)
                deduped.append(cp)

        return sorted(deduped, key=lambda cp: cp.x_start)

    @staticmethod
    def _cluster_values(values: List[float], tolerance: float) -> List[float]:
        """Return the representative values of clusters within tolerance."""
        if not values:
            return []
        sorted_vals = sorted(values)
        clusters: List[float] = [sorted_vals[0]]
        for v in sorted_vals:
            if abs(v - clusters[-1]) > tolerance:
                clusters.append(v)
        return clusters

    # ── region proposals ────────────────────────────────────────────────

    def _propose_regions(self, text_lines: List[TextLine]) -> List[RegionProposal]:
        if not text_lines:
            return []

        # group by page
        by_page: Dict[int, List[TextLine]] = defaultdict(list)
        for tl in text_lines:
            by_page[tl.page_num].append(tl)

        proposals: List[RegionProposal] = []
        for page, page_lines in by_page.items():
            proposals.extend(self._region_proposals_single_page(page_lines))
        return proposals

    def _region_proposals_single_page(self, page_lines: List[TextLine]) -> List[RegionProposal]:
        if not page_lines:
            return []

        y0 = min(tl.bbox.y for tl in page_lines)
        y1 = max(tl.bbox.y + tl.bbox.height for tl in page_lines)
        page_height = max(y1 - y0, 1.0)

        lines_sorted = sorted(page_lines, key=lambda tl: tl.bbox.y)

        # Split into header/body/footer by y position
        header_end = y0 + page_height * 0.20
        footer_start = y1 - page_height * 0.20

        header_lines = [tl for tl in lines_sorted if tl.bbox.y < header_end]
        body_lines = [tl for tl in lines_sorted if header_end <= tl.bbox.y < footer_start]
        footer_lines = [tl for tl in lines_sorted if tl.bbox.y >= footer_start]

        proposals: List[RegionProposal] = []

        if header_lines:
            proposals.append(RegionProposal(
                y_start=y0,
                y_end=header_end,
                region_type="header",
                lines=header_lines,
            ))

        if body_lines:
            body_start = body_lines[0].bbox.y
            body_end = body_lines[-1].bbox.y + body_lines[-1].bbox.height
            proposals.append(RegionProposal(
                y_start=body_start,
                y_end=body_end,
                region_type="body",
                lines=body_lines,
            ))

            # Detect table sub-regions within body: look for consecutive lines
            # sharing the same alignment structure.
            table_regions = self._detect_tables_in_body(body_lines)
            proposals.extend(table_regions)

        if footer_lines:
            proposals.append(RegionProposal(
                y_start=footer_start,
                y_end=y1,
                region_type="footer",
                lines=footer_lines,
            ))

        return proposals

    def _detect_tables_in_body(self, body_lines: List[TextLine]) -> List[RegionProposal]:
        """Detect potential table regions within body lines.

        Heuristic: group consecutive lines into y-aligned rows.
        A table candidate is a run of at least 3 y-rows, each containing
        at least 2 lines with different x0 values (suggesting multiple columns).
        """
        tables: List[RegionProposal] = []
        if len(body_lines) < 3:
            return tables

        # Sort by y, then x
        sorted_lines = sorted(body_lines, key=lambda tl: (tl.bbox.y, tl.bbox.x))

        # Group lines by y-position (rows within 5px tolerance)
        from collections import Counter
        rows: List[List[TextLine]] = []
        current_row: List[TextLine] = []
        current_y: float = -1.0
        for tl in sorted_lines:
            if current_y < 0:
                current_y = tl.bbox.y
                current_row = [tl]
            elif abs(tl.bbox.y - current_y) <= 5.0:
                current_row.append(tl)
            else:
                rows.append(current_row)
                current_y = tl.bbox.y
                current_row = [tl]
        if current_row:
            rows.append(current_row)

        # A row is "multi-column" if it has at least 2 lines with distinct x0
        def _is_multicolumn_row(row: List[TextLine]) -> bool:
            x0s = {round(tl.bbox.x, 1) for tl in row}
            return len(x0s) >= 2

        # Scan consecutive runs of multi-column rows
        current_table_rows: List[List[TextLine]] = []
        for row in rows:
            if _is_multicolumn_row(row):
                current_table_rows.append(row)
            else:
                if len(current_table_rows) >= 3:
                    # Emit table
                    table_all_lines = [tl for r in current_table_rows for tl in r]
                    y_start = min(tl.bbox.y for tl in table_all_lines)
                    y_end = max(tl.bbox.y + tl.bbox.height for tl in table_all_lines)
                    tables.append(RegionProposal(
                        y_start=y_start,
                        y_end=y_end,
                        region_type="table",
                        lines=table_all_lines,
                    ))
                current_table_rows = []

        # Flush last group
        if len(current_table_rows) >= 3:
            table_all_lines = [tl for r in current_table_rows for tl in r]
            y_start = min(tl.bbox.y for tl in table_all_lines)
            y_end = max(tl.bbox.y + tl.bbox.height for tl in table_all_lines)
            tables.append(RegionProposal(
                y_start=y_start,
                y_end=y_end,
                region_type="table",
                lines=table_all_lines,
            ))

        return tables
