/**
 * read_page 的页面抽取函数 —— 自包含、序列化后在目标页里执行。单独成模块，是因为它有两种注入法：
 * 桌面经 CDP `Runtime.evaluate(EXTRACT_PAGE_EXPR)`（见 readPage.ts / cdpOps.readPageOp），
 * Chrome 扩展经 `chrome.scripting.executeScript({ func: extractPage })`（不挂调试横幅）——
 * 扩展只要这个函数，不该为它把 turndown 一起打进包里。
 */

export interface ExtractedPage {
  title: string
  url: string
  html: string
}

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
