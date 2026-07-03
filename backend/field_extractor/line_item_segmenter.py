"""
发票项目明细区域分割器

从带坐标的文本行中精确切割出发票项目明细区域，
包括表头行和所有明细数据行。

双引擎设计：
  1. 主引擎：*分类编码* 锚点 + 列网格空间校验
  2. 兜底引擎：纯列网格数字特征分割

Usage:
    from .line_item_segmenter import segment_line_items
    result = segment_line_items(lines)
    # => {'header_lines': [...], 'item_lines': [...], 'start': int, 'end': int} | None
"""
import logging
import re
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np

from .models import Line

logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)
logger.propagate = False
if not logger.handlers:
    _ch = logging.StreamHandler()
    _ch.setLevel(logging.DEBUG)
    _fmt = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    _ch.setFormatter(_fmt)
    logger.addHandler(_ch)


# ═══════════════════════════════════════════════════════════
#  字符级数据类
# ═══════════════════════════════════════════════════════════


@dataclass
class Char:
    """单个字符及其坐标"""
    char: str
    x0: float
    y0: float
    x1: float
    y1: float
    page: int

# ═══════════════════════════════════════════════════════════
#  配置参数
# ═══════════════════════════════════════════════════════════

# 表头列名正则（已含空格容错）
HEADER_PATTERNS = [
    re.compile(r'项目名称|货物或应税劳务、服务名称|货物.*名称|服务名称|品名'),
    re.compile(r'规格型号|规格'),
    re.compile(r'单\s*位'),
    re.compile(r'数\s*量'),
    re.compile(r'单\s*价'),
    re.compile(r'金\s*额'),
    re.compile(r'税率\s*/\s*征收率|税率|征收率'),
    re.compile(r'税\s*额'),
]

# 分类编码正则
CLASS_CODE_PAT = re.compile(r'\*[^*]+\*')
ITEM_START_RE = re.compile(r'^\*[^*]+\*')
HAS_NUMBER_RE = re.compile(r'\d+\.?\d*')

# 终止词
TERMINATOR_KW = ['合计', '价税合计', '小计', '大写', '小写', '收款人', '复核人', '开票人']

# 列模式顺序模板
COL_ORDER_TEMPLATE = [0, 1, 2, 3, 4, 5, 6, 7]

# 聚类与校验参数
COL_CLUSTER_EPS = 14.0        # x 聚类容差（像素）
Y_CLUSTER_TOLERANCE = 5.0     # y 聚类容差（像素）
HEADER_SEARCH_WINDOW = 10     # 回溯行数
HEADER_MIN_PATTERNS = 3       # 判定表头最少不同模式数
BLANK_TOLERANCE = 2           # 连续非明细行数阈值
MIN_MERGE_CODES = 2           # 拆行所需分类编码出现次数

# 列边界微调偏移量（像素），正数右移（扩左列缩右列），负数左移（缩左列扩右列）
# 索引 0-6 对应 7 个列边界：[规, 单, 位, 量, 价, 额, 率]
COL_BOUNDARY_ADJUSTMENTS = [-0.5, -0.5, 3.0, 0.2, 3.0, 3.0, 3.0]

# ── 简易聚类 ──────────────────────────────────────────────


def _cluster_1d(values: List[float], eps: float) -> List[List[float]]:
    """一维数据按 eps 距离聚类（替代 DBSCAN，无外部依赖）"""
    if not values:
        return []
    sorted_vals = sorted(values)
    clusters = [[sorted_vals[0]]]
    for v in sorted_vals[1:]:
        if v - clusters[-1][-1] <= eps:
            clusters[-1].append(v)
        else:
            clusters.append([v])
    return clusters


def _cluster_1d_with_items(items: List, get_value, eps: float) -> List[List]:
    """一维聚类：保留原始元素（替代 sklearn DBSCAN for 1D data, min_samples=1）
    
    因为都是 min_samples=1 的一维有序聚类，不需要 sklearn 的复杂 DBSCAN 实现。
    
    Args:
        items: 待聚类的元素列表
        get_value: 函数，从 item 提取用于聚类的一维坐标值
        eps: 邻域半径（同一聚类中相邻值最大差）
    
    Returns:
        聚类后的列表，每个聚类是原始 item 的列表，按值升序排列
    """
    if not items:
        return []
    indexed = [(get_value(item), i, item) for i, item in enumerate(items)]
    indexed.sort(key=lambda x: x[0])
    
    clusters = [[indexed[0][2]]]
    for v, idx, item in indexed[1:]:
        prev_v = get_value(clusters[-1][-1])
        if v - prev_v <= eps:
            clusters[-1].append(item)
        else:
            clusters.append([item])
    return clusters


# ═══════════════════════════════════════════════════════════
#  1.预处理：拆分被合并的明细行
# ═══════════════════════════════════════════════════════════


def split_merged_item_line(line: Line) -> List[Line]:
    """如果一个 Line 内出现 >=2 个分类编码，按编码起始位置切分"""
    text = line.text.strip()
    matches = list(CLASS_CODE_PAT.finditer(text))
    if len(matches) <= 1:
        return [line]

    logger.info("[LineSegmenter] 拆分行: %d 个编码 → %d 个子行 | 原文: %s",
                len(matches), len(matches), text[:60])

    parts = []
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i < len(matches) - 1 else len(text)
        parts.append(text[start:end].strip())

    n = len(parts)
    total_h = max(line.y1 - line.y, 1.0)
    h_part = total_h / n
    sub_lines = []
    for i, part in enumerate(parts):
        sub_lines.append(Line(
            text=part,
            y0=line.y + i * h_part,
            y1=line.y + (i + 1) * h_part,
            x0=line.x, x1=line.x1,
            page=line.page,
        ))
    return sub_lines


def preprocess_lines(lines: List[Line]) -> List[Line]:
    """预处理流水线：拆分合并行"""
    result = []
    for line in lines:
        result.extend(split_merged_item_line(line))
    return result


# ═══════════════════════════════════════════════════════════
#  2. 构建列网格
# ═══════════════════════════════════════════════════════════


def build_columns(lines: List[Line], eps: float = COL_CLUSTER_EPS) -> Tuple[List[float], List[float]]:
    """基于 x 中心点聚类，返回列中心列表和列边界列表"""
    if not lines:
        return [], []
    xs = [l.cx for l in lines]
    clusters = _cluster_1d(xs, eps)
    centers = sorted([sum(c) / len(c) for c in clusters])
    boundaries = [(centers[i] + centers[i + 1]) / 2.0 for i in range(len(centers) - 1)]
    logger.info("[LineSegmenter] 列网格: %d 个聚类, 列中心=%s, 边界=%s",
                len(clusters),
                [f'{c:.0f}' for c in centers],
                [f'{b:.0f}' for b in boundaries])
    return centers, boundaries


def get_col_index(line: Line, boundaries: List[float]) -> int:
    """返回 TextLine 所属的列索引（委托给 _char_get_col_index）"""
    return _char_get_col_index(line.cx, boundaries)


# ═══════════════════════════════════════════════════════════
#  3. 明细行定位（主引擎）
# ═══════════════════════════════════════════════════════════


def is_item_line(line: Line) -> bool:
    """判断是否为明细行：行首 *分类编码* + 行内含数字"""
    if not ITEM_START_RE.match(line.text):
        return False
    if not HAS_NUMBER_RE.search(line.text):
        return False
    logger.debug("[LineSegmenter] 明细行命中: %s", line.text[:50])
    return True


# ═══════════════════════════════════════════════════════════
#  4. 表头回溯
# ═══════════════════════════════════════════════════════════


def is_column_order_plausible(col_pattern_ids: List[int]) -> bool:
    """检查列 pattern_id 顺序是否基本递增（允许缺失和最多 1 个逆序）。

    OCR 可能丢失某些字符（如"单位"只识别出"位"），
    导致 pattern_id 序列缺失中间值或出现 1 处局部乱序，
    只要整体大致递增即可视为合法表头。
    """
    if len(col_pattern_ids) < 2:
        return True
    # 过滤掉未匹配的 -1
    valid = [p for p in col_pattern_ids if p >= 0]
    if len(valid) < 2:
        return True
    inversions = sum(1 for i in range(len(valid) - 1) if valid[i] > valid[i + 1])
    return inversions <= 1


