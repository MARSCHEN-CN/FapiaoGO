/**
 * V16 Preview State Model
 *
 * 四层状态模型，详见 preview-state-architecture.md
 * 
 * 使用方式：JS 文件通过 JSDoc @type 标注类型，TS 文件直接 import 接口。
 * V16 四层 State 类型定义：DocumentState → PaperLayout → ContentLayout → RenderState
 */

import { PREVIEW_DPI } from './config.js'
import { resolvePaper } from './layout/resolvePaper.js'

// ── DocumentState ──────────────────────────────────────────────
// 由 loadFilePreview 确定，与渲染器无关

/** @typedef {{ w: number, h: number }} Size */

/** 
 * @typedef {Object} DocumentState
 * @property {string}   id               - 文档唯一标识
 * @property {number}   pageCount        - 总页数
 * @property {Size}     pageSize         - 文档原始像素尺寸
 * @property {'landscape'|'portrait'} pageOrientation - 文档原始方向
 * @property {number}   rotation         - 文件级旋转（/Rotate 或预览旋转），°；最终旋转由 RenderLayoutFactory 归一到 {0,90,180,270}
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
 * @property {Size}     displayRect      - 纸张逻辑尺寸（纯纸张，不含方向 swap；swap → RenderLayout，Stage 1）
 * @property {'landscape'|'portrait'} [orientation] - [DEPRECATED Stage 0.5 删除] 历史字段；方向由 paperRect.width > height 推导，不得写入/读取 PaperLayout
 * @property {Size}     clipRect         - 纸张裁剪区域（纸张坐标，非 viewport）
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

// ── PaperSpec（Fact，唯一输入） ──────────────────────────────
// 仅描述纸张与边距，与文档完全无关。PaperSpec 改变只影响 PaperLayout。

/** @typedef {{widthMM: number, heightMM: number}} PaperDims */

/**
 * @typedef {Object} PaperSpec
 * @property {string} paperSize                       - 如 'A4' / 'A5' / 'Letter' / 'custom'
 * @property {?PaperDims} customPaper                 - 自定义纸张尺寸（paperSize==='custom' 时生效）
 * @property {{top:number,right:number,bottom:number,left:number}} margins - 安全边距，单位 mm
 */

/**
 * 视觉边距 → 物理边距转换。
 * 用户 UI 上的"左边距"始终表示"用户看到的纸的左边缘距离"。
 * 当纸为 landscape（物理纸旋转了 90° CW）时，视觉边与物理边的映射为：
 *   视觉左 → 物理底, 视觉上 → 物理左, 视觉右 → 物理上, 视觉下 → 物理右。
 * 此后所有代码（usableRect / placement / backend / render）全部只认物理坐标。
 *
 * @param {{top:number,right:number,bottom:number,left:number}} visualMargins
 * @param {boolean} paperLandscape
 * @returns {{top:number,right:number,bottom:number,left:number}}
 */
export function resolvePhysicalMargins(visualMargins, paperLandscape) {
  if (!paperLandscape) return { ...visualMargins }
  const l = visualMargins.left ?? 3, r = visualMargins.right ?? 3
  const t = visualMargins.top ?? 3, b = visualMargins.bottom ?? 3
  return {
    left: t,          // 视觉上 → 物理左
    top: r,           // 视觉右 → 物理上
    right: b,         // 视觉下 → 物理右
    bottom: l,        // 视觉左 → 物理底
  }
}

/**
 * 唯一构造点（F3）：从 PaperSpec 推导 PaperLayout。
 * 纯函数（F5）：仅依赖入参，不读 React State / DocumentState / container / zoom。
 * PaperLayout 只含纸张坐标系（I1），不含方向 swap（swap 属于 RenderLayout.placement，Stage 1）。
 * 禁止被其它 Factory 调用（F6）。
 *
 * @param {PaperSpec} spec
 * @returns {PaperLayout}
 */
export function computePaperLayout(spec) {
  const { paperSize = 'A4', customPaper = null, margins = {} } = spec || {}
  const paper = resolvePaper(paperSize, customPaper)
  const dpi = PREVIEW_DPI
  const paperW = Math.round(paper.widthMM / 25.4 * dpi)
  const paperH = Math.round(paper.heightMM / 25.4 * dpi)

  const mTop = Math.round((margins.top ?? 3) / 25.4 * dpi)
  const mBottom = Math.round((margins.bottom ?? 3) / 25.4 * dpi)
  const mLeft = Math.round((margins.left ?? 3) / 25.4 * dpi)
  const mRight = Math.round((margins.right ?? 3) / 25.4 * dpi)

  const innerW = Math.max(0, paperW - mLeft - mRight)
  const innerH = Math.max(0, paperH - mTop - mBottom)

  return {
    paperRect: { w: paperW, h: paperH },
    marginRect: { w: innerW, h: innerH },
    contentRect: { w: innerW, h: innerH },            // Phase 2A: = marginRect（预留装订边/水印扩展空间）
    // usableRect：允许摆放的安全区（带原点）。contentRect 仅描述尺寸（无 x/y），
    // 摆放原点由 usableRect 承担 —— 见 RenderLayoutFactory 的 slot 桥接
    // （修复「图绕纸张中心而非安全区居中」：offset 必须 = mLeft + (innerW-drawW)/2）。
    usableRect: { x: mLeft, y: mTop, w: innerW, h: innerH },
    displayRect: { w: paperW, h: paperH },            // 纯纸张，无 doc swap（swap → RenderLayout，Stage 1）
    clipRect: { w: paperW, h: paperH },               // 纸张坐标，非 viewport（I1）
    // orientation 字段已废弃（Stage 0.5 删除）：由 paperRect.width > height 推导
  }
}
