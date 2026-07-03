import requests
import json

url = "http://localhost:5000/api/export-excel-sse"
payload = {
    "invoices": [
        {
            "invoiceFields": {
                "type": "专票",
                "fphm": "25317200000084187224",
                "kprq": "2025-12-05",
                "amountHj": "19.90",
                "gmfmc": "广州华栈天城科技有限公司",
                "gmfsh": "91440106068698695J",
                "xsfmc": "上海公牛电器有限公司",
                "xsfsh": "91310112631148271Y",
                "amountJe": "17.61",
                "amountSe": "2.29",
                "amountHjDx": "壹拾玖元玖角",
                "note": "订单号:344902686248"
            }
        }
    ],
    "format": "xlsx"
}

headers = {"Content-Type": "application/json"}
print("发送请求...")
r = requests.post(url, json=payload, headers=headers, stream=True)
print("Status:", r.status_code)
if r.status_code == 200:
    with open("test_export.xlsx", "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)
    print("导出成功！文件已保存为 test_export.xlsx")
else:
    print("错误响应:", r.text[:300])