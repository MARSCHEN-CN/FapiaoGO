"""
OCR 专属后处理：图片型发票的列修复
文本型 PDF 完全不经过此模块
"""

import logging
from typing import List, Dict, Tuple, Optional

from .line_item_segmenter import HEADER_PATTERNS, segment_from_chars, grid_to_excel_rows
from .models import Token

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════
#  1. Token 级合并（在 segment_from_chars 之前修改 token 列表）
# ═══════════════════════════════════════════════════════════


_HEADER_MERGE_CANDIDATES = {
    # ── 单字对（OCR 把两字词拆成两个独立 token）──
    ('单', '位'): '单位',
    ('单', '价'): '单价',
    ('数', '量'): '数量',
    ('金', '额'): '金额',
    ('税', '率'): '税率',
    ('税', '额'): '税额',
    ('规', '格'): '规格',
    ('型', '号'): '型号',
  
}


def _merge_header_tokens_in_place(
    tokens: List[Token],
    y_tol: float = 4.0,
    x_gap_tol: float = 20.0,
) -> None:
    """
    原地合并同一行被拆分的相邻表头 Token。

    如 "单" + "位" → "单位"，"金" + "额" → "金额"。
    合并后修改第一个 token 的 text 和包围盒，将第二个 token 标记为已删除。

    Args:
        tokens: Token 列表（会被原地修改）
        y_tol: y 中心容差（像素）
        x_gap_tol: x 间隙最大容差（像素）
    """
    deleted = set()

    for i, t1 in enumerate(tokens):
        if i in deleted:
            continue

        # 如果 t1 自身已是完整表头（如 "金额"、"税率"），不参与合并
        t1_text = t1.text.strip()
        if any(p.fullmatch(t1_text) for p in HEADER_PATTERNS):
            continue

        for j in range(i + 1, len(tokens)):
            if j in deleted:
                continue
            t2 = tokens[j]

            # 同一行检查
            if abs(t1.cy - t2.cy) > y_tol:
                continue

            # x 间隙检查（t1 在左，t2 在右）
            gap = t2.x0 - t1.x1
            if not (0 <= gap <= x_gap_tol):
                continue

            # 检查已知的合并候选
            key = (t1.text.strip(), t2.text.strip())
            if key in _HEADER_MERGE_CANDIDATES:
                merged_text = _HEADER_MERGE_CANDIDATES[key]
                t1.text = merged_text
                t1.x0 = min(t1.x0, t2.x0)
                t1.x1 = max(t1.x1, t2.x1)
                t1.y0 = min(t1.y0, t2.y0)
                t1.y1 = max(t1.y1, t2.y1)
                deleted.add(j)
                logger.debug("[OCRPost] 合并: '%s' + '%s' → '%s'",
                            key[0], key[1], merged_text)
                break

            # 用 HEADER_PATTERNS 兜底校验
            # 限制合并后长度 ≤ 4 字，避免两个独立完整 token 被误合并
            combined = t1.text.strip() + t2.text.strip()
            combined_nospace = ''.join(combined.split())
            if len(combined_nospace) <= 4 and any(
                p.search(combined) or p.search(combined_nospace)
                for p in HEADER_PATTERNS
            ):
                t1.text = combined_nospace
                t1.x0 = min(t1.x0, t2.x0)
                t1.x1 = max(t1.x1, t2.x1)
                t1.y0 = min(t1.y0, t2.y0)
                t1.y1 = max(t1.y1, t2.y1)
                deleted.add(j)
                logger.debug("[OCRPost] 合并(HEADER_PATTERN): '%s' + '%s' → '%s'",
                            key[0], key[1], combined_nospace)
                break

    # 移除被合并的 token
    if deleted:
        tokens[:] = [t for i, t in enumerate(tokens) if i not in deleted]
        logger.info("[OCRPost] 表头合并: 移除 %d 个冗余 token", len(deleted))


# ═══════════════════════════════════════════════════════════
#  3. 列名修复（兜底）
# ═══════════════════════════════════════════════════════════


