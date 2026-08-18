"""InvoiceImportHistory 单元测试（冻结方案验证）。

覆盖：
- 基本记录 / 查询
- invoiceDate 首次记录后不可被后续导入覆盖；firstImportedAt 不变；lastImportedAt/count 更新
- 同号码再次导入开票日期不一致 → 保留首次日期 + 累计 dateMismatchCount + warning（不污染）
- 发票号码归一化（空白/大小写）
- 空号码不记录
- 3 年清理按开票日期边界（差 1 天也保留；invoiceDate 缺失回退 firstImportedAt）
- 🔴 豁免回归：db 压缩(_compact_oplog) 与 7 天清理(cleanup_expired_invoices) 不影响导入历史
"""
import os
import sys
import tempfile

# 必须在 import 之前设置，db / import_history 均在模块加载时解析 DB 路径
_TMP_DB = tempfile.mkdtemp(prefix="import_history_db_")
os.environ['FAPIAOGO_DB_PATH'] = _TMP_DB
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import import_history as ih  # noqa: E402
import db  # noqa: E402
from datetime import date  # noqa: E402


def _reset_db_memory():
    db._invoices = []
    db._invoice_index_by_id.clear()
    db._invoice_index_by_filename.clear()
    db._invoice_index_by_hash.clear()
    db._invoice_index_by_number.clear()
    db._loaded = True
    for p in (db.OPLOG_PATH, db.INVOICES_PATH):
        if os.path.exists(p):
            os.remove(p)


def setup_function(_):
    # 每个用例使用独立历史文件，避免相互污染
    ih.configure(os.path.join(tempfile.mkdtemp(prefix="ih_"), "x"))
    ih._history_by_number.clear()


def test_record_and_get():
    ih.record_import("123456", "2026-08-01")
    ih.flush()
    rec = ih.get_import_history("123456")
    assert rec is not None
    assert rec['invoiceDate'] == '2026-08-01'
    assert rec['importCount'] == 1
    assert rec['firstImportedAt'] == rec['lastImportedAt']
    assert ih.has_imported("123456") is True
    assert ih.has_imported("999999") is False


def test_reimport_keeps_first_date_and_count():
    ih.record_import("Y123", "2026-01-01")
    first = ih.get_import_history("Y123")
    first_at = first['firstImportedAt']
    # 再次导入同号码同日期
    ih.record_import("Y123", "2026-01-01")
    second = ih.get_import_history("Y123")
    assert second['invoiceDate'] == '2026-01-01'          # 不可变
    assert second['firstImportedAt'] == first_at           # 首次时间不可变
    assert second['lastImportedAt'] >= first_at            # 最近时间更新
    assert second['importCount'] == 2


def test_date_mismatch_keeps_first_and_warns():
    ih.record_import("X1", "2025-01-01")
    first_at = ih.get_import_history("X1")['firstImportedAt']
    # 再次导入，开票日期不一致
    ih.record_import("X1", "2025-01-02")
    rec = ih.get_import_history("X1")
    assert rec['invoiceDate'] == '2025-01-01'             # 保留首次，不覆盖
    assert rec['firstImportedAt'] == first_at
    assert rec['dateMismatchCount'] == 1                   # 累计不一致次数
    assert rec['importCount'] == 2


def test_normalize_equality():
    ih.record_import("  abc-123 ", "2026-03-03")
    ih.record_import("ABC-123", "2026-03-03")             # 归一化后应视为同一号码
    rec = ih.get_import_history("abc-123")
    assert rec is not None
    assert rec['importCount'] == 2


def test_empty_number_not_recorded():
    ih.record_import("", "2026-01-01")
    ih.record_import(None, "2026-01-01")
    assert ih.get_import_history("") is None
    assert ih.get_import_history(None) is None


