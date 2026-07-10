"""发票 id 迁移 / 版本兼容 / 启动不变量 的离线验证。

用法: python test_migration.py
依赖: 与本文件同目录的 db.py（仅在测试进程中 monkey-patch 路径全局变量，
不触碰真实数据库）。

覆盖:
1. 未知 schemaVersion（999 / 3）加载应拒绝并给出清晰信息
2. 当前 schemaVersion=2 正常加载，id 为 str
3. 裸列表（旧格式，无信封）兼容加载
4. _write_snapshot 信封一致：_save_invoices / _compact_oplog 均产出
   {"schemaVersion": SCHEMA_VERSION, "invoices": [...]}
5. 遗留 int id 迁移为 hex 并输出「迁移完成」日志
6. _validate_invoice_ids 对非 str id 抛 RuntimeError，对 str id 不抛
7. 回归：遗留 int 快照 + int oplog -> 全部 hex，oplog id 一并迁移
"""
import io
import json
import os
import sys
import tempfile
import logging

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db  # noqa: E402


def setup_dir():
    d = tempfile.mkdtemp(prefix="migtest_")
    db.DB_DIR = d
    db.INVOICES_PATH = os.path.join(d, "invoices.json")
    db.OPLOG_PATH = os.path.join(d, "oplog.log")
    db.CONFIG_PATH = os.path.join(d, "config.json")
    db.COMPACT_MARKER = os.path.join(d, ".compact_writing")
    db.COMPACT_READY = os.path.join(d, ".compact_done")
    db._loaded = False
    db._invoices = []
    db._oplog_buffer = []
    db._oplog_count = 0
    for idx in (db._invoice_index_by_id, db._invoice_index_by_hash,
                db._invoice_index_by_filename, db._invoice_index_by_number):
        idx.clear()
    return d


failures = []


def check(name, cond):
    if cond:
        print("  PASS:", name)
    else:
        print("  FAIL:", name)
        failures.append(name)


# ---- 1+2: 未知 schemaVersion 应拒绝加载 ----
for sv in (999, 3):
    setup_dir()
    with io.open(db.INVOICES_PATH, "w", encoding="utf-8") as f:
        json.dump({"schemaVersion": sv, "invoices": [{"id": "abc", "file_name": "a.pdf"}]}, f)
    try:
        db._load_invoices()
        check(f"schemaVersion={sv} 应拒绝加载 (RuntimeError)", False)
    except RuntimeError as e:
        msg = str(e)
        check(f"schemaVersion={sv} 拒绝并给出清晰信息", "schemaVersion" in msg and str(db.SCHEMA_VERSION) in msg)

# ---- 3: 当前 schemaVersion=2 正常加载 ----
setup_dir()
with io.open(db.INVOICES_PATH, "w", encoding="utf-8") as f:
    json.dump({"schemaVersion": 2, "invoices": [{"id": "abc", "file_name": "a.pdf"}]}, f)
try:
    db._load_invoices()
    check("schemaVersion=2 正常加载", True)
    check("schemaVersion=2 后 id 为 str", isinstance(db._invoices[0]["id"], str))
except Exception as e:
    check("schemaVersion=2 正常加载", False)
    print("    unexpected:", repr(e))

# ---- 4: 裸列表（旧格式，无信封）兼容加载 ----
setup_dir()
with io.open(db.INVOICES_PATH, "w", encoding="utf-8") as f:
    json.dump([{"id": "abc", "file_name": "a.pdf"}], f)
try:
    db._load_invoices()
    check("裸列表(旧格式)兼容加载", True)
except Exception as e:
    check("裸列表(旧格式)兼容加载", False)
    print("    unexpected:", repr(e))

# ---- 5: _write_snapshot 信封一致 ----
setup_dir()
db._invoices = [{"id": "x1", "file_name": "x.pdf"}]
db._save_invoices()
with io.open(db.INVOICES_PATH, encoding="utf-8") as f:
    snap = json.load(f)
check("_save_invoices 写信封 schemaVersion", snap.get("schemaVersion") == db.SCHEMA_VERSION)
check("_save_invoices 信封含 invoices", snap.get("invoices") == [{"id": "x1", "file_name": "x.pdf"}])

setup_dir()
db._invoices = [{"id": "y1", "file_name": "y.pdf"}]
db._compact_oplog()
with io.open(db.INVOICES_PATH, encoding="utf-8") as f:
    snap = json.load(f)
check("_compact_oplog 写信封 schemaVersion", snap.get("schemaVersion") == db.SCHEMA_VERSION)

# ---- 6: 遗留 int id 迁移为 hex + 迁移完成日志 ----
setup_dir()
log_records = []

class _H(logging.Handler):
    def emit(self, rec):
        log_records.append(rec.getMessage())

h = _H()
h.setLevel(logging.INFO)
db.logger.setLevel(logging.INFO)  # 测试桩未配 basicConfig，默认 WARNING 会过滤 INFO 迁移日志
db.logger.addHandler(h)
with io.open(db.INVOICES_PATH, "w", encoding="utf-8") as f:
    json.dump([{"id": 123456789, "file_name": "leg.pdf"}], f)
db._load_invoices()
db.logger.removeHandler(h)
vid = db._invoices[0]["id"]
check("遗留 int id 迁移为 32 位 hex", isinstance(vid, str) and len(vid) == 32)
check("迁移完成日志已输出", any("迁移完成" in m for m in log_records))

# ---- 7: _validate_invoice_ids 行为 ----
setup_dir()
db._invoices = [{"id": 42, "file_name": "bad.pdf"}]
try:
    db._validate_invoice_ids()
    check("_validate_invoice_ids 对非 str id 抛出", False)
except RuntimeError:
    check("_validate_invoice_ids 对非 str id 抛出 RuntimeError", True)

setup_dir()
db._invoices = [{"id": "okhex", "file_name": "ok.pdf"}]
try:
    db._validate_invoice_ids()
    check("_validate_invoice_ids 对 str id 不抛", True)
except Exception:
    check("_validate_invoice_ids 对 str id 不抛", False)

# ---- 8: 回归 遗留 int 快照 + int oplog -> 全部 hex ----
setup_dir()
i1, i2 = 111111, 222222
with io.open(db.INVOICES_PATH, "w", encoding="utf-8") as f:
    json.dump([
        {"id": i1, "file_name": "a.pdf", "hash_sha256": "h1"},
        {"id": i2, "file_name": "b.pdf", "hash_sha256": "h2"},
    ], f)
with io.open(db.OPLOG_PATH, "w", encoding="utf-8") as f:
    f.write(json.dumps({"op": "upsert", "id": i2, "ts": "t",
                        "data": {"id": i2, "file_name": "b.pdf"}}) + "\n")
db._load_invoices()
ids = [inv["id"] for inv in db._invoices]
check("回归: 全部 id 为 32 位 hex", all(isinstance(x, str) and len(x) == 32 for x in ids))
check("回归: oplog 中 id 一并迁移（旧 int 不再可查）",
      db._invoice_index_by_id.get("222222") is None)

print()
if failures:
    print("FAILURES:", failures)
    sys.exit(1)
print("ALL MIGRATION TESTS PASSED")