def fix_ocr_column_headers(rows: List[Dict[str, str]]) -> List[Dict[str, str]]:
    """
    修复图片型 OCR 产出的偏移列名
    文本型 PDF 不走此逻辑
    """
    if not rows:
        return rows

    headers = list(rows[0].keys())
    logger.info("[OCRPost] 修复前列名: %s", headers)

    # ── 修复1: '位' → '单位' ──
    new_headers = []
    for h in headers:
        if h == '位':
            new_headers.append('单位')
            logger.info("[OCRPost] 修复列名: '位' → '单位'")
        else:
            new_headers.append(h)

    # ── 修复2: '金额 税率/征收率' 拆分 ──
    for i, h in enumerate(new_headers):
        if '金额' in h and '税率' in h:
            # 找左侧最近的空列/占位列
            for j in range(i - 1, -1, -1):
                if new_headers[j] in ('', None) or new_headers[j].startswith('列'):
                    new_headers[j] = '金额'
                    logger.info("[OCRPost] 修复列名: 列%d → '金额'", j)
                    break
            # 清理当前列名
            cleaned = h.replace('金额', '').strip().lstrip('/').strip()
            new_headers[i] = cleaned if cleaned else '税率/征收率'
            logger.info("[OCRPost] 修复列名: '%s' → '%s'", h, new_headers[i])

    # ── 移除空列/占位列 ──
    final_headers = []
    col_map = {}  # 旧索引 → 新索引
    new_idx = 0
    for i, h in enumerate(new_headers):
        if h and not h.startswith('列'):
            final_headers.append(h)
            col_map[i] = new_idx
            new_idx += 1

    logger.info("[OCRPost] 修复后列名: %s", final_headers)

    # ── 重映射数据 ──
    result = []
    for row in rows:
        new_row = {h: '' for h in final_headers}
        for old_idx, new_idx in col_map.items():
            old_h = headers[old_idx] if old_idx < len(headers) else ''
            val = row.get(old_h, '')
            new_row[final_headers[new_idx]] = val
        result.append(new_row)

    return result


# ═══════════════════════════════════════════════════════════
#  4. 完整 OCR 路径封装
# ═══════════════════════════════════════════════════════════


def process_ocr_line_items(tokens: List[Token]) -> Tuple[List[Dict[str, str]], dict]:
    """
    图片型 OCR 的完整项目明细提取路径（v2：绕过 segment_from_chars）

    核心改动：
    1. 保留表头 token 合并（_merge_header_tokens_in_place）
    2. 用基于 bbox 的行/列分割替代 segment_from_chars 的字符级聚类
    3. 直接产出 grid，然后走 grid_to_excel_rows

    Returns:
        (excel_rows, segment_result)
    """
    logger.info("[OCRPath] 入口: tokens=%d", len(tokens))

    # 1. 合并表头 token（保留）
    _merge_header_tokens_in_place(tokens)

    # 2. 基于 bbox 的行分割（替代 segment_from_chars 的字符级聚类）
    rows = _cluster_tokens_by_bbox(tokens)
    logger.info("[OCRPath] bbox 行分割: %d 行", len(rows))

    # 3. 找表头行
    header_idx = _find_header_row(rows)
    if header_idx < 0:
        logger.warning("[OCRPath] 未找到表头行, 回退 segment_from_chars")
        seg_result = segment_from_chars(tokens)
        if seg_result and seg_result.get('grid'):
            rows = grid_to_excel_rows(
                seg_result['grid'], seg_result['header_lines'],
                item_lines=seg_result.get('item_lines'),
            )
            rows = fix_ocr_column_headers(rows)
        return rows, seg_result or {}

    # 4. 基于表头行推断列边界
    col_boundaries = _infer_col_boundaries_from_header(rows[header_idx])
    logger.info("[OCRPath] 列边界: %s", [f"{b:.0f}" for b in col_boundaries])

    # 5. 构建 grid（每行按列边界分配 token）
    grid = _build_grid(rows, col_boundaries)
    logger.info("[OCRPath] grid: %dx%d", len(grid), len(grid[0]) if grid else 0)

    # 6. 终止检测 + 构建明细行索引
    #    GridToExcel Phase 2 会按星号合并续行，但合计行及其之后的行应该排除。
    #    复用文本型的终止逻辑：找到第一个合计行特征（连续空行/双¥/"合"+"计"）截断。
    item_lines: List[int] = []
    consecutive_blank = 0
    for i in range(header_idx + 1, len(grid)):
        row_text = ' '.join(grid[i])
        is_blank = not row_text.strip()
        has_he = '合' in row_text
        has_ji = '计' in row_text
        has_yen = '¥' in row_text or '￥' in row_text

        # 空行计数
        if is_blank:
            consecutive_blank += 1
            if consecutive_blank >= 2:
                logger.debug("[OCRPath] 终止: 连续 %d 行空白, 截断于行%d", consecutive_blank, i - 1)
                break
            continue
        consecutive_blank = 0

        # 合计行检测：双￥（最明显特征）、"合"+"计"+¥、"价税合计"
        yen_count = row_text.count('¥') + row_text.count('￥')
        if yen_count >= 2 or (has_he and has_ji and has_yen) or '价税合计' in row_text:
            logger.debug("[OCRPath] 终止: 行%d 匹配合计行 '%s'", i, row_text.strip()[:40])
            break

        item_lines.append(i)

    logger.info("[OCRPath] 明细行: %d 行 (索引=%s..%s)", len(item_lines),
                item_lines[0] if item_lines else '?', item_lines[-1] if item_lines else '?')

    # 7. 转 Excel
    excel_rows = grid_to_excel_rows(grid, [header_idx], item_lines=item_lines)
    logger.info("[OCRPath] grid_to_excel_rows → %d 行", len(excel_rows))

    # 8. 修复列名
    excel_rows = fix_ocr_column_headers(excel_rows)

    seg_result = {
        'grid': grid,
        'header_lines': [header_idx],
        'item_lines': item_lines,
    }

    logger.info("[OCRPath] 出口: excel_rows=%d, grid=%s",
                len(excel_rows), f"{len(grid)}x{len(grid[0])}" if grid and grid[0] else "None")
    return excel_rows, seg_result


