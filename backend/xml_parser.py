import io
import re
import xml.etree.ElementTree as ET

from field_extractor import normalize_invoice_type


def find_text_in_xml(root, tags):
    for tag in tags:
        element = root.find('.//' + tag)
        if element is not None and element.text:
            return element.text.strip()
    for element in root.iter():
        tag_name = element.tag
        if isinstance(tag_name, str) and any(tag_name.lower().endswith(t.lower()) for t in tags):
            if element.text:
                return element.text.strip()
    return None


def extract_xml_fragment(text):
    if '<?xml' in text:
        xml_start = text.index('<?xml')
        text = text[xml_start:]
    match = re.search(r'(<(Invoice)[\s\S]*?</\2>)', text)
    if match:
        return match.group(1)
    return text


def parse_xml(file):
    file.seek(0)
    raw = file.read()
    content = raw.decode(errors='ignore')
    xml_fragment = extract_xml_fragment(content)

    try:
        root = ET.fromstring(xml_fragment)
        invoice_number = find_text_in_xml(root, ['InvoiceNo', 'InvoiceCode', 'Fphm'])
        amount = find_text_in_xml(root, ['TotalAmount', 'Jshj', 'Amount', 'Total'])
        invoice_type_raw = find_text_in_xml(root, ['InvoiceType', 'FpType', 'InvoiceTypeName', 'Type'])
        invoice_date_raw = find_text_in_xml(root, ['InvoiceDate', 'IssueDate', 'Date', 'Kprq', 'FpDate'])

        if not invoice_number and not amount:
            print("  parse_xml: XML中未找到发票字段，跳过", flush=True)
            return None

        invoice_type = normalize_invoice_type(invoice_type_raw)

        invoice_date = '未知日期'
        if invoice_date_raw:
            cleaned_date = invoice_date_raw.replace('年', '-').replace('月', '-').replace('日', '').replace('号', '')
            m = re.match(r'(\d{4})[-/](\d{1,2})[-/](\d{1,2})', cleaned_date)
            if m:
                invoice_date = f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"

        return {
            "invoice_number": invoice_number,
            "amount": amount,
            "invoice_type": invoice_type,
            "invoice_date": invoice_date,
            "text": xml_fragment
        }
    except Exception:
        return None
