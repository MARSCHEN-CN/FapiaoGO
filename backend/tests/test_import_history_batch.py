"""InvoiceImportHistory 批量查询单元测试（P2-L2）。

覆盖：
- 批量结果与逐个 get_import_history 语义等价（命中/未命中/字段一致）
- 归一化键：大小写 / 内部空白视为同一号码；重复输入只出现一次
- 空数组 / None / 含空值 → 安全返回
- 返回副本（修改返回值不污染模块内状态）
- 性能回归保护：1000 个号码的批量查询远快于逐个查询的锁开销（宽松阈值）
"""
import os
import sys
import tempfile
import time

# 必须在 import 之前设置，db / import_history 均在模块加载时解析 DB 路径
os.environ['FAPIAOGO_DB_PATH'] = tempfile.mkdtemp(prefix="import_history_batch_db_")
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import import_history as ih  # noqa: E402


def setup_function(_):
    ih.configure(os.path.join(tempfile.mkdtemp(prefix="ihb_"), "x"))
    ih._history_by_number.clear()


def test_batch_matches_single_query():
    ih.record_import('INV001', '2026-01-01')
    ih.record_import('INV001', '2026-01-01')  # importCount = 2
    ih.record_import('INV002', '2026-02-02')  # importCount = 1

    batch = ih.get_import_history_batch(['INV001', 'INV002', 'INV999'])

    assert batch['INV001'] == ih.get_import_history('INV001')
    assert batch['INV002'] == ih.get_import_history('INV002')
    assert batch['INV999'] is None
    assert batch['INV001']['importCount'] == 2


def test_batch_normalizes_and_dedupes():
    ih.record_import('INV001', '2026-01-01')

    batch = ih.get_import_history_batch(['inv 001', 'INV001', '  inv001  '])

    assert list(batch.keys()) == ['INV001']
    assert batch['INV001']['importCount'] == 1


def test_batch_safe_on_empty_input():
    assert ih.get_import_history_batch([]) == {}
    assert ih.get_import_history_batch(None) == {}
    assert ih.get_import_history_batch(['', '   ', None]) == {}


def test_batch_returns_copies():
    ih.record_import('INV001', '2026-01-01')

    batch = ih.get_import_history_batch(['INV001'])
    batch['INV001']['importCount'] = 999

    assert ih.get_import_history('INV001')['importCount'] == 1


def test_batch_is_not_pathologically_slow():
    """性能回归保护：批量查询不得随号码数线性放大到逐个查询的量级。"""
    for i in range(200):
        ih.record_import('INV%03d' % i, '2026-01-01')
    numbers = ['INV%03d' % i for i in range(1000)]

    t0 = time.time()
    result = ih.get_import_history_batch(numbers)
    elapsed_ms = (time.time() - t0) * 1000

    assert len(result) == 1000
    # 实测 100 条 < 1ms；这里给 1000 条留 50ms 的宽松上限（防 CI 抖动误报）
    assert elapsed_ms < 50, "批量查询 %d 条耗时 %.1fms，疑似退化" % (len(numbers), elapsed_ms)
