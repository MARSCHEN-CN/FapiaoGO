"""
时间工具模块 - 确保整个项目使用北京时间(UTC+8)
"""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# ============================
# 北京时间时区定义
# ============================

try:
    BEIJING_TZ = ZoneInfo('Asia/Shanghai')
except Exception:
    # 如果 zoneinfo 不可用（Python < 3.9），回退到固定偏移
    BEIJING_TZ = timezone(timedelta(hours=8))


# ============================
# 获取当前时间（北京时间）
# ============================

def now():
    """获取当前北京时间"""
    return datetime.now(BEIJING_TZ)


def now_timestamp():
    """获取当前北京时间的时间戳（秒）"""
    return now().timestamp()


def now_ms():
    """获取当前北京时间的时间戳（毫秒）"""
    return int(now_timestamp() * 1000)


def now_isoformat():
    """获取当前北京时间的 ISO 格式字符串"""
    return now().isoformat()


# ============================
# 时间转换
# ============================

def from_timestamp(ts):
    """从时间戳转换为北京时间 datetime"""
    return datetime.fromtimestamp(ts, tz=BEIJING_TZ)


def from_isoformat(iso_str):
    """从 ISO 格式字符串转换为北京时间 datetime"""
    # 处理带时区信息的字符串
    if iso_str.endswith('Z'):
        dt = datetime.fromisoformat(iso_str.replace('Z', '+00:00'))
        return dt.astimezone(BEIJING_TZ)
    # 处理不带时区信息的字符串，假设是北京时间
    dt = datetime.fromisoformat(iso_str)
    return dt.replace(tzinfo=BEIJING_TZ)


def to_timestamp(dt):
    """将 datetime 转换为时间戳（秒）"""
    if dt.tzinfo is None:
        # 如果没有时区信息，假设是北京时间
        dt = dt.replace(tzinfo=BEIJING_TZ)
    return dt.timestamp()


# ============================
# 时间格式化
# ============================

def format_datetime(dt, fmt='%Y-%m-%d %H:%M:%S'):
    """格式化 datetime 为字符串（北京时间）"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BEIJING_TZ)
    return dt.strftime(fmt)


def format_timestamp(ts, fmt='%Y-%m-%d %H:%M:%S'):
    """格式化时间戳为字符串（北京时间）"""
    return format_datetime(from_timestamp(ts), fmt)


# ============================
# 日志格式化器
# ============================

import logging

class BeijingTimeFormatter(logging.Formatter):
    """自定义日志格式化器，使用北京时间"""
    
    def formatTime(self, record, datefmt=None):
        dt = datetime.fromtimestamp(record.created, tz=BEIJING_TZ)
        if datefmt:
            return dt.strftime(datefmt)
        return dt.strftime('%Y-%m-%d %H:%M:%S')
