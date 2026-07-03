"""
ofd_parser 包 - OFD 发票解析
对外 API 与拆分前完全兼容：
  from ofd_parser import parse_ofd, render_ofd_page_preview
"""
from ._parser import parse_ofd
from .ofd_page_render import render_ofd_page_preview
