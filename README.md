<img width="1672" height="941" alt="image" src="https://github.com/user-attachments/assets/2d58957b-0af3-477c-a1fd-c341fde02a26" />



# FapiaoGO

发票解析、管理与打印一体化桌面应用。

## 项目概览

FapiaoGO 是一个基于 Electron 的桌面应用，支持 PDF/OFD/图片格式的发票智能解析、结构化字段提取、预览打印、批量重命名打包与 Excel 导出。

| 维度     | 技术栈                               |
| ------ | --------------------------------- |
| 桌面框架   | Electron43.1.0 + Node.js                |
| 前端     | React 19.2 + Vite8.1 + CSS（无 UI 框架）  |
| 后端 API | Flask (Python 3.11+)              |
| OCR 引擎 | RapidOCR + ONNX Runtime（PP-OCRv6） |
| 数据存储   | JSON oplog + 定期压缩                 |
| 打包分发   | electron-builder (NSIS)           |

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│                     Electron Main Process                    │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌────────────┐ │
│  │ 窗口管理  │  │ IPC 通信  │  │ 打印服务   │  │ 文件对话框  │ │
│  └──────────┘  └──────────┘  └───────────┘  └────────────┘ │
│                     OsLauncherBridge → SumatraPDF             │
├──────────────────────────────────────────────────────────────┤
│                     Renderer (React SPA)                      │
│  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌───────────┐ │
│  │ 文件管理  │  │ 预览画布    │  │ 打印设置  │  │ 设置窗口   │ │
│  └──────────┘  └────────────┘  └──────────┘  └───────────┘ │
│              HTTP REST API (localhost:5000)                   │
├──────────────────────────────────────────────────────────────┤
│                     Flask Backend                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  Parser Registry                       │  │
│  │  XML → OFD → PDF(Text) → PDF(OCR) → Image(OCR)       │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ OCR 引擎  │  │ 字段提取管线  │  │ 渲染引擎 (Render)     │  │
│  └──────────┘  └──────────────┘  └──────────────────────┘  │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ 数据存储  │  │ 决策路由器    │  │ Excel 导出            │  │
│  └──────────┘  └──────────────┘  └──────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## 核心模块

### Backend — 发票解析管线

```
文件上传 → 格式检测 → ParserRegistry 调度
    ├── XML: 结构化直接解析
    ├── OFD: OFD 解包 → 文本/图片提取
    ├── PDF(Text): fitz 文本提取 → 含文本层直接解析
    ├── PDF(OCR): 文本不足 → 转图片 → OCR → 字段提取
    └── Image: 方向校正 → OCR → 字段提取
                        ↓
              字段提取 (field_extractor)
    ┌─────────────────────────────────────┐
    │ 布局解析 → 区域划分 → 锚点匹配       │
    │ 候选生成 → 解析/校验 → 最终清理       │
    └─────────────────────────────────────┘
                        ↓
              DecisionRouter 路由
         export_ready / review_queue
```

#### 关键模块

| 模块       | 路径                                    | 说明                      |
| -------- | ------------------------------------- | ----------------------- |
| Flask 入口 | `backend/app.py`                      | REST API 路由、SSE 进度推送    |
| 解析器注册表   | `backend/parsers/`                    | 插件化解析器，按优先级调度           |
| OCR 引擎   | `backend/ocr_engine.py`               | RapidOCR 封装，GPU/CPU 自适应 |
| 字段提取     | `backend/field_extractor/`            | 布局区域划分 + 多策略字段提取        |
| 渲染引擎     | `backend/render_engine/`              | 文档预览缩略图生成               |
| 数据存储     | `backend/db.py`                       | JSON oplog + 定期全量压缩     |
| 缓存       | `backend/cache.py`                    | 命名空间分级缓存，TTL + 容量限制     |
| 决策路由     | `backend/services/decision_router.py` | 校验结果路由（就绪/人工审核）         |

### Frontend — React SPA

组件以 Hooks 模式组织，核心状态由 `FileContext` 统一管理：

| 组件                   | 说明               |
| -------------------- | ---------------- |
| `App.jsx`            | 顶层路由，懒加载弹窗组件     |
| `Sidebar.jsx`        | 文件列表、搜索、排序、多选    |
| `PreviewCanvas.jsx`  | PDF 预览画布，支持缩放/旋转 |
| `ActionBar.jsx`      | 底部操作栏（打印/打包/导出）  |
| `InvoiceDetail.jsx`  | 发票字段详情面板         |
| `SettingsWindow.jsx` | 打印/重命名/主题设置      |
| `TopBar.jsx`         | 顶部工具栏与菜单         |

自定义 Hooks：

| Hook                   | 说明                                    |
| ---------------------- | ------------------------------------- |
| `usePreview`           | 预览渲染（render engine / pdf.js fallback） |
| `usePrint`             | 打印管线（源文件 → SumatraPDF）                |
| `useFileOps`           | 文件导入/删除/去重                            |
| `useRenamePack`        | 批量重命名 + 打包                            |
| `useExport`            | Excel 导出                              |
| `useKeyboardShortcuts` | 全局快捷键                                 |
| `useSort`              | 列表排序（时间/金额/名称/类型）                     |

