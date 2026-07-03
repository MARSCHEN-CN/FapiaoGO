"""
OFD 发票解析
parse_ofd() - 提取发票数据和预览图片
"""
import base64
import io
import re
import xml.etree.ElementTree as ET

from PIL import Image as PILImage

from .xml_utils import _strip_ofd_ns
from .ofd_page_render import render_ofd_page_preview


def _find_text_in_xml(root, tag_names):
    """在 XML 树中查找匹配标签的文本"""
    for elem in root.iter():
        tag = elem.tag.split('}')[-1] if '}' in elem.tag else elem.tag
        if tag in tag_names and elem.text:
            return elem.text.strip()
    return None


def _normalize_invoice_type(type_str):
    """标准化发票类型名称"""
    if not type_str:
        return '其他'
    s = type_str.strip()
    type_map = {
        '增值税专用发票': '增值税专用发票',
        '专票': '增值税专用发票',
        '增值税普通发票': '增值税普通发票',
        '普票': '增值税普通发票',
        '全电发票': '全电发票',
        '电子发票': '全电发票',
        '机动车销售统一发票': '机动车销售统一发票',
        '机动车': '机动车销售统一发票',
    }
    for key, value in type_map.items():
        if key in s:
            return value
    return '其他'


def _extract_fields_legacy(text):
    """从文本中提取发票类型、号码、金额、日期（回退方案）"""
    inv_type = '其他'
    inv_number = '未知号码'
    amt = '0.00'
    inv_date = '未知日期'

    if '增值税专用发票' in text:
        inv_type = '增值税专用发票'
    elif '增值税普通发票' in text:
        inv_type = '增值税普通发票'
    elif '电子发票' in text:
        inv_type = '全电发票'
    elif '机动车' in text:
        inv_type = '机动车销售统一发票'

    m = re.search(r'(?:发票号码|No[：:]\s*)(\d+)', text)
    if m:
        inv_number = m.group(1)

    m = re.search(r'[¥￥]\s*([\d,]+\.\d{2})', text)
    if m:
        amt = m.group(1).replace(',', '')

    m = re.search(r'(\d{4})年(\d{1,2})月(\d{1,2})日', text)
    if m:
        inv_date = f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"

    return inv_type, inv_number, amt, inv_date


