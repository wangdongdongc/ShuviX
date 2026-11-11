/**
 * 文件库链接（rehypeLibraryLinks）的判定表（测试设计 docs/file-library-l1-tests.md §11.1，RLIB-*）。
 * 跑的是**生产同款插件链**，断言落在 hast 上（同 rehypeSessionLinks.test.ts）。
 *
 * 要防的两头：该认的没认（笔记、对话里的 `![](shuvix://file/<id>/…)` 变回破图或点不动的字），
 * 不该认的认了（形状不严的地址过了闸、手写的 `<library-image>` 伪造出一张本机图片）。
 * 另外一条：`shuvix://file/…` 这段地址一个都不能留到属性里 —— 组件只按 id 经 mediaUrl seam 取图。
 *
 *   RLIB-0 顺序与对照：闸之后、扣图之前；减去这一格时 href / src 还在
 *   RLIB-1 图片：markdown、空 alt、大写 id、裸 HTML、引用式
 *   RLIB-2 链接：markdown、裸 HTML、引用式、尖括号
 *   RLIB-3 长得像的不认
 *   RLIB-4 地址一个都留不到属性里
 *   RLIB-5 伪造不出来
 *   RLIB-6 代码与裸地址（裸地址不认是现状，见测试设计 Q3）
 *   RLIB-7 嵌套与差分
 */
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified, type PluggableList } from 'unified'
import { describe, expect, it } from 'vitest'
import { markdownRehypePlugins, markdownRemarkPlugins } from './markdownPlugins'
import { rehypeSanitizeRawHtml } from './rehypeSanitizeRawHtml'
import { HELD_IMAGE_TAG, rehypeHoldImages } from './rehypeHoldImages'
import { LIBRARY_IMAGE_TAG, LIBRARY_LINK_TAG, rehypeLibraryLinks } from './rehypeLibraryLinks'

const ID = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const ID2 = '0199d3a2-0000-7000-8000-000000000000'
const ID_UP = ID.toUpperCase()

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

const gated = pipeline(markdownRehypePlugins)
/** 生产链减去这一格 —— 按引用剔除，剔不掉 RLIB-0 即红 */
const noLib = pipeline(markdownRehypePlugins.filter((p) => p !== rehypeLibraryLinks))
/** 再减去扣图那一格：看闸给 img 留下的 src（不然 img 先被换成不带地址的 held-image） */
const gateOnly = pipeline(
  markdownRehypePlugins.filter((p) => p !== rehypeLibraryLinks && p !== rehypeHoldImages)
)

function walk(node: HastNode, visit: (n: HastNode, parents: HastNode[]) => void): void {
  const go = (n: HastNode, parents: HastNode[]): void => {
    visit(n, parents)
    n.children?.forEach((c) => go(c, [...parents, n]))
  }
  go(node, [])
}

function elements(md: string, tag: string, render: Render = gated): HastNode[] {
  const out: HastNode[] = []
  walk(render(md), (n) => {
    if (n.type === 'element' && n.tagName === tag) out.push(n)
  })
  return out
}

const libraryElements = (md: string, render: Render = gated): HastNode[] => {
  const out: HastNode[] = []
  walk(render(md), (n) => {
    if (n.type === 'element' && n.tagName?.startsWith('library-')) out.push(n)
  })
  return out
}

function text(node: HastNode): string {
  let out = ''
  walk(node, (n) => {
    if (n.type === 'text') out += n.value ?? ''
  })
  return out
}

/** 全树属性的 JSON 拼接（只有属性，不含文字） */
function propsJson(md: string, render: Render = gated): string {
  const out: string[] = []
  walk(render(md), (n) => {
    if (n.properties) out.push(JSON.stringify(n.properties))
  })
  return out.join(' ')
}

const hrefs = (md: string, render: Render): unknown[] =>
  elements(md, 'a', render).map((a) => a.properties?.href)
