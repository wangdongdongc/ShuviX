/**
 * 裸 HTML 白名单闸的判定表。跑的是**生产同款插件链** —— 直接 `use` 了
 * `utils/markdownPlugins` 导出的两张表（`markdownRemarkPlugins` /
 * `markdownRehypePlugins`），断言落在 hast 上。
 *
 * 为什么必须吃生产那两个数组、而不是在这里重列一遍插件：**顺序就是这道闸的安全边界**
 * （rehype-raw 在闸前、rehype-highlight / rehype-katex 在闸后，理由见
 * rehypeSanitizeRawHtml.ts 与 markdownPlugins.ts 的文件头）。手抄一份插件表的用例只能
 * 证明「这个函数会删 script」，证不了「线上那条链会删」—— 而顺序排反正是这道闸最容易
 * 悄悄失效的方式。数组本身被搬进 utils/ 就是为了让 `environment: 'node'` 的单测吃得到它。
 *
 * 三条派生链，三种用途：
 *   - `gated`   —— 生产链，绝大多数断言跑它；
 *   - `ungated` —— 生产链**减去闸**（按引用剔除，不是另抄一份）。两个用途：差分组拿它当
 *                  对照证明「闸对纯 markdown 零影响」，以及给「闸删掉了东西」的断言做
 *                  **非空证**（没有它，`<noscript>` 里本来就没有 img 也会绿）；
 *   - `bare`    —— 一个 rehype 插件都不装，用来钉 mdast-util-to-hast 自己的行为（G 组）。
 *
 * 属性断言一律看 **properties**，不看整棵树的 JSON：KaTeX 会把 TeX 源码原样回显进
 * `<annotation>` 的**文本**里，`$\href{javascript:...}$` 的树 dump 必然含 "javascript"，
 * 按 dump 断言会写出假红（而真正要防的是它变成属性）。
 */
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { describe, it, expect } from 'vitest'
import { markdownRemarkPlugins, markdownRehypePlugins } from './markdownPlugins'
import { rehypeSanitizeRawHtml, isSafeMarkdownUrl, sanitizeHastTree } from './rehypeSanitizeRawHtml'

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

type RehypePlugins = typeof markdownRehypePlugins
type Render = (md: string) => HastNode

function pipeline(rehypePlugins: RehypePlugins): Render {
  const proc = unified()
    .use(remarkParse)
    .use(markdownRemarkPlugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypePlugins)
  return (md) => proc.runSync(proc.parse(md), md) as unknown as HastNode
}

/** 生产链（闸在位） */
const gated = pipeline(markdownRehypePlugins)
/** 生产链**减去闸** —— 按引用剔除，剔不掉就说明数组换了实现，用例即红 */
const ungated = pipeline(markdownRehypePlugins.filter((p) => p !== rehypeSanitizeRawHtml))
/** 不装任何 rehype 插件 —— 只看 mdast→hast 这一步的产物 */
const bare = pipeline([])

// ─── 树上的取数工具 ────────────────────────────────────

function walk(node: HastNode, visit: (n: HastNode) => void): void {
  visit(node)
  node.children?.forEach((c) => walk(c, visit))
}

/** 全树元素名（按文档序） */
function tags(md: string, render: Render = gated): string[] {
  const out: string[] = []
  walk(render(md), (n) => {
    if (n.type === 'element' && n.tagName) out.push(n.tagName)
  })
  return out
}

/** 头一个指定标签的元素；取不到即 undefined（断言处一律先 toBeDefined） */
function find(md: string, tag: string, render: Render = gated): HastNode | undefined {
  let hit: HastNode | undefined
  walk(render(md), (n) => {
    if (!hit && n.type === 'element' && n.tagName === tag) hit = n
  })
  return hit
}

/** 头一个满足条件的元素 */
function findWhere(
  md: string,
  pred: (n: HastNode) => boolean,
  render: Render = gated
): HastNode | undefined {
  let hit: HastNode | undefined
  walk(render(md), (n) => {
    if (!hit && n.type === 'element' && pred(n)) hit = n
  })
  return hit
}

/** 元素的直接子元素里头一个叫 tag 的 —— 用来断言父子链而不只是「都在树上」 */
function childTag(node: HastNode | undefined, tag: string): HastNode | undefined {
  return (node?.children ?? []).find((c) => c.type === 'element' && c.tagName === tag)
}

