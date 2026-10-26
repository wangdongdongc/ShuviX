/**
 * mermaid 图在对话里怎么摆 —— 纯函数，不碰 DOM（单测在 node 环境直接跑）。
 *
 * 渲染器按图的内容自己定画布，一张三十个节点的竖向流程图天然两千像素高，原样放进对话就把
 * 一整屏占掉；横向的宽图压到栏宽，字又小到读不了。宽度这一头渲染器自己会让（pele 按栏宽重排，
 * 见 mermaidFence 的 fitWidth），高度这一头由这里管：内联只占一块限高的地方（整张缩进去，或缩
 * 不动时按栏宽截断，见 mermaidLayout）；限高藏住或缩小了图时给「展开」，就地去掉限高（见
 * mermaidUnfoldable）；展开了也只能按栏宽缩着看时，才再给「放大查看」弹窗。
 *
 * 配色不在这里：pele 的产物是 `var(--pele-*)`，由 themes.css 的 `.pele` 那段接到主题 token 上。
 */

/** 内联显示的最大高度（CSS px）：再高的图收起时也只占这么一块，完整的点「展开」看 */
export const MERMAID_MAX_HEIGHT = 480

/** 图的原始尺寸（产物根 `<svg>` 的 viewBox 宽高） */
export interface MermaidSize {
  width: number
  height: number
}

/**
 * 内联显示的宽度上限（px）：不放大（≤ 原宽），并按比例缩到高度不超过 `maxHeight`。
 * 实际显示宽度再与栏宽取小 —— 那一步在 CSS 里（`min(100%, …)`），这里不知道栏有多宽。
 */
export function mermaidFitWidth(size: MermaidSize, maxHeight = MERMAID_MAX_HEIGHT): number {
  return Math.min(size.width, (maxHeight * size.width) / size.height)
}

/** 缩到这个比例以下，图里的字就读不动了（13px 的字缩到 0.6 约 8px） */
export const MERMAID_MIN_READABLE_SCALE = 0.6

/**
 * 内联怎么放：
 *  - `fit`：整张图缩进限高的框里。缩得不狠（≥ MIN_READABLE_SCALE）时总览最有用；
 *  - `clip`：整张缩进去字就读不动了（典型是一长串竖向流程）—— 改按栏宽显示，截在限高处、
 *    底部渐隐，完整的点「展开」看。读得清的前半截比一条看不清的细条有用；
 *  - 宽到连按栏宽都读不动时（极宽的横向图），截断也救不了可读性，退回 `fit` 看个整体形状。
 *
 * `width` 是给 `<svg>` 的显示宽度（px）；`expandable` 表示显示的不是原尺寸全貌（被缩小或截断了）。
 * `maxHeight` 传 `Infinity` 就是展开后的样子（见 mermaidUnfoldedLayout）。
 * 栏宽还没量到（`boxWidth` ≤ 0）时按 `fit` 算、不看栏宽 —— CSS 的 `min(100%, …)` 兜住栏宽。
 */
export interface MermaidLayout {
  mode: 'fit' | 'clip'
  width: number
  expandable: boolean
}

export function mermaidLayout(
  size: MermaidSize,
  boxWidth: number,
  maxHeight = MERMAID_MAX_HEIGHT
): MermaidLayout {
  const fitWidth = mermaidFitWidth(size, maxHeight)
  if (boxWidth <= 0) {
    return { mode: 'fit', width: fitWidth, expandable: fitWidth < size.width - 0.5 }
  }
  const shown = Math.min(boxWidth, fitWidth)
  // 半个像素的容差：栏宽恰好等于原宽时别因为舍入误报「被缩小了」
  const expandable = shown < size.width - 0.5
  if (shown / size.width >= MERMAID_MIN_READABLE_SCALE) {
    return { mode: 'fit', width: shown, expandable }
  }
  const widthOnly = Math.min(boxWidth, size.width)
  if (widthOnly / size.width >= MERMAID_MIN_READABLE_SCALE) {
    return { mode: 'clip', width: widthOnly, expandable: true }
  }
  return { mode: 'fit', width: shown, expandable: true }
}

/**
 * 展开后怎么放：不限高，只受栏宽约束 —— 总是 `fit`，宽度 = 原宽与栏宽取小。它的 `expandable`
 * 就是「展开了还被栏宽缩着」：只有这时「放大查看」弹窗（按原宽、可横向滚动）才多给了点什么。
 * pele 已经按栏宽重排过，所以这通常只发生在重排也收不进这一栏的图上。
 */
export function mermaidUnfoldedLayout(size: MermaidSize, boxWidth: number): MermaidLayout {
  return mermaidLayout(size, boxWidth, Infinity)
}

/**
 * 值不值得给「展开」：限高藏住了图的一部分（`clip`），或把整张缩得比只按栏宽摆时更小（`fit`）。
 * 半个像素的容差同 mermaidLayout。
 */
export function mermaidUnfoldable(
  size: MermaidSize,
  boxWidth: number,
  maxHeight = MERMAID_MAX_HEIGHT
): boolean {
  const capped = mermaidLayout(size, boxWidth, maxHeight)
  if (capped.mode === 'clip') return true
  return mermaidUnfoldedLayout(size, boxWidth).width > capped.width + 0.5
}

/** 内联图的字号（px）：比 pele 缺省的 16 小一档，贴近对话正文（text-sm） */
export const MERMAID_FONT_SIZE = 13
