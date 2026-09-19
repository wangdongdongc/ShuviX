/**
 * 渲染树的白名单闸 —— 跟在 rehype-raw 之后跑。
 *
 * 为什么需要：对话正文是**不可信输入**。模型的输出里混着它读进来的东西（browser/CDP 抓的
 * 网页、read 读到的文件、MCP server 的返回、子会话的汇报），而这份 markdown 渲染在**特权
 * 渲染进程**里 —— 那里有完整的 window.api（写文件、跑终端）。rehype-raw 会把正文里的裸
 * HTML 变成真实 DOM 元素，于是一句提示注入就能换来渲染进程里的任意 JS。这正是
 * svgSanitize.ts 头注释论证过的威胁模型（「任何在该源里执行的脚本都等于完全沦陷」），
 * 只是裸 HTML 这条路绕过了那道闸。
 *
 * 实测过的四条（真实 Chromium + 真 react-markdown，用例见 e2e/specs/chat/markdown-sanitize）：
 * React 确实丢掉了 `onerror`、react-markdown 的 urlTransform 确实清掉了 `javascript:` ——
 * 但 `<svg><script>…</script></svg>` 会执行，`<iframe srcdoc>` 同源执行，`<style>` 活着即
 * 全局 CSS 注入（`* { display: none }` 抹掉整个界面），`<div style="position:fixed;inset:0">`
 * 活着即整屏遮罩 / 界面仿冒。指望「React 会丢掉危险属性」不是防御，是运气。
 *
 * 采用白名单而不是黑名单：上面四条里有三条不在任何一份常见的「危险标签」清单上，黑名单
 * 挡不住没想到的写法。三档处理：
 *   1. `STRIP_TAGS` —— 能执行、能拉远端、能改全局样式的，连内容一起删；
 *   2. 不在 `ALLOWED_TAGS` 里的其余标签 —— 只拆外壳、文字留下（`<center>hi</center>` → `hi`）；
 *   3. `ALLOWED_TAGS` 里的 —— 属性再过一遍白名单，表外一律丢（含全部 `on*`、`style`、`data-*`）。
 *
 * class 与 style 同罪：应用全局挂着 tailwind 的原子类，`class="fixed inset-0 z-50 bg-black"`
 * 和 `style="position:fixed"` 是同一块遮罩 —— 只挡 style 等于没挡。
 *
 * href/src 自己再过一遍协议白名单，尽管 react-markdown 的 urlTransform 已经清过一遍：
 * 主进程的 `will-navigate` 直接把点中的 URL 交给 `shell.openExternal`（见 main/index.ts），
 * 那是操作系统级的交接，不该只由渲染库的一个可替换选项把守。
 *
 * **插件顺序是这道闸的前提**（见 markdownComponents.tsx 的插件表）：把不可信文本变成标记的
 * 插件（rehype-raw）排在闸**之前**，产出可信标记的插件（rehype-highlight 的 hljs class、
 * rehype-katex 的 MathML 与内联 style）排在闸**之后**。顺序反了，这道闸就会去剥 KaTeX 和
 * hljs 自己的输出 —— 别为此放宽下面的表，把插件排回去。
 */

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/**
 * 连内容一起删的标签 —— 能执行脚本、能拉远端、能改全局样式的那一类。
 * 只拆外壳对它们没用：`<style>` 的内容是 CSS，`<script>` 的内容是代码，留下正是漏洞本身。
 * `<svg>` / `<math>` 在列是因为它们各自带着一套脚本入口（SVG 的 `<script>` 实测会执行），
 * 正经的图形走代码围栏那条路（mermaid / svg 块经 svgSanitize 净化），不走裸 HTML。
 */
const STRIP_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'link',
  'meta',
  'base',
  'form',
  'button',
  'select',
  'option',
  'textarea',
  'svg',
  'math',
  'template',
  'noscript',
  'title',
  'canvas',
  'audio',
  'video',
  'source',
  'track',
  'param',
  'map',
  'area',
  'portal',
  'slot',
  'dialog'
])

