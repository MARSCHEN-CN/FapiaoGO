"""
OCR 文本规范化与数字纠错
"""
import re
from .models import OCRDocument, Token, Line


# ============================
# 预编译正则（避免每次调用重新编译）
# ============================

# normalize()
_RE_WHITESPACE = re.compile(r'\s+')

# _normalize_invoice_keywords()
_RE_FA_PIAO = re.compile(r"发\s*票")
_RE_PIAO_JU = re.compile(r"票\s*据")
_RE_SHUI_E = re.compile(r"税\s*额")
_RE_JIN_E = re.compile(r"金\s*额")

# _fix_ocr_text() — 发票代码/号码/票据号码（带 lambda 回调）
_RE_FPHM_DIGITS = re.compile(r'(发票号码[:：])\s*([0-9OIol]+)')
_RE_PJHM_DIGITS = re.compile(r'(票据号码[:：])\s*([0-9OIol]+)')

# _fix_ocr_text() — 日期 O→0
_RE_DATE_OI_BEFORE_YEAR1 = re.compile(r'(?<=\D)[OI](?=\d{1,3}年)')
_RE_DATE_OI_BEFORE_YEAR2 = re.compile(r'(?<=\d)[OI](?=\d年)')
_RE_DATE_OI_BEFORE_MONTH = re.compile(r'(?<=年)[OI](?=\d月)')
_RE_DATE_OI_BEFORE_DAY = re.compile(r'(?<=月)[OI](?=\d[日号])')
_RE_DATE_OI_AFTER_DIGIT_DASH = re.compile(r'(?<=\d)[OI](?=-\d)')
_RE_DATE_OI_AFTER_DASH = re.compile(r'(?<=-)[OI](?=\d)')

# _fix_ocr_text() — 金额上下文 O→0（循环内 14 个）
_RE_AMT_DIGIT_OI_DIGIT = re.compile(r'(?<=[0-9])[OI](?=[0-9])')
_RE_AMT_YEN_OI_DIGIT = re.compile(r'(?<=[¥￥])[OI](?=[0-9])')
_RE_AMT_DIGIT_OI_DOT = re.compile(r'(?<=[0-9])[OI](?=\.)')
_RE_AMT_DOT_OI_DIGIT = re.compile(r'(?<=\.)[OI](?=[0-9])')
_RE_AMT_DOTD_OI_END = re.compile(r'(?<=\.\d)[OI](?=[^0-9A-Za-zOI]|$)')
_RE_AMT_DOTD0_OI_END = re.compile(r'(?<=\.\d0)[OI](?=[^0-9A-Za-zOI]|$)')
_RE_AMT_DOT00_OI_END = re.compile(r'(?<=\.00)[OI](?=[^0-9A-Za-zOI]|$)')
_RE_AMT_DIGIT_OI_COMMA = re.compile(r'(?<=[0-9])[OI](?=[,，\s])')
_RE_AMT_COMMA_OI_DIGIT = re.compile(r'(?<=[,，])[OI](?=[0-9])')
_RE_AMT_COLON_OI_DOT = re.compile(r'(?<=[:：])[OI](?=\.)')
_RE_AMT_COLON_OI_DIGIT = re.compile(r'(?<=[:：])[OI](?=[0-9])')
_RE_AMT_SPACE_OI_DIGIT = re.compile(r'(?<=\s)[OI](?=[\d.])')
_RE_AMT_DOT_O_O_END = re.compile(r'(?<=\.)O(?=O[^0-9A-Za-z]|O$)')

# 循环内模式打包为元组，方便迭代
_AMT_OI_PATTERNS = (
    _RE_AMT_DIGIT_OI_DIGIT,
    _RE_AMT_YEN_OI_DIGIT,
    _RE_AMT_DIGIT_OI_DOT,
    _RE_AMT_DOT_OI_DIGIT,
    _RE_AMT_DOTD_OI_END,
    _RE_AMT_DOTD0_OI_END,
    _RE_AMT_DOT00_OI_END,
    _RE_AMT_DIGIT_OI_COMMA,
    _RE_AMT_COMMA_OI_DIGIT,
    _RE_AMT_COLON_OI_DOT,
    _RE_AMT_COLON_OI_DIGIT,
    _RE_AMT_SPACE_OI_DIGIT,
    _RE_AMT_DOT_O_O_END,
)