const hasClass = (node: HastNode | undefined, cls: string): boolean => {
  const value = node?.properties?.className
  return Array.isArray(value) && value.includes(cls)
}

/** 全树文本拼接 —— 「连内容一起删」这一档只有它证得了 */
function text(md: string, render: Render = gated): string {
  let out = ''
  walk(render(md), (n) => {
    if (n.type === 'text') out += n.value ?? ''
  })
  return out
}

/** 全树属性名（去重）—— `on*` 那条断言的判据 */
function propKeys(md: string, render: Render = gated): string[] {
  const out = new Set<string>()
  walk(render(md), (n) => Object.keys(n.properties ?? {}).forEach((k) => out.add(k)))
  return [...out]
}

/** 全树属性的 JSON 拼接（**只有属性**，不含文本 —— 见文件头） */
function propsJson(md: string, render: Render = gated): string {
  const out: string[] = []
  walk(render(md), (n) => {
    if (n.properties) out.push(JSON.stringify(n.properties))
  })
  return out.join(' ')
}

/** needle 在 haystack 里出现几次 —— 「拆壳不能把文字复制一份」的判据 */
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1

// ══════════════════════════════════════════════════════
// 0 · 被测的确实是生产那条链
// ══════════════════════════════════════════════════════

describe('0 · 管线本身', () => {
  it('闸在生产 rehype 表里，且对照组确实少了它 —— 否则差分组全是假绿', () => {
    expect(markdownRehypePlugins).toContain(rehypeSanitizeRawHtml)
    expect(markdownRehypePlugins.filter((p) => p !== rehypeSanitizeRawHtml)).toHaveLength(
      markdownRehypePlugins.length - 1
    )
  })

  /**
   * 顺序就是这道闸的安全边界：把不可信文本变成标记的插件（rehype-raw）必须在闸**前**，
   * 产出可信标记的插件（rehype-highlight 的 hljs class、rehype-katex 的 MathML）必须在
   * 闸**后**。B 组与「裸写 pre/code」那条是它的行为证明，这里按**引用**再钉一次索引 ——
   * 有人重排插件表时，红在这一条上比红在一堆形状断言里好读。
   */
  it('闸紧跟在 rehype-raw 之后，且排在 highlight / katex 之前', () => {
    expect(markdownRehypePlugins.indexOf(rehypeSanitizeRawHtml)).toBe(1)
    expect(markdownRehypePlugins).toHaveLength(4)
  })
})

// ══════════════════════════════════════════════════════
// A · 第一档：连内容一起删
// ══════════════════════════════════════════════════════

