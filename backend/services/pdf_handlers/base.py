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
        """将源文件转换为 PDF 并写入 output_path（单文件输出）。

        单独导出模式调用此方法。

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

    def export_merge(self, source: bytes, filename: str,
                     target_doc: 'fitz.Document') -> int:
        """将源文件的页面插入一个已有的 PDF 文档（合并模式用）。

        可选方法，默认实现抛出 NotImplementedError。
        支持合并的 Handler（PdfExportHandlerImpl、ImageExportHandler）
        应覆盖此方法。

        此方法与 export_to_pdf 的区别：
          - export_to_pdf 写入独立文件。
          - export_merge 将内容插入调用方持有的 fitz.Document。
            调用方（Service 层）负责 Document 的创建/保存/关闭。

        Args:
            source:     源文件字节。
            filename:   文件名（仅用于日志/异常）。
            target_doc: 目标 fitz.Document（调用方持有生命周期）。

        Returns:
            int: 插入的页数。

        Raises:
            NotImplementedError: 当 Handler 不支持合并时。
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not support export_merge"
        )