# ═══════════════════════════════════════════════════════════
#  5. BBox 级辅助函数（绕过 segment_from_chars）
# ═══════════════════════════════════════════════════════════


def _cluster_tokens_by_bbox(tokens: List[Token]) -> List[List[Token]]:
    """
    基于 OCR 引擎的原始行聚类结果将 tokens 按行分组。

    OCR 引擎（merge_ocr_boxes_by_row）已产出按行排列的 tokens，
    相邻 token 的 cy 差 ≤ 4px 视为同一行。这里直接用 OCR 引擎
    的聚类结果，不做二次聚类。
    """
    if not tokens:
        return []

    # 按 (cy, x) 排序
    sorted_tokens = sorted(tokens, key=lambda t: (t.cy, t.x))

    # DEBUG: 输出 cy 分布
    cy_values = [t.cy for t in sorted_tokens]
    cy_diffs = [f"{cy_values[i+1]-cy_values[i]:.1f}" for i in range(len(cy_values)-1)]
    logger.debug("[OCRPath/BBox] cy 序列 (前20): %s", [f"{v:.1f}" for v in cy_values[:20]])
    logger.debug("[OCRPath/BBox] cy 差值 (前20): %s", cy_diffs[:20])

    rows: List[List[Token]] = []
    current_row: List[Token] = [sorted_tokens[0]]
    row_anchor_cy = sorted_tokens[0].cy

    for token in sorted_tokens[1:]:
        # 与当前行的锚点（第一个 token）的 cy 比较
        # cy 差值分析：行内最大 5px，行间距最小 20px
        # 阈值 8px 安全隔离行间
        if abs(token.cy - row_anchor_cy) > 8.0:
            # 新行
            if current_row:
                current_row.sort(key=lambda t: t.x)
                rows.append(current_row)
            current_row = [token]
            row_anchor_cy = token.cy
        else:
            current_row.append(token)

    if current_row:
        current_row.sort(key=lambda t: t.x)
        rows.append(current_row)

    logger.debug("[OCRPath/BBox] 按 OCR 引擎行聚类: %d tokens → %d 行", len(tokens), len(rows))
    return rows


def _find_header_row(rows: List[List[Token]]) -> int:
    """找表头行：包含最多表头关键词的行"""
    best_idx = -1
    best_score = 0

    for i, row in enumerate(rows):
        row_text = ''.join(t.text for t in row)
        score = 0
        keywords = ['项目名称', '规格型号', '单位', '数量', '单价', '金额', '税率', '税额']
        for kw in keywords:
            if kw in row_text:
                score += 1

        if score > best_score:
            best_score = score
            best_idx = i

    return best_idx if best_score >= 2 else -1


def _infer_col_boundaries_from_header(header_row: List[Token]) -> List[float]:
    """从表头行推断列边界。相邻表头 token 之间的中点作为列边界。"""
    if not header_row:
        return []

    tokens = sorted(header_row, key=lambda t: t.x)
    boundaries = []
    for i in range(len(tokens) - 1):
        mid = (tokens[i].x1 + tokens[i + 1].x0) / 2
        boundaries.append(mid)
    return boundaries


def _build_grid(rows: List[List[Token]], col_boundaries: List[float]) -> List[List[str]]:
    """
    构建 grid：每行按列边界分配 token 文本。

    与 segment_from_chars 的区别：
    - segment_from_chars 用字符级网格（8 列，与真实列数不符）
    - 这里用 token 直接分配，列数 = len(col_boundaries) + 1
    """
    n_cols = len(col_boundaries) + 1
    grid: List[List[str]] = []

    for row in rows:
        cells = [''] * n_cols
        for token in row:
            # 找到 token 中心点所在的列
            cx = (token.x0 + token.x1) / 2
            col = 0
            for boundary in col_boundaries:
                if cx < boundary:
                    break
                col += 1

            # 追加文本（同一列可能有多个 token）
            if cells[col]:
                cells[col] += ' ' + token.text
            else:
                cells[col] = token.text

        grid.append(cells)

    return grid
