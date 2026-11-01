/**
 * 扣下图片（rehypeHoldImages）的判定表。跑的是**生产同款插件链** —— 直接 `use` 了
 * `utils/markdownPlugins` 导出的两张表，断言落在 hast 的 **properties** 上（理由同
 * rehypeSanitizeRawHtml.test.ts 的文件头：KaTeX 会把 TeX 源码回显进文本，按整棵树的 dump 断言会写出假红）。
 *
 * 这一步要防的是「模型写的图片地址在消息显示出来的那一刻就被请求」：每个 `img` 都换成不取图的 `held-image`，
 * 只有写明 http(s)、不带凭据的绝对 URL 才带上 `url`（URL 解析后的规范形 —— 占位上显示的主机就是点开时取的那个）。
 *
 * 五条派生链，全部从生产数组**按引用**剔除 / 替换，不另抄插件表：
 *   - `gated`   —— 生产链；
 *   - `noHold`  —— 生产链减去扣图这一步：所有「扣下了」的断言拿它做非空证（不扣时那个 img 确实带着 src）；
 *   - `ungated` —— 生产链减去闸：证明扣图这一步**自己**就够，不靠闸先把怪协议丢掉；
 *   - `rawOnly` —— 两样都减：看 rehype-raw / mdast→hast 原样产出的 img；
 *   - `trusted` —— rehype-katex 换成 `trust: true`：白盒钉「排在最后」—— 闸之后的插件造出来的 img 也逃不过。
 *
 *   HI-0  派生链确实各少了一格
 *   HI-1  远端图片（markdown / 裸 HTML / 引用式 / `<image>`）→ held-image，url 即原地址
 *   HI-2  怪写法一律规范化：url 是 URL 解析后的 href，主机就是会被取的那个
 *   HI-3  闸留着 src、扣图让它变成只是占位（相对 / 本地 / 协议相对 / 反斜杠 / mailto / 空 / 带凭据）
 *   HI-4  闸已经丢了 src 的，照样是占位
 *   HI-5  不装闸时扣图自己也只认 http(s)；手写的 `url` 属性顶不掉 src；remoteImageUrl 直接调用
 *   HI-6  alt 的取舍，其余属性一律不带过去
 *   HI-7  正文里手写的 `<held-image>` 伪造不出来
 *   HI-8  任何位置的图片都被扣下，一对一、原地替换
 *   HI-9  闸之后的插件（KaTeX `\includegraphics`，trust:true）造出的 img 也被扣下；生产的 trust:false 根本不出 img
 *   HI-10 没有图片的文档：装不装扣图，树逐节点相同
 *   HS-1  源码扫描：每一处 `<ReactMarkdown` 都用共用的插件表与组件表（否则扣图那一格在那处缺席）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import { unified, type PluggableList } from 'unified'
import { describe, it, expect } from 'vitest'
import { markdownRemarkPlugins, markdownRehypePlugins } from './markdownPlugins'
import { rehypeSanitizeRawHtml } from './rehypeSanitizeRawHtml'
import { HELD_IMAGE_TAG, rehypeHoldImages, remoteImageUrl } from './rehypeHoldImages'

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

type Render = (md: string) => HastNode

function pipeline(rehypePlugins: PluggableList): Render {
  const proc = unified()
    .use(remarkParse)
    .use(markdownRemarkPlugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypePlugins)
  return (md) => proc.runSync(proc.parse(md), md) as unknown as HastNode
}

const production: PluggableList = markdownRehypePlugins
const without = (...drop: unknown[]): PluggableList =>
  markdownRehypePlugins.filter((p) => !drop.includes(p))

/** 生产链 */
const gated = pipeline(production)
/** 生产链减去扣图 —— 按引用剔除，剔不掉就说明数组换了实现，HI-0 即红 */
const noHold = pipeline(without(rehypeHoldImages))
/** 生产链减去闸 */
const ungated = pipeline(without(rehypeSanitizeRawHtml))
/** 两样都减 */
const rawOnly = pipeline(without(rehypeHoldImages, rehypeSanitizeRawHtml))
/** rehype-katex 按引用换成 trust:true 的那一格（其余不动） */
const trustedPlugins: PluggableList = markdownRehypePlugins.map((p) =>
  p === rehypeKatex ? [rehypeKatex, { trust: true }] : p
) as PluggableList
const trusted = pipeline(trustedPlugins)
/** trusted 再减去扣图 —— HI-9 的非空证 */
const trustedNoHold = pipeline(trustedPlugins.filter((p) => p !== rehypeHoldImages))

