import os

# OCR 结果缓存目录 - 位于项目根目录的 database 文件夹下
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)
DATABASE_DIR = os.path.join(PROJECT_ROOT, 'database')
OCR_CACHE_DIR = os.path.join(DATABASE_DIR, '.ocr_cache')
try:
    os.makedirs(OCR_CACHE_DIR, exist_ok=True)
except OSError as e:
    print(f"警告: 无法创建缓存目录 {OCR_CACHE_DIR}: {e}")

# 最多缓存的文件数量
OCR_CACHE_MAX_SIZE = 1000

# 缓存总容量限制（字节）- 500 MB
OCR_CACHE_MAX_BYTES = 500 * 1024 * 1024

# 缓存过期天数
OCR_CACHE_EXPIRE_DAYS = 7

# 各 namespace 版本号（可独立失效）
# 格式: {日期}_{版本标识}_{功能描述}
# 示例: '20260608_v10_perf_optim'
CACHE_VERSIONS = {
    # PDF 文本提取缓存版本
    'pdf_text': '20260608_v9_text_extract',
    
    # OCR 识别缓存版本
    'ocr': '20260608_v9_ocr_engine',
    
    # 字段提取缓存版本
    'fields': '20260608_v9_field_extractor',
    
    # 预览图缓存版本
    'preview': '20260608_v1_preview',
}

# 缓存参数键名（用于生成缓存 key）
CACHE_PARAMS = {
    'auto_orient': 'orient',
    'force_ocr': 'force',
    'dpi': 'dpi',
    'lang': 'lang',
    'engine_version': 'engine',
}

# 是否启用缓存（可通过环境变量覆盖）
ENABLE_CACHE = os.environ.get('ENABLE_CACHE', '1') == '1'

# 是否启用详细缓存日志  修改后（默认启用调试）
CACHE_DEBUG = os.environ.get('CACHE_DEBUG', '1') == '1'
