/**
 * 网页正文清理：转成 Markdown 之前去掉站点导航、页眉页脚、侧栏和 cookie 横幅。
 *
 * 规则是保守的 —— 宁可留下一点导航，也不删正文：
 * - 只按语义标签和 ARIA 角色删，不按 class 名猜（实测按 class 名多删不到 1%，误删风险却高）；
 * - `aria-hidden` 的元素（收起的菜单、弹出层）删，但表格里的不删（有的页面给表格行加它，
 *   实测 bun.sh 的对比表因此丢行）；
 * - 块里有成段正文、或包着 article / main 的不删；导航例外，只看它有没有包着 article / main
 *   （大菜单里的说明文字也是一段一段的）；
 * - 删完段落文字少了四成以上、或全页可见文字只剩不到四分之一，整页不清理；
 * - 只删了图标、模板、noscript 这类没有可见文字的东西，不算清理过（结果里不加说明）；
 * - 只看 body 里面：body 自己和它的祖先（`<html class="cookie-banner-open">` 之类）从不删。
 *
 * 2026-11-20 在 31 个真实页面上量过：输出总字符少 19%，文章类中位数少 51%。
 * 没有 Electron 依赖；jsdom 用到时才加载（它很重，也是 markitdown-ts 自己用的那一份）。
 */

/** 超过这个长度的 HTML 不清理：jsdom 是同步解析，转换器还要再解析一遍 */
export const MAIN_CONTENT_MAX_HTML_CHARS = 5 * 1024 * 1024

/** 块里的段落文字超过这个数就当它有正文，不删 */
const CONTENT_P_CHARS = 600
/** 段落文字够这个数，才用「段落少了四成」这条安全网 */
const SAFETY_MIN_P_CHARS = 400
const SAFETY_P_KEEP = 0.6
const SAFETY_TEXT_KEEP = 0.25
/** 侧栏里链接文字占到这个比例才算导航（文章里的提示框也常用 aside，它们链接少） */
const ASIDE_LINK_SHARE = 0.5

const NAVIGATION = 'nav, [role=navigation]'

/** 站点页眉；`role=banner` 和 `<header>` 同样对待（页面标题、文章自己的页眉留着） */
const HEADER = 'header, [role=banner]'
/** 站点页脚；`role=contentinfo` 和 `<footer>` 同样对待（引文出处留着） */
const FOOTER = 'footer, [role=contentinfo]'

/** 无条件算页面家具的（仍受「有正文不删」保护） */
const FURNITURE = [
  '[role=search]',
  '[role=dialog]',
  '[role=alertdialog]',
  'dialog',
  '[hidden]',
  'template',
  'noscript',
  'iframe',
  'svg'
].join(',')

/** 常见 cookie 同意组件的固定 id（只认整 id，不按名字猜：「cookie-consent」也可能是正文标题的锚点） */
const CONSENT = [
  '#onetrust-consent-sdk',
  '#onetrust-banner-sdk',
  '#CybotCookiebotDialog',
  '#cookie-law-info-bar'
].join(',')

/** 删掉它们不算「清理过」：没有读者看得见的文字 */
const SILENT = new Set(['svg', 'template', 'noscript', 'iframe', 'script', 'style'])
const NOT_VISIBLE = 'script, style, template, noscript'

const CONTENT_ROOTS = 'article, main, [role=main]'

function textLength(node: { textContent: string | null }): number {
  return (node.textContent ?? '').replace(/\s+/g, '').length
}

/** 读者看得见的文字数：去掉脚本、样式之类元素里的文字（正文里内联的大段 JSON 不该撑住安全网） */
function visibleTextLength(el: Element): number {
  let hidden = 0
  for (const inner of el.querySelectorAll(NOT_VISIBLE)) {
    // 嵌套的只算最外层
    if (inner.parentElement?.closest(NOT_VISIBLE)) continue
    hidden += textLength(inner)
  }
  return textLength(el) - hidden
}

function paragraphText(root: ParentNode): number {
  let total = 0
  for (const p of root.querySelectorAll('p')) total += textLength(p)
  return total
}

function holdsContent(el: Element): boolean {
  return el.querySelector(CONTENT_ROOTS) !== null || paragraphText(el) > CONTENT_P_CHARS
}

function linkShare(el: Element): number {
  const all = textLength(el)
  if (all === 0) return 1
  let links = 0
  for (const a of el.querySelectorAll('a')) links += textLength(a)
  return links / all
}

export interface CleanedPage {
  html: string
}

/**
 * 去掉页面家具后的 HTML；没有可删的、安全网判定删错了、或页面太大时返回 null（调用方用原文）。
 */
export async function cleanMainContent(html: string): Promise<CleanedPage | null> {
  if (html.length > MAIN_CONTENT_MAX_HTML_CHARS) return null
  const { JSDOM, VirtualConsole } = await import('jsdom')
  // 不接 console：jsdom 会把解析不了的样式表报到 console.error
  const dom = new JSDOM(html, { virtualConsole: new VirtualConsole() })
  try {
    const doc = dom.window.document
    const body = doc.body
    if (!body) return null
    const textBefore = visibleTextLength(body)
    const proseBefore = paragraphText(body)
    /** 删掉的读者看得见的文字；为 0 就是没清理出什么 */
    let removedVisible = 0

    const remove = (el: Element): void => {
      if (!SILENT.has(el.localName)) removedVisible += visibleTextLength(el)
      el.remove()
    }
    const each = (selector: string, shouldRemove: (el: Element) => boolean): void => {
      // 只在 body 里找：body 自己和它的祖先（html 上挂的 class）、head 里的东西都不动
      for (const el of Array.from(body.querySelectorAll(selector))) {
        // 父块已经删掉的不用再看
        if (!el.isConnected) continue
        if (shouldRemove(el)) remove(el)
      }
    }

    // 先删导航：站点页眉里的大菜单去掉后，页眉才不会被当成「有正文」
    each(NAVIGATION, (el) => el.querySelector(CONTENT_ROOTS) === null)
    each(FURNITURE, (el) => !holdsContent(el))
    each('[aria-hidden=true]', (el) => !el.closest('table') && !holdsContent(el))
    // 引文的出处常写在 <blockquote><footer> 里
    each(FOOTER, (el) => !el.closest('blockquote') && !holdsContent(el))
    // 文章自己的页眉（标题、作者、日期）留着；站点页眉里要是放着页面标题也留着
    each(HEADER, (el) => !el.closest(CONTENT_ROOTS) && !el.querySelector('h1') && !holdsContent(el))
    each(
      'aside, [role=complementary]',
      (el) => !holdsContent(el) && (!el.closest(CONTENT_ROOTS) || linkShare(el) >= ASIDE_LINK_SHARE)
    )
    each(CONSENT, () => true)

    if (removedVisible === 0) return null
    const proseAfter = paragraphText(body)
    if (proseBefore > SAFETY_MIN_P_CHARS && proseAfter < proseBefore * SAFETY_P_KEEP) return null
    if (visibleTextLength(body) < textBefore * SAFETY_TEXT_KEEP) return null
    return { html: dom.serialize() }
  } finally {
    dom.window.close()
  }
}
