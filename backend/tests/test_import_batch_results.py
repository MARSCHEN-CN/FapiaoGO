# -*- coding: utf-8 -*-
"""
Commit 2.7c-0（audit + test，不提交业务代码）

目的：锁定 import_batch_manager.get_batch_results 中 amount read-out 合并的
「空 clientKey 跨文档覆盖」数据污染 bug，作为后续 2.7c 修复的回归基线。

背景（5.1a 审计 §6）：
  get_batch_results 遍历 batch.assembled_documents，用每篇文档的 pageClientKeys
  构建 clientKey → 合并后价税合计 的映射：
      for client_key in (doc.get('pageClientKeys') or []):
          if amount: assembled_amount_map[client_key] = amount
  再在 item 层用 job 的 metrics.client_key 查表覆盖单页金额。

  风险点：当 pageClientKeys 含空串 ""（clientKey 在 scheduler 处可选、缺省即 ""），
  多篇文档都会以 "" 为键写入同一 map，后者覆盖前者。于是 Doc A 的金额可能被
  Doc B 覆盖，造成跨文档金额错配——危害级别高于 amount 统一本身。

本测试驱动真实 get_batch_results 路径（FakeJobManager 提供 get_job/get_job_result），
而非手工复现片段。4 个用例中 3 个在现有代码下应通过，1 个（空 clientKey）应失败——
即把真实 bug 锁住，待 2.7c 修复后全部转绿。

运行（backend/tests 被 gitignore，需 -f 纳入）：
  backend/venv/Scripts/python -m pytest tests/test_import_batch_results.py -q
"""
import os
import sys
import unittest

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _BACKEND_DIR)

from import_batch_manager import ImportBatchManager, ImportBatch


class FakeJobManager:
    """极简 ParseJobManager 替身，仅满足 get_batch_results 所需接口。"""
    def __init__(self, jobs=None, results=None):
        self._jobs = jobs or {}
        self._results = results or {}

    def on_job_complete(self, callback):
        pass

    def get_job(self, job_id):
        return self._jobs.get(job_id)

    def get_job_result(self, job_id):
        return self._results.get(job_id)


def _batch(manager, batch_id, job_ids, assembled_documents):
    batch = ImportBatch(
        id=batch_id,
        total=len(job_ids),
        status='completed',
        job_ids=list(job_ids),
        assembled_documents=list(assembled_documents),
    )
    manager._batches[batch_id] = batch
    return batch


def _mk_job(client_key, status='success'):
    return {
        'status': status,
        'metrics': {'client_key': client_key},
        'file_name': 'f.pdf',
        'file_hash': 'h',
    }


def _mk_result(amount='', extra_fields=None):
    # 注意：与 invoice_service 真实返回对齐——result **无顶层 failed_fields 键**，
    # 失败字段只嵌在 extra_fields 内（字段提取器 to_dict 产物：list[dict{field,...}]）。
    return {
        'extra_fields': extra_fields or {},
        'doc_id': 'd',
        'invoice_type': '',
        'invoice_number': '',
        'invoice_date': '',
        'amount': amount,
        'parse_method': 'ocr',
        'new_name': '',
    }