def find_header_range(
    lines: List[Line],
    first_item_idx: int,
    boundaries: List[float],
    window: int = HEADER_SEARCH_WINDOW,
    min_patterns: int = HEADER_MIN_PATTERNS,
    y_tol: float = Y_CLUSTER_TOLERANCE,
) -> Optional[Tuple[int, int]]:
    """从第一个明细行向上回溯，定位表头行索引范围"""
    start_idx = max(0, first_item_idx - window)
    search_lines = lines[start_idx:first_item_idx]
    logger.info("[LineSegmenter] 表头回溯: first_item_idx=%d, 回溯范围=[%d, %d)",
                first_item_idx, start_idx, first_item_idx)

    # 收集匹配片段（每行可匹配多个不同 pattern_id）
    fragments = []
    for i, line in enumerate(search_lines):
        real_idx = start_idx + i
        yc = line.cy
        seen_patterns = set()
        for pi, pat in enumerate(HEADER_PATTERNS):
            if pi in seen_patterns:
                continue
            if pat.search(line.text):
                fragments.append({
                    'idx': real_idx,
                    'y_center': yc,
                    'pattern_id': pi,
                    'col': get_col_index(line, boundaries) if boundaries else -1,
                })
                seen_patterns.add(pi)

    if not fragments:
        logger.info("[LineSegmenter] 表头回溯: 未找到任何表头关键词匹配")
        return None
    logger.debug("[LineSegmenter] 表头回溯: 收集到 %d 个片段", len(fragments))

    # y 聚类
    fragments.sort(key=lambda f: f['y_center'])
    clusters = []
    curr_cluster = [fragments[0]]
    curr_y = fragments[0]['y_center']
    for f in fragments[1:]:
        if abs(f['y_center'] - curr_y) <= y_tol:
            curr_cluster.append(f)
        else:
            clusters.append(curr_cluster)
            curr_cluster = [f]
            curr_y = f['y_center']
    clusters.append(curr_cluster)
    logger.debug("[LineSegmenter] 表头回溯: y 聚类得到 %d 个候选组", len(clusters))

    # 筛选有效聚类
    all_idxs = []
    for ci, cluster in enumerate(clusters):
        pids = set(f['pattern_id'] for f in cluster)
        if len(pids) < min_patterns:
            logger.debug("[LineSegmenter] 表头回溯: 组%d 跳过(模式数=%d<%d)", ci, len(pids), min_patterns)
            continue
        # 列顺序验证
        cols_pids = [(f['col'], f['pattern_id']) for f in cluster if f['col'] >= 0]
        cols_pids.sort(key=lambda x: x[0])
        col_order = [pid for _, pid in cols_pids]
        if not is_column_order_plausible(col_order):
            logger.debug("[LineSegmenter] 表头回溯: 组%d 列顺序异常 %s", ci, col_order)
            continue
        idxs = sorted(set(f['idx'] for f in cluster))
        all_idxs.extend(idxs)
        first_line = lines[idxs[0]].text[:40] if idxs[0] < len(lines) else ''
        logger.debug("[LineSegmenter] 表头回溯: 组%d 有效(模式=%s, 列序=%s) 首行=%s",
                     ci, sorted(pids), col_order, first_line)

    if not all_idxs:
        logger.info("[LineSegmenter] 表头回溯: 无有效聚类")
        return None

    result = (min(all_idxs), max(all_idxs))
    logger.info("[LineSegmenter] 表头回溯: 成功 → 行范围 %s", str(result))
    return result


# ═══════════════════════════════════════════════════════════
#  5. 结束行检测
# ═══════════════════════════════════════════════════════════

# 金额列索引（通过表头或兜底推断），由上层函数传入
_AMOUNT_COL_INDEX = -1  # 全局临时变量，仅在 find_item_end 作用域使用


def find_item_end_by_project_col(
    lines: List[Line],
    last_item_idx: int,
    blank_tolerance: int = 2,
) -> int:
    consecutive_blank = 0
    for i in range(last_item_idx + 1, len(lines)):
        text = lines[i].text.strip()
        is_blank = not text  # 空行

        if not is_blank:
            # 有内容的行，重置计数
            consecutive_blank = 0
            continue

        # 空行：累加计数
        consecutive_blank += 1
        if consecutive_blank >= blank_tolerance:
            end_idx = i - blank_tolerance
            logger.debug("[LineSegmenter/EndDetect] 连续空行截断: "
                         "第%d行开始连续%d行空白(累计%d), 截断于%d, 前一行='%s'",
                         i - blank_tolerance + 1, blank_tolerance,
                         consecutive_blank, end_idx,
                         lines[i - blank_tolerance].text.strip()[:30] if i >= blank_tolerance else '')
            return max(end_idx, last_item_idx)

    logger.debug("[LineSegmenter/EndDetect] 未出现连续%d行空白, 回退合计y偏移检测", blank_tolerance)
    return find_item_end_by_heji_y(lines, last_item_idx)


def find_item_end_by_heji_y(
    lines: List[Line],
    last_item_idx: int,
    y_offset: float = 1.0,
) -> int:
    """
    根据 '合'+'计' y 坐标往上偏移截断

    在发票中，合计金额行（如 ¥1113.85）通常紧贴在"合计"文字的上方
    2~5px。通过定位"合计"的 y0 再往上偏移 y_offset，可以精确排除
    价税汇总区的所有行。

    Args:
        lines: 文本行列表（Line 需有 y0/y1/cy 属性）
        last_item_idx: 最后一条确信明细行的索引
        y_offset: 往上偏移像素，默认 4px

    Returns:
        截断后的结束行索引（last_item_idx <= 返回值 < len(lines)）
    """
    heji_y: Optional[float] = None

    # 优先检测双¥行（合计行通常包含两个¥：不含税金额+价税合计）
    for i, line in enumerate(lines):
        yen_count = line.text.count('¥') + line.text.count('￥')
        if yen_count >= 2:
            heji_y = line.y0
            logger.info("[LineSegmenter] 双¥行检测: 行%d '%s'(y=%.1f, ¥出现%d次)",
                        i, line.text.strip()[:40], heji_y, yen_count)
            break

    if heji_y is None:
        for i, line in enumerate(lines):
            text = line.text.strip()
            if text == '合':
                for j in range(i + 1, min(i + 5, len(lines))):
                    if lines[j].text.strip() == '计':
                        if abs(line.cy - lines[j].cy) <= 3:
                            heji_y = min(line.y0, lines[j].y0)
                            break
                if heji_y:
                    logger.info("[LineSegmenter] 合/计分离行: 行%d '合'(y=%.1f) + 行%d '计'(y=%.1f)",
                                i, line.y0, j, lines[j].y0)
                    break
            elif '合计' in text:
                heji_y = line.y0
                logger.info("[LineSegmenter] 合计整词行: 行%d '%s'(y=%.1f)",
                            i, text[:30], heji_y)
                break

    if heji_y is None:
        logger.warning("[LineSegmenter] 未找到合计行，回退到 find_item_end")
        return find_item_end(lines, last_item_idx, [], -1)

    cutoff_y = heji_y - y_offset
    logger.info("[LineSegmenter] 截断线: y=%.1f (合计y0=%.1f - %.1fpx)",
                cutoff_y, heji_y, y_offset)

    # 从 last_item_idx 往后找第一个 y0 >= cutoff_y 的行
    for i in range(last_item_idx, len(lines)):
        if lines[i].y0 >= cutoff_y:
            end_idx = max(i - 1, last_item_idx)
            logger.info("[LineSegmenter] 结束行: %d (last_item=%d, 截止y=%.1f)",
                        end_idx, last_item_idx, cutoff_y)
            return end_idx

    logger.info("[LineSegmenter] 无行超出截断线，返回末尾")
    return len(lines) - 1


def find_item_end(
    lines: List[Line],
    last_item_idx: int,
    boundaries: List[float],
    amount_col: int = -1,
    blank_tolerance: int = BLANK_TOLERANCE,
    item_line_set: Optional[set] = None,
) -> int:
    """从最后一条明细行向下搜索，确定区域结束索引

    Args:
        item_line_set: 预计算的明细行索引集合（避免重复正则匹配）
    """
    consecutive_blank = 0
    for i in range(last_item_idx + 1, len(lines)):
        text = lines[i].text.strip()
        col = get_col_index(lines[i], boundaries) if boundaries else -1

        # 条件1：终止关键词在金额列（或全局匹配）
        if amount_col >= 0 and col == amount_col:
            if any(kw in text for kw in TERMINATOR_KW):
                logger.info("[LineSegmenter] 结束检测: 行%d 金额列命中终止词 '%s'", i, text[:30])
                return i - 1
        else:
            if any(kw in text for kw in TERMINATOR_KW):
                logger.info("[LineSegmenter] 结束检测: 行%d 全局命中终止词 '%s'", i, text[:30])
                return i - 1

        # 条件2：连续非明细无数字行（优先用预计算集合，避免重复正则）
        if item_line_set is not None:
            is_item = i in item_line_set
        else:
            is_item = bool(ITEM_START_RE.match(text))
        if not is_item and not HAS_NUMBER_RE.search(text):
            consecutive_blank += 1
            if consecutive_blank >= blank_tolerance:
                logger.info("[LineSegmenter] 结束检测: 行%d 连续%d行无数字，截断", i, blank_tolerance)
                return i - blank_tolerance
        else:
            consecutive_blank = 0
    logger.info("[LineSegmenter] 结束检测: 扫描至末尾(行%d)", len(lines) - 1)
    return len(lines) - 1


# ═══════════════════════════════════════════════════════════
#  6. 区域清洗
# ═══════════════════════════════════════════════════════════


def clean_item_lines(
    lines: List[Line],
    item_start: int,
    item_end: int,
    boundaries: List[float],
) -> List[int]:
    """在 [item_start, item_end] 内剔除空行和非明细行"""
    clean_indices = []
    for i in range(item_start, item_end + 1):
        if not lines[i].text.strip():
            continue
        clean_indices.append(i)
    return clean_indices


# ═══════════════════════════════════════════════════════════
#  7. 兜底策略：纯列网格分割
# ═══════════════════════════════════════════════════════════


def _infer_amount_col_by_density(
    lines: List[Line],
    boundaries: List[float],
) -> int:
    """通过统计每列数字密度推断金额列（数字最多的右侧列通常是金额列）"""
    if not boundaries:
        return -1
    n_cols = len(boundaries) + 1
    digit_counts = [0] * n_cols
    total_counts = [0] * n_cols
    for line in lines:
        col = get_col_index(line, boundaries)
        total_counts[col] += 1
        if HAS_NUMBER_RE.search(line.text):
            digit_counts[col] += 1

    ratios = [
        (digit_counts[i] / max(total_counts[i], 1), i)
        for i in range(n_cols)
    ]
    ratios.sort(key=lambda x: -x[0])
    # 取数字密度最高的列，但偏向右侧（金额列通常在右侧）
    for _, col in ratios:
        if col >= n_cols - 3:  # 右侧三列之一
            logger.debug("[LineSegmenter] 金额列推断: 列%d (密度%.2f, 右侧%d列之一)", col, digit_counts[col]/max(total_counts[col],1), n_cols)
            return col
    result = ratios[0][1] if ratios else -1
    logger.debug("[LineSegmenter] 金额列推断: 列%d (密度最高)", result)
    return result


