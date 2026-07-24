"""OCR 解析任务封装（供进程池 / 线程池执行）。

独立成模块的原因：ProcessPoolExecutor 在 spawn 子进程中需重新导入「提交函数与目标所在的模块」。
若把执行目标直接定义在 app.py（即 __main__），子进程会重新执行 app.py 的模块级代码
（创建 Flask app、绑定端口、导入整条依赖链等），导致 worker 启动失败或行为异常。

本模块仅依赖 logging，顶层导入零副作用；真正需要的 services.invoice_service / ocr_engine
在函数内惰性导入，子进程导入本模块时几乎无成本。
"""

import logging

from temp_file_registry import read_bytes_by_ref  # IS-3 P2-2：worker 按 refId 跨进程读回字节

logger = logging.getLogger(__name__)


def init_ocr():
    """进程池 worker 初始化：预热 OCR 引擎（每个进程仅加载一次模型）。

    模型缺失等异常在此捕获，不阻塞 worker 启动；任务时仍会惰性加载。
    """
    try:
        from ocr_engine import get_ocr
        get_ocr()
        logger.info("[OCR worker] 模型预热完成")
    except Exception as e:  # 模型缺失等：任务时再惰性加载，不阻塞 worker 启动
        logger.warning("[OCR worker] 模型预热失败（任务时将重试）: %s", e)


def run_parse(ref_id, filename, auto_orient, enable_auto_ocr):
    """在 worker 中执行完整解析；DB 写入由主进程完成（skip_db_write=True）。

    IS-3 P2-2：入参由 bytes 改为 opaque ref_id。worker 仅按 ref_id 跨进程解析读取
    字节（read_bytes_by_ref，依赖 config.TEMP_ROOT 共享 root，INV-IS3-5），绝不接收/
    持有 bytes（INV-IS3-3），也绝不 retain/release（INV-IS3-6：lifecycle mutation 由
    父进程 _run_parse_offthread 的 finally 负责）。

    Args 与返回值均为可 pickle 类型：
      - ref_id: str（opaque storage identity，跨 ProcessPool 仅传字符串）
      - filename: str
      - auto_orient / enable_auto_ocr: bool
      - 返回值: parse_invoice_service 的结果 dict（base64 字符串 / 普通 dict / list）
    """
    file_bytes = read_bytes_by_ref(ref_id)
    from services.invoice_service import parse_invoice_service
    return parse_invoice_service(
        file_bytes, filename,
        auto_orient=auto_orient,
        enable_auto_ocr=enable_auto_ocr,
        skip_db_write=True,
    )