describe('A · 连内容一起删 —— 能执行 / 能拉远端 / 能改全局样式的那一类', () => {
  /**
   * `[标签, INNER 的去向]`。第二列不是可有可无的注脚 —— 不分清楚就会写出假绿：
   *   - `inside`   真子节点，闸删壳时连它一起带走（这一档与「拆壳」的分界正在这里）；
   *   - `sibling`  `link` / `meta` / `base` / `embed` 是 HTML 的**空元素**，解析器压根不
   *                把 `INNER` 放进去，那段文字成了兄弟节点。对它们断言「内容也没了」
   *                是在断言解析器；这里反过来断言文字**必须留着**，顺带钉住闸没有误伤邻居；
   *   - `fragment` `<template>` 的内容被 hast-util-raw 挂在 `content` 上而不是 `children`，
   *                所以装不装闸，树上的文本里都找不到它。
   */
  const STRIPPED: Array<[string, 'inside' | 'sibling' | 'fragment']> = [
    ['script', 'inside'],
    ['style', 'inside'],
    ['iframe', 'inside'],
    ['object', 'inside'],
    ['embed', 'sibling'],
    ['link', 'sibling'],
    ['meta', 'sibling'],
    ['base', 'sibling'],
    ['form', 'inside'],
    ['svg', 'inside'],
    ['math', 'inside'],
    ['template', 'fragment'],
    ['noscript', 'inside']
  ]

  const fixture = (tag: string): string => `A<${tag}>INNER</${tag}>B`

  it.each(STRIPPED)('<%s> 整个元素不留在树上', (tag) => {
    expect(tags(fixture(tag))).not.toContain(tag)
  })

  it.each(STRIPPED.filter(([, fate]) => fate === 'inside'))(
    '<%s> 的内部文字一并消失 —— 这一档与「拆壳」的分界就在这里',
    (tag) => {
      expect(text(fixture(tag))).not.toContain('INNER')
      // 非空证：不装闸时这段文字确实在树上，否则上面那条是在断言解析器
      expect(text(fixture(tag), ungated)).toContain('INNER')
    }
  )

  it.each(STRIPPED.filter(([, fate]) => fate === 'sibling'))(
    '<%s> 是空元素 —— 元素没了，但相邻正文一个字都不能少',
    (tag) => {
      expect(text(fixture(tag))).toContain('INNER')
      expect(text(fixture(tag))).toBe(text(fixture(tag), ungated))
    }
  )

  it('<template> 的内容不在 children 上（挂在 content），装不装闸都不出现在文本里', () => {
    expect(text(fixture('template'))).not.toContain('INNER')
    expect(text(fixture('template'), ungated)).not.toContain('INNER')
  })

  it('<svg> 连里面的 <circle> 一起走 —— 删的是整棵子树而不是脚本那一个节点', () => {
    const md = '<svg><script>window.__pwn = 1</script><circle r="9"></circle></svg>'
    expect(tags(md)).not.toContain('svg')
    expect(tags(md)).not.toContain('script')
    expect(tags(md)).not.toContain('circle')
    expect(tags(md, ungated)).toContain('circle')
  })

  it('活下来的 <details> 里嵌的 <style> 照删 —— 闸是递归的，不只看顶层', () => {
    const md = '<details><summary>S</summary><style>i{color:red}</style>BODY</details>'
    expect(tags(md)).toContain('details')
    expect(tags(md)).toContain('summary')
    expect(tags(md)).not.toContain('style')
    expect(text(md)).toContain('BODY')
    expect(text(md)).not.toContain('color:red')
  })

  it('<noscript> 里的 <img onerror> 跟着一起走', () => {
    const md = '<noscript><img src=x onerror="window.__pwn = 1"></noscript>'
    expect(tags(md)).not.toContain('noscript')
    expect(tags(md)).not.toContain('img')
    // 非空证：脚本未禁用时 parse5 把 noscript 的内容解析成**真元素**（不是一团文本），
    // 所以那个 img 确实是闸删掉的
    expect(tags(md, ungated)).toContain('img')
  })

  it('大写的 <SCRIPT> / <IFRAME> 同样删 —— 判定认的是规范化后的标签名', () => {
    const md = '<SCRIPT>alert(1)</SCRIPT><IFRAME src="https://evil"></IFRAME>'
    expect(tags(md)).toEqual([])
    expect(text(md)).not.toContain('alert')
  })

  it('解析器混淆写法 <scr<script>ipt> 也留不下可执行节点', () => {
    const md = '<scr<script>ipt>alert(1)</scr</script>ipt>'
    expect(tags(md)).not.toContain('script')
    expect(text(md)).not.toContain('alert')
  })

  it('<iframe srcdoc> 整条走 —— 任何属性值里都不该再出现 "<script"', () => {
    const md = '<iframe srcdoc="<script>parent.__pwn = 1</script>"></iframe>'
    expect(tags(md)).not.toContain('iframe')
    expect(propsJson(md)).not.toContain('<script')
    expect(text(md)).not.toContain('__pwn')
  })
})

// ══════════════════════════════════════════════════════
// B · <math> / <svg> 这一对：顺序不变式
// ══════════════════════════════════════════════════════