// ─── 树上的取数工具（与 rehypeSanitizeRawHtml.test.ts 同形） ──────────

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

/** 全部指定标签的元素（按文档序） */
function findAll(md: string, tag: string, render: Render = gated): HastNode[] {
  const out: HastNode[] = []
  walk(render(md), (n) => {
    if (n.type === 'element' && n.tagName === tag) out.push(n)
  })
  return out
}

/** 头一个指定标签的元素；取不到即 undefined（断言处一律先 toBeDefined） */
function find(md: string, tag: string, render: Render = gated): HastNode | undefined {
  return findAll(md, tag, render)[0]
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

/** 全树属性的 JSON 拼接（**只有属性**，不含文本 —— 见文件头） */
function propsJson(md: string, render: Render = gated): string {
  const out: string[] = []
  walk(render(md), (n) => {
    if (n.properties) out.push(JSON.stringify(n.properties))
  })
  return out.join(' ')
}

/** 被扣下的那一张：先断言它在，再交回 properties */
function heldProps(md: string, render: Render = gated): Record<string, unknown> | undefined {
  const held = find(md, HELD_IMAGE_TAG, render)
  expect(held, `没有 held-image：${md}`).toBeDefined()
  return held?.properties
}

const rawImg = (src: string): string => `<img src="${src}" alt="a">`

// ══════════════════════════════════════════════════════
// HI-0 · 派生链确实各少了一格
// ══════════════════════════════════════════════════════

describe('HI-0 · 对照链', () => {
  it('HI-0 noHold / ungated 各比生产表少一格，rawOnly 少两格 —— 否则所有非空证都是假绿', () => {
    expect(markdownRehypePlugins).toContain(rehypeHoldImages)
    expect(markdownRehypePlugins.at(-1)).toBe(rehypeHoldImages)
    expect(without(rehypeHoldImages)).toHaveLength(markdownRehypePlugins.length - 1)
    expect(without(rehypeSanitizeRawHtml)).toHaveLength(markdownRehypePlugins.length - 1)
    expect(without(rehypeHoldImages, rehypeSanitizeRawHtml)).toHaveLength(
      markdownRehypePlugins.length - 2
    )
    // trusted 换掉的确实是 katex 那一格（换不到 = 还是 trust:false，HI-9 的 trusted 断言会是假的）
    expect(trustedPlugins).toHaveLength(markdownRehypePlugins.length)
    expect(trustedPlugins).not.toContain(rehypeKatex)
    expect(HELD_IMAGE_TAG).toBe('held-image')
  })
})

// ══════════════════════════════════════════════════════
// HI-1 · 远端图片 → held-image
// ══════════════════════════════════════════════════════

describe('HI-1 · 远端图片一律扣下，url 即原地址', () => {
  const REMOTE: Array<[string, string, string]> = [
    ['markdown https', '![a](https://a.example/x.png)', 'https://a.example/x.png'],
    ['markdown http', '![a](http://a.example/x.png)', 'http://a.example/x.png'],
    ['裸 <img>', '<img src="https://a.example/x.png" alt="a">', 'https://a.example/x.png'],
    ['引用式', '![a][r]\n\n[r]: https://a.example/x.png', 'https://a.example/x.png'],
    // parse5 把 <image> 改名成 <img>：不能因为写法不同绕过
    ['<image>', '<image src="https://a.example/x.png" alt="a">', 'https://a.example/x.png']
  ]

  it.each(REMOTE)('HI-1 %s：held-image 恰为 {alt, url}，树上没有 img', (_label, md, src) => {
    expect(heldProps(md)).toEqual({ alt: 'a', url: src })
    expect(tags(md)).not.toContain('img')
    // 非空证：不扣时那里确实是一张带着这个 src 的 img
    expect(find(md, 'img', noHold)?.properties?.src).toBe(src)
  })
})

// ══════════════════════════════════════════════════════
// HI-2 · 怪写法规范化
// ══════════════════════════════════════════════════════

describe('HI-2 · 怪写法规范化：url 是解析后的 href，主机就是会被取的那个', () => {
  /** `[说明, 裸 HTML 里 src 的写法, 规范形, 主机]` */
  const ODD: Array<[string, string, string, string]> = [
    ['前导空白', '  https://a.example/x.png', 'https://a.example/x.png', 'a.example'],
    [
      '实体 tab 拆开协议与主机',
      'ht&#9;tps://ev&#9;il.example/x',
      'https://evil.example/x',
      'evil.example'
    ],
    ['实体换行拆开主机', 'https://ev&#10;il.example/x', 'https://evil.example/x', 'evil.example'],
    ['大写协议与主机', 'HTTPS://A.EXAMPLE/X.png', 'https://a.example/X.png', 'a.example'],
    ['特殊协议省掉斜杠', 'https:evil.example/x', 'https://evil.example/x', 'evil.example'],
    ['反斜杠当斜杠', 'https:\\\\evil.example/x', 'https://evil.example/x', 'evil.example'],
    ['三条斜杠', 'https:///evil.example/x', 'https://evil.example/x', 'evil.example'],
    ['全角字母', 'https://ａ.example/x', 'https://a.example/x', 'a.example'],
    [
      'IDN',
      'https://bücher.example/x.png',
      'https://xn--bcher-kva.example/x.png',
      'xn--bcher-kva.example'
    ]
  ]

  it.each(ODD)('HI-2 %s：url 是规范形', (_label, src, expected, host) => {
    const url = heldProps(rawImg(src))?.url
    expect(url).toBe(expected)
    expect(new URL(url as string).href).toBe(url)
    expect(new URL(url as string).host).toBe(host)
    // 非空证：不扣时 img 上的 src 与规范形不同 —— 规范化确实是扣图这一步做的
    const before = find(rawImg(src), 'img', noHold)?.properties?.src
    expect(typeof before).toBe('string')
    expect(before).not.toBe(expected)
  })

  it('HI-2 端口原样带着：主机是 a.example:8443', () => {
    const url = heldProps(rawImg('https://a.example:8443/x'))?.url
    expect(url).toBe('https://a.example:8443/x')
    expect(new URL(url as string).host).toBe('a.example:8443')
  })
})

// ══════════════════════════════════════════════════════
// HI-3 · 闸留着 src，扣图让它只是占位
// ══════════════════════════════════════════════════════

describe('HI-3 · 闸留着 src 的非远端地址：只是占位，没有 url', () => {
  const INERT: Array<[string, string]> = [
    ['相对 ./', '![a](./x.png)'],
    ['相对裸名', '![a](x.png)'],
    ['本地绝对路径', '![a](/Users/x/a.png)'],
    ['尖括号里带前导空格', '![a](< https://a.example/x.png>)'],
    ['协议相对 //', '<img src="//evil.example/x" alt="a">'],
    ['反斜杠 UNC', '<img src="\\\\evil.example\\x" alt="a">'],
    ['/\\ 开头', '<img src="/\\evil.example/x" alt="a">'],
    ['mailto', '<img src="mailto:a@b.c" alt="a">'],
    ['只有协议', '<img src="https://" alt="a">'],
    ['空 src', '<img src="" alt="a">'],
    ['用户名冒充主机', '![a](https://good.example@evil.example/x)'],
    ['用户名 + 密码', '![a](https://u:p@a.example/x)']
  ]

  it.each(INERT)('HI-3 %s：held-image 恰为 {alt}', (label, md) => {
    expect(heldProps(md)).toEqual({ alt: 'a' })
    expect(tags(md)).not.toContain('img')
    // 非空证：闸确实留着 src（不扣时 img 上有它）—— 让它不出网的是扣图这一步
    const src = find(md, 'img', noHold)?.properties?.src
    expect(typeof src, label).toBe('string')
    if (label !== '空 src') expect((src as string).length, label).toBeGreaterThan(0)
  })
})

// ══════════════════════════════════════════════════════
// HI-4 · 闸已经丢了 src
// ══════════════════════════════════════════════════════

describe('HI-4 · 闸已丢掉 src 的：照样是只有 alt 的占位', () => {
  const STRIPPED: Array<[string, string, string | undefined]> = [
    ['data: markdown', '![a](data:image/png;base64,AAAA)', 'data:image/png;base64,AAAA'],
    [
      'data:svg 裸 HTML',
      '<img src="data:image/svg+xml,<svg/>" alt="a">',
      'data:image/svg+xml,<svg/>'
    ],
    ['file:', '![a](file:///etc/passwd)', 'file:///etc/passwd'],
    ['没有 src', '<img alt="a">', undefined]
  ]

  it.each(STRIPPED)('HI-4 %s：held-image 恰为 {alt}', (_label, md, src) => {
    expect(heldProps(md)).toEqual({ alt: 'a' })
    expect(tags(md)).not.toContain('img')
    // 非空证：闸和扣图都不装时 img 上就是原样的那个 src（没有 src 那行就是没有）
    const img = find(md, 'img', rawOnly)
    expect(img).toBeDefined()
    expect(img?.properties?.src).toBe(src)
  })
})

// ══════════════════════════════════════════════════════
// HI-5 · 扣图自己就够
// ══════════════════════════════════════════════════════

describe('HI-5 · 不装闸，扣图自己也只认 http(s)', () => {
  const ODD_SCHEMES = [
    'ws://evil.example/x',
    'ftp://evil.example/x',
    'blob:https://evil.example/u',
    'file://server/share/x.png',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)'
  ]

  it.each(ODD_SCHEMES)('HI-5 %s：held-image 恰为 {alt}', (src) => {
    expect(heldProps(rawImg(src), ungated)).toEqual({ alt: 'a' })
    expect(tags(rawImg(src), ungated)).not.toContain('img')
    // 非空证：没有闸时 src 原样到了 img 上 —— 这一格不是闸替扣图挡下的
    expect(find(rawImg(src), 'img', rawOnly)?.properties?.src).toBe(src)
  })

  it('HI-5 手写的 url 属性顶不掉 src：url 是 src 的规范形', () => {
    const md = '<img src="https://a.example/x" url="https://evil.example/y" alt="a">'
    expect(heldProps(md, ungated)).toEqual({ alt: 'a', url: 'https://a.example/x' })
    // 非空证：没有闸时那个 url 属性确实到了 img 上
    const img = find(md, 'img', rawOnly)
    expect(img?.properties?.src).toBe('https://a.example/x')
    expect(img?.properties?.url).toBe('https://evil.example/y')
  })

  it.each([
    ['undefined', undefined],
    ['数字', 1],
    ['数组', ['https://a.example/']],
    ['用户名冒充主机', 'https://good.example@evil.example/x'],
    ['用户名 + 密码', 'https://u:p@a.example/x']
  ])('HI-5 remoteImageUrl(%s) → undefined', (_label, value) => {
    expect(remoteImageUrl(value)).toBeUndefined()
  })

  it('HI-5 remoteImageUrl 认得的规范地址原样交回', () => {
    expect(remoteImageUrl('https://a.example/x')).toBe('https://a.example/x')
  })
})