def fallback_segment_by_columns(
    lines: List[Line],
    col_centers: List[float],
    boundaries: List[float],
) -> Optional[dict]:
    """无 *分类编码* 时的兜底：纯列网格数字特征分割"""
    if not boundaries:
        logger.info("[LineSegmenter] 兜底跳过: 无列边界信息")
        return None

    amount_col = _infer_amount_col_by_density(lines, boundaries)
    logger.info("[LineSegmenter] 进入兜底路径, 金额列=%d, 总行数=%d", amount_col, len(lines))

    # 1. 寻找表头：扫描含 ≥2 个表头关键词的行
    header_candidates = []
    for i, line in enumerate(lines):
        hits = sum(1 for pat in HEADER_PATTERNS if pat.search(line.text))
        if hits >= 2:
            header_candidates.append(i)
    if not header_candidates:
        logger.info("[LineSegmenter] 兜底: 未找到表头行")
        return None
    logger.debug("[LineSegmenter] 兜底: 表头候选行=%s", header_candidates)

    # 取最后一个表头候选行（最接近明细区域）作为表头
    header_end = header_candidates[-1]
    # 向上合并同一水平线的表头行（y 聚类）
    header_y = lines[header_end].cy
    header_start = header_end
    for idx in reversed(header_candidates[:-1]):
        yc = lines[idx].cy
        if abs(yc - header_y) <= Y_CLUSTER_TOLERANCE:
            header_start = idx
        else:
            break

    # 2. 从表头下开始，找到有数字的第一行
    data_start = header_end + 1
    first_data = None
    for i in range(data_start, len(lines)):
        if HAS_NUMBER_RE.search(lines[i].text):
            # 若有列信息，额外检查金额列；无列信息直接认为命中
            if amount_col >= 0:
                col = get_col_index(lines[i], boundaries)
                if col == amount_col:
                    first_data = i
                    break
                # 如果列不匹配但该行确实包含数字类金额（常见写法），也接受
                if re.search(r'\d+\.\d{2}', lines[i].text):
                    first_data = i
                    break
            else:
                first_data = i
                break

    if first_data is None:
        return None

    # 3. 找到结束（项目列空行检测，回退合+计 y偏移截断）
    end_idx = find_item_end_by_project_col(lines, first_data)

    # 4. 清洗
    item_lines = clean_item_lines(lines, first_data, end_idx, boundaries)

    return {
        'header_lines': list(range(header_start, header_end + 1)),
        'item_lines': item_lines,
        'amount_col': amount_col,
        'start': header_start,
        'end': end_idx,
    }


# ═══════════════════════════════════════════════════════════
#  8. 主函数
# ═══════════════════════════════════════════════════════════


def segment_line_items(lines: List[Line], col_boundaries: List[float] = None) -> Optional[dict]:
    """
    发票项目明细区域分割主函数
    ...
    """
    original_count = len(lines)
    lines = preprocess_lines(lines)
    if not lines:
        logger.warning("[LineSegmenter] 分割失败: 输入为空")
        return None
    if len(lines) != original_count:
        logger.info("[LineSegmenter] 预处理: %d 行 → %d 行 (拆分合并)", original_count, len(lines))

    # 如果外部传入了列边界，跳过列聚类直接使用
    if col_boundaries is not None:
        col_centers = []
        boundaries = col_boundaries
    else:
        col_centers, boundaries = build_columns(lines)

    # 明细定位
    item_candidates = [i for i, l in enumerate(lines) if is_item_line(l)]
    item_line_set = set(item_candidates)  # 预计算集合，供 find_item_end 等复用
    logger.info("[LineSegmenter] 明细定位: %d 条候选 (共%d行)",
                len(item_candidates), len(lines))
    # 诊断：打印前 15 行及其 is_item_line 状态
    for ti, tl in enumerate(lines[:15]):
        has_star = bool(ITEM_START_RE.match(tl.text))
        has_num = bool(HAS_NUMBER_RE.search(tl.text))
        logger.info("[LineSegmenter] 诊断: lines[%d] star=%s num=%s item=%s text='%s'",
                     ti, has_star, has_num, ti in item_line_set, tl.text[:60])

    if not item_candidates:
        logger.info("[LineSegmenter] 主引擎无命中, 进入兜底路径")
        # 兜底：纯列网格分割
        result = fallback_segment_by_columns(lines, col_centers, boundaries)
        if result:
            logger.info("[LineSegmenter] 兜底成功: header=%s, items=%d行, end=%d",
                        result['header_lines'], len(result['item_lines']), result['end'])
            return result
        # 最后尝试：裸数字行直接匹配
        logger.info("[LineSegmenter] 兜底失败, 尝试裸数字兜底")
        return _fallback_standalone_numbers(lines)

    first_item = item_candidates[0]
    last_item = item_candidates[-1]
    logger.info("[LineSegmenter] 主引擎: first_item=%d '%s', last_item=%d '%s'",
                first_item, lines[first_item].text[:40],
                last_item, lines[last_item].text[:40])

    # 表头回溯
    header_range = find_header_range(lines, first_item, boundaries)
    if header_range:
        h_start, h_end = header_range
        logger.info("[LineSegmenter] 表头: 行[%d-%d] '%s'",
                    h_start, h_end, lines[h_start].text[:40])
    else:
        h_start = h_end = first_item - 1
        logger.info("[LineSegmenter] 表头: 未定位, 设为 first_item-1=(%d)", h_start)

    # 推断金额列（用于结束检测）
    amount_col = _infer_amount_col_by_density(
        lines[h_start:last_item + 1], boundaries
    )

    # 结束行（项目列空行检测，回退合+计 y偏移截断）
    end_idx = find_item_end_by_project_col(lines, last_item)
    if end_idx < last_item:
        logger.info("[LineSegmenter] 截断: 结束行 %d < last_item %d, 共 %d 行被截断 (保留 0~%d)",
                    end_idx, last_item, last_item - end_idx, end_idx)
    else:
        logger.info("[LineSegmenter] 结束行: %d (未提前截断, 保留全部 %d 行)",
                    end_idx, end_idx + 1)

    # 清洗明细行
    item_lines = clean_item_lines(lines, first_item, end_idx, boundaries)
    logger.info("[LineSegmenter] 清洗: %d 行 → %d 行 (剔除空行)",
                end_idx - first_item + 1, len(item_lines))

    result = {
        'header_lines': list(range(h_start, h_end + 1)),
        'item_lines': item_lines,
        'amount_col': amount_col,
        'start': h_start,
        'end': end_idx,
    }
    logger.info("[LineSegmenter] 分割完成: header=%s, items=%d行, 区域[%d-%d]",
                result['header_lines'], len(result['item_lines']), result['start'], result['end'])
    return result


def _fallback_standalone_numbers(lines: List[Line]) -> Optional[dict]:
    """极端兜底：直接找包含 8 位或 20 位纯数字的行作为明细"""
    for i, line in enumerate(lines):
        stripped = line.text.strip()
        if re.fullmatch(r'\d{8,20}', stripped):
            return {
                'header_lines': [max(0, i - 1)],
                'item_lines': [i],
                'amount_col': -1,
                'start': max(0, i - 1),
                'end': i,
            }
    return None


# ═══════════════════════════════════════════════════════════
#  9. 字符级入口（字符 → 行聚类 → 列聚类 → 网格）
# ═══════════════════════════════════════════════════════════


def extract_chars(page) -> List[Char]:
    """从 PyMuPDF Page 对象中提取所有字符，返回 Char 列表

    Args:
        page: PyMuPDF 的 Page 对象

    Returns:
        List[Char]: 提取到的所有字符
    """
    chars = []
    # 使用 rawdict 而非 dict：rawdict 在 PyMuPDF 1.27.x 中才包含 chars 数组
    raw = page.get_text("rawdict")
    blocks = raw.get("blocks", [])
    logger.debug("[LineSegmenter/Char] extract_chars: blocks=%d", len(blocks))

    n_lines = 0
    n_spans = 0
    n_chars_in_spans = 0
    for block in blocks:
        if block.get("type") != 0:          # 0 = 文本块
            continue
        blines = block.get("lines", [])
        n_lines += len(blines)
        for line in blines:
            spans = line.get("spans", [])
            n_spans += len(spans)
            for span in spans:
                span_chars = span.get("chars", [])
                n_chars_in_spans += len(span_chars)
                for c in span_chars:
                    bbox = c.get("bbox")
                    if bbox and len(bbox) >= 4:
                        chars.append(Char(
                            char=c.get("c", ""),
                            x0=bbox[0], y0=bbox[1],
                            x1=bbox[2], y1=bbox[3],
                            page=page.number,
                        ))

    # 若 rawdict 无 chars（某些 PyMuPDF 版本），回退：从 span.text + bbox 估算
    if not chars:
        logger.debug("[LineSegmenter/Char] extract_chars: rawdict 无 chars, "
                     "回退到 span.text 估算")
        for block in blocks:
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = span.get("text", "")
                    span_bbox = span.get("bbox")
                    if not text or not span_bbox or len(span_bbox) < 4:
                        continue
                    span_w = span_bbox[2] - span_bbox[0]
                    span_h = span_bbox[3] - span_bbox[1]
                    avg_w = span_w / max(len(text), 1)
                    for ci, ch in enumerate(text):
                        cx0 = span_bbox[0] + ci * avg_w
                        cx1 = cx0 + avg_w
                        chars.append(Char(
                            char=ch,
                            x0=cx0, y0=span_bbox[1],
                            x1=cx1, y1=span_bbox[3],
                            page=page.number,
                        ))

    # 若 text 也为空（图片型 PDF），尝试用 page.get_text("text") 兜底
    if not chars:
        raw_text = page.get_text("text")
        logger.debug("[LineSegmenter/Char] extract_chars: 文本型提取也失败, "
                     "get_text='%s...'", raw_text[:50] if raw_text else '(空)')

    logger.info("[LineSegmenter/Char] extract_chars: 提取 %d 个字符 "
                "(page=%d, blocks=%d, lines=%d, spans=%d, span_chars=%d)",
                len(chars), page.number, len(blocks),
                n_lines, n_spans, n_chars_in_spans)
    return chars


