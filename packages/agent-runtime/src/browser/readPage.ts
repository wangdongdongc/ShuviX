/**
 * read_page 共享内核 —— 渲染后 DOM 抽取 + HTML→Markdown（turndown，动态加载）。
 *
 * 注入方式由宿主决定：
 *   - 扩展：chrome.scripting.executeScript({ func: extractPage })（函数体序列化注入）
 *   - 桌面：webContents.executeJavaScript(EXTRACT_PAGE_EXPR)
 * turndown 在浏览器用原生 DOM、在 Node 用内置 domino，双端可跑；动态 import 保持懒加载。
 */

export interface ExtractedPage {
  title: string
  url: string
  html: string
}

/** read_page 转换后 Markdown 字符上限 */
export const MAX_PAGE_MARKDOWN_CHARS = 200_000

// 本包被无 DOM lib 的 tsconfig（桌面主进程）整体编译，故用最小局部声明代替全局 DOM 类型；
// declare 不产生代码，extractPage 序列化注入页面后引用的仍是页面全局 document/location。
interface MinimalElement {
  cloneNode(deep: boolean): MinimalElement
  querySelectorAll(selector: string): { forEach(cb: (el: { remove(): void }) => void): void }
  innerHTML: string
}
declare const document: {
  body: MinimalElement | null
  documentElement: MinimalElement
  title: string
}
declare const location: { href: string }

/** 注入页面的抽取函数（自包含；序列化后在目标页执行）：去脚本/样式，返回正文 HTML + 元信息 */
export function extractPage(): ExtractedPage {
  const rootSrc = document.body ?? document.documentElement
  const clone = rootSrc.cloneNode(true)
  clone
    .querySelectorAll('script,style,noscript,svg,template,link,iframe')
    .forEach((el) => el.remove())
  return { title: document.title, url: location.href, html: clone.innerHTML }
}

/** 供 executeJavaScript 使用的自执行表达式形式 */
export const EXTRACT_PAGE_EXPR = `(${extractPage.toString()})()`

/** HTML → Markdown（turndown 按需加载） */
export async function htmlToMarkdown(html: string): Promise<string> {
  const { default: TurndownService } = await import('turndown')
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  return td.turndown(html)
}

/** 拼装 read_page 的最终文本（header + 截断提示） */
export function formatReadPage(extracted: ExtractedPage, markdown: string): string {
  let md = markdown
  let note = ''
  if (md.length > MAX_PAGE_MARKDOWN_CHARS) {
    md = md.slice(0, MAX_PAGE_MARKDOWN_CHARS)
    note = '\n\n[Output truncated — page content exceeded limit.]'
  }
  const header = `Page: ${extracted.title || '(untitled)'}\nURL: ${extracted.url}\n\n`
  return header + md + note
}
