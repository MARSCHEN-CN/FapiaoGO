import requests
import os

url = "http://localhost:5000/api/export-excel-sse"
payload = {
    "filePath": os.path.join(os.getcwd(), "test_export_full.xlsx"),
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
print("发送导出请求...")
print("保存路径:", payload["filePath"])
r = requests.post(url, json=payload, headers=headers)
print("HTTP 状态码:", r.status_code)
if r.status_code == 200:
    print("导出成功！文件已保存为:", payload["filePath"])
    print("请手动打开该文件检查内容")
else:
    print("错误响应:", r.text[:300])
