# -*- coding: utf-8 -*-
"""
M1-a 现状锁定 · Channel B：批量导入 `page_num` 的归一化行为

⚠️ 本文件锁定的是【当前真实行为】，**不是目标契约**。
   下方多条断言锁住的恰恰是我们认为**有问题**的行为（运行时猜 base）。
   之所以先锁住，是因为 M1-c 要删掉这段猜测逻辑时，必须能看见「改动到底
   影响了哪些输入」。若将来行为被修正，本文件【预期失败】——失败即信号。

范围边界（重要，勿与 Channel A 合并）
------------------------------------------------
本文件覆盖 `ImportBatchManager._parse_page_info`，即**批量导入表单通道**。
它与 `/split_pdf` 的 `page_index` 输出通道（见
`tests/test_m1a_split_pdf_page_base.py`）是**两条独立通道**：

    Channel A  /split_pdf.page_index      → 1-based（app.py:987）
    Channel B  批量导入 metrics.page_num  → 由本文件锁定的运行时推断决定

Commit 4.1 / 4.3 归一的是 Channel B，**从未覆盖 Channel A**。把两者当成
同一个 contract 正是 M1 漂移能潜伏至今的直接原因，故测试层面刻意分文件。

核心现状（SourcePage-Migration-Audit.md · M1）
------------------------------------------------
`import_batch_manager.py:1131-1140` 不从 evidence 计算 base，而是从**值的字面
形状**推断语义：

    if page_num_str.startswith('0') and page_num_str:   # ← 靠字符串首字符猜 0-based
        ...
    if 1 <= page_num <= total_pages:
        page_num = page_num - 1                          # ← 否则默认按 1-based 归一

这是后端版的 `docId ?? id ?? key`。下面的
`test_fact_same_logical_page_yields_different_result_by_string_shape`
是对该问题最精确的可执行表达。

运行：
    cd backend && venv/Scripts/python -m pytest tests/test_m1a_batch_import_page_base.py -q
"""

import pytest

from import_batch_manager import ImportBatchManager


class FakeJobManager:
    """极简 ParseJobManager 替身，只满足 ImportBatchManager.__init__ 所需。"""

    def __init__(self):
        self._cb = None

    def on_job_complete(self, callback):
        self._cb = callback


@pytest.fixture
def manager():
    """每个用例一个全新实例 —— `_zero_based_buckets` 是实例级粘滞状态，必须隔离。"""
    return ImportBatchManager(FakeJobManager())


def _metrics(page_num, total_pages="3"):
    return {"page_num": page_num, "total_pages": total_pages}


# ---------------------------------------------------------------------------
# 事实 1：默认路径按 1-based 归一（-1）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw,expected", [("1", 0), ("2", 1), ("3", 2)])
def test_fact_default_branch_normalizes_one_based_by_minus_one(manager, raw, expected):
    """现状：未触发 0-based 信号时，1..total 范围内的值一律 -1。"""
    page_num, total = manager._parse_page_info(_metrics(raw), "bucket-default")
    assert (page_num, total) == (expected, 3), (
        f"现状锁定：page_num='{raw}' 应归一为 {expected}"
    )


# ---------------------------------------------------------------------------
# 事实 2：'0' 开头的字符串被判为 0-based 并原样透传
# ---------------------------------------------------------------------------

def test_fact_zero_prefixed_string_is_treated_as_zero_based_passthrough(manager):
    """现状：page_num 字符串以 '0' 开头 → 判定 0-based，不做 -1。"""
    page_num, total = manager._parse_page_info(_metrics("0"), "bucket-zero")
    assert (page_num, total) == (0, 3), "现状锁定：'0' 原样透传"


def test_fact_zero_based_verdict_is_sticky_per_bucket(manager):
    """现状：一旦某 bucket 被判为 0-based，同 bucket 后续页一律不再 -1。"""
    manager._parse_page_info(_metrics("0"), "bucket-sticky")
    page_num, _ = manager._parse_page_info(_metrics("1"), "bucket-sticky")
    assert page_num == 1, (
        "现状锁定：粘滞生效后 '1' 保持 1（不 -1）。"
        "注意这与 test_fact_default_branch_...（'1' → 0）结论相反——"
        "同一输入的语义取决于**该 bucket 的历史**，而非契约。"
    )


def test_fact_stickiness_does_not_leak_across_buckets(manager):
    """现状：粘滞状态按 bucket 隔离，不跨 bucket 传染。"""
    manager._parse_page_info(_metrics("0"), "bucket-A")
    page_num, _ = manager._parse_page_info(_metrics("1"), "bucket-B")
    assert page_num == 0, "现状锁定：bucket-B 未被污染，仍走默认 1-based 归一"


# ---------------------------------------------------------------------------
# 事实 3：越界值 / 非数字的降级行为
# ---------------------------------------------------------------------------

def test_fact_out_of_range_value_passes_through_without_normalization(manager):
    """现状：超出 1..total 的值不做 -1，原样返回（仅打 warning，不抛错）。"""
    page_num, total = manager._parse_page_info(_metrics("5", "3"), "bucket-oob")
    assert (page_num, total) == (5, 3), "现状锁定：越界值原样透传，不归一、不失败"


def test_fact_non_digit_page_num_degrades_to_zero(manager):
    """现状：非数字 page_num 静默降级为 0（不抛错、不标记 0-based）。"""
    page_num, total = manager._parse_page_info(_metrics("abc"), "bucket-nan")
    assert (page_num, total) == (0, 3), "现状锁定：非数字 → 0"


def test_fact_missing_fields_degrade_to_zero_and_total_one(manager):
    """现状：缺字段时 page_num=0, total_pages=1（静默默认值，无失败信号）。"""
    page_num, total = manager._parse_page_info({}, "bucket-empty")
    assert (page_num, total) == (0, 1), "现状锁定：缺 evidence 时静默取默认值"


# ---------------------------------------------------------------------------
# 事实 4（本文件核心）：base 由字符串形状推断，而非契约
# ---------------------------------------------------------------------------

def test_fact_same_logical_page_yields_different_result_by_string_shape(manager):
    """现状：逻辑上同一页，因字符串写法不同得到**不同**结果。

        '1'  → 0   （判为 1-based，做 -1）
        '01' → 1   （判为 0-based，原样透传）

    两者 int 值都是 1，却解析出不同的页号。这证明 base 不是契约，
    而是**运行时对字面量形状的猜测**。当前生产恰好稳定走 '1' 分支，
    因此结果正确——但这是巧合，不是保证。

    此断言存在的意义：M1-c 删除猜测逻辑时，本用例必然失败，
    从而强制实施者正面回答「这两种输入今后各自应得到什么」。
    """
    from_plain, _ = manager._parse_page_info(_metrics("1"), "bucket-plain")
    from_padded, _ = manager._parse_page_info(_metrics("01"), "bucket-padded")

    assert from_plain == 0, "现状：'1' 被判为 1-based → 0"
    assert from_padded == 1, "现状：'01' 被判为 0-based → 1"
    assert from_plain != from_padded, (
        "现状锁定：同一逻辑页的两种字符串写法产生不同结果——"
        "这是 M1 要消灭的运行时 base guessing 的可执行证据。"
    )
