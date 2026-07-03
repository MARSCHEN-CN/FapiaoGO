"""
金额提取器（优化版：小写锚点 + 双¥对齐 + 合计锚点）

核心原则：
- 金额字段是强语义字段，不能只靠数值大小推断
- 禁止只因某个金额最大就判定为价税合计
- 禁止只因某个金额最小就判定为税额

布局假设：
- "价税合计（大写）"、"（小写）"、"￥hj" 三者同一水平线
- 双¥水平对齐：左=je，右=se
"""
import re
import logging
from typing import Optional, List, Tuple
from dataclasses import dataclass
from ..models import OCRDocument, AmountCandidate, Token
from ..regex_patterns import (
    _SMALL_WRITE_RE, _TAX_TOTAL_LINE_RE, _YUAN_RE, _AMOUNT_NUM_RE,
    _PRICE_TAX_TOTAL_RE, _TOTAL_LINE_RE,
    _AMOUNT_SE_LINE_RE, _AMOUNT_JE_RE, _TAX_SE_RE,
    _AMOUNT_JE_TOTAL_RE, _TAX_SE_TOTAL_RE,
)

logger = logging.getLogger(__name__)

# ¥ 前缀金额提取
_YEN_PREFIX_RE = re.compile(r'[¥￥]\s*([\d,]+\.\d{2})')

# 表头列检测
_HEADER_AMOUNT_COL = re.compile(r'金\s*额')
_HEADER_TAX_COL = re.compile(r'税\s*额')
_HEADER_TAX_RATE_COL = re.compile(r'税\s*率')
_HEADER_TOTAL_COL = re.compile(r'价税合计|小计')

# 金额/数字判定
_AMOUNT_TOKEN_RE = re.compile(r'^-?[\d,]+(?:\.\d{1,4})?$')

# 合计行关键词
_SUMMARY_KEYWORDS_RE = re.compile(r'合\s*计|价税合计|小计')

# 大写合计行匹配（含全角/半角括号）
_DAXIE_TOTAL_RE = re.compile(r'价税合计[\s]*[（(]\s*大写\s*[）)]|价税合计大写')
# 小写锚点正则：匹配 "(小写)" 或 "（小写）"
_XIAOXIE_ANCHOR_RE = re.compile(r'[（(]\s*小写\s*[）)]')

# ¥ 金额 token 正则（含负号、千分位）
_YEN_AMOUNT_RE = re.compile(r'[¥￥]?\s*(-?[\d,]+\.\d{2})')

# _scan_lines_once 内部用：关键词行搜索
_JE_KW_RE = re.compile(r'金\s*额', re.IGNORECASE)
_SE_KW_RE = re.compile(r'税\s*额', re.IGNORECASE)
_AMT_OPT_RE = re.compile(r'[¥￥]?\s*([\d,]+\.\d{2})')

# 合计/计 关键词
_HEJI_RE = re.compile(r'合\s*计|合计|小计')
_JI_RE = re.compile(r'计|小计')


@dataclass
class AmountPair:
    """同一水平线上的金额对"""
    je: str           # 税前金额
    se: str           # 总税额
    je_token: Token   # je的token
    se_token: Token   # se的token
    y_center: float   # Y中心坐标
    x_gap: float      # 两者X间距
    je_value: float   # 数值
    se_value: float   # 数值


