/**
 * ```svg 围栏的**帧判定** —— 一段（可能还没写完的）SVG 源码里，此刻能拿去渲染的是哪一截。
 *
 * 与 `svgSanitize.ts` 的分工：那边管「这段标记注进宿主 DOM 安不安全」，这边管「这段源码
 * 现在成不成形」。两件事都发生在同一条路上，但判定是纯正则、净化要 DOMParser，拆开之后
 * 前者在任何环境都跑得起来（chat-protocol 是零依赖叶子包）。
 *
 * **两个消费方，两种「没写完」**：
 *  - 聊天里的 ```svg 围栏：源码逐字符流进来，每一帧都画 —— 图是一笔一笔长出来的。
 *  - 笔记本 live preview 里的 ```svg 围栏：没有流式，但有**手打到一半**的文档，以及磁盘上
 *    本就被截断的文件。
 * 两者要的是同一个函数：给定任意一截源码，回答「现在能画的是哪一帧」。
 */

/** 开标签已闭合 —— 拿到它才知道 viewBox */
const SVG_OPEN_TAG_RE = /<svg\b[^>]*>/i

/** 自闭合根 `<svg …/>`（贪婪的 [^>]* 会回溯，属性值里的 `/` 不会误判成自闭合） */
const SVG_SELF_CLOSING_RE = /<svg\b[^>]*\/>/i

/**
 * 这段源码写完了没有 —— 决定要不要缓存净化结果、以及判死时要不要出错误卡。
 * 自闭合根也算写完：它永远等不到 `</svg>`，不认的话会永久停在一张空图卡上。
 */
export const isSvgComplete = (code: string): boolean =>
  /<\/svg\s*>/i.test(code) || SVG_SELF_CLOSING_RE.test(code)

/**
 * 可渲染的那一帧 —— 不可渲染时返回 null。
 *
 * **图是一笔一笔画出来的，这是刻意的**：源码逐字符流进来，每一帧都画，用户就看着图长出来。
 * 这不是省下来的复杂度，是这条载体最好的一点 —— 一次性的图本该像在被画，而不是先给你一屏
 * path 数据、末尾再啪地换成成品。
 *
 * 但「每一帧都画」只有卡在对的边界上才成立，两处会抽：
 *
 *  1. **`viewBox` 还没写完**（`<svg viewBox="0 0 32`）—— 属性不完整等于没有 viewBox，
 *     整张图先按错的比例画一遍，等属性写全再跳一次。所以门开在**开标签闭合**那一刻，
 *     不是第一个字符。附带的好处比避开跳变更大：viewBox 一确定，卡片的宽高比就定了，
 *     于是从第一帧起高度就不再变 —— 整个流式过程零布局位移。
 *  2. **尾部半截的元素**（`<rect x="10" y=`）—— 切到最后一个完整标签为止，补上 `</svg>`
 *     交给解析器收尾；没闭合的 `<g>` 它自己会补。于是每一帧都是结构完整的一张图。
 *
 * 判定是 code 的纯函数，不需要知道当前是否正在流式输出：开标签未闭合就落回普通代码块，
 * 于是「模型写坏了、开标签都没写完」也停在源码可见的状态 —— 笔记本里同理，手打到
 * `<svg` 还没闭合时看到的仍是自己正在敲的那行字。
 */
export function authoredSvgFrame(code: string): string | null {
  const open = SVG_OPEN_TAG_RE.exec(code)
  if (!open) return null
  if (isSvgComplete(code)) return code // 已完成：整段交出去
  const cut = code.lastIndexOf('>')
  // 至少要含整个开标签；恰好只有开标签时这一帧是张空图 —— 正是用来占住位置的第一帧
  if (cut < open.index + open[0].length - 1) return null
  return `${code.slice(0, cut + 1)}</svg>`
}

/** 围栏语言名：两个消费方（聊天的 CodeBlock、笔记本的 svg-blocks）认的是同一个字面量 */
export const SVG_FENCE_LANG = 'svg'

/**
 * 该围栏要不要按图渲染 —— 分发判定，与组件分开以便单测（组件要 DOM，判定不要）。
 * 大小写敏感与 mermaid 那档保持一致：提示词教的是小写，两档在这点上不该有分歧。
 */
export const svgFenceIsRenderable = (lang: string, code: string): boolean =>
  lang === SVG_FENCE_LANG && authoredSvgFrame(code) !== null
