/**
 * read_page 共享内核 —— 渲染后 DOM 抽取 + HTML→Markdown（turndown，动态加载）。
 *
 * 注入方式由宿主决定：
 *   - 扩展：chrome.scripting.executeScript({ func: extractPage })（免 attach，不挂调试横幅）
 *   - 桌面：CDP Runtime.evaluate(EXTRACT_PAGE_EXPR)，见 cdpOps.readPageOp
 *     （**不能**用 Electron 的 webContents.executeJavaScript：它会等页面停止加载，
 *      遇到永远加载不完的站点就永不返回）
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

/**
 * 去掉链接与图片的目标地址，只留方括号里的文字。
 *
 * 实测这些 URL 占 markdown 的 24%~61%（hn 61%、mdn 57%、wikipedia 44%、github 24%），
 * 是 read_page 里最大的一块。而真实会话里 **32 次 read_page 只有 1 个 distinct URL
 * 后来被用于导航** —— 绝大多数链接目标从头到尾没人看。
 *
 * 这是**有损**的，和 snapshot 的压缩不同（后者按 W3C accname 规范可证明无损）。
 * 丢的东西可以精确定位：就是链接目标，正文一个字不少。代价实测下来可以接受 ——
 * 内容类问题 15/15 仍能直接答出；只有问「那个链接指向哪」时才会退化，而 14/15 会
 * 退化到 `evaluate`（均值 93 tok），没有一次去 snapshot 或 screenshot。
 * 精简 + 一次 evaluate 往返仍比全量便宜四倍。
 *
 * 保留方括号（`[text]`）是有意的：模型据此知道这里**曾是**一个链接，只是目标没给。
 */
/**
 * 代码区域（围栏块与行内代码）—— 必须整段跳过。
 *
 * `handlers[0](arg)` 这种「从数组取函数再调用」的写法在语法上和 markdown 链接
 * 一模一样，不跳过就会被剥成 `handlers[0]`，**把代码改坏**。read_page 大量用于读
 * 文档，MDN 这类页面满屏都是代码，这不是理论风险。
 */
const CODE_REGIONS = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*`+)/g

/**
 * 遮蔽用的定界符 —— 私用区字符，正常网页正文里不会出现（图标字体偶尔会用，
 * 所以调用处还加了一道「输入已含此字符就放弃精简」的守卫）。
 * 用 fromCharCode 而不是字面量转义：源码里写转义容易在编辑时被折叠成真实字符。
 */
const MARK = String.fromCharCode(0xe000)
const PLACEHOLDER = new RegExp(`${MARK}(\\d+)${MARK}`, 'g')

export function stripLinkTargets(markdown: string): { markdown: string; stripped: number } {
  let stripped = 0
  const drop = (_m: string, keep: string): string => {
    stripped++
    return keep
  }
  // 代码区域先**遮蔽成占位符**，剥完再还原 —— 不能按代码区切段后分别处理：
  // MDN 的文档风格大量是 [`code`](url)，切段会把链接拆成 `[` + 代码 + `](url)`，
  // 两边都匹配不上，URL 全留下来（实测 mdn 的收益因此从 56% 掉到 27%）。
  // 占位符用 \u0000 包裹，不含任何 markdown 语法字符，不会干扰下面的匹配。
  // 万一页面本身就含这个字符（图标字体会用私用区），直接放弃精简 —— 宁可不省，
  // 也不能让还原步骤张冠李戴。
  if (markdown.includes(MARK)) return { markdown, stripped: 0 }
  const code: string[] = []
  let md = markdown.replace(CODE_REGIONS, (m) => `${MARK}${code.push(m) - 1}${MARK}`)

  // 图片先处理：`![alt](url)` 是 `[text](url)` 的超集，顺序反了会把 `!` 落单。
  md = md.replace(/(!\[[^\]]*\])\((?:<[^>]*>|[^)]*)\)/g, drop)
  // 链接的方括号里允许再套一层（`[![alt]](url)` 这种图片链接很常见，实测 hn 首行就是）。
  // 内层已被上一步剥掉，这里只需处理外层。
  md = md.replace(/(\[(?:[^[\]]|\[[^\]]*\])*\])\((?:<[^>]*>|[^)]*)\)/g, drop)

  md = md.replace(PLACEHOLDER, (_m, i: string) => code[Number(i)])
  return { markdown: md, stripped }
}

/**
 * 省下的字符太少就别动 —— 只有一两个链接的小页面，那句自证提示比省下来的还贵
 * （实测 example.com 上 54 → 67 tok，净亏）。低于这条线时输出与改造前逐字节相同。
 */
const MIN_LINK_SAVING_CHARS = 200

/** 拼装 read_page 的最终文本（header + 链接说明 + 截断提示） */
export function formatReadPage(extracted: ExtractedPage, markdown: string): string {
  const t = stripLinkTargets(markdown)
  // 省得太少就原样放行（含提示在内会净亏），见 MIN_LINK_SAVING_CHARS
  const worth = markdown.length - t.markdown.length >= MIN_LINK_SAVING_CHARS
  const stripped = worth ? t.stripped : 0
  let md = worth ? t.markdown : markdown
  let note = ''
  if (md.length > MAX_PAGE_MARKDOWN_CHARS) {
    md = md.slice(0, MAX_PAGE_MARKDOWN_CHARS)
    note = '\n\n[Output truncated — page content exceeded limit.]'
  }
  // 自证：说明少了什么、怎么补。放表头而不是结尾 —— 几千行之后的脚注未必被读到。
  // 实测不说也有 14/15 自己摸到 evaluate，明说是为了省掉那一轮试探。
  const links =
    stripped > 0
      ? `(${stripped} link target${stripped > 1 ? 's' : ''} omitted — text kept as [label]; ` +
        `use evaluate to get a specific href)\n`
      : ''
  const header = `Page: ${extracted.title || '(untitled)'}\nURL: ${extracted.url}\n${links}\n`
  return header + md + note
}