def cluster_chars_into_rows(
    chars: List[Char],
    y_tol: Optional[float] = None,
) -> List[List[Char]]:
    """按 y 中心点聚类字符到文本行（轻量级一维聚类，替代 sklearn DBSCAN）"""
    if not chars:
        return []

    if y_tol is None:
        heights = [c.y1 - c.y0 for c in chars]
        median_h = float(np.median(heights))
        y_tol = median_h * 0.6

    # 使用轻量级一维聚类替代 sklearn DBSCAN
    def _get_y(c):
        return (c.y0 + c.y1) / 2.0
    rows = _cluster_1d_with_items(chars, _get_y, y_tol)

    # 按平均 y 升序排列（排序确保稳定）
    rows.sort(key=lambda row: sum((c.y0 + c.y1) / 2.0 for c in row) / len(row))

    # 前3行的字符数分布（诊断用）
    char_counts = [len(r) for r in rows[:3]]
    y_ranges = []
    for r in rows[:3]:
        ys = [(c.y0 + c.y1) / 2.0 for c in r]
        y_ranges.append(f'{min(ys):.0f}-{max(ys):.0f}')
    logger.info("[LineSegmenter/Char] 行聚类: %d 个字符 → %d 行 (y_tol=%.1f) [light-cluster]",
                len(chars), len(rows), y_tol)
    logger.debug("[LineSegmenter/Char] 行聚类详情: 前3行字符数=%s, y范围=%s",
                 char_counts, y_ranges)
    return rows


def cluster_chars_into_columns(
    chars: List[Char],
    x_tol: Optional[float] = None,
) -> List[float]:
    """按 x 中心点聚类字符到列，返回列边界列表（轻量级一维聚类，替代 sklearn DBSCAN）

    Args:
        chars: 字符列表
        x_tol: x 聚类容差（像素）；默认取所有字符宽度的中位数 × 2

    Returns:
        List[float]: 列边界列表（相邻列中心的中点），长度 = 列数 - 1
    """
    if not chars:
        return []

    if x_tol is None:
        widths = [c.x1 - c.x0 for c in chars]
        x_tol = float(np.median(widths) * 2.0)
        logger.debug("[LineSegmenter/Char] 列聚类: 自动 x_tol=%.2f (宽度中位数=%.2f)",
                      x_tol, float(np.median(widths)))

    # 使用轻量级一维聚类替代 sklearn DBSCAN
    def _get_x(c):
        return (c.x0 + c.x1) / 2.0
    char_clusters = _cluster_1d_with_items(chars, _get_x, x_tol)

    # 计算聚类中心（x 均值）
    cluster_centers_x = []
    for cluster in char_clusters:
        xs = [_get_x(c) for c in cluster]
        cluster_centers_x.append(sum(xs) / len(xs))
    cluster_centers_x.sort()
    n_clusters = len(cluster_centers_x)

    # 边界 = 相邻中心点的中点
    boundaries = []
    for i in range(len(cluster_centers_x) - 1):
        boundaries.append((cluster_centers_x[i] + cluster_centers_x[i + 1]) / 2.0)

    logger.info("[LineSegmenter/Char] 列聚类: %d 个聚类 → %d 列, 边界=%s [light-cluster]",
                n_clusters, len(boundaries) + 1,
                [f'{b:.0f}' for b in boundaries])
    if boundaries:
        centers = [cluster_centers_x[i] for i in range(len(cluster_centers_x))]
        logger.debug("[LineSegmenter/Char] 列聚类详情: 列中心=%s, 列宽估算=%s",
                     [f'{c:.0f}' for c in centers],
                     [f'{cluster_centers_x[i+1]-cluster_centers_x[i]:.0f}' if i+1 < len(cluster_centers_x) else 'N/A'
                      for i in range(len(cluster_centers_x))])
    return boundaries


def _char_get_col_index(cx: float, boundaries: List[float]) -> int:
    """根据 x 中心点和列边界返回列索引（基于 float 而非 Line 对象）"""
    for i, b in enumerate(boundaries):
        if cx < b:
            return i
    return len(boundaries)


# 表头引导列合并的目标关键词
_TARGET_HEADERS_NORMALIZED = [
    ''.join(k.split())  # 去空格后用于模糊匹配
    for k in ['项目名称', '规格型号', '单位', '数量', '单价', '金额', '税率/征收率', '税额']
]


def merge_columns_by_header(
    col_boundaries: List[float],
    header_cells: List[str],
) -> List[float]:
    """根据表头单元格文本合并过分割的列边界。

    当列聚类过度分割（>8列）时，用表头文本与目标关键词匹配，
    将匹配同一关键词的相邻列合并为一列。

    Args:
        col_boundaries: 原始列边界列表
        header_cells: 表头最后一行的单元格文本列表

    Returns:
        合并后的列边界列表
    """
    if not col_boundaries or not header_cells:
        return col_boundaries

    n_cols = len(col_boundaries) + 1
    n_headers = len(header_cells)

    # 清洗每个 header cell，生成规范化的目标文本
    cleaned_cells = []
    for cell in header_cells[:n_cols]:
        # 去空白
        flat = ''.join(cell.split())
        cleaned_cells.append(flat)

    # 对每个 header cell，找匹配的目标关键词索引
    cell_target_indices = []
    for flat in cleaned_cells:
        matched = -1
        for ti, target in enumerate(_TARGET_HEADERS_NORMALIZED):
            if flat and (flat == target or flat in target or target in flat):
                matched = ti
                break
        cell_target_indices.append(matched)

    logger.debug("[MergeColumns] 表头→目标匹配: cells=%s, targets=%s",
                 [c[:8] for c in cleaned_cells[:n_cols]],
                 cell_target_indices)

    # 构建合并组：相邻且有相同 target_index 的列合并为一组
    # 同时如果多列连续匹配到不同的目标关键词，它们自然分开
    groups: List[List[int]] = []
    current_group: List[int] = [0]
    for col_idx in range(1, n_cols):
        ti_prev = cell_target_indices[col_idx - 1] if col_idx - 1 < len(cell_target_indices) else -1
        ti_curr = cell_target_indices[col_idx] if col_idx < len(cell_target_indices) else -1
        # 如果当前列匹配到目标，且与前一列匹配到同一目标 → 合并
        # 如果当前列未匹配目标，且前一列也未匹配 → 合并
        # 否则分开
        should_merge = False
        if ti_prev >= 0 and ti_curr >= 0 and ti_prev == ti_curr:
            should_merge = True
        elif ti_prev < 0 and ti_curr < 0:
            should_merge = True

        if should_merge:
            current_group.append(col_idx)
        else:
            groups.append(current_group)
            current_group = [col_idx]
    if current_group:
        groups.append(current_group)

    # 如果没有合并（每组只含 1 列），直接返回原边界
    if all(len(g) == 1 for g in groups):
        return col_boundaries

    # 计算合并后的边界
    # 从 col_boundaries 中选取每组之间的边界
    merged_bounds = []
    for group_idx in range(len(groups) - 1):
        # 当前组最后一列与下一组第一列之间的边界
        last_col = groups[group_idx][-1]
        next_col = groups[group_idx + 1][0]
        # 取原边界中这两列之间的分界
        if last_col < len(col_boundaries):
            merged_bounds.append(col_boundaries[last_col])
        else:
            # 如果最后一列没有对应边界（最后一列的右边界为无穷大）
            # 则取下一组第一列的前一个边界
            if next_col - 1 < len(col_boundaries):
                merged_bounds.append(col_boundaries[next_col - 1])

    logger.debug("[MergeColumns] 合并: %d 组 → %d 边界 (%d列)",
                 len(groups), len(merged_bounds), len(merged_bounds) + 1)
    return merged_bounds