def test_db_upsert_empty_number_not_recorded():
    """🔴 回归：发票号码为空的发票经 db 完整链路（单张+批量）也绝不写入导入历史。

    否则所有空号码发票会塌缩到同一键，全部被误判为「重复报销」。
    覆盖 '' / None / 纯空白三种形态，验证 db.py 挂钩→record_import 归一化守卫整链路。
    """
    _reset_db_memory()
    db.upsert_invoice({
        'file_name': 'empty-num.pdf', 'hash_sha256': 'emptyhash1',
        'number': '', 'date': '2026-01-01', 'amount': '10',
    })
    db.upsert_invoice({
        'file_name': 'no-num-field.pdf', 'hash_sha256': 'emptyhash2',
        'number': None, 'date': '2026-01-02', 'amount': '20',
    })
    db.batch_upsert_invoices([
        {'file_name': 'blank-num.pdf', 'hash_sha256': 'emptyhash3',
         'number': '   ', 'date': '2026-01-03', 'amount': '30'},
    ])
    ih.flush()
    assert ih._history_by_number == {}, "空号码不得写入导入历史任何键"

    # 对照组：有号码的发票正常写入
    db.upsert_invoice({
        'file_name': 'has-num.pdf', 'hash_sha256': 'emptyhash4',
        'number': 'EMP-123', 'date': '2026-01-04', 'amount': '40',
    })
    ih.flush()
    assert ih.has_imported('EMP-123') is True
    assert ih._history_by_number.get('') is None
    assert ih._history_by_number.get(None) is None


def test_three_year_cleanup_boundary():
    today = date(2026, 8, 17)
    ih.record_import("A", "2023-08-01")   # expiry 2026-08-01 < today → 删
    ih.record_import("B", "2023-08-20")   # expiry 2026-08-20 > today → 留
    ih.record_import("C", "2025-01-10")   # 留
    ih.record_import("E", "2026-08-10")   # 留
    # D：无 invoiceDate，回退 firstImportedAt=2023-01-01 → expiry 2026-01-01 < today → 删
    ih._history_by_number["D"] = {
        'invoiceDate': None,
        'firstImportedAt': '2023-01-01T00:00:00+08:00',
        'lastImportedAt': '2023-01-01T00:00:00+08:00',
        'importCount': 1, 'dateMismatchCount': 0,
    }
    removed = ih.cleanup_expired(today=today)
    assert removed == 2
    assert ih.has_imported("A") is False
    assert ih.has_imported("D") is False
    assert ih.has_imported("B") is True
    assert ih.has_imported("C") is True
    assert ih.has_imported("E") is True


def test_compaction_and_7day_exemption():
    """🔴 回归：db 压缩与 7 天清理不得触及导入历史。"""
    _reset_db_memory()
    num, inv_date = "IMPORT-EXM", "2026-05-02"
    # 通过 db 正式入库（触发 import_history 挂钩）
    db.upsert_invoice({
        'file_name': 'exm.png', 'hash_sha256': 'exmhash',
        'number': num, 'date': inv_date, 'amount': '10',
    })
    ih.flush()
    assert ih.has_imported(num) is True

    # db 压缩（invoices.oplog 会被清空）—— 导入历史必须仍在
    db._compact_oplog()
    assert os.path.exists(db.OPLOG_PATH) is False or os.path.getsize(db.OPLOG_PATH) == 0
    assert ih.has_imported(num) is True
    assert ih.get_import_history(num)['invoiceDate'] == inv_date

    # db 7 天清理（invoice 可能丢失）—— 导入历史必须仍在
    db.cleanup_expired_invoices(days=0)  # 极端：立即过期全部发票
    assert ih.has_imported(num) is True


