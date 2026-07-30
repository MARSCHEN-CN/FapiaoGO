# -*- coding: utf-8 -*-
"""
PageResultStore — 页面解析结果暂存层

职责（单一）：
    收集同一桶键（bucket_key）的页面解析结果，提供生命周期判断。
    不做业务判断（不分组、不合并、不写 DB）。

桶键语义（IS-4.2）：
    bucket_key = 文档实例身份 instance_id（前端 producer 生成、transport 透传）。
    同内容 A/B 导入 → instance_id 不同 → 落入不同桶，不再互相覆盖。
    source_doc_id（内容哈希）降级为桶内记录的溯源元数据（debug 用），不参与分桶；
    渲染 / OCR / 缓存仍按内容哈希共享（合法）。

设计原则：
    - 纯内存暂存，非持久化
    - 每个 bucket_key 独立存储
    - 线程安全（锁保护）
    - 由 InvoiceAssemblyPipeline 消费

数据结构：
    {
        bucket_key: {
            total_pages: int,
            source_doc_id: str,   # 内容溯源（可选，debug 用）
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
        # { bucket_key: { total_pages, source_doc_id, pages: { page_num: result } } }
        self._store: Dict[str, Dict[str, Any]] = {}

    def put(
        self,
        bucket_key: str,
        page_num: int,
        total_pages: int,
        parse_result: Dict[str, Any],
        source_doc_id: str = '',
    ) -> bool:
        """存入一页的解析结果

        Args:
            bucket_key: 桶键（IS-4.2 后 = 文档实例身份 instance_id；同一实例的所有页共享）
            page_num: 页码（0-based）
            total_pages: 源文档总页数
            parse_result: parse_invoice_service 返回的解析结果 dict
            source_doc_id: 内容溯源（内容哈希，可选；仅记录 debug 用，不参与分桶）

        Returns:
            True 表示该 bucket_key 的所有页已收齐，
            False 表示仍在等待更多页
        """
        with self._lock:
            if bucket_key not in self._store:
                self._store[bucket_key] = {
                    'total_pages': total_pages,
                    'source_doc_id': source_doc_id,
                    'pages': {},
                }

            entry = self._store[bucket_key]
            # total_pages 以最后一次写入为准（允许不同页的 total_pages 不一致）
            entry['total_pages'] = total_pages
            if source_doc_id:
                entry['source_doc_id'] = source_doc_id
            entry['pages'][page_num] = parse_result

            received = len(entry['pages'])
            completed = received >= total_pages

            logger.debug(
                f"[PageResultStore] {bucket_key} 第{page_num + 1}/{total_pages}页已存入 "
                f"({received}/{total_pages})"
            )

            return completed

    def get_pages(self, bucket_key: str) -> Optional[List[Dict[str, Any]]]:
        """获取指定 bucket_key 的页面结果列表（按 page_num 排序）

        Args:
            bucket_key: 桶键（文档实例身份 instance_id）

        Returns:
            按 page_num 排序的 parse_result 列表；不存在时返回 None
        """
        with self._lock:
            entry = self._store.get(bucket_key)
            if not entry:
                return None
            pages = entry['pages']
            return [pages[i] for i in sorted(pages.keys())]

    def is_completed(self, bucket_key: str) -> bool:
        """判断指定 bucket_key 的所有页是否已收齐"""
        with self._lock:
            entry = self._store.get(bucket_key)
            if not entry:
                return False
            return len(entry['pages']) >= entry['total_pages']

    def remove(self, bucket_key: str) -> None:
        """移除指定 bucket_key 的暂存数据（组装完成后调用）"""
        with self._lock:
            self._store.pop(bucket_key, None)
            logger.debug(f"[PageResultStore] {bucket_key} 已移除")

    def get_all_completed(self) -> List[str]:
        """获取所有已收齐的 bucket_key 列表（用于批量触发组装）"""
        with self._lock:
            return [
                key for key, entry in self._store.items()
                if len(entry['pages']) >= entry['total_pages']
            ]

    def clear(self) -> None:
        """清空所有暂存数据（用于测试/重置）"""
        with self._lock:
            self._store.clear()

    @property
    def size(self) -> int:
        """当前暂存中的 bucket_key 数量"""
        with self._lock:
            return len(self._store)


# 全局单例
_page_result_store = PageResultStore()


def get_page_result_store() -> PageResultStore:
    """获取全局 PageResultStore 单例"""
    return _page_result_store
