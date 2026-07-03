"""
杂项字段提取器（备注、收款人、复核人、开票人）
使用 regex_patterns 中的原始正则

修复清单：
[FIX-1] _extract_note_no_colon: 竖排"备"+"注"时 note_idx 指向"注"行
        修复前 note_idx=i 指向"备"行，搜索从"注"行开始，"注"被收集为备注
        修复后 note_idx=i+1 指向"注"行，搜索从"注"之后开始
[FIX-2] 新增 _extract_note_from_header_region: 全电发票备注内容
        出现在"电子发票"标题之前时的提取方法
[FIX-3] _extract_note: 在所有标准方法失败后回退到 header region 提取
[FIX-4] _clean_misc_text: 修正正则 $$$$ → $$ $$
        修复前 $$ 是行尾锚点，永远无法匹配 (BUYER_START) 等标签
        修复后 \(  匹配字面括号
[FIX-5] _extract_note_no_colon / _extract_note_from_footer:
        增加最短长度校验 (_NOTE_MIN_LENGTH)，防止返回标签碎片
[FIX-6] _extract_note_from_footer:
        使用 _find_footer_start 替代固定的"后20行"
        修复前搜索范围可能延伸到明细区域，误拾产品名续行
        如 "动断电家用电热水壶烧水"（无*标记、无数字，通过所有过滤器）
        修复后仅搜索 footer 区域（最后一个金额行之后）
"""
import re
import logging
from ..models import OCRDocument
from ..regex_patterns import (
    _NOTE_RE, _PAYEE_RE, _REVIEWER_RE, _REVIEWER_RE2, _ISSUER_RE,
)

logger = logging.getLogger(__name__)

# 人名校验：预期 2-4 个中文字符（可含·间隔符）
_PERSON_NAME_RE = re.compile(r'^[\u4e00-\u9fa5·]{2,4}$')

# [FIX-5] 备注内容最短长度（避免返回标签碎片如单个"注"字）
_NOTE_MIN_LENGTH = 5

# [FIX-2] 备注内容特征关键词（用于判断 header region 文本是否像备注）
_NOTE_CONTENT_INDICATORS = [
    r'订单号',
    r'购方[:：]',
    r'销方[:：]',
    r'快递',
    r'物流',
    r'合同',
    r'项目',
    r'工程',
    r'发生地',
    r'差额',
    r'编号',
]


