"""
Patch line_item_extractor.py:
1. Insert token classifier functions after _assign_text_fields
2. Modify _assemble_single_item to use token classification
3. Add _normalize_line_item_text_fields call in output
"""
import re

with open(r'D:\marsprint\print609\backend\field_extractor\extractors\line_item_extractor.py', 'r', encoding='utf-8') as f:
    content = f.read()

# ── 1. Insert token classifier functions ──
# Find the comment block before "_assemble_field"
marker = "# Token 组装"

new_functions = '''# ═════════════════════════════════════════════════
#  垂直明细 token 分类器（P1-4 修复）
# ═════════════════════════════════════════════════

# 规格型号 token 正则
_SPEC_TOKEN_RE = re.compile(
    r'^(?:'
    r'[A-Za-z]{1,5}\\d+[A-Za-z0-9\\-/.]*'      # M4, A4, DN25
    r'|\\d+(?:\\.\\d+)?(?:mm|cm|m|kg|g|ml|L|V|W|A|寸)'  # 3mm, 12V
    r'|\\d+mm|\\d+cm|\\d+m'                            # 20cm, 5m
    r'|φ\\d+(?:\\.\\d+)?(?:mm|cm|m)?'              # φ10, φ2.5mm
    r'|[A-Za-z]\\d+(?:[A-Za-z]*)?'               # M4, B5
    r')$'
)

# 名称尾缀词（短中文，是商品名的一部分）
_NAME_SUFFIX_TOKENS: frozenset[str] = frozenset({
    '头', '绳', '线', '管', '片', '扣', '座',
    '条', '块', '颗', '粒', '根', '支', '把',
    '盒', '瓶', '袋', '桶', '罐', '壶',
    '轮', '圈',
})


def _is_spec_like_token(text: str) -> bool:
    """判断 token 是否像规格型号（M4, 3mm, φ10, DN25 等）"""
    text = text.strip()
    if not text:
        return False
    if text in _COMMON_UNITS:
        return False
    if _RATE_RE.match(text):
        return False
    if _AMOUNT_RE.match(text) or _AMOUNT_LOOSE_RE.match(text):
        return False
    if text in _NAME_SUFFIX_TOKENS:
        return False
    return bool(_SPEC_TOKEN_RE.match(text))


def _is_name_suffix_token(text: str) -> bool:
    """判断 token 是否像名称尾缀（头、绳、管等短中文）"""
    text = text.strip()
    if not text:
        return False
    if text in _COMMON_UNITS:
        return False
    if _is_spec_like_token(text):
        return False
    if _RATE_RE.match(text):
        return False
    if _AMOUNT_RE.match(text) or _AMOUNT_LOOSE_RE.match(text):
        return False
    if re.fullmatch(r'[\\u4e00-\\u9fff]{1,3}', text):
        return True
    return False


def _join_name_parts(parts: list[str]) -> str:
    """拼接商品名称各部件，短中文尾缀直接拼接（不加空格）"""
    result = ''
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if not result:
            result = part
            continue
        # 前一部件以中文结尾、当前部件是短中文（1-3字），直接拼接
        if re.search(r'[\\u4e00-\\u9fff]$', result) and re.fullmatch(r'[\\u4e00-\\u9fff]{1,3}', part):
            result += part
        else:
            result += ' ' + part
    return result.strip()


@dataclass
class LineItemCandidateGroup:
    """垂直明细多行 token 分组，在最终组装为 InvoiceLineItem 之前保留中间状态。"""
    name_lines: list[str] = field(default_factory=list)
    spec_lines: list[str] = field(default_factory=list)
    data_lines: list[str] = field(default_factory=list)
    suffix_lines: list[str] = field(default_factory=list)
    source_line_indices: list[int] = field(default_factory=list)


def _normalize_line_item_text_fields(item: InvoiceLineItem) -> InvoiceLineItem:
    """后处理：修正 xmmc/ggxh 字段中的误拆问题。"""
    item.xmmc = _strip_control_markers(item.xmmc)
    item.ggxh = _strip_control_markers(item.ggxh)

    # 如果 ggxh 末尾包含短中文尾缀，转移到 xmmc
    if item.ggxh:
        parts = item.ggxh.split()
        keep_specs = []
        suffixes = []

        for part in parts:
            if _is_name_suffix_token(part):
                suffixes.append(part)
            else:
                keep_specs.append(part)

        if suffixes:
            item.xmmc = _join_name_parts([item.xmmc] + suffixes)
            item.ggxh = ' '.join(keep_specs)

    # 如果 xmmc 中混入规格，尝试拆出来
    if item.xmmc and not item.ggxh:
        tokens = item.xmmc.split()
        name_tokens = []
        spec_tokens = []
        suffix_tokens = []

        for token in tokens:
            if _is_spec_like_token(token):
                spec_tokens.append(token)
            elif _is_name_suffix_token(token):
                suffix_tokens.append(token)
            else:
                name_tokens.append(token)

        if spec_tokens:
            item.xmmc = _join_name_parts(name_tokens + suffix_tokens)
            item.ggxh = ' '.join(spec_tokens)

    return item


'''