// ══════════════════════════════════════════════════════
// HI-6 · alt 与其余属性
// ══════════════════════════════════════════════════════

describe('HI-6 · alt 的取舍，其余属性一律不带过去', () => {
  const URL_ = 'https://a.example/x.png'

  it.each([
    ['markdown 空 alt', `![](${URL_})`],
    ['alt=""', `<img src="${URL_}" alt="">`],
    ['裸 alt', `<img src="${URL_}" alt>`]
  ])('HI-6 %s：恰为 {url}，没有 alt 键', (_label, md) => {
    const props = heldProps(md)
    expect(props).toEqual({ url: URL_ })
    expect(Object.keys(props ?? {})).not.toContain('alt')
  })

  it('HI-6 alt 里的强调取纯文本', () => {
    expect(heldProps(`![*em* t](${URL_})`)).toEqual({ alt: 'em t', url: URL_ })
  })

  it('HI-6 闸留下的 title / align / class / id / aria-label 都不带到 held-image 上', () => {
    const md =
      '<img src="https://a.example/x" alt="a" title="t" align="left" class="language-x" id="user-content-x" aria-label="l" width="1">'
    expect(heldProps(md)).toEqual({ alt: 'a', url: 'https://a.example/x' })
    // 非空证：不扣时这几样确实活过了闸
    const img = find(md, 'img', noHold)
    expect(img?.properties).toMatchObject({
      title: 't',
      align: 'left',
      className: ['language-x'],
      id: 'user-content-x',
      ariaLabel: 'l'
    })
  })
})

