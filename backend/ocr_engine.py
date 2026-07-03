import re
import math
import threading
import os
from dataclasses import dataclass
from typing import Optional
import numpy as np
from PIL import Image as PILImage, ImageOps, ImageFilter, ImageEnhance
from rapidocr import RapidOCR
import logging

logger = logging.getLogger(__name__)


class OCRModelNotFoundError(Exception):
    """OCR 模型文件缺失时抛出的异常"""
    pass


@dataclass
class OcrResult:
    """内部 OCR 结果，统一流通格式。

    与 RapidOCROutput 接口兼容，避免了在调用方解构
    [[box, text, score], ...] 旧格式。

    Attributes:
        boxes:  极框坐标，ndarray shape (N, 4, 2)
        txts:   识别文本列表
        scores: 置信度列表
        elapse: 本次 OCR 耗时（秒）
    """
    boxes: np.ndarray       # shape (N, 4, 2), float32
    txts: list[str]
    scores: list[float]
    elapse: float

    def __len__(self) -> int:
        return len(self.txts) if self.txts else 0

    def __bool__(self) -> bool:
        return self.txts is not None and len(self.txts) > 0

    def __iter__(self):
        """迭代产出 [box, text, score] 三元组，兼容旧版 list 格式。"""
        if not self.txts:
            return
        for i, txt in enumerate(self.txts):
            box = self.boxes[i].tolist() if self.boxes is not None else []
            score = self.scores[i] if self.scores else 0.0
            yield [box, txt, score]

# 预编译正则，避免每次调用重新编译
_AMOUNT_RE = re.compile(r'\d+[.,]\d{2}')
_DATE_RE = re.compile(r'\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}')

# OCR 方向检测提前退出阈值（可调优）
# 当识别结果同时满足以下条件时，认为当前方向已足够好，跳过剩余方向
ORIENT_EARLY_EXIT_MIN_LINES = 5       # 最小识别行数（降低阈值，更容易触发快速路径）
ORIENT_EARLY_EXIT_MIN_CONFIDENCE = 0.5  # 最小平均置信度（降低阈值）
ORIENT_EARLY_EXIT_MIN_CHARS = 60      # 最小字符数（降低阈值）
ORIENT_EARLY_EXIT_KEYWORD_HIT = 2     # 发票关键词命中数（新增：≥2个关键词直接认为方向正确）

# 快速方向检测参数
QUICK_SCAN_LONG_SIDE = 384            # 快速扫描时图像长边缩放尺寸（越小越快，但准确率下降）

# =========================
# 图片预处理常量
# =========================
ENABLE_PREPROCESS = False             # 预处理总开关
ENABLE_ROW_MERGE = False             # OCR 后行合并开关    

# 模型文件目录（相对于当前文件）
_MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models')