def parse_ofd(file):
    """解析 OFD 文件：提取发票数据和预览图片"""
    import zipfile

    file.seek(0)
    raw = file.read()

    result = {
        "invoice_type": "其他",
        "invoice_number": "未知号码",
        "amount": "0.00",
        "invoice_date": "未知日期",
        "text": "",
        "preview_image": None
    }

    try:
        with zipfile.ZipFile(io.BytesIO(raw), 'r') as zf:
            all_names = zf.namelist()

            # 步骤 1：预览图片
            best_img_data = None
            best_img_pixels = 0
            for name in all_names:
                nl = name.lower()
                if nl.endswith(('.png', '.jpg', '.jpeg', '.bmp')):
                    try:
                        img_data = zf.read(name)
                        with PILImage.open(io.BytesIO(img_data)) as test_img:
                            w, h = test_img.size
                            pixels = w * h
                            if pixels > best_img_pixels:
                                best_img_data = img_data
                                best_img_pixels = pixels
                    except Exception:
                        continue

            rendered_img = render_ofd_page_preview(raw, dpi=150)
            if rendered_img:
                buf = io.BytesIO()
                rendered_img.save(buf, format='JPEG', quality=85, optimize=True)
                result["preview_image"] = base64.b64encode(buf.getvalue()).decode('utf-8')
            elif best_img_data and best_img_pixels > 10000:
                result["preview_image"] = base64.b64encode(best_img_data).decode('utf-8')

            # 步骤 2：搜索发票 XML
            invoice_xml = None
            for name in all_names:
                if not name.lower().endswith('.xml'):
                    continue
                try:
                    content = zf.read(name).decode('utf-8', errors='ignore')
                    if re.search(r'<(Invoice|Fphm|InvoiceNo|TotalAmount|Jshj)', content):
                        invoice_xml = content
                        print(f"OFD中找到发票XML: {name}")
                        break
                except Exception:
                    continue

            # 步骤 3：解析发票 XML
            if invoice_xml:
                try:
                    root = ET.fromstring(invoice_xml)
                    invoice_number = _find_text_in_xml(root, ['InvoiceNo', 'InvoiceCode', 'Fphm'])
                    amount = _find_text_in_xml(root, ['TotalAmount', 'Jshj', 'Amount', 'Total'])
                    invoice_type_raw = _find_text_in_xml(root, ['InvoiceType', 'FpType',
                                                                 'InvoiceTypeName', 'Type'])
                    invoice_date_raw = _find_text_in_xml(root, ['InvoiceDate', 'IssueDate',
                                                                 'Date', 'Kprq'])

                    result["invoice_type"] = _normalize_invoice_type(invoice_type_raw)
                    result["invoice_number"] = invoice_number or '未知号码'
                    result["amount"] = amount or '0.00'

                    if invoice_date_raw:
                        cleaned = (invoice_date_raw
                                   .replace('年', '-').replace('月', '-')
                                   .replace('日', '').replace('号', ''))
                        m = re.match(r'(\d{4})[-/](\d{1,2})[-/](\d{1,2})', cleaned)
                        if m:
                            result["invoice_date"] = (
                                f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"
                            )

                    result["text"] = invoice_xml[:2000]
                    return result
                except Exception as e:
                    print(f"OFD XML解析失败: {e}")

            # 步骤 4：CustomTag.xml
            custom_tag_xml = None
            for name in all_names:
                nl = name.lower()
                if 'customtag' in nl and nl.endswith('.xml'):
                    try:
                        custom_tag_xml = zf.read(name).decode('utf-8', errors='ignore')
                        break
                    except Exception:
                        continue

            if custom_tag_xml:
                try:
                    tag_clean = _strip_ofd_ns(custom_tag_xml)
                    tag_root = ET.fromstring(tag_clean)
                    tag_texts = {}
                    for elem in tag_root.iter():
                        tag_name = (elem.tag.split('}')[-1]
                                    if '}' in elem.tag else elem.tag)
                        if elem.text and elem.text.strip():
                            tag_texts[tag_name] = elem.text.strip()

                    tag_all_text = ' '.join(tag_texts.values())
                    if tag_all_text.strip():
                        inv_type, inv_number, amt, inv_date = _extract_fields_legacy(tag_all_text)
                        if inv_type != '其他':
                            result["invoice_type"] = inv_type
                        if inv_number != '未知号码':
                            result["invoice_number"] = inv_number
                        if amt != '0.00':
                            result["amount"] = amt
                        if inv_date != '未知日期':
                            result["invoice_date"] = inv_date
                except Exception as e:
                    print(f"CustomTag 解析失败: {e}")

            # 步骤 5：从 Content.xml 提取文本
            all_text = ""
            for name in all_names:
                if not name.lower().endswith('.xml'):
                    continue
                try:
                    content = zf.read(name).decode('utf-8', errors='ignore')

                    try:
                        content_clean = _strip_ofd_ns(content)
                        xml_root = ET.fromstring(content_clean)

                        text_objects = []
                        for elem in xml_root.iter():
                            tag = (elem.tag.split('}')[-1]
                                   if '}' in elem.tag else elem.tag)
                            if tag == 'TextObject':
                                boundary = elem.get('Boundary', '')
                                obj_parts = []
                                for tc in elem.iter():
                                    tc_tag = (tc.tag.split('}')[-1]
                                              if '}' in tc.tag else tc.tag)
                                    if tc_tag == 'TextCode' and tc.text and tc.text.strip():
                                        obj_parts.append(tc.text)
                                if obj_parts:
                                    y_pos = 0.0
                                    b_parts = boundary.strip().split()
                                    if len(b_parts) >= 2:
                                        try:
                                            y_pos = float(b_parts[1])
                                        except ValueError:
                                            pass
                                    text_objects.append((''.join(obj_parts), y_pos))

                        if text_objects:
                            lines = []
                            current_line_y = text_objects[0][1]
                            current_line_parts = []
                            unit = 0.01 if any(t[1] > 500 for t in text_objects) else 1.0
                            threshold = 2.0 * unit

                            for text, y in text_objects:
                                if abs(y - current_line_y) > threshold:
                                    lines.append(''.join(current_line_parts))
                                    current_line_parts = []
                                    current_line_y = y
                                current_line_parts.append(text)

                            if current_line_parts:
                                lines.append(''.join(current_line_parts))

                            all_text += '\n'.join(lines) + '\n'
                            continue

                    except ET.ParseError:
                        pass

                    text_parts = re.findall(r'<TextCode[^>]*>([^<]+)</TextCode>', content)
                    if text_parts:
                        all_text += ''.join(text_parts) + '\n'

                except Exception:
                    continue

            if all_text.strip():
                result["text"] = all_text[:2000]
                inv_type, inv_number, amt, inv_date = _extract_fields_legacy(all_text)
                if inv_type != '其他':
                    result["invoice_type"] = inv_type
                if inv_number != '未知号码':
                    result["invoice_number"] = inv_number
                if amt != '0.00':
                    result["amount"] = amt
                if inv_date != '未知日期':
                    result["invoice_date"] = inv_date

            return result

    except zipfile.BadZipFile:
        print("OFD文件不是有效的ZIP格式")
        return result
    except Exception as e:
        print(f"OFD解析错误: {e}")
        return result
