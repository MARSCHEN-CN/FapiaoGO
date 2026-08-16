"""
全局一致性校验层（InvoiceValidator）

在字段提取完成后，进行跨字段一致性校验：
  - 买卖方不等
  - 金额等式校验（含红字符号一致性）
  - 大写金额与小写金额辅助校验
  - 日期合理性
  - 发票号码格式
  - 明细汇总校验（含行级单价×数量、税率等式）
  - 人员字段互斥
"""
import re
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import List, Optional, Dict

from .models import InvoiceFields, InvoiceLineItem, OCRDocument
from .candidates import FieldCandidate

logger = logging.getLogger(__name__)


@dataclass
class ValidationResult:
    """校验结果"""
    fields: InvoiceFields
    confidence: Dict[str, float] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    corrections: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            'confidence': self.confidence,
            'warnings': self.warnings,
            'corrections': self.corrections,
        }


class InvoiceValidator:
    """全局一致性校验器"""

    # 合法增值税率（含征收率：1%、1.5%、3%、5% 等）
    _VALID_TAX_RATES = [0.0, 0.01, 0.015, 0.03, 0.05, 0.06, 0.09, 0.13]

    # 开票日期业务下限年份（中国电子发票推广起点，可视业务需要调整）
    _EARLIEST_YEAR: int = 2000

    # 开票日期业务允许最早完整日期（比 _EARLIEST_YEAR 更精细的下限，可设为 "2012-01-01"）
    _EARLIEST_DATE: Optional[str] = None  # None 表示仅用 _EARLIEST_YEAR 做年份判断

    def validate(
        self,
        fields: InvoiceFields,
        doc: OCRDocument = None,
        candidates: List[FieldCandidate] = None,
    ) -> ValidationResult:
        """执行全局校验"""
        result = ValidationResult(fields=fields)

        # 初始化置信度
        result.confidence = self._init_confidence(fields, candidates)

        # 执行各项校验
        self._check_buyer_seller(fields, result)
        self._check_tax_id_vs_fphm(fields, result)
        self._check_amount_consistency(fields, result)
        self._check_uppercase_amount(fields, result)
        self._check_date_reasonability(fields, result)
        self._check_line_item_sum(fields, result)
        self._check_tax_rate(fields, result)
        self._check_fphm_format(fields, result)
        self._check_person_exclusive(fields, result)

        return result

    # ─── 置信度初始化 ───
    # 说明：confidence 由 score/100.0 派生（见 FieldCandidate.__post_init__），
    # 以下统一使用 confidence（0-1 归一化）做选择和输出。

    def _init_confidence(
        self,
        fields: InvoiceFields,
        candidates: List[FieldCandidate] = None,
    ) -> Dict[str, float]:
        """从候选列表中提取字段置信度（统一使用 confidence 字段）"""
        conf = {}
        if not candidates:
            # 无候选信息时，基于字段是否有值给出默认置信度
            field_map = {
                'fphm': fields.fphm,
                'kprq': fields.kprq, 'gmfmc': fields.gmfmc,
                'gmfsh': fields.gmfsh, 'xsfmc': fields.xsfmc,
                'xsfsh': fields.xsfsh, 'amountHj': fields.amountHj,
                'amountJe': fields.amountJe, 'amountSe': fields.amountSe,
            }
            for name, value in field_map.items():
                if value and value not in ('未知号码', '未知日期', '0.00', ''):
                    conf[name] = 0.8  # 默认置信度
                else:
                    conf[name] = 0.0
            return conf

        # 从候选中找到每个字段的最佳候选（统一用 confidence 比较）
        best: dict = {}
        for c in candidates:
            if c.value and c.field not in best:
                best[c.field] = c
            elif c.value and c.field in best and c.confidence > best[c.field].confidence:
                best[c.field] = c

        for name in ['fphm', 'kprq', 'gmfmc', 'gmfsh',
                      'xsfmc', 'xsfsh', 'amountHj', 'amountJe', 'amountSe']:
            if name in best:
                conf[name] = best[name].confidence
            else:
                conf[name] = 0.0

        return conf

    # ─── 校验规则 ───

    def _check_buyer_seller(self, fields: InvoiceFields, result: ValidationResult) -> None:
        """购买方 ≠ 销售方"""
        if fields.gmfmc and fields.xsfmc and fields.gmfmc == fields.xsfmc:
            result.warnings.append('购买方名称与销售方名称相同')
            result.confidence['gmfmc'] = min(result.confidence.get('gmfmc', 0.8), 0.5)
            result.confidence['xsfmc'] = min(result.confidence.get('xsfmc', 0.8), 0.5)

    def _check_tax_id_vs_fphm(self, fields: InvoiceFields, result: ValidationResult) -> None:
        """税号不能等于发票号码"""
        if not fields.fphm:
            return
        for tax_field, label in [('gmfsh', '购买方'), ('xsfsh', '销售方')]:
            tax_val = getattr(fields, tax_field, '')
            if tax_val and tax_val == fields.fphm:
                result.warnings.append(f'发票号码与{label}税号相同')
                result.confidence['fphm'] = min(result.confidence.get('fphm', 0.8), 0.4)

    def _check_amount_consistency(self, fields: InvoiceFields, result: ValidationResult) -> None:
        """金额 + 税额 ≈ 价税合计（含红字发票符号一致性）"""
        try:
            hj = float(fields.amountHj) if fields.amountHj else 0
            je = float(fields.amountJe) if fields.amountJe else 0
            se = float(fields.amountSe) if fields.amountSe else 0
        except (ValueError, TypeError):
            return

        if hj == 0:
            return

        # ① 红字发票：hj < 0 时要求 je 和 se 符号一致（均 <= 0）
        if hj < 0:
            if je > 0 or se > 0:
                result.warnings.append(
                    f'红字发票价税合计({hj})为负，但金额({je})或税额({se})为正，符号不一致'
                )
                result.confidence['amountHj'] = min(
                    result.confidence.get('amountHj', 0.8), 0.5
                )
                result.confidence['amountJe'] = min(
                    result.confidence.get('amountJe', 0.8), 0.5
                )
                result.confidence['amountSe'] = min(
                    result.confidence.get('amountSe', 0.8), 0.5
                )

        # ② 金额等式校验（正票和红字均适用）
        if je != 0 or se != 0:
            diff = abs(hj - (je + se))
            if diff > 0.1:
                result.warnings.append(
                    f'金额({je})+税额({se})与价税合计({hj})差异 {diff:.2f}'
                )
                result.confidence['amountHj'] = min(
                    result.confidence.get('amountHj', 0.8), 0.5
                )
            elif diff > 0.01:
                result.warnings.append(
                    f'金额+税额与价税合计微小差异 {diff:.2f}'
                )

    def _check_date_reasonability(self, fields: InvoiceFields, result: ValidationResult) -> None:
        """开票日期不能明显晚于当前日期，不能早于业务下限"""
        if not fields.kprq or fields.kprq == '未知日期':
            return

        try:
            date = datetime.strptime(fields.kprq, '%Y-%m-%d')
            future_limit = datetime.now() + timedelta(days=30)
            if date > future_limit:
                result.warnings.append(
                    f'开票日期 {fields.kprq} 晚于当前日期+30天'
                )
                result.confidence['kprq'] = min(
                    result.confidence.get('kprq', 0.8), 0.4
                )

            # 精细下限（_EARLIEST_DATE 优先，其次 _EARLIEST_YEAR）
            if self._EARLIEST_DATE:
                earliest = datetime.strptime(self._EARLIEST_DATE, '%Y-%m-%d')
                if date < earliest:
                    result.warnings.append(
                        f'开票日期 {fields.kprq} 早于业务允许最早日期 {self._EARLIEST_DATE}'
                    )
                    result.confidence['kprq'] = min(
                        result.confidence.get('kprq', 0.8), 0.4
                    )
            elif date.year < self._EARLIEST_YEAR:
                result.warnings.append(
                    f'开票日期 {fields.kprq} 早于{self._EARLIEST_YEAR}年'
                )
                result.confidence['kprq'] = min(
                    result.confidence.get('kprq', 0.8), 0.4
                )
        except ValueError:
            pass

    def _check_line_item_sum(self, fields: InvoiceFields, result: ValidationResult) -> None:
        """明细行金额汇总 ≈ 合计金额，并逐行校验单价×数量≈je、je×税率≈se"""
        if not fields.line_items:
            return

        try:
            hj = float(fields.amountHj) if fields.amountHj else 0
        except (ValueError, TypeError):
            return

        if hj == 0:
            return

        # ① 汇总 vs 合计
        total_je = 0.0
        total_se = 0.0
        valid_count = 0
        for item in fields.line_items:
            try:
                if item.je:
                    total_je += float(item.je)
                if item.se:
                    total_se += float(item.se)
                valid_count += 1
            except (ValueError, TypeError):
                continue

        if valid_count == 0:
            return

        total_sum = round(total_je + total_se, 2)
        diff = abs(hj - total_sum)
        if diff > 1.0:  # 允许 1 元的误差（四舍五入累积）
            result.warnings.append(
                f'明细汇总({total_sum:.2f})与价税合计({hj})差异 {diff:.2f}'
            )

        # ② 逐行校验
        for idx, item in enumerate(fields.line_items):
            row_label = f'第{idx + 1}行'
            try:
                je_val = float(item.je) if item.je else None
                se_val = float(item.se) if item.se else None
                sl_val = float(item.sl) if item.sl else None
                dj_val = float(item.dj) if item.dj else None
                slv_raw = item.slv or ''

                # 解析税率：支持 "13%"、"0.13"、"13" 等格式
                slv_val: Optional[float] = None
                slv_clean = slv_raw.strip().replace('免税', '0').replace('不征税', '0')
                has_percent = '%' in slv_raw  # 记录原始字符串是否包含 %
                slv_clean = slv_clean.replace('%', '')
                if slv_clean:
                    try:
                        v = float(slv_clean)
                        # 如果原始字符串含 %，则 v 是百分比值（如 "1%" → v=1 → slv_val=0.01）
                        # 如果原始字符串不含 %，则 v 可能是比例值（如 "0.13"）或百分比值（如 "13"）
                        if has_percent:
                            slv_val = v / 100.0
                        else:
                            slv_val = v / 100.0 if v > 1 else v
                    except ValueError:
                        pass

                # 折扣行（je < 0）跳过单价×数量校验，但保留税额比例校验
                is_discount_row = (je_val is not None and je_val < 0)

                # 2a. 单价 × 数量 ≈ je（非折扣行且三项均有值）
                if not is_discount_row and sl_val is not None and dj_val is not None and je_val is not None:
                    expected_je = round(sl_val * dj_val, 2)
                    row_diff = abs(je_val - expected_je)
                    if row_diff > max(0.05, abs(je_val) * 0.001):
                        result.warnings.append(
                            f'明细{row_label}：单价({dj_val})×数量({sl_val})={expected_je:.2f}，'
                            f'与金额({je_val})差异 {row_diff:.2f}'
                        )

                # 2b. je × 税率 ≈ se（两项均有值且税率已知）
                if je_val is not None and se_val is not None and slv_val is not None and slv_val > 0:
                    expected_se = round(abs(je_val) * slv_val, 2)
                    actual_se = abs(se_val)
                    se_diff = abs(actual_se - expected_se)
                    if se_diff > max(0.05, expected_se * 0.01):
                        result.warnings.append(
                            f'明细{row_label}：金额({je_val})×税率({slv_raw})={expected_se:.2f}，'
                            f'与税额({se_val})差异 {se_diff:.2f}'
                        )

                # 2c. 明细行税率合法性
                if slv_val is not None:
                    closest = min(self._VALID_TAX_RATES, key=lambda r: abs(r - slv_val))
                    if abs(slv_val - closest) > 0.005:
                        result.warnings.append(
                            f'明细{row_label}：税率 {slv_raw} 不是合法增值税率'
                        )

            except (ValueError, TypeError, ZeroDivisionError):
                continue

    def _check_uppercase_amount(self, fields: InvoiceFields, result: ValidationResult) -> None:
        """大写金额与小写价税合计辅助校验"""
        if not fields.amountHjDx or not fields.amountHj:
            return

        # 将大写金额转为浮点（简单映射，处理常见格式）
        dx_float = self._parse_chinese_amount(fields.amountHjDx)
        if dx_float is None:
            return  # 无法解析大写，跳过

        try:
            hj = float(fields.amountHj)
        except (ValueError, TypeError):
            return

        logger.info("[Validator Debug] 大写校验: fields.amountHj=%r fields.amountJe=%r fields.amountHjDx=%r dx_float=%.2f hj=%.2f",
                     fields.amountHj, fields.amountJe, fields.amountHjDx, dx_float, hj)

        if hj == 0:
            return

        # 允许 0.5 元内的四舍五入误差
        diff = abs(abs(dx_float) - abs(hj))
        if diff > 0.5:
            result.warnings.append(
                f'大写金额({fields.amountHjDx}≈{dx_float:.2f})与小写价税合计({hj})不一致，差异 {diff:.2f}'
            )
            result.confidence['amountHj'] = min(
                result.confidence.get('amountHj', 0.8), 0.6
            )

    @staticmethod
    def _parse_chinese_amount(text: str) -> Optional[float]:
        """将大写金额文本转换为浮点数（仅支持阿拉伯数字大写混合格式）"""
        if not text:
            return None
        # 先尝试直接从文本中提取数字（如"壹万贰仟叁佰肆拾伍元陆角柒分"或含¥的混合格式）
        # 策略：提取所有阿拉伯/中文数字组合
        cleaned = text.strip()

        # 大写汉字数字映射
        cn_map = {
            '零': 0, '壹': 1, '贰': 2, '叁': 3, '肆': 4,
            '伍': 5, '陆': 6, '柒': 7, '捌': 8, '玖': 9,
            '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
            '六': 6, '七': 7, '八': 8, '九': 9,
        }
        unit_map = {
            '分': 0.01, '角': 0.1, '元': 1, '圆': 1, '拾': 10, '十': 10,
            '佰': 100, '百': 100, '仟': 1000, '千': 1000,
            '万': 10000, '亿': 100000000,
        }

        # 如果文本中含有阿拉伯数字，直接提取
        arabic_match = re.search(r'[\d,，]+\.?\d*', cleaned)
        if arabic_match:
            try:
                return float(arabic_match.group().replace(',', '').replace('，', ''))
            except ValueError:
                pass

        # 纯汉字大写解析（简化版：到元/角/分级别）
        try:
            result_val = 0.0
            current = 0
            unit_multiplier = 1
            i = 0
            while i < len(cleaned):
                ch = cleaned[i]
                if ch in cn_map:
                    current = cn_map[ch]
                elif ch in unit_map:
                    u = unit_map[ch]
                    if u >= 10000:
                        unit_multiplier = u
                        result_val += current * u
                        current = 0
                    elif u >= 1:
                        result_val += current * u
                        current = 0
                    else:
                        result_val += current * u
                        current = 0
                i += 1
            result_val += current  # 剩余
            return result_val if result_val > 0 else None
        except Exception:
            return None

    def _check_tax_rate(self, fields: InvoiceFields, result: ValidationResult) -> None:
        """税额/金额 ≈ 合法税率"""
        try:
            je = float(fields.amountJe) if fields.amountJe else 0
            se = float(fields.amountSe) if fields.amountSe else 0
        except (ValueError, TypeError):
            return

        if je <= 0 or se <= 0:
            return

        actual_rate = se / je
        # 检查是否接近合法税率
        closest_rate = min(self._VALID_TAX_RATES, key=lambda r: abs(r - actual_rate))
        deviation = abs(actual_rate - closest_rate)

        if deviation > 0.02:  # 偏差超过 2%
            result.warnings.append(
                f'实际税率 {actual_rate:.2%} 不接近任何合法税率'
            )

    def _check_fphm_format(self, fields: InvoiceFields, result: ValidationResult) -> None:
        """发票号码格式校验：8-20 位数字"""
        if not fields.fphm or fields.fphm == '未知号码':
            return

        clean = fields.fphm.replace(' ', '')
        if not re.match(r'^\d{8,20}$', clean):
            result.warnings.append(f'发票号码格式异常: {fields.fphm}')
            result.confidence['fphm'] = min(result.confidence.get('fphm', 0.8), 0.5)

    def _check_person_exclusive(self, fields: InvoiceFields, result: ValidationResult) -> None:
        """收款人/复核人/开票人不应完全相同"""
        persons = [
            ('skr', fields.skr, '收款人'),
            ('fhr', fields.fhr, '复核人'),
            ('kpr', fields.kpr, '开票人'),
        ]
        values = [(k, v, label) for k, v, label in persons if v]
        if len(values) >= 2:
            vals = [v for _, v, _ in values]
            if len(set(vals)) == 1 and vals[0]:
                result.warnings.append('收款人/复核人/开票人全部相同')
