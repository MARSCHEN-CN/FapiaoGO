"""
render_engine/adapters — 格式专属渲染适配器包。

适配器是 render_engine 与第三方解析器之间的「合同桥」：
- 适配器只暴露统一合同：metadata() / render()
- 适配器不进入 engine 核心渲染路径（PDF/Image 仍由 engine 直渲）
- 适配器把格式细节（OFD 多页、字体、CTM）封装在各自模块内

当前成员：
    OFDAdapter  — OFD 文档后端合同（13-A.3.3 新消费链）
"""