const srcs = (md: string, render: Render): unknown[] =>
  elements(md, 'img', render).map((img) => img.properties?.src)

describe('RLIB-0 · 顺序与对照', () => {
  it('RLIB-0 排在闸之后、扣下图片之前', () => {
    const at = (p: unknown): number => markdownRehypePlugins.indexOf(p as never)
    expect(at(rehypeLibraryLinks)).toBeGreaterThan(-1)
    expect(at(rehypeLibraryLinks)).toBeGreaterThan(at(rehypeSanitizeRawHtml))
    expect(at(rehypeLibraryLinks)).toBeLessThan(at(rehypeHoldImages))
  })

  it('RLIB-0 减去这一格时，闸放过的 href / src 还在；生产链里一个都不剩', () => {
    const link = `[r](shuvix://file/${ID}/r.pdf)`
    const image = `![c](shuvix://file/${ID}/c.png)`

    expect(hrefs(link, noLib)).toEqual([`shuvix://file/${ID}/r.pdf`])
    expect(srcs(image, gateOnly)).toEqual([`shuvix://file/${ID}/c.png`])
    expect(libraryElements(`${link} ${image}`, noLib)).toEqual([])

    expect(hrefs(link, gated)).toEqual([])
    expect(srcs(image, gated)).toEqual([])
    expect(libraryElements(`${link} ${image}`, gated).map((n) => n.tagName)).toEqual([
      LIBRARY_LINK_TAG,
      LIBRARY_IMAGE_TAG
    ])
  })

  it('RLIB-0 两个元素名', () => {
    expect(LIBRARY_IMAGE_TAG).toBe('library-image')
    expect(LIBRARY_LINK_TAG).toBe('library-link')
  })
})

describe('RLIB-1 · 图片', () => {
  const only = (md: string): HastNode => {
    const all = libraryElements(md)
    expect(all).toHaveLength(1)
    expect(all[0].tagName).toBe(LIBRARY_IMAGE_TAG)
    expect(elements(md, HELD_IMAGE_TAG)).toEqual([])
    expect(elements(md, 'img')).toEqual([])
    return all[0]
  }

  it('RLIB-1 `![Chart](…)`：恰一个 library-image，只带 item 与 alt；没有 held-image，也没有 img', () => {
    const el = only(`![Chart](shuvix://file/${ID}/c.png)`)
    expect(el.properties).toEqual({ item: ID, alt: 'Chart' })
    expect(el.children).toEqual([])
  })

  it('RLIB-1 空 alt：属性里没有 alt 键', () => {
    const el = only(`![](shuvix://file/${ID}/c.png)`)
    expect(el.properties).toEqual({ item: ID })
    expect(el.properties).not.toHaveProperty('alt')
  })

  it('RLIB-1 大写 id 统一成小写', () => {
    expect(only(`![x](shuvix://file/${ID_UP}/c.png)`).properties).toEqual({ item: ID, alt: 'x' })
  })

  it('RLIB-1 裸 HTML：事件、class、宽度一概不带过去', () => {
    const el = only(
      `<img src="shuvix://file/${ID}/c.png" alt="x" onerror="alert(1)" class="fixed" width="9">`
    )
    expect(el.properties).toEqual({ item: ID, alt: 'x' })
  })

  it('RLIB-1 引用式图片同样处理', () => {
    const el = only(`![Ref][c]\n\n[c]: shuvix://file/${ID}/c.png`)
    expect(el.properties).toEqual({ item: ID, alt: 'Ref' })
  })
})