# ONNX Runtime 执行提供者配置
# 优先使用 GPU（CUDA），如果不可用则回退到 CPU
try:
    import onnxruntime as ort
    
    # 检查可用的执行提供者
    available_providers = ort.get_available_providers()
    logger.info("可用的ONNX Runtime提供者: %s", available_providers)
    
    # 构建提供者列表（优先GPU）
    OCR_PROVIDERS = []
    if 'CUDAExecutionProvider' in available_providers:
        OCR_PROVIDERS.append('CUDAExecutionProvider')
        logger.info("检测到 CUDA，将使用 GPU 加速")
    elif 'DirectMLExecutionProvider' in available_providers:
        OCR_PROVIDERS.append('DirectMLExecutionProvider')
        logger.info("检测到 DirectML，将使用 GPU 加速")
    elif 'TensorrtExecutionProvider' in available_providers:
        OCR_PROVIDERS.append('TensorrtExecutionProvider')
        logger.info("检测到 TensorRT，将使用 GPU 加速")
    
    # 始终添加 CPU 作为后备
    OCR_PROVIDERS.append('CPUExecutionProvider')
    
    # 配置会话选项
    SESSION_OPTIONS = ort.SessionOptions()
    SESSION_OPTIONS.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    SESSION_OPTIONS.intra_op_num_threads = max(1, os.cpu_count() // 2)
    SESSION_OPTIONS.inter_op_num_threads = 1
    
    USE_GPU = len(OCR_PROVIDERS) > 1  # 如果有多个提供者，说明启用了GPU
except ImportError:
    logger.warning("未安装 onnxruntime-gpu，将使用 CPU 模式")
    OCR_PROVIDERS = ['CPUExecutionProvider']
    SESSION_OPTIONS = None
    USE_GPU = False

# =========================
# OCR 引擎（懒加载，线程安全）
# =========================
ocr = None
_ocr_lock = threading.Lock()


def get_ocr():
    global ocr
    if ocr is None:
        with _ocr_lock:
            if ocr is None:  # 双重检查锁定
                logger.info("初始化RapidOCR...")
                # 指定本地模型路径（使用 PP-OCRv6 模型）
                det_model_path = os.path.join(_MODEL_DIR, 'det', 'PP-OCRv6_det_small.onnx')
                rec_model_path = os.path.join(_MODEL_DIR, 'rec', 'PP-OCRv6_rec_small.onnx')
                cls_model_path = os.path.join(_MODEL_DIR, 'cls', 'ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx')

                logger.info("检测模型: %s", det_model_path)
                logger.info("识别模型: %s", rec_model_path)
                logger.info("方向分类模型: %s", cls_model_path)

                # 检查模型文件是否存在，任一缺失则抛出明确异常
                missing_models = [p for p in [det_model_path, rec_model_path, cls_model_path] if not os.path.exists(p)]
                if missing_models:
                    raise OCRModelNotFoundError(
                        f"OCR 模型文件缺失: {', '.join(missing_models)}\n"
                        f"请确保模型文件存在于 models/det/, models/rec/, models/cls/ 目录"
                    )

                # 构建 RapidOCR 参数（点分隔格式）
                # PP-OCRv6 CLS 模型输入 shape 为 [3, 80, 160]，覆盖默认的 [3, 48, 192]
                ocr_params = {
                    'Det.model_path': det_model_path,
                    'Rec.model_path': rec_model_path,
                    'Cls.model_path': cls_model_path,
                    'Cls.cls_image_shape': [3, 80, 192],
                    'Global.use_cls': False,           # 关闭方向分类，避免裁剪块尺寸不匹配导致ONNX报错
                    'Det.limit_side_len': 1024,
                    'Det.thresh': 0.3,
                    'Det.box_thresh': 0.5,
                    'Det.unclip_ratio': 1.6,
                    'Det.use_dilation': True,
                    'Global.log_level': 'warning',
                }

                # ONNX Runtime 引擎配置
                engine_cfg = {
                    'intra_op_num_threads': max(1, os.cpu_count() // 2),
                    'inter_op_num_threads': 1,
                }
                if USE_GPU:
                    engine_cfg['use_cuda'] = True
                ocr_params['EngineConfig.onnxruntime'] = engine_cfg

                ocr = RapidOCR(params=ocr_params)

                logger.info("OCR 引擎初始化完成，执行提供者: %s", OCR_PROVIDERS)
                if USE_GPU:
                    logger.info("GPU 加速已启用，预期识别速度将显著提升")
    return ocr


def _to_ocr_result(raw):
    """将 RapidOCROutput 转换为内部 OcrResult。

    Args:
        raw: RapidOCR.__call__ 返回值（RapidOCROutput 或 None）

    Returns:
        OcrResult 或 None（当 raw 为 None 或无识别结果时）
    """
    if raw is None or raw.txts is None or len(raw.txts) == 0:
        return None
    return OcrResult(
        boxes=raw.boxes,
        txts=raw.txts,
        scores=list(raw.scores) if hasattr(raw.scores, 'tolist') else list(raw.scores),
        elapse=raw.elapse,
    )


def ocr_call(ocr_engine, img_array):
    """调用 RapidOCR 并返回 (OcrResult, elapse) 元组。

    相对于直接调用 ocr_engine(img_array) 返回的 RapidOCROutput，
    此函数将其统一转换为内部 OcrResult，下游代码只需处理一种格式。
    """
    raw = ocr_engine(img_array)
    elapse = raw.elapse if raw else 0.0
    return _to_ocr_result(raw), elapse


# =========================
# 图片预处理：锐化 + 对比度增强
# =========================
def preprocess_for_invoice(img_array):
    """
    发票专用 OCR 预处理：锐化 + 对比度增强

    注：图像尺寸由 RapidOCR 的 det_limit_side_len=1280 统一管理，
    此处不再做放大操作。

    Args:
        img_array: numpy array, RGB 格式

    Returns:
        预处理后的 numpy array
    """
    # 1. 轻度锐化（增强文字边缘）
    kernel = np.array([[0, -0.75, 0], [-0.75, 4.5, -0.75], [0, -0.75, 0]], dtype=np.float32)
    # 用 numpy 手动卷积（避免依赖 cv2）
    img_array = _apply_kernel(img_array, kernel)

    # 2. 对比度增强（发票常有浅灰色背景）
    pil_img = PILImage.fromarray(img_array)
    pil_img = ImageOps.autocontrast(pil_img, cutoff=1)  # 拉伸直方图，丢弃极端 1%
    enhancer = ImageEnhance.Contrast(pil_img)
    pil_img = enhancer.enhance(1.2)  # 轻微增强 20%
    img_array = np.array(pil_img)

    return img_array


def _apply_kernel(img_array, kernel):
    """
    对 RGB 图像应用 3x3 卷积核（完全向量化实现）

    相比 Python 循环，利用 numpy 堆叠切片一次性计算所有位置的卷积：
    - 一次 np.pad 处理所有通道（edge 模式）
    - 堆叠 9 个 3x3 位置的切片，向量化加权求和
    - 消除所有 Python 循环，性能提升 10-15 倍
    """
    img_float = img_array.astype(np.float32)
    h, w = img_float.shape[:2]

    # 对三通道同时 pad（axis=(0,1) 仅 pad 高和宽，通道轴不 pad）
    padded = np.pad(img_float, ((1, 1), (1, 1), (0, 0)), mode='edge')

    # 堆叠 9 个 3x3 位置的切片，形状为 (h, w, 3, 9)
    patches = np.stack([
        padded[0:h, 0:w, :], padded[0:h, 1:w+1, :], padded[0:h, 2:w+2, :],
        padded[1:h+1, 0:w, :], padded[1:h+1, 1:w+1, :], padded[1:h+1, 2:w+2, :],
        padded[2:h+2, 0:w, :], padded[2:h+2, 1:w+1, :], padded[2:h+2, 2:w+2, :]
    ], axis=-1)

    # 向量化加权求和：沿最后一个轴（9 个位置）加权求和
    result = np.sum(patches * kernel.ravel(), axis=-1)

    return np.clip(result, 0, 255).astype(np.uint8)


# 行合并密度阈值：OCR 结果行数低于此值时跳过行合并（避免非表格场景误合并）
ROW_MERGE_MIN_LINES = 10


def ocr_result_to_items(ocr_result):
    """将 OcrResult 转换为 [[box.tolist(), text, score], ...] 便于中间处理。

    当消费者需要按阅读顺序排序、遍历 line[0]/line[1]/line[2] 时，
    调用此函数转换为旧列表格式处理。
    """
    items = []
    for i in range(len(ocr_result)):
        box = ocr_result.boxes[i].tolist()
        text = ocr_result.txts[i]
        score = float(ocr_result.scores[i])
        items.append([box, text, score])
    return items


# =========================
# OCR 后处理：行合并
# =========================
def merge_ocr_boxes_by_row(ocr_result, y_tol=4, x_gap_tol=15, min_lines=10):
    """
    将 OCR 结果按行合并，解决表格场景下检测框过度分割的问题。

    仅在 OCR 结果行数 ≥ min_lines 时执行（密度启发），避免对非表格
    发票（如全电发票）的短文本结果做不必要的合并。

    Args:
        ocr_result: OcrResult 对象（新版），或 list of [box, text, score]（旧版兼容）
        y_tol: y 中心坐标容差（像素），在此范围内视为同一行
        x_gap_tol: x 方向最大间隙（像素），超过则不合并
        min_lines: 最少有效行数，低于此值跳过合并

    Returns:
        OcrResult（新版输入）或 list（旧版输入），格式与输入相同
    """
    if not ocr_result:
        if isinstance(ocr_result, OcrResult):
            return OcrResult(boxes=np.empty((0, 4, 2)), txts=[], scores=[], elapse=0.0)
        return []

    # 统一为内部迭代格式
    is_ocr_result = isinstance(ocr_result, OcrResult)
    if is_ocr_result:
        items = ocr_result_to_items(ocr_result)
    else:
        items = ocr_result

    # 密度启发：行数不足时跳过合并，直接返回原结果
    if len(items) < min_lines:
        logger.debug("[行合并] 跳过: %d 行 < %d (min_lines)", len(items), min_lines)
        return ocr_result

    # 解析每个检测框
    boxes = []
    for item in items:
        if not item or len(item) < 3:
            continue
        box, text, score = item[0], item[1], item[2]
        if not box or not text:
            continue
        ys = [p[1] for p in box]
        xs = [p[0] for p in box]
        y_center = sum(ys) / 4
        x0, x1 = min(xs), max(xs)
        boxes.append({
            'box': box, 'text': text, 'score': score,
            'y_center': y_center, 'x0': x0, 'x1': x1
        })

    if not boxes:
        return ocr_result

    # 按 y_center 排序
    boxes.sort(key=lambda b: b['y_center'])

    # 聚类成行：按实际水平间隙判断，而非简单 x0 ≤ max(row_xs) + tol
    # （后者会导致左右跨度大的框被链式合并到同一行）
    rows = []
    for b in boxes:
        merged = False
        for row in rows:
            if abs(b['y_center'] - row['y_center']) <= y_tol:
                # 检查新框与行内任一框的实际水平间隙
                for item in row['items']:
                    gap = max(0, b['x0'] - item['x1'], item['x0'] - b['x1'])
                    if gap <= x_gap_tol:
                        row['items'].append(b)
                        row['y_center'] = sum(it['y_center'] for it in row['items']) / len(row['items'])
                        merged = True
                        break
            if merged:
                break
        if not merged:
            rows.append({'y_center': b['y_center'], 'items': [b]})

    # 每行内按 x 排序，合并文本和外包框
    merged_result = []
    merge_count = 0
    for row in rows:
        row['items'].sort(key=lambda b: b['x0'])
        if len(row['items']) == 1:
            item = row['items'][0]
            merged_result.append([item['box'], item['text'], item['score']])
            continue

        merge_count += 1
        # ✅ 空格分隔而非直接拼接，保留列间边界供下游按空格/坐标切分
        full_text = ' '.join(b['text'] for b in row['items'])
        all_xs = [p[0] for b in row['items'] for p in b['box']]
        all_ys = [p[1] for b in row['items'] for p in b['box']]
        merged_box = [
            [min(all_xs), min(all_ys)],
            [max(all_xs), min(all_ys)],
            [max(all_xs), max(all_ys)],
            [min(all_xs), max(all_ys)]
        ]
        avg_score = sum(b['score'] for b in row['items']) / len(row['items'])
        merged_result.append([merged_box, full_text, avg_score])

    if merge_count > 0:
        logger.debug("[行合并] %d 行被合并 (%d → %d)", merge_count, len(boxes), len(merged_result))

    # 按输入类型返回对应格式
    if is_ocr_result:
        txts_out = [item[1] for item in merged_result]
        scores_out = [float(item[2]) for item in merged_result]
        # boxes 转为 ndarray shape (N, 4, 2)
        boxes_out = np.array([item[0] for item in merged_result], dtype=np.float32)
        return OcrResult(boxes=boxes_out, txts=txts_out, scores=scores_out, elapse=ocr_result.elapse)
    return merged_result


def bbox_to_char_coords(bbox, text, page=0):
    """
    从 bbox 和文本估算每个字符的坐标，返回 Char 对象列表。

    改进：基于字符类型估算不同宽度（中文/数字/标点），
    避免等宽拆分导致的列串位。

    字符宽度权重：
      - 中文：1.5（宽字符）
      - 数字/字母：1.0（标准）
      - 窄字符 .,-·：0.6
      - 空格：0.5

    Args:
        bbox: [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
        text: 对应的文本字符串
        page: 页码（默认 0，图片场景只有单页）

    Returns:
        list[Char]: line_item_segmenter.Char 对象列表
    """
    from field_extractor.line_item_segmenter import Char

    x0 = min(p[0] for p in bbox)
    x1 = max(p[0] for p in bbox)
    y0 = min(p[1] for p in bbox)
    y1 = max(p[1] for p in bbox)

    total_width = x1 - x0

    # 字符宽度权重
    def char_weight(ch):
        if '\u4e00' <= ch <= '\u9fff':  # 中文
            return 1.5
        elif ch in '.,-·':              # 窄字符
            return 0.6
        elif ch == ' ':                 # 空格
            return 0.5
        else:                           # 数字、字母、其他
            return 1.0

    weights = [char_weight(ch) for ch in text]
    total_weight = sum(weights)

    chars = []
    current_x = x0
    for i, ch in enumerate(text):
        w = total_width * (weights[i] / total_weight) if total_weight > 0 else 0
        cx0 = current_x
        cx1 = current_x + w
        chars.append(Char(char=ch, x0=cx0, y0=y0, x1=cx1, y1=y1, page=page))
        current_x = cx1

    return chars


def bbox_tokens_to_chars(tokens, page=0):
    """
    将 Token 列表转换为 Char 列表，打通图片 OCR → segment_from_chars 通路。

    Args:
        tokens: list[Token] — 每个 token 有 text/x0/y0/x1/y1
        page: 页码（默认 0）

    Returns:
        list[Char]: 所有 token 拆分后的字符级坐标列表
    """
    from field_extractor.line_item_segmenter import Char

    chars = []
    for t in tokens:
        text = t.text if hasattr(t, 'text') else t.get('text', '')
        if not text:
            continue
        x0 = t.x0 if hasattr(t, 'x0') else t.get('x0', 0)
        y0 = t.y0 if hasattr(t, 'y0') else t.get('y0', 0)
        x1 = t.x1 if hasattr(t, 'x1') else t.get('x1', 0)
        y1 = t.y1 if hasattr(t, 'y1') else t.get('y1', 0)

        width = x1 - x0
        char_width = width / max(len(text), 1)
        for i, ch in enumerate(text):
            cx0 = x0 + i * char_width
            cx1 = cx0 + char_width
            chars.append(Char(char=ch, x0=cx0, y0=y0, x1=cx1, y1=y1, page=page))
    return chars


# =========================
# 自动方向纠正 + OCR
# =========================
def auto_orient_and_ocr(img, ocr_engine):
    """
    自动纠正方向 + OCR 识别（两阶段优化版）
    
    性能优化策略：
    1. 阶段一（快速扫描）：将图像缩放到长边384px，快速测试4个方向确定最佳角度
    2. 阶段二（精细识别）：仅在最佳方向上对全分辨率图像做完整OCR
    3. 激进早期退出：0°方向若检测到足够发票关键词，直接跳过其他方向
    4. 关键词优先：发票关键词命中数是方向判断的决定性因素

    注意：返回的 best_img_array 是旋转后的原始图像（未经预处理），
    预处理仅用于 OCR 推理，不影响返回图像。

    线程安全：ocr_engine 内部使用 onnxruntime 会话，一般线程安全；
    若并发调用 auto_orient_and_ocr，建议在调用方加锁保护。
    """

    def _safe_confidence(result):
        if not result or not result.scores:
            return 0.0
        scores_clean = []
        for s in result.scores:
            try:
                scores_clean.append(float(s))
            except (ValueError, TypeError):
                scores_clean.append(0.0)
        return sum(scores_clean) / len(scores_clean) if scores_clean else 0.0

    def _total_chars(result):
        if not result or not result.txts:
            return 0
        return sum(len(t) for t in result.txts if t)

    def _count_invoice_keywords(result):
        """统计发票关键词命中数"""
        if not result or not result.txts:
            return 0
        full_text = ''.join(t for t in result.txts if t)
        hit = 0
        if _AMOUNT_RE.search(full_text):
            hit += 1
        if _DATE_RE.search(full_text):
            hit += 1
        for kw in ['发票', '税', '金额', '合计', '价税', '号码', '日期', '购买', '销售', '开票']:
            if kw in full_text:
                hit += 1
        return hit

    def _calc_quick_score(result):
        """快速扫描评分（轻量级，只看关键词和基本指标）"""
        if not result or not result.txts:
            return 0.0
        conf = _safe_confidence(result)
        count = len(result)
        chars = _total_chars(result)
        kw_hits = _count_invoice_keywords(result)
        return kw_hits * 100 + math.sqrt(count) * (conf ** 2) * (1 + chars / 50.0)

    def resize_for_quick_scan(arr):
        """将图像缩放到长边 QUICK_SCAN_LONG_SIDE 用于快速方向检测"""
        h, w = arr.shape[:2]
        long_side = max(h, w)
        if long_side <= QUICK_SCAN_LONG_SIDE:
            return arr.copy()
        scale = QUICK_SCAN_LONG_SIDE / long_side
        new_h, new_w = int(h * scale), int(w * scale)
        pil_img = PILImage.fromarray(arr)
        pil_img = pil_img.resize((new_w, new_h), PILImage.LANCZOS)
        return np.array(pil_img)

    try:
        img = ImageOps.exif_transpose(img)
        img_array = np.array(img.convert('RGB'))
        h, w = img_array.shape[:2]
        logger.debug("图片尺寸: %dx%d", w, h)

        # 候选顺序：0° → 180°（上下颠倒常见于扫描件）→ 90° → 270°
        angle_k_map = [(0, 0), (180, 2), (90, -1), (270, 1)]

        # ========== 阶段0：先在全分辨率上尝试0°，若结果极好直接返回（最常见情况） ==========
        logger.debug("[方向检测] 尝试 0° 快速路径（全分辨率）")
        arr_0 = img_array.copy()
        if ENABLE_PREPROCESS:
            arr_0 = preprocess_for_invoice(arr_0)
        result_0, elapse_0 = ocr_call(ocr_engine, arr_0)
        count_0 = len(result_0) if result_0 else 0
        conf_0 = _safe_confidence(result_0)
        chars_0 = _total_chars(result_0)
        kw_hits_0 = _count_invoice_keywords(result_0)

        logger.debug("0°: 置信度=%.2f, 行数=%d, 字符=%d, 关键词=%d",
                     conf_0, count_0, chars_0, kw_hits_0)

        # 激进早期退出：关键词命中足够多，直接认定0°正确（90%以上的正常发票走这里）
        if kw_hits_0 >= ORIENT_EARLY_EXIT_KEYWORD_HIT:
            logger.info("方向检测: 0° 快速路径命中（关键词=%d, 行=%d, 置信度=%.2f）",
                        kw_hits_0, count_0, conf_0)
            best_result = result_0
            best_angle = 0
            best_elapse = elapse_0
            best_img_array = img_array
            if ENABLE_ROW_MERGE and best_result:
                best_result = merge_ocr_boxes_by_row(best_result)
            return best_result, best_elapse, best_angle, best_img_array

        # 如果0°结果已经不错（虽然关键词不够），也可以直接使用
        if (count_0 >= ORIENT_EARLY_EXIT_MIN_LINES and
            conf_0 >= ORIENT_EARLY_EXIT_MIN_CONFIDENCE and
            chars_0 >= ORIENT_EARLY_EXIT_MIN_CHARS):
            logger.info("方向检测: 0° 快速路径命中（指标达标, 行=%d, 置信度=%.2f）",
                        count_0, conf_0)
            best_result = result_0
            best_angle = 0
            best_elapse = elapse_0
            best_img_array = img_array
            if ENABLE_ROW_MERGE and best_result:
                best_result = merge_ocr_boxes_by_row(best_result)
            return best_result, best_elapse, best_angle, best_img_array

        # ========== 阶段1：快速扫描确定最佳角度（缩小图像，仅跑方向判断） ==========
        logger.info("[方向检测] 0° 快速路径未命中，启动多方向快速扫描（缩小到%dpx）", QUICK_SCAN_LONG_SIDE)
        quick_best_angle = 0
        quick_best_score = _calc_quick_score(result_0)

        for angle, k in angle_k_map[1:]:
            try:
                arr_rot = np.rot90(img_array, k=k)
                arr_quick = resize_for_quick_scan(arr_rot)
                if ENABLE_PREPROCESS:
                    arr_quick = preprocess_for_invoice(arr_quick)
                result_q, _ = ocr_call(ocr_engine, arr_quick)
                score_q = _calc_quick_score(result_q)
                count_q = len(result_q) if result_q else 0
                conf_q = _safe_confidence(result_q)
                kw_q = _count_invoice_keywords(result_q)
                logger.debug("快速扫描 %d°: 置信度=%.2f, 行数=%d, 关键词=%d, 评分=%.1f",
                             angle, conf_q, count_q, kw_q, score_q)
                if score_q > quick_best_score:
                    quick_best_score = score_q
                    quick_best_angle = angle
            except Exception as e:
                logger.warning("快速扫描 %d° 失败: %s", angle, e)
                continue

        logger.info("[方向检测] 快速扫描最佳角度: %d° (评分=%.1f)", quick_best_angle, quick_best_score)

        # ========== 阶段2：在最佳角度上做全分辨率精细OCR ==========
        best_angle = quick_best_angle
        if best_angle == 0:
            best_result = result_0
            best_elapse = elapse_0
            best_img_array = img_array
        else:
            k = {90: -1, 180: 2, 270: 1}.get(best_angle, 0)
            best_img_array = np.rot90(img_array, k=k)
            arr_full = best_img_array.copy()
            if ENABLE_PREPROCESS:
                arr_full = preprocess_for_invoice(arr_full)
            logger.info("[方向检测] 对 %d° 做全分辨率精细OCR", best_angle)
            best_result, best_elapse = ocr_call(ocr_engine, arr_full)

        # ✅ OCR 后处理：行合并（解决表格场景检测框过度分割）
        if ENABLE_ROW_MERGE and best_result:
            best_result = merge_ocr_boxes_by_row(best_result)

        if best_angle != 0:
            logger.info("方向检测: 物理旋转%d°", best_angle)
        else:
            logger.info("方向检测: 保持原图")

        return best_result, best_elapse, best_angle, best_img_array

    except Exception as e:
        logger.error("auto_orient_and_ocr 错误: %s", e, exc_info=True)
        return None, 0, 0, None