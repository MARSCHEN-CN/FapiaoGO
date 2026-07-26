# -*- coding: utf-8 -*-
"""
PageResultStore — 页面解析结果暂存层

职责（单一）：
    收集同一 source_doc_id 的页面解析结果，提供生命周期判断。
    不做业务判断（不分组、不合并、不写 DB）。

设计原则：
    - 纯内存暂存，非持久化
    - 每个 source_doc_id 独立存储
    - 线程安全（锁保护）
    - 由 InvoiceAssemblyPipeline 消费

数据结构：
    {
        source_doc_id: {
            total_pages: int,
            pages: {
                page_num: parse_result_dict,
            }
        }
    }
"""

import threading
import logging
from typing import Dict, Any, Optional, List

logger = logging.getLogger(__name__)


class PageResultStore:
    """页面解析结果暂存层"""

    def __init__(self):
        self._lock = threading.Lock()
        # { source_doc_id: { total_pages, pages: { page_num: result } } }
        self._store: Dict[str, Dict[str, Any]] = {}

    def put(
        self,
        source_doc_id: str,
        page_num: int,
        total_pages: int,
        parse_result: Dict[str, Any],
    ) -> bool:
        """存入一页的解析结果

        Args:
            source_doc_id: 源文档 ID（同一 PDF 的所有页共享）
            page_num: 页码（0-based）
            total_pages: 源文档总页数
            parse_result: parse_invoice_service 返回的解析结果 dict

        Returns:
            True 表示该 source_doc_id 的所有页已收齐，
            False 表示仍在等待更多页
        """
        with self._lock:
            if source_doc_id not in self._store:
                self._store[source_doc_id] = {
                    'total_pages': total_pages,
                    'pages': {},
                }

            entry = self._store[source_doc_id]
            # total_pages 以最后一次写入为准（允许不同页的 total_pages 不一致）
            entry['total_pages'] = total_pages
            entry['pages'][page_num] = parse_result

            received = len(entry['pages'])
            completed = received >= total_pages

            logger.debug(
                f"[PageResultStore] {source_doc_id} 第{page_num + 1}/{total_pages}页已存入 "
                f"({received}/{total_pages})"
            )

            return completed

    def get_pages(self, source_doc_id: str) -> Optional[List[Dict[str, Any]]]:
        """获取指定 source_doc_id 的页面结果列表（按 page_num 排序）

        Args:
            source_doc_id: 源文档 ID

        Returns:
            按 page_num 排序的 parse_result 列表；不存在时返回 None
        """
        with self._lock:
            entry = self._store.get(source_doc_id)
            if not entry:
                return None
            pages = entry['pages']
            return [pages[i] for i in sorted(pages.keys())]

    def is_completed(self, source_doc_id: str) -> bool:
        """判断指定 source_doc_id 的所有页是否已收齐"""
        with self._lock:
            entry = self._store.get(source_doc_id)
            if not entry:
                return False
            return len(entry['pages']) >= entry['total_pages']

    def remove(self, source_doc_id: str) -> None:
        """移除指定 source_doc_id 的暂存数据（组装完成后调用）"""
        with self._lock:
            self._store.pop(source_doc_id, None)
            logger.debug(f"[PageResultStore] {source_doc_id} 已移除")

    def get_all_completed(self) -> List[str]:
        """获取所有已收齐的 source_doc_id 列表（用于批量触发组装）"""
        with self._lock:
            return [
                sid for sid, entry in self._store.items()
                if len(entry['pages']) >= entry['total_pages']
            ]

    def clear(self) -> None:
        """清空所有暂存数据（用于测试/重置）"""
        with self._lock:
            self._store.clear()

    @property
    def size(self) -> int:
        """当前暂存中的 source_doc_id 数量"""
        with self._lock:
            return len(self._store)


# 全局单例
_page_result_store = PageResultStore()


def get_page_result_store() -> PageResultStore:
    """获取全局 PageResultStore 单例"""
    return _page_result_store