describe('B · math/svg 这一对 —— 裸的删掉，KaTeX 自己吐的留下', () => {
  /**
   * 这两条是**顺序不变式**的体现：`math` / `svg` 都在 STRIP 表里，而 rehype-katex 排在
   * 闸**之后**，所以它产出的 MathML 与根号符号根本轮不到闸看见。
   * 两种想当然的实现各错一半 —— 把 math 从 STRIP 表里拿掉，上半句红；把闸挪到 katex
   * 之后，下半句红。只断言其中一半的用例两种写法都放得过去。
   */
  it('裸 <math> 没了，而 $x^2$ 的 span.katex > span.katex-mathml > math[xmlns] 完好', () => {
    const md = '<math><mtext>RAW</mtext></math> 与 $x^2$'
    expect(text(md)).not.toContain('RAW')
    expect(tags(md)).not.toContain('mtext')

    const katex = findWhere(md, (n) => n.tagName === 'span' && hasClass(n, 'katex'))
    const mathml = childTag(katex, 'span')
    expect(hasClass(mathml, 'katex-mathml')).toBe(true)
    const math = childTag(mathml, 'math')
    expect(math?.properties?.xmlns).toBe('http://www.w3.org/1998/Math/MathML')
  })

  it('裸 <svg> 没了，而 $\\sqrt{x}$ 的 svg + path[d] 完好', () => {
    const md = '<svg><circle r="9"></circle></svg> 与 $\\sqrt{x}$'
    expect(tags(md)).not.toContain('circle')
    expect(tags(md)).toContain('svg')
    const path = find(md, 'path')
    expect(typeof path?.properties?.d).toBe('string')
    expect(String(path?.properties?.d).length).toBeGreaterThan(20)
  })
})

// ══════════════════════════════════════════════════════
// C · 第二档：只拆外壳，文字留下
// ══════════════════════════════════════════════════════

describe('C · 只拆外壳 —— 表外标签退成文字', () => {
  const UNWRAPPED: Array<[string, string, string]> = [
    ['center', '<center>KEEPME</center>', 'center'],
    ['font', '<font color="red">KEEPME</font>', 'font'],
    ['自定义元素', '<my-widget>KEEPME</my-widget>', 'my-widget'],
    ['marquee', '<marquee>KEEPME</marquee>', 'marquee']
  ]

  it.each(UNWRAPPED)('%s —— 壳没了', (_label, md, tag) => {
    expect(tags(md)).not.toContain(tag)
  })

  it.each(UNWRAPPED)('%s —— 文字还在，且只出现一次', (_label, md) => {
    expect(occurrences(text(md), 'KEEPME')).toBe(1)
  })

  it('嵌套的表外标签逐层拆到底', () => {
    // 剩下的 `p` 是 remark 给行内 HTML 加的段落壳，不是 `<foo>` 留下的
    const md = '<foo><bar><baz>DEEP</baz></bar></foo>'
    expect(tags(md)).toEqual(['p'])
    expect(occurrences(text(md), 'DEEP')).toBe(1)
  })

  /**
   * 遍历顺序的钉子：拆壳必须发生在**递归之后**。反过来写（先把子节点抬上来再走），
   * `<script>` 会在拆壳那一步被原样抬进父节点、再也没人看它一眼。
   */
  it('拆壳发生在递归之后 —— 壳里的 <script> 不会被顺手抬上来', () => {
    const md = '<center onclick="window.__pwn = 1()"><script>alert(1)</script>KEEP</center>'
    expect(occurrences(text(md), 'KEEP')).toBe(1)
    expect(tags(md)).not.toContain('script')
    expect(text(md)).not.toContain('alert')
    expect(propKeys(md)).toEqual([])
  })
})

// ══════════════════════════════════════════════════════
// D · 第三档：属性白名单
// ══════════════════════════════════════════════════════

