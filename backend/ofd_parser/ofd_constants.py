"""
OFD 页面渲染 — 模块级常量、正则表达式、工具函数
"""
import re
import os
import pathlib
import logging

from PIL import Image as PILImage

logger = logging.getLogger(__name__)


# ══════════════════════════════════════════════════════════════
#  项目字体目录
# ══════════════════════════════════════════════════════════════
PROJECT_FONT_DIR = str(
    pathlib.Path(__file__).resolve().parent.parent.parent
    / 'frontend' / 'public' / 'fonts'
) + '/'


# ══════════════════════════════════════════════════════════════
#  LANCZOS 兼容常量（模块级，避免每次渲染重复 try/except）
# ══════════════════════════════════════════════════════════════
try:
    from PIL.Image import Resampling
    LANCZOS = Resampling.LANCZOS
except ImportError:
    LANCZOS = PILImage.LANCZOS


# ══════════════════════════════════════════════════════════════
#  正则表达式
# ══════════════════════════════════════════════════════════════
RE_PHYSICAL_BOX = re.compile(
    r'PhysicalBox[^>]*>\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)')

# 判断 TextCode.text 是否为 Glyphs 索引格式（如 "0; 1; 2; 3;"）
RE_DELTA_GLYPHS = re.compile(r'^\s*(\d+,?\s*;?)+\s*$')


# ══════════════════════════════════════════════════════════════
#  缓存与阈值
# ══════════════════════════════════════════════════════════════
MISSING = object()                            # 缓存哨兵

CLEAN_TABLE = str.maketrans(                  # 控制字符过滤表
    {c: '' for c in (chr(i) for i in range(32) if i not in (9, 10))})

DARK_THRESHOLD = 200                          # 字形可见性判定阈值

MAX_CACHE_SIZE = 8192                         # 缓存容量上限


# ══════════════════════════════════════════════════════════════
#  已知包含通用符号的字体（跳过耗时的像素探测）
# ══════════════════════════════════════════════════════════════
TRUSTED_FONT_NAMES = frozenset({
    'NotoSansSymbols2', 'seguisym', 'Segoe UI Symbol',
    'Noto Sans Symbols 2',
})


# ══════════════════════════════════════════════════════════════
#  工具函数
# ══════════════════════════════════════════════════════════════
def local_tag(tag):
    """提取 XML 标签名（去除命名空间前缀）。"""
    return tag.split('}')[-1] if '}' in tag else tag


def is_number(s):
    try:
        float(s)
        return True
    except ValueError:
        return False


def is_trusted_font(fname):
    """判断字体文件名是否属于免探测的已知符号字体。"""
    lower = fname.lower()
    return any(t.lower() in lower for t in TRUSTED_FONT_NAMES)
