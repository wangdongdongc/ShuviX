/**
 * 对话流 markdown 的共用插件表 —— 只此一份。
 *
 * 过去 9 处 ReactMarkdown 各自内联 `[remarkGfm]` / `[rehypeHighlight, rehypeRaw]`，加公式
 * 渲染时要改 9 遍，漏一处就只有那块不认公式。定成模块级常量还有第二个好处：react-markdown
 * 按引用判等，内联字面量每次渲染都是新数组。
 *
 * 一份就够，别再分叉出「不解析裸 HTML 的那一份」：所有渲染 markdown 的地方（助手正文、
 * 过程区的中间文本、压缩通知、指令文件、子智能体转写）吃的都是同样不可信的输入，走同一条
 * 管线才谈得上「这条管线安全」。
 *
 * 为什么不和 markdownComponents.tsx 放在一起：那边 import 了 react / lucide / i18n / KaTeX
 * 的样式表，在 `environment: 'node'` 的单测里根本加载不起来。顺序就是本管线的安全边界
 * （见下），而「被测的就是生产那一份数组」是这条边界唯一可信的钉法。
 */
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeKatex from 'rehype-katex'
import { remarkMathDollarGuard } from './remarkMathDollarGuard'
import { rehypeSanitizeRawHtml } from './rehypeSanitizeRawHtml'

/** TeX 公式：remark-math 分词 → 单 `$` 按 Pandoc 规则复核（见 remarkMathDollarGuard） */
export const markdownRemarkPlugins = [remarkGfm, remarkMath, remarkMathDollarGuard]

/**
 * 顺序就是安全边界，四个插件的排法都是被这一条定死的：
 *
 *   1. rehype-raw   —— 把正文里的裸 HTML 变成真实元素。**它是唯一把不可信文本变成标记的
 *                      插件**，所以必须排在闸之前，让闸看得见它的产物。
 *   2. 白名单闸     —— 见 rehypeSanitizeRawHtml 的文件头：这里渲染的是不可信文本，而渲染
 *                      进程握着完整的 window.api。裸 HTML 只允许变成排版，不允许变成能力。
 *   3. rehype-highlight / 4. rehype-katex —— 产出的是**可信**标记（hljs 的 class、KaTeX 的
 *                      MathML、内联 style 与 `<svg><path>` 那套符号），排在闸之后就不必为
 *                      它们放宽白名单；排到闸之前则会被闸当作裸 HTML 剥掉。
 *
 * rehype-katex 仍在 rehype-raw 之后，理由没变：raw 会把整棵树序列化再解析一遍，KaTeX 吐出
 * 的 MathML 没必要陪着走一趟。
 */
export const markdownRehypePlugins = [
  rehypeRaw,
  rehypeSanitizeRawHtml,
  rehypeHighlight,
  rehypeKatex
]
