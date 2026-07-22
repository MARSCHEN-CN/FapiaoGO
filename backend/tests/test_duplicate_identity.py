"""重复发票 identity 修复验证（fix duplicate invoice identity）。

隔离策略：在 import db 之前设置 MARSPRINT_DB_PATH 指向临时目录，
避免污染真实 database/ 与 Electron userData。

覆盖：
- Case 1：相同内容两张不同文件名 → 两条独立记录，各自可查
- Case 2：删除重复文件 B → 原件 A 仍可用自身 file_name 查询
- Case 3：不同内容 → 保持原行为，两条独立非重复记录
- 回归：同 hash + 同 file_name（重命名回填路径）→ 原地刷新，不新建
- 重启恢复：oplog 回放后两记录各自可查，重复关系保留
"""
import os
import sys
import tempfile
import shutil

# 必须在 import db 之前设置，db 在模块加载时即解析 DB 路径
_TMP_DB = tempfile.mkdtemp(prefix="dup_identity_db_")
os.environ['MARSPRINT_DB_PATH'] = _TMP_DB
# 保证 backend 目录在 sys.path（time_utils 等本地模块）
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import db  # noqa: E402


def _row(fname, h, amount='100'):
    return {
        'file_name': fname,
        'hash_sha256': h,
        'number': '123456',
        'amount': amount,
        'invoice_type': '电子发票',
    }


def _reset():
    """重置内存状态 + 清空磁盘残留，保证用例互不影响（纯内存测试，跳过磁盘加载）"""
    db._invoices = []
    db._invoice_index_by_id.clear()
    db._invoice_index_by_filename.clear()
    db._invoice_index_by_hash.clear()
    db._invoice_index_by_number.clear()
    db._loaded = True
    for p in (db.OPLOG_PATH, db.INVOICES_PATH):
        if os.path.exists(p):
            os.remove(p)


def test_case1_same_hash_two_files_both_queryable():
    """Case 1：相同内容两张不同文件名 → 两条独立记录，各自可查"""
    _reset()
    r1 = db.upsert_invoice(_row('A.pdf', 'hashX'))
    r2 = db.upsert_invoice(_row('B.pdf', 'hashX'))
    assert len(db._invoices) == 2, "应创建两条独立记录"
    rec_a = db.get_invoice_by_filename('A.pdf')
    rec_b = db.get_invoice_by_filename('B.pdf')
    assert rec_a is not None, "A 应可查"
    assert rec_b is not None, "B 应可查"
    assert rec_a['file_name'] == 'a.pdf'
    assert rec_b['file_name'] == 'b.pdf'
    assert r2['is_duplicate'] is True, "B 应标记为重复"
    assert rec_b['duplicate_of'] == r1['id'], "B.duplicate_of 应指向 A"


def test_case2_delete_duplicate_keeps_original():
    """Case 2：删除重复文件 B → 原件 A 仍可用自身 file_name 查询"""
    _reset()
    r1 = db.upsert_invoice(_row('A.pdf', 'hashX'))
    r2 = db.upsert_invoice(_row('B.pdf', 'hashX'))
    db.soft_delete_invoice(r2['id'])
    rec_a = db.get_invoice_by_filename('A.pdf')
    rec_b = db.get_invoice_by_filename('B.pdf')
    assert rec_a is not None, "删除 B 后 A 仍应可查"
    assert rec_b is None, "已软删的 B 应查不到"


def test_case3_different_hash_original_behavior():
    """Case 3：不同内容 → 保持原行为，两条独立非重复记录"""
    _reset()
    r1 = db.upsert_invoice(_row('A.pdf', 'hashA'))
    r2 = db.upsert_invoice(_row('B.pdf', 'hashB'))
    assert len(db._invoices) == 2
    assert r1['is_duplicate'] is False
    assert r2['is_duplicate'] is False
    assert db.get_invoice_by_filename('A.pdf') is not None
    assert db.get_invoice_by_filename('B.pdf') is not None


def test_same_file_reparse_refreshes_in_place():
    """回归保护：同 hash + 同 file_name（重命名回填路径）→ 原地刷新，不新建"""
    _reset()
    r1 = db.upsert_invoice(_row('A.pdf', 'hashX', amount='100'))
    r2 = db.upsert_invoice(_row('A.pdf', 'hashX', amount='200'))
    assert len(db._invoices) == 1, "同一文件重新解析不应新建记录"
    assert r2['is_new'] is False
    rec = db.get_invoice_by_filename('A.pdf')
    assert rec['amount'] == '200', "应刷新为最新解析值"


def test_persistence_across_restart():
    """重启恢复：oplog 回放后两条记录各自可查，重复关系保留"""
    _reset()
    db.upsert_invoice(_row('A.pdf', 'hashX'))
    db.upsert_invoice(_row('B.pdf', 'hashX'))
    db.flush_oplog_buffer()
    # 模拟重启：重新加载（复用同一临时 DB 目录）
    db._loaded = False
    db._ensure_loaded()
    rec_a = db.get_invoice_by_filename('A.pdf')
    rec_b = db.get_invoice_by_filename('B.pdf')
    assert rec_a is not None and rec_b is not None, "重启后两记录均应恢复"
    dups = [i for i in db._invoices if i.get('is_duplicate')]
    assert len(dups) == 1 and dups[0]['duplicate_of'], "重复关系应保留"


def test_case4_batch_same_hash_two_files():
    """batch 路径：相同内容两张不同文件名 → 两条独立记录，各自可查，标记重复"""
    _reset()
    rows = [_row('A.pdf', 'hashX'), _row('B.pdf', 'hashX')]
    results = db.batch_upsert_invoices(rows)
    assert len(db._invoices) == 2, "batch 应创建两条独立记录"
    assert results[0]['is_duplicate'] is False
    assert results[1]['is_duplicate'] is True, "batch 第二条应标记为重复"
    rec_a = db.get_invoice_by_filename('A.pdf')
    rec_b = db.get_invoice_by_filename('B.pdf')
    assert rec_a is not None and rec_b is not None
    assert rec_b['duplicate_of'] == results[0]['id']


if __name__ == '__main__':
    import unittest
    try:
        unittest.main(verbosity=2)
    finally:
        shutil.rmtree(_TMP_DB, ignore_errors=True)