/**
 * 保留成真实元素的标签 —— 全是排版，没有一个能动网络或脚本。
 * `<input>` 只为任务列表的复选框而留，见下面的 `checkbox` 判定。
 */
const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'hr',
  'blockquote',
  'pre',
  'code',
  'span',
  'div',
  'section',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'a',
  'img',
  'em',
  'strong',
  'b',
  'i',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'small',
  'sub',
  'sup',
  'kbd',
  'samp',
  'var',
  'abbr',
  'cite',
  'q',
  'dfn',
  'time',
  'wbr',
  'bdi',
  'bdo',
  'ruby',
  'rt',
  'rp',
  'details',
  'summary',
  'figure',
  'figcaption',
  'input'
])

/**
 * class 的取值白名单 —— 每一条都是管线自己产出的，别按「看着像是要用的」往里加。
 *   - `language-*` / `math-inline` / `math-display`：remark-math 与代码围栏的语言标记，
 *     rehype-katex 与 CodeBlock 都靠它认块（实测形如 `code.language-math.math-display`）；
 *   - `contains-task-list` / `task-list-item`：remark-gfm 的任务列表；
 *   - `footnotes` / `sr-only` / `data-footnote-backref`：remark-gfm 的脚注区；
 *   - `hljs*`：正常顺序下 rehype-highlight 排在本闸之后、轮不到这里，留着是为了万一有人
 *     把顺序排反时代码配色不会先悄悄消失（安全性无损：这些 class 只有颜色）。
 */
const CLASS_ALLOW: Array<string | RegExp> = [
  /^language-[\w#+.-]*$/,
  'math-inline',
  'math-display',
  'contains-task-list',
  'task-list-item',
  'footnotes',
  'sr-only',
  'data-footnote-backref',
  'hljs',
  /^hljs-[\w-]+$/
]

/** 可作为完整 URL 出现的安全协议（与 svgSanitize 的表同源，但那边多放 data:image 给图表用） */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** 锚点 id 的形状 —— remark-gfm 的脚注自己就带 `user-content-` 前缀，照它放行即可 */
const ANCHOR_ID = /^user-content-[\w:.-]*$/

/** 属性检查：返回 undefined = 丢掉 */
type AttrCheck = (value: unknown) => unknown

const keepString: AttrCheck = (value) => (typeof value === 'string' ? value : undefined)

/** 空格分隔的一串 —— hast 把这类属性拆成数组（实测 `ariaDescribedBy` 就是） */
const keepTokens: AttrCheck = (value) => {
  if (typeof value === 'string') return value
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined
}

/** 数值属性 —— parse5 对已知属性给 number，其余仍是字符串（实测 `li.value` 就是字符串） */
const keepNumber: AttrCheck = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return typeof value === 'string' && /^\d{1,6}$/.test(value) ? value : undefined
}

const keepFlag: AttrCheck = (value) =>
  value === true || value === '' || value === 'true' ? true : undefined

const oneOf =
  (...allowed: string[]): AttrCheck =>
  (value) =>
    typeof value === 'string' && allowed.includes(value.toLowerCase()) ? value : undefined

/**
 * URL 是否安全。先剔除控制字符与空白 —— `java\tscript:` 这类写法浏览器解析时会规整成
 * javascript:，按原样比对就会漏掉（同 svgSanitize.isSafeSvgUrl 的理由）。
 */
export function isSafeMarkdownUrl(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u0020\u007f-\u009f]/g, '').toLowerCase()
  if (v === '') return true
  if (v.startsWith('#')) return true // 页内锚点（脚注的正反跳都是它）
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(v)
  if (!scheme) return true // 无协议 = 相对 URL
  return SAFE_PROTOCOLS.has(`${scheme[1]}:`)
}

const keepUrl: AttrCheck = (value) =>
  typeof value === 'string' && isSafeMarkdownUrl(value) ? value : undefined

