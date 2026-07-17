"""PDF 导出 Handler 抽象接口（纯能力层，不感知 SSE/Task/Progress）。"""

from abc import ABC, abstractmethod
from typing import Any, Dict


class PdfExportHandler(ABC):
    """PDF 导出处理器接口。

    职责：给定源文件，输出 PDF 文件。
    不感知：task_id、progress_callback、SSE、cancel。
    """

    @abstractmethod
    def can_handle(self, file_format: str, details: Dict[str, Any] = None) -> bool:
        """判断此 Handler 是否可处理该文件格式。"""
        ...

    @abstractmethod
    def export_to_pdf(self, source: bytes, output_path: str, **kwargs) -> Dict[str, Any]:
        """将源文件转换为 PDF 并写入 output_path。

        Args:
            source:      源文件字节。
            output_path: 目标 .pdf 文件路径（调用方保证目录存在）。
            **kwargs:    Handler 专用参数（如 dpi、paper_size 等）。

        Returns:
            dict: {
                'pages': int,         # 输出 PDF 页数
                'sha256': str,        # 输出文件 SHA256
                'size': int,          # 输出文件字节数
                'warnings': [str],    # 非致命警告
            }
        """
        ...
