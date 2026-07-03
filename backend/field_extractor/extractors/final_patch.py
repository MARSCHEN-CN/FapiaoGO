"""
Final patch: add _normalize_line_item_text_fields calls to _assemble_multi_items
"""
import re

with open(r'D:\marsprint\print609\backend\field_extractor\extractors\line_item_extractor.py', 'r', encoding='utf-8') as f:
    content = f.read()

count = 0

# ── Fix 1: add _normalize call before items.append(item) in _assemble_multi_items ──
# Match the line "                items.append(item)" that appears after _post_process in _assemble_multi_items
# We need to find the right one (not in _assemble_single_item)

# Strategy: find "_assemble_multi_items" then patch the items.append inside it
marker = 'def _assemble_multi_items'
idx = content.find(marker)
if idx > 0:
    # Find the items.append(item) after _post_process in this function
    # Look for "                adj = _post_process(item, len(items))"
    sub = content[idx:]
    # Find all occurrences
    pattern = '                adj = _post_process(item, len(items))\n'
    pos = sub.find(pattern)
    if pos > 0:
        actual_pos = idx + pos
        # Check if _normalize is already there
        check = sub[pos:pos+200]
        if '_normalize_line_item_text_fields' not in check:
            # Insert after "                adj = _post_process(item, len(items))\n"
            old = '                adj = _post_process(item, len(items))\n                adjustments.extend(adj)\n'
            new = '                item = _normalize_line_item_text_fields(item)\n                adj = _post_process(item, len(items))\n                adjustments.extend(adj)\n'
            if old in sub:
                sub = sub.replace(old, new, 1)
                content = content[:idx] + sub
                print("[OK] Added _normalize before items.append(item) in _assemble_multi_items")
                count += 1
            else:
                print("[WARN] Pattern not found for _post_process in _assemble_multi_items")
        else:
            print("[INFO] _normalize already present before items.append(item)")
            count += 1
    else:
        print("[WARN] Could not find _post_process call in _assemble_multi_items")
else:
    print("[ERROR] _assemble_multi_items function not found")

# ── Fix 2: add _normalize call for discount_item too ──
marker2 = '                adj = _post_process(discount_item, len(items))\n'
if marker2 in content:
    # Check if already patched
    idx2 = content.find(marker2)
    check2 = content[idx2:idx2+200]
    if '_normalize_line_item_text_fields' not in check2:
        old2 = '                adj = _post_process(discount_item, len(items))\n                adjustments.extend(adj)\n'
        new2 = '                discount_item = _normalize_line_item_text_fields(discount_item)\n                adj = _post_process(discount_item, len(items))\n                adjustments.extend(adj)\n'
        if old2 in content:
            content = content.replace(old2, new2, 1)
            print("[OK] Added _normalize for discount_item")
            count += 1
        else:
            print("[WARN] Pattern not found for discount_item _post_process")
    else:
        print("[INFO] _normalize already present for discount_item")
        count += 1
else:
    print("[INFO] discount_item _post_process not found (may use different code)")

# ── Fix 3: fix _join_name_parts to handle __SUFFIX__ marker ──
# In _assemble_multi_items Step 6, we stored suffix as "__SUFFIX__: xxx"
# Need to handle it when building xmmc
# This is already done in the __SUFFIX__ handling we added earlier

# ── Write back ──
if count > 0:
    with open(r'D:\marsprint\print609\backend\field_extractor\extractors\line_item_extractor.py', 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"\n[OK] Wrote back with {count} changes")
else:
    print("\n[INFO] No changes needed or all already patched")
