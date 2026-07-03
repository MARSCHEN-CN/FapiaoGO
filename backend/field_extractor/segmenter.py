# -*- coding: utf-8 -*-
"""
文档分段器（5 区域版）

将 OCRDocument 切分为 5 个语义区域：
  header / line_items / summary / footer / remark / noise

分区策略：
  1. 用锚点检测 remark 区域
  2. 用明细表头+合计行定位 line_items 区域
  3. 剩余行归入 header/footer/noise

新的 Region 系统（可选）：
  使用 AnchorDetector + RegionBuilder 进行基于 bbox 的区域划分
  提供更精确的区域隔离，彻底防止备注区污染
  
注意：buyer/seller 区域不再由 Segmenter 管理，
  由 PartyExtractor 独立提取并回写到 doc.regions。
"""
from __future__ import annotations

# ═══════════════════════════════════════════════════════
#  导入新的 Region 系统（可选增强）
# ═══════════════════════════════════════════════════════

try:
    from .anchor_detector import AnchorDetector, AnchorCollection
    from .region_builder import RegionBuilder, RegionCollection
    from .table_anchor import TableAnchorDetector, TableAnchorCollection
    ANCHOR_DETECTOR_AVAILABLE = True
except ImportError:
    ANCHOR_DETECTOR_AVAILABLE = False
    AnchorDetector = None
    RegionBuilder = None
    TableAnchorDetector = None

import re
import logging
from typing import List, Optional, Dict, Tuple, TYPE_CHECKING

import numpy as np

from .models import OCRDocument, Line, Region
from .segments import DocumentSegment, SegmentedDocument

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════
#  表头检测
# ═══════════════════════════════════════════════════════

_HEADER_NAME_RE = re.compile(r'项目名称|货物.*名称|服务名称|品名')
_HEADER_AMOUNT_RE = re.compile(r'金\s*额')
_HEADER_TAX_RE = re.compile(r'税\s*率|税\s*额')
_HEADER_QTY_RE = re.compile(r'数\s*量|单\s*位')
_HEADER_PRICE_RE = re.compile(r'单\s*价')
_HEADER_VALUE_THRESHOLD = 2
_HEADER_MAX_WINDOW = 8

# ═══════════════════════════════════════════════════════
#  终止行检测
# ═══════════════════════════════════════════════════════

_SUMMARY_RE = re.compile(r'(?:^|(?<=[\s:：]))(?:合\s*计|价税合计|小计)(?:\s|$|[:：])')

_FOOTER_KEYWORDS = [
    r'收款人', r'复核人', r'开票人', r'备注',
    r'销售方[:：]', r'销售方\s*[\(（]',
    r'收款人[:：]', r'复核人[:：]',
    r'机器编号', r'校验码', r'开票人[:：]',
    r'销售方信息', r'购买方信息',
    r'密码区', r'销售方\s*\(章\)',
    r'价税合计', r'\（大写）', r'\（小写）',
    r'肆', r'伍', r'陆', r'柒', r'捌', r'玖',
]
_FOOTER_FIRST_RE = re.compile('|'.join(_FOOTER_KEYWORDS))

# ═══════════════════════════════════════════════════════
#  买卖方 / 备注锚点
# ═══════════════════════════════════════════════════════

_REMARK_ANCHOR_RE = re.compile(r'^备\s*注[:：]?\s*$|^备注\s')
_FOOTER_PERSON_RE = re.compile(r'收款人|复核人|开票人')

# 合计区域关键词
_SUMMARY_LINE_RE = re.compile(r'合\s*计|价税合计|（大写）|（小写）|\(大写\)|\(小写\)')

# ═══════════════════════════════════════════════════════
#  白名单排除模式
# ═══════════════════════════════════════════════════════

_INVOICE_NUMBER_RE = re.compile(r'^[\d\s]{8,20}$')
_BANK_ACCOUNT_RE = re.compile(r'^\d{12,19}$')
_DATE_RE = re.compile(
    r'^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?$'
    r'|^\d{4}[-/]\d{1,2}[-/]\d{1,2}$'
)
_CHINESE_UPPER_AMOUNT_RE = re.compile(
    r'^[零壹贰叁肆伍陆柒捌玖拾佰仟万亿元角分整负\s]+$'
)
_COMPANY_NAME_RE = re.compile(
    r'(?:公司|有限|集团|中心|事务所|合作社|厂|行|部|室|处|协会|商会'
    r'|医院|学校|银行|保险|基金|信托|证券|投资|房地产|建筑|商贸'
    r'|科技|信息|咨询|服务)'
)
_TAX_ID_RE = re.compile(r'^[0-9A-Za-z]{15,20}$')

_HEADER_SINGLE_CHARS: set[str] = {
    '数', '量', '单', '价', '金', '额', '税', '率',
    '项', '目', '名', '称', '规', '格', '型', '号',
    '征', '收',
}

_RATE_RE = re.compile(r'^-?\d+(?:\.\d+)?%$|^免税$')

_COMMON_UNITS: frozenset[str] = frozenset({
    '台', '个', '次', '套', '件', '批', '项', '组', '条',
    '吨', 'kg', '千克', '克', 'g', '毫克', 'mg', '磅', '盎司',
    '米', 'm', '厘米', 'cm', '毫米', 'mm', '公里', 'km',
    '㎡', 'm²', '平方米', '平方', '立方米', '亩', '公顷',
    '升', 'L', '毫升', 'ml', '加仑',
    '箱', '包', '卷', '张', '本', '册', '份', '盒', '瓶',
    '袋', '桶', '罐', '壶', '根', '块', '粒', '颗', '只',
    '支', '坛', '筐', '篓', '令', '把', '片',
    '小时', '天', '年', '月',
    '人', '对', '双', '班', '课', '期', '轮', '场',
})


def _has_company_name(text: str) -> bool:
    return bool(_COMPANY_NAME_RE.search(text)) and len(text) >= 6


def _is_invoice_number_token(token: str) -> bool:
    clean = token.replace(' ', '')
    if not _INVOICE_NUMBER_RE.match(clean):
        return False
    if '.' in token or '¥' in token or '￥' in token:
        return False
    if ',' in clean and len(clean.replace(',', '')) <= 8:
        return False
    return True


