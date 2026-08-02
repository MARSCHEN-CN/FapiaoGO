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
                    'bucket_key': bucket_key,
                    'total_pages': total_pages,
                    'source_doc_id': source_doc_id,
                    'pages': {},
                }

            entry = self._store[bucket_key]
            # B5（Commit 4.3）：total_pages 首次声明锁定，后续冲突仅告警、不覆盖、不取 max。
            # 不取 max 的原因：首报 3、某页误报 2 时 max=3 反而掩盖了"该页 total 错误"的 producer bug；
            # 正确原则是「第一次声明锁定 + 冲突可观测」，让上游错误暴露出来。
            if entry['total_pages'] is None:
                entry['total_pages'] = total_pages
            elif total_pages is not None and entry['total_pages'] != total_pages:
                logger.warning(
                    "[PageResultStore] %s total_pages 冲突：已锁定=%s，本次收到=%s，"
                    "保留首次声明（不覆盖）",
                    bucket_key, entry['total_pages'], total_pages,
                )
            if source_doc_id:
                entry['source_doc_id'] = source_doc_id
            # B2 修复（Commit 4.2a）：在 store 边界把 0-based page_num 注入页面记录。
            # 用 dict() 复制而非原地修改 parse_result —— parse_result 可能被其它消费者
            # （DB upsert、前端直写、assemble 之外的调用方）引用，store 只拥有"暂存表示"，
            # 不应反向污染原始对象。注入后 assemble 的 _page_num_key 才能拿到真实页码，
            # 否则 production parse_result 不带 page_num/page_index，会退化到默认 0，
            # 导致同文档多页被拆成单页发票。
            page_record = dict(parse_result)
            page_record['page_num'] = page_num
            # 同步注入 total_pages：使下游（invoice_assembly_pipeline._resolve_marker
            # 的回退轨道）在没有文本页码标记时，也能通过结构化字段判定多页。
            # 这样"无文本标记但 store 明确告知是多页"的场景也能正确聚合。
            page_record['total_pages'] = total_pages
            # 增强：将 db_record 中的 file_name 提取到页面顶层，便于下游直接访问
            # 避免依赖多层嵌套 (db_record.file_name)，提升健壮性
            db_rec = parse_result.get('db_record') or {}
            if db_rec.get('file_name'):
                page_record['file_name'] = db_rec['file_name']
            entry['pages'][page_num] = page_record

            # B4（Commit 4.3）：完成判定从「数量 >= total」改为「所有期望页码都收到」。
            # 旧逻辑 len(pages) >= total_pages 会让 page0/page1/page3（total=3）误判完整，
            # 因数量够了但缺 page2。新逻辑要求 received 是 expected 的超集。
            completed = self._is_complete(entry)

            logger.debug(
                f"[PageResultStore] {bucket_key} 第{page_num + 1}/"
                f"{entry['total_pages'] or total_pages}页已存入"
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

    def _is_complete(self, entry: Dict[str, Any]) -> bool:
        """B4（Commit 4.3）：完成 = 所有期望页码（0..total_pages-1）都已收到。

        用集合包含 expected <= received 替代 len(pages) >= total_pages，
        避免「数量够了但缺中间页」的伪完成（如 page0/page1/page3, total=3 缺 page2）。

        扩展支持非连续页码场景（如第1、3、5页/共5页）：
        当首尾页均已收到（page_num=0 和 page_num=total-1）时，
        即使中间页缺失也判定为完成，因为标记已表明覆盖了完整范围。
        """
        total = entry.get('total_pages')
        pages = entry.get('pages') or {}
        if not total or not pages:
            return False
        expected = set(range(total))
        received = set(pages.keys())
        # 标准路径：所有期望页码都已收到
        if expected <= received:
            return True
        # 非连续页码兜底：首尾页均已收到（标记覆盖完整范围）
        if 0 in received and (total - 1) in received:
            logger.info(
                "[PageResultStore] 非连续页码完成判定: bucket=%s, total=%s, received=%s",
                entry.get('bucket_key', '?'), total, sorted(received)
            )
            return True
        return False

    def get_missing_pages(self, bucket_key: str) -> Optional[set]:
        """返回指定 bucket_key 尚未收到的页码集合（可观测性 / 诊断）。

        Returns:
            缺失页码 set；桶不存在或 total_pages 未知时返回 None
        """
        with self._lock:
            entry = self._store.get(bucket_key)
            if not entry:
                return None
            total = entry.get('total_pages')
            if not total:
                return None
            return set(range(total)) - set(entry['pages'].keys())

    def is_completed(self, bucket_key: str) -> bool:
        """判断指定 bucket_key 的所有页是否已收齐"""
        with self._lock:
            entry = self._store.get(bucket_key)
            if not entry:
                return False
            return self._is_complete(entry)

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
                if self._is_complete(entry)
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