### Electron — 桌面壳

| 模块                | 说明                           |
| ----------------- | ---------------------------- |
| `main.js`         | Electron 主进程入口，窗口/菜单/PDF方向检测 |
| `ipc-file-ops.js` | 文件对话框、拖拽导入、临时文件清理            |
| `ipc-rename.js`   | 批量重命名 IPC                    |
| `ipc-pack.js`     | 压缩包生成 IPC                    |
| `print-service/`  | 打印服务管线                       |

#### 打印架构 — OS Trust Delegation

```
JS Domain (untrusted)          OS Domain (trusted)
┌──────────────────────┐      ┌──────────────────┐
│ PrintJobEmitter       │ ───→ │ OsLauncherBridge │
│   submit(payload)     │      │   verify binary   │
│   ❌ no execFile      │      │   → SumatraPDF    │
│   ❌ no binary paths  │      │   → spooler       │
└──────────────────────┘      └──────────────────┘
```

架构锁定 (`electron/architecture/ARCHITECTURE_LOCK.md`)：单一渲染契约，运行时 + 构建时双重守卫，禁止任何第二布局解释器。

## 快速开始

### 环境要求

- Python 3.11+
- Node.js 20+
- Windows 10/11

### 安装

```bash
# 克隆仓库
git clone <repo-url>
cd FapiaoGO

# 安装前端依赖
cd frontend
npm install

# 安装 Electron 依赖
cd ../electron
npm install

# 安装 Python 依赖
cd ../backend
pip install -r requirements.txt
```

### 开发运行

```bash
# 终端 1：启动 Flask 后端 (端口 5000)
cd backend
python app.py

# 终端 2：启动 Vite 开发服务器 + Electron
cd electron
npm run dev
```

### 构建

```bash
npm run build        # 构建前端
npm run dist         # electron-builder 打包
```

## API 概览

| 端点                        | 方法             | 说明                 |
| ------------------------- | -------------- | ------------------ |
| `/api/invoice/parse`      | POST           | 上传发票并解析，返回 SSE 进度流 |
| `/api/invoice/parse-sync` | POST           | 同步解析模式             |
| `/api/db/invoices`        | GET            | 查询发票列表（支持搜索/排序/分页） |
| `/api/db/invoice/<id>`    | GET/PUT/DELETE | 发票 CRUD            |
| `/api/db/config`          | GET/PUT        | 应用配置               |
| `/api/db/stats`           | GET            | 统计信息               |
| `/preview/<doc_id>`       | GET            | 文档预览图（ETag/304 缓存） |
| `/thumbnail/<doc_id>`     | GET            | 文档缩略图              |
| `/api/documents/open`     | POST           | 注册文档               |
| `/api/export/excel`       | POST           | 导出 Excel           |

## OCR 模型

| 模型                 | 用途   |
| ------------------ | ---- |
| PP-OCRv6_det_small | 文字检测 |
| PP-OCRv6_rec_small | 文字识别 |

模型自动下载至 `C:\Users\<用户名>\.rapidocr\`。

## 项目结构

```

├── backend/                    # Flask 后端
│   ├── app.py                  # API 路由入口
│   ├── config.py               # 配置（缓存/路径）
│   ├── db.py                   # JSON 数据存储
│   ├── cache.py                # 缓存管理
│   ├── ocr_engine.py           # OCR 引擎封装
│   ├── layout_parser.py        # 布局解析器
│   ├── excel_exporter.py       # Excel 导出
│   ├── parse_job_manager.py    # 解析任务队列
│   ├── parsers/                # 解析器插件
│   ├── field_extractor/        # 字段提取管线
│   ├── render_engine/          # 渲染引擎
│   ├── services/               # 业务服务层
│   ├── ofd_parser/             # OFD 解析
│   └── tests/                  # 后端测试
├── frontend/                   # React 前端
│   └── src/
│       ├── App.jsx             # 应用入口
│       ├── config.js           # 前端配置
│       ├── components/         # UI 组件
│       ├── hooks/              # 自定义 Hooks
│       ├── contexts/           # React Context
│       └── utils/              # 工具函数
├── electron/                   # Electron 主进程
│   ├── main.js                 # 主进程入口
│   ├── ipc-*.js                # IPC 处理器
│   ├── print-service/          # 打印服务
│   ├── architecture/           # 架构守卫
│   └── shared/                 # 共享模块
├── database/                   # 数据 & 缓存目录
├── scripts/                    # 构建/工具脚本
├── tests/                      # 集成测试
├── resources/                  # 打包资源（图标/SumatraPDF）
├── electron-builder.yml        # 打包配置
└── package.json                # 根 package.json

```



## 界面预览

<img width="1208" height="808" alt="image" src="https://github.com/user-attachments/assets/c714439c-4a29-4006-97b0-91e95cf102e1" />

<img width="1205" height="805" alt="image" src="https://github.com/user-attachments/assets/c7e6f2bd-ba54-4f58-b5fe-dfb80120decc" />

<img width="1200" height="800" alt="image" src="https://github.com/user-attachments/assets/f3f396dc-caf2-4cc3-88a1-f2e5fb4f52af" />
