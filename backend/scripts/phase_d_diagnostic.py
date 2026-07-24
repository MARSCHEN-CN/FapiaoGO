# -*- coding: utf-8 -*-
"""
D-0 契约验证脚本 — 检查真实解析结果的数据契约

用法：
    1. 启动 Flask 后端
    2. 准备一个真实的三页同票 PDF
    3. 运行此脚本

    它会模拟前端分页后的三次 /parse_invoice 调用，
    并验证 PageResultStore + InvoiceAssemblyPipeline 的输出。

依赖：
    pip install requests
"""

import sys
import os
import json

# 添加 backend 目录到路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

try:
    import requests
except ImportError:
    print("请先安装 requests: pip install requests")
    sys.exit(1)

BACKEND_URL = "http://127.0.0.1:5000"

# ═══════════════════════════════════════════
# 辅助函数
# ═══════════════════════════════════════════

def check_field(label, value, expected_type=None, non_empty=False):
    """检查字段类型和内容"""
    if value is None:
        print(f"  ❌ {label}: None")
        return False
    if expected_type and not isinstance(value, expected_type):
        print(f"  ❌ {label}: 期望 {expected_type.__name__}, 实际 {type(value).__name__}")
        return False
    if non_empty and isinstance(value, (str, list, dict)) and len(value) == 0:
        print(f"  ❌ {label}: 为空")
        return False
    print(f"  ✅ {label}: {str(value)[:80]}")
    return True


def print_separator(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


# ═══════════════════════════════════════════
# D-0: 契约验证
# ═══════════════════════════════════════════

print("\n⚠️  本脚本需要在 Flask 后端运行时执行")
print("  确保已经: python backend/app.py")
print("  按 Ctrl+C 继续...\n")

input_file = input("请输入真实三页 PDF 文件路径: ").strip()
if not input_file or not os.path.isfile(input_file):
    print(f"文件不存在: {input_file}")
    sys.exit(1)

file_name = os.path.basename(input_file)

# ── Step 1: Split PDF ──
print_separator("Step 1: 拆分 PDF")
with open(input_file, 'rb') as f:
    resp = requests.post(
        f"{BACKEND_URL}/split_pdf",
        files={'file': (file_name, f, 'application/pdf')},
    )
data = resp.json()
if not data.get('success'):
    print(f"  ❌ 拆分失败: {data}")
    sys.exit(1)

pages = data.get('pages', [])
doc_id = data.get('doc_id', '')
total_pages = len(pages)
print(f"  doc_id: {doc_id}")
print(f"  total_pages: {total_pages}")
print(f"  page_ids: {[p.get('page_index') for p in pages]}")

if total_pages < 2:
    print("  ⚠️  建议使用至少 2 页的 PDF 以验证多页组装")

# ── Step 2: 逐页解析 ──
print_separator("Step 2: 逐页解析")

page_results = []
for i, page in enumerate(pages):
    import base64
    page_bytes = base64.b64decode(page['page_bytes'])
    
    resp = requests.post(
        f"{BACKEND_URL}/parse_invoice",
        files={'file': ('page.pdf', page_bytes, 'application/pdf')},
        data={
            'mode': 'batch',
            'source_doc_id': doc_id,
            'page_num': str(i),
            'total_pages': str(total_pages),
        }
    )
    result = resp.json()
    page_results.append(result)
    
    ef = result.get('invoice_fields') or {}
    inv_no = result.get('invoice_number') or ef.get('fphm', '(无)')
    items = ef.get('line_items', [])
    item_count = len(items) if items else 0
    print(f"  第{i+1}页: invoice={inv_no}, items={item_count}, success={result.get('success', False)}")

# ── Step 3: 验证 PageResultStore ──
print_separator("Step 3: 验证 Store + Assembly 状态")

# 模拟 store 和 assembly（如果后端已按 Phase C 修改）
# 检查返回结果中的关键字段
for i, r in enumerate(page_results):
    print(f"\n  第{i+1}页原始返回字段:")
    ef = r.get('invoice_fields') or {}
    
    has_fphm = check_field('  invoice_fields.fphm', ef.get('fphm'), str, non_empty=True)
    has_line_items = check_field('  invoice_fields.line_items', ef.get('line_items'), list)
    has_gmfmc = check_field('  invoice_fields.gmfmc', ef.get('gmfmc'), str)
    has_xsfmc = check_field('  invoice_fields.xsfmc', ef.get('xsfmc'), str)
    
    # 检查第一页和最后一页的差异
    if i == 0:
        check_field('  invoice_number', r.get('invoice_number'), str)
        check_field('  invoice_type', r.get('invoice_type'), str)
        check_field('  invoice_date', r.get('invoice_date'), str)
    if i == total_pages - 1:
        check_field('  amount (末页)', r.get('amount'), (str, float, int))
        check_field('  extra_fields.amountHj', ef.get('amountHj'))
        check_field('  extra_fields.bz', ef.get('bz'))

    if not has_fphm:
        print(f"  ❌ 第{i+1}页缺少 fphm! assembly 无法获取 invoice_number，分组会失败!")

# ═══════════════════════════════════════════
# 结论
# ═══════════════════════════════════════════

print_separator("D-0 验证结论")

all_have_fphm = all(
    (r.get('invoice_fields') or {}).get('fphm')
    for r in page_results
)

if all_have_fphm:
    print("  ✅ 所有页面都有 fphm → assembly 可正确按 invoice_number 分组")
else:
    print("  ❌ 部分页面缺少 fphm → 需要检查 extractor 是否为续页提取号码")

# 检查 DB 记录数
print(f"\n  检查数据库: 预期 '批量入库完成: 1 条 (新增 1)'")
print(f"  如果看到 '新增 {total_pages} 条' 说明 assembly 路径未生效")
print(f"  可能原因: parseRunner 没有传 source_doc_id/page_num/total_pages")

print(f"\n  日志关键词 grep:")
print(f"    [PageResultStore] - 检查页面是否进入暂存")
print(f"    [InvoiceAssembly] - 检查组装是否触发")
print(f"    [MultiPageMerge] - 检查合并是否执行")
