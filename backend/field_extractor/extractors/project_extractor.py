"""
项目名称/货物名称提取器
"""
import re
import logging
from ..models import OCRDocument

logger = logging.getLogger(__name__)

# 税率 token 模式，用于从数据行中剥离
_TAX_RATE_PATTERN = re.compile(r'\d+%|免税|0%|6%|9%|13%')
# 金额 token 模式
_PRICE_PATTERN = re.compile(r'[¥￥]?\s*[\d,]+\.\d{2}')
# 星号分类编码格式: *分类名称*
_STAR_CATEGORY_RE = re.compile(r'^\*[^*]+\*')
# 表头关键词，用于避免策略2误命中表头行
_TABLE_HEADER_KEYWORDS = re.compile(r'(项目名称|货物或应税劳务|服务名称).*(金额|税率|单价)')


class ProjectExtractor:
    """提取项目名称/货物或应税劳务名称（xmmc）"""

    def extract(self, doc: OCRDocument) -> str:
        # 修改4: 收集所有候选，选最优
        candidates = []

        # 策略1: "项目名称" 列后的数据行
        r = self._extract_from_project_header(doc.lines)
        if r:
            candidates.append((r, 90, '项目名称表头'))

        # 策略2: "货物或应税劳务" 关键词
        r = self._extract_from_goods_keyword(doc.lines)
        if r:
            candidates.append((r, 85, '货物关键词'))

        # 策略3: 包含 "金额"+"税率" 的表头行后的数据行
        r = self._extract_from_table_data(doc.lines)
        if r:
            candidates.append((r, 75, '表格数据行'))

        # 策略4: 以 * 开头的数电发票项目
        r = self._extract_from_star_prefix(doc.lines)
        if r:
            candidates.append((r, 95, '星号分类编码'))

        if not candidates:
            return ''

        # 选最高分候选
        best = max(candidates, key=lambda c: c[1])
        logger.debug("[Project] Selected: '%s' (score=%d, source=%s)", best[0], best[1], best[2])
        return best[0]

    def _extract_from_project_header(self, lines: list) -> str:
        for i, line in enumerate(lines):
            if ('项目名称' in line or '服务名称' in line) and i + 1 < len(lines):
                next_line = lines[i + 1]
                if not re.search(r'\d+\.\d{2}', next_line):
                    continue
                parts = re.split(r'\s+', next_line)
                project_parts = []
                for part in parts:
                    if re.match(r'^[\d\.]+$', part):
                        break
                    if _TAX_RATE_PATTERN.fullmatch(part):
                        break
                    if re.match(r'^[\d,]+\.\d{2}$', part):
                        break
                    project_parts.append(part)
                if project_parts:
                    candidate = ' '.join(project_parts).strip()
                    # 去掉星号分类编码前缀
                    candidate = _STAR_CATEGORY_RE.sub('', candidate).strip()
                    if len(candidate) > 1:
                        return candidate
        return ''

    def _extract_from_goods_keyword(self, lines: list) -> str:
        for line in lines:
            # 修改2: 排除表头行本身（同时包含"货物"和"金额/税率"）
            if _TABLE_HEADER_KEYWORDS.search(line):
                continue
            if '货物或应税劳务' in line or '服务名称' in line:
                m = re.search(
                    r'(?:货物或应税劳务|服务名称)[:\s]*(.+?)(?:\s+\d|\s+¥|$)',
                    line
                )
                if m:
                    candidate = m.group(1).strip()
                    if candidate and len(candidate) > 1:
                        return candidate
        return ''

    def _extract_from_table_data(self, lines: list) -> str:
        for i, line in enumerate(lines):
            if '金额' in line and '税率' in line:
                candidate = self._extract_project_from_data_lines(lines, i)
                if candidate:
                    return candidate
        return ''

    def _extract_project_from_data_lines(self, lines: list, header_idx: int) -> str:
        """从表头行下方的数据行中提取项目名称"""
        project_parts = []
        for j in range(header_idx + 1, min(header_idx + 6, len(lines))):
            data_line = lines[j]
            if not re.search(r'\d+\.\d{2}', data_line):
                # 非数据行：如果已有部分内容且行非空，可能是续行
                if project_parts and data_line.strip():
                    # 修改3: 续行只在当前结果以括号结尾时才追加
                    if re.search(r'[（(]$', project_parts[-1]):
                        project_parts.append(data_line.strip())
                continue

            # 清理数据行中的数字和税率 token
            cleaned = _TAX_RATE_PATTERN.sub('', data_line)
            cleaned = _PRICE_PATTERN.sub('', cleaned)
            cleaned = re.sub(r'\b\d+\b', '', cleaned)
            cleaned = cleaned.strip()

            if len(cleaned) >= 2 and re.search(r'[\u4e00-\u9fa5a-zA-Z]', cleaned):
                project_parts.append(cleaned)
                # 如果不以括号结尾，说明项目名到此结束
                if not re.search(r'[）)]$', cleaned):
                    break

        if project_parts:
            return ' '.join(project_parts)
        return ''

    def _extract_from_star_prefix(self, lines: list) -> str:
        for line in lines:
            if '*' not in line:
                continue

            # 优先匹配: *分类名称*项目名称 格式
            m = re.search(
                r'(\*[^*]+\*[^\d*].*?)(?:\s+[\d,]+\.\d{2}|\s+\d+%|\s+免税|\s+0%|\s+6%|\s+9%|\s+13%|$)',
                line
            )
            if m:
                raw = m.group(1).strip()
                # 保留完整的 *分类名称*项目名称 格式（不去掉星号前缀）
                if len(raw) >= 2 and re.search(r'[\u4e00-\u9fa5]', raw):
                    return raw

            # 回退: *后面第一个非空白token
            m = re.search(r'\*(\S+)', line)
            if m:
                candidate = m.group(1).strip('*')
                # 修改1: 要求至少含一个中文字符，排除纯数字编码
                if len(candidate) >= 2 and re.search(r'[\u4e00-\u9fa5]', candidate):
                    return candidate

        return ''