def test_batch_upsert_records_history():
    """🔴 回归：批量入库（batch_upsert_invoices）必须触发 import_history 挂钩。

    曾经的实际 bug：挂钩只接在单张 upsert_invoice，批路径（拖入多文件 /
    import_batch_manager / app.py 批量接口）只 flush 不 record，导致批量导入
    完全不记录历史。修复后批路径每张新发票都应写入历史。
    """
    _reset_db_memory()
    num1, inv_date1 = "BATCH-001", "2026-06-01"
    num2, inv_date2 = "BATCH-002", "2026-06-02"
    results = db.batch_upsert_invoices([
        {'file_name': 'b1.pdf', 'hash_sha256': 'batchhash1',
         'number': num1, 'date': inv_date1, 'amount': '10'},
        {'file_name': 'b2.pdf', 'hash_sha256': 'batchhash2',
         'number': num2, 'date': inv_date2, 'amount': '20'},
    ])
    assert all(r['is_new'] for r in results)        # 两张均为新增
    ih.flush()
    assert ih.has_imported(num1) is True
    assert ih.has_imported(num2) is True
    assert ih.get_import_history(num1)['invoiceDate'] == inv_date1
    assert ih.get_import_history(num2)['invoiceDate'] == inv_date2

    # 重复导入同批文件（同 hash + 同 file_name）→ is_new=False，但历史必须更新 last/count
    results2 = db.batch_upsert_invoices([
        {'file_name': 'b1.pdf', 'hash_sha256': 'batchhash1',
         'number': num1, 'date': inv_date1, 'amount': '10'},
    ])
    assert results2[0]['is_new'] is False
    rec_after = ih.get_import_history(num1)
    assert rec_after['importCount'] == 2            # 🔴 重复导入必须 +1（曾为 1，bug）
    assert rec_after['invoiceDate'] == inv_date1    # 开票日期仍不可变
    assert rec_after['firstImportedAt'] <= rec_after['lastImportedAt']  # last 更新


def test_upsert_reimport_updates_history():
    """单张路径重复导入（同 hash + 同 file_name → is_new=False）也必须更新
    lastImportedAt/importCount（lastImportedAt = 第二次导入时间）。"""
    _reset_db_memory()
    num, inv_date = "REIMP-001", "2026-07-01"
    row = {'file_name': 'r.pdf', 'hash_sha256': 'reimphash',
           'number': num, 'date': inv_date, 'amount': '10'}
    r1 = db.upsert_invoice(row)
    assert r1['is_new'] is True
    ih.flush()
    assert ih.get_import_history(num)['importCount'] == 1
    # 再次导入同一文件 → is_new=False，但 lastImportedAt/importCount 必须更新
    r2 = db.upsert_invoice(row)
    assert r2['is_new'] is False
    ih.flush()
    rec = ih.get_import_history(num)
    assert rec['importCount'] == 2
    assert rec['invoiceDate'] == inv_date            # 首次开票日期不可变
    assert rec['firstImportedAt'] <= rec['lastImportedAt']


def test_default_path_is_project_root_database():
    """🔴 冻结约束：未注入 FAPIAOGO_DB_PATH 时，默认路径必须落在
    <项目根>/database/invoice_import_history.json（项目级持久化，非后端私有）。"""
    saved = os.environ.pop('FAPIAOGO_DB_PATH', None)
    try:
        # 测试文件位于 backend/tests/，项目根为向上三层
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        expected = os.path.join(project_root, 'database', 'invoice_import_history.json')
        # 项目根 database/ 目录应存在（否则 dev_path.exists() 回退 home，不符冻结约束）
        assert os.path.isdir(os.path.join(project_root, 'database')), "项目根/database 不存在"
        assert ih._resolve_path() == expected
    finally:
        if saved is not None:
            os.environ['FAPIAOGO_DB_PATH'] = saved


def test_env_path_overrides_default():
    """FAPIAOGO_DB_PATH 注入时，路径必须落在该目录下（与 db._resolve_db_dir 一致）。"""
    import tempfile
    saved = os.environ.get('FAPIAOGO_DB_PATH')
    d = tempfile.mkdtemp(prefix="ih_env_")
    os.environ['FAPIAOGO_DB_PATH'] = d
    try:
        assert ih._resolve_path() == os.path.join(d, 'invoice_import_history.json')
    finally:
        if saved is None:
            os.environ.pop('FAPIAOGO_DB_PATH', None)
        else:
            os.environ['FAPIAOGO_DB_PATH'] = saved