if marker in content:
    # Insert before the "# Token 组装" comment
    content = content.replace(marker, new_functions + '\n' + marker, 1)
    print("[OK] Inserted token classifier functions")
else:
    print("[WARN] Marker 'Token 组装' not found, trying alternate marker")
    # Try to find the exact comment
    for i, line in enumerate(content.split('\n')):
        if 'Token' in line and '组装' in line:
            print(f"  Found at line {i+1}: {repr(line[:80])}")
            break

# ── 2. Modify _assemble_single_item token classification logic ──
old_single = "            if _TOKEN_STAR_CATEGORY_RE.search(stripped):\n                name_parts.append(stripped)\n                continue\n            if amount_values or rate_value:\n                spec_parts.append(stripped)\n            else:\n                name_parts.append(stripped)"

new_single = """            if _TOKEN_STAR_CATEGORY_RE.search(stripped):
                name_parts.append(stripped)
                continue
            # 使用 token 分类器判断，而非仅看是否已出现数据
            if _is_spec_like_token(stripped):
                spec_parts.append(stripped)
            elif _is_name_suffix_token(stripped) and not (amount_values or rate_value):
                # 数据出现前的短中文尾缀 → 名称
                name_parts.append(stripped)
            elif _is_name_suffix_token(stripped) and (amount_values or rate_value):
                # 数据出现后的短中文尾缀 → 优先作为名称尾缀，不进规格
                name_parts.append(stripped)
            elif not (amount_values or rate_value):
                name_parts.append(stripped)
            else:
                spec_parts.append(stripped)"""

if old_single in content:
    content = content.replace(old_single, new_single, 1)
    print("[OK] Modified _assemble_single_item token logic")
else:
    print("[WARN] Could not find _assemble_single_item logic to replace")
    # Debug: show what's around that area
    for i, line in enumerate(content.split('\n')):
        if '_TOKEN_STAR_CATEGORY_RE.search(stripped)' in line:
            print(f"  Found at line {i+1}")
            break

# ── 3. Add _normalize_line_item_text_fields call after item.je check ──
old_normalize = "        if item.je:\n            adj = _post_process(item, 0)\n            adjustments.extend(adj)"

new_normalize = """        if item.je:
            item = _normalize_line_item_text_fields(item)
            adj = _post_process(item, 0)
            adjustments.extend(adj)"""

if old_normalize in content:
    content = content.replace(old_normalize, new_normalize, 1)
    print("[OK] Added _normalize_line_item_text_fields call in _assemble_single_item")
else:
    print("[WARN] Could not find _post_process call in _assemble_single_item to patch")

# ── 4. Also patch _assemble_multi_items if it has similar logic ──
old_multi = "                    if amount_values or rate_value:\n                        spec_parts.append(g.strip())\n                    else:\n                        name_parts.append(g.strip())"

new_multi = """                    if _is_spec_like_token(g.strip()):
                        spec_parts.append(g.strip())
                    elif _is_name_suffix_token(g.strip()) and not (amount_values or rate_value):
                        name_parts.append(g.strip())
                    elif _is_name_suffix_token(g.strip()) and (amount_values or rate_value):
                        name_parts.append(g.strip())
                    elif not (amount_values or rate_value):
                        name_parts.append(g.strip())
                    else:
                        spec_parts.append(g.strip())"""

if old_multi in content:
    content = content.replace(old_multi, new_multi, 1)
    print("[OK] Modified _assemble_multi_items token logic")
else:
    print("[INFO] Could not find _assemble_multi_items logic (may use different structure)")

# ── Write back ──
with open(r'D:\marsprint\print609\backend\field_extractor\extractors\line_item_extractor.py', 'w', encoding='utf-8') as f:
    f.write(content)

print("\n[OK] All patches applied successfully")
