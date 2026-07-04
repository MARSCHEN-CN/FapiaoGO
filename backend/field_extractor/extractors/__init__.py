"""
发票字段提取器包
统一入口，将所有提取器编排为流水线

新架构流程:
  1. normalize → segment(7区域) → extract(各extractor) → validate → InvoiceFields
"""
import re
import logging
from ..models import OCRDocument, InvoiceFields, InvoiceLineItem, Line, FieldIssue, Token
from ..regex_patterns import _DIGIT_CN, _SMALL_UNIT, _BIG_UNIT
from ..normalizer import TextNormalizer, DigitCorrector
from ..segmenter import DocumentSegmenter
from ..segments import SegmentedDocument
from ..validators import InvoiceValidator
from ..final_sanitizer import sanitize_invoice_fields

from .type_extractor import TypeExtractor
from .number_extractor import NumberExtractor
from .amount_extractor import AmountExtractor
from .date_extractor import DateExtractor
from .party_extractor import PartyExtractor
from .project_extractor import ProjectExtractor
from .line_item_extractor import LineItemExtractor
from .misc_extractor import MiscExtractor
from .invoice_table_extractor import InvoiceTableExtractor

logger = logging.getLogger(__name__)

# 预编译正则表达式（避免函数内重复编译）
_DATE_PATTERN = re.compile(r'(\d{4})[-/](\d{1,2})[-/](\d{1,2})')
_TAX_ID_PATTERN = re.compile(r'^[A-Z0-9]{15,20}$')

# 统一无值语义
_EMPTY_DEFAULTS = {
    'fphm': '', 'kprq': '',
    'gmfmc': '', 'gmfsh': '', 'xsfmc': '', 'xsfsh': '',
    'amountJe': '', 'amountSe': '', 'amountHj': '0.00', 'amountHjDx': '',
    'note': '', 'skr': '', 'fhr': '', 'kpr': '', 'xmmc': '',
    'type': '其他',
}


