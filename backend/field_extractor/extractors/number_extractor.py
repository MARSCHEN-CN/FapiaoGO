"""
发票号码提取器
"""
import re
import logging
from ..models import OCRDocument, Line

logger = logging.getLogger(__name__)


class NumberExtractor:
    """提取发票号码（fphm）"""

    def extract(self, doc: OCRDocument):
        fphm = self._extract_fphm(doc)
        return fphm or ''

    def _get_search_text(self, doc: OCRDocument) -> str:
        """优先从 header 区域搜索，无区域时回退到全文"""
        region_text = doc.region_text('header')
        return region_text if region_text else doc.collapsed

    def _get_search_lines(self, doc: OCRDocument) -> list:
        """优先从 header 区域获取行，无区域时回退到全文"""
        region = doc.get_region('header')
        if region and region.lines:
            lines = []
            for l in region.lines:
                lines.append(l.text if isinstance(l, Line) else str(l))
            return lines
        return doc.lines

    def _extract_fphm(self, doc: OCRDocument) -> str:
        # 修改4: 收紧"号码" pattern，要求前面不紧跟其他字段名
        # 修改2: 删除裸数字兗底 pattern
        # OCR 常见误识别：码→鸡/吗/马/妈/蚂（字体相近）
        patterns = [
            r'发票号码[:：]?\s*([0-9]{8,20})',
            r'发票号[鸡吗马妈蚂][:：]?\s*([0-9]{8,20})',
            r'票据号码[:：]?\s*([0-9]{8,20})',
            # 注意：Python re 模块要求 look-behind 固定宽度，不能用 | 拼接不同长度
            r'(?<!电话)(?<!银行)(?<!税)(?<!手机)(?<!传真)(?<!账号)号码[:：]?\s*([0-9]{8,20})',
            r'(?<!电话)(?<!银行)(?<!税)(?<!手机)(?<!传真)(?<!账号)号[鸡吗马妈蚂][:：]?\s*([0-9]{8,20})',
            r'No[.:：]?\s*([0-9]{8,20})',
            r'FPHM[:：]?\s*([0-9]{8,20})',
        ]
        # 优先从 header 区域搜索
        search_text = self._get_search_text(doc)
        result = self._find_first(search_text, patterns, flags=re.IGNORECASE)
        if result:
            return result
    
        # 行级回退
        search_lines = self._get_search_lines(doc)
        result = self._find_first_in_lines(search_lines, patterns, flags=re.IGNORECASE)
        if result:
            return result
    
        # 全文兜底
        if search_text != doc.collapsed:
            result = self._find_first(doc.collapsed, patterns, flags=re.IGNORECASE)
            if result:
                return result
            result = self._find_first_in_lines(doc.lines, patterns, flags=re.IGNORECASE)
            if result:
                return result
    
        # 裸数字行级兜底：仅匹配独立占一行的 8 位或 20 位纯数字
        result = self._find_standalone_number(doc.lines)
        if result:
            return result

        # 全文兜底：匹配以词边界分隔的 20 位独立数字（标签和值被 OCR 拆到不同行时）
        # 如 "发票号码:" 在行A，"25332000000535514566" 在行B
        result = self._find_standalone_number_in_text(doc.collapsed)
        if result:
            return result

        return ''

    @staticmethod
    def _find_standalone_number(lines: list) -> str:
        """裸数字兜底：仅匹配独立占一行的 8 位或 20 位纯数字"""
        for line in lines:
            stripped = line.strip()
            m = re.fullmatch(r'(\d{8}|\d{20})', stripped)
            if m:
                logger.debug("[Number] 裸数字兜底(行级)命中: %s", m.group(1))
                return m.group(1)
        return ''

    @staticmethod
    def _find_standalone_number_in_text(text: str) -> str:
        """
        全文兜底：匹配以词边界分隔的 20 位独立数字。
        适用场景：OCR 将"发票号码："和数字拆到不同 y 行，
        行级匹配失败，但数字仍以独立词形式存在于全文。
        """
        if not text:
            return ''
        m = re.search(r'\b(\d{20})\b', text)
        if m:
            logger.debug("[Number] 裸数字兜底(全文)命中: %s", m.group(1))
            return m.group(1)
        return ''

    @staticmethod
    def _find_first(text: str, patterns: list, flags: int = 0) -> str | None:
        for p in patterns:
            m = re.search(p, text, flags)
            if m:
                return m.group(1).strip()
        return None

    @staticmethod
    def _find_first_in_lines(lines: list, patterns: list, flags: int = 0) -> str | None:
        """逐行搜索，collapsed 合并破坏邻接时的回退"""
        for line in lines:
            for p in patterns:
                m = re.search(p, line, flags)
                if m:
                    return m.group(1).strip()
        return None