describe('D · 属性白名单 —— 活下来的标签上还要再过一遍', () => {
  /**
   * 判据是「**没有任何属性名以 on 开头**」而不是「没有 onerror」：hast 会把 `onerror`
   * 规范成驼峰的 `onError`（G 组钉了这条），所以字面量 `'onerror'` 的断言天然为真 ——
   * 闸整个删掉也一样绿。写成正则是这条断言唯一不假绿的形态。
   */
  it('任何事件处理器属性都活不下来', () => {
    const md =
      '<div onclick="a()" onerror="b()" ONMOUSEOVER="c()" onfocus="d()">H</div>' +
      '<img src="https://x.com/i.png" onerror="window.__pwn = 1" alt="A">' +
      '<details ontoggle="e()"><summary>S</summary>B</details>'
    expect(propKeys(md).filter((k) => /^on/i.test(k))).toEqual([])
    // 非空证：不装闸时它们确实在（且确实是驼峰形态）
    expect(propKeys(md, ungated)).toContain('onError')
  })

  it('style 一律丢 —— 一个 position:fixed 就是整屏遮罩', () => {
    const md = '<div style="position:fixed;inset:0;z-index:9999">S</div>'
    expect(find(md, 'div')?.properties).toEqual({})
    expect(propsJson(md)).not.toContain('position:fixed')
  })

  it('裸标记上的 class 一律丢 —— tailwind 原子类与 style 是同一块遮罩', () => {
    const md = '<div class="fixed inset-0 z-50 bg-black">S</div>'
    expect(find(md, 'div')?.properties).toEqual({})
    expect(propsJson(md)).not.toContain('inset-0')
  })

  it('任意 id 与 data-* 丢 —— 放开 id 等于允许 DOM clobbering 去遮全局名字', () => {
    const md = '<div id="api" data-y="1" data-footnotes="">D</div>'
    expect(find(md, 'div')?.properties).toEqual({})
  })

  /**
   * 按标签分表的钉子。`colSpan` 只在表格单元格上有意义，别的标签上留着毫无理由。
   * 注意 `align` 是**全局**放行的（GLOBAL_ATTRS，实现里是明写的选择），所以它在 `<b>`
   * 上也活着 —— 这条按现状钉住：哪天把 align 收进 TAG_ATTRS，这里会红。
   */
  it('colSpan 只在表格单元格上放行', () => {
    expect(find('<b colspan="2" align="center">B</b>', 'b')?.properties).toEqual({
      align: 'center'
    })
    expect(
      find('<table><tr><td colspan="2" align="center">T</td></tr></table>', 'td')?.properties
    ).toEqual({ colSpan: 2, align: 'center' })
  })

  const BLOCKED_URLS: Array<[string, string]> = [
    ['javascript:', 'javascript:alert(1)'],
    ['内嵌 tab 的 javascript:', 'java&#9;script:alert(1)'],
    ['vbscript:', 'vbscript:alert(1)'],
    ['data:text/html', 'data:text/html,<h1>x</h1>']
  ]

  it.each(BLOCKED_URLS)('href 协议白名单：%s 连属性一起丢', (_label, href) => {
    const a = find(`<a href="${href}">X</a>`, 'a')
    expect(a).toBeDefined()
    expect(a?.properties).toEqual({})
  })

  it.each(BLOCKED_URLS)('src 协议白名单：%s 连属性一起丢', (_label, src) => {
    const img = find(`<img src="${src}" alt="A">`, 'img')
    expect(img?.properties).toEqual({ alt: 'A' })
  })

  const KEPT_URLS: Array<[string, string]> = [
    ['https:', 'https://example.com/p'],
    ['mailto:', 'mailto:a@b.c'],
    ['页内锚点', '#frag']
  ]

  it.each(KEPT_URLS)('%s 照常放行', (_label, href) => {
    expect(find(`<a href="${href}">X</a>`, 'a')?.properties).toEqual({ href })
  })

  /**
   * react-markdown 自带的 `urlTransform` 只看 href/src。这一排属性它一条都不管，
   * 而它们各自都能拉远端或改变点击去向 —— 「React 会处理掉」不是防御。
   */
  const UNCOVERED_ATTRS = ['srcset', 'ping', 'target', 'download', 'rel', 'referrerpolicy']

  it.each(UNCOVERED_ATTRS)('urlTransform 管不到的 %s 丢在这里', (attr) => {
    const md = `<a href="https://example.com" ${attr}="https://evil.example/x">L</a>`
    expect(find(md, 'a')?.properties).toEqual({ href: 'https://example.com' })
  })

  it('img 上的 srcset / crossorigin 同样丢', () => {
    const md =
      '<img src="https://x.com/i.png" srcset="https://evil/x 2x" crossorigin="use-credentials" alt="A">'
    expect(find(md, 'img')?.properties).toEqual({ src: 'https://x.com/i.png', alt: 'A' })
  })

  /**
   * 值的**类型**要原样活下来：把 `checked` 变成字符串 `''`、把 `start` 变成 `'5'`，
   * React 那边的行为就变了（前者仍为真，后者仍能用，红不出来但已经不是同一棵树）。
   */
  it('属性值的类型不被改写：布尔仍是布尔，数字仍是数字', () => {
    const input = find('<input type="checkbox" checked disabled>', 'input')
    expect(input?.properties?.checked).toBe(true)
    expect(input?.properties?.disabled).toBe(true)
    expect(find('<ol start="5"><li>x</li></ol>', 'ol')?.properties?.start).toBe(5)
    expect(find('<details open><summary>S</summary>B</details>', 'details')?.properties).toEqual({
      open: true
    })
  })

  it('复选框之外的 input 整个丢 —— type 被剥掉之后它会退回成可输入的文本框', () => {
    expect(tags('<input type="text" value="x">')).not.toContain('input')
    expect(tags('<input type="password">')).not.toContain('input')
    // 留下来的那个一定是禁用的：任务列表的复选框是展示件，不是控件
    expect(find('<input type="checkbox">', 'input')?.properties).toEqual({
      type: 'checkbox',
      disabled: true
    })
  })
})