class InvoiceExtractor:
    """发票字段提取器 — OCR 文本 → 结构化字段"""

    # 字段中文标签（类常量，避免每次方法调用重新构造）
    _FIELD_LABELS = {
        'fphm': '发票号码',
        'kprq': '开票日期',
        'gmfmc': '购买方名称',
        'gmfsh': '购买方税号',
        'xsfmc': '销售方名称',
        'xsfsh': '销售方税号',
        'amountJe': '不含税金额',
        'amountSe': '税额',
        'amountHj': '价税合计',
        'line_items': '明细行',
    }

    def __init__(self):
        self.normalizer = TextNormalizer()
        self.digit_corrector = DigitCorrector()
        self.segmenter = DocumentSegmenter()
        self.validator = InvoiceValidator()
        self.type_extractor = TypeExtractor()
        self.number_extractor = NumberExtractor()
        self.amount_extractor = AmountExtractor()
        self.date_extractor = DateExtractor()
        self.party_extractor = PartyExtractor()
        self.project_extractor = ProjectExtractor()
        self.line_item_extractor = LineItemExtractor()
        self.table_extractor = InvoiceTableExtractor()  # 新增表格识别器
        self.misc_extractor = MiscExtractor()

    def extract(self, text: str, bbox_data: list = None, source_type: str = '', auxiliary_blocks: list = None, pymupdf_page=None) -> InvoiceFields:
        """主入口：OCR 文本 → 结构化 InvoiceFields

        Args:
            text: OCR 文本
            bbox_data: OCR bbox 数据
            source_type: 来源类型 (pdf_text / pdf_ocr / image / ofd)
            auxiliary_blocks: 辅助文本块，用于结构化输入 bbox 结果
            pymupdf_page: PyMuPDF Page 对象（可选），传入后可激活字符级分割通路
        """
        if not text:
            return InvoiceFields()

        # ▸ PDF文本层质量门控
        if source_type == 'pdf_text' and bbox_data and len(bbox_data) >= 3:
            tokens = self._build_quick_tokens(bbox_data)
            if self._should_fallback_to_ocr(tokens):
                logger.warning(
                    "[Extractor] PDF文本层质量不合格（token=%d），降级到OCR",
                    len(tokens)
                )
                if pymupdf_page is not None:
                    return self._reroute_to_ocr(pymupdf_page)
                logger.error("[Extractor] 降级失败：pymupdf_page为None，无法渲染")

        # 1. 文本规范化（一次性构建 OCRDocument，含 bbox 坐标）
        doc = self.normalizer.normalize(text, bbox_data=bbox_data)

        # 设置 source_type
        if source_type:
            doc.source_type = source_type

        # 设置 PyMuPDF Page（字符级通路）
        if pymupdf_page is not None:
            doc.page = pymupdf_page
            logger.info("[Extractor] 已设置 doc.page (type=%s), 将走字符级分割通路",
                        type(pymupdf_page).__name__)
            doc.source_type = source_type

        return self._continue_extraction(doc, auxiliary_blocks=auxiliary_blocks)

    # ════════════════════════════════════════════════
    #  PDF文本层质量门控
    # ════════════════════════════════════════════════

    @staticmethod
    def _build_quick_tokens(bbox_data: list) -> list:
        """从 bbox_data 快速构造 Token 列表（门控用，不经过 normalize）"""
        tokens = []
        for item in bbox_data:
            if not item or 'box' not in item or 'text' not in item:
                continue
            text = item['text']
            box = item['box']
            if not text or not box or len(box) < 4:
                continue
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            tokens.append(Token(
                text=text,
                x0=min(xs), y0=min(ys),
                x1=max(xs), y1=max(ys),
            ))
        return tokens

    @staticmethod
    def _should_fallback_to_ocr(tokens):
        """PDF文本层质量门控：3ms内判断是否需要降级到OCR"""
        # 条件1: token数不足（如宜家发票31个token）
        if len(tokens) < 40:
            return True

        # 条件2: 坐标碎片化检测
        from ..line_item_segmenter import cluster_chars_into_rows
        try:
            rows = cluster_chars_into_rows(tokens, y_tol=15.0)
            frag_ratio = len(rows) / max(len(tokens), 1)
            if frag_ratio > 0.5:
                return True
        except Exception:
            pass

        # 条件3: 关键结构标签缺失（按类别分组，需≥2类）
        text = ' '.join(t.text for t in tokens if hasattr(t, 'text'))
        structure_categories = [
            ['项目名称', '规格型号', '单位', '数量', '单价'],
            ['金额', '税额', '税率', '价税合计', '合计'],
            ['购买方', '销售方', '购方', '销方'],
            ['统一社会信用代码', '纳税人识别号'],
            ['发票号码', '开票日期', '发票类型'],
            ['备注', '收款人', '复核人', '开票人'],
            ['机打代码', '机器编号'],
            ['大写'],
        ]
        matched = sum(1 for cat in structure_categories if any(kw in text for kw in cat))
        if matched < 2:
            return True

        return False

    def _reroute_to_ocr(self, pymupdf_page):
        """PDF文本层降级到OCR图像通路"""
        from PIL import Image
        from ocr_engine import get_ocr, auto_orient_and_ocr, ocr_result_to_items, OCRModelNotFoundError

        logger.info("[Extractor] 渲染PDF页面并重新走OCR解析")

        # 渲染PDF页面为图片
        pix = pymupdf_page.get_pixmap(dpi=200)
        pil_img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

        ocr_text = ''
        ocr_bbox = []
        try:
            try:
                ocr_engine = get_ocr()
                ocr_result, _, _, _ = auto_orient_and_ocr(pil_img, ocr_engine)
            except OCRModelNotFoundError:
                logger.warning("[Extractor] OCR模型不可用，降级失败，返回空结果")
                return InvoiceFields()

            if ocr_result:
                lines = ocr_result_to_items(ocr_result)
                lines.sort(key=lambda x: (x[0][0][1], x[0][0][0]))
                ocr_text = '\n'.join(line[1] for line in lines if line and len(line) >= 2)
                for line in lines:
                    if line and len(line) >= 2 and line[0] and len(line[0]) >= 4:
                        ocr_bbox.append({'text': line[1], 'box': line[0]})
        except Exception as e:
            logger.error("[Extractor] OCR解析异常: %s", e, exc_info=True)
            return InvoiceFields()
        finally:
            pil_img.close()
            del pil_img, pix

        # 用OCR结果构造OCRDocument，继续后续提取
        doc = self.normalizer.normalize(ocr_text, bbox_data=ocr_bbox)
        doc.source_type = 'pdf_ocr'
        return self._continue_extraction(doc)

    def _continue_extraction(self, doc: OCRDocument, auxiliary_blocks: list = None) -> InvoiceFields:
        """normalize 之后的公共提取流程（正常通路 + OCR降级通路共用）"""

        # 1.5. 文档分段: header / line_items / footer / noise
        segmented = self.segmenter.segment(doc)

        # 2~5. 独立字段提取器顺序执行
        # [PERF] Python GIL 下纯文本处理（正则、字符串操作）无法真正并行，
        # 线程池提交后立即 .result() 等待反而增加上下文切换开销，
        # 因此直接串行调用更高效。
        invoice_type = self.type_extractor.extract(doc)
        fphm = self.number_extractor.extract(doc)
        amount_hj, amount_je, amount_se = self.amount_extractor.extract(doc)
        kprq = self.date_extractor.extract(doc)

        # 6. 购买方/销售方（含字段元数据）
        gmfmc, gmfsh, xsfmc, xsfsh, party_field_meta = self.party_extractor.extract(
            doc, segmented=segmented)

        # 处理辅助文本块（结构化 bbox 输入）
        # 放在 party_extractor 之后执行，确保 doc.regions['buyer'/'seller']
        # 已由 PartyExtractor._write_back_regions 回写，辅助块能插入到精确区域。
        if auxiliary_blocks:
            self._process_auxiliary_blocks(doc, auxiliary_blocks)

        # 7. 明细行（使用表格识别器，优先于传统提取器）
        table_items = self.table_extractor.extract(segmented.line_items)
        
        # 8. 项目名称：优先从表格数据获取
        xmmc = ''
        if table_items:
            xmmc = table_items[0].name
        
        # 如果表格识别器未提取到，回退到传统项目名称提取器
        if not xmmc:
            xmmc = self.project_extractor.extract(doc)
        
        # 9. 明细行（兼容老接口，使用传统提取器的格式）
        line_items, line_item_adjustments = self.line_item_extractor.extract(segmented, return_adjustments=True)
        
        # 项目名称兜底：如果表格和全局都未提取到，用第一条明细的项目名称
        if not xmmc and line_items:
            xmmc = line_items[0].xmmc
        
        # 9.5. 使用表格数据校验金额
        if table_items:
            table_summary = self.table_extractor.get_summary(table_items)
            logger.debug("[TableExtractor] 表格汇总: 金额=%.2f, 税额=%.2f, 项目数=%d",
                        table_summary['total_amount'],
                        table_summary['total_tax'],
                        table_summary['item_count'])
        
        # 8.5. 金额/税额汇总（从明细行计算，作为安全网）
        amount_je = self._aggregate_amount_from_line_items(line_items, amount_je, amount_se, amount_hj)
        amount_se = self._aggregate_tax_from_line_items(line_items, amount_se, amount_hj, amount_je)

        # 9. 杂项（优先用 bbox 坐标定位备注区域）
        if doc.bbox_tokens:
            note, skr, fhr, kpr = self.misc_extractor.extract_with_bbox(doc)
        else:
            note, skr, fhr, kpr = self.misc_extractor.extract(doc)

        # 10. 二次 OCR 纠错（安全网）
        fphm = self.digit_corrector.fix(fphm)
        amount_je = self.digit_corrector.fix(amount_je) if amount_je else ''
        amount_se = self.digit_corrector.fix(amount_se) if amount_se else ''
        amount_hj = self.digit_corrector.fix(amount_hj) if amount_hj else '0.00'
        gmfsh = self.digit_corrector.fix(gmfsh)
        xsfsh = self.digit_corrector.fix(xsfsh)

        # 明细行数值纠错
        for item in line_items:
            item.je = self.digit_corrector.fix(item.je) if item.je else ''
            item.se = self.digit_corrector.fix(item.se) if item.se else ''
            item.dj = self.digit_corrector.fix(item.dj) if item.dj else ''
            item.sl = self.digit_corrector.fix(item.sl) if item.sl else ''

        # 11. 生成金额大写
        logger.info("[Extractor Debug] 大写生成: amount_hj=%r amount_je=%r amount_se=%r",
                     amount_hj, amount_je, amount_se)
        amount_hj_dx = self._to_chinese_amount(amount_hj)

        # 统一兜底默认值
        fields = InvoiceFields(
            type=invoice_type or _EMPTY_DEFAULTS['type'],
            fphm=fphm or _EMPTY_DEFAULTS['fphm'],
            kprq=kprq or _EMPTY_DEFAULTS['kprq'],
            gmfmc=gmfmc or _EMPTY_DEFAULTS['gmfmc'],
            gmfsh=gmfsh or _EMPTY_DEFAULTS['gmfsh'],
            xsfmc=xsfmc or _EMPTY_DEFAULTS['xsfmc'],
            xsfsh=xsfsh or _EMPTY_DEFAULTS['xsfsh'],
            amountJe=amount_je or _EMPTY_DEFAULTS['amountJe'],
            amountSe=amount_se or _EMPTY_DEFAULTS['amountSe'],
            amountHj=amount_hj or _EMPTY_DEFAULTS['amountHj'],
            amountHjDx=amount_hj_dx or _EMPTY_DEFAULTS['amountHjDx'],
            note=note or _EMPTY_DEFAULTS['note'],
            skr=skr or _EMPTY_DEFAULTS['skr'],
            fhr=fhr or _EMPTY_DEFAULTS['fhr'],
            kpr=kpr or _EMPTY_DEFAULTS['kpr'],
            xmmc=xmmc or _EMPTY_DEFAULTS['xmmc'],
            line_items=line_items,
            line_item_adjustments=line_item_adjustments,
            field_meta=party_field_meta,
        )

        # 12. 注入字符级通路的 Excel 行数据（如果存在）
        excel_rows = getattr(doc, 'line_items_excel_rows', None)
        if excel_rows:
            fields.line_items_excel_rows = excel_rows
            logger.info("[Extractor] 注入 line_items_excel_rows: %d 条明细",
                        len(excel_rows))

        # 12. 去重
        fields = self._dedup(fields)

        # 13. 全局一致性校验
        validation = self.validator.validate(fields, doc)
        fields.confidence = validation.confidence
        fields.warnings = validation.warnings
        fields.corrections = validation.corrections

        # 14. 字段级失败/警告判定
        failed_fields, warning_fields = self._detect_field_issues(fields, party_field_meta)
        fields.failed_fields = failed_fields
        fields.warning_fields = warning_fields

        # 15. 最终统一清洗（控制标记、反污染、兜底规范化）
        fields = sanitize_invoice_fields(fields)

        return fields

    def _detect_field_issues(self, fields, field_meta):
        """检测字段级失败和警告"""
        failed_fields = []
        warning_fields = []
        
        # [PERF] 一次性获取所有字段置信度，避免重复查找
        conf_map = {}
        if field_meta:
            for field in ['fphm', 'kprq', 'gmfmc', 'gmfsh', 'xsfmc', 'xsfsh', 'amountJe', 'amountSe', 'amountHj']:
                fm = field_meta.get(field)
                conf_map[field] = fm.get('confidence', 0) if fm else 0
        else:
            for field in ['fphm', 'kprq', 'gmfmc', 'gmfsh', 'xsfmc', 'xsfsh', 'amountJe', 'amountSe', 'amountHj']:
                conf_map[field] = 0
        
        # fphm: 发票号码
        fphm_conf = conf_map['fphm']
        if not fields.fphm or fields.fphm in ('未知号码', ''):
            failed_fields.append(FieldIssue(
                field='fphm',
                label=self._FIELD_LABELS['fphm'],
                severity='error',
                reason='发票号码为空',
                value=fields.fphm,
                confidence=fphm_conf,
            ))
        elif len(fields.fphm.strip()) not in (8, 10, 12, 20):
            warning_fields.append(FieldIssue(
                field='fphm',
                label=self._FIELD_LABELS['fphm'],
                severity='warning',
                reason=f'发票号码位数异常（{len(fields.fphm.strip())}位）',
                value=fields.fphm,
                confidence=fphm_conf,
            ))
        
        # kprq: 开票日期
        kprq_conf = conf_map['kprq']
        if not fields.kprq or fields.kprq in ('未知日期', ''):
            failed_fields.append(FieldIssue(
                field='kprq',
                label=self._FIELD_LABELS['kprq'],
                severity='error',
                reason='开票日期为空',
                value=fields.kprq,
                confidence=kprq_conf,
            ))
        elif not self._is_valid_date(fields.kprq):
            warning_fields.append(FieldIssue(
                field='kprq',
                label=self._FIELD_LABELS['kprq'],
                severity='warning',
                reason='开票日期格式非法',
                value=fields.kprq,
                confidence=kprq_conf,
            ))
        
        # gmfmc: 购买方名称
        gmfmc_conf = conf_map['gmfmc']
        if not fields.gmfmc:
            failed_fields.append(FieldIssue(
                field='gmfmc',
                label=self._FIELD_LABELS['gmfmc'],
                severity='error',
                reason='购买方名称为空',
                value=fields.gmfmc,
                confidence=gmfmc_conf,
            ))
        elif fields.gmfmc == fields.xsfmc and fields.gmfmc:
            failed_fields.append(FieldIssue(
                field='gmfmc',
                label=self._FIELD_LABELS['gmfmc'],
                severity='error',
                reason='购买方名称与销售方名称相同',
                value=fields.gmfmc,
                confidence=gmfmc_conf,
            ))
        
        # gmfsh: 购买方税号
        gmfsh_conf = conf_map['gmfsh']
        if not fields.gmfsh:
            failed_fields.append(FieldIssue(
                field='gmfsh',
                label=self._FIELD_LABELS['gmfsh'],
                severity='error',
                reason='购买方税号为空',
                value=fields.gmfsh,
                confidence=gmfsh_conf,
            ))
        elif fields.gmfsh and not self._is_valid_tax_id(fields.gmfsh):
            warning_fields.append(FieldIssue(
                field='gmfsh',
                label=self._FIELD_LABELS['gmfsh'],
                severity='warning',
                reason='购买方税号格式不合法',
                value=fields.gmfsh,
                confidence=gmfsh_conf,
            ))
        elif fields.gmfsh == fields.xsfsh and fields.gmfsh:
            failed_fields.append(FieldIssue(
                field='gmfsh',
                label=self._FIELD_LABELS['gmfsh'],
                severity='error',
                reason='购买方税号与销售方税号相同',
                value=fields.gmfsh,
                confidence=gmfsh_conf,
            ))
        
        # xsfmc: 销售方名称
        xsfmc_conf = conf_map['xsfmc']
        if not fields.xsfmc:
            failed_fields.append(FieldIssue(
                field='xsfmc',
                label=self._FIELD_LABELS['xsfmc'],
                severity='error',
                reason='销售方名称为空',
                value=fields.xsfmc,
                confidence=xsfmc_conf,
            ))
        
        # xsfsh: 销售方税号
        xsfsh_conf = conf_map['xsfsh']
        if not fields.xsfsh:
            failed_fields.append(FieldIssue(
                field='xsfsh',
                label=self._FIELD_LABELS['xsfsh'],
                severity='error',
                reason='销售方税号为空',
                value=fields.xsfsh,
                confidence=xsfsh_conf,
            ))
        elif fields.xsfsh and not self._is_valid_tax_id(fields.xsfsh):
            warning_fields.append(FieldIssue(
                field='xsfsh',
                label=self._FIELD_LABELS['xsfsh'],
                severity='warning',
                reason='销售方税号格式不合法',
                value=fields.xsfsh,
                confidence=xsfsh_conf,
            ))
        
        # 金额校验
        je_conf = conf_map['amountJe']
        se_conf = conf_map['amountSe']
        hj_conf = conf_map['amountHj']
        
        try:
            je = float(fields.amountJe.replace(',', '')) if fields.amountJe else 0
            se = float(fields.amountSe.replace(',', '')) if fields.amountSe else 0
            hj = float(fields.amountHj.replace(',', '')) if fields.amountHj else 0
        except (ValueError, TypeError):
            je = se = hj = 0
        
        # 价税合计 = 不含税金额 + 税额
        if abs((je + se) - hj) > 0.01 and hj > 0:
            warning_fields.append(FieldIssue(
                field='amountHj',
                label=self._FIELD_LABELS['amountHj'],
                severity='warning',
                reason=f'价税合计与分项合计不一致（不含税={je:.2f}, 税额={se:.2f}, 合计={hj:.2f}）',
                value=str(hj),
                confidence=hj_conf,
            ))
        
        # 明细行校验
        if not fields.line_items:
            warning_fields.append(FieldIssue(
                field='line_items',
                label=self._FIELD_LABELS['line_items'],
                severity='warning',
                reason='明细行为空',
                value='',
                confidence=0,
            ))
        
        # 检查置信度低于阈值的字段（直接使用 conf_map，不再重复查找）
        for field in ['gmfmc', 'gmfsh', 'xsfmc', 'xsfsh']:
            conf = conf_map[field]
            if conf > 0 and conf < 0.6:
                failed_fields.append(FieldIssue(
                    field=field,
                    label=self._FIELD_LABELS.get(field, field),
                    severity='error',
                    reason=f'置信度 {conf:.2f} 低于阈值 0.6',
                    value=getattr(fields, field, ''),
                    confidence=conf,
                ))
            elif conf > 0 and conf < 0.85:
                warning_fields.append(FieldIssue(
                    field=field,
                    label=self._FIELD_LABELS.get(field, field),
                    severity='warning',
                    reason=f'置信度 {conf:.2f} 较低，建议人工确认',
                    value=getattr(fields, field, ''),
                    confidence=conf,
                ))
        
        return failed_fields, warning_fields

    @staticmethod
    def _is_valid_date(date_str):
        """检查日期格式是否合法"""
        m = _DATE_PATTERN.match(str(date_str))
        if not m:
            return False
        try:
            year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if year < 2000 or year > 2100:
                return False
            if month < 1 or month > 12:
                return False
            if day < 1 or day > 31:
                return False
            return True
        except ValueError:
            return False

    @staticmethod
    def _is_valid_tax_id(tax_id):
        """检查税号格式是否合法（15-20位字母数字组合）"""
        return bool(_TAX_ID_PATTERN.match(str(tax_id).strip().upper()))

    def _process_auxiliary_blocks(self, doc, auxiliary_blocks):
        """处理辅助文本块（结构化 bbox 输入）
        
        将 bbox 解析结果以结构化方式注入文档，而非直接拼接为文本，
        这样可以保持来源可追溯性，并按来源评分。
        """
        for block in auxiliary_blocks:
            source = block.get('source', '')
            role = block.get('role', '')
            text = block.get('text', '')
            confidence = block.get('confidence', 0.0)
            
            if not text:
                continue
            
            # 将辅助块添加到文档元数据
            if 'auxiliary_blocks' not in doc.meta:
                doc.meta['auxiliary_blocks'] = []
            
            doc.meta['auxiliary_blocks'].append({
                'source': source,
                'role': role,
                'text': text,
                'confidence': confidence,
            })
            
            # 同时将文本添加到对应角色的区域（如果存在）
            if role == 'buyer':
                # 添加到购买方区域
                buyer_region = doc.regions.get('buyer')
                if buyer_region:
                    # 在区域开头添加标记文本（带来源标识）
                    marked_text = f"__AUX_{source}_BUYER_START__\n{text}\n__AUX_{source}_BUYER_END__\n"
                    # 将文本插入到区域文本的开头
                    if hasattr(buyer_region, 'lines') and buyer_region.lines:
                        # 在第一行前插入
                        new_line = Line(text=marked_text)
                        buyer_region.lines.insert(0, new_line)
            elif role == 'seller':
                # 添加到销售方区域
                seller_region = doc.regions.get('seller')
                if seller_region:
                    marked_text = f"__AUX_{source}_SELLER_START__\n{text}\n__AUX_{source}_SELLER_END__\n"
                    if hasattr(seller_region, 'lines') and seller_region.lines:
                        new_line = Line(text=marked_text)
                        seller_region.lines.insert(0, new_line)

    # ─── 金额大写 ───
    @staticmethod
    def _to_chinese_amount(num_str: str) -> str:
        """将金额数字转为中文大写"""
        if not num_str or num_str in ('0.00', '0', ''):
            return ''
        try:
            num = float(num_str.replace(',', '').replace('¥', '').replace('￥', '').replace(' ', ''))
        except (ValueError, TypeError):
            return ''

        num = round(num, 2)
        if num == 0:
            return '零元整'

        negative = num < 0
        num = abs(num)

        int_part = int(num)
        decimal_cents = round((num - int_part) * 100)
        jiao = decimal_cents // 10
        fen = decimal_cents % 10

        int_str = str(int_part)
        length = len(int_str)
        int_result = ''
        zero_flag = False

        for i in range(length):
            n = int(int_str[i])
            pos = length - 1 - i
            unit_pos = pos % 4
            group_idx = pos // 4

            if group_idx >= len(_BIG_UNIT):
                return ''  # 金额过大，无法转换

            if n == 0:
                zero_flag = True
                if unit_pos == 0 and int_result:
                    int_result += _BIG_UNIT[group_idx]
            else:
                if zero_flag:
                    int_result += '零'
                    zero_flag = False
                int_result += _DIGIT_CN[n] + _SMALL_UNIT[unit_pos]
                if unit_pos == 0:
                    int_result += _BIG_UNIT[group_idx]

        if not int_result:
            int_result = '零'

        result = int_result + '元'

        if jiao == 0 and fen == 0:
            result += '整'
        else:
            if jiao > 0:
                result += _DIGIT_CN[jiao] + '角'
            elif int_part > 0:
                result += '零'
            if fen > 0:
                result += _DIGIT_CN[fen] + '分'

        if negative:
            result = '负' + result

        return result

    # ─── 明细行金额汇总（通用方法）───
    @staticmethod
    def _aggregate_field_from_line_items(
        line_items: list,
        field_attr: str,
        current: str,
        other_field: str = None,
        amount_hj: str = None,
        needs_comma_strip: bool = False,
        aggregate_label: str = "金额",
        log_tag: str = "Aggregate",
    ) -> str:
        """从明细行汇总指定字段，作为当前值缺失/异常时的安全网。

        通用逻辑：
        1. 汇总所有明细行中 field_attr 对应的值
        2. 当前值为空时使用汇总值
        3. 通过算术校验（current + other ≈ hj）时信任当前值
        4. 差异超过 1.0 时用汇总值
        5. 差异 0.1~1.0 时保留当前值（置信锚点）

        Args:
            line_items: 明细行列表
            field_attr: 要汇总的字段属性名（如 'je', 'se'）
            current: 当前提取的值
            other_field: 另一个字段的值（用于算术校验，如 je 校验需 se）
            amount_hj: 价税合计（用于算术校验）
            needs_comma_strip: 是否在解析当前值时去除逗号
            aggregate_label: 日志中显示的中文标签
            log_tag: 日志前缀
        """
        if not line_items:
            return current

        total = 0.0
        valid_count = 0
        for item in line_items:
            val = getattr(item, field_attr, '') if hasattr(item, field_attr) else item.get(field_attr, '')
            if val:
                try:
                    total += float(str(val).replace(',', ''))
                    valid_count += 1
                except (ValueError, TypeError):
                    pass

        if valid_count == 0:
            return current

        total = round(total, 2)
        aggregated = f"{total:.2f}"

        if not current or current == '':
            logger.debug("[%s] 使用明细行汇总%s: %s", log_tag, aggregate_label, aggregated)
            return aggregated

        try:
            current_val = float(str(current).replace(',', '') if needs_comma_strip else current)

            # 算术校验：如果 current + other_field ≈ hj，信任当前值
            if other_field is not None and amount_hj:
                try:
                    other_val = float(str(other_field).replace(',', ''))
                    if abs(current_val + other_val - float(amount_hj)) <= 0.02:
                        logger.debug("[%s] 当前值已通过算术校验, 保留: %s+%s≈%s",
                                     log_tag, current, other_field, amount_hj)
                        return current
                except (ValueError, TypeError):
                    pass

            diff = abs(current_val - total)

            if diff > 1.0:
                logger.debug("[%s] %s差异 %.2f > 1.0，使用汇总值: %s (原: %s)",
                             log_tag, aggregate_label, diff, aggregated, current)
                return aggregated
            if diff > 0.1:
                logger.debug("[%s] %s差异 %.2f，保留原值(合-计锚点): %s (汇总: %s)",
                             log_tag, aggregate_label, diff, current, aggregated)
            else:
                logger.debug("[%s] %s一致，保留原值: %s", log_tag, aggregate_label, current)
            return current
        except (ValueError, TypeError):
            logger.debug("[%s] 当前%s格式错误，使用汇总值: %s", log_tag, aggregate_label, aggregated)
            return aggregated

    # ─── 税前金额汇总（从明细行计算）───
    def _aggregate_amount_from_line_items(self, line_items: list, current_je: str, current_se: str, amount_hj: str) -> str:
        """从明细行汇总不含税金额，作为 amountJe 缺失/异常时的安全网。"""
        return self._aggregate_field_from_line_items(
            line_items=line_items,
            field_attr='je',
            current=current_je,
            other_field=current_se,
            amount_hj=amount_hj,
            needs_comma_strip=True,
            aggregate_label="税前金额",
            log_tag="AmountAggregate",
        )

    # ─── 税额汇总（从明细行计算）───
    def _aggregate_tax_from_line_items(self, line_items: list, current_se: str, amount_hj: str, current_je: str = None) -> str:
        """从明细行汇总税额，作为安全网"""
        return self._aggregate_field_from_line_items(
            line_items=line_items,
            field_attr='se',
            current=current_se,
            other_field=current_je,
            amount_hj=amount_hj,
            needs_comma_strip=False,
            aggregate_label="税额",
            log_tag="TaxAggregate",
        )

    # ─── 去重 ───
    @staticmethod
    def _dedup(fields: InvoiceFields) -> InvoiceFields:
        """对名称、税号、人员字段去重"""
        name_fields = ['gmfmc', 'xsfmc', 'xmmc']
        tax_fields = ['gmfsh', 'xsfsh']
        person_fields = ['skr', 'fhr', 'kpr']
        text_fields = ['note']

        for key in name_fields:
            val = getattr(fields, key, None)
            if val and isinstance(val, str):
                cleaned = InvoiceExtractor._dedup_lines(val)
                setattr(fields, key, cleaned)

        for key in tax_fields:
            val = getattr(fields, key, None)
            if val and isinstance(val, str):
                cleaned = InvoiceExtractor._dedup_by_pattern(val, r'[0-9A-Za-z]{10,}')
                setattr(fields, key, cleaned)

        for key in person_fields:
            val = getattr(fields, key, None)
            if val and isinstance(val, str):
                cleaned = InvoiceExtractor._dedup_lines(val)
                setattr(fields, key, cleaned)

        for key in text_fields:
            val = getattr(fields, key, None)
            if val and isinstance(val, str):
                cleaned = InvoiceExtractor._dedup_lines(val)
                setattr(fields, key, cleaned)

        return fields

    @staticmethod
    def _dedup_lines(value: str) -> str:
        """按行去重，保持每行内部结构不变"""
        if not value or not isinstance(value, str):
            return value
        normalized = value.replace('\r\n', '\n').replace('\r', '\n')
        parts = normalized.split('\n')
        parts = [p.strip() for p in parts if p.strip()]
        seen = []
        for p in parts:
            if p not in seen:
                seen.append(p)
        if not seen:
            return value
        if len(seen) == 1:
            return seen[0]
        return '\n'.join(seen)

    @staticmethod
    def _dedup_by_pattern(value: str, pattern: str) -> str:
        """按正则匹配去重，适用于税号等结构化字段"""
        if not value or not isinstance(value, str):
            return value
        matches = re.findall(pattern, value)
        if not matches:
            return value
        seen = []
        for m in matches:
            if m not in seen:
                seen.append(m)
        return seen[0] if seen else value
