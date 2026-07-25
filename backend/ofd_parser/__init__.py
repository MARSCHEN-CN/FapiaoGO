"""
ofd_parser 包 - OFD 发票解析
对外 API：
  from ofd_parser import parse_ofd
（render_ofd_page_preview 旧链已于 13-B.5 C2 删除，改用 OFDAdapter.render → WebP）
"""
from ._parser import parse_ofd
