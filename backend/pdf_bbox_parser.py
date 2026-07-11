"""
PDF bbox 解析器 - 充分利用 PyMuPDF 的坐标信息

核心思路：
1. 使用 page.get_text("words") 获取带坐标的文本块
2. 基于 Y 坐标聚类识别区域（购买方区域、销售方区域）
3. 识别垂直标签（购/买/方/信/息）
4. 在各自区域内提取字段
"""

import fitz
from dataclasses import dataclass
from typing import List, Tuple, Dict, Optional

logger = __import__('logging').getLogger(__name__)


@dataclass
class TextToken:
    """带坐标的文本token"""
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    page: int = 0
    
    @property
    def width(self):
        return self.x1 - self.x0
    
    @property
    def height(self):
        return self.y1 - self.y0
    
    @property
    def center_x(self):
        return (self.x0 + self.x1) / 2
    
    @property
    def center_y(self):
        return (self.y0 + self.y1) / 2


@dataclass
class Region:
    """文本区域"""
    name: str
    y_min: float
    y_max: float
    tokens: List[TextToken] = None
    
    def __post_init__(self):
        if self.tokens is None:
            self.tokens = []
    
    def contains(self, token: TextToken) -> bool:
        return self.y_min <= token.y0 <= self.y_max
    
    def get_text(self) -> str:
        """获取区域内的文本（按坐标排序）"""
        sorted_tokens = sorted(self.tokens, key=lambda t: (t.y0, t.x0))
        return "\n".join([t.text for t in sorted_tokens])