class AmountExtractor:
    """三阶段金额提取器：标签绑定 → 空间定位 → 算术校验"""

    def extract(self, doc: OCRDocument):
        """返回 (amount_hj, amount_je, amount_se)"""
        candidates = {'hj': [], 'je': [], 'se': []}

        # ===== 最高优先级：双¥水平对齐提取 je/se =====
        pair_result = self._extract_dual_yen_pair(doc)
        if pair_result:
            je, se, conf, source = pair_result
            candidates['je'].append(AmountCandidate(je, conf, source))
            candidates['se'].append(AmountCandidate(se, conf, source))
            logger.info("[Amount] 双¥对齐提取: je=%s se=%s conf=%d", je, se, conf)

            # 尝试推导hj
            try:
                derived_hj = f"{round(float(je) + float(se), 2):.2f}"
                candidates['hj'].append(AmountCandidate(derived_hj, 90, '双¥对齐推导hj'))
                logger.info("[Amount] 推导hj=%s", derived_hj)
            except (ValueError, TypeError):
                pass

            # 如果hj和je/se都有了，直接校验返回
            if candidates['hj'] and candidates['je'] and candidates['se']:
                hj = self._select_best(candidates['hj'])
                je = self._select_best(candidates['je'])
                se = self._select_best(candidates['se'])
                hj, je, se = self._stage3_arithmetic_validation(hj, je, se)
                return hj or '0.00', je or '', se or ''

        # ===== 阶段1: 标签绑定（兜底）=====
        candidates = self._stage1_label_binding(doc, candidates)

        # ===== 阶段2: 空间表格定位（兜底）=====
        if doc.bbox_tokens or (doc.tokens and doc.regions):
            candidates = self._stage2_spatial_lookup(doc, candidates)

        # 从候选中选择最佳值
        hj = self._select_best(candidates['hj'])
        je = self._select_best(candidates['je'])
        se = self._select_best(candidates['se'])

        # 免税推断：如果金额=价税合计且税额为空，设税额为0
        if je and not se and hj and je == hj:
            se = '0.00'
            logger.debug("[Amount] Tax-free invoice: tax=0.00")

        # 阶段3: 算术校验
        hj, je, se = self._stage3_arithmetic_validation(hj, je, se)

        return hj or '0.00', je or '', se or ''

    # ═══════════════════════════════════════════════════
    # 核心：小写锚点直接提取 hj
    # ═══════════════════════════════════════════════════

    def _extract_hj_by_xiaoxie_anchor(self, doc: OCRDocument) -> Optional[str]:
        """
        两阶段策略：

        阶段一（高优先级 — 顶部小写）：
        1. 找所有"（小写）"token，取 Y 最小的（最顶部）
        2. 从该 token 向右，同一水平线找第一个 ¥ 金额 → 直接返回
        3. 若找到则命中，否则进入阶段二

        阶段二（回退 — 大写对齐）：
        1. 找"价税合计（大写）"token
        2. 多个"（小写）"时，选与大写 Y 坐标最接近的（Y 偏差 ≤ 字高×50%）
        3. 从选中的"（小写）"向右，同一水平线取第一个 ¥ 金额
        """
        tokens = self._get_summary_tokens(doc)
        if not tokens:
            return None

        # 找所有"（小写）"token
        xiaoxie_tokens = []
        for t in tokens:
            text = getattr(t, 'text', '')
            if _XIAOXIE_ANCHOR_RE.search(text):
                xiaoxie_tokens.append(t)

        if not xiaoxie_tokens:
            logger.info("[XiaoxieAnchor] 未找到（小写）token")
            return None

        logger.info("[XiaoxieAnchor] 找到%d个（小写）token", len(xiaoxie_tokens))

        # ===== 阶段一：顶部小写 =====
        top_xiaoxie = min(xiaoxie_tokens, key=lambda t: t.cy)
        logger.info("[XiaoxieAnchor] 顶部（小写）: x1=%.1f cy=%.1f height=%.1f text='%s'",
                    top_xiaoxie.x1, top_xiaoxie.cy, top_xiaoxie.height, top_xiaoxie.text[:20])

        hj = self._find_yuan_right_of_token(tokens, doc, top_xiaoxie)
        if hj:
            logger.info("[XiaoxieAnchor] 阶段一命中: %s", hj)
            return hj

        logger.info("[XiaoxieAnchor] 阶段一未命中，进入阶段二（大写对齐）")

        # ===== 阶段二：大写对齐回退 =====
        daxie_token = None
        for t in tokens:
            text = getattr(t, 'text', '')
            if _DAXIE_TOTAL_RE.search(text):
                if daxie_token is None or t.cy > daxie_token.cy:
                    daxie_token = t

        if daxie_token is None:
            logger.debug("[XiaoxieAnchor] 未找到价税合计（大写）token")
            return None

        daxie_cy = daxie_token.cy
        daxie_height = daxie_token.height
        logger.info("[XiaoxieAnchor] 大写token: cy=%.1f height=%.1f text='%s'",
                    daxie_cy, daxie_height, daxie_token.text[:30])

        best_xiaoxie = None
        best_y_diff = float('inf')

        for xt in xiaoxie_tokens:
            y_diff = abs(xt.cy - daxie_cy)
            y_tolerance = max(daxie_height, xt.height) * 0.5

            if y_diff <= y_tolerance and y_diff < best_y_diff:
                best_y_diff = y_diff
                best_xiaoxie = xt
                logger.debug("[XiaoxieAnchor] 候选（小写）: cy=%.1f y_diff=%.1f",
                            xt.cy, y_diff)

        if best_xiaoxie is None:
            logger.info("[XiaoxieAnchor] 无（小写）与大写同一水平线")
            return None

        logger.info("[XiaoxieAnchor] 大写对齐选中（小写）: x1=%.1f cy=%.1f y_diff=%.1f",
                    best_xiaoxie.x1, best_xiaoxie.cy, best_y_diff)

        hj = self._find_yuan_right_of_token(tokens, doc, best_xiaoxie)
        if hj:
            logger.info("[XiaoxieAnchor] 阶段二命中: %s", hj)
            return hj

        logger.info("[XiaoxieAnchor] 未触发: （小写）右侧无¥金额")
        return None

    def _find_yuan_right_of_token(self, tokens: list, doc, anchor_token) -> Optional[str]:
        """从 anchor_token 向右，同一水平线找第一个 ¥ 金额

        优先检查 anchor_token 自身文本（常见如 "(小写)¥1258.65" 是同一个 token），
        再遍历右侧其他 token。
        如果 summary tokens 内找不到，回退到 doc.bbox_tokens 全量搜索。
        """
        tx_cy = anchor_token.cy
        tx_x1 = anchor_token.x1
        tx_height = anchor_token.height

        # 1. 优先检查 anchor_token 自身是否已包含 ¥ 金额
        anchor_text = getattr(anchor_token, 'text', '')
        m = _YUAN_RE.search(anchor_text)
        if m:
            clean_val = m.group(1).replace(',', '').replace(' ', '')
            if self._is_valid_amount(clean_val):
                logger.debug("[XiaoxieAnchor] anchor自身命中: %s", clean_val)
                return clean_val

        # 2. 在给定 tokens 中搜索（summary 区域）
        result = self._scan_tokens_for_yuan(tokens, tx_x1, tx_cy, tx_height)
        if result:
            return result

        # 3. 回退：用全部 bbox tokens 搜索（文本型 PDF 的 ¥ 可能不在 summary 区域内）
        if doc and doc.bbox_tokens:
            logger.debug("[XiaoxieAnchor] summary未命中，回退到全部bbox_tokens搜索")
            all_tokens = list(doc.bbox_tokens)
            result = self._scan_tokens_for_yuan(all_tokens, tx_x1, tx_cy, tx_height)
            if result:
                logger.info("[XiaoxieAnchor] bbox回退命中: %s", result)
                return result

        return None

    def _scan_tokens_for_yuan(self, tokens: list, tx_x1: float, tx_cy: float, tx_height: float) -> Optional[str]:
        """遍历 token 列表，找 anchor 同一水平线右侧最近的 ¥ 金额"""
        y_tolerance = tx_height * 0.3
        best_val = None
        best_dist = float('inf')

        for t in tokens:
            if t.x0 <= tx_x1:
                continue

            y_diff = abs(t.cy - tx_cy)
            if y_diff > y_tolerance:
                continue

            text = getattr(t, 'text', '')
            # 阶段一：¥ 可选匹配（文本型 PDF，¥ 和金额分开为独立 token）
            m = _YEN_AMOUNT_RE.search(text)
            if m:
                clean_val = m.group(1).replace(',', '').replace(' ', '')
            else:
                # 阶段二：¥ 必需匹配（OCR 型，¥123.45 在同一 token）
                m2 = _YUAN_RE.search(text)
                if not m2:
                    logger.debug("[XiaoxieAnchor] 排除(非¥): x0=%.1f cy=%.1f text='%s'",
                                t.x0, t.cy, text[:30])
                    continue
                clean_val = m2.group(1).replace(',', '').replace(' ', '')

            if not self._is_valid_amount(clean_val):
                logger.debug("[XiaoxieAnchor] 排除(无效金额): val='%s' text='%s'", clean_val, text[:30])
                continue

            dist = t.x0 - tx_x1
            if dist < best_dist:
                best_dist = dist
                best_val = clean_val
                logger.debug("[XiaoxieAnchor] 候选hj: %s dist=%.1f (x0=%.1f cy=%.1f text='%s')",
                            clean_val, dist, t.x0, t.cy, text[:30])

        logger.debug("[XiaoxieAnchor] ¥搜索结束: best_val=%s tokens=%d y_tol=%.1f",
                     best_val or 'None', len(tokens), y_tolerance)
        return best_val

    # ═══════════════════════════════════════════════════
    # 核心：双¥水平对齐提取 je/se
    # ═══════════════════════════════════════════════════

    def _extract_dual_yen_pair(self, doc: OCRDocument) -> Optional[Tuple]:
        """
        核心规则：找同一水平线上左右排列的两个¥金额
        
        左边=je，右边=se
        多个候选时，用"合计/计"行锚点筛选
        """
        tokens = list(doc.bbox_tokens) if doc and doc.bbox_tokens else []
        if not tokens:
            return None

        # 提取所有¥金额token
        yen_tokens = self._extract_yen_tokens(tokens)
        if len(yen_tokens) < 2:
            logger.debug("[DualYen] ¥金额token不足2个: %d个", len(yen_tokens))
            return None

        logger.info("[DualYen] 找到%d个¥金额token", len(yen_tokens))

        # 找同一水平线上的¥金额对
        pairs = self._find_horizontal_pairs(yen_tokens)
        if not pairs:
            logger.info("[DualYen] 未找到水平对齐的¥金额对")
            return None

        logger.info("[DualYen] 找到%d组水平对齐候选", len(pairs))
        for i, p in enumerate(pairs):
            logger.info("[DualYen] 候选%d: je=%s(%.1f,%.1f) se=%s(%.1f,%.1f) y=%.1f",
                       i, p.je, p.je_token.x0, p.je_token.y0,
                       p.se, p.se_token.x0, p.se_token.y0, p.y_center)

        # 多组候选时，用"合计/计"行锚点筛选
        if len(pairs) > 1:
            selected_pair = self._select_pair_by_heji_anchor(tokens, pairs)
            if selected_pair:
                pairs = [selected_pair]
                logger.info("[DualYen] 合计锚点筛选后保留1组")

        # 取最佳候选
        best_pair = pairs[0]
        
        if self._validate_pair(best_pair):
            conf = 95 if len(pairs) == 1 else 90
            return (best_pair.je, best_pair.se, conf, '双¥水平对齐')
        else:
            logger.warning("[DualYen] 金额对校验失败: je=%s se=%s", 
                          best_pair.je, best_pair.se)
            return None

    def _extract_yen_tokens(self, tokens: List[Token]) -> List[Tuple[Token, str, float]]:
        """
        提取带¥的金额token
        返回: [(token, clean_value, numeric_value), ...]
        """
        result = []
        for t in tokens:
            text = getattr(t, 'text', '')
            m = _YUAN_RE.search(text)
            if not m:
                continue
            
            raw_val = m.group(1)
            clean_val = raw_val.replace(',', '').replace(' ', '')
            
            try:
                num_val = float(clean_val)
            except ValueError:
                continue
            
            # 过滤无效金额（太长可能是账号）
            if len(clean_val.replace('-', '').split('.')[0]) >= 10:
                continue
            
            result.append((t, clean_val, num_val))
        
        # 按Y坐标排序，再按X坐标排序
        result.sort(key=lambda x: (x[0].cy, x[0].x0))
        return result

    def _find_horizontal_pairs(self, yen_tokens: List[Tuple]) -> List[AmountPair]:
        """
        找同一水平线上的¥金额对
        
        规则：
        - Y中心偏差 <= 字高 * 0.5（同一行）
        - 左边金额X < 右边金额X
        - 税前金额 > 总税额
        """
        pairs = []
        n = len(yen_tokens)
        
        for i in range(n):
            t1, val1, num1 = yen_tokens[i]
            
            for j in range(i + 1, n):
                t2, val2, num2 = yen_tokens[j]
                
                # Y坐标检查：必须在同一行
                y_diff = abs(t1.cy - t2.cy)
                avg_height = (t1.height + t2.height) / 2
                y_tolerance = max(avg_height * 0.5, 8)  # 最小8像素容差
                
                if y_diff > y_tolerance:
                    continue
                
                # X坐标检查：t1必须在t2左边
                if t1.x0 >= t2.x0:
                    continue
                
                # 数值检查：je > se
                left_val, right_val = num1, num2
                left_token, right_token = t1, t2
                left_str, right_str = val1, val2
                
                # 红字发票处理：绝对值比较
                is_red = (num1 < 0 or num2 < 0)
                if is_red:
                    cmp_result = abs(num1) > abs(num2)
                else:
                    cmp_result = num1 > num2
                
                if not cmp_result:
                    logger.debug("[DualYen] 跳过: 左值%.2f <= 右值%.2f", num1, num2)
                    continue
                
                pair = AmountPair(
                    je=left_str,
                    se=right_str,
                    je_token=left_token,
                    se_token=right_token,
                    y_center=(t1.cy + t2.cy) / 2,
                    x_gap=t2.x0 - t1.x1,
                    je_value=left_val,
                    se_value=right_val
                )
                pairs.append(pair)
                logger.debug("[DualYen] 发现候选对: je=%s se=%s y=%.1f x_gap=%.1f",
                            left_str, right_str, pair.y_center, pair.x_gap)
        
        # 排序：x_gap小的优先（更紧凑），然后y_center大的优先（更靠下通常是合计行）
        pairs.sort(key=lambda p: (p.x_gap, -p.y_center))
        return pairs

    def _select_pair_by_heji_anchor(self, all_tokens: List[Token],
                                     pairs: List[AmountPair]) -> Optional[AmountPair]:
        """
        用"合计/计"行锚点筛选多组候选
        
        找"合计/计"token的Y坐标，选最接近的那组金额对
        """
        # 找所有"合计/计"token
        heji_tokens = []
        for t in all_tokens:
            text = getattr(t, 'text', '').strip()
            if _HEJI_RE.search(text) or _JI_RE.search(text):
                heji_tokens.append(t)
        
        if not heji_tokens:
            logger.info("[DualYen] 无合计/计锚点，取第一组")
            return pairs[0] if pairs else None
        
        logger.info("[DualYen] 找到%d个合计/计锚点", len(heji_tokens))
        
        # 找最接近的金额对
        best_pair = None
        best_score = float('inf')
        
        for ht in heji_tokens:
            ht_cy = ht.cy
            ht_x = ht.x0
            
            for pair in pairs:
                # Y距离
                y_dist = abs(pair.y_center - ht_cy)
                # X距离：合计应该在金额对左边或附近
                x_dist = abs(pair.je_token.x0 - ht_x)
                
                # 综合评分：Y距离优先，X距离辅助
                score = y_dist + x_dist * 0.1
                
                # 额外加分：如果合计在金额对左边
                if ht_x < pair.je_token.x0:
                    score *= 0.8
                
                logger.debug("[DualYen] 锚点评分: 合计(%.1f,%.1f) vs 对je(%.1f,%.1f) score=%.1f",
                            ht_x, ht_cy, pair.je_token.x0, pair.y_center, score)
                
                if score < best_score:
                    best_score = score
                    best_pair = pair
        
        return best_pair

    def _validate_pair(self, pair: AmountPair) -> bool:
        """校验金额对是否合法"""
        # X坐标校验：je必须在se左边
        if pair.je_token.x0 >= pair.se_token.x0:
            logger.warning("[DualYen] X坐标校验失败: je.x%.1f >= se.x%.1f",
                          pair.je_token.x0, pair.se_token.x0)
            return False
        
        # 数值校验
        if pair.je_value <= 0 and pair.se_value <= 0:
            # 红字发票
            if abs(pair.je_value) <= abs(pair.se_value):
                logger.warning("[DualYen] 红字校验失败: |je|%.2f <= |se|%.2f",
                              abs(pair.je_value), abs(pair.se_value))
                return False
        elif pair.je_value <= pair.se_value:
            logger.warning("[DualYen] 校验失败: je%.2f <= se%.2f", 
                          pair.je_value, pair.se_value)
            return False
        
        return True

    # ═══════════════════════════════════════════════════
    # 辅助：获取summary区域token
    # ═══════════════════════════════════════════════════

    def _get_summary_tokens(self, doc: OCRDocument) -> List[Token]:
        """获取summary区域token，优先summary区域"""
        summary_region = doc.regions.get('summary')
        
        if summary_region and summary_region.tokens:
            logger.debug("[Tokens] 使用summary区域token: %d个", len(summary_region.tokens))
            return summary_region.tokens
        
        if doc.bbox_tokens:
            tokens = list(doc.bbox_tokens)
            if summary_region and summary_region.y1 > 0:
                # 按y范围过滤
                tokens = [t for t in tokens 
                         if summary_region.y <= getattr(t, 'cy', t.y0) <= summary_region.y1]
                logger.debug("[Tokens] 从bbox过滤得%d个token (y=[%.0f,%.0f])",
                            len(tokens), summary_region.y, summary_region.y1)
            else:
                logger.debug("[Tokens] 使用全部%d个bbox_tokens", len(tokens))
            return tokens
        
        return []

    # ═══════════════════════════════════════════════════
    # 阶段1: 标签绑定（兜底）
    # ═══════════════════════════════════════════════════

    def _scan_lines_once(self, doc: OCRDocument) -> dict:
        """单次扫描 doc.lines，预收集所有行级匹配信息"""
        tax_total = []
        total = []
        xiaoxie = None
        je_kw = ''
        se_kw = ''
        n = len(doc.lines)

        for i, line in enumerate(doc.lines):
            if _TAX_TOTAL_LINE_RE.search(line):
                tax_total.append((i, line))

            if xiaoxie is None and '小写' in line:
                xiaoxie = i

            if _TOTAL_LINE_RE.search(line):
                m = _YUAN_RE.search(line)
                if m:
                    v = self._clean_amount(m.group(1))
                    if v:
                        total.append((i, v))

            # 金额/税额共享 _AMT_OPT_RE 匹配，合并为一次正则扫描
            kw_line = None
            if not je_kw and _JE_KW_RE.search(line):
                kw_line = line
            if not se_kw and _SE_KW_RE.search(line):
                kw_line = line
            if kw_line is not None:
                m = _AMT_OPT_RE.search(kw_line)
                if not m and i + 1 < n:
                    m = _AMT_OPT_RE.search(doc.lines[i + 1])
                if m:
                    v = self._clean_amount(m.group(1))
                    if not je_kw and _JE_KW_RE.search(kw_line):
                        je_kw = v
                    if not se_kw and _SE_KW_RE.search(kw_line):
                        se_kw = v

        return {
            'tax_total': tax_total,
            'total': total,
            'xiaoxie': xiaoxie,
            'je_kw': je_kw,
            'se_kw': se_kw,
        }

    def _stage1_label_binding(self, doc: OCRDocument, candidates: dict) -> dict:
        """阶段1: 通过语义标签绑定金额字段"""
        scan = self._scan_lines_once(doc)

        # ── 1.1 价税合计(小写) → amountHj ──
        m = _SMALL_WRITE_RE.search(doc.collapsed)
        if m:
            v = self._clean_amount(m.group(1))
            if v:
                candidates['hj'].append(AmountCandidate(v, 95, '价税合计(小写)'))

        # ── 1.2 行级别价税合计匹配 → amountHj ──
        if not candidates['hj']:
            for i, line in scan['tax_total']:
                logger.debug("[Amount] Found keyword at line %d: '%s'", i, line)
                m = _YUAN_RE.search(line)
                if m:
                    v = self._clean_amount(m.group(1))
                    candidates['hj'].append(AmountCandidate(v, 90, f'价税合计行#{i}'))
                    break
                m = _AMOUNT_NUM_RE.search(line)
                if m:
                    v = self._clean_amount(m.group(1))
                    candidates['hj'].append(AmountCandidate(v, 80, f'价税合计行#{i}(裸数字)'))
                    break
                for j in range(i + 1, min(len(doc.lines), i + 5)):
                    m = _YUAN_RE.search(doc.lines[j])
                    if m:
                        v = self._clean_amount(m.group(1))
                        candidates['hj'].append(AmountCandidate(v, 85, f'价税合计下行#{j}'))
                        break
                    m = re.search(r'^([\d,]+\.\d{2})$', doc.lines[j].strip())
                    if m:
                        v = self._clean_amount(m.group(1))
                        candidates['hj'].append(AmountCandidate(v, 75, f'价税合计下行#{j}(裸数字)'))
                        break
                if candidates['hj']:
                    break
                for j in range(max(0, i - 3), i):
                    m = _YUAN_RE.search(doc.lines[j])
                    if m:
                        v = self._clean_amount(m.group(1))
                        candidates['hj'].append(AmountCandidate(v, 70, f'价税合计上行#{j}'))
                        break
                if candidates['hj']:
                    break

        # ── 1.2b "（小写）"行锚点 + 跳过连续¥金额 → amountHj ──
        if not candidates['hj']:
            xiaoxie_idx = scan['xiaoxie']
            if xiaoxie_idx is not None:
                yen_in_range = []
                for j in range(xiaoxie_idx + 1, min(len(doc.lines), xiaoxie_idx + 40)):
                    m = _YUAN_RE.search(doc.lines[j])
                    if m:
                        yen_in_range.append((j, self._clean_amount(m.group(1))))
                if yen_in_range:
                    best_idx = len(yen_in_range) - 1
                    for k in range(len(yen_in_range) - 2, -1, -1):
                        gap = yen_in_range[k + 1][0] - yen_in_range[k][0]
                        if gap > 3:
                            best_idx = k + 1
                            break
                    v = yen_in_range[best_idx][1]
                    if v and self._is_valid_amount(v):
                        candidates['hj'].append(
                            AmountCandidate(v, 88, f'价税合计(小写锚点#{yen_in_range[best_idx][0]})'))

        # ── 1.3 collapsed 文本价税合计匹配 → amountHj ──
        if not candidates['hj']:
            m = _PRICE_TAX_TOTAL_RE.search(doc.collapsed)
            if m:
                v = self._clean_amount(m.group(1))
                if v:
                    candidates['hj'].append(AmountCandidate(v, 75, '价税合计(collapsed)'))

        # ── 1.4 同行金额+税额匹配 → amountJe + amountSe ──
        m = _AMOUNT_SE_LINE_RE.search(doc.collapsed)
        if m:
            je_v = self._clean_amount(m.group(1))
            se_v = self._clean_amount(m.group(2))
            if je_v:
                candidates['je'].append(AmountCandidate(je_v, 92, '同行金额+税额'))
            if se_v:
                candidates['se'].append(AmountCandidate(se_v, 92, '同行金额+税额'))

        # ── 1.5 金额:标签 → amountJe ──
        if not candidates['je']:
            m = _AMOUNT_JE_RE.search(doc.collapsed)
            if m:
                v = self._clean_amount(m.group(1))
                if v:
                    candidates['je'].append(AmountCandidate(v, 88, '金额标签'))

        # ── 1.6 税额:标签 → amountSe ──
        if not candidates['se']:
            m = _TAX_SE_RE.search(doc.collapsed)
            if m:
                v = self._clean_amount(m.group(1))
                if v:
                    candidates['se'].append(AmountCandidate(v, 88, '税额标签'))

        # ── 1.7 合计金额/合计税额标签 → amountJe / amountSe ──
        if not candidates['je']:
            m = _AMOUNT_JE_TOTAL_RE.search(doc.collapsed)
            if m:
                v = self._clean_amount(m.group(1))
                if v:
                    candidates['je'].append(AmountCandidate(v, 80, '合计金额标签'))

        if not candidates['se']:
            m = _TAX_SE_TOTAL_RE.search(doc.collapsed)
            if m:
                v = self._clean_amount(m.group(1))
                if v:
                    candidates['se'].append(AmountCandidate(v, 80, '合计税额标签'))

        # ── 1.8 逐行搜索兜底 → amountJe / amountSe ──
        if not candidates['je'] and scan['je_kw']:
            candidates['je'].append(AmountCandidate(scan['je_kw'], 70, '逐行金额搜索'))

        if not candidates['se'] and scan['se_kw']:
            candidates['se'].append(AmountCandidate(scan['se_kw'], 70, '逐行税额搜索'))

        # ── 1.9 合计行回退 → amountHj ──
        if not candidates['hj'] and scan['total']:
            _, v = scan['total'][0]
            candidates['hj'].append(AmountCandidate(v, 55, '合计行(无税关键字)'))

        # ── 1.10 末尾 ¥ 前缀金额回退 → amountHj ──
        if not candidates['hj']:
            all_yen = _YEN_PREFIX_RE.findall(doc.collapsed)
            if all_yen:
                last = self._clean_amount(all_yen[-1])
                if last and self._is_valid_amount(last):
                    candidates['hj'].append(AmountCandidate(last, 40, '末尾¥金额(回退)'))

        return candidates

    # ═══════════════════════════════════════════════════
    # 阶段2: 空间表格定位（兜底）
    # ═══════════════════════════════════════════════════

    def _stage2_spatial_lookup(self, doc: OCRDocument, candidates: dict) -> dict:
        """阶段2: 空间定位金额字段"""
        # ── 2.1 合-计锚点规则 ──
        heji_result = self._stage2_heji_anchor(doc, candidates)
        if heji_result is not None:
            logger.info("[Amount] 合-计锚点规则成功: je=%s se=%s hj=%s conf=%d",
                        heji_result['je'], heji_result['se'],
                        heji_result['hj'], heji_result['conf'])
            return {
                'hj': [AmountCandidate(heji_result['hj'], heji_result['conf'], '合-计锚点')],
                'je': [AmountCandidate(heji_result['je'], heji_result['conf'], '合-计锚点')],
                'se': [AmountCandidate(heji_result['se'], heji_result['conf'], '合-计锚点')],
            }

        # ── 2.2 小写右侧 ¥ 金额提取 ──
        xiaoxie_result = self._stage2_xiaoxie_anchor(doc, candidates)
        if xiaoxie_result is not None:
            logger.info("[Amount] 小写锚点规则成功: hj=%s conf=%d",
                        xiaoxie_result['hj'], xiaoxie_result['conf'])
            candidates['hj'].append(AmountCandidate(
                xiaoxie_result['hj'], xiaoxie_result['conf'], '小写锚点'))
            return candidates

        return candidates

    def _stage2_heji_anchor(self, doc: OCRDocument, candidates: dict) -> Optional[dict]:
        """合-计锚点规则"""
        summary_region = doc.regions.get('summary')
        summary_tokens = None

        if summary_region and summary_region.tokens:
            summary_tokens = summary_region.tokens
        elif doc.bbox_tokens:
            summary_tokens = list(doc.bbox_tokens)
            if summary_region and summary_region.y1 > 0:
                summary_tokens = [t for t in summary_tokens
                                  if summary_region.y <= t.cy <= summary_region.y1]

        if not summary_tokens:
            return None

        # 找"价税合计(大写)" token
        daxie_token = None
        for t in summary_tokens:
            if _DAXIE_TOTAL_RE.search(t.text):
                if daxie_token is None or t.cy > daxie_token.cy:
                    daxie_token = t

        if daxie_token is None:
            return None

        # 找"合""计"单独 token
        daxie_cy = daxie_token.cy
        daxie_height = daxie_token.height
        search_range = daxie_height * 3

        he_token = None
        ji_token = None
        for t in summary_tokens:
            if abs(t.cy - daxie_cy) > search_range:
                continue
            if t.text.strip() == '合':
                he_token = t
            elif t.text.strip() == '计':
                ji_token = t

        if he_token is None or ji_token is None:
            return None

        he_cy = he_token.cy
        ji_cy = ji_token.cy
        he_x = he_token.cx
        ji_x = ji_token.cx

        # 检查合/计在同一行
        cy_diff = abs(he_cy - ji_cy)
        cy_tol = daxie_height * 0.5
        if cy_diff > cy_tol:
            return None

        # 在合/计同一行找两个数值
        heji_line_cy = he_cy
        x_start = max(he_token.x1, ji_token.x1)
        line_tol = daxie_height * 0.5

        raw_values = []
        for t in summary_tokens:
            if abs(t.cy - heji_line_cy) > line_tol:
                continue
            if t.x <= x_start:
                continue
            m = _YEN_AMOUNT_RE.search(t.text)
            if not m:
                m = _AMOUNT_NUM_RE.search(t.text)
            if not m:
                continue
            raw_val = m.group(1)
            clean_val = raw_val.replace(',', '').replace(' ', '')
            if not self._is_valid_amount(clean_val):
                continue
            raw_values.append((raw_val, clean_val, t.cx))

        if len(raw_values) < 2:
            return None

        # 按x排序：靠左=金额, 靠右=税额
        raw_values.sort(key=lambda x: x[2])
        je_val = raw_values[0][1]
        se_val = raw_values[1][1]

        # 获取 amountHj
        hj_val = None
        hj_from_stage1 = self._select_best(candidates.get('hj', []))
        if hj_from_stage1:
            best_hj = max(candidates['hj'], key=lambda c: c.confidence, default=None)
            if best_hj and best_hj.confidence >= 75:
                if hj_from_stage1 != je_val and hj_from_stage1 != se_val:
                    hj_val = hj_from_stage1

        # 没有阶段1候选，在 daxie 行找第三个独立数值
        if hj_val is None:
            daxie_cy = daxie_token.cy
            for t in summary_tokens:
                if abs(t.cy - daxie_cy) > line_tol:
                    continue
                m_hj = _AMOUNT_NUM_RE.search(t.text) or _YEN_AMOUNT_RE.search(t.text)
                if not m_hj:
                    continue
                cv = m_hj.group(1).replace(',', '').replace(' ', '')
                if not self._is_valid_amount(cv):
                    continue
                if cv == je_val or cv == se_val:
                    continue
                hj_val = cv
                break

        if hj_val is None:
            return None

        # 校验
        try:
            je_f = float(je_val)
            se_f = float(se_val)
            hj_f = float(hj_val)
        except (ValueError, TypeError):
            return None

        is_red = (hj_f < 0)
        if is_red:
            amt_gt_tax = abs(je_f) > abs(se_f)
        else:
            amt_gt_tax = je_f > se_f

        arith_diff = abs(je_f + se_f - hj_f)
        arith_ok = arith_diff <= 0.02

        if arith_ok and amt_gt_tax:
            return {'je': je_val, 'se': se_val, 'hj': hj_val, 'conf': 95}
        elif arith_diff <= 0.05:
            for adj in [0.01, -0.01, 0.02, -0.02]:
                adjusted_se = round(se_f + adj, 2)
                if abs(je_f + adjusted_se - hj_f) <= 0.02:
                    if (is_red and abs(je_f) > abs(adjusted_se)) or (not is_red and je_f > adjusted_se):
                        return {'je': je_val, 'se': f"{adjusted_se:.2f}", 'hj': hj_val, 'conf': 90}

        return None

    def _stage2_xiaoxie_anchor(self, doc: OCRDocument, candidates: dict) -> Optional[dict]:
        """小写锚点规则（旧版，作为兜底）"""
        summary_tokens = None
        if doc.regions.get('summary') and doc.regions['summary'].tokens:
            summary_tokens = doc.regions['summary'].tokens
        elif doc.bbox_tokens:
            summary_tokens = list(doc.bbox_tokens)

        if not summary_tokens:
            return None

        daxie_token = None
        for t in summary_tokens:
            if _DAXIE_TOTAL_RE.search(getattr(t, 'text', '')):
                if daxie_token is None or t.cy > daxie_token.cy:
                    daxie_token = t

        if daxie_token is None:
            return None

        xiaoxie_token = None
        for t in summary_tokens:
            if _XIAOXIE_ANCHOR_RE.search(getattr(t, 'text', '')):
                xiaoxie_token = t
                break

        if xiaoxie_token is None:
            return None

        # 检查 Y 轴重叠
        d_y0, d_y1 = getattr(daxie_token, 'y0', 0), getattr(daxie_token, 'y1', 0)
        x_y0, x_y1 = getattr(xiaoxie_token, 'y0', 0), getattr(xiaoxie_token, 'y1', 0)
        y_overlap = max(0, min(d_y1, x_y1) - max(d_y0, x_y0))

        if y_overlap <= 0:
            return None

        # 取小写右侧最近的 ¥ 金额
        x_x1 = getattr(xiaoxie_token, 'x1', 0)
        x_cy = (x_y0 + x_y1) / 2
        y_tol = max(x_y1 - x_y0, 10) * 1.5

        best_val = None
        best_dist = None

        for t in summary_tokens:
            m = _YUAN_RE.search(getattr(t, 'text', ''))
            if not m:
                continue
            tx = getattr(t, 'x0', 0)
            if tx < x_x1 - 5:
                continue
            ty = getattr(t, 'cy', 0) if hasattr(t, 'cy') else (getattr(t, 'y0', 0) + getattr(t, 'y1', 0)) / 2
            if abs(ty - x_cy) > y_tol:
                continue
            clean_val = m.group(1).replace(',', '').replace(' ', '')
            if not self._is_valid_amount(clean_val):
                continue
            dist = tx - x_x1
            if best_val is None or dist < best_dist:
                best_val = clean_val
                best_dist = dist

        if best_val is None:
            return None

        return {'hj': best_val, 'conf': 90}

    @staticmethod
    def _detect_table_columns(items_region) -> dict:
        """检测表格列位置"""
        if not items_region or not items_region.tokens:
            return {}

        rows = AmountExtractor._cluster_by_y(items_region.tokens)
        header_row = None

        for row in rows:
            row_text = ' '.join(t.text for t in row)
            has_amount = bool(_HEADER_AMOUNT_COL.search(row_text))
            has_tax = bool(_HEADER_TAX_COL.search(row_text))
            has_tax_rate = bool(_HEADER_TAX_RATE_COL.search(row_text))
            if has_amount and (has_tax or has_tax_rate):
                header_row = row
                break

        if not header_row:
            return {}

        columns = {}
        for token in header_row:
            text = token.text.strip()
            cx = token.cx
            if _HEADER_AMOUNT_COL.search(text) and not _HEADER_TOTAL_COL.search(text):
                columns['amount'] = (token.x, token.x1, cx)
            elif _HEADER_TAX_COL.search(text):
                columns['tax'] = (token.x, token.x1, cx)
            elif _HEADER_TOTAL_COL.search(text):
                columns['total'] = (token.x, token.x1, cx)

        result = {}
        col_order = sorted(columns.keys(), key=lambda k: columns[k][2])

        for i, col_name in enumerate(col_order):
            x0 = columns[col_name][0]
            if i < len(col_order) - 1:
                next_x0 = columns[col_order[i + 1]][0]
                x1 = (columns[col_name][1] + next_x0) / 2
            else:
                x1 = columns[col_name][1] + 100
            result[col_name] = (x0, x1)

        return result

    @staticmethod
    def _classify_column(cx: float, columns: dict) -> str:
        """根据 x 坐标判断所属列类型"""
        for col_type, (x0, x1) in columns.items():
            if x0 <= cx <= x1:
                return col_type
        return 'unknown'

    @staticmethod
    def _cluster_by_y(tokens: list) -> list:
        """按 y 坐标将 tokens 聚类为行"""
        if not tokens:
            return []

        sorted_tokens = sorted(tokens, key=lambda t: t.cy)

        rows = []
        current_row = [sorted_tokens[0]]
        current_y0 = sorted_tokens[0].y
        current_y1 = sorted_tokens[0].y1

        for token in sorted_tokens[1:]:
            overlap_start = max(token.y, current_y0)
            overlap_end = min(token.y1, current_y1)
            overlap = max(0.0, overlap_end - overlap_start)
            token_height = max(token.height, 1)

            overlap_ratio = overlap / token_height
            if overlap_ratio >= 0.3:
                current_row.append(token)
                current_y0 = min(current_y0, token.y)
                current_y1 = max(current_y1, token.y1)
            else:
                rows.append(sorted(current_row, key=lambda t: t.x))
                current_row = [token]
                current_y0 = token.y
                current_y1 = token.y1

        if current_row:
            rows.append(sorted(current_row, key=lambda t: t.x))

        return rows

    # ═══════════════════════════════════════════════════
    # 阶段3: 算术校验
    # ═══════════════════════════════════════════════════

    def _stage3_arithmetic_validation(self, hj: str, je: str, se: str) -> tuple:
        """阶段3: 算术校验与修正"""
        if not hj:
            return hj, je, se

        try:
            total = float(hj)
            net = float(je) if je else 0.0
            tax = float(se) if se else 0.0
        except (ValueError, TypeError):
            return hj, je, se

        if not je and not se:
            return hj, je, se

        diff = abs(net + tax - total)
        hj_abs = max(abs(total), 1.0)
        ratio_diff = diff / hj_abs

        # 免税发票
        if tax == 0 and net == total:
            logger.debug("[Validation] Tax-free, diff=%.4f", diff)
            return hj, je, '0.00'

        # 红字发票
        if total < 0 and net < 0 and tax <= 0:
            if diff <= 0.02 or ratio_diff <= 0.01:
                logger.debug("[Validation] Red invoice, diff=%.4f, ratio=%.4f", diff, ratio_diff)
                return hj, je, se
            if tax >= 0 and abs(abs(net) - abs(total) - tax) <= 0.02:
                logger.debug("[Validation] Red invoice with discount, diff=%.4f", diff)
                return hj, je, se

        # 税额为 0
        if tax == 0 and abs(net - total) <= 0.02:
            logger.debug("[Validation] Zero tax, diff=%.4f", diff)
            return hj, je, '0.00'

        # 正常校验通过
        if diff <= 0.02 or ratio_diff <= 0.01:
            logger.debug("[Validation] Passed: diff=%.4f, ratio=%.4f", diff, ratio_diff)
            return hj, je, se

        # 校验失败：尝试微调税额
        if je and se:
            adjusted_se = f"{round(total - net, 2):.2f}"
            if abs(total - (net + round(total - net, 2))) <= 0.02:
                logger.debug("[Validation] Adjusted tax: %s -> %s", se, adjusted_se)
                return hj, je, adjusted_se
            logger.debug("[Validation] Failed: total=%s, je=%s, se=%s, diff=%.4f", hj, je, se, diff)
            return hj, '', ''

        # 仅有金额，尝试推导税额
        if je and not se:
            derived_tax = f"{round(total - net, 2):.2f}"
            if abs(total - net) <= 0.02:
                se = '0.00'
            elif float(derived_tax) > 0:
                se = derived_tax
                logger.debug("[Validation] Derived tax=%s from total=%s, amount=%s", se, hj, je)
            return hj, je, se

        # 仅有税额，尝试推导金额
        if se and not je:
            derived_net = f"{round(total - tax, 2):.2f}"
            if float(derived_net) > 0:
                je = derived_net
                logger.debug("[Validation] Derived amount=%s from total=%s, tax=%s", je, hj, se)
            return hj, je, se

        return hj, je, se

    # ═══════════════════════════════════════════════════
    # 辅助方法
    # ═══════════════════════════════════════════════════

    @staticmethod
    def _select_best(candidates: list) -> str:
        """从候选列表中选择置信度最高的值"""
        if not candidates:
            return ''
        best = max(candidates, key=lambda c: c.confidence)
        logger.debug("[Amount] Selected: %s (conf=%d, source=%s)",
                     best.value, best.confidence, best.source)
        return best.value

    @staticmethod
    def _is_valid_amount(value: str) -> bool:
        """排除税号/银行账号等伪金额"""
        if not value:
            return False
        clean = value.replace(',', '').replace('¥', '').replace('￥', '').replace(' ', '')
        if '.' not in clean:
            return False
        int_part = clean.split('.')[0].replace(',', '')
        if len(int_part) >= 10:
            return False
        return True

    def _extract_by_keyword_line(self, lines: list, keyword: str) -> str:
        """在行中按关键词提取金额"""
        for i, line in enumerate(lines):
            if re.search(keyword, line, re.IGNORECASE):
                m = re.search(r'[¥￥]?\s*([\d,]+\.\d{2})', line)
                if not m and i + 1 < len(lines):
                    m = re.search(r'[¥￥]?\s*([\d,]+\.\d{2})', lines[i + 1])
                if m:
                    return self._clean_amount(m.group(1))
        return ''

    def _extract_amount_from_right(self, label_token, all_tokens):
        """从标签token右侧提取金额"""
        right_tokens = [t for t in all_tokens 
                       if abs(t.y0 - label_token.y0) < 10
                       and t.x0 > label_token.x1]
        
        if not right_tokens:
            return None
        
        right_tokens.sort(key=lambda t: t.x0)
        
        collected_text = ''
        prev_x1 = label_token.x1
        avg_char_width = (label_token.x1 - label_token.x0) / max(len(label_token.text), 1)
        
        for rt in right_tokens:
            gap = rt.x0 - prev_x1
            if collected_text and gap > avg_char_width * 1.5:
                break
            collected_text += rt.text
            prev_x1 = rt.x1
        
        cleaned = collected_text.replace(',', '').replace('¥', '').replace('￥', '').strip()
        match = re.search(r'\d+\.?\d*', cleaned)
        if match:
            return match.group(0)
        
        return None

    @staticmethod
    def _clean_amount(s: str) -> str:
        if not s:
            return ''
        return s.replace(',', '').replace('¥', '').replace('￥', '').replace(' ', '')