// ══════════════════════════════════════════════════════
// HI-7 · 手写的 held-image
// ══════════════════════════════════════════════════════

describe('HI-7 · 正文里手写的 <held-image> 伪造不出来', () => {
  const FORGED: Array<[string, string]> = [
    ['小写', '<held-image url="https://evil.example/x" alt="a"></held-image>'],
    ['大写', '<HELD-IMAGE URL="https://evil.example/x">t</HELD-IMAGE>'],
    [
      '包在链接里',
      '<a href="https://l.example/"><held-image url="https://evil.example/x">t</held-image></a>'
    ]
  ]

  it.each(FORGED)('HI-7 %s：树上没有 held-image，属性里没有 evil.example', (_label, md) => {
    expect(tags(md)).not.toContain(HELD_IMAGE_TAG)
    expect(propsJson(md)).not.toContain('evil.example')
    // 非空证：不装闸时这个手写标签确实带着 url 活到了表尾（扣图只换 img，不碰它）
    expect(find(md, HELD_IMAGE_TAG, ungated)?.properties?.url).toBe('https://evil.example/x')
  })

  it('HI-7 与真图片同一份文档：恰好一个 held-image，url 是真的那张', () => {
    const md = `![real](https://good.example/r.png)\n\n${FORGED[0][1]}`
    const held = findAll(md, HELD_IMAGE_TAG)
    expect(held).toHaveLength(1)
    expect(held[0].properties).toEqual({ alt: 'real', url: 'https://good.example/r.png' })
    expect(propsJson(md)).not.toContain('evil.example')
    // 非空证：不装闸时是两个
    expect(findAll(md, HELD_IMAGE_TAG, ungated)).toHaveLength(2)
  })
})

