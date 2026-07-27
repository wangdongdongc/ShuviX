/**
 * 展开态详情区的滚动契约 —— 「一个区域只有一个纵向滚动主」
 *
 * 曾经的问题：ToolCallBlock 的详情容器统一套一层 `max-h-80 overflow-y-auto`，而内部渲染器
 * （DiffViewer、CodeView 的 .cm-scroller）各自又限高滚动，两层叠出双滚动条 —— 读完一段 diff
 * 要拖两次，且内层限高比外层还大（400 > 320）时那条滚动条纯属白送。
 *
 * 现在的规则：**外层永不限高，每个叶子自己限高自己滚**。方向不能反过来：CodeMirror 的
 * .cm-scroller 必须是滚动主，否则丢掉视口虚拟化，大文件预览会掉帧。所以让位的只能是外层。
 *
 * 配套两点：滚动容器一律 `overscroll-contain`（滚到底不把整条会话流带跑）+ `thin-scrollbar`
 * （base.css 里的 4px 淡色滚动条，选择器已覆盖内部 .cm-scroller）。
 */

/** 独占整块详情区的渲染器（diff / 流式 args）的限高 */
export const DETAIL_MAX_H = '20rem'

/** 内联代码预览（CodeView）的限高 —— 比 diff 略矮，edit 回退到 oldText/newText 时会并排出现两块 */
export const CODE_MAX_H = '15rem'

const PRE_BASE =
  'text-[11px] text-text-secondary bg-bg-tertiary/50 rounded px-2 py-1 whitespace-pre-wrap break-words overflow-y-auto overscroll-contain thin-scrollbar'

/** 裸文本块（参数 / 结果 / 文本表单项）：与代码块并列出现，各自限高各自滚 */
export const DETAIL_PRE_CLASS = `${PRE_BASE} max-h-40`

/** 流式生成中的原始 args：此刻它是详情区里唯一的内容，给足整块区域的高度 */
export const STREAM_PRE_CLASS = `${PRE_BASE} max-h-80`
