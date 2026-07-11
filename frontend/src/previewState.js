/**
 * V16 Preview State Model
 *
 * 四层状态模型，详见 preview-state-architecture.md
 * 
 * 使用方式：JS 文件通过 JSDoc @type 标注类型，TS 文件直接 import 接口。
 * V16 四层 State 类型定义：DocumentState → PaperLayout → ContentLayout → RenderState
 */

// ── DocumentState ──────────────────────────────────────────────
// 由 loadFilePreview 确定，与渲染器无关

/** @typedef {{ w: number, h: number }} Size */

/** 
 * @typedef {Object} DocumentState
 * @property {string}   id               - 文档唯一标识
 * @property {number}   pageCount        - 总页数
 * @property {Size}     pageSize         - 文档原始像素尺寸
 * @property {'landscape'|'portrait'} pageOrientation - 文档原始方向
 * @property {'pdf'|'ofd'|'image'} sourceType - 文档类型
 * @property {number}   pageNum          - 当前页码
 */

// ── PaperLayout ────────────────────────────────────────────────
// 始终存在，不依赖渲染内容。Paper 不知道 Content。

/** 
 * @typedef {Object} PaperLayout
 * @property {Size}     paperRect        - 纸张物理像素尺寸（如 A5@150dpi = 874x1240）
 * @property {Size}     marginRect       - 安全边距裁切后的区域（含装订边/页码预留）
 * @property {Size}     contentRect      - 内容实际 Fit 区域 ⊆ marginRect（Phase 2A 初期 = marginRect）
 * @property {Size}     displayRect      - 经 orientation 交换后的逻辑尺寸
 * @property {'landscape'|'portrait'} orientation - 最终纸张展示方向（可 ≠ DocumentState.pageOrientation）
 * @property {Size}     clipRect         - 容器裁剪区域
 */

// ── ContentLayout ──────────────────────────────────────────────
// 可为空，有内容时才更新

/** 
 * @typedef {Object} ContentLayout
 * @property {number}   fitScale         - 内容 fit 到 PaperLayout.contentRect 的缩放比
 * @property {Size}     imageRect        - 内容在 PaperLayout.contentRect 内的绘制区域
 * @property {number}   rotation         - 额外旋转角度
 * @property {boolean}  ready            - 内容是否就绪
 * @property {number}   paperDisplayScale - 纸张→窗口缩放（自适应 = fitToWindow，手动 = zoomPercent/100）
 * @property {Size}     paperDisplayRect  - 最终显示容器尺寸（contentRect × paperDisplayScale）
 */

// ── RenderState ────────────────────────────────────────────────
// 描述"当前由谁来画"

/** 
 * @typedef {'re-image'|'canvas'|'ofd'|'skeleton'} RendererType
 * 
 * @typedef {Object} RenderState
 * @property {RendererType} renderer     - 当前渲染器
 * @property {boolean}  loading          - 是否加载中
 * @property {boolean}  ready            - 是否渲染完成
 * @property {?string}  error            - 错误信息（如有）
 */

// ── 构造辅助 ──────────────────────────────────────────────────

/** 创建空 ContentLayout */
export function emptyContentLayout() {
  return { fitScale: 0, imageRect: { w: 0, h: 0 }, rotation: 0, ready: false, paperDisplayScale: 1, paperDisplayRect: { w: 0, h: 0 } }
}

/** 创建初始 RenderState */
export function initialRenderState() {
  return { renderer: 'skeleton', loading: false, ready: false, error: null }
}

/** 创建初始 PaperLayout（占位，加载文件后更新） */
export function placeholderPaperLayout() {
  return { paperRect: { w: 0, h: 0 }, marginRect: { w: 0, h: 0 }, contentRect: { w: 0, h: 0 }, displayRect: { w: 0, h: 0 }, orientation: 'portrait', clipRect: { w: 0, h: 0 } }
}