// ══════════════════════════════════════════════════════
// HI-8 · 任何位置
// ══════════════════════════════════════════════════════

describe('HI-8 · 任何位置的图片都被扣下，一对一、原地替换', () => {
  const IMG = '![a](https://i.example/x.png)'
  /** `[说明, 文档, 图片张数]` */
  const CONTEXTS: Array<[string, string, number]> = [
    ['链接里', `[${IMG}](https://l.example/)`, 1],
    ['表格单元格', `| h |\n| - |\n| ${IMG} |`, 1],
    ['脚注定义', `t[^1]\n\n[^1]: ${IMG}`, 1],
    ['标题', `# ${IMG}`, 1],
    ['列表项', `- ${IMG}`, 1],
    ['引用块', `> ${IMG}`, 1],
    [
      '<picture>',
      '<picture><source srcset="https://e.example/s"><img src="https://e.example/i" alt=a></picture>',
      1
    ],
    [
      '<details>',
      '<details><summary>s</summary><img src="https://e.example/d" alt="a"></details>',
      1
    ],
    ['同一段两张', `${IMG} ![b](https://i.example/y.png)`, 2]
  ]

  it.each(CONTEXTS)('HI-8 %s：元素序列与不扣时相同，只是 img → held-image', (_label, md, count) => {
    expect(tags(md)).toEqual(tags(md, noHold).map((t) => (t === 'img' ? HELD_IMAGE_TAG : t)))
    expect(tags(md)).not.toContain('img')
    expect(findAll(md, HELD_IMAGE_TAG)).toHaveLength(count)
    // 非空证：不扣时 img 确实是这么多张
    expect(count).toBeGreaterThan(0)
    expect(findAll(md, 'img', noHold)).toHaveLength(count)
  })

  it('HI-8 链接里：held-image 是 a 的直接子元素，a 的 href 不动', () => {
    const md = CONTEXTS[0][1]
    const a = find(md, 'a')
    expect(a).toBeDefined()
    expect(childTag(a, HELD_IMAGE_TAG)).toBeDefined()
    expect(childTag(a, HELD_IMAGE_TAG)?.properties).toEqual({
      alt: 'a',
      url: 'https://i.example/x.png'
    })
    expect(a?.properties?.href).toBe('https://l.example/')
    // 非空证：不扣时 a 的直接子元素是那张 img
    expect(childTag(find(md, 'a', noHold), 'img')).toBeDefined()
  })
})

// ══════════════════════════════════════════════════════
// HI-9 · 排在最后（白盒）
// ══════════════════════════════════════════════════════

describe('HI-9 · 闸之后的插件造出来的 img 也逃不过', () => {
  const md = '$\\includegraphics[height=1em]{https://k.example/x.png}$'

  it('HI-9 trust:true 的 KaTeX 吐出的 img 被扣下', () => {
    expect(tags(md, trusted)).not.toContain('img')
    expect(find(md, HELD_IMAGE_TAG, trusted)?.properties?.url).toBe('https://k.example/x.png')
    // 非空证：同一条链不扣时，KaTeX 真的造了一张带 src 的 img（它在闸之后，闸看不见）
    expect(find(md, 'img', trustedNoHold)?.properties?.src).toBe('https://k.example/x.png')
  })

  it('HI-9 生产（trust:false）：没有 img、没有 held-image，属性里没有 k.example', () => {
    expect(tags(md)).not.toContain('img')
    expect(tags(md)).not.toContain(HELD_IMAGE_TAG)
    expect(propsJson(md)).not.toContain('k.example')
  })
})

