"""
工具模块：超时保护和性能统计
"""

import time
import logging
from contextlib import contextmanager
from functools import wraps

logger = logging.getLogger(__name__)

# ============================
# 超时配置
# ============================

# 单文件解析最大耗时（秒）
MAX_PARSE_TIME = 60

# 单页 OCR 最大耗时（秒）
MAX_OCR_TIME = 20

# PDF 最大页数
MAX_PDF_PAGES = 100

# 图片最大像素数
MAX_IMAGE_PIXELS = 50_000_000


# ============================
# 性能统计工具
# ============================

@contextmanager
def timer(name, metrics=None):
    """
    性能统计上下文管理器
    
    Usage:
        metrics = {}
        with timer('ocr_ms', metrics):
            text = run_ocr(...)
        logger.info('[Perf] %s', metrics)
    """
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
        if metrics is not None:
            metrics[name] = elapsed_ms
        logger.debug('[Perf] %s: %.2fms', name, elapsed_ms)


def timed_function(func):
    """
    装饰器：统计函数执行时间
    """
    @wraps(func)
    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        try:
            return func(*args, **kwargs)
        finally:
            elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
            logger.debug('[Perf] %s: %.2fms', func.__name__, elapsed_ms)
    return wrapper


# ============================
# 超时保护（软超时）
# ============================

class TimeoutException(Exception):
    """超时异常"""
    pass


def check_timeout(start_time, max_time, operation_name):
    """
    检查是否超时（软检查）
    
    Args:
        start_time: 开始时间（time.perf_counter() 返回值）
        max_time: 最大允许时间（秒）
        operation_name: 操作名称（用于日志）
    
    Returns:
        bool: 是否超时
    
    Raises:
        TimeoutException: 如果超时且需要抛出异常
    """
    elapsed = time.perf_counter() - start_time
    if elapsed > max_time:
        logger.warning('[Timeout] %s 耗时超过 %d 秒，实际 %.2f 秒', 
                      operation_name, max_time, elapsed)
        return True
    return False


def timeout_decorator(max_time=MAX_PARSE_TIME, raise_exception=False):
    """
    装饰器：超时保护（软超时）
    
    Args:
        max_time: 最大允许时间（秒）
        raise_exception: 是否抛出超时异常
    
    Usage:
        @timeout_decorator(max_time=30)
        def parse_invoice(file):
            ...
    """
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            start_time = time.perf_counter()
            
            # 执行函数
            result = func(*args, **kwargs)
            
            # 检查超时
            elapsed = time.perf_counter() - start_time
            if elapsed > max_time:
                logger.warning('[Timeout] %s 耗时超过 %d 秒，实际 %.2f 秒', 
                              func.__name__, max_time, elapsed)
                if raise_exception:
                    raise TimeoutException(f'{func.__name__} 超时')
            
            return result
        return wrapper
    return decorator


# ============================
# 带超时的进程执行（可强制终止）
# ============================

def run_with_timeout(func, args=(), kwargs=None, timeout=MAX_PARSE_TIME):
    """在独立进程中执行函数，支持超时强制终止。

    使用 multiprocessing.Process 代替 threading.Thread，
    确保超时后能真正终止执行（Python 线程无法被强制杀死，
    daemon 线程超时后仍会在后台继续运行，造成 CPU/内存/GPU 资源泄漏）。

    注意：func 及其参数必须可 pickle。对于持有 OCR 模型等不可 pickle
    对象的闭包，请使用 check_timeout 软超时模式代替。

    Args:
        func: 要执行的函数（必须可 pickle）
        args: 位置参数
        kwargs: 关键字参数
        timeout: 超时时间（秒）

    Returns:
        tuple: (success, result/error)
    """
    if kwargs is None:
        kwargs = {}

    from multiprocessing import Process, Queue

    result_queue = Queue()

    def target():
        try:
            result = func(*args, **kwargs)
            result_queue.put(('success', result))
        except Exception as e:
            result_queue.put(('error', e))

    p = Process(target=target, daemon=True)
    p.start()
    p.join(timeout)

    if p.is_alive():
        p.terminate()
        p.join(timeout=5)
        if p.is_alive():
            p.kill()
            p.join(timeout=5)
        logger.warning('[Timeout] 函数执行超时（%ds），已强制终止进程', timeout)
        return (False, TimeoutException(f'执行超时，超过 {timeout} 秒'))

    if not result_queue.empty():
        status, result = result_queue.get_nowait()
        if status == 'success':
            return (True, result)
        else:
            logger.exception('[Timeout] 函数执行异常', exc_info=result)
            return (False, result)

    return (False, TimeoutException('进程已结束但未返回结果'))


# ============================
# 资源限制检查
# ============================

def check_image_size(width, height, max_pixels=MAX_IMAGE_PIXELS):
    """
    检查图片像素数是否超过限制
    
    Args:
        width: 图片宽度
        height: 图片高度
        max_pixels: 最大像素数
    
    Returns:
        tuple: (is_valid, message)
    """
    total_pixels = width * height
    if total_pixels > max_pixels:
        msg = f'图片像素数 {total_pixels:,} 超过限制 {max_pixels:,}'
        logger.warning('[Resource] %s', msg)
        return (False, msg)
    return (True, None)


def check_pdf_pages(page_count, max_pages=MAX_PDF_PAGES):
    """
    检查 PDF 页数是否超过限制
    
    Args:
        page_count: PDF 页数
        max_pages: 最大页数
    
    Returns:
        tuple: (is_valid, message)
    """
    if page_count > max_pages:
        msg = f'PDF 页数 {page_count} 超过限制 {max_pages}'
        logger.warning('[Resource] %s', msg)
        return (False, msg)
    return (True, None)


# ============================
# 性能指标收集器
# ============================

class PerformanceMetrics:
    """
    性能指标收集器
    
    Usage:
        metrics = PerformanceMetrics()
        with metrics.timer('read_file'):
            read_file()
        with metrics.timer('ocr'):
            run_ocr()
        
        print(metrics.get_summary())
    """
    
    def __init__(self):
        self._metrics = {}
        self._start_time = time.perf_counter()
    
    @contextmanager
    def timer(self, name):
        """计时上下文管理器"""
        start = time.perf_counter()
        try:
            yield
        finally:
            elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
            self._metrics[name] = elapsed_ms
    
    def add_metric(self, name, value):
        """添加指标"""
        self._metrics[name] = value
    
    def get_summary(self):
        """获取汇总（包含总耗时）"""
        total_ms = round((time.perf_counter() - self._start_time) * 1000, 2)
        return {
            **self._metrics,
            'total_ms': total_ms
        }
    
    def log_summary(self):
        """打印汇总日志"""
        summary = self.get_summary()
        logger.info('[Perf Summary] %s', summary)