// ══════════════════════════════════════════════════════
// E · 不许回退：闸对纯 markdown 必须零影响
// ══════════════════════════════════════════════════════

describe('E · 差分 —— 不含裸 HTML 的正文，装闸与不装闸必须产出同一棵树', () => {
  /**
   * 这是本文件的头条。前面每一条都在说「什么被删了」，删过头的代价却只有这一组看得见：
   * 语料全是**纯 markdown**（一处裸 HTML 都没有），闸本该一个节点都不碰。
   * 对照组是生产表**减去闸**，所以表里任何一个插件换了、顺序动了，两边同时变，
   * 差分仍只检验闸自己。
   */
  const CORPUS: Array<[string, string]> = [
    ['GFM 表格（三种对齐）', '| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |'],
    ['任务列表', '- [x] done\n- [ ] todo'],
    ['嵌套列表', '- a\n  - b\n    - c'],
    ['从 5 起的有序列表', '5. five\n6. six'],
    ['脚注', 'Foot[^1]\n\n[^1]: note'],
    ['围栏代码（js）', '```js\nconst a = 1\n```'],
    ['围栏代码（未知语言）', '```wat\n(module)\n```'],
    ['围栏代码（无语言）', '```\nplain text\n```'],
    ['行内公式', 'a $x^2$ b'],
    ['块级公式', '$$\ny = mx + b\n$$'],
    ['根号', 'a $\\sqrt{x}$ b'],
    ['自动链接', 'see https://example.com/p now'],
    ['图片', '![alt](https://example.com/i.png)'],
    ['块引用', '> quoted **text**\n>\n> second'],
    ['各级标题', '# h1\n\n## h2\n\n### h3'],
    ['分隔线', 'a\n\n---\n\nb'],
    ['强调 / 加粗 / 删除线', '*em* **strong** ~~del~~'],
    ['行内代码', 'call `fn(1)` now'],
    ['路径形状的行内代码', 'see `src/main/index.ts` now'],
    [
      '一篇混排长文',
      [
        '# 标题',
        '正文里有 *强调*、**加粗**、`code`，以及 https://example.com/auto 自动链接。',
        '> 引用里也有 [链接](https://example.com/p "标题") 和图片 ![i](https://example.com/i.png)',
        '| 名目 | 值 |\n|:--|--:|\n| 一 | 1 |',
        '1. 一\n2. 二\n   - 子项\n   - [x] 勾选',
        '```ts\nexport const a: number = 1\n```',
        '行内 $E = mc^2$ 与块级：',
        '$$\n\\sqrt{a^2 + b^2}\n$$',
        '脚注在这里[^n]',
        '---',
        '[^n]: 脚注正文'
      ].join('\n\n')
    ]
  ]

  it.each(CORPUS)('%s —— 与不装闸的树深度相等', (_label, md) => {
    expect(gated(md)).toEqual(ungated(md))
  })

  // 差分红了只会说「两棵树不一样」。下面这些把它拆成能一眼定位的形状。

  it('表格对齐留在 align 上', () => {
    const md = '| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |'
    expect(tags(md)).toEqual(expect.arrayContaining(['table', 'thead', 'tbody', 'tr', 'th', 'td']))
    expect(find(md, 'th')?.properties).toEqual({ align: 'left' })
    expect(find(md, 'td')?.properties).toEqual({ align: 'left' })
  })

  it('任务列表的 class 与那个禁用复选框都在', () => {
    const md = '- [x] done\n- [ ] todo'
    expect(find(md, 'ul')?.properties).toEqual({ className: ['contains-task-list'] })
    expect(find(md, 'li')?.properties).toEqual({ className: ['task-list-item'] })
    expect(find(md, 'input')?.properties).toEqual({
      type: 'checkbox',
      checked: true,
      disabled: true
    })
  })

  it('代码高亮的 class 与内层 hljs span 都在', () => {
    const md = '```js\nconst a = 1\n```'
    const code = childTag(find(md, 'pre'), 'code')
    expect(code?.properties?.className).toEqual(['hljs', 'language-js'])
    expect(hasClass(childTag(code, 'span'), 'hljs-keyword')).toBe(true)
  })

  it('脚注整套形状（正跳 / 区块 / 标题 / 条目 / 反跳）都在', () => {
    const md = 'Foot[^1]\n\n[^1]: note'
    expect(childTag(find(md, 'sup'), 'a')?.properties).toEqual({
      href: '#user-content-fn-1',
      id: 'user-content-fnref-1',
      dataFootnoteRef: '',
      ariaDescribedBy: ['footnote-label']
    })
    expect(find(md, 'section')?.properties).toEqual({
      dataFootnotes: '',
      className: ['footnotes']
    })
    expect(find(md, 'h2')?.properties).toEqual({
      className: ['sr-only'],
      id: 'footnote-label'
    })
    expect(find(md, 'li')?.properties).toEqual({ id: 'user-content-fn-1' })
    const backref = findWhere(md, (n) => hasClass(n, 'data-footnote-backref'))
    expect(backref?.tagName).toBe('a')
    expect(backref?.properties?.href).toBe('#user-content-fnref-1')
    expect(backref?.properties?.dataFootnoteBackref).toBe('')
    expect(backref?.properties?.ariaLabel).toBe('Back to reference 1')
  })

  it('有序列表的 start 留着（且仍是数字）', () => {
    expect(find('5. five\n6. six', 'ol')?.properties).toEqual({ start: 5 })
  })

  it('KaTeX 的行内与块级形状都在', () => {
    expect(hasClass(find('a $x^2$ b', 'span'), 'katex')).toBe(true)
    const display = find('$$\ny = 1\n$$', 'span')
    expect(hasClass(display, 'katex-display')).toBe(true)
    expect(find('$$\ny = 1\n$$', 'math')?.properties?.display).toBe('block')
  })

  it('图片的 src / alt 都在', () => {
    expect(find('![alt](https://example.com/i.png)', 'img')?.properties).toEqual({
      src: 'https://example.com/i.png',
      alt: 'alt'
    })
  })

  it('自动链接的子文本仍等于 URL —— LinkChip 按这条分支', () => {
    const a = find('see https://example.com/p now', 'a')
    expect(a?.properties).toEqual({ href: 'https://example.com/p' })
    expect(a?.children?.[0]?.value).toBe('https://example.com/p')
  })

  it('裸写的 <pre><code class="language-js"> 保住 pre > code 这条链', () => {
    // markdownComponents 把 `pre` 映射成 CodeBlock，链断了就换成另一种渲染
    const md = '<pre><code class="language-js">const a = 1</code></pre>'
    const code = childTag(find(md, 'pre'), 'code')
    expect(code).toBeDefined()
    expect(code?.properties?.className).toEqual(['hljs', 'language-js'])
  })
})

