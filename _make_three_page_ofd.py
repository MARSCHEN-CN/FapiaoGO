# -*- coding: utf-8 -*-
"""
合成 3 页 OFD 测试夹具（Step 0, OFD R1 前置）。
位置: test_fixtures/multi-page-ofd/three-page.ofd
结构: 3 页 A4 竖版(210x297mm), 每页一个不同颜色 ImageObject(红/绿/蓝), 逐页可辨识。
用途: 仅测 page identity / page count / raster page iteration, 非发票业务内容。
"""
import io
import os
import sys
import zipfile
import uuid

from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), 'test_fixtures', 'multi-page-ofd', 'three-page.ofd')
OUT = os.path.abspath(OUT)

NS = 'xmlns:ofd="http://www.ofdspec.org/2016"'

OFD_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    f'<ofd:OFD {NS} Version="1.0" DocType="OFD">'
    '<ofd:DocBody><ofd:DocInfo>'
    f'<ofd:DocID>{uuid.uuid4().hex}</ofd:DocID>'
    '<ofd:CreationDate>2026-08-21</ofd:CreationDate>'
    '<ofd:Creator>print706-test-fixture</ofd:Creator>'
    '</ofd:DocInfo>'
    '<ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>'
    '</ofd:DocBody></ofd:OFD>'
)

DOCUMENT_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    f'<ofd:Document {NS} DocType="OFD" Version="1.0">'
    '<ofd:CommonData>'
    '<ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox>'
    '<ofd:ApplicationBox>0 0 210 297</ofd:ApplicationBox></ofd:PageArea>'
    '<ofd:DocumentRes>DocumentRes.xml</ofd:DocumentRes>'
    '</ofd:CommonData>'
    '<ofd:Pages>'
    '<ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/>'
    '<ofd:Page ID="2" BaseLoc="Pages/Page_1/Content.xml"/>'
    '<ofd:Page ID="3" BaseLoc="Pages/Page_2/Content.xml"/>'
    '</ofd:Pages>'
    '</ofd:Document>'
)

DOCUMENT_RES_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    f'<ofd:DocumentRes {NS}>'
    '<ofd:MultiMedia ID="IM0" Type="Image" Format="image/png">'
    '<ofd:MediaFile>Res/page_marker_0.png</ofd:MediaFile></ofd:MultiMedia>'
    '<ofd:MultiMedia ID="IM1" Type="Image" Format="image/png">'
    '<ofd:MediaFile>Res/page_marker_1.png</ofd:MediaFile></ofd:MultiMedia>'
    '<ofd:MultiMedia ID="IM2" Type="Image" Format="image/png">'
    '<ofd:MediaFile>Res/page_marker_2.png</ofd:MediaFile></ofd:MultiMedia>'
    '</ofd:DocumentRes>'
)

def content_xml(rid):
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<ofd:Page {NS}>'
        '<ofd:Area>'
        '<ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox>'
        '<ofd:ApplicationBox>0 0 210 297</ofd:ApplicationBox>'
        '</ofd:Area>'
        '<ofd:Content><ofd:Layer Type="Body" ID="0"><ofd:PageBlock ID="1">'
        f'<ofd:ImageObject ID="10" ResourceID="{rid}" '
        'Boundary="0 0 210 297" CTM="210 0 0 297 0 0"/>'
        '</ofd:PageBlock></ofd:Layer></ofd:Content>'
        '</ofd:Page>'
    )

def make_marker_png(rgb):
    """32x32 纯色 PNG, 上边缘画一条黑线用于方向/内容辨识。"""
    img = Image.new('RGB', (32, 32), rgb)
    px = img.load()
    for x in range(32):
        px[x, 0] = (0, 0, 0)          # 顶边黑线
        px[x, 4] = (255, 255, 255)    # 4px 白线, 区分页方向
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()

def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    markers = [(255, 0, 0), (0, 180, 0), (0, 0, 255)]
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('OFD.xml', OFD_XML)
        z.writestr('Doc_0/Document.xml', DOCUMENT_XML)
        z.writestr('Doc_0/DocumentRes.xml', DOCUMENT_RES_XML)
        for i, rgb in enumerate(markers):
            z.writestr(f'Doc_0/Res/page_marker_{i}.png', make_marker_png(rgb))
            z.writestr(f'Doc_0/Pages/Page_{i}/Content.xml', content_xml(f'IM{i}'))
    print('WROTE', OUT, os.path.getsize(OUT), 'bytes')

if __name__ == '__main__':
    main()