// ══════════════════════════════════════════════════════
// HI-10 · 没有图片的文档不受影响
// ══════════════════════════════════════════════════════

describe('HI-10 · 没有图片：装不装扣图，树逐节点相同', () => {
  const CORPUS = [
    '```js\nconst a = 1\n```',
    '行内代码 `/Users/x/a.ts` 与 $x^2$。',
    '$$\ny = 1\n$$',
    '| h | i |\n| - | - |\n| 1 | 2 |',
    '- [ ] todo\n- [x] done',
    '脚注[^n]\n\n[^n]: 脚注正文',
    '自动链接 https://auto.example/p 与 [link](https://x.example)',
    '~~删除~~',
    '<b>粗</b>',
    '<details><summary>s</summary>body</details>',
    '密钥 {{REDACTED_API_KEY_k3v7x2mq}} 在这里'
  ].join('\n\n')

  it('HI-10 gated(md) 与 noHold(md) 逐节点相同', () => {
    expect(gated(CORPUS)).toEqual(noHold(CORPUS))
  })

  it('HI-10 非空证：语料确实走到了链接 / 表格 / 复选框 / 高亮 / 公式 / 脱敏标记 / 脚注区', () => {
    const t = tags(CORPUS)
    for (const tag of ['a', 'table', 'input', 'redaction-mark']) expect(t, tag).toContain(tag)
    expect(findWhere(CORPUS, (n) => n.tagName === 'code' && hasClass(n, 'hljs'))).toBeDefined()
    expect(findWhere(CORPUS, (n) => n.tagName === 'span' && hasClass(n, 'katex'))).toBeDefined()
    expect(
      findWhere(CORPUS, (n) => n.tagName === 'section' && n.properties?.dataFootnotes !== undefined)
    ).toBeDefined()
    expect(t).not.toContain('img')
    expect(t).not.toContain(HELD_IMAGE_TAG)
  })
})

// ══════════════════════════════════════════════════════
// HS-1 · 每一处 ReactMarkdown 都用共用的表
// ══════════════════════════════════════════════════════

describe('HS-1 · 对话流的每一处 markdown 都走共用的插件表与组件表', () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__tests__') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
      else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(path)
    }
    return out
  }

  it('HS-1 import 了 react-markdown 的 .tsx 里，每个 <ReactMarkdown 开标签都传 markdownRehypePlugins 与 markdownComponents', () => {
    const roots = ['packages/chat-ui/src', 'packages/app-shell/src', 'apps/desktop/src/renderer']
    const files = roots
      .flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)))
      .filter((path) => /from\s+['"]react-markdown['"]/.test(readFileSync(path, 'utf8')))
    const names = files.map((path) => relative(REPO_ROOT, path))
    // 非空证：扫描确实找到了已知的那几处
    for (const known of [
      'packages/chat-ui/src/components/chat/markdownComponents.tsx',
      'packages/chat-ui/src/components/chat/CompactionNoticeRow.tsx',
      'packages/chat-ui/src/components/chat/InstructionNoticeRow.tsx',
      'packages/app-shell/src/subagent/SubAgentStream.tsx'
    ]) {
      expect(names).toContain(known)
    }

    const offenders: string[] = []
    let openings = 0
    for (const path of files) {
      const source = readFileSync(path, 'utf8')
      // 开标签：从 `<ReactMarkdown` 到第一个不在 {…} 里的 `>`
      for (const match of source.matchAll(/<ReactMarkdown\b/g)) {
        let depth = 0
        let end = match.index + match[0].length
        for (; end < source.length; end++) {
          const ch = source[end]
          if (ch === '{') depth++
          else if (ch === '}') depth--
          else if (ch === '>' && depth === 0) break
        }
        const tag = source.slice(match.index, end + 1)
        openings++
        if (
          !/rehypePlugins=\{markdownRehypePlugins\}/.test(tag) ||
          !/components=\{markdownComponents\}/.test(tag)
        ) {
          offenders.push(`${relative(REPO_ROOT, path)}: ${tag}`)
        }
      }
    }
    expect(openings).toBeGreaterThanOrEqual(4)
    expect(offenders).toEqual([])
  })
})