// ══════════════════════════════════════════════════════
// F · 排版留得下
// ══════════════════════════════════════════════════════

describe('F · 排版标签与安全链接照常活着', () => {
  const SURVIVORS =
    '<p>p</p><br><details><summary>s</summary>d</details>' +
    '<sub>sub</sub><sup>sup</sup><kbd>K</kbd>' +
    '<b>b</b><i>i</i><strong>st</strong><em>em</em><del>del</del>' +
    '<blockquote>q</blockquote><ul><li>u</li></ul><ol><li>o</li></ol>' +
    '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>d</td></tr></tbody></table>' +
    '<a href="https://example.com">a</a><img src="https://example.com/i.png" alt="i">'

  it.each([
    'p',
    'br',
    'details',
    'summary',
    'sub',
    'sup',
    'kbd',
    'b',
    'i',
    'strong',
    'em',
    'del',
    'blockquote',
    'ul',
    'ol',
    'li',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'a',
    'img'
  ])('<%s> 活着', (tag) => {
    expect(tags(SURVIVORS)).toContain(tag)
  })

  it('<details> 里的空行 markdown 仍被解析（strong 还在）', () => {
    const md = '<details><summary>more</summary>\n\nhidden **body**\n\n</details>'
    expect(childTag(find(md, 'details'), 'summary')).toBeDefined()
    expect(tags(md)).toContain('strong')
    expect(text(md)).toContain('body')
  })

  it('裸表格里 parse5 补出来的 tbody 链完整', () => {
    const md = '<table><tr><td colspan="2">m</td></tr></table>'
    const tbody = childTag(find(md, 'table'), 'tbody')
    const tr = childTag(tbody, 'tr')
    expect(childTag(tr, 'td')?.properties).toEqual({ colSpan: 2 })
  })
})

