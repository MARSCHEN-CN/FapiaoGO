# -*- coding: utf-8 -*-
"""
M1-a 现状锁定 · Channel A：`/split_pdf` 的 `page_index` 页码基数

⚠️ 本文件锁定的是【当前真实行为】，**不是目标契约**。
   若将来 M1-c 统一页码基数，本文件【预期失败】——失败即「我们正在改 base」的
   明确信号。届时应连同 SourcePageIdentity 契约一起显式更新断言，
   **而不是悄悄放宽/删除断言**。

背景（SourcePage-Migration-Audit.md · M1）
------------------------------------------------
项目记忆「核心原则 3」写着 `/split_pdf` 的 `page_index` 应为 0-based，
但真实 producer 是 **1-based**，且全后端仅此一处 emit：

    app.py:959   chunks.append([(i, i + 1, f"{file_hash}_{i}") for i in ...])   # page_num = i + 1
    app.py:987   pages.append({"page_index": page_num, ...})                    # ← 唯一 emit 点

这条漂移长期潜伏的原因之一是：既有 `test_split_pdf_chunk.py:80-84` 只用
「严格升序」（`prev_index + 1`，`prev_index` 初值 0）的形式**间接**锁定基数，
未把 base 本身写成显式断言，读测试的人看不出它在断言 1-based。
本文件把 base 提升为**一等断言**。

范围边界（重要，勿合并）
------------------------------------------------
本文件**只**覆盖 `/split_pdf` 的 `page_index` 输出通道。
批量导入的 `page_num` 表单通道是**另一条独立通道**，语义当前并不相同，
由 `tests/test_m1a_batch_import_page_base.py` 单独锁定。
两条通道禁止在测试中被表述为同一个 contract —— 正是「以为它们是同一个契约」
才导致 Commit 4.1/4.3 归一了表单通道却漏掉了 `/split_pdf`。

运行：
    cd backend && venv/Scripts/python -m pytest tests/test_m1a_split_pdf_page_base.py -q
"""

import hashlib
import io

import fitz
import pytest

import app as backend_app


@pytest.fixture
def client():
    backend_app.app.config["TESTING"] = True
    with backend_app.app.test_client() as c:
        yield c


def _make_pdf(n_pages):
    doc = fitz.open()
    for i in range(n_pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text((50, 60), f"PAGE_MARKER_{i}", fontsize=12)
    data = doc.tobytes()
    doc.close()
    return data


def _post_split(client, file_bytes, filename="m1a.pdf"):
    return client.post(
        "/split_pdf",
        data={"file": (io.BytesIO(file_bytes), filename)},
        content_type="multipart/form-data",
    )


# ---------------------------------------------------------------------------
# 事实 1：page_index 是 1-based
# ---------------------------------------------------------------------------

def test_fact_first_page_index_is_one_not_zero(client):
    """现状：多页 PDF 的首页 page_index == 1（而非 0）。"""
    pages = _post_split(client, _make_pdf(3)).get_json()["pages"]
    assert pages, "多页 PDF 应返回非空 pages"
    assert pages[0]["page_index"] == 1, (
        "现状锁定：/split_pdf 首页 page_index 为 1（1-based）。"
        "若此断言失败，说明 base 已被改动 —— 这是 M1-c 的信号，不是本测试的 bug。"
    )
    assert pages[0]["page_index"] != 0, "首页 page_index 当前不是 0-based"


@pytest.mark.parametrize("n_pages", [2, 3, 5])
def test_fact_page_index_sequence_is_1_to_n(client, n_pages):
    """现状：N 页 PDF 的 page_index 序列严格等于 [1, 2, ..., N]。"""
    pages = _post_split(client, _make_pdf(n_pages)).get_json()["pages"]
    actual = [p["page_index"] for p in pages]
    assert actual == list(range(1, n_pages + 1)), (
        f"现状锁定：{n_pages} 页应产出 1..{n_pages}，实际 {actual}"
    )


# ---------------------------------------------------------------------------
# 事实 2：同一响应内 page_index(1-based) 与 page_id 后缀(0-based) 基数不一致
# ---------------------------------------------------------------------------

def test_fact_page_id_suffix_is_zero_based_while_page_index_is_one_based(client):
    """现状：同一个 page 对象内部就存在两种基数。

    app.py:959 里 `(i, i + 1, f"{file_hash}_{i}")` 三元组同时产出：
        page_id  后缀 = i      → 0-based
        page_index      = i+1  → 1-based
    这不是笔误，是当前真实行为。锁住它是为了防止「统一 base」时只改一半，
    导致 page_id 与 page_index 静默错配一页。
    """
    pdf_bytes = _make_pdf(3)
    pages = _post_split(client, pdf_bytes).get_json()["pages"]
    file_hash = hashlib.sha256(pdf_bytes).hexdigest()[:16]

    for i, p in enumerate(pages):
        assert p["page_id"] == f"{file_hash}_{i}", (
            f"现状锁定：page_id 后缀为 0-based 的 i，@ 第 {i} 项"
        )
        assert p["page_index"] == i + 1, "现状锁定：page_index 为 1-based 的 i+1"
        # 显式记录二者差值恒为 1 —— 这正是错配风险的量化表达
        suffix = int(p["page_id"].rsplit("_", 1)[1])
        assert p["page_index"] - suffix == 1, (
            "现状锁定：同一 page 内 page_index 恒比 page_id 后缀大 1"
        )


# ---------------------------------------------------------------------------
# 事实 3：单页 PDF 提前返回，根本不产出 page_index
# ---------------------------------------------------------------------------

def test_fact_single_page_pdf_returns_empty_pages_and_no_page_index(client):
    """现状：单页 PDF 走提前返回（total_pages=1, pages=[]），不拆页、无 page_index。

    这条决定了「单页 PDF / Image → sourcePageIndex = 0」在前端是**隐式**得出的
    （fileObj.pageNum 为 null），而非后端给出。Resolver 设计必须知道这里没有 evidence。
    """
    body = _post_split(client, _make_pdf(1)).get_json()
    assert body["total_pages"] == 1
    assert body["pages"] == [], "现状锁定：单页 PDF 不返回任何 page 条目"


# ---------------------------------------------------------------------------
# 事实 4：1-based 的值同时进入 _page_registry（供 /download_page 定位）
# ---------------------------------------------------------------------------

def test_fact_page_registry_stores_one_based_page_number(client):
    """现状：`_page_registry[page_id]["page"]` 存的是 1-based 的 page_num。

    app.py:979 `_page_registry[page_id] = {"doc_id": ..., "page": page_num}`。
    该值被 /download_page 用于定位物理页，因此 base 不是"仅展示用"，
    而是**真实参与寻址**——这也是 M1 不能靠 consumer 各自 ±1 收场的原因。
    """
    pages = _post_split(client, _make_pdf(3)).get_json()["pages"]
    for i, p in enumerate(pages):
        entry = backend_app._page_registry.get(p["page_id"])
        assert entry is not None, f"page_id 未入 registry @ {i}"
        assert entry["page"] == i + 1, (
            "现状锁定：registry 内 page 为 1-based，与 page_index 同源同值"
        )
        assert entry["page"] == p["page_index"], "registry.page 应与 page_index 恒等"