describe('RLIB-2 · 链接', () => {
  it.each([
    ['markdown 链接', `[Report](shuvix://file/${ID}/r.pdf)`, 'Report'],
    [
      '裸 HTML',
      `x <a href="shuvix://file/${ID}/r.pdf" title="hover" target="_blank">Report</a> y`,
      'Report'
    ],
    ['引用式', `[Report][r]\n\n[r]: shuvix://file/${ID}/r.pdf`, 'Report'],
    ['尖括号', `<shuvix://file/${ID}/r.pdf>`, `shuvix://file/${ID}/r.pdf`]
  ])('RLIB-2 %s → library-link，只带 item', (_label, md, label) => {
    const all = libraryElements(md)
    expect(all).toHaveLength(1)
    const [link] = all
    expect(link.tagName).toBe(LIBRARY_LINK_TAG)
    expect(link.properties).toEqual({ item: ID })
    expect(text(link)).toBe(label)
    expect(elements(md, 'a')).toEqual([])
  })
})

describe('RLIB-3 · 长得像的不认', () => {
  it.each([
    `![](shuvix://file/${ID}?x=1)`,
    `![](shuvix://file/${ID}/a/b.png)`,
    '![](shuvix://file/not-an-id)',
    `![](shuvix://files/${ID})`
  ])('RLIB-3 图片 %s：不出库元素，变成不带地址的 held-image', (md) => {
    expect(libraryElements(md)).toEqual([])
    const held = elements(md, HELD_IMAGE_TAG)
    expect(held).toHaveLength(1)
    expect(held[0].properties).not.toHaveProperty('url')
    expect(elements(md, 'img')).toEqual([])
  })

  it('RLIB-3 链接 `[t](shuvix://file/ID#x)`：不出库元素，a 没有 href', () => {
    const md = `[t](shuvix://file/${ID}#x)`
    expect(libraryElements(md)).toEqual([])
    const as = elements(md, 'a')
    expect(as).toHaveLength(1)
    expect(as[0].properties?.href).toBeUndefined()
  })
})

describe('RLIB-4 · 地址留不到属性里', () => {
  const CORPUS = [
    `![Chart](shuvix://file/${ID}/c.png)`,
    `![](shuvix://file/${ID})`,
    `![x](shuvix://file/${ID_UP}/c.png)`,
    `<img src="shuvix://file/${ID}/c.png" alt="x" onerror="x">`,
    `![Ref][c]`,
    `[Report](shuvix://file/${ID}/r.pdf)`,
    `<a href="shuvix://file/${ID}/r.pdf" title="t">Report</a>`,
    `[Report][r]`,
    `<shuvix://file/${ID}/r.pdf>`,
    `<SHUVIX://FILE/${ID_UP}/r.pdf>`,
    `![](shuvix://file/${ID}?x=1)`,
    `![](shuvix://file/${ID}/a/b.png)`,
    '![](shuvix://file/not-an-id)',
    `![](shuvix://files/${ID})`,
    `[t](shuvix://file/${ID}#x)`,
    `<video src="shuvix://file/${ID}/v.mp4"></video>`,
    `<img srcset="shuvix://file/${ID}/c.png 2x">`,
    `[![](shuvix://file/${ID}/a.png)](shuvix://file/${ID2}/b.pdf)`,
    `[c]: shuvix://file/${ID}/c.png`,
    `[r]: shuvix://file/${ID}/r.pdf`
  ].join('\n\n')

  it('RLIB-4 所有节点属性的 JSON 里都没有 shuvix://file（不分大小写）', () => {
    const json = propsJson(CORPUS)
    expect(json).not.toMatch(/shuvix:\/\/file/i)
    // 非空证：语料里确实认出了库元素
    expect(libraryElements(CORPUS).length).toBeGreaterThanOrEqual(8)
    // 对照：减去这一格时地址还在属性里
    expect(propsJson(CORPUS, noLib)).toMatch(/shuvix:\/\/file/i)
  })
})