// ══════════════════════════════════════════════════════
// G · 上游规则回归（不装闸 / 裸链）
// ══════════════════════════════════════════════════════

describe('G · 上游回归 —— 闸赖以成立的那几条前提', () => {
  it('mdast-util-to-hast 把表格对齐发成 align，而不是 style="text-align:…"', () => {
    // 若上游改成 style，闸会把它当裸标记的 style 一起丢掉 —— 红在这里比红在差分里好定位
    const md = '| a |\n|:-:|\n| 1 |'
    expect(find(md, 'th', bare)?.properties).toEqual({ align: 'center' })
    expect(propsJson(md, bare)).not.toContain('text-align')
  })

  it('hast 的属性名是驼峰 —— onerror → onError、data-y → dataY', () => {
    // D 组那条 `/^on/i` 正则断言的前提；按字面量 'onerror' 写会永远为真
    const props = find('<div onerror="x" data-y="1">D</div>', 'div', ungated)?.properties
    expect(props).toEqual({ onError: 'x', dataY: '1' })
  })

  /**
   * KaTeX 的 `trust: false` 仍然成立。这条钉的是**闸故意不看的那个洞**：rehype-katex
   * 排在闸之后，它吐出来的东西没有任何人再过一遍 —— 于是「KaTeX 自己不生成链接、
   * 不生成任意 style/class」是这条管线的前提，而不是推论。
   *
   * 断言只落在 properties 上：`\href{javascript:…}` 的 TeX 源码会被 KaTeX 原样回显进
   * `<annotation>` 的文本节点，按整棵树的 dump 断言必然假红。
   */
  it('KaTeX 的 trust 仍关着：\\href 不生成 <a>，也不生成 javascript: 属性', () => {
    const md = '$\\href{javascript:alert(1)}{x}$'
    expect(tags(md, ungated)).not.toContain('a')
    expect(propsJson(md, ungated)).not.toContain('javascript')
  })

  it('KaTeX 的 \\htmlStyle / \\htmlClass 不落成属性', () => {
    expect(propsJson('$\\htmlStyle{position:fixed}{x}$', ungated)).not.toContain('position:fixed')
    expect(propsJson('$\\htmlClass{fixed inset-0}{x}$', ungated)).not.toContain('inset-0')
  })
})

// ══════════════════════════════════════════════════════
// H · 直接调用两个导出件
// ══════════════════════════════════════════════════════

describe('H · isSafeMarkdownUrl / sanitizeHastTree 直接调用', () => {
  it.each([
    ['https', 'https://example.com', true],
    ['http', 'http://example.com', true],
    ['mailto', 'mailto:a@b.c', true],
    ['相对路径', 'docs/a.md', true],
    ['页内锚点', '#frag', true],
    ['空串', '', true],
    ['javascript', 'javascript:alert(1)', false],
    ['大写 JavaScript', 'JavaScript:alert(1)', false],
    ['带空白的 javascript', ' java\tscript:alert(1)', false],
    ['vbscript', 'vbscript:msgbox(1)', false],
    ['data:text/html', 'data:text/html,<h1>x</h1>', false],
    ['data:image', 'data:image/png;base64,AAAA', false],
    ['file', 'file:///etc/passwd', false]
  ])('%s → %s', (_label, url, safe) => {
    expect(isSafeMarkdownUrl(url)).toBe(safe)
  })

  it('sanitizeHastTree 就地改树，并丢掉注释与 doctype', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'doctype' },
        { type: 'comment', value: '[if IE]><script>x</script><![endif]' },
        {
          type: 'element',
          tagName: 'div',
          properties: { onClick: 'x', className: ['fixed'] },
          children: [{ type: 'text', value: 'T' }]
        }
      ]
    }
    sanitizeHastTree(tree)
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]?.properties).toEqual({})
  })
})