# _fix_ocr_text() — 税号纠错
_RE_TAX_ID = re.compile(r'(纳税人识别号[:：])\s*([0-9A-Za-zOI]+)')

# CompanyNameCleaner
_RE_CJK_SPACE = re.compile(r'([\u4e00-\u9fff])\s+([\u4e00-\u9fff])')


# 已知垂直文字短语（OCR 逐字分行时，将这些单字行合并为一行）
_VERTICAL_PHRASES = [
    '购买方信息', '销售方信息',
    '购方信息', '销方信息',
    '购买方', '销售方',
    '收款人', '复核人', '开票人',
    '备注', '合计', '价税合计',
    '发票代码', '发票号码', '开票日期',
    '密码区',
    # 明细表头字段
    '项目名称', '规格型号',
    '数量', '单价', '金额', '税率', '税额', '单位', '征收率',
    # 监制章
    '全国统一发票监制章', '广东省税务局',
]

# 需要跨行配对的2字短语（非连续但距离较近的孤立单字）
_PAIR_PHRASES = ['备注', '合计']


class TextNormalizer:
    """OCR 文本预处理与数字纠错"""

    # ─── 数字纠错辅助 ───
    @staticmethod
    def _replace_ocr_digits(s: str) -> str:
        """纯数字上下文：O→0, I/l→1"""
        result = []
        for ch in s:
            if ch in ('O', 'o'):
                result.append('0')
            elif ch in ('I', 'l'):
                result.append('1')
            else:
                result.append(ch)
        return ''.join(result)

    @staticmethod
    def _replace_ocr_tax_digits(s: str) -> str:
        """税号纠错：O→0（税号中不会出现O）"""
        return s.replace('O', '0')

    # ─── 主入口 ───
    def normalize(self, text: str, bbox_data: list = None) -> OCRDocument:
        """规范化 OCR 文本并返回 OCRDocument"""
        if not text:
            return OCRDocument('')

        # 统一换行符
        text = text.replace("\r\n", "\n").replace("\r", "\n")

        # 关键词合并（从 TextCleaner 移入）
        text = self._normalize_invoice_keywords(text)

        # 全角/半角统一
        clean = text.replace('：', ':')
        normalized = _RE_WHITESPACE.sub(' ', clean)

        # OCR 数字纠错
        normalized = self._fix_ocr_text(normalized)

        # 构建 OCRDocument
        lines = [l.strip() for l in normalized.split('\n') if l.strip()]

        # [FIX] 先拆分竖排尾字+横排标签合并行，再合并垂直文字
        # 这样拆出的单字"息"才能被合并进"购买方信息"
        lines = self._split_merged_text_lines(lines)

        # 合并垂直文字（连续单字行 → 已知短语）
        lines = self._merge_vertical_text(lines)

        collapsed = ' '.join(lines)

        # 构建统一的 Token 列表
        tokens = self._build_tokens(bbox_data) if bbox_data else []

        # 结构化 Lines（从 Token 列表构建）
        structured_lines = self._build_structured_lines(tokens, lines) if tokens else []

        return OCRDocument(
            raw=text,
            collapsed=collapsed,
            lines=lines,                  # 兼容
            structured_lines=structured_lines,  # 新增
            tokens=tokens,                # 统一 token 列表
            bbox_tokens=tokens,           # 兼容：bbox_tokens 与 tokens 指向同一数据
        )

    @staticmethod
    def _normalize_invoice_keywords(text: str) -> str:
        """合并发票关键词中的空白（从 TextCleaner 移入）"""
        text = _RE_FA_PIAO.sub("发票", text)
        text = _RE_PIAO_JU.sub("票据", text)
        text = _RE_SHUI_E.sub("税额", text)
        text = _RE_JIN_E.sub("金额", text)
        return text

    @staticmethod
    def _build_tokens(bbox_data: list) -> list:
        """将 OCR 引擎返回的 bbox 数据转换为 Token 列表。

        PaddleOCR box 格式: [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
        转换为轴对齐包围盒: (min_x, min_y, max_x, max_y)
        """
        tokens = []
        for item in bbox_data:
            if not item or 'box' not in item or 'text' not in item:
                continue
            box = item['box']
            text = item['text']
            if not text or not box or len(box) < 4:
                continue
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            tokens.append(Token(
                text=text,
                x0=min(xs),
                y0=min(ys),
                x1=max(xs),
                y1=max(ys),
                page=0,
                confidence=1.0,
            ))

        # [FIX] 拆分竖排尾字+横排标签的合并token
        # 如 "息统一社会信用代码/纳税人识别号：" → "息" + "统一社会信用代码/纳税人识别号："
        return TextNormalizer._split_merged_vertical_tokens(tokens)

    # [FIX] 已知横排标签前缀（竖排尾字可能被吞并的标签）
    _HORIZONTAL_LABEL_PREFIXES = [
        '统一社会信用代码/纳税人识别号：',
        '统一社会信用代码/纳税人识别号:',
        '纳税人识别号：', '纳税人识别号:',
        '统一社会信用代码：', '统一社会信用代码:',
    ]

    @classmethod
    def _split_merged_vertical_tokens(cls, tokens: list) -> list:
        """拆分竖排尾字被横排标签吞并的token。

        PDF文本提取中，竖排"购买方信息"的最后一个字"息"的y坐标
        与横排"统一社会信用代码/纳税人识别号："重叠，导致两者被合并
        为一个token。本方法检测并拆分这种合并token。

        拆分策略：
        1. 检测token文本是否以单个中文字符开头+已知横排标签
        2. 是则拆分为两个token，按标签出现位置分配bbox坐标
        """
        result = []
        for t in tokens:
            text = t.text.strip()
            split_done = False
            for prefix in cls._HORIZONTAL_LABEL_PREFIXES:
                if text.startswith(prefix):
                    # 不应该以标签开头（标签不应有前缀竖排字）
                    continue
                if len(text) > len(prefix) and prefix in text:
                    idx = text.index(prefix)
                    leading = text[:idx]
                    # 仅拆分：前缀是单个中文字符
                    if (len(leading) == 1
                            and '\u4e00' <= leading <= '\u9fff'):
                        # 计算拆分点的x坐标
                        total_w = t.width
                        label_ratio = len(prefix) / len(text)
                        split_x = t.x + total_w * (1 - label_ratio)
                        # 前缀token（竖排字）
                        result.append(Token(
                            text=leading,
                            x0=t.x, y0=t.y,
                            x1=split_x, y1=t.y1,
                            page=0, confidence=1.0,
                        ))
                        # 标签token
                        result.append(Token(
                            text=prefix,
                            x0=split_x, y0=t.y,
                            x1=t.x1, y1=t.y1,
                            page=0, confidence=1.0,
                        ))
                        split_done = True
                        break
            if not split_done:
                result.append(t)
        return result

    @staticmethod
    def _build_structured_lines(tokens: list, text_lines: list) -> list:
        """将 tokens 按 y 坐标聚类为 Line 对象列表。

        算法：
        1. 按 cy 排序所有 tokens
        2. 用自适应阈值（中位行高的 60%）将 tokens 聚类为行
        3. 每行内按 x0 排序，拼接文本
        4. 计算每行的包围盒
        """
        if not tokens:
            return []

        # 按 cy 排序
        sorted_tokens = sorted(tokens, key=lambda t: t.cy)

        # 估算中位行高
        heights = sorted([t.height for t in sorted_tokens])
        median_h = heights[len(heights) // 2] if heights else 10
        threshold = max(median_h * 0.6, 3)

        # 聚类为行
        clusters = []  # List[List[Token]]
        current_cluster = [sorted_tokens[0]]
        current_cy = sorted_tokens[0].cy

        for token in sorted_tokens[1:]:
            if abs(token.cy - current_cy) <= threshold:
                current_cluster.append(token)
            else:
                clusters.append(current_cluster)
                current_cluster = [token]
                current_cy = token.cy
        if current_cluster:
            clusters.append(current_cluster)

        # 构建 Line 对象
        result = []
        for cluster in clusters:
            # 行内按 x 坐标排序
            cluster.sort(key=lambda t: t.x)

            # [PERF] 一次性遍历计算所有值，避免多次迭代
            texts = []
            tokens = []
            min_x, min_y = float('inf'), float('inf')
            max_x1, max_y1 = float('-inf'), float('-inf')

            for t in cluster:
                texts.append(t.text)
                tokens.append(Token(text=t.text, x0=t.x, y0=t.y, x1=t.x1, y1=t.y1))
                if t.x < min_x:
                    min_x = t.x
                if t.y < min_y:
                    min_y = t.y
                if t.x1 > max_x1:
                    max_x1 = t.x1
                if t.y1 > max_y1:
                    max_y1 = t.y1

            text = ' '.join(texts)
            line = Line(
                text=text,
                tokens=tokens,
                x0=min_x,
                y0=min_y,
                x1=max_x1,
                y1=max_y1,
            )
            result.append(line)

        return result

    # ─── 垂直文字合并 ───
    @staticmethod
    def _merge_vertical_text(lines: list) -> list:
        """合并 OCR 产生的垂直文字（逐字分行 → 已知短语）。

        全电发票中，"销售方信息" 等垂直标签被 OCR 逐字分行输出。
        本方法将连续的短行（≤2字）合并为已知短语，
        并对非连续但距离较近的孤立单字进行配对合并。
        """
        if not lines:
            return lines

        # Pass 1: 合并连续短行形成已知短语
        sorted_phrases = sorted(_VERTICAL_PHRASES, key=len, reverse=True)
        result = []
        i = 0
        while i < len(lines):
            merged = False
            for phrase in sorted_phrases:
                plen = len(phrase)
                if i + plen > len(lines):
                    continue
                # 所有待合并行必须都是短行（≤2字）
                if all(len(lines[i + j].strip()) <= 2 for j in range(plen)):
                    candidate = ''.join(lines[i + j].strip() for j in range(plen))
                    if candidate == phrase:
                        result.append(phrase)
                        i += plen
                        merged = True
                        break
            if not merged:
                result.append(lines[i])
                i += 1

        # Pass 2: 配对非连续孤立单字（如 "备"..."注" → "备注"）
        merged_indices = set()
        result2 = []
        for i in range(len(result)):
            if i in merged_indices:
                continue
            line = result[i].strip()
            if len(line) == 1 and '\u4e00' <= line <= '\u9fff':
                paired = False
                for phrase in _PAIR_PHRASES:
                    if phrase[0] == line:
                        for j in range(i + 1, min(i + 8, len(result))):
                            if j in merged_indices:
                                continue
                            if result[j].strip() == phrase[1] and len(result[j].strip()) == 1:
                                result2.append(phrase)
                                merged_indices.add(i)
                                merged_indices.add(j)
                                paired = True
                                break
                if not paired:
                    result2.append(result[i])
            else:
                result2.append(result[i])

        # [FIX] Pass 3: 已合并词+后续单字 → 已知短语
        # 如 "购买方" + "息" → "购买方信息"
        # Pass 1 只合并连续≤2字行，已合并的词（如"购买方"=3字）不会被处理。
        # 本步骤检测已合并词是否可以与后续单字组合成已知短语。
        result3 = []
        i = 0
        while i < len(result2):
            line = result2[i].strip()
            merged_in_pass3 = False
            if line and len(line) >= 2:
                for phrase in sorted_phrases:
                    if phrase.startswith(line) and phrase != line:
                        needed = phrase[len(line):]
                        # 检查后续行是否正好是所需的剩余字符
                        remaining_lines = ''.join(
                            result2[j].strip()
                            for j in range(i + 1, min(i + len(needed) + 1, len(result2)))
                        )
                        if remaining_lines.startswith(needed):
                            result3.append(phrase)
                            # 跳过消耗的后续行
                            skip = 0
                            for j in range(i + 1, min(i + len(needed) + 1, len(result2))):
                                if remaining_lines.startswith(needed[:skip + len(result2[j].strip())]):
                                    skip += 1
                                else:
                                    break
                            i += 1 + skip
                            merged_in_pass3 = True
                            break
            if not merged_in_pass3:
                result3.append(result2[i])
                i += 1

        return result3

    # ─── 拆分竖排尾字+横排标签合并行 ───
    @classmethod
    def _split_merged_text_lines(cls, lines: list) -> list:
        """拆分竖排尾字被横排标签吞并的文本行。

        如 "息统一社会信用代码/纳税人识别号：" → "息" + "统一社会信用代码/纳税人识别号："
        与 _split_merged_vertical_tokens 逻辑一致，作用于文本行。
        """
        result = []
        for line in lines:
            stripped = line.strip()
            split_done = False
            for prefix in cls._HORIZONTAL_LABEL_PREFIXES:
                if stripped.startswith(prefix) or len(stripped) <= len(prefix):
                    continue
                if prefix in stripped:
                    idx = stripped.index(prefix)
                    leading = stripped[:idx]
                    if (len(leading) == 1
                            and '\u4e00' <= leading <= '\u9fff'):
                        result.append(leading)
                        result.append(prefix)
                        split_done = True
                        break
            if not split_done:
                result.append(line)
        return result

    # ─── OCR 数字纠错 ───
    def _fix_ocr_text(self, text: str) -> str:
        """修复 OCR 常见数字识别错误（O→0, I→1）"""
        if not text:
            return text

        # 1. 发票号码/票据号码
        text = _RE_FPHM_DIGITS.sub(
            lambda m: m.group(1) + self._replace_ocr_digits(m.group(2)), text)
        text = _RE_PJHM_DIGITS.sub(
            lambda m: m.group(1) + self._replace_ocr_digits(m.group(2)), text)

        # 2. 日期 O→0
        text = _RE_DATE_OI_BEFORE_YEAR1.sub('0', text)
        text = _RE_DATE_OI_BEFORE_YEAR2.sub('0', text)
        text = _RE_DATE_OI_BEFORE_MONTH.sub('0', text)
        text = _RE_DATE_OI_BEFORE_DAY.sub('0', text)
        text = _RE_DATE_OI_AFTER_DIGIT_DASH.sub('0', text)
        text = _RE_DATE_OI_AFTER_DASH.sub('0', text)

        # 3. 金额上下文 O→0（多轮扫描确保收敛，实际 1-2 轮即稳定）
        for _ in range(3):
            prev = text
            for pat in _AMT_OI_PATTERNS:
                text = pat.sub('0', text)
            if text == prev:
                break

        # 4. 税号纠错
        text = _RE_TAX_ID.sub(
            lambda m: m.group(1) + self._replace_ocr_tax_digits(m.group(2).upper()),
            text
        )

        return text


class DigitCorrector:
    """字段级数字纠错（二次安全网）"""

    # [PERF] 模块级预编译正则 + 快速过滤字符集
    _DIGITS_OI_RE = re.compile(r'^[0-9OIolI]+$')
    _CORRECTABLE_CHARS = frozenset('OoIl')

    @staticmethod
    def fix(value: str) -> str:
        if not value or value in ('未知号码', '未知日期', '0.00', ''):
            return value
        # [PERF] 快速过滤：如果值中不含可纠错字符，直接返回
        if not any(c in DigitCorrector._CORRECTABLE_CHARS for c in value):
            return value
        stripped = value.replace('.', '').replace('-', '').replace(',', '').replace('/', '').replace('¥', '').replace('￥', '').replace(' ', '')
        if DigitCorrector._DIGITS_OI_RE.match(stripped):
            result = []
            for ch in value:
                if ch in ('O', 'o'):
                    result.append('0')
                elif ch in ('I', 'l'):
                    result.append('1')
                else:
                    result.append(ch)
            return ''.join(result)
        # 混合字段（税号等）
        result = list(value)
        for i, ch in enumerate(result):
            if ch in ('O', 'o'):
                prev_digit = (i > 0 and result[i - 1].isdigit())
                next_digit = (i < len(result) - 1 and result[i + 1].isdigit())
                if prev_digit or next_digit:
                    result[i] = '0'
        return ''.join(result)


class CompanyNameCleaner:
    """公司名称 OCR 空格清理"""
    @staticmethod
    def clean(name: str) -> str:
        if not name:
            return name
        result = name.replace('\u3000', ' ').strip()
        result = _RE_CJK_SPACE.sub(r'\1\2', result)
        return result.strip()