class TestBatchResultsAmountMerge(unittest.TestCase):
    # ───────────────────────────────────────────────────────────
    # 锁 bug：空 clientKey 不应成为 map 键，避免跨文档金额覆盖
    # ───────────────────────────────────────────────────────────
    def test_empty_client_key_does_not_cross_override(self):
        jm = FakeJobManager(
            jobs={'j1': _mk_job('')},
            results={'j1': _mk_result(amount='old')},
        )
        mgr = ImportBatchManager(jm)
        _batch(mgr, 'b-empty', ['j1'], [
            {'amount': 100, 'invoiceDate': '', 'pageClientKeys': ['']},
            {'amount': 200, 'invoiceDate': '', 'pageClientKeys': ['']},
        ])
        items = mgr.get_batch_results('b-empty')['items']
        self.assertEqual(len(items), 1)
        # client_key='' 必须被跳过：item.amount 应保持 legacy 'old'，而非被 200 覆盖
        self.assertEqual(
            items[0]['amount'], 'old',
            "空 clientKey 不应成为 map 键；多文档 '' 键互相覆盖会污染金额",
        )

    # ───────────────────────────────────────────────────────────
    # 以下 3 个用例在现有代码下应通过（2.7c 修复后仍为绿，作为回归）
    # ───────────────────────────────────────────────────────────
    def test_normal_client_key_overrides(self):
        jm = FakeJobManager(
            jobs={'j1': _mk_job('ckA')},
            results={'j1': _mk_result(amount='old')},
        )
        mgr = ImportBatchManager(jm)
        _batch(mgr, 'b-normal', ['j1'], [
            {'amount': 100, 'invoiceDate': '', 'pageClientKeys': ['ckA']},
        ])
        items = mgr.get_batch_results('b-normal')['items']
        self.assertEqual(items[0]['amount'], 100)

    def test_different_keys_no_cross_override(self):
        jm = FakeJobManager(
            jobs={'jA': _mk_job('ckA'), 'jB': _mk_job('ckB')},
            results={
                'jA': _mk_result(amount='oldA'),
                'jB': _mk_result(amount='oldB'),
            },
        )
        mgr = ImportBatchManager(jm)
        _batch(mgr, 'b-multi', ['jA', 'jB'], [
            {'amount': 100, 'invoiceDate': '', 'pageClientKeys': ['ckA']},
            {'amount': 200, 'invoiceDate': '', 'pageClientKeys': ['ckB']},
        ])
        items = {it['clientKey']: it for it in mgr.get_batch_results('b-multi')['items']}
        self.assertEqual(items['ckA']['amount'], 100)
        self.assertEqual(items['ckB']['amount'], 200)

    def test_no_assembled_documents_legacy(self):
        jm = FakeJobManager(
            jobs={'j1': _mk_job('ckA')},
            results={'j1': _mk_result(amount='', extra_fields={'amountHj': 'legacy'})},
        )
        mgr = ImportBatchManager(jm)
        _batch(mgr, 'b-legacy', ['j1'], [])  # 空 assembled_documents
        items = mgr.get_batch_results('b-legacy')['items']
        self.assertEqual(items[0]['amount'], 'legacy')

    # ───────────────────────────────────────────────────────────
    # failedFields 契约：必须从 extra_fields 读取（invoice_service 返回
    # 的 result 无顶层 failed_fields 键），dict 列表 → 字段名字符串列表。
    # 修复前 `result.get('failed_fields', [])` 恒为 [] → 前端 isFailedFile
    # 永不为真，缺失购买方名称等发票不被判定为解析失败。
    # ───────────────────────────────────────────────────────────
    def test_failed_fields_read_from_extra_fields(self):
        jm = FakeJobManager(
            jobs={'j1': _mk_job('ckA')},
            results={'j1': _mk_result(extra_fields={
                'failed_fields': [
                    {'field': 'gmfmc', 'label': '购买方名称', 'severity': 'error',
                     'reason': '购买方名称为空', 'value': '', 'confidence': 0.0},
                    {'field': 'gmfsh', 'label': '购买方税号', 'severity': 'error',
                     'reason': '购买方税号为空', 'value': '', 'confidence': 0.0},
                ],
            })},
        )
        mgr = ImportBatchManager(jm)
        _batch(mgr, 'b-failed', ['j1'], [
            {'amount': 100, 'invoiceDate': '', 'pageClientKeys': ['ckA']},
        ])
        items = mgr.get_batch_results('b-failed')['items']
        self.assertEqual(items[0]['failedFields'], ['gmfmc', 'gmfsh'])

    def test_failed_fields_empty_when_no_extra_fields(self):
        jm = FakeJobManager(
            jobs={'j1': _mk_job('ckA')},
            results={'j1': _mk_result(extra_fields=None)},
        )
        mgr = ImportBatchManager(jm)
        _batch(mgr, 'b-noff', ['j1'], [
            {'amount': 100, 'invoiceDate': '', 'pageClientKeys': ['ckA']},
        ])
        items = mgr.get_batch_results('b-noff')['items']
        self.assertEqual(items[0]['failedFields'], [])


if __name__ == '__main__':
    unittest.main()