describe('RLIB-5 · 伪造不出来', () => {
  it.each([
    [`<library-image item="${ID}"></library-image> kept`, 'kept'],
    [`<library-image item="${ID}" alt="a"> kept`, 'kept'],
    [`<library-link item="${ID}">forged</library-link>`, 'forged'],
    [`<LIBRARY-LINK item="${ID}">forged</LIBRARY-LINK>`, 'forged'],
    [`<span data-library-image="${ID}">kept</span>`, 'kept'],
    [`<span data-library-link="${ID}">kept</span>`, 'kept']
  ])('RLIB-5 %s：没有库元素，文字保留', (md, kept) => {
    expect(libraryElements(md)).toEqual([])
    expect(text(gated(md))).toContain(kept)
    expect(propsJson(md)).not.toContain(ID)
  })
})

describe('RLIB-6 · 代码与裸地址', () => {
  it.each([
    ['行内代码', '`shuvix://file/' + ID + '/a.png`', `shuvix://file/${ID}/a.png`],
    ['围栏', '```md\n![](shuvix://file/' + ID + '/a.png)\n```', `![](shuvix://file/${ID}/a.png)`],
    ['缩进代码块', `    ![](shuvix://file/${ID}/a.png)`, `![](shuvix://file/${ID}/a.png)`]
  ])('RLIB-6 %s：代码文字原样，没有库元素', (_label, md, code) => {
    expect(libraryElements(md)).toEqual([])
    const codes = elements(md, 'code')
    expect(codes).toHaveLength(1)
    expect(text(codes[0])).toContain(code)
  })

  it('RLIB-6 段落里的裸地址保持纯文本（现状，见测试设计 Q3）', () => {
    const md = `see shuvix://file/${ID}/a.png here`
    expect(libraryElements(md)).toEqual([])
    expect(elements(md, 'a')).toEqual([])
    expect(text(gated(md))).toBe(md)
  })
})

describe('RLIB-7 · 嵌套与差分', () => {
  it('RLIB-7 外链里的库图片：a[href=https…] 下挂 library-image', () => {
    const tree = gated(`[![](shuvix://file/${ID}/a.png)](https://e.example)`)
    const hits: Array<{ node: HastNode; parents: HastNode[] }> = []
    walk(tree, (n, parents) => {
      if (n.tagName === LIBRARY_IMAGE_TAG) hits.push({ node: n, parents })
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].node.properties).toEqual({ item: ID })
    const parent = hits[0].parents[hits[0].parents.length - 1]
    expect(parent.tagName).toBe('a')
    expect(parent.properties?.href).toBe('https://e.example')
  })

  it('RLIB-7 库链接里的库图片：library-link(B) 下挂 library-image(A)', () => {
    const tree = gated(`[![](shuvix://file/${ID}/a.png)](shuvix://file/${ID2}/b.pdf)`)
    const hits: Array<{ node: HastNode; parents: HastNode[] }> = []
    walk(tree, (n, parents) => {
      if (n.tagName === LIBRARY_IMAGE_TAG) hits.push({ node: n, parents })
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].node.properties).toEqual({ item: ID })
    const parent = hits[0].parents[hits[0].parents.length - 1]
    expect(parent.tagName).toBe(LIBRARY_LINK_TAG)
    expect(parent.properties).toEqual({ item: ID2 })
    expect(
      libraryElements(`[![](shuvix://file/${ID}/a.png)](shuvix://file/${ID2}/b.pdf)`)
    ).toHaveLength(2)
  })

  it('RLIB-7 不含库链接的文档：装不装这一格，树逐节点相同', () => {
    const CORPUS = [
      '# h',
      'para [ext](https://x.dev/a) `code` `/tmp/a.txt` shuvix://settings',
      '| a |\n|---|\n| 1 |',
      '```js\nconst a = 1\n```',
      '$x^2$',
      '![i](https://h.example/p.png)',
      '{{EMAIL_abcdefgh}}',
      '<details><summary>s</summary>body</details>',
      '[s](shuvix://session/abc)'
    ].join('\n\n')
    expect(gated(CORPUS)).toEqual(noLib(CORPUS))
  })
})