def _is_image_ocr_tokens(tokens) -> bool:
    """判断 tokens 是否来自图片型 OCR（而非文本型 PDF）"""
    if not tokens:
        return False
    pages = set(getattr(t, 'page', 0) for t in tokens)
    if pages == {0} and len(tokens) > 20:
        ys = [getattr(t, 'y0', 0) for t in tokens]
        y_range = max(ys) - min(ys) if ys else 0
        return y_range > 400
    return False


class DocumentSegmenter:
    """将 OCRDocument 切分为 7 个语义区域"""

    # ─── 主入口 ───

    def segment(self, doc: OCRDocument) -> SegmentedDocument:
        """切分文档，返回 7 区域 SegmentedDocument"""
        result = SegmentedDocument()
        lines = doc.lines

        if not lines:
            return result

        # ── Step 1: 检测锚点（单次遍历替代多次独立扫描）──
        remark_start = footer_person = None
        for i, line in enumerate(lines):
            stripped = line.strip()
            if remark_start is None and (_REMARK_ANCHOR_RE.match(stripped) or stripped == '备注'):
                remark_start = i
            if footer_person is None and _FOOTER_PERSON_RE.search(stripped):
                footer_person = i
            # [PERF] 全部找到后提前终止
            if remark_start is not None and footer_person is not None:
                break
        header_idx = self._find_table_header(lines)
        summary_idx = self._find_summary_row(lines, header_idx)

        # ── Step 2: 构建行→区域映射 ──
        region_map = self._build_region_map(
            len(lines),
            header_idx, summary_idx,
            remark_start, footer_person,
            lines=lines,
        )

        # ── Step 2.5: 新 line_item_segmenter 增强（优先于旧逻辑）──
        # 基于 tokens 或 structured_lines 构建 Line 对象，
        # 用基于坐标的精确定位替换旧 anchor-bounded 区域划分。
        self._enhance_with_line_item_segmenter(doc, region_map, header_idx)

        # ── Step 3: 分配行 ──
        for i, line in enumerate(lines):
            stripped = line.strip()
            if not stripped:
                continue
            region_name = region_map.get(i, 'header')
            segment = result.get_region(region_name)
            segment.lines.append(stripped)

        # ── Step 4: tokens ──
        if doc.tokens:
            self._segment_bbox(doc, result, region_map)

        # ── Step 5: structured_lines ──
        if doc.structured_lines:
            self._segment_structured_lines(doc, result, region_map)

        # ── Step 6: 填充 doc.regions ──
        self._populate_regions(doc, result)

        # ── Step 7: 兜底明细行收集 ──
        if not result.line_items.lines or not self._has_item_data(result.line_items.lines):
            self._fallback_collect_line_items(doc, result)

        logger.debug(
            "[Segmenter] header=%d items=%d summary=%d footer=%d remark=%d noise=%d",
            len(result.header.lines),
            len(result.line_items.lines), len(result.summary.lines),
            len(result.footer.lines),
            len(result.remark.lines), len(result.noise.lines),
        )

        # ── Step 8: 输出字符级通路诊断摘要 ──
        excel_rows = getattr(doc, 'line_items_excel_rows', None)
        grid = getattr(doc, 'line_items_grid', None)
        logger.info(
            "[Segmenter] 字符级通路诊断: line_items_excel_rows=%s, grid=%s",
            f"{len(excel_rows)}行" if excel_rows else ("None" if excel_rows is None else "空列表"),
            f"{len(grid)}x{len(grid[0])}" if grid and grid[0] else "None",
        )
        if excel_rows and len(excel_rows) > 0:
            for ri, row in enumerate(excel_rows):
                logger.info("[Segmenter] Excel行%d: %s", ri, {
                    k: v for k, v in row.items()
                })

        return result

    # ─── 锚点检测 ───

    @staticmethod
    def _find_anchor(lines: list, pattern: re.Pattern) -> Optional[int]:
        for i, line in enumerate(lines):
            if pattern.search(line.strip()):
                return i
        return None

    def _find_remark_anchor(self, lines: list) -> Optional[int]:
        for i, line in enumerate(lines):
            stripped = line.strip()
            if _REMARK_ANCHOR_RE.match(stripped):
                return i
            if stripped == '备注':
                return i
        return None

    def _find_footer_person(self, lines: list) -> Optional[int]:
        for i, line in enumerate(lines):
            if _FOOTER_PERSON_RE.search(line.strip()):
                return i
        return None

    # ─── 区域映射构建 ───

    def _build_region_map(
        self,
        n: int,
        header_idx: int,
        summary_idx: Optional[int],
        remark_start: Optional[int],
        footer_person: Optional[int],
        lines: Optional[list] = None,
    ) -> Dict[int, str]:
        """构建 line_index → region_name 映射。

        策略：
        1. 先分配 remark（锚点区域，最多 10 行）
        2. 再分配 line_items（明细表头后到合计行前）
        3. 再分配 summary（合计行到下一个区域前）
        4. 再分配 footer（收款人/复核人/开票人区域）
        5. 其余归入 header
        """
        region_map: Dict[int, str] = {}

        # ── 1. remark 区域 ──
        if remark_start is not None:
            remark_end = self._anchor_region_end(
                remark_start, n,
                stops=[footer_person],
                max_span=10,
            )
            for i in range(remark_start, remark_end):
                region_map[i] = 'remark'

        # ── 2. line_items 区域 ──
        if header_idx >= 0:
            items_start = header_idx + 1
            if summary_idx is not None:
                items_end = summary_idx
            elif footer_person is not None:
                items_end = footer_person
            else:
                items_end = n

            for i in range(items_start, items_end):
                if i not in region_map:  # 不覆盖已分配的 remark
                    region_map[i] = 'line_items'

            # 表头行 → header（向前扫描找到表头起始）
            table_header_start = self._find_table_header_start(lines=lines, header_end=header_idx)
            for i in range(table_header_start, header_idx + 1):
                if i not in region_map:
                    region_map[i] = 'header'

        # ── 3. summary 区域 ──
        if summary_idx is not None:
            # summary 从合计行开始，到下一个已分配区域之前
            summary_end = n
            for stop in [footer_person, remark_start]:
                if stop is not None and stop > summary_idx:
                    summary_end = min(summary_end, stop)
            # 也检查已分配区域的起始
            for i in range(summary_idx, summary_end):
                if i not in region_map:
                    region_map[i] = 'summary'

        # ── 4. footer 区域（收款人/复核人/开票人）──
        if footer_person is not None:
            for i in range(footer_person, n):
                if i not in region_map:
                    region_map[i] = 'footer'

        # ── 5. 剩余行 → header ──
        for i in range(n):
            if i not in region_map:
                region_map[i] = 'header'

        return region_map

    @staticmethod
    def _anchor_region_end(
        start: int,
        n: int,
        stops: list,
        max_span: int = 15,
    ) -> int:
        """计算锚点区域的结束行号（exclusive）"""
        end = min(start + max_span, n)
        for stop in stops:
            if stop is not None and stop > start:
                end = min(end, stop)
        return end

    @staticmethod
    def _find_table_header_start(lines: Optional[list], header_end: int) -> int:
        """[FIX] 向前扫描找到表头区域的起始行（最多 8 行）

        当 lines 不为 None 时，实际检查行内容是否含表头关键词；
        否则回退为简单的范围截取。
        """
        if lines is None:
            return max(0, header_end - 7)

        # 表头关键词（发票代码/号码/日期/密码区等）
        _HEADER_KW = ('发票代码', '发票号码', '开票日期', '密码区', '机器编号',
                       '发票', '代码', '号码', '日期')
        start = max(0, header_end - 7)
        best = header_end
        for i in range(header_end - 1, start - 1, -1):
            if i < 0 or i >= len(lines):
                continue
            stripped = lines[i].strip()
            if not stripped:
                continue
            if any(kw in stripped for kw in _HEADER_KW):
                best = i
            else:
                # 遇到非表头内容即停止向前扫描
                break
        return best

    # ── 兜底收集明细行 ──

    @staticmethod
    def _has_item_data(lines: list[str]) -> bool:
        has_star = has_amount = has_rate = has_long_decimal = False
        for line in lines:
            s = line.strip()
            if not s:
                continue
            if re.search(r'\*[^*]+\*', s):
                has_star = True
            if re.match(r'^[¥￥]?[\d,]+\.\d{1,2}$', s):
                has_amount = True
            if re.match(r'^-?\d+(?:\.\d+)?%$', s):
                has_rate = True
            if re.match(r'^\d+\.\d{5,}$', s):
                has_long_decimal = True
        return has_star or has_amount or has_rate or has_long_decimal

    def _enhance_with_line_item_segmenter(
        self,
        doc: OCRDocument,
        region_map: Dict[int, str],
        header_idx: int,
    ) -> None:
        """使用 line_item_segmenter 增强明细区域分割。

        优先路径：如果 doc 持有 PyMuPDF 的 Page 对象（doc.page），
        则走字符级通路（字符 → 行聚类 → 列聚类 → 网格 → 分割），
        否则走原有的 tokens → Line 路径。
        """
        # ── 路径选择：文本型PDF走字符级通路，图片型/扫描型走OCR修复路径 ──
        has_page = getattr(doc, 'page', None) is not None
        src_type = getattr(doc, 'source_type', '')
        is_image_ocr = src_type not in ('', 'pdf_text')
        logger.info("[Segmenter/Char] 路径选择: has_page=%s, src_type=%r, is_image_ocr=%s",
                    has_page, src_type, is_image_ocr)

        if has_page and not is_image_ocr:
            # ── 文本型 PDF：走字符级通路 ──
            try:
                from .line_item_segmenter import (
                    extract_chars, segment_from_chars,
                    grid_to_excel_rows,
                )
                chars = extract_chars(doc.page)
                result = segment_from_chars(chars)
                if result is not None and result.get('grid'):
                    grid = result['grid']
                    header_indices = result.get('header_lines', [])
                    doc.line_items_grid = grid
                    doc.line_items_header_indices = header_indices

                    try:
                        doc.line_items_excel_rows = grid_to_excel_rows(
                            grid, header_indices,
                            item_lines=result.get('item_lines'),
                        )
                    except Exception:
                        logger.debug("[Segmenter/Char] grid_to_excel_rows 异常", exc_info=True)
                        doc.line_items_excel_rows = []

                    logger.info(
                        "[Segmenter/Char] 字符通路成功: grid=%dx%d, headers=%s, items=%d行",
                        len(grid), len(grid[0]) if grid else 0,
                        header_indices, len(result.get('item_lines', [])),
                    )
                    # 诊断：打印前 3 个 item_lines 索引和对应 grid 行
                    item_lines = result.get('item_lines', [])
                    if item_lines:
                        if logger.isEnabledFor(logging.DEBUG):
                            logger.debug("[Segmenter/Char] 诊断: item_lines=%s, 前3条grid行索引=%s",
                                         item_lines,
                                         [i for i in item_lines[:3] if i < len(grid)])
                            for ri in item_lines[:3]:
                                if ri < len(grid):
                                    logger.debug("[Segmenter/Char] 诊断: grid行%d=%s",
                                                 ri, grid[ri])
                    else:
                        logger.warning("[Segmenter/Char] 诊断: item_lines 为空!")
                    return
                else:
                    logger.info("[Segmenter/Char] 字符通路无结果，回退 bbox 路径")
            except Exception:
                logger.debug("[Segmenter/Char] 字符通路异常，回退 bbox 路径", exc_info=True)

        # ── 图片型/扫描型/无 page 的走 OCR 修复 → Token 通路 ──
        if doc.tokens:
            is_image_ocr = False
            if src_type != 'pdf_text':
                is_image_ocr = _is_image_ocr_tokens(doc.tokens)
            if src_type == 'pdf_text':
                is_image_ocr = False

            logger.info("[Segmenter/OCR] source_type=%r is_image_ocr=%s", src_type, is_image_ocr)

            if is_image_ocr:
                # 图片型：走 OCR 专属修复路径
                try:
                    from .ocr_post_processor import process_ocr_line_items
                    rows, seg_result = process_ocr_line_items(doc.tokens)
                    if rows and seg_result.get('grid'):
                        grid = seg_result['grid']
                        header_indices = seg_result.get('header_lines', [])
                        doc.line_items_grid = grid
                        doc.line_items_header_indices = header_indices
                        doc.line_items_excel_rows = rows
                        logger.info(
                            "[Segmenter] OCR路径产出 %d 行明细, grid=%dx%d",
                            len(rows), len(grid), len(grid[0]) if grid else 0,
                        )
                        return
                    else:
                        logger.info("[Segmenter] OCR路径无结果")
                except Exception:
                    logger.debug("[Segmenter] OCR路径异常", exc_info=True)

            # Token 级通路（回退/兜底）
            try:
                from .line_item_segmenter import (
                    segment_from_chars, grid_to_excel_rows,
                )
                result = segment_from_chars(doc.tokens)
                logger.info("[Segmenter/OCR-Token] 直接传入 %d 个 tokens 到 segment_from_chars",
                            len(doc.tokens))
                if result is not None and result.get('grid'):
                    grid = result['grid']
                    header_indices = result.get('header_lines', [])
                    doc.line_items_grid = grid
                    doc.line_items_header_indices = header_indices

                    try:
                        doc.line_items_excel_rows = grid_to_excel_rows(
                            grid, header_indices,
                            item_lines=result.get('item_lines'),
                        )
                    except Exception:
                        logger.debug("[Segmenter/OCR-Char] grid_to_excel_rows 异常", exc_info=True)
                        doc.line_items_excel_rows = []

                    logger.info(
                        "[Segmenter/OCR-Char] 字符通路成功: grid=%dx%d, headers=%s, items=%d行",
                        len(grid), len(grid[0]) if grid else 0,
                        header_indices, len(result.get('item_lines', [])),
                    )
                    return
                else:
                    logger.info("[Segmenter/OCR-Char] 字符通路无结果")
            except Exception:
                logger.debug("[Segmenter/OCR-Char] 字符通路异常", exc_info=True)

        # ── 原有路径：tokens → Line ──
        self._enhance_with_bbox(doc, region_map, header_idx)

    def _enhance_with_bbox(
        self,
        doc: OCRDocument,
        region_map: Dict[int, str],
        header_idx: int,
    ) -> None:
        """原有 bbox 路径：从 doc.tokens 构建 Line 对象，运行基于坐标的精确分割。"""
        # 需要 tokens 或 structured_lines 才有坐标信息
        coord_lines, token_rows = self._build_coord_lines_for_segmenter(doc)
        if not coord_lines:
            logger.info("[Segmenter/BBox] 回退跳过: coord_lines 为空 (tokens=%d, structured_lines=%d)",
                        len(doc.tokens) if doc.tokens else 0,
                        len(doc.structured_lines) if doc.structured_lines else 0)
            return
        logger.info("[Segmenter/BBox] 进入 bbox 路径: coord_lines=%d", len(coord_lines))

        try:
            from .line_item_segmenter import segment_line_items, build_header_boundaries_from_tokens
            # ✅ 用表头关键字引导的间距中点法计算列边界（与 OCR 通道一致）
            token_boundaries = build_header_boundaries_from_tokens(doc.tokens)
            if token_boundaries:
                logger.info("[Segmenter/BBox] 表头引导边界: %s",
                            [f'{b:.1f}' for b in token_boundaries])
                result = segment_line_items(coord_lines, col_boundaries=token_boundaries)
            else:
                result = segment_line_items(coord_lines)
        except Exception:
            logger.debug("[Segmenter] line_item_segmenter 异常，回退旧逻辑", exc_info=True)
            return

        if result is None or not result['item_lines']:
            return

        # 将新 segmenter 产出的行索引映射回 region_map
        item_indices_set = set(result['item_lines'])
        header_indices_set = set(result['header_lines'])

        # 清除旧的 line_items 标记（仅清除被新结果覆盖的区域）
        for i in range(result['start'], result['end'] + 1):
            if i in region_map and region_map[i] == 'line_items':
                del region_map[i]

        # 重新标记 header 行
        for i in header_indices_set:
            if i < len(doc.lines):
                # 只有未被 remark 占用的才标记为 header
                if i not in region_map or region_map[i] == 'header':
                    region_map[i] = 'header'

        # 重新标记 item 行
        for i in result['item_lines']:
            if i < len(doc.lines):
                # 不覆盖已分配的 remark
                if i not in region_map:
                    region_map[i] = 'line_items'

        # 填充 header 与 item 之间的间隙（如果有表头行未被覆盖）
        header_end = max(header_indices_set) if header_indices_set else -1
        item_start = min(result['item_lines'])
        for i in range(header_end + 1, item_start):
            if i < len(doc.lines) and i not in region_map:
                region_map[i] = 'header'

        logger.debug(
            "[Segmenter] line_item_segmenter 已增强: header=%s, items=%s",
            sorted(header_indices_set), sorted(result['item_lines']),
        )

        # ── 构建 grid 和 Excel 行数据（bbox 路径兜底）──
        # 字符通路由 _enhance_with_line_item_segmenter 处理，这里作为 bbox 路径补充
        self._build_excel_from_bbox(result, coord_lines, doc, token_rows=token_rows)

    def _build_excel_from_bbox(
        self,
        segmenter_result: dict,
        coord_lines: List[Line],
        doc: OCRDocument,
        token_rows: dict = None,
    ) -> None:
        """从 bbox 路径的分割结果构建 grid 和 Excel 行数据。

        网格行数与 coord_lines 严格对齐，第 i 行 grid[i] 对应 coord_lines[i]。
        列拆分：对 grid 第 i 行，取 doc.tokens 中 y 中心落在

        Args:
            token_rows: 可选，由 _build_coord_lines_for_segmenter 产出的 y 聚类缓存，
                        传入后跳过内部重复聚类。
        coord_lines[i] 的 y 范围内的 token，按 x 分配到各列。
        """
        try:
            from .line_item_segmenter import (
                get_col_index, grid_to_excel_rows,
            )
        except ImportError:
            logger.debug("[Segmenter/BBox] 导入 line_item_segmenter 失败")
            return

        if not coord_lines or not segmenter_result:
            return

        header_line_indices = segmenter_result.get('header_lines', [])
        item_line_indices = segmenter_result.get('item_lines', [])

        # ── 列边界计算：复用文本型通路的 _build_header_guided_boundaries ──
        n_cols = 1
        boundaries: List[float] = []
        if doc.tokens and header_line_indices:
            try:
                from .line_item_segmenter import (
                    Char, Line as _SegLine,
                    _build_header_guided_boundaries,
                )

                hdr_idx = max(header_line_indices)
                if hdr_idx < len(coord_lines):
                    hdr_y = coord_lines[hdr_idx].y
                    hdr_y1 = coord_lines[hdr_idx].y1
                    hdr_tokens = sorted(
                        [t for t in doc.tokens
                         if hdr_y <= t.cy <= hdr_y1],
                        key=lambda t: t.x)

                    if hdr_tokens:
                        # 将 bbox token 拆分为 Char 对象（等宽插值）
                        hdr_text = ''.join(t.text for t in hdr_tokens)
                        chars: List[Char] = []
                        for t in hdr_tokens:
                            n = len(t.text)
                            if n == 0:
                                continue
                            ch_w = t.width / max(len(t.text), 1)
                            for i, c in enumerate(t.text):
                                chars.append(Char(
                                    char=c,
                                    x0=t.x + ch_w * i,
                                    y0=t.y,
                                    x1=t.x + ch_w * (i + 1),
                                    y1=t.y1,
                                    page=0,
                                ))

                        if chars:
                            rows_chars = [chars]
                            temp_line = _SegLine(
                                text=hdr_text, y0=hdr_y, y1=hdr_y1,
                                x0=chars[0].x0, x1=chars[-1].x1, page=0)
                            temp_lines = [temp_line]

                            boundaries = _build_header_guided_boundaries(
                                chars, rows_chars, [0], temp_lines)

                            if len(boundaries) >= 7:
                                n_cols = len(boundaries) + 1
                                logger.info(
                                    "[BBox/Excel] 复用文本型列检测: %d 列, 边界=%s",
                                    n_cols, [f'{b:.0f}' for b in boundaries])
                                # 边界诊断：每个边界对应的估计位置
                                kw_names = ['规(项目/规格)', '单(规格/单位)', '位(单位/数量)',
                                           '量(数量/单价)', '价(单价/金额)', '额(金额/税率)',
                                           '率(税率/税额)']
                                for i, (b, nm) in enumerate(zip(boundaries, kw_names)):
                                    logger.debug("[BBox/Excel]  边界%d %s: %.1f",
                                                 i, nm, b)
                            else:
                                boundaries = []
                                n_cols = 1

            except Exception:
                logger.debug("[BBox/Excel] 列检测异常", exc_info=True)

        # 无 token 或无边界时保持单列

        # ── 从 doc.tokens 直接重做分行 ──
        grid: List[List[str]] = []
        if doc.tokens and boundaries:
            # 1.5px 容差 y 聚类分行（优先复用调用方传入的缓存）
            if token_rows:
                rows_dict = token_rows
            else:
                ROW_TOL = 1.5
                rows_dict: Dict[float, List] = {}
                for t in doc.tokens:
                    y_key = round(t.cy / ROW_TOL) * ROW_TOL
                    rows_dict.setdefault(y_key, []).append(t)

            grid_rows = sorted(rows_dict.keys())

            # 第一遍：构建完整 grid
            raw_grid: List[List[str]] = []
            for y_key in grid_rows:
                tokens = rows_dict[y_key]
                tokens.sort(key=lambda t: t.x)
                cells = [''] * n_cols
                for t in tokens:
                    col = self._x0_to_col_index(t.x, boundaries)
                    if 0 <= col < n_cols:
                        cells[col] += t.text
                raw_grid.append(cells)

            # ── 诊断：token 到列分配详情 ──
            for ri, y_key in enumerate(grid_rows):
                tokens = rows_dict[y_key]
                tokens.sort(key=lambda t: t.x)
                row_text = ''.join(raw_grid[ri])
                # 只诊断表头行和包含 *...* 的明细行
                if '项目名称' in row_text or re.search(r'\*[^*]+\*', row_text):
                    if logger.isEnabledFor(logging.DEBUG):
                        logger.debug("[BBox/分配] 行%d(y=%.0f) %d个token→%d列:",
                                     ri, y_key, len(tokens), n_cols)
                        for t in tokens:
                            col = self._x0_to_col_index(t.x, boundaries)
                            logger.debug("[BBox/分配]   token='%s' x=%.1f→col=%d",
                                         t.text[:15], t.x, col)
                        non_empty = [(i, c[:20]) for i, c in enumerate(raw_grid[ri]) if c.strip()]
                        logger.debug("[BBox/分配]   → 非空列: %s", non_empty)

            # 找表头行（包含"项目名称"关键词的行）
            hdr_row_idx = None
            for i, row in enumerate(raw_grid):
                for cell in row:
                    if '项目名称' in cell:
                        hdr_row_idx = i
                        break
                if hdr_row_idx is not None:
                    break

            # 找明细行（包含 *...* 的行）
            item_row_indices = []
            for i, row in enumerate(raw_grid):
                for cell in row:
                    if re.search(r'\*[^*]+\*', cell):
                        item_row_indices.append(i)
                        break

            # 从表头下行开始、到合计行结束的区域
            data_start = hdr_row_idx + 1 if hdr_row_idx is not None else 0
            data_end = len(raw_grid)
            for i in range(data_start, len(raw_grid)):
                row_text = ' '.join(raw_grid[i])
                if '合计' in row_text and '¥' in row_text:
                    data_end = i
                    break

            # 截取 grid
            grid = raw_grid[max(0, hdr_row_idx if hdr_row_idx else 0):data_end]
            grid_header = [0]  # 表头是截取后的第一行
            grid_items = [i - (hdr_row_idx or 0) for i in item_row_indices
                          if hdr_row_idx is not None and i < data_end and i > (hdr_row_idx or 0)]

            logger.info("[BBox/Excel] 直接分行: %d原始行→%d grid行, 表头行%d, 明细%d行",
                        len(raw_grid), len(grid), hdr_row_idx or -1, len(grid_items))
        else:
            # 回退：无 tokens 或无边界，用 coord_lines 构建单列 grid
            for line_idx, coord_line in enumerate(coord_lines):
                cells = [coord_line.text] if coord_line.text.strip() else ['']
                grid.append(cells)
            grid_header = sorted(header_line_indices) if header_line_indices else [0]
            grid_items = sorted(item_line_indices)

        if not grid:
            return

        doc.line_items_grid = grid
        doc.line_items_header_indices = sorted(
            i for i in grid_header if i < len(grid)
        )

        valid_item_indices = [i for i in grid_items if i < len(grid)]
        try:
            doc.line_items_excel_rows = grid_to_excel_rows(
                grid, doc.line_items_header_indices,
                item_lines=valid_item_indices,
            )
            logger.info(
                "[Segmenter/BBox] Excel 行数据构建完成: %d 行, grid=%dx%d, "
                "item_lines=[%d..%d]",
                len(doc.line_items_excel_rows), len(grid), n_cols,
                min(valid_item_indices) if valid_item_indices else -1,
                max(valid_item_indices) if valid_item_indices else -1,
            )
        except Exception:
            logger.debug("[Segmenter/BBox] grid_to_excel_rows 异常", exc_info=True)
            doc.line_items_excel_rows = []

        if not doc.line_items_excel_rows:
            logger.info("[Segmenter/BBox] Excel 行为空，降级为原始行文本输出")
            fallback_rows = []
            for idx in valid_item_indices:
                if idx < len(grid):
                    text = ' '.join(c for c in grid[idx] if c.strip())
                    if text:
                        fallback_rows.append({'原始行': text})
            if fallback_rows:
                doc.line_items_excel_rows = fallback_rows

    @staticmethod
    def _x0_to_col_index(x0: float, boundaries: List[float]) -> int:
        """根据 token 左侧坐标 x0 和列边界返回列索引。

        与 get_col_index 的区别：get_col_index 使用中心点 (x0+x1)/2，
        这里直接用左侧起始坐标，避免宽 token 跨越列边界时中心点落入错误列。
        """
        for i, b in enumerate(boundaries):
            if x0 < b:
                return i
        return len(boundaries)

    @staticmethod
    def _split_text_by_boundaries(text: str, n_cols: int) -> List[str]:
        """将表头行文本按空格拆分为各列单元格。

        简单的等分策略：按空格分割后，按顺序填入各列。
        如果单词数 > 列数，多余的合并到最后一列。
        如果单词数 < 列数，空列留空。

        Args:
            text: 表头行文本（如 "项目名称 规格型号 单位 数量 单价 金额 税率 税额"）
            n_cols: 总列数

        Returns:
            各列文本列表，长度为 n_cols
        """
        words = text.split()
        cells = [''] * n_cols
        for i, word in enumerate(words):
            if i < n_cols:
                cells[i] = word
            else:
                # 多余单词合并到最后一列
                cells[-1] += ' ' + word
        return cells

    @staticmethod
    def _build_coord_lines_for_segmenter(doc: OCRDocument):
        """从 OCRDocument 构建 line_item_segmenter 所需的 Line 列表。

        Returns:
            tuple: (bbox_lines, tokens_by_row)
                - bbox_lines: List[Line] — 聚合后的行列表
                - tokens_by_row: Dict[float, List[Token]] — y 聚类中间结果，
                  可传递给 _build_excel_from_bbox 避免重复聚类
        """
        bbox_lines = []
        tokens_by_row = {}
        if doc.tokens:
            # 按 y 中心聚合同一行的 token（1.5px 容差，减少 OCR 微小抖动产生多余行）
            ROW_TOL = 1.5
            for token in doc.tokens:
                y_key = round((token.y0 + token.y1) / 2.0 / ROW_TOL) * ROW_TOL
                if y_key not in tokens_by_row:
                    tokens_by_row[y_key] = []
                tokens_by_row[y_key].append(token)

            for y_key in sorted(tokens_by_row.keys()):
                row_tokens = tokens_by_row[y_key]
                row_tokens.sort(key=lambda t: t.x0)
                text = ''.join(t.text for t in row_tokens)
                xs = [t.x0 for t in row_tokens] + [t.x1 for t in row_tokens]
                ys = [t.y0 for t in row_tokens] + [t.y1 for t in row_tokens]
                bbox_lines.append(Line(
                    text=text,
                    y0=min(ys), y1=max(ys),
                    x0=min(xs), x1=max(xs),
                    page=0,
                ))
        elif doc.structured_lines:
            for sl in doc.structured_lines:
                if isinstance(sl, dict):
                    bbox_lines.append(Line(
                        text=sl.get('text', ''),
                        y0=sl.get('y0', 0), y1=sl.get('y1', 0),
                        x0=sl.get('x0', 0), x1=sl.get('x1', 0),
                        page=sl.get('page', 0),
                    ))
                elif hasattr(sl, 'text'):
                    bbox_lines.append(Line(
                        text=sl.text,
                        y0=getattr(sl, 'y0', 0), y1=getattr(sl, 'y1', 0),
                        x0=getattr(sl, 'x0', 0), x1=getattr(sl, 'x1', 0),
                        page=getattr(sl, 'page', 0),
                    ))
        return bbox_lines, tokens_by_row

    def _fallback_collect_line_items(self, doc: OCRDocument, result: SegmentedDocument) -> None:
        """当区间提取未产生明细行时，从全文扫描 *分类编码* 项目。"""
        item_lines: list[str] = []
        in_item_block = False
        has_real_data = False

        for line in doc.lines:
            stripped = line.strip()
            if not stripped:
                continue

            if re.search(r'\*[^*]+\*', stripped) and not _FOOTER_FIRST_RE.search(stripped):
                in_item_block = True
                has_real_data = False

            if in_item_block:
                item_lines.append(stripped)
                if (stripped in _COMMON_UNITS
                        or _RATE_RE.match(stripped)
                        or re.match(r'^[¥￥]?[\d,]+\.\d{2}$', stripped)
                        or (re.match(r'^\d+$', stripped) and len(stripped) <= 10)
                        or re.match(r'^\d+\.\d{5,}$', stripped)):
                    has_real_data = True

                if self._is_summary_line(stripped) and has_real_data and len(item_lines) > 2:
                    item_lines.pop()
                    break
                if _is_invoice_number_token(stripped) and len(item_lines) > 2:
                    item_lines.pop()
                    break
                if (re.match(r'^(开票人|备注|复核人|收款人)', stripped)
                        and has_real_data and len(item_lines) > 2):
                    item_lines.pop()
                    break

        if item_lines:
            all_regions = [result.header, result.summary,
                           result.footer, result.remark, result.noise]
            item_set = set(item_lines)
            for seg in all_regions:
                new_lines = []
                for fl in seg.lines:
                    if fl in item_set:
                        item_set.discard(fl)
                    else:
                        new_lines.append(fl)
                seg.lines = new_lines
            result.line_items.lines = item_lines
            logger.debug("[Segmenter] Fallback: collected %d line_items", len(item_lines))

    # ─── 表头扩展 ──

    def _extend_header(self, lines: List[str], initial_end: int) -> int:
        header_end = initial_end
        n = len(lines)
        for j in range(initial_end + 1, min(n, initial_end + 11)):
            line = lines[j].strip()
            if not line:
                continue
            if self._is_header_field_line(line):
                header_end = j
            else:
                break
        return header_end

    @staticmethod
    def _is_header_field_line(line: str) -> bool:
        header_patterns = [
            _HEADER_NAME_RE, _HEADER_AMOUNT_RE, _HEADER_TAX_RE,
            _HEADER_QTY_RE, _HEADER_PRICE_RE,
            re.compile(r'规格型号'),
            re.compile(r'征收率'),
        ]
        stripped = line.strip()
        for pat in header_patterns:
            if pat.search(stripped):
                return True
        if len(stripped) == 1 and stripped in _HEADER_SINGLE_CHARS:
            return True
        return False

    # ─── 表头检测 ───

    def _find_table_header(self, lines: List[str]) -> int:
        n = len(lines)
        for i in range(n):
            for window in range(1, min(_HEADER_MAX_WINDOW + 1, n - i + 1)):
                combined = ' '.join(lines[i:i + window])
                if self._is_table_header(combined):
                    header_end = i + window - 1
                    header_end = self._extend_header(lines, header_end)
                    return header_end
        return -1

    @staticmethod
    def _is_table_header(text: str) -> bool:
        has_name = bool(_HEADER_NAME_RE.search(text))
        has_spec = bool(re.search(r'规格型号', text))
        has_amount = bool(_HEADER_AMOUNT_RE.search(text))
        value_hits = sum([
            has_spec, has_amount,
            bool(_HEADER_TAX_RE.search(text)),
            bool(_HEADER_QTY_RE.search(text)),
            bool(_HEADER_PRICE_RE.search(text)),
        ])
        return has_name and (has_spec or has_amount) and value_hits >= _HEADER_VALUE_THRESHOLD

    # ─── 合计行检测 ───

    def _find_summary_row(self, lines: List[str], header_idx: int) -> Optional[int]:
        start = header_idx + 1 if header_idx >= 0 else 0
        end = min(len(lines), start + 60)
        for i in range(start, end):
            if self._is_summary_line(lines[i]):
                return i
        return None

    @staticmethod
    def _is_summary_line(line: str) -> bool:
        return bool(_SUMMARY_RE.search(line))

    # ─── 行级候选过滤 ───

    def _is_line_item_candidate(self, line: str) -> bool:
        stripped = line.strip()
        if not stripped:
            return False
        if self._is_summary_line(stripped):
            return False
        if _FOOTER_FIRST_RE.search(stripped):
            return False
        if _HEADER_NAME_RE.search(stripped) or _HEADER_AMOUNT_RE.search(stripped):
            return False
        if _HEADER_TAX_RE.search(stripped) or _HEADER_QTY_RE.search(stripped):
            return False
        if _HEADER_PRICE_RE.search(stripped):
            return False
        if len(stripped) == 1 and '\u4e00' <= stripped <= '\u9fff':
            if stripped in _HEADER_SINGLE_CHARS:
                return False
        if _is_invoice_number_token(stripped):
            return False
        if _BANK_ACCOUNT_RE.match(stripped):
            return False
        if _DATE_RE.match(stripped):
            return False
        if _CHINESE_UPPER_AMOUNT_RE.match(stripped) and len(stripped) >= 2:
            return False
        if (_has_company_name(stripped) and ':' not in stripped and '：' not in stripped
                and not re.search(r'\*[^*]+\*', stripped)):
            return False
        if _TAX_ID_RE.match(stripped):
            return False
        _NON_ITEM_LABELS = re.compile(
            r'电子发票|增值税|名\s*称[:：]|统一社会信用代码|纳税人识别号[:：]'
            r'|规格型号$|征收率$|地址[:：]|电话[:：]|开户银行|账号[:：]'
        )
        if _NON_ITEM_LABELS.search(stripped):
            return False
        return True

    # ─── bbox 分段 ───

    def _segment_bbox(
        self,
        doc: OCRDocument,
        result: SegmentedDocument,
        region_map: Dict[int, str],
    ) -> None:
        tokens = list(doc.tokens)
        if not tokens:
            return
        if doc.structured_lines:
            self._segment_bbox_precise(doc, result, region_map)
        else:
            self._segment_bbox_approx(doc, result, region_map)

    def _segment_structured_lines(
        self,
        doc: OCRDocument,
        result: SegmentedDocument,
        region_map: Dict[int, str],
    ) -> None:
        for i, line in enumerate(doc.structured_lines):
            region_name = region_map.get(i, 'header')
            segment = result.get_region(region_name)
            segment.structured_lines.append(line)

    def _populate_regions(self, doc: OCRDocument, result: SegmentedDocument) -> None:
        # NOTE: 'buyer'/'seller' 不再由 Segmenter 填充，由 PartyExtractor 在 extract() 后回写
        region_names = ['header', 'line_items', 'summary',
                        'footer', 'remark']
        for name in region_names:
            seg = result.get_region(name)
            sl = seg.structured_lines
            bt = seg.tokens

            if not sl and not bt:
                doc.regions[name] = Region(name=name)
                continue

            all_y0 = [l.y0 for l in sl] + [t.y0 for t in bt]
            all_y1 = [l.y1 for l in sl] + [t.y1 for t in bt]
            all_x0 = [l.x0 for l in sl] + [t.x0 for t in bt]
            all_x1 = [l.x1 for l in sl] + [t.x1 for t in bt]

            doc.regions[name] = Region(
                name=name,
                x0=min(all_x0) if all_x0 else 0,
                y0=min(all_y0) if all_y0 else 0,
                x1=max(all_x1) if all_x1 else 0,
                y1=max(all_y1) if all_y1 else 0,
                lines=list(sl),
                tokens=list(bt),
            )

    def _segment_bbox_precise(
        self,
        doc: OCRDocument,
        result: SegmentedDocument,
        region_map: Dict[int, str],
    ) -> None:
        lines = doc.structured_lines
        if not lines:
            return

        # 构建区域 y 坐标范围
        region_y: Dict[str, Tuple[float, float]] = {}
        for i, line in enumerate(lines):
            rn = region_map.get(i, 'header')
            if rn not in region_y:
                region_y[rn] = (line.y0, line.y1)
            else:
                y0, y1 = region_y[rn]
                region_y[rn] = (min(y0, line.y0), max(y1, line.y1))

        for token in doc.tokens:
            best_region = 'header'
            best_dist = float('inf')

            for rn, (y_min, y_max) in region_y.items():
                if y_min <= token.cy <= y_max:
                    best_region = rn
                    break
                dist = min(abs(token.cy - y_min), abs(token.cy - y_max))
                if dist < best_dist:
                    best_dist = dist
                    best_region = rn

            segment = result.get_region(best_region)
            segment.tokens.append(token)

    def _segment_bbox_approx(
        self,
        doc: OCRDocument,
        result: SegmentedDocument,
        region_map: Dict[int, str],
    ) -> None:
        tokens = sorted(doc.tokens, key=lambda t: t.cy)
        if not tokens:
            return
        total_lines = len(doc.lines)
        if total_lines == 0:
            return

        # 将 bbox tokens 按 y 坐标聚合成行
        # 同一行的 token cy 差不超过 8px（可配置）
        Y_ROW_TOLERANCE = 8.0
        rows = []  # list of list[Token]
        for token in tokens:
            if not rows:
                rows.append([token])
            else:
                last_row_cy = sum(t.cy for t in rows[-1]) / len(rows[-1])
                if abs(token.cy - last_row_cy) <= Y_ROW_TOLERANCE:
                    rows[-1].append(token)
                else:
                    rows.append([token])

        # 每行 token 分配到对应 line index 的 region
        for row_idx, row_tokens in enumerate(rows):
            # 估算对应 text line 索引
            line_est = int(row_idx / len(rows) * total_lines) if len(rows) > 1 else 0
            line_est = min(line_est, total_lines - 1)
            region_name = region_map.get(line_est, 'header')

            for token in row_tokens:
                if region_name == 'line_items' and not self._is_line_item_candidate(token.text):
                    result.noise.tokens.append(token)
                else:
                    segment = result.get_region(region_name)
                    segment.tokens.append(token)

    # ═══════════════════════════════════════════════════════
    #  新的 Region 系统分段（可选增强）
    # ═══════════════════════════════════════════════════════

    def segment_with_regions(self, doc: OCRDocument) -> SegmentedDocument:
        """
        使用新的 Region 系统进行分段（基于 AnchorDetector + RegionBuilder）
        
        这是新的分段方法的入口，提供更精确的区域隔离。
        如果新的系统不可用，则回退到传统的分段方法。
        
        Args:
            doc: OCR 文档对象
            
        Returns:
            SegmentedDocument 对象（与现有格式兼容）
        """
        if not ANCHOR_DETECTOR_AVAILABLE:
            logger.warning("AnchorDetector not available, falling back to traditional segment()")
            return self.segment(doc)
        
        try:
            # Step 1: 使用 AnchorDetector 检测锚点
            anchor_detector = AnchorDetector(doc)
            anchors = anchor_detector.detect()
            
            # Step 2: 使用 RegionBuilder 构建区域
            region_builder = RegionBuilder(doc, anchors)
            regions = region_builder.build()
            
            # Step 3: 将 Region 转换为 SegmentedDocument
            result = self._convert_regions_to_segmented_document(regions, doc)
            
            logger.info(f"Region-based segmentation complete: "
                       f"header={len(result.header.lines)} lines, "
                       f"line_items={len(result.line_items.lines)} lines, "
                       f"summary={len(result.summary.lines)} lines, "
                       f"remark={len(result.remark.lines)} lines")
            
            return result
            
        except Exception as e:
            logger.error(f"Region-based segmentation failed: {e}, falling back to traditional method")
            return self.segment(doc)
    
    def _convert_regions_to_segmented_document(self, 
                                              regions: RegionCollection,
                                              doc: OCRDocument) -> SegmentedDocument:
        """
        将 RegionCollection 转换为 SegmentedDocument（兼容现有格式）
        
        Args:
            regions: RegionCollection 对象
            doc: OCR 文档对象（用于获取 lines）
            
        Returns:
            SegmentedDocument 对象
        """
        result = SegmentedDocument()
        
        # 转换每个区域
        # 注意：buyer/seller 不在 SegmentedDocument 中管理，
        # 由 PartyExtractor 独立提取并回写到 doc.regions
        for region_name in ['header', 'line_items', 'summary', 
                           'remark', 'footer', 'noise']:
            region = getattr(regions, region_name, None)
            if not region or not region.tokens:
                continue
            
            # 获取对应的 DocumentSegment
            segment = getattr(result, region_name, None)
            if not segment:
                continue
            
            # 转换 tokens 为 lines（提取文本）
            for token in region.tokens:
                segment.tokens.append(token)
                if token.text not in segment.lines:
                    segment.lines.append(token.text)
        
        return result


# ═══════════════════════════════════════════════════════
#  便捷函数
# ═══════════════════════════════════════════════════════

def segment_document(doc: OCRDocument, use_regions: bool = False) -> SegmentedDocument:
    """
    便捷函数：分段文档
    
    Args:
        doc: OCR 文档对象
        use_regions: 是否使用新的 Region 系统（默认 False）
        
    Returns:
        SegmentedDocument 对象
    """
    segmenter = DocumentSegmenter()
    
    if use_regions and ANCHOR_DETECTOR_AVAILABLE:
        return segmenter.segment_with_regions(doc)
    else:
        return segmenter.segment(doc)
