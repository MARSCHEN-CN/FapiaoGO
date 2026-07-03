"""
开票日期提取器
"""
import re
import logging
from datetime import datetime
from ..models import OCRDocument, Line

logger = logging.getLogger(__name__)


class DateExtractor:
    """提取开票日期（kprq）"""

    def extract(self, doc: OCRDocument) -> str:
        # 修改1: 优先用带关键词的 pattern，裸日期降为低优先级
        patterns = [
            r'开票日期[:：]?\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?)',
            r'日期[:：]?\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?)',
            r'(\d{4}年\d{1,2}月\d{1,2}日)',
        ]

        # 优先从 header 区域搜索（避免从备注中误取日期）
        region_text = doc.region_text('header')
        search_text = region_text if region_text else doc.collapsed

        raw = self._find_first_cached(doc, patterns, search_text)

        if not raw and search_text != doc.collapsed:
            # 区域未命中，回退到全文（使用缓存）
            raw = self._find_first_cached(doc, patterns, doc.collapsed)

        # collapsed 未命中时，逐行搜索
        if not raw:
            region = doc.get_region('header')
            if region and region.lines:
                search_lines = [l.text if isinstance(l, Line) else str(l) for l in region.lines]
                raw = self._find_first_in_lines(search_lines, patterns)
            if not raw:
                raw = self._find_first_in_lines(doc.lines, patterns)

        if not raw:
            return ''

        raw = raw.replace('年', '-').replace('月', '-').replace('日', '').replace('号', '')
        m = re.match(r'(\d{4})[-/](\d{1,2})[-/](\d{1,2})', raw)
        if m:
            year, month, day = m.group(1), m.group(2), m.group(3)
            # 修改2: 日期合理性校验
            if self._validate_date(year, month, day):
                return f"{year}-{month.zfill(2)}-{day.zfill(2)}"
            logger.debug("[Date] 日期校验失败: %s-%s-%s", year, month, day)
        return ''

    @staticmethod
    def _find_first_cached(doc: OCRDocument, patterns: list, text: str) -> str | None:
        """在给定文本中用缓存搜索，避免重复扫描 doc.collapsed"""
        for p in patterns:
            m = doc.cached_search(p, text)
            if m:
                return m.group(1).strip()
        return None

    @staticmethod
    def _validate_date(year: str, month: str, day: str) -> bool:
        """校验日期是否合理"""
        try:
            y, m, d = int(year), int(month), int(day)
            datetime(y, m, d)
            return True
        except (ValueError, TypeError):
            return False

    @staticmethod
    def _find_first(text: str, patterns: list) -> str | None:
        for p in patterns:
            m = re.search(p, text)
            if m:
                return m.group(1).strip()
        return None

    @staticmethod
    def _find_first_in_lines(lines: list, patterns: list) -> str | None:
        """逐行搜索，用于 collapsed 合并破坏邻接关系时的回退"""
        for line in lines:
            for p in patterns:
                m = re.search(p, line)
                if m:
                    return m.group(1).strip()
        return None
