/**
 * mermaid 图在对话里怎么摆 —— 纯函数，不碰 DOM（单测在 node 环境直接跑）。
 *
 * 两件事：
 *  - **尺寸**：mermaid 按图的内容自己定画布，一张三十个节点的竖向流程图天然两千像素高，
 *    原样放进对话就把一整屏占掉；横向的宽图压到栏宽，字又小到读不了。内联只占一块限高的
 *    地方（整张缩进去，或缩不动时按栏宽截断，见 mermaidLayout），显示的不是全貌时给「放大查看」。
 *  - **配色**：mermaid 的主题要具体颜色值（它自己拿颜色做加深减淡），`var(--x)` 喂不进去；
 *    所以把 ShuviX 的主题 token 解析成颜色再交给它的 base 主题 —— 解析交给调用方传进来的
 *    `resolve`，这里只管「哪个 token 对哪个 mermaid 变量」。
 */

/** 内联显示的最大高度（CSS px）：再高的图也只占这么一块，完整的在「放大查看」里看 */
export const MERMAID_MAX_HEIGHT = 480

/** 图的原始尺寸（mermaid 产物根 `<svg>` 的 viewBox 宽高） */
export interface MermaidSize {
  width: number
  height: number
}

/**
 * 从 mermaid 产物的根 `<svg>` 上读 viewBox 的宽高。读不到、或宽高不是正的有限数时返回 null ——
 * 调用方那时不做限高，按原样放（宁可大，也不按一个猜出来的比例把图压变形）。
 */
export function mermaidNaturalSize(svg: string): MermaidSize | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0]
  if (!root) return null
  // 前面必须是空白：`data-viewBox=` 这类属性名里含 viewBox 的不算
  const viewBox = /\sviewBox\s*=\s*["']([^"']*)["']/i.exec(root)?.[1]
  if (!viewBox) return null
  const parts = viewBox
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (parts.length !== 4) return null
  const [, , width, height] = parts
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
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
 *    底部渐隐，完整的去「放大查看」里看。读得清的前半截比一条看不清的细条有用；
 *  - 宽到连按栏宽都读不动时（极宽的横向图），截断也救不了可读性，退回 `fit` 看个整体形状。
 *
 * `width` 是给 `<svg>` 的显示宽度（px）；`expandable` 表示显示的不是原尺寸全貌，值得给「放大查看」。
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

/** 内联图的字号：比 mermaid 缺省的 16px 小一档，贴近对话正文（text-sm） */
export const MERMAID_FONT_SIZE = '13px'

/**
 * ShuviX 主题 token → mermaid `base` 主题变量。
 *
 * 只给几个根变量（底色 / 节点面 / 边框 / 字色 / 连线），其余由 mermaid 自己从它们推导 ——
 * 这样流程图、时序图、状态图、甘特图……共用一套取色，不必逐种图型去对 class 名。
 * 节点面用 `--theme-bg-tertiary`（比卡片底再高一级），连线用三级字色：结构安静，字最显眼。
 *
 * `resolve(token)` 返回该 token 此刻解析出的颜色串（如 `rgb(22, 27, 34)`），由调用方负责。
 */
export function mermaidThemeVariables(
  resolve: (token: string) => string,
  dark: boolean,
  fontFamily: string
): Record<string, string | boolean> {
  const surface = resolve('--theme-bg-secondary')
  const node = resolve('--theme-bg-tertiary')
  const raised = resolve('--theme-bg-hover')
  const border = resolve('--theme-border-primary')
  const text = resolve('--theme-text-primary')
  const line = resolve('--theme-text-tertiary')
  return {
    darkMode: dark,
    background: surface,
    primaryColor: node,
    mainBkg: node,
    secondaryColor: raised,
    tertiaryColor: surface,
    primaryBorderColor: border,
    nodeBorder: border,
    primaryTextColor: text,
    textColor: text,
    titleColor: text,
    lineColor: line,
    defaultLinkColor: line,
    clusterBkg: surface,
    clusterBorder: border,
    edgeLabelBackground: surface,
    noteBkgColor: raised,
    noteTextColor: text,
    noteBorderColor: border,
    fontFamily,
    fontSize: MERMAID_FONT_SIZE
  }
}