/** class：逐个取值过表，一个都不剩时连属性一起丢 */
const keepClasses: AttrCheck = (value) => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s+/) : []
  const kept = list.filter(
    (c): c is string =>
      typeof c === 'string' &&
      CLASS_ALLOW.some((rule) => (typeof rule === 'string' ? rule === c : rule.test(c)))
  )
  return kept.length > 0 ? kept : undefined
}

/** id：只认脚注那一族。放开任意 id 等于允许 DOM clobbering 去遮全局名字 */
const keepAnchorId: AttrCheck = (value) =>
  typeof value === 'string' && (ANCHOR_ID.test(value) || value === 'footnote-label')
    ? value
    : undefined

/** 任何允许标签上都可以有的属性 */
const GLOBAL_ATTRS: Record<string, AttrCheck> = {
  title: keepString,
  align: oneOf('left', 'right', 'center', 'justify'),
  className: keepClasses,
  id: keepAnchorId,
  // 脚注的正反跳靠这两条读屏可达；它们是惰性的，读屏之外没有别的效果
  ariaLabel: keepString,
  ariaDescribedBy: keepTokens
}

/** 按标签追加的属性（`dataFootnote*` 是 remark-gfm 的钩子，CSS 与读屏都认它） */
const TAG_ATTRS: Record<string, Record<string, AttrCheck>> = {
  a: { href: keepUrl, dataFootnoteRef: keepString, dataFootnoteBackref: keepString },
  img: { src: keepUrl, alt: keepString },
  ol: { start: keepNumber },
  li: { value: keepNumber },
  td: { colSpan: keepNumber, rowSpan: keepNumber },
  th: { colSpan: keepNumber, rowSpan: keepNumber },
  time: { dateTime: keepString },
  section: { dataFootnotes: keepString },
  details: { open: keepFlag },
  input: { type: oneOf('checkbox'), checked: keepFlag, disabled: keepFlag }
}

function filterProperties(tagName: string, properties: Record<string, unknown>): void {
  const perTag = TAG_ATTRS[tagName]
  for (const name of Object.keys(properties)) {
    const check = perTag?.[name] ?? GLOBAL_ATTRS[name]
    const kept = check ? check(properties[name]) : undefined
    if (kept === undefined) delete properties[name]
    else properties[name] = kept
  }
}

/**
 * 整棵树过闸（就地改）。三档处理见文件头注释。
 *
 * 注释与 doctype 一并丢掉：它们在页面上不显示，留着只是把旧浏览器的条件注释那类花样
 * 带进来。`raw` 节点原样留下 —— 没排 rehype-raw 时 react-markdown 会把它当文本显示。
 */
export function sanitizeHastTree(tree: HastNode): void {
  const walk = (node: HastNode): void => {
    const kids = node.children
    if (!kids) return
    const kept: HastNode[] = []
    for (const child of kids) {
      if (child.type === 'comment' || child.type === 'doctype') continue
      if (child.type !== 'element') {
        kept.push(child)
        continue
      }
      const tagName = child.tagName ?? ''
      if (STRIP_TAGS.has(tagName)) continue
      walk(child)
      // 复选框之外的 input 一律丢：type 被剥掉之后它会退回成可输入的文本框
      if (tagName === 'input' && child.properties?.type !== 'checkbox') continue
      if (!ALLOWED_TAGS.has(tagName)) {
        kept.push(...(child.children ?? []))
        continue
      }
      const properties = child.properties
      if (properties) {
        filterProperties(tagName, properties)
        // 任务列表的复选框是展示件，不是控件：管线自己也是这么发的
        if (tagName === 'input') properties.disabled = true
      }
      kept.push(child)
    }
    node.children = kept
  }

  walk(tree)
}

/** rehype 插件形态 —— 必须紧跟在 rehype-raw 之后（顺序的理由见文件头） */
export function rehypeSanitizeRawHtml() {
  return (tree: HastNode): void => {
    sanitizeHastTree(tree)
  }
}