class MiscExtractor:
    """提取备注、收款人、复核人、开票人"""

    # 同行判定容差（像素）
    _ROW_TOL = 18
    # 单元格宽度倍率阈值：文本宽度 > 标签宽度 * 3 → colspan 内容
    _CELL_WIDTH_RATIO = 3.0

    def extract(self, doc: OCRDocument):
        note = self._clean_misc_text(self._extract_note(doc))
        skr = self._clean_misc_text(self._extract_payee(doc))
        fhr = self._clean_misc_text(self._extract_reviewer(doc))
        kpr = self._clean_misc_text(self._extract_issuer(doc))
        return note, skr, fhr, kpr

    def extract_with_bbox(self, doc: OCRDocument):
        """结构化提取：用表格几何定位备注 + 底部反向扫描开票人"""
        tokens = doc.bbox_tokens
        if not tokens:
            return self.extract(doc)

        # ── 备注：单元格几何定位 ──
        # _extract_note_structural 返回 None 表示无法判断（回退正则方案）
        # 返回 '' 表示分割线命中但备注确实为空（不再回退）
        # 返回非空字符串表示提取成功
        note = self._extract_note_structural(tokens)
        if note is None:
            note = self._extract_note(doc)
        note = self._clean_misc_text(note)

        # ── 收款人/复核人/开票人：坐标增强 ──
        skr = self._extract_payee_with_bbox(tokens) or self._extract_payee(doc)
        fhr = self._extract_reviewer_with_bbox(tokens) or self._extract_reviewer(doc)
        kpr = self._extract_issuer_with_bbox(tokens) or self._extract_issuer(doc)

        return (self._clean_misc_text(note),
                self._clean_misc_text(skr),
                self._clean_misc_text(fhr),
                self._clean_misc_text(kpr))

    # ═══════════════════════════════════════════════════
    # 备注：结构化单元格几何
    # ═══════════════════════════════════════════════════

    def _find_remarks_divider_y(self, tokens):
        """找到价税合计区域的底边 y1，作为备注区域的水平分割线。
    
        返回分割线 token 的底边 y1（而非中心 cy），
        这样可以直接用 y1 做截止线，无需额外容差。
    
        策略：
        1. 找"大写"和"小写"关键词的 token
        2. 取最下方 token 的 y1
        3. 兆底用"价税合计" token 的 y1
        4. 全都找不到时返回 None（回退原逻辑）
        """
        daxie_y1s = []
        xiaoxie_y1s = []
        jshj_y1s = []
    
        for t in tokens:
            text = self._gtext(t).strip()
            y1 = self._gattr(t, 'y1')
            if '大写' in text:
                daxie_y1s.append(y1)
            if '小写' in text:
                xiaoxie_y1s.append(y1)
            if '价税合计' in text:
                jshj_y1s.append(y1)
    
        # 同时有大写和小写 → 取最下方的 y1
        if daxie_y1s and xiaoxie_y1s:
            y_dx = max(daxie_y1s)
            y_xx = max(xiaoxie_y1s)
            chosen = max(y_dx, y_xx)
            logger.info("[Misc] remarks_divider: 大写y1=%.1f 小写y1=%.1f → 取max=%.1f",
                         y_dx, y_xx, chosen)
            return chosen
    
        # 只有其一
        if xiaoxie_y1s:
            logger.info("[Misc] remarks_divider: 仅小写 y1=%s → %.1f", xiaoxie_y1s, max(xiaoxie_y1s))
            return max(xiaoxie_y1s)
        if daxie_y1s:
            logger.info("[Misc] remarks_divider: 仅大写 y1=%s → %.1f", daxie_y1s, max(daxie_y1s))
            return max(daxie_y1s)
    
        # 只有"价税合计"
        if jshj_y1s:
            logger.info("[Misc] remarks_divider: 仅价税合计 y1=%s → %.1f", jshj_y1s, max(jshj_y1s))
            return max(jshj_y1s)
    
        logger.info("[Misc] remarks_divider: 未找到大写/小写/价税合计 → None")
        return None

    def _find_vertical_divider_x(self, tokens):
        """检测竖排备注布局，返回竖向分割线的 x 坐标。

        策略：
        1. 找独立的“备”“注”单字 token
        2. 两者 x 坐标接近、y 坐标不同 → 竖排布局
        3. 可选：用“购买方信息”等标签进一步确认
        4. 取“备/注”的右边缘作为竖向分割线，右侧为备注内容区域

        返回 None 表示不是竖排布局。
        """
        bei_tokens = []
        zhu_tokens = []
        buyer_xs = []

        for t in tokens:
            text = self._gtext(t).strip()
            if text == '备':
                bei_tokens.append(t)
            elif text == '注':
                zhu_tokens.append(t)
            if '购买方' in text or '购方' in text:
                buyer_xs.append(self._gcx(t))

        logger.info("[Misc] vertical_divider: 备token=%d 注token=%d 购买方token=%d",
                    len(bei_tokens), len(zhu_tokens), len(buyer_xs))

        if not bei_tokens or not zhu_tokens:
            logger.info("[Misc] vertical_divider: 未找到备/注单字 token → 非竖排")
            return None

        # 找 x 坐标接近的备/注对（竖排特征：x 接近、y 不同）
        tol = self._ROW_TOL * 3
        best_pair = None
        for bt in bei_tokens:
            bx = self._gcx(bt)
            by = self._gcy(bt)
            bh = self._gattr(bt, 'y1') - self._gattr(bt, 'y0')
            for zt in zhu_tokens:
                zx = self._gcx(zt)
                zy = self._gcy(zt)
                zh = self._gattr(zt, 'y1') - self._gattr(zt, 'y0')
                # y 差超过平均字高一半 → 确认不在同一行
                min_y_diff = max((bh + zh) / 4, 3.0)
                if abs(bx - zx) < tol and abs(by - zy) > min_y_diff:
                    logger.info("[Misc] vertical_divider: 备(x=%.1f,y=%.1f) 注(x=%.1f,y=%.1f) x差=%.1f y差=%.1f>阈值%.1f → 竖排配对",
                                bx, by, zx, zy, abs(bx - zx), abs(by - zy), min_y_diff)
                    best_pair = (bt, zt)
                    break
            if best_pair:
                break

        if not best_pair:
            logger.info("[Misc] vertical_divider: 备/注 x 坐标不接近或 y 相同 → 非竖排")
            return None

        bt, zt = best_pair
        divider_x = max(self._gattr(bt, 'x1'), self._gattr(zt, 'x1'))

        # 可选确认：购买方标签的 x 与备/注接近
        if buyer_xs:
            label_cx = (self._gcx(bt) + self._gcx(zt)) / 2
            closest_buyer = min(buyer_xs, key=lambda x: abs(x - label_cx))
            if abs(closest_buyer - label_cx) < tol:
                logger.info("[Misc] vertical_divider: 备x=%.1f 注x=%.1f 购买方x=%.1f 三方对齐 → 竖排分割 x=%.1f",
                            self._gcx(bt), self._gcx(zt), closest_buyer, divider_x)
            else:
                logger.info("[Misc] vertical_divider: 备x=%.1f 注x=%.1f 购买方x=%.1f 未对齐(差%.1f) 但备注对齐 → 竖排分割 x=%.1f",
                            self._gcx(bt), self._gcx(zt), closest_buyer,
                            abs(closest_buyer - label_cx), divider_x)
        else:
            logger.info("[Misc] vertical_divider: 备x=%.1f 注x=%.1f 无购买方标签 → 备注对齐竖排分割 x=%.1f",
                        self._gcx(bt), self._gcx(zt), divider_x)

        return divider_x

    def _extract_note_below_divider(self, tokens, divider_y, vertical_x=None):
        """从 divider_y 以下提取备注内容。

        排除规则：
        - 竖排/横排"备注"标签行
        - 页面最底部的开票人/收款人/复核人标签行（仅此一行）
        - 发票元数据行（发票号码/代码/日期）
        - 过短行（标签碎片）

        备注内容是自由文本，不做关键词内容排除，避免误杀合法内容。

        当 vertical_x 不为 None 时，额外过滤掉左侧标签列的 token。
        """
        # ── 按行分组（量化 y 到 ROW_TOL 粒度）──
        # divider_y 已是分割线 token 的底边 y1，直接用 cy > divider_y 即可
        rows = {}
        for t in tokens:
            cy = self._gcy(t)
            if cy <= divider_y:
                continue
            text = self._gtext(t).strip()
            if not text:
                continue
            cx = self._gcx(t)
            # 竖排分割：过滤左侧标签列（用 x0 确保标签 token 本身被剔除）
            if vertical_x is not None:
                tx0 = self._gattr(t, 'x0')
                if tx0 <= vertical_x:
                    continue
                # 显式排除竖排标签单字
                if text in ('备', '注'):
                    continue
            y_key = round(cy / (self._ROW_TOL / 2.0))  # 备注区行间距较密，用半容差避免行合并
            rows.setdefault(y_key, []).append((cx, text))
            logger.debug("[Misc/Diag] token cy=%.1f→y_key=%d(半容差=%.0f) text='%s'",
                         cy, y_key, self._ROW_TOL / 2.0, text[:30])

        has_tokens_below = bool(rows)

        # ── DEBUG: 打印所有 y_key 的分布 ──
        if rows and len(rows) <= 3:  # 行数少时大概率是合并了，打印明细
            for yk in sorted(rows.keys()):
                cells = sorted(rows[yk], key=lambda x: x[0])
                row_text = ' '.join(t for _, t in cells).strip()
                half_tol = self._ROW_TOL / 2.0
                logger.debug("[Misc/Diag] y_key=%d (cy≈%.0f~%.0f) '%s...'",
                             yk, yk * half_tol, (yk + 1) * half_tol,
                             row_text[:60])
        else:
            logger.debug("[Misc/Diag] divider_y=%.1f 以下共 %d 个 y_key", divider_y, len(rows))

        if not rows:
            logger.info("[Misc] note_below_divider: divider_y=%.1f 以下无有效token", divider_y)
            return None  # None 表示分割线下方无数据，可能需要回退

        # ── 找最底部的人员标签行 y_key（仅排除这一行）──
        bottom_person_y_key = -1
        for y_key, cells in rows.items():
            for _, text in cells:
                if re.match(r'\s*(开票人|收款人|复核人)', text):
                    if y_key > bottom_person_y_key:
                        bottom_person_y_key = y_key
                    break
        if bottom_person_y_key >= 0:
            logger.info("[Misc] note_below_divider: 最底部人员行 y_key=%d", bottom_person_y_key)

        logger.info("[Misc] note_below_divider: divider_y=%.1f 共%d行候选", divider_y, len(rows))

        # ── 逐行过滤 ──
        note_lines = []
        for y_key in sorted(rows.keys()):
            cells = sorted(rows[y_key], key=lambda x: x[0])
            row_text = ' '.join(text for _, text in cells).strip()

            if not row_text:
                continue

            # 排除竖排/横排"备注"标签行
            if re.match(r'^\s*备\s*注\s*$', row_text):
                logger.info("[Misc] note_below_divider: 排除备注标签行 y_key=%d '%s'", y_key, row_text[:40])
                continue

            # 仅排除页面最底部的人员标签行（备注内容是自由文本，不做内容排除）
            if y_key == bottom_person_y_key:
                logger.info("[Misc] note_below_divider: 排除底部人员行 y_key=%d '%s'", y_key, row_text[:40])
                continue

            # 排除发票元数据行
            if re.match(r'^\s*(发票号码|发票代码|开票日期)', row_text):
                logger.info("[Misc] note_below_divider: 排除元数据行 y_key=%d '%s'", y_key, row_text[:40])
                continue

            # 排除过短行（标签碎片）
            if len(row_text) < 3:
                logger.info("[Misc] note_below_divider: 排除过短行 y_key=%d '%s'", y_key, row_text)
                continue

            logger.info("[Misc] note_below_divider: 收集 y_key=%d '%s'", y_key, row_text[:60])
            note_lines.append(row_text)

        if not note_lines:
            if has_tokens_below:
                logger.info("[Misc] note_below_divider: 有token但全部被过滤 → 备注为空")
            return ''  # 空字符串表示备注确实为空，无需回退

        result = '\n'.join(note_lines)
        if len(result.strip()) < _NOTE_MIN_LENGTH:
            return ''
        return result[:200]

    def _extract_note_structural(self, tokens):
        """用表格几何结构定位备注区域。

        优先使用价税合计区域的 y 坐标作为水平分割线；
        失败时回退到备注标签 + 单元格几何方案。
        """
        # ── 新方案：价税合计分割线 ──
        divider_y = self._find_remarks_divider_y(tokens)
        if divider_y is not None:
            logger.info("[Misc] note_structural: 分割线方案 divider_y=%.1f", divider_y)
            # 检测竖排备注布局
            vertical_x = self._find_vertical_divider_x(tokens)
            if vertical_x is not None:
                logger.info("[Misc] note_structural: 竖排分割 vertical_x=%.1f", vertical_x)
            note = self._extract_note_below_divider(tokens, divider_y, vertical_x)
            if note is None:
                logger.info("[Misc] note_structural: 分割线下方无token，回退标签方案")
            elif note:
                logger.info("[Misc] note_structural: 分割线命中 → '%s'", note[:80])
                return note
            else:
                logger.info("[Misc] note_structural: 分割线命中但备注为空")
                return ''
        else:
            logger.info("[Misc] note_structural: 无分割线，回退标签方案")

        # ── 原方案：备注标签 + 单元格几何 ──
        label = self._find_note_anchor(tokens)
        if not label:
            return None  # 无标签锚点，回退正则方案

        cell = self._find_cell_geometry(label, tokens)
        if cell:
            return self._text_in_cell(cell, tokens)

        return self._fallback_scan(label, tokens)

    def _find_note_anchor(self, tokens):
        """找到"备注"标签 token"""
        for t in tokens:
            text = self._gtext(t).strip()
            if text == '备注':
                return t
        # 竖排："备"+"注"
        for i, t in enumerate(tokens):
            if self._gtext(t).strip() == '备':
                for j in range(i + 1, min(i + 5, len(tokens))):
                    if self._gtext(tokens[j]).strip() == '注':
                        return tokens[j]
        return None

    def _find_cell_geometry(self, label, all_tokens):
        """找"备注"标签所在行的宽单元格边界（colspan 内容区）

        原理：
        - "备注"标签在第一列，宽度小
        - 同一行右侧有宽文本块（colspan=7 的内容区）
        - 宽文本块的几何边界 = 备注单元格边界
        """
        lcx = self._gcx(label)
        lcy = self._gcy(label)
        lx1 = self._gattr(label, 'x1')
        ly0 = self._gattr(label, 'y0')
        ly1 = self._gattr(label, 'y1')
        label_width = lx1 - self._gattr(label, 'x0')

        # 找同行 token
        same_row = [t for t in all_tokens
                    if abs(self._gcy(t) - lcy) < self._ROW_TOL
                    and self._gattr(t, 'x0') > lx1 - 5]

        if not same_row:
            # 内容可能在下一行
            same_row = [t for t in all_tokens
                        if 0 < self._gcy(t) - lcy < self._ROW_TOL * 2
                        and self._gattr(t, 'x1') > lcx]

        if not same_row:
            return None

        # 找最右侧 token 的 x1 作为右边界
        rightmost_x1 = max(self._gattr(t, 'x1') for t in same_row)
        # 找最下方 token 的 y1 作为下边界
        bottom_y1 = max(self._gattr(t, 'y1') for t in same_row)
        # 找最上方 token 的 y0 作为上边界
        top_y0 = min(self._gattr(t, 'y0') for t in same_row)

        # 验证：内容区宽度应远大于标签宽度（colspan 特征）
        content_width = rightmost_x1 - lx1
        if content_width < label_width * self._CELL_WIDTH_RATIO:
            return None

        return {
            'left': lx1 + 2,
            'right': rightmost_x1 + 5,
            'top': top_y0 - 2,
            'bottom': bottom_y1 + 5,
        }

    def _text_in_cell(self, cell, tokens):
        """收集单元格边界内的全部文本"""
        in_cell = []
        for t in tokens:
            cx = self._gcx(t)
            cy = self._gcy(t)
            if (cell['left'] <= cx <= cell['right'] and
                    cell['top'] <= cy <= cell['bottom']):
                text = self._gtext(t).strip()
                if text:
                    in_cell.append((cy, text))

        if not in_cell:
            return ''

        in_cell.sort(key=lambda x: x[0])
        # 同一行合并
        lines = []
        cur_line = []
        cur_y = None
        for cy, text in in_cell:
            if cur_y is None or abs(cy - cur_y) < self._ROW_TOL:
                cur_line.append(text)
                cur_y = cy
            else:
                lines.append(' '.join(cur_line))
                cur_line = [text]
                cur_y = cy
        if cur_line:
            lines.append(' '.join(cur_line))

        result = '\n'.join(lines)
        if len(result.strip()) < _NOTE_MIN_LENGTH:
            return ''
        return result[:200]

    def _fallback_scan(self, label, tokens):
        """无单元格结构时的兜底：从标签向右+向下扫描"""
        lx1 = self._gattr(label, 'x1')
        ly0 = self._gattr(label, 'y0')
        ly1 = self._gattr(label, 'y1')

        # 扫描范围：标签右侧 + 下方 150px
        page_right = max(self._gattr(t, 'x1') for t in tokens) if tokens else 1000
        scan_bottom = ly1 + 150

        texts = []
        for t in tokens:
            cx = self._gcx(t)
            cy = self._gcy(t)
            if cx > lx1 - 5 and ly0 - 5 <= cy <= scan_bottom:
                text = self._gtext(t).strip()
                if text and text != '备注':
                    texts.append((cy, text))

        if not texts:
            return ''

        texts.sort(key=lambda x: x[0])
        # 同行合并
        lines = []
        cur_line = []
        cur_y = None
        for cy, text in texts:
            if cur_y is None or abs(cy - cur_y) < self._ROW_TOL:
                cur_line.append(text)
                cur_y = cy
            else:
                lines.append(' '.join(cur_line))
                cur_line = [text]
                cur_y = cy
        if cur_line:
            lines.append(' '.join(cur_line))

        result = '\n'.join(lines)
        # 排除已知外部字段
        for kw in ['开票人', '收款人', '复核人']:
            idx = result.find(kw)
            if idx >= 0:
                result = result[:idx]
        result = result.strip()

        if len(result) < _NOTE_MIN_LENGTH:
            return ''
        return result[:200]

    def _extract_note_from_label(self, label_token, footer_tokens):
        """从备注标签提取内容
        
        优先提取右侧内容，回退提取下方内容
        使用相对容差而非硬编码像素
        """
        # 1. 优先提取右侧内容
        right_tokens = [t for t in footer_tokens 
                       if abs(t.y - label_token.y) < 10  # 同一水平线
                       and t.x > label_token.x1]  # 右侧
        
        if right_tokens:
            right_tokens.sort(key=lambda t: t.x)
            note_parts = []
            for rt in right_tokens:
                text = self._gtext(rt).strip() if hasattr(rt, 'text') else str(rt).strip()
                if text and text != '备注':
                    note_parts.append(text)
            if note_parts:
                return ' '.join(note_parts)
        
        # 2. 回退：提取下方内容
        # 使用相对值：标签宽度的2倍作为水平容差
        label_x0 = self._gattr(label_token, 'x0')
        label_x1 = self._gattr(label_token, 'x1')
        label_y1 = self._gattr(label_token, 'y1')
        label_width = label_x1 - label_x0
        horizontal_tolerance = label_width * 2
        
        below_tokens = [t for t in footer_tokens 
                       if self._gattr(t, 'y0') > label_y1  # 在标签下方
                       and abs(self._gattr(t, 'x0') - label_x0) < horizontal_tolerance]  # 水平位置接近
        
        if below_tokens:
            below_tokens.sort(key=lambda t: self._gattr(t, 'y0'))
            note_parts = []
            for bt in below_tokens:
                text = self._gtext(bt).strip() if hasattr(bt, 'text') else str(bt).strip()
                if text and text != '备注' and '备注' not in text:
                    note_parts.append(text)
            if note_parts:
                return ' '.join(note_parts)
        
        return None

    # ═══════════════════════════════════════════════════
    # 收款人/复核人/开票人：坐标增强
    # ═══════════════════════════════════════════════════

    def _extract_payee_with_bbox(self, tokens):
        return self._extract_person_by_bbox(tokens, '收款人')

    def _extract_reviewer_with_bbox(self, tokens):
        return self._extract_person_by_bbox(tokens, '复核人')

    def _extract_issuer_with_bbox(self, tokens):
        """开票人：优先从页面底部反向扫描"""
        return self._extract_person_from_bottom(tokens, '开票人')

    def _extract_person_by_bbox(self, tokens, label_text):
        """通用方法：找标签 token，取同行右侧文本作为值"""
        for t in tokens:
            text = self._gtext(t).strip()
            if label_text in text:
                # 同行右侧的 token
                tx1 = self._gattr(t, 'x1')
                tcy = self._gcy(t)
                right_tokens = [
                    x for x in tokens
                    if abs(self._gcy(x) - tcy) < self._ROW_TOL
                    and self._gattr(x, 'x0') > tx1 - 5
                ]
                if right_tokens:
                    right_tokens.sort(key=lambda x: self._gattr(x, 'x0'))
                    val = self._gtext(right_tokens[0]).strip()
                    # 清理值（去掉冒号等）
                    val = re.split(r'[:：]', val)[0].strip()
                    if val and len(val) <= 10:
                        return val
        return ''

    def _extract_person_from_bottom(self, tokens, label_text):
        """从页面底部反向扫描找标签，取同行右侧值"""
        # 按 y 坐标降序排列
        sorted_tokens = sorted(tokens, key=lambda t: self._gcy(t), reverse=True)
        for t in sorted_tokens:
            text = self._gtext(t).strip()
            if label_text in text:
                tx1 = self._gattr(t, 'x1')
                tcy = self._gcy(t)
                right_tokens = [
                    x for x in tokens
                    if abs(self._gcy(x) - tcy) < self._ROW_TOL
                    and self._gattr(x, 'x0') > tx1 - 5
                ]
                if right_tokens:
                    right_tokens.sort(key=lambda x: self._gattr(x, 'x0'))
                    val = self._gtext(right_tokens[0]).strip()
                    val = re.split(r'[:：]', val)[0].strip()
                    if val and len(val) <= 10:
                        return val
        return ''

    # ═══════════════════════════════════════════════════
    # Token 辅助方法
    # ═══════════════════════════════════════════════════

    @staticmethod
    def _gtext(t):
        if isinstance(t, dict):
            return t.get('text', '')
        return getattr(t, 'text', '')

    @staticmethod
    def _gattr(t, key, default=0):
        if isinstance(t, dict):
            return t.get(key, default)
        return getattr(t, key, default)

    @staticmethod
    def _gcx(t):
        if isinstance(t, dict):
            return (t.get('x0', 0) + t.get('x1', 0)) / 2
        return (getattr(t, 'x0', 0) + getattr(t, 'x1', 0)) / 2

    @staticmethod
    def _gcy(t):
        if isinstance(t, dict):
            return (t.get('y0', 0) + t.get('y1', 0)) / 2
        return (getattr(t, 'y0', 0) + getattr(t, 'y1', 0)) / 2

    # ─── 备注（可能多行） ───
    def _extract_note(self, doc: OCRDocument) -> str:
        # [FIX] 备注是自由文本字段，不施加数字密度过滤
        # 1. 标准 regex 匹配（collapsed）
        m = _NOTE_RE.search(doc.collapsed)
        if m:
            raw = m.group(1).strip()
            raw = self._truncate_at_field_keyword(raw)
            if len(raw) > 200:
                raw = raw[:200]
            return raw

        # 2. 逐行搜索（带冒号的备注）
        for i, line in enumerate(doc.lines):
            m = _NOTE_RE.search(line)
            if m:
                parts = [m.group(1).strip()]
                for j in range(i + 1, min(len(doc.lines), i + 6)):
                    next_line = doc.lines[j].strip()
                    if not next_line:
                        break
                    if self._is_note_boundary(next_line):
                        break
                    parts.append(next_line)
                result = '\n'.join(p for p in parts if p)
                if len(result) > 200:
                    result = result[:200]
                if result:
                    return result
                break

        # 3. 全电发票：合并后的 "备注" 无冒号，从后续行搜索内容
        result = self._extract_note_no_colon(doc.lines)
        if result:
            return result

        # [FIX-3] 4. 全电发票：备注内容出现在发票标题之前（header region）
        result = self._extract_note_from_header_region(doc)
        if result:
            return result

        # 5. 全电发票 footer 区域备注搜索
        result = self._extract_note_from_footer(doc.lines)
        if result:
            return result

        return ''

    # [FIX-2] ─── 全电发票：标题之前的备注内容提取 ───
    def _extract_note_from_header_region(self, doc: OCRDocument) -> str:
        """全电发票：提取出现在发票标题之前的备注内容。

        某些全电发票的 OCR 布局中，备注内容出现在文档最前面
        （"电子发票"标题之前），而非"备注"标签旁边。

        策略：
        1. 找到"电子发票"或"增值税"标题行
        2. 收集标题之前的所有非空行
        3. 用 _truncate_at_field_keyword 截断（去除尾部的"收款人:xxx"等）
        4. 验证内容是否像备注（包含订单号、购方/销方等关键词）
        """
        lines = doc.lines
        if not lines:
            return ''

        # 找到发票标题行
        header_idx = -1
        for i, line in enumerate(lines):
            stripped = line.strip()
            if re.search(r'电子发票|增值税', stripped):
                header_idx = i
                break

        if header_idx <= 0:
            return ''

        # 收集标题之前的所有非空行
        parts = []
        for i in range(header_idx):
            line = lines[i].strip()
            if not line:
                continue
            if len(line) < 3:
                continue
            parts.append(line)

        if not parts:
            return ''

        result = '\n'.join(parts)

        # 截断到字段关键词（如"收款人"、"复核人"等）
        result = self._truncate_at_field_keyword(result)

        if len(result) > 200:
            result = result[:200]

        # 最短长度检查
        if len(result.strip()) < _NOTE_MIN_LENGTH:
            return ''

        # 验证这看起来像备注内容
        if not self._looks_like_note_content(result):
            logger.debug("[Misc] Header region content doesn't look like note: '%s'",
                         result[:60])
            return ''

        logger.debug("[Misc] Found note in header region: '%s'", result[:80])
        return result

    def _looks_like_note_content(self, text: str) -> bool:
        """判断文本是否像备注内容（包含订单号、购方/销方信息等）"""
        for pattern in _NOTE_CONTENT_INDICATORS:
            if re.search(pattern, text):
                return True
        return False

    def _extract_note_no_colon(self, lines: list) -> str:
        """处理全电发票中合并后的 '备注' 关键词（无冒号）。

        用「结构化边界检测」替代「内容排除法」。
        备注内容是开放的（可包含公司名、银行名、电话、地址等），
        排除法会误杀合法内容。改为：找到"备注"标签后，收集后续行
        直到遇到结构化边界（行首为已知字段标签）。
        """
        note_idx = -1
        note_inline = ''
        for i, line in enumerate(lines):
            stripped = line.strip()
            # 精确匹配 "备注"
            if stripped == '备注':
                note_idx = i
                break
            # [FIX-1] 竖排文字："备" + "注" → note_idx 指向"注"行
            # 修复前: note_idx = i（指向"备"），搜索从 i+1("注") 开始，
            #         "注"被收集为备注内容
            # 修复后: note_idx = i+1（指向"注"），搜索从 i+2 开始，
            #         跳过标签碎片
            if stripped == '备' and i + 1 < len(lines) and lines[i + 1].strip() == '注':
                note_idx = i + 1
                break
            # "备注" 后跟内容但无冒号的情况（同一行）
            m = re.match(r'^\s*备注\s+(.+)', stripped)
            if m and not re.search(r'[:：]', stripped[:6]):
                note_inline = m.group(1).strip()
                note_idx = i
                break

        if note_idx < 0:
            logger.debug("[Misc] _extract_note_no_colon: no '备注' keyword found")
            return ''

        logger.debug("[Misc] _extract_note_no_colon: note_idx=%d", note_idx)

        # 如果"备注"同一行有内容，直接返回
        if note_inline:
            if not self._is_note_boundary(note_inline) and len(note_inline) > 2:
                logger.debug("[Misc] _extract_note_no_colon: inline content: '%s'",
                             note_inline[:60])
                return note_inline[:200] if len(note_inline) > 200 else note_inline

        # 向后搜索备注内容
        parts = []
        for j in range(note_idx + 1, min(len(lines), note_idx + 15)):
            line = lines[j].strip()
            if not line:
                continue

            logger.debug("[Misc] _extract_note_no_colon: checking line %d: '%s'", j, line)

            # ── 结构化边界：行首为已知字段标签 → 停止 ──
            if self._is_note_boundary(line):
                logger.debug("[Misc] boundary reached: '%s'", line[:40])
                break

            # ── 跳过金额行 ──
            if re.match(r'^\s*[¥￥]', line) or re.match(r'^[-]?\d[\d,.]*\.\d{2}$', line):
                logger.debug("[Misc] skipped amount line")
                continue
            if re.match(r'^\s*[零壹贰叁肆伍陆柒捌玖拾佰仟万亿元角分整圆]+\s*$', line):
                logger.debug("[Misc] skipped Chinese amount")
                continue
            if re.search(r'[（(]\s*小写\s*[）)]', line):
                logger.debug("[Misc] skipped (小写) marker")
                continue

            # ── 遇到明细行停止 ──
            if re.search(r'\*[^*]+\*', line):
                logger.debug("[Misc] stopped at line item: '%s'", line[:40])
                break

            # ── 收集为备注内容 ──
            if len(line) <= 200:
                parts.append(line)
                logger.debug("[Misc] added to note: '%s'", line[:60])

        if parts:
            result = '\n'.join(parts)
            # [FIX-5] 最短长度检查：避免返回标签碎片（如单个"注"字）
            if len(result.strip()) < _NOTE_MIN_LENGTH:
                logger.debug("[Misc] _extract_note_no_colon: result too short, ignoring: '%s'",
                             result)
                return ''
            logger.debug("[Misc] _extract_note_no_colon result: '%s'", result[:100])
            return result

        logger.debug("[Misc] _extract_note_no_colon: no content found")
        return ''

    def _extract_note_from_footer(self, lines: list) -> str:
        """从 footer 区域搜索备注内容（最后回退方案）。

        [FIX-6] 使用 _find_footer_start 确定 footer 起始位置，
        仅搜索最后一个金额行之后的行。

        修复前：搜索"后20行"，范围可能延伸到明细区域，
        导致产品名续行（如"动断电家用电热水壶烧水"）被误拾为备注。
        修复后：仅搜索 footer_start 之后的行，确保不会误拾明细内容。
        """
        footer_start = self._find_footer_start(lines)
        if footer_start <= 0:
            # 未找到金额行，回退到搜索最后 20 行
            footer_start = max(0, len(lines) - 20)

        for j in range(len(lines) - 1, footer_start - 1, -1):
            line = lines[j].strip()
            if not line:
                continue

            logger.debug("[Misc] _extract_note_from_footer: checking line %d: '%s'", j, line)

            # ── 跳过过短的行 ──
            if len(line) < 3:
                continue

            # 字段标签行：行首锚定
            if re.match(r'^\s*(开票人|收款人|复核人|发票号码|发票代码|开票日期)\s*[:：]', line):
                continue

            # ── 跳过价税合计 / 合计 ──
            if re.match(r'^\s*(价税合计|合\s*计)\b', line):
                continue
            if re.search(r'价税合计', line):
                continue

            if re.search(r'[（(]\s*小写\s*[）)]', line):
                logger.debug("[Misc] skipped (小写) marker: '%s'", line)
                continue

            # ── 跳过发票标题 ──
            if re.search(r'电[子子]发票', line):
                continue
            if re.search(r'增值税', line):
                continue

            # ── 跳过短标签行（以冒号结尾的短文本） ──
            if re.search(r'[:：]$', line) and len(line) < 15:
                continue

            # ── 跳过价格行 ──
            if re.match(r'^[¥￥]', line) or re.match(r'^[-]?\d[\d,.]*\.\d{2}$', line):
                continue
            if re.match(r'^\s*[零壹贰叁肆伍陆柒捌玖拾佰仟万亿元角分整圆]+\s*$', line):
                continue

            # ── 跳过日期 ──
            if re.match(r'^\d{4}[-/年]', line):
                continue

            # ── 跳过百分比税率 ──
            if re.match(r'^\d+%$', line):
                continue

            # ── 跳过独立人名 ──
            if _PERSON_NAME_RE.match(line) or self._clean_person_name(line):
                continue

            # ── 跳过独立税号 ──
            if re.match(r'^[0-9A-Za-z]{15,20}$', line):
                continue

            # ── 跳过纯数字（发票号码等） ──
            if re.match(r'^\d{8,20}$', line):
                continue

            # ── 跳过短纯数字（数量） ──
            if re.match(r'^\d{1,5}$', line):
                continue

            # ── 跳过高精度小数（单价） ──
            if re.match(r'^\d+\.\d{5,}$', line):
                continue

            # ── 跳过税务机关噪声 ──
            if self._is_gov_noise(line):
                continue

            # ── 跳过下载次数 ──
            if re.match(r'下载次数', line):
                continue

            # ── 跳过明细行（继续向前搜索） ──
            if re.search(r'\*[^*]+\*', line):
                continue

            # [FIX] 备注是自由文本字段，不施加数字密度过滤
            # ── 剩下的可能是备注内容 ──
            if len(line) <= 200:
                # [FIX-5] 最短长度检查
                if len(line.strip()) < _NOTE_MIN_LENGTH:
                    continue
                logger.debug("[Misc] Footer note found: '%s'", line[:50])
                return line

        logger.debug("[Misc] _extract_note_from_footer: no content found")
        return ''

    # ─── 结构化边界检测 ───

    _NOTE_BOUNDARY_PATTERNS = [
        r'^\s*开票人\s*[:：]',
        r'^\s*复核人\s*[:：]',
        r'^\s*收款人\s*[:：]',
        r'^\s*发票号码\s*[:：]',
        r'^\s*发票代码\s*[:：]',
        r'^\s*开票日期\s*[:：]',
        r'^\s*价税合计',
        r'^\s*合\s*计\s',
        r'^\s*购买方信息',
        r'^\s*销售方信息',
        r'^\s*购买方\s',
        r'^\s*销售方\s',
        r'^\s*电子发票',
        r'^\s*增值税',
        r'^\s*项目名称',
        r'^\s*规格型号',
        r'^\s*统一社会信用代码',
        r'^\s*纳税人识别号',
        r'^\s*名\s*称\s*[:：]',
        r'^\s*单价',
        r'^\s*金额',
        r'^\s*税率',
        r'^\s*税额',
        r'^\s*单位$',
        r'^\s*数\s*量',
    ]

    def _is_note_boundary(self, line: str) -> bool:
        """判断行是否为备注内容的结构化边界。"""
        for pattern in self._NOTE_BOUNDARY_PATTERNS:
            if re.match(pattern, line):
                return True
        return False

    # ─── 收款人 ───
    def _extract_payee(self, doc: OCRDocument) -> str:
        m = _PAYEE_RE.search(doc.collapsed)
        if m:
            val = self._clean_person_name(m.group(1))
            if val:
                return val
        result = self._extract_person_by_line(doc.lines, _PAYEE_RE)
        if result:
            return result
        return self._search_person_after_label(doc.lines, r'收款人[:：]')

    # ─── 复核人 ───
    def _extract_reviewer(self, doc: OCRDocument) -> str:
        for regex in (_REVIEWER_RE2, _REVIEWER_RE):
            m = regex.search(doc.collapsed)
            if m:
                val = self._clean_person_name(m.group(1))
                if val:
                    return val
        for regex in (_REVIEWER_RE2, _REVIEWER_RE):
            result = self._extract_person_by_line(doc.lines, regex)
            if result:
                return result
        return self._search_person_after_label(doc.lines, r'复核人?[:：]')

    # ─── 开票人 ───
    def _extract_issuer(self, doc: OCRDocument) -> str:
        result = self._extract_person_by_line(doc.lines, _ISSUER_RE)
        if result:
            return result
        result = self._search_person_after_label(doc.lines, r'开\s*票\s*人[:：]')
        if result:
            return result
        m = _ISSUER_RE.search(doc.collapsed)
        if m:
            val = self._clean_person_name(m.group(1))
            if val:
                return val
        return ''

    # ─── 工具方法 ───
    @staticmethod
    def _clean_misc_text(text: str) -> str:
        if not text:
            return ''
        # [FIX-4] 修正正则：原 $$$$ 是行尾锚点（永远不匹配），改为 $$ $$ 匹配字面括号
        text = re.sub(r'$$(?:BUYER|SELLER)_(?:START|END)$$', ' ', str(text))
        text = re.sub(r'__AUX_[A-Za-z0-9_]+__', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        return '' if text in {'BUYER_START', 'BUYER_END', 'SELLER_START', 'SELLER_END'} else text

    _NOT_PERSON_NAMES = {
        '销售方信息', '购买方信息', '销方信息', '购方信息',
        '销售方', '购买方', '销方', '购方',
        '备注', '合计', '价税合计',
        '发票号码', '发票代码', '开票日期',
        '项目名称', '规格型号', '密码区',
        '单位', '数量', '单价', '金额', '税率', '税额',
        '征收率', '旅客运输服务', '餐饮服务', '运输服务', '服务费',
        '名称', '下载次数', '备注', '开票人', '收款人', '复核人',
        '价税合计', '合计', '小写', '大写',
    }

    _GOV_NOISE_KEYWORDS = (
        '税务', '国家', '监制', '省税务', '市税务', '区税务',
        '发票监制', '统一发票', '国家税务总局',
    )

    def _search_person_after_label(self, lines: list, label_pattern: str) -> str:
        """在标签行之后搜索人名（全电发票中标签和人名在不同行）。"""
        label_line = -1
        for i, line in enumerate(lines):
            if re.search(label_pattern, line):
                label_line = i
                break

        if label_line < 0:
            return ''

        footer_start = self._find_footer_start(lines)

        search_start = max(label_line + 1, footer_start)
        for j in range(search_start, min(len(lines), search_start + 20)):
            line = lines[j].strip()
            if not line:
                continue
            if re.match(r'(收款人|复核人|开票人)[:：]', line):
                if not re.search(label_pattern, line):
                    break
            if MiscExtractor._is_bad_person_candidate(line):
                continue
            name = self._clean_person_name(line)
            if name:
                return name

        if footer_start > label_line + 1:
            for j in range(label_line + 1, min(footer_start, label_line + 50)):
                line = lines[j].strip()
                if not line:
                    continue
                if MiscExtractor._is_bad_person_candidate(line):
                    continue
                name = self._clean_person_name(line)
                if name:
                    return name

        return ''

    @staticmethod
    def _find_footer_start(lines: list) -> int:
        """找到 footer 区域的起始行索引。

        优先找价税合计区域（含"大写"/"小写"/"价税合计"的行），
        回退到最后一个金额行。
        """
        # ── 优先：价税合计区域 ──
        jshj_last = -1
        for i, line in enumerate(lines):
            stripped = line.strip()
            if ('大写' in stripped or '小写' in stripped
                    or '价税合计' in stripped):
                jshj_last = i

        if jshj_last >= 0:
            return jshj_last + 1

        # ── 回退：最后一个金额行 ──
        last_amount = -1
        for i, line in enumerate(lines):
            stripped = line.strip()
            if (re.match(r'^[¥￥]', stripped)
                    or re.match(r'^[\d,]+\.\d{2}$', stripped)
                    or re.match(r'^[-]\d+\.\d{2}$', stripped)
                    or re.search(r'[（(]\s*小写\s*[）)]', stripped)):
                last_amount = i
        return last_amount + 1 if last_amount >= 0 else 0

    def _extract_person_by_line(self, lines: list, regex) -> str:
        """逐行搜索人名字段"""
        for line in lines:
            m = regex.search(line)
            if m:
                raw_value = m.group(1).strip()
                val = self._extract_person_from_value(raw_value)
                if val:
                    return val
        return ''

    def _extract_person_from_value(self, raw: str) -> str:
        """从原始值中提取人名"""
        if not raw:
            return ''

        separators = ['|', '：', ':', '；', ';', '。', '、', '，', ',']
        for sep in separators:
            idx = raw.find(sep)
            if idx != -1:
                raw = raw[:idx].strip()

        field_keywords = ['收款人', '复核人', '开票人', '备注', '金额', '税额']
        for kw in field_keywords:
            idx = raw.find(kw)
            if idx != -1:
                raw = raw[:idx].strip()

        return self._clean_person_name(raw)

    @staticmethod
    def _is_gov_noise(text: str) -> bool:
        for kw in MiscExtractor._GOV_NOISE_KEYWORDS:
            if kw in text:
                return True
        return False

    @staticmethod
    def _is_bad_person_candidate(text: str) -> bool:
        if not text or not isinstance(text, str):
            return True
        t = text.strip()
        if not t:
            return True
        if t in MiscExtractor._NOT_PERSON_NAMES:
            return True
        if MiscExtractor._is_gov_noise_static(t):
            return True
        if re.match(r'.+[:：]$', t):
            return True
        return False

    @staticmethod
    def _is_gov_noise_static(text: str) -> bool:
        for kw in MiscExtractor._GOV_NOISE_KEYWORDS:
            if kw in text:
                return True
        return False

    @staticmethod
    def _clean_person_name(raw: str) -> str:
        if not raw:
            return ''
        if MiscExtractor._is_bad_person_candidate(raw):
            logger.debug("[Misc] 被统一排除规则丢弃: '%s'", raw[:20])
            return ''
        name = raw.strip().replace(' ', '')

        if len(name) > 10:
            logger.debug("[Misc] 人名过长，丢弃: '%s'", name[:20])
            return ''

        if re.search(r'[:：；;，,。、|/\\]', name):
            logger.debug("[Misc] 人名含标点，丢弃: '%s'", name[:20])
            return ''

        if name.isdigit():
            logger.debug("[Misc] 纯数字不是人名，丢弃: '%s'", name)
            return ''

        if re.match(r'^[零壹贰叁肆伍陆柒捌玖拾佰仟万亿元角分整圆]+$', name):
            logger.debug("[Misc] 中文大写金额，丢弃: '%s'", name)
            return ''

        if _PERSON_NAME_RE.match(name):
            return name
        if 2 <= len(name) <= 6 and re.match(r'^[\u4e00-\u9fa5·]+$', name):
            return name

        logger.debug("[Misc] 人名校验不通过，丢弃: '%s'", name)
        return ''

    @staticmethod
    def _truncate_at_field_keyword(text: str) -> str:
        field_keywords = [
            r'收款人', r'复核人', r'开票人',
            r'销售方', r'购买方', r'价税合计',
            r'发票代码', r'发票号码',
        ]
        for kw in field_keywords:
            idx = re.search(kw, text)
            if idx and idx.start() > 0:
                return text[:idx.start()].strip()
        return text.strip()

    @staticmethod
    def _is_field_keyword(line: str) -> bool:
        return bool(re.match(
            r'(收款人|复核人|开票人|销售方|购买方|价税合计|发票代码|发票号码)',
            line.strip()
        ))

    @staticmethod
    def _has_too_many_digits(text: str, threshold: float = 0.6) -> bool:
        if not text:
            return False
        # [FIX] 含连字符的编号（如 260202-271738508940940）不视为纯数字噪声
        if re.search(r'\d+-\d+', text):
            return False
        digit_count = sum(1 for c in text if c.isdigit())
        digit_ratio = digit_count / len(text)
        return digit_ratio > threshold
