## 项目结构
项目采用前后端分离与桌面应用集成的混合架构：
- 前端（React/Vite）：负责用户界面、文件拖拽与预览、搜索与排序、重命名打包、打印与导出等。
- 后端（Flask + Python）：提供发票解析接口、OCR 引擎、字段提取、缓存与数据库读取。
- Electron：封装桌面应用、IPC 通信、文件对话框、打印窗口、Excel 导出、设置窗口等。
## 核心组件
- 解析服务层：统一调度 PDF、OFD、图片，调用 OCR 补充文本，提取结构化字段，构建数据库记录。
- OCR 引擎：基于 RapidOCR 与 ONNX Runtime，支持 GPU/CPU 执行提供者，缓存加速。
- OCR模型：PP-OCRv6_det_small、PP-OCRv6_rec_small
- PDF 统一解析：先文本提取，不足时首页 OCR 补充，再统一字段提取。
- 图片 OCR：支持自动方向纠正，缓存 OCR 结果，避免重复计算。
- 数据库读取：只读 JSON 存储，提供发票检索、统计与配置读取。
- 前端应用：文件列表、搜索过滤、预览缩放、打印、重命名打包、Excel 导出。
- Electron 主进程：窗口管理、IPC 通信、文件对话框、打印设置、Excel 导出、设置窗口。

## 界面预览
<img width="1208" height="808" alt="image" src="https://github.com/user-attachments/assets/c714439c-4a29-4006-97b0-91e95cf102e1" />
<img width="1205" height="805" alt="image" src="https://github.com/user-attachments/assets/c7e6f2bd-ba54-4f58-b5fe-dfb80120decc" />
<img width="1200" height="800" alt="image" src="https://github.com/user-attachments/assets/f3f396dc-caf2-4cc3-88a1-f2e5fb4f52af" />