def build_grid_and_lines(
    rows_items: list,
    col_boundaries: List[float],
) -> Tuple[List[Line], List[List[str]]]:
    """从字符/Token 级行和列边界构建网格和 Line 列表

    支持两种输入类型：
      - Char 列表（有 char 属性）：拆开按字符分配
      - Token 列表（有 text 属性）：整体分配，不拆分数字

    Args:
        rows_items: 每行的 Char 或 Token 列表
        col_boundaries: 列边界列表

    Returns:
        (lines, grid): Line 列表和字符串网格
    """
    if not rows_items:
        return [], []

    is_token_level = hasattr(rows_items[0][0], 'text')

    lines = []
    grid = []

    # ── 表头-明细行分离检测（仅字符级需要；Token 级已有完整文本） ──
    if not is_token_level:
        _HEADER_KW = {'项目', '规格', '型号', '单位', '数量', '单价', '金额', '税率', '税额'}
        _CODE_RE = re.compile(r'\*[^*]+\*')
        separated_rows = []
        for row_chars in rows_items:
            row_text = ''.join(c.char for c in row_chars)
            has_header_kw = any(kw in row_text for kw in _HEADER_KW)
            has_code = bool(_CODE_RE.search(row_text))
            if has_header_kw and has_code:
                xs = sorted([c.x0 for c in row_chars])
                mid_x = xs[len(xs) // 2]
                left = sorted([c for c in row_chars if c.x0 < mid_x], key=lambda c: c.x0)
                right = sorted([c for c in row_chars if c.x0 >= mid_x], key=lambda c: c.x0)
                if left and right:
                    logger.debug("[HeaderDetailSplit] 拆分行: '%s' → 左(%d) + 右(%d) chars",
                                 row_text[:40], len(left), len(right))
                    separated_rows.append(left)
                    separated_rows.append(right)
                    continue
            separated_rows.append(row_chars)
        rows_items = separated_rows

    if not col_boundaries:
        # 单列情况
        for row_items in rows_items:
            text = "".join(t.text if is_token_level else c.char for t in row_items)
            if not text.strip():
                continue
            y0 = min(it.y0 for it in row_items)
            y1 = max(it.y1 for it in row_items)
            x0 = min(it.x0 for it in row_items)
            x1 = max(it.x1 for it in row_items)
            lines.append(Line(text=text, y0=y0, y1=y1, x0=x0, x1=x1, page=row_items[0].page))
            grid.append([text])
        return lines, grid

    n_cols = len(col_boundaries) + 1
    for row_items in rows_items:
        cells = [""] * n_cols

        if is_token_level:
            # Token 级：按 token 中心点整体分配到列，不拆分字符
            for token in row_items:
                col_idx = _char_get_col_index(token.cx, col_boundaries)
                cells[col_idx] += token.text
        else:
            # 字符级：按字符中心点分配到列
            for c in row_items:
                col_idx = _char_get_col_index((c.x0 + c.x1) / 2.0, col_boundaries)
                cells[col_idx] += c.char

        text = " ".join(cells).strip()
        if not text:
            continue

        y0 = min(it.y0 for it in row_items)
        y1 = max(it.y1 for it in row_items)
        x0 = min(it.x0 for it in row_items)
        x1 = max(it.x1 for it in row_items)

        lines.append(Line(text=text, y0=y0, y1=y1, x0=x0, x1=x1, page=row_items[0].page))
        grid.append(cells)

    logger.info("[LineSegmenter] build_grid_and_lines: %d 行 → %d 条 Line (%s)",
                len(rows_items), len(lines), 'Token' if is_token_level else 'Char')
    if grid:
        preview = [cell[:20] for cell in grid[0]]
        logger.debug("[LineSegmenter] build_grid_and_lines: 首行单元格预览=%s, 网格尺寸=%dx%d",
                     preview, len(grid), len(grid[0]) if grid else 0)
    return lines, grid


def _make_header_search_helpers(items, key_fn: Callable, *, strict_before: bool = True):
    """创建表头关键字搜索辅助函数集（O(1) 查找 + 二分搜索）。

    预构建 {char: [(x0, x1), ...]} 索引，避免每次调用全量扫描 items。
    对 `_first_before` / `_first_after` 使用 bisect 二分定位。

    Args:
        items: 已按 x0 排序的元素列表（Char 或 Token）
        key_fn: item -> str 提取文本。
                Char 级: lambda c: c.char；Token 级: lambda t: t.text
        strict_before: _first_before 中使用 <（Char 级）还是 <=（Token 级，
                       兼容同 Token 内多字共享 x0 的情况）

    Returns:
        (_first, _last, _first_before, _first_after, _gap_mid)
    """
    # ── 预构建索引: {char: (x0s, positions)} 按 x0 升序 ──
    _raw_index: Dict[str, List[Tuple[float, Tuple[float, float]]]] = {}
    for item in items:
        text = key_fn(item)
        for ch in text:
            if ch not in _raw_index:
                _raw_index[ch] = []
            _raw_index[ch].append((item.x0, (item.x0, item.x1)))
    # 拆分为 x0s 列表（供 bisect）和 positions 列表（供取值）
    char_x0s: Dict[str, List[float]] = {}
    char_positions: Dict[str, List[Tuple[float, float]]] = {}
    for ch, entries in _raw_index.items():
        char_x0s[ch] = [e[0] for e in entries]
        char_positions[ch] = [e[1] for e in entries]

    def _first(target: str, use_x1: bool = False) -> float:
        """O(1) 查找目标字符首次出现的坐标"""
        positions = char_positions.get(target)
        if not positions:
            return -1
        return positions[0][1] if use_x1 else positions[0][0]

    def _last(target: str, use_x1: bool = False) -> float:
        """O(1) 查找目标字符最后出现的坐标"""
        positions = char_positions.get(target)
        if not positions:
            return -1
        return positions[-1][1] if use_x1 else positions[-1][0]

    def _first_before(before_char: str, target: str, use_x1: bool = False) -> float:
        """找在 before_char 首次出现之前的 target（二分搜索）"""
        before_x = _first(before_char, use_x1=False)
        if before_x < 0:
            return -1
        positions = char_positions.get(target)
        if not positions:
            return -1
        idx = bisect_left(char_x0s[target], before_x) if strict_before \
            else bisect_right(char_x0s[target], before_x)
        if idx > 0:
            return positions[0][1] if use_x1 else positions[0][0]
        return -1

    def _first_after(after_char: str, target: str, use_x1: bool = False) -> float:
        """找在 after_char 之后首次出现的 target（二分搜索）"""
        # Char 级: 从 after_char 的 x0 之后开始搜索
        # Token 级: 从 after_char 的 x1 之后开始搜索（Token 有宽度）
        if strict_before:
            after_x = _first(after_char, use_x1=False)
        else:
            after_x = _last(after_char, use_x1=True)
        if after_x < 0:
            return -1
        positions = char_positions.get(target)
        if not positions:
            return -1
        idx = bisect_right(char_x0s[target], after_x)
        if idx < len(positions):
            return positions[idx][1] if use_x1 else positions[idx][0]
        return -1

    def _gap_mid(left_char: str, right_char: str,
                 left_use_x1: bool = True, right_use_x1: bool = False,
                 left_before: str = '', right_after: str = '') -> float:
        """计算左右两个关键字字符之间的间距中点"""
        if left_before:
            lx = _first_before(left_before, left_char, use_x1=left_use_x1)
        else:
            lx = _last(left_char, use_x1=left_use_x1)
        if right_after:
            rx = _first_after(right_after, right_char, use_x1=right_use_x1)
        else:
            rx = _first(right_char, use_x1=right_use_x1)
        if lx > 0 and rx > 0:
            return (lx + rx) / 2.0
        return -1

    return _first, _last, _first_before, _first_after, _gap_mid


def _header_guided_raw_boundaries(_first, _last, _first_before, _first_after):
    """计算标准 8 列表头的 7 个原始边界值（间距中点法）"""
    return [
        # 边界1: 以"规"（规格型号开头）的左边缘为锚点
        ('name-spec', _first('规', use_x1=False) if _first('规') > 0 else -1),
        # 边界2: 以"单"（单位开头，位之前）的左边缘为锚点
        ('spec-unit', _first_before('位', '单', use_x1=False)
         if _first_before('位', '单') > 0 else -1),
        # 边界3: 以"位"（单位末尾）的右边缘为锚点
        ('unit-qty', _first('位', use_x1=True) if _first('位') > 0 else -1),
        # 边界4: 以"量"（数量末尾）的右边缘为锚点
        ('qty-price', _last('量', use_x1=True) if _first('量') > 0 else -1),
        # 边界5: 以"价"（单价末尾）的右边缘为锚点
        ('price-amount', _last('价', use_x1=True) if _first('价') > 0 else -1),
        # 边界6: 以"额"（金额末尾，价之后）的右边缘为锚点
        ('amount-tax', _first_after('价', '额', use_x1=True)
         if _first_after('价', '额') > 0 else -1),
        # 边界7: 以最后一个"率"（征收率末尾）的右边缘为锚点
        ('tax-taxamt', _last('率', use_x1=True) if _first('率') > 0 else -1),
    ]


def _build_header_guided_boundaries(
    chars: List[Char],
    rows_chars: List[List[Char]],
    header_indices: List[int],
    temp_lines: List[Line],
) -> List[float]:
    """基于表头行关键字坐标生成固定 8 列边界。

    在表头行中找到 "规"、"单"、"位"、"量"、"价"、"额"、"率" 的 x 坐标，
    按发票标准列布局生成 7 个列边界。

    每个边界可附加微小偏移量（像素），默认为 0.0，后续可按需调整。

    Args:
        chars: 全部字符
        rows_chars: 行聚类后的字符列表
        header_indices: 表头行在 temp_lines 中的索引
        temp_lines: 临时单列 line 列表

    Returns:
        7 个列边界（→ 8 列）
    """
    # 回退：如果无法定位表头，用全量字符的 x 范围估算
    if not header_indices:
        x_min = min(c.x0 for c in chars) if chars else 0
        x_max = max(c.x1 for c in chars) if chars else 800
        w = (x_max - x_min) / 8.0
        fallback = [x_min + w * (i + 1) for i in range(7)]
        logger.info("[CharBoundaries] 无表头, 回退等分: %s",
                    [f'{b:.1f}' for b in fallback])
        return fallback

    header_row_idx = max(header_indices)
    if header_row_idx >= len(temp_lines):
        return _fallback_even_boundaries(chars)

    # 获取表头行 y 范围
    hdr_y0 = temp_lines[header_row_idx].y0
    hdr_y1 = temp_lines[header_row_idx].y1

    # 找出表头行所有字符，按 x0 排序
    hdr_chars = sorted(
        [c for c in chars if hdr_y0 <= (c.y0 + c.y1) / 2.0 <= hdr_y1],
        key=lambda c: c.x0,
    )
    if not hdr_chars:
        return _fallback_even_boundaries(chars)

    # 获取字符中位宽度（供回退估算用）
    char_widths = [c.x1 - c.x0 for c in hdr_chars if c.x1 > c.x0]
    avg_w = float(np.median(char_widths)) if char_widths else 8.0

    hdr_text = ''.join(c.char for c in hdr_chars)
    logger.debug("[CharBoundaries] 表头文本: '%s'", hdr_text[:80])
    coord_str = ', '.join(f"('{c.char}', {c.x0:.0f}, {c.x1:.0f})" for c in hdr_chars)
    logger.debug("[CharBoundaries] 表头字符坐标: %s", coord_str)

    # ── 关键字查找（公共工厂，Char 级用字符精确匹配） ──
    _first, _last, _first_before, _first_after, _gap_mid = \
        _make_header_search_helpers(hdr_chars, lambda c: c.char, strict_before=True)

    # ── 间距中点法计算 7 个列边界 ──
    raw = _header_guided_raw_boundaries(_first, _last, _first_before, _first_after)

    boundaries = []
    for i, (label, val) in enumerate(raw):
        if val > 0:
            boundaries.append(val)
            logger.debug("[CharBoundaries] 边界%d '%s': 间距中点=%.1f",
                         i + 1, label, val)
        else:
            logger.warning("[CharBoundaries] 边界%d '%s' 未找到, val=%.1f",
                           i + 1, label, val)

    if len(boundaries) < 7:
        logger.info("[CharBoundaries] 关键字不完整(%d/7), 回退到等分边界", len(boundaries))
        return _fallback_even_boundaries(chars)

    logger.info("[CharBoundaries] 8 列边界: %s",
                [f'{b:.1f}' for b in boundaries])
    # 应用微调偏移量
    boundaries = [b + COL_BOUNDARY_ADJUSTMENTS[i] for i, b in enumerate(boundaries)]
    logger.debug("[CharBoundaries] 微调后: %s", [f'{b:.1f}' for b in boundaries])
    return boundaries


def _fallback_even_boundaries(chars: List[Char]) -> List[float]:
    """回退：将文档 x 范围 8 等分"""
    x_min = min(c.x0 for c in chars) if chars else 0
    x_max = max(c.x1 for c in chars) if chars else 800
    w = (x_max - x_min) / 8.0
    return [x_min + w * (i + 1) for i in range(7)]


def _cluster_token_columns(tokens) -> List[float]:
    """直接基于 Token 坐标做列聚类，跳过字符级拆分。

    用于 segment_from_chars Token 通路替换等宽拆字 + 字符聚类回退。
    与 cluster_chars_into_columns 的区别：
    - 使用 Token 中心点（cx），而非等宽拆字后的 Char 中心点
    - x_tol 基于 token 宽度统计（median_w × 0.5），避免列过度合并

    Returns:
        List[float]: 列边界列表
    """
    if not tokens:
        return []

    widths = [max(t.x1 - t.x0, 1.0) for t in tokens]
    median_w = float(np.median(widths))
    # Token 级列间距通常 60-120px；同一列内 token cx 差异约 0.3×宽度
    # median_w × 0.5 ≈ 30-80px，能安全分离大部分列
    x_tol = max(median_w * 0.5, 15.0)
    logger.debug("[TokenColumnCluster] x_tol=%.1f (token宽度中位数=%.1f)",
                  x_tol, median_w)

    def _get_x(t):
        return t.cx

    clusters = _cluster_1d_with_items(tokens, _get_x, x_tol)

    cluster_centers_x = []
    for cluster in clusters:
        xs = [_get_x(t) for t in cluster]
        cluster_centers_x.append(sum(xs) / len(xs))
    cluster_centers_x.sort()

    boundaries = []
    for i in range(len(cluster_centers_x) - 1):
        boundaries.append((cluster_centers_x[i] + cluster_centers_x[i + 1]) / 2.0)

    logger.info("[TokenColumnCluster] %d 列, 边界=%s [token-direct]",
                len(boundaries) + 1,
                [f'{b:.0f}' for b in boundaries])
    return boundaries


def _tokens_to_chars(tokens) -> List[Char]:
    """将 Token 列表拆分为单个字符的 Char 对象列表（等宽插值）

    Token 的宽度被均匀分配给其包含的每个字符，这样 cluster_chars_into_columns
    就能基于字符级别的宽度计算合理的 x_tol（~20px），避免 token 级宽度中位数
    （通常 80-200px）导致 x_tol 过大、列过度合并的问题。

    Args:
        tokens: Token 列表（须有 text/x0/x1/y0/y1 属性）

    Returns:
        拆分后的 Char 对象列表
    """
    chars: List[Char] = []
    for t in tokens:
        text = getattr(t, 'text', '')
        if not text:
            continue
        n = len(text)
        tw = max(t.x1 - t.x0, 1.0)
        ch_w = tw / n
        for i, c in enumerate(text):
            chars.append(Char(
                char=c,
                x0=t.x0 + ch_w * i,
                y0=t.y0,
                x1=t.x0 + ch_w * (i + 1),
                y1=t.y1,
                page=getattr(t, 'page', 0),
            ))
    return chars


def segment_from_chars(items) -> Optional[dict]:
    """从字符/Token 坐标出发的完整分割通路

    支持两种输入：
      - Char 列表（char/x0/y0/x1/y1）：字符级拆分后分配
      - Token 列表（text/cx/cy/x0/y0/x1/y1）：整体分配，数字不被拆开

    对 Char 输入执行完整 7 步管线；对 Token 输入直接用 Token 坐标构建网格。
    """
    if not items:
        logger.warning("[LineSegmenter] segment_from_chars: 输入为空")
        return None

    is_token = hasattr(items[0], 'text')

    if is_token:
        # ── Token 级快速通路：整体分配，不拆分数字 ──
        rows = cluster_chars_into_rows(items)
        if not rows:
            return None
        # 构建临时行用于 header 检测
        temp_lines = []
        for row in rows:
            row_sorted = sorted(row, key=lambda t: t.x0)
            text = ''.join(t.text for t in row_sorted)
            if not text.strip():
                continue
            temp_lines.append(Line(text=text,
                                   y0=min(t.y0 for t in row),
                                   y1=max(t.y1 for t in row),
                                   x0=min(t.x0 for t in row),
                                   x1=max(t.x1 for t in row),
                                   page=row[0].page))
        temp_result = segment_line_items(temp_lines)
        if temp_result is None or not temp_result.get('item_lines'):
            # 回退到无列边界
            lines, grid = build_grid_and_lines(rows, [])
            if not lines:
                return None
            result = segment_line_items(lines, col_boundaries=[])
            if result is not None:
                # 截断grid：终止行之后不参与后续处理
                end_idx = result.get('end', -1)
                if end_idx >= 0 and end_idx < len(grid) - 1:
                    grid = grid[:end_idx + 1]
                    logger.info("[LineSegmenter/Token] grid截断(回退): %d→%d行 (end=%d)",
                                len(lines), len(grid), end_idx)
                result['grid'] = grid
            return result

        header_indices = temp_result.get('header_lines', [])

        header_start_y = temp_lines[header_indices[0]].y0 if header_indices else temp_lines[0].y0

        # 与文本 bbox 路径一致的间距中点法（build_header_boundaries_from_tokens）
        col_boundaries = build_header_boundaries_from_tokens(items)

        # 如果表头引导边界失败（数电票等无表头关键字的场景），
        # 回退到直接基于 Token 坐标的列聚类（跳过字符级拆分）
        if not col_boundaries or len(col_boundaries) < 7:
            logger.info("[LineSegmenter/Token] 表头引导边界失败(%s/7)，"
                        "回退到 Token 级列聚类",
                        len(col_boundaries) if col_boundaries else 0)
            fallback_bounds = _cluster_token_columns(items)
            if fallback_bounds and len(fallback_bounds) >= 3:
                col_boundaries = fallback_bounds
                logger.info("[LineSegmenter/Token] Token 列聚类回退成功: %d 列, 边界=%s",
                            len(col_boundaries) + 1,
                            [f'{b:.0f}' for b in col_boundaries])
            else:
                logger.info("[LineSegmenter/Token] Token 列聚类无足够列(%s)，保持空边界",
                            len(fallback_bounds) if fallback_bounds else 0)

        lines, grid = build_grid_and_lines(rows, col_boundaries)
        if not lines:
            return None

        # ⚠️ 不复用 Char 路径的 item_lines：预处理（编码行拆分）改变了行数，
        # Token 网格不做预处理，直接扫描所有 grid 行获取有 *分类编码* 的行。
        item_indices = []
        for i, row in enumerate(grid):
            if not row:
                continue
            for cell in row:
                if CLASS_CODE_PAT.search(cell):
                    item_indices.append(i)
                    break

        item_end_y = temp_lines[item_indices[-1]].y1 if item_indices else temp_lines[-1].y1

        # item_lines 已从 Token 网格重新计算（因预处理行分裂，Char 路径的索引不适用）。
        # 仅需用更精确的表头引导边界重新推断 amount_col。
        h_start = temp_result['start']
        last_item = item_indices[-1] if item_indices else 0
        amount_col = _infer_amount_col_by_density(
            lines[h_start:last_item + 1], col_boundaries
        )
        temp_result['amount_col'] = amount_col
        # 截断grid：优先使用 segment_line_items 的 end 值（双¥/合计行检测），
        # 回退到 item_indices（含星号分类编码的最后一行）。
        # 部分明细行可能无星号编码（如仅有金额数字），直接用 item_indices
        # 会误截断，改用 segment 的 end 值更准确。
        end_idx = temp_result.get('end', max(item_indices) if item_indices else len(grid) - 1)
        if end_idx >= 0 and end_idx < len(grid) - 1:
            grid = grid[:end_idx + 1]
            logger.info("[LineSegmenter/Token] grid截断: %d→%d行 (end=%d)",
                        len(lines), len(grid), end_idx)
        temp_result['grid'] = grid
        return temp_result

    # ── 以下为 Char 级原有逻辑 ──
    chars = items
    rows_chars = cluster_chars_into_rows(chars)
    if not rows_chars:
        logger.warning("[LineSegmenter/Char] segment_from_chars: 行聚类无结果")
        return None

    temp_lines = []
    for row_chars in rows_chars:
        # 按 x0 排序，保证行内从左到右的阅读顺序
        row_chars_sorted = sorted(row_chars, key=lambda c: c.x0)
        text = "".join(c.char for c in row_chars_sorted)
        if not text.strip():
            continue
        y0 = min(c.y0 for c in row_chars)
        y1 = max(c.y1 for c in row_chars)
        x0 = min(c.x0 for c in row_chars)
        x1 = max(c.x1 for c in row_chars)
        temp_lines.append(Line(text=text, y0=y0, y1=y1, x0=x0, x1=x1, page=row_chars[0].page))

    temp_result = segment_line_items(temp_lines)
    if temp_result is None or not temp_result.get('item_lines'):
        logger.info("[LineSegmenter/Char] 临时分割无结果，回退到全量列聚类")
        # 诊断：打印 temp_lines 中 5-15 行的内容
        for ti, tl in enumerate(temp_lines):
            if 5 <= ti <= 15:
                logger.info("[LineSegmenter/Char] 诊断: temp_lines[%d]='%s' y0=%.0f y1=%.0f",
                            ti, tl.text[:60], tl.y0, tl.y1)
        col_boundaries = cluster_chars_into_columns(chars)
        lines, grid = build_grid_and_lines(rows_chars, col_boundaries)
        if not lines:
            return None
        result = segment_line_items(lines, col_boundaries=col_boundaries)
        if result is not None:
            # 截断grid：终止行之后不参与后续处理
            end_idx = result.get('end', -1)
            if end_idx >= 0 and end_idx < len(grid) - 1:
                grid = grid[:end_idx + 1]
                logger.info("[LineSegmenter/Char] grid截断(回退): %d→%d行 (end=%d)",
                            len(lines), len(grid), end_idx)
            result['grid'] = grid
        return result

    header_indices = temp_result.get('header_lines', [])
    item_indices = temp_result.get('item_lines', [])
    header_start_y = temp_lines[header_indices[0]].y0 if header_indices else temp_lines[0].y0
    item_end_y = temp_lines[item_indices[-1]].y1 if item_indices else temp_lines[-1].y1

    logger.info("[LineSegmenter/Char] 表格区域 y=[%.1f, %.1f] (header行%d→item行%d)",
                header_start_y, item_end_y,
                header_indices[0] if header_indices else -1,
                item_indices[-1] if item_indices else -1)

    # 5. 用表头字符坐标生成固定 8 列边界
    col_boundaries = _build_header_guided_boundaries(chars, rows_chars, header_indices, temp_lines)
    logger.info("[LineSegmenter/Char] 列边界(header-guided): %s, 共 %d 列",
                [f'{b:.0f}' for b in col_boundaries], len(col_boundaries) + 1)

    # 6. 用列边界重建真实网格
    lines, grid = build_grid_and_lines(rows_chars, col_boundaries)
    if not lines:
        return None

    # 7. 避免第二次完整 segment_line_items：
    # 仅当 build_grid_and_lines 未拆分混合行（行数一致）时复用 temp_result，
    # 并用更精确的表头引导边界重新推断 amount_col。
    if len(lines) == len(temp_lines):
        h_start = temp_result['start']
        last_item = item_indices[-1] if item_indices else 0
        amount_col = _infer_amount_col_by_density(
            lines[h_start:last_item + 1], col_boundaries
        )
        temp_result['amount_col'] = amount_col
        # 截断grid：终止行之后不参与后续处理
        end_idx = temp_result.get('end', -1)
        if end_idx >= 0 and end_idx < len(grid) - 1:
            grid = grid[:end_idx + 1]
            logger.info("[LineSegmenter/Char] grid截断: %d→%d行 (end=%d)",
                        len(lines), len(grid), end_idx)
        temp_result['grid'] = grid
        grid_shape = (len(grid), len(grid[0])) if grid else (0, 0)
        logger.info("[LineSegmenter/Char] segment_from_chars: 复用首次结果, "
                    "items=%d行, grid=%dx%d, header_lines=%s",
                    len(temp_result['item_lines']), grid_shape[0], grid_shape[1],
                    temp_result.get('header_lines', []))
        return temp_result

    # 行数变化（混合行被拆分），需重新分割
    result = segment_line_items(lines, col_boundaries=col_boundaries)
    if result is not None:
        result['grid'] = grid
        grid_shape = (len(grid), len(grid[0])) if grid else (0, 0)
        logger.info("[LineSegmenter/Char] segment_from_chars: 重新分割, "
                    "items=%d行, grid=%dx%d, header_lines=%s",
                    len(result['item_lines']), grid_shape[0], grid_shape[1],
                    result.get('header_lines', []))
    else:
        # 如果列边界导致分割失败，回退到临时结果
        logger.info("[LineSegmenter/Char] 列边界分割失败，回退到单列结果")
        temp_result['grid'] = [[''.join(c.char for c in r)] for r in rows_chars]
        result = temp_result

    return result


# ═══════════════════════════════════════════════════════════
#  表头引导列边界（Token 版 — 供文本 PDF 通道使用）
# ═══════════════════════════════════════════════════════════


def build_header_boundaries_from_tokens(tokens) -> List[float]:
    """从 Token 列表中根据表头关键字位置计算列边界（间距中点法）

    适用于 bbox 路径：从 doc.tokens 直接计算，不依赖 Char 拆分。
    与 _build_header_guided_boundaries 共享相同的 gap-midpoint 逻辑。

    Args:
        tokens: Token 列表（须有 text/x0/x1/y0/y1/cy）

    Returns:
        7 个列边界（→ 8 列），或空列表（无法定位表头时）
    """
    if not tokens:
        return []

    rows = cluster_chars_into_rows(tokens)
    if not rows:
        return []

    # 用文本匹配评分选出最可能的表头行
    best_row_idx = -1
    best_score = 0
    for i, row in enumerate(rows):
        text = ''.join(t.text for t in row)
        score = sum(1 for pat in HEADER_PATTERNS if pat.search(text))
        if score > best_score:
            best_score = score
            best_row_idx = i

    if best_score < 3:
        return []

    # 计算 avg_w（用于回退估算）
    char_widths = [t.x1 - t.x0 for t in tokens if t.x1 > t.x0]
    avg_w = float(np.median(char_widths)) if char_widths else 8.0

    # 提取表头行 tokens
    best_row = rows[best_row_idx]
    hdr_y0 = min(t.y0 for t in best_row)
    hdr_y1 = max(t.y1 for t in best_row)
    hdr_tokens = sorted(
        [t for t in tokens if hdr_y0 <= t.cy <= hdr_y1],
        key=lambda t: t.x0,
    )
    if len(hdr_tokens) < 3:
        return []

    # ── 关键字查找（公共工厂，Token 级用子串匹配 + 非严格 before） ──
    _first, _last, _first_before, _first_after, _gap_mid = \
        _make_header_search_helpers(hdr_tokens, lambda t: t.text, strict_before=False)

    raw = _header_guided_raw_boundaries(_first, _last, _first_before, _first_after)

    boundaries = []
    for label, val in raw:
        if val > 0:
            boundaries.append(val)

    if len(boundaries) >= 7:
        logger.info("[TokenBoundaries] 表头引导边界成功: %s",
                    [f'{b:.1f}' for b in boundaries])
        boundaries = [b + COL_BOUNDARY_ADJUSTMENTS[i] for i, b in enumerate(boundaries)]
        logger.debug("[TokenBoundaries] 微调后: %s", [f'{b:.1f}' for b in boundaries])
        return boundaries

    # 回退：等分
    x_min = min(t.x0 for t in tokens)
    x_max = max(t.x1 for t in tokens)
    w = (x_max - x_min) / 8.0
    fallback = [x_min + w * (i + 1) for i in range(7)]
    logger.info("[TokenBoundaries] 表头引导失败(%d/7)，回退等分边界", len(boundaries))
    return fallback


# ═══════════════════════════════════════════════════════════
#  10. 网格 → Excel 行数据映射
# ═══════════════════════════════════════════════════════════

# 列标题清洗正则（去除表头中的空白）
_HEADER_CLEAN_RES = [
    (re.compile(r'单\s*位'), '单位'),
    (re.compile(r'金\s*额'), '金额'),
    (re.compile(r'税\s*率'), '税率'),
    (re.compile(r'税\s*额'), '税额'),
    (re.compile(r'数\s*量'), '数量'),
    (re.compile(r'单\s*价'), '单价'),
    (re.compile(r'规\s*格\s*型\s*号'), '规格型号'),
    (re.compile(r'征\s*收\s*率'), '征收率'),
]

# 表头列名统一映射（不同写法 → 标准键名）
HEADER_NAME_MAPPING: Dict[str, str] = {
    '项目名称': '项目名称',
    '货物或应税劳务、服务名称': '项目名称',
    '货物或应税劳务名称': '项目名称',
    '服务名称': '项目名称',
    '货物名称': '项目名称',
    '品名': '项目名称',
    '商品名称': '项目名称',
    '规格型号': '规格型号',
    '规格': '规格型号',
    '单位': '单位',
    '数量': '数量',
    '单价': '单价',
    '金额': '金额',
    '税率': '税率/征收率',
    '征收率': '税率/征收率',
    '税额': '税额',
}

# 需要跳过的汇总行关键词（出现在第一列）
_SKIP_ROW_KW = ['合计', '价税合计', '小计']


def _clean_header_cell(cell: str) -> str:
    """清洗单个表头单元格文本"""
    cell = cell.strip()
    for pattern, replacement in _HEADER_CLEAN_RES:
        cell = pattern.sub(replacement, cell)
    return cell


def _build_unique_headers(raw_headers: List[str]) -> List[str]:
    """清洗并去重列标题"""
    seen: Dict[str, int] = {}
    result: List[str] = []
    for cell in raw_headers:
        h = _clean_header_cell(cell)
        # 统一映射
        h = HEADER_NAME_MAPPING.get(h, h)
        if not h.strip():
            h = f'列{len(result)}'
        # 去重
        if h in seen:
            seen[h] += 1
            h = f'{h}_{seen[h]}'
        else:
            seen[h] = 0
        result.append(h)
    return result


def _collect_and_merge_rows(
    grid: List[List[str]],
    header_lines: List[int],
    item_lines: Optional[List[int]] = None,
    log_tag: str = "GridToExcel",
) -> Tuple[List[str], List[List[str]], List[List[str]], int]:
    """公共逻辑：构建表头、收集原始行、按分类编码合并碎片行。

    Returns:
        (headers, raw_cells, merged_cells, n_cols)
    """
    if not grid or not header_lines:
        return [], [], [], 0

    header_row_idx = max(header_lines)
    if header_row_idx >= len(grid):
        return [], [], [], 0

    headers = _build_unique_headers(grid[header_row_idx])
    n_cols = len(headers)

    if item_lines:
        target_rows = sorted(item_lines)
        logger.debug("[%s] 使用 item_lines: %s, 共 %d 行", log_tag, target_rows, len(target_rows))
    else:
        target_rows = list(range(header_row_idx + 1, len(grid)))
        logger.debug("[%s] 未指定 item_lines, 从表头后取: %d ~ %d, 共 %d 行",
                     log_tag, header_row_idx + 1, len(grid) - 1, len(target_rows))

    # ── Phase 1: 收集目标行的原始单元格数据 ──
    raw_cells: List[List[str]] = []
    for i in target_rows:
        row_cells = grid[i] if i < len(grid) else []
        if not row_cells or all(not cell.strip() for cell in row_cells):
            continue
        if row_cells and any(kw in row_cells[0] for kw in _SKIP_ROW_KW):
            continue
        raw_cells.append(row_cells)

    # ── Phase 2: 按分类编码合并碎片行 ──
    def _has_class_code(cells: List[str]) -> Tuple[bool, int]:
        """检查任意列是否包含分类编码 *...*，返回(是否匹配, 列索引)"""
        for j, c in enumerate(cells):
            if ITEM_START_RE.match(c.strip()):
                return True, j
        return False, -1

    def _is_code_only_row(cells: List[str], code_col: int) -> bool:
        """判断是否为"仅编码列有内容"的伪新明细行"""
        if code_col < 0:
            return False
        return not any(cells[j].strip() for j in range(len(cells)) if j != code_col)

    merged_cells: List[List[str]] = []
    current: List[str] = []

    for cells in raw_cells:
        # 合计行检测：同时含有 '合'+'计' 和 ≥2 个 ¥ 符号
        text_all = ' '.join(cells)
        has_he = '合' in text_all
        has_ji = '计' in text_all
        yen_count = text_all.count('¥') + text_all.count('￥')
        if has_he and has_ji and yen_count >= 2:
            logger.debug("[%s] 跳过合计行: ¥符号=%d", log_tag, yen_count)
            continue

        is_new_item, code_col = _has_class_code(cells)

        # 空值续行：仅编码列有内容 → 追加到上一行，不开新明细
        if is_new_item and current and _is_code_only_row(cells, code_col) \
           and any(current[j].strip() for j in range(len(current))):
            extra = cells[code_col].strip() if code_col >= 0 else ''
            if extra:
                if current[0].strip():
                    current[0] += ' ' + extra
                else:
                    current[0] = extra
            while len(current) < n_cols:
                current.append('')
            continue

        if is_new_item or not current:
            if current:
                merged_cells.append(current)
            current = cells[:]
            while len(current) < n_cols:
                current.append('')
        else:
            # 续行：拼接到 current 各列末尾
            for j in range(n_cols):
                val_j = cells[j].strip() if j < len(cells) else ''
                if val_j:
                    if j < len(current):
                        if current[j].strip():
                            current[j] += ' ' + val_j
                        else:
                            current[j] = val_j
                    else:
                        while len(current) <= j:
                            current.append('')
                        current[j] = val_j
            while len(current) < n_cols:
                current.append('')

    if current:
        merged_cells.append(current)

    if raw_cells:
        logger.info("[%s] 合并前 %d 行, 合并后 %d 行",
                    log_tag, len(raw_cells), len(merged_cells))

    # 诊断：打印前 3 条合并后的单元格
    if merged_cells:
        for mi, mc in enumerate(merged_cells[:3]):
            logger.info("[%s] 诊断: merged_cell[%d]=%s",
                        log_tag, mi, [c[:20] for c in mc])

    return headers, raw_cells, merged_cells, n_cols


def grid_to_excel_rows(
    grid: List[List[str]],
    header_lines: List[int],
    item_lines: Optional[List[int]] = None,
) -> List[Dict[str, str]]:
    """将二维网格和表头行索引转化为可以写入 Excel 的字典列表。

    每行一个字典，键为表头列标题（经清洗和统一映射），值为该行对应列的文本。

    Args:
        grid: 字符串网格，grid[row][col]
        header_lines: 表头行在 grid 中的索引列表（多行时取最后一行）
        item_lines: 可选，数据行在 Line 列表中的索引（用于限制数据行范围）

    Returns:
        List[Dict[str, str]]: 每行一个字典
    """
    logger.debug("[GridToExcel] 入口: grid=%s, header_lines=%s, item_lines=%s",
                 f"{len(grid)}行" if grid else "None/空",
                 header_lines,
                 f"{len(item_lines)}条" if item_lines else "None")

    if not grid:
        logger.warning("[GridToExcel] 提前返回: grid 为空")
        return []
    if not header_lines:
        logger.warning("[GridToExcel] 提前返回: header_lines 为空")
        return []

    logger.debug("[GridToExcel] grid 尺寸: %d x %d",
                 len(grid), len(grid[0]) if grid else 0)

    header_row_idx = max(header_lines)
    if header_row_idx >= len(grid):
        logger.warning("[GridToExcel] 表头行索引 %d 超出网格行数 %d", header_row_idx, len(grid))
        return []

    logger.debug("[GridToExcel] 表头行索引: header_lines=%s, 取最后一行 row=%d",
                 header_lines, header_row_idx)
    logger.debug("[GridToExcel] 表头行原始内容: %s", grid[header_row_idx])

    # 公共逻辑：收集原始行 + 按分类编码合并碎片行
    headers, raw_cells, merged_cells, n_cols = _collect_and_merge_rows(
        grid, header_lines, item_lines, log_tag="GridToExcel")
    if not headers:
        logger.warning("[GridToExcel] 提前返回: 表头构建失败")
        return []
    logger.info("[GridToExcel] 列标题(清洗后): %s", headers)

    # ── Phase 3: 合并后的行 → 字典 ──
    rows: List[Dict[str, str]] = []
    for cells in merged_cells:
        row_dict: Dict[str, str] = {}
        for j, h in enumerate(headers):
            row_dict[h] = cells[j].strip() if j < len(cells) else ''
        # 对 项目名称 字段移除所有空白字符（含换行/空格/制表符）
        if '项目名称' in row_dict:
            row_dict['项目名称'] = re.sub(r'\s+', '', row_dict['项目名称'])
        rows.append(row_dict)
        logger.debug("[GridToExcel] 接受(合并后, 首字段='%s')",
                     list(row_dict.values())[0][:30] if row_dict else '')
    # 诊断：打印第一条和第二条对比
    if logger.isEnabledFor(logging.DEBUG):
        if rows:
            logger.debug("[GridToExcel] 诊断: rows[0]=%s", {k: v[:20] for k, v in rows[0].items()})
        if len(rows) >= 2:
            logger.debug("[GridToExcel] 诊断: rows[1]=%s", {k: v[:20] for k, v in rows[1].items()})

    # ── Phase 4: 移除全空列 ──
    all_empty_cols: set = set()
    if rows:
        for h_idx, h in enumerate(headers):
            if all(not row.get(h, '').strip() for row in rows):
                all_empty_cols.add(h)
        if all_empty_cols:
            logger.info("[GridToExcel] 移除 %d 个全空列: %s",
                        len(all_empty_cols), sorted(all_empty_cols))
            for row in rows:
                for h in all_empty_cols:
                    row.pop(h, None)

    # ── 最终摘要日志 ──
    final_n_cols = len(headers) - len(all_empty_cols) if rows else len(headers)
    logger.info("[GridToExcel] 转换完成: %d 行数据, %d 列 (合并前%d行→合并后%d行, 移除%d空列)",
                len(rows), final_n_cols, len(raw_cells), len(merged_cells), len(all_empty_cols))
    if rows:
        # 打印全部行（不截断）
        for ri, row in enumerate(rows):
            logger.info("[GridToExcel] 行%d: %s", ri, {
                k: v for k, v in row.items()
            })
    else:
        logger.warning("[GridToExcel] 无有效数据行! 原始行数=%d, 合并后=0. "
                       "降级: 输出原始网格行文本.",
                       len(raw_cells))
        # 降级：输出原始网格行文本
        for row_cells in raw_cells:
            text = ' | '.join(c.strip() for c in row_cells if c.strip())
            if text:
                rows.append({'原始行': text})
        if rows:
            logger.info("[GridToExcel] 降级成功: 恢复 %d 行原始文本", len(rows))
    return rows


def grid_to_excel_lists(
    grid: List[List[str]],
    header_lines: List[int],
    item_lines: Optional[List[int]] = None,
) -> Tuple[List[str], List[List[str]]]:
    """将二维网格转化为 Excel 行列表格式。

    便于直接写入 openpyxl。

    Returns:
        (headers, rows): 表头列表和行数据列表
    """
    if not grid or not header_lines:
        return [], []

    header_row_idx = max(header_lines)
    if header_row_idx >= len(grid):
        return [], []

    # 公共逻辑：收集原始行 + 按分类编码合并碎片行
    headers, raw_cells, merged_cells, n_cols = _collect_and_merge_rows(
        grid, header_lines, item_lines, log_tag="GridToExcel/List")
    if not headers:
        return [], []

    rows = merged_cells

    # 移除全空列
    empty_col_indices = sorted([
        j for j in range(len(headers))
        if all(not row[j].strip() for row in rows)
    ], reverse=True)
    if empty_col_indices:
        logger.info("[GridToExcel/List] 移除 %d 个全空列: 索引=%s",
                    len(empty_col_indices), empty_col_indices)
        for j in empty_col_indices:
            headers.pop(j)
            for row in rows:
                row.pop(j)

    logger.info("[GridToExcel] 列表转换完成: %d 行, %d 列", len(rows), len(headers))
    return headers, rows
