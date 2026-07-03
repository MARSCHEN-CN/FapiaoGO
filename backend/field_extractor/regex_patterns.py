"""
发票字段提取 - 预编译正则表达式（从 field_extractor.py 提取）
"""
import re

# ============================
# 金额/税务基础正则
# ============================
_SMALL_WRITE_RE = re.compile(r'[（(]\s*小写\s*[）)]\s*[¥￥]?\s*([\d,]+\.\d{2})')
_TAX_TOTAL_LINE_RE = re.compile(r'价税合计|小写金额')
_YUAN_RE = re.compile(r'[¥￥]\s*([\d,]+\.\d{2})')
_AMOUNT_NUM_RE = re.compile(r'([\d,]+\.\d{2})')
_PRICE_TAX_TOTAL_RE = re.compile(r'价税合计[^\d]*?([¥￥]?\s*[\d,]+\.\d{2})')
_TOTAL_LINE_RE = re.compile(r'合计')

# ============================
# 名称匹配正则
# ============================
# 全电发票格式: "名称:广州华栈天城科技有限公司"
_NAME_COLON_RE = re.compile(
    r'名\s*称[:：]\s*(.+?)(?=\s+统一社会|\s+纳税人|\s+识别号|\s+名\s*称[:：]|$)',
    re.IGNORECASE
)
# 传统发票带前缀
_BUYER_NAME_FULL_RE = re.compile(
    r'购?\s*买\s*方[:：]?\s*名\s*称[:：]?\s*(.+?)(?=\s+纳税人|\s+识别号|\s+统一社会|\s+名\s*称[:：]|$)',
    re.IGNORECASE
)
_SELLER_NAME_FULL_RE = re.compile(
    r'销?\s*售\s*方[:：]?\s*名\s*称[:：]?\s*(.+?)(?=\s+纳税人|\s+识别号|\s+统一社会|\s+名\s*称[:：]|$)',
    re.IGNORECASE
)

# ============================
# 税号匹配正则
# ============================
_UNIFIED_TAX_RE = re.compile(
    r'统一社会信用代码\s*[/／]\s*纳税人识别号[:：]?\s*([A-Z0-9]{15,20})',
    re.IGNORECASE
)
_TAX_ID_ONLY_RE = re.compile(
    r'纳税人识别号[:：]?\s*([A-Z0-9]{15,20})',
    re.IGNORECASE
)
# [修复2] .*? → [\s\S]*?，支持跨行匹配"购买方"与"纳税人识别号"不在同一行的情况
_BUYER_TAX_FULL_RE = re.compile(
    r'购?\s*买\s*方[\s\S]*?(?:统一社会信用代码\s*[/／]\s*)?纳税人识别号[:：]?\s*([A-Z0-9]{15,20})',
    re.IGNORECASE
)
_SELLER_TAX_FULL_RE = re.compile(
    r'销?\s*售\s*方[\s\S]*?(?:统一社会信用代码\s*[/／]\s*)?纳税人识别号[:：]?\s*([A-Z0-9]{15,20})',
    re.IGNORECASE
)

# ============================
# 备注/人员正则
# [修复3] 终止条件要求关键词后跟冒号（匹配发票字段标签格式），
#         避免备注/人员内容本身包含"收款人""复核"等关键词时误截断
# [修复4] 移除脆弱的负向前瞻，统一用冒号锚定替代
# ============================
_NOTE_RE = re.compile(
    r'备注[:：]\s*(.+?)(?=\s+(?:收款人|复核人?|开\s*票\s*人?|审核人?)[:：]|\n|$)',
    re.IGNORECASE
)
_PAYEE_RE = re.compile(
    r'收款人[:：]\s*(.+?)(?=\s+(?:复核人?|开\s*票\s*人?|审核人?)[:：]|\n|$)',
    re.IGNORECASE
)
_REVIEWER_RE = re.compile(
    r'复核[:：]\s*(.+?)(?=\s+(?:收款人|开\s*票\s*人?|审核人?)[:：]|\n|$)',
    re.IGNORECASE
)
_REVIEWER_RE2 = re.compile(
    r'复核人[:：]\s*(.+?)(?=\s+(?:收款人|开\s*票\s*人?|审核人?)[:：]|\n|$)',
    re.IGNORECASE
)
_ISSUER_RE = re.compile(
    r'开\s*票\s*人[:：]\s*(.+?)(?=\s+项目名称|\s+规格型号|\s+收款人|\s+复核|\s+审核|\s*$)',
    re.IGNORECASE
)

# ============================
# 金额拆分正则（金额/税额分拆）
# ============================
_AMOUNT_JE_RE = re.compile(r'金\s*额[:：]?\s*[¥￥]?\s*([\d,]+\.\d{2})', re.IGNORECASE)
_TAX_SE_RE = re.compile(r'税\s*额[:：]?\s*[¥￥]?\s*([\d,]+\.\d{2})', re.IGNORECASE)
_AMOUNT_JE_TOTAL_RE = re.compile(r'合\s*计.*?金\s*额[:：]?\s*[¥￥]?\s*([\d,]+\.\d{2})', re.IGNORECASE)
_TAX_SE_TOTAL_RE = re.compile(r'合\s*计.*?税\s*额[:：]?\s*[¥￥]?\s*([\d,]+\.\d{2})', re.IGNORECASE)
_AMOUNT_SE_LINE_RE = re.compile(
    r'金\s*额[:：]?\s*[¥￥]?\s*([\d,]+\.\d{2})\s*税\s*额[:：]?\s*[¥￥]?\s*([\d,]+\.\d{2})',
    re.IGNORECASE
)

# ============================
# 金额大写映射常量（非正则）
# [修复5] 明确标注为常量，区别于上方的预编译正则
# [修复6] _BIG_UNIT 补充 '万亿'，覆盖超大金额场景
# ============================
_DIGIT_CN = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
_SMALL_UNIT = ['', '拾', '佰', '仟']
_BIG_UNIT = ['', '万', '亿', '万亿']
