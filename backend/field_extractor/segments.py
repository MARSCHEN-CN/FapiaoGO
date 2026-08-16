"""
文档分段模型

将 OCRDocument 切分为六个语义区域，供字段提取器按区域提取。

区域划分:
  header     — 抬头区（发票类型、发票代码、发票号码、开票日期、购销方信息等）
  line_items — 明细区（项目、规格、数量、单价、金额、税率、税额）
  summary    — 合计区（合计金额、合计税额、价税合计）
  footer     — 页脚区（收款人、复核人、开票人）
  remark     — 备注区（备注内容）
  noise      — 噪声（不属于任何区域的杂项）

注意：buyer/seller 区域不再在此处管理，由 PartyExtractor 独立提取
  并回写到 OCRDocument.regions 中。
"""
from dataclasses import dataclass, field
from typing import List, Dict
from .models import Token


# 字段名 → 所属区域 映射
# 注意：gmfmc/gmfsh/xsfmc/xsfsh 不再映射到固定区域，
# 由 PartyExtractor 独立提取，不依赖此处的区域划分
FIELD_REGION_MAP: Dict[str, List[str]] = {
    'type':       ['header'],
    'fphm':       ['header'],
    'kprq':       ['header'],
    'line_items': ['line_items'],
    'xmmc':       ['line_items'],
    'amountJe':   ['summary', 'line_items'],
    'amountSe':   ['summary', 'line_items'],
    'amountHj':   ['summary'],
    'amountHjDx': ['summary'],
    'skr':        ['footer'],
    'fhr':        ['footer'],
    'kpr':        ['footer'],
    'note':       ['remark'],
}


@dataclass
class DocumentSegment:
    """一个文档区域"""
    lines: List[str] = field(default_factory=list)
    tokens: List[Token] = field(default_factory=list)
    structured_lines: list = field(default_factory=list)  # List[Line] — 结构化行

    @property
    def text(self) -> str:
        return '\n'.join(self.lines)

    @property
    def is_empty(self) -> bool:
        return not self.lines and not self.tokens

    @property
    def collapsed(self) -> str:
        """区域的 collapsed 文本（单行，空格分隔）"""
        return ' '.join(self.lines) if self.lines else ''


@dataclass
class SegmentedDocument:
    """分段后的文档，每个区域互不重叠"""
    header: DocumentSegment = field(default_factory=DocumentSegment)
    line_items: DocumentSegment = field(default_factory=DocumentSegment)
    summary: DocumentSegment = field(default_factory=DocumentSegment)
    footer: DocumentSegment = field(default_factory=DocumentSegment)
    remark: DocumentSegment = field(default_factory=DocumentSegment)
    noise: DocumentSegment = field(default_factory=DocumentSegment)

    def get_region(self, name: str) -> DocumentSegment:
        """按名称获取区域"""
        return getattr(self, name, DocumentSegment())

    def region_text(self, name: str) -> str:
        """获取区域的文本内容"""
        seg = self.get_region(name)
        return seg.text if seg else ''

    def region_lines(self, name: str) -> List[str]:
        """获取区域的行列表"""
        seg = self.get_region(name)
        return seg.lines if seg else []

    def multi_region_text(self, *names: str) -> str:
        """获取多个区域的合并文本"""
        parts = []
        for name in names:
            t = self.region_text(name)
            if t:
                parts.append(t)
        return '\n'.join(parts)

    def multi_region_lines(self, *names: str) -> List[str]:
        """获取多个区域的合并行列表"""
        result = []
        for name in names:
            result.extend(self.region_lines(name))
        return result