class PdfBboxParser:
    """基于 bbox 的 PDF 解析器"""
    
    def __init__(self):
        # 垂直标签模式识别
        self.vertical_label_patterns = [
            ["购", "买", "方", "信", "息"],
            ["销", "售", "方", "信", "息"],
            ["卖", "方", "信", "息"],
            ["购", "买", "方"],
            ["销", "售", "方"],
        ]
    
    def extract_tokens(self, pdf_bytes: bytes = None, doc: fitz.Document = None,
                       pre_words: List[List[tuple]] = None) -> List[TextToken]:
        """从 PDF 提取带坐标的文本 token（支持传入已打开的 doc 避免重复打开）

        Args:
            pdf_bytes: PDF 文件字节（doc 为 None 时使用）
            doc: 已打开的 fitz.Document（优先使用，避免重复打开）
            pre_words: 可选，预先提取的每页 words 元组列表
                （来自 extract_text_from_bytes(..., return_words=True)）。
                传入时将跳过每页的 get_text("words") 调用，避免重复提取。
                元素结构: (x0, y0, x1, y1, word_text, block_no, line_no, word_no)
        """
        tokens = []
        should_close = False

        try:
            if doc is None:
                if pdf_bytes is None:
                    logger.warning("extract_tokens: pdf_bytes 和 doc 均为空")
                    return []
                doc = fitz.open(stream=pdf_bytes, filetype="pdf")
                should_close = True

            if pre_words is not None:
                # [PERF] 直接复用预提取的 words，不再调用 page.get_text("words")
                for page_idx, words in enumerate(pre_words):
                    for word in words:
                        x0, y0, x1, y1, text, _, _, _ = word
                        if text.strip():
                            tokens.append(TextToken(
                                x0=x0, y0=y0, x1=x1, y1=y1,
                                text=text.strip(),
                                page=page_idx
                            ))
            else:
                for page_idx, page in enumerate(doc):
                    # 使用 words 模式获取带坐标的单词
                    words = page.get_text("words")
                    for word in words:
                        x0, y0, x1, y1, text, _, _, _ = word
                        if text.strip():
                            tokens.append(TextToken(
                                x0=x0, y0=y0, x1=x1, y1=y1,
                                text=text.strip(),
                                page=page_idx
                            ))
        except Exception as e:
            logger.error(f"提取 tokens 失败: {e}")
        finally:
            if should_close:
                doc.close()

        return tokens
    
    def detect_regions(self, tokens: List[TextToken]) -> Tuple[Region, Region]:
        """
        检测购买方和销售方区域
        
        策略：
        1. 先识别垂直标签（购/买/方/信/息）确定区域边界
        2. 如果没有垂直标签，基于 Y 坐标聚类划分上下区域
        """
        buyer_region = Region(name="buyer", y_min=0, y_max=0)
        seller_region = Region(name="seller", y_min=0, y_max=0)
        
        # 第一步：识别垂直标签
        vertical_labels = self._detect_vertical_labels(tokens)
        
        if vertical_labels:
            # 有垂直标签，以此为界
            buyer_y = None
            seller_y = None
            
            for label in vertical_labels:
                if "购" in label['text'] or "买" in label['text']:
                    buyer_y = label['y_center']
                elif "销" in label['text'] or "售" in label['text'] or "卖" in label['text']:
                    seller_y = label['y_center']
            
            if buyer_y is not None and seller_y is not None:
                # 确定上下区域
                if buyer_y < seller_y:
                    buyer_region = Region(
                        name="buyer",
                        y_min=0,
                        y_max=(buyer_y + seller_y) / 2
                    )
                    seller_region = Region(
                        name="seller",
                        y_min=(buyer_y + seller_y) / 2,
                        y_max=float('inf')
                    )
                else:
                    buyer_region = Region(
                        name="buyer",
                        y_min=0,
                        y_max=buyer_y + 200
                    )
                    seller_region = Region(
                        name="seller",
                        y_min=seller_y - 50,
                        y_max=float('inf')
                    )
        
        # 如果没有识别到垂直标签或识别不完整，使用默认策略
        if buyer_region.y_max == 0:
            self._default_region_detection(tokens, buyer_region, seller_region)
        
        # 将 tokens 分配到对应区域
        for token in tokens:
            if buyer_region.contains(token):
                buyer_region.tokens.append(token)
            elif seller_region.contains(token):
                seller_region.tokens.append(token)
        
        return buyer_region, seller_region
    
    def _detect_vertical_labels(self, tokens: List[TextToken]) -> List[Dict]:
        """
        检测垂直排列的标签（如"购买方信息"垂直排列）
        
        识别条件：
        1. 同一 x 坐标附近（±15 像素）
        2. y 坐标连续递增
        3. 字符按顺序组成已知模式
        """
        labels = []
        
        # 按 x 坐标分组
        x_groups = {}
        for token in tokens:
            x_key = round(token.center_x / 15) * 15  # 15像素为一组
            if x_key not in x_groups:
                x_groups[x_key] = []
            x_groups[x_key].append(token)
        
        # 在每个 x 组中查找垂直排列的字符
        for x_center, group_tokens in x_groups.items():
            # 按 y 坐标排序
            sorted_tokens = sorted(group_tokens, key=lambda t: t.y0)
            
            # 尝试匹配垂直标签模式
            for pattern in self.vertical_label_patterns:
                matched, start_idx = self._match_vertical_pattern(sorted_tokens, pattern)
                if matched:
                    labels.append({
                        'text': ''.join(pattern),
                        'y_center': sorted_tokens[start_idx].center_y,
                        'x_center': x_center
                    })
                    break
        
        return labels
    
    def _match_vertical_pattern(self, sorted_tokens: List[TextToken], 
                               pattern: List[str]) -> Tuple[bool, int]:
        """
        匹配垂直排列的字符模式
        
        Args:
            sorted_tokens: 按 y 坐标排序的 tokens
            pattern: 期望的字符序列（如 ["购", "买", "方", "信", "息"]）
        
        Returns:
            (是否匹配, 匹配起始索引)
        """
        pattern_len = len(pattern)
        
        for i in range(len(sorted_tokens) - pattern_len + 1):
            match = True
            expected_y = sorted_tokens[i].y0
            
            for j in range(pattern_len):
                token = sorted_tokens[i + j]
                
                # 检查字符是否匹配
                if token.text != pattern[j]:
                    match = False
                    break
                
                # 检查 y 坐标是否连续递增（允许一定误差）
                if j > 0 and token.y0 < expected_y:
                    match = False
                    break
                
                # 更新期望的下一个 y 坐标
                expected_y = token.y1 + 2  # 允许 2 像素间隔
            
            if match:
                return True, i
        
        return False, -1
    
    def _default_region_detection(self, tokens: List[TextToken], 
                                buyer_region: Region, seller_region: Region):
        """
        默认区域检测策略：基于 Y 坐标聚类
        
        将页面分为上下两部分：
        - 上半部分：购买方区域
        - 下半部分：销售方区域
        """
        if not tokens:
            return
        
        # 获取所有 token 的 y 坐标范围
        all_ys = [token.y0 for token in tokens]
        min_y = min(all_ys)
        max_y = max(all_ys)
        
        # 计算中间分割线（稍微偏上，因为购买方通常在上半部分）
        split_y = min_y + (max_y - min_y) * 0.45
        
        buyer_region.y_min = min_y
        buyer_region.y_max = split_y
        
        seller_region.y_min = split_y
        seller_region.y_max = max_y + 50  # 扩展一点边界
    
    def parse_pdf(self, pdf_bytes: bytes, include_all_tokens: bool = True) -> Dict:
        """
        完整解析流程：
        1. 提取 tokens
        2. 检测区域
        3. 返回结构化结果
        """
        tokens = self.extract_tokens(pdf_bytes=pdf_bytes)

        if not tokens:
            return {
                'buyer_text': '',
                'seller_text': '',
                'buyer_tokens': [],
                'seller_tokens': [],
                'all_tokens': []
            }

        buyer_region, seller_region = self.detect_regions(tokens)

        return {
            'buyer_text': buyer_region.get_text(),
            'seller_text': seller_region.get_text(),
            'buyer_tokens': [{'x0': t.x0, 'y0': t.y0, 'x1': t.x1, 'y1': t.y1, 'text': t.text} 
                           for t in buyer_region.tokens],
            'seller_tokens': [{'x0': t.x0, 'y0': t.y0, 'x1': t.x1, 'y1': t.y1, 'text': t.text} 
                           for t in seller_region.tokens],
            'all_tokens': ([{'x0': t.x0, 'y0': t.y0, 'x1': t.x1, 'y1': t.y1, 'text': t.text}
                         for t in tokens] if include_all_tokens else [])
        }

    def parse_pdf_from_doc(self, doc: fitz.Document,
                            pre_words: List[List[tuple]] = None,
                            include_all_tokens: bool = True) -> Dict:
        """
        从已打开的 fitz.Document 解析（避免重复打开 PDF）

        Args:
            doc: 已打开的 fitz.Document 对象
            pre_words: 可选，预先提取的每页 words 元组列表，
                传入时将跳过 get_text("words") 调用
        """
        tokens = self.extract_tokens(doc=doc, pre_words=pre_words)

        if not tokens:
            return {
                'buyer_text': '',
                'seller_text': '',
                'buyer_tokens': [],
                'seller_tokens': [],
                'all_tokens': []
            }

        buyer_region, seller_region = self.detect_regions(tokens)

        return {
            'buyer_text': buyer_region.get_text(),
            'seller_text': seller_region.get_text(),
            'buyer_tokens': [{'x0': t.x0, 'y0': t.y0, 'x1': t.x1, 'y1': t.y1, 'text': t.text} 
                           for t in buyer_region.tokens],
            'seller_tokens': [{'x0': t.x0, 'y0': t.y0, 'x1': t.x1, 'y1': t.y1, 'text': t.text} 
                           for t in seller_region.tokens],
            'all_tokens': ([{'x0': t.x0, 'y0': t.y0, 'x1': t.x1, 'y1': t.y1, 'text': t.text}
                         for t in tokens] if include_all_tokens else [])
        }


# 全局单例
_bbox_parser = None

def get_bbox_parser() -> PdfBboxParser:
    """获取 bbox 解析器单例"""
    global _bbox_parser
    if _bbox_parser is None:
        _bbox_parser = PdfBboxParser()
    return _bbox_parser


def parse_pdf_with_bbox(pdf_bytes: bytes, include_all_tokens: bool = True) -> Dict:
    """便捷函数：解析 PDF 获取区域信息"""
    return get_bbox_parser().parse_pdf(pdf_bytes, include_all_tokens=include_all_tokens)


def parse_pdf_with_bbox_from_doc(doc, pre_words: List[List[tuple]] = None,
                                 include_all_tokens: bool = True) -> Dict:
    """便捷函数：从已打开的 fitz.Document 解析（避免重复打开 PDF）

    Args:
        doc: 已打开的 fitz.Document
        pre_words: 可选，预先提取的每页 words 元组列表
        include_all_tokens: 是否构建 all_tokens（仅开发脚本需要；
            生产路径可传 False 跳过 500+ dict 分配）
    """
    return get_bbox_parser().parse_pdf_from_doc(doc, pre_words=pre_words,
                                               include_all_tokens=include_all_tokens)
