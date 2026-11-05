/**
 * 会话链接（rehypeSessionLinks）的判定表。跑的是**生产同款插件链**，断言落在 hast 上（同 rehypeHoldImages.test.ts）。
 *
 * 要防的两头：该认的没认（模型写的 `[标题](shuvix://session/<id>)` 又变回一段点不动的文字），
 * 不该认的认了（代码块里引用的地址、外链里的文字变成按钮；形状不严的地址过了闸）。
 *
 *   RL-0  对照链：减去这一格时 a 还带着 href；这一格排在闸之后
 *   RL-1  写法：`[t](…)`、`<…>`、引用式、裸 HTML、带 title；entry 只在有消息 id 时才有
 *   RL-2  正文里的裸地址：各种块里都认，句尾标点留在外面，一段里可以有两个
 *   RL-3  长得像但不是的：文字原样
 *   RL-4  行内代码：整段就是地址才认，代码块 / 外链 / 围栏里的不认
 *   RL-5  过了闸的 href 一个都到不了终点（裸 HTML 写在 code / pre 里也一样）
 *   RL-6  公式里的不认
 *   RL-7  手写的 `<session-link>` 伪造不出来
 *   RL-8  链接文字压成纯文本：里面没有 img / held-image / 别的 chip
 *   RL-9  没有会话地址的文档：装不装这一格，树逐节点相同
 *   RL-10 地址后面紧跟着还像地址的部分就不算；根上的文字也切
 */
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified, type PluggableList } from 'unified'
import { describe, expect, it } from 'vitest'
import { markdownRehypePlugins, markdownRemarkPlugins } from './markdownPlugins'
import { rehypeSanitizeRawHtml } from './rehypeSanitizeRawHtml'
import { SESSION_LINK_TAG, rehypeSessionLinks } from './rehypeSessionLinks'

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
/** 生产链减去这一格 —— 按引用剔除，剔不掉 RL-0 即红 */
const noLinks = pipeline(markdownRehypePlugins.filter((p) => p !== rehypeSessionLinks))

function walk(node: HastNode, visit: (n: HastNode, parents: HastNode[]) => void): void {
  const go = (n: HastNode, parents: HastNode[]): void => {
    visit(n, parents)
    n.children?.forEach((c) => go(c, [...parents, n]))
  }
  go(node, [])
}

function links(md: string, render: Render = gated): HastNode[] {
  const out: HastNode[] = []
  walk(render(md), (n) => {
    if (n.tagName === SESSION_LINK_TAG) out.push(n)
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

const props = (md: string): Array<Record<string, unknown> | undefined> =>
  links(md).map((l) => l.properties)

describe('RL-0 · 对照链', () => {
  it('RL-0 减去这一格时 a 还带着 href；装上就没有', () => {
    const hrefs = (render: Render): unknown[] => {
      const out: unknown[] = []
      walk(render('[t](shuvix://session/abc)'), (n) => {
        if (n.tagName === 'a') out.push(n.properties?.href)
      })
      return out
    }
    expect(hrefs(noLinks)).toEqual(['shuvix://session/abc'])
    expect(hrefs(gated)).toEqual([])
    expect(links('[t](shuvix://session/abc)', noLinks)).toEqual([])
  })

  it('RL-0 排在闸之后（闸之前的话手写标签就能伪造）', () => {
    expect(markdownRehypePlugins.indexOf(rehypeSessionLinks)).toBeGreaterThan(
      markdownRehypePlugins.indexOf(rehypeSanitizeRawHtml)
    )
    expect(SESSION_LINK_TAG).toBe('session-link')
  })
})

describe('RL-1 · 写法', () => {
  it.each([
    ['markdown 链接', '[t](shuvix://session/abc)', 't'],
    ['带 title', '[t](shuvix://session/abc "hover")', 't'],
    ['引用式', '[t][r]\n\n[r]: shuvix://session/abc', 't'],
    ['裸 HTML', 'x <a href="shuvix://session/abc">t</a> y', 't'],
    ['尖括号', '<shuvix://session/abc>', 'shuvix://session/abc']
  ])('RL-1 %s', (_label, md, label) => {
    const [link, ...rest] = links(md)
    expect(rest).toEqual([])
    expect(link.properties).toEqual({ session: 'abc' })
    expect(text(link)).toBe(label)
  })

  it('RL-1 带消息 id 才有 entry', () => {
    expect(props('[t](shuvix://session/abc#e-1)')).toEqual([{ session: 'abc', entry: 'e-1' }])
    expect(props('[t](shuvix://session/abc)')).toEqual([{ session: 'abc' }])
  })

  it('RL-1 空文字的链接也是链接（标题由组件取）', () => {
    const [link] = links('[](shuvix://session/abc)')
    expect(link.properties).toEqual({ session: 'abc' })
    expect(link.children).toEqual([])
  })
})

describe('RL-2 · 正文里的裸地址', () => {
  it.each([
    ['段落', 'see shuvix://session/abc here'],
    ['列表', '- see shuvix://session/abc here'],
    ['表格', '| h |\n|---|\n| shuvix://session/abc |'],
    ['详情', '<details><summary>shuvix://session/abc</summary>x</details>']
  ])('RL-2 %s', (_label, md) => {
    expect(props(md)).toEqual([{ session: 'abc' }])
  })

  it('RL-2 句尾标点留在外面，文字位置不变', () => {
    const p = gated('see shuvix://session/abc. next').children?.[0]
    expect(p?.children?.map((c) => c.value ?? c.tagName)).toEqual([
      'see ',
      SESSION_LINK_TAG,
      '. next'
    ])
    expect(props('see shuvix://session/abc#e1. next')).toEqual([{ session: 'abc', entry: 'e1' }])
    expect(props('see shuvix://session/abc#e1: next')).toEqual([{ session: 'abc', entry: 'e1' }])
    expect(props('did you see shuvix://session/abc? yes')).toEqual([{ session: 'abc' }])
    expect(props('见 shuvix://session/abc。下一句')).toEqual([{ session: 'abc' }])
    expect(props('shuvix://session/abc/ next')).toEqual([{ session: 'abc' }])
  })

  it('RL-2 一段里两个地址：两个元素，中间的文字在原位', () => {
    const p = gated('a shuvix://session/one b shuvix://session/two c').children?.[0]
    expect(p?.children?.map((c) => c.value ?? c.properties?.session)).toEqual([
      'a ',
      'one',
      ' b ',
      'two',
      ' c'
    ])
  })
})

describe('RL-3 · 长得像但不是', () => {
  it.each([
    'xshuvix://session/abc',
    'shuvix://session/abc/extra',
    'SHUVIX://session/abc',
    'shuvix://SESSION/abc',
    'shuvix://knowledge/abc',
    'shuvix://session/'
  ])('RL-3 %s 文字原样', (md) => {
    expect(links(md)).toEqual([])
    expect(text(gated(md))).toContain(md)
  })

  it('RL-3 外链路径里的地址：还是那一个外链', () => {
    const md = 'https://x.dev/shuvix://session/abc'
    expect(links(md)).toEqual([])
    const hrefs: unknown[] = []
    walk(gated(md), (n) => {
      if (n.tagName === 'a') hrefs.push(n.properties?.href)
    })
    expect(hrefs).toEqual([md])
  })
})

describe('RL-4 · 行内代码', () => {
  it('RL-4 手写的 `<code>` 与行内代码同形，同样认', () => {
    expect(props('x <code>shuvix://session/abc</code> y')).toEqual([{ session: 'abc' }])
  })

  it('RL-4 整段就是地址才认，并替换掉 code', () => {
    const tree = gated('see `shuvix://session/abc#e1` here')
    const tags: string[] = []
    walk(tree, (n) => {
      if (n.tagName) tags.push(n.tagName)
    })
    expect(tags).not.toContain('code')
    expect(props('see `shuvix://session/abc#e1` here')).toEqual([{ session: 'abc', entry: 'e1' }])
    expect(links('`see shuvix://session/abc`')).toEqual([])
  })

  it.each([
    ['没写语言的围栏', '```\nshuvix://session/abc\n```'],
    ['写了语言的围栏', '```js\nconst a = "shuvix://session/abc"\n```'],
    ['text 围栏', '```text\nshuvix://session/abc\n```'],
    ['缩进代码块', '    shuvix://session/abc'],
    ['外链文字里的裸地址', '[shuvix://session/abc](https://x.dev/)'],
    ['外链文字里的行内代码', '[`shuvix://session/abc`](https://x.dev/)'],
    ['手写在 pre 里', '<pre>shuvix://session/abc</pre>'],
    ['外链套粗体再套地址', '[**shuvix://session/abc**](https://x.dev/)']
  ])('RL-4 %s：不是 chip', (_label, md) => {
    expect(links(md)).toEqual([])
    expect(text(gated(md))).toContain('shuvix://session/abc')
  })
})

describe('RL-5 · 过了闸的 href 到不了终点', () => {
  it.each([
    '[t](shuvix://session/abc)',
    '<code><a href="shuvix://session/abc">t</a></code>',
    '<pre><a href="shuvix://session/abc">t</a></pre>',
    '<details><summary><a href="shuvix://session/abc">t</a></summary></details>',
    '<table><tr><td><a href="shuvix://session/abc">t</a></td></tr></table>',
    '<a href="https://x.dev/"><b><a href="shuvix://session/abc">t</a></b></a>'
  ])('RL-5 %s', (md) => {
    const leftover: unknown[] = []
    walk(gated(md), (n) => {
      if (n.tagName === 'a' && String(n.properties?.href ?? '').startsWith('shuvix:')) {
        leftover.push(n.properties?.href)
      }
    })
    expect(leftover).toEqual([])
    expect(links(md)).toHaveLength(1)
  })
})

describe('RL-6 · 公式', () => {
  it.each(['$\\text{shuvix://session/abc}$', '$$\n\\text{shuvix://session/abc}\n$$'])(
    'RL-6 %s 不出 chip',
    (md) => {
      expect(links(md)).toEqual([])
      const katex: HastNode[] = []
      walk(gated(md), (n) => {
        const cls = n.properties?.className
        if (Array.isArray(cls) && cls.includes('katex')) katex.push(n)
      })
      expect(katex.length).toBeGreaterThan(0) // 非空证：公式确实排出来了
    }
  )
})

describe('RL-7 · 伪造', () => {
  it.each([
    '<session-link session="v" entry="e">forged</session-link>',
    '<SESSION-LINK session="v">forged</SESSION-LINK>',
    '<details><summary>x</summary><session-link session="v">forged</session-link></details>',
    '<table><tr><td><session-link session="v">forged</session-link></td></tr></table>'
  ])('RL-7 %s 拆成文字', (md) => {
    expect(links(md)).toEqual([])
    expect(text(gated(md))).toContain('forged')
  })
})

describe('RL-8 · 链接文字压成纯文本', () => {
  it.each([
    ['图片', '[x ![a](https://h.example/p.png)](shuvix://session/b)', 'x '],
    ['只有图片', '[![a](https://h.example/p.png)](shuvix://session/b)', ''],
    ['裸 img', '<a href="shuvix://session/b">x <img src="https://h.example/p.png"></a>', 'x '],
    ['行内代码地址', '[see `shuvix://session/a`](shuvix://session/b)', 'see shuvix://session/a'],
    ['路径', '[`/a/b.txt`](shuvix://session/b)', '/a/b.txt'],
    ['粗体', '[**bold** tail](shuvix://session/b)', 'bold tail'],
    ['脱敏占位符', '[{{EMAIL_abcdefgh}}](shuvix://session/b)', '{{EMAIL_abcdefgh}}']
  ])('RL-8 %s', (_label, md, label) => {
    const all = links(md)
    expect(all.map((l) => l.properties?.session)).toEqual(['b'])
    const [link] = all
    expect(text(link)).toBe(label)
    expect((link.children ?? []).every((c) => c.type === 'text')).toBe(true)
  })

  it('RL-8 外面的图片不受影响：照样扣下', () => {
    const tags: string[] = []
    walk(gated('[t](shuvix://session/b) ![a](https://h.example/p.png)'), (n) => {
      if (n.tagName) tags.push(n.tagName)
    })
    expect(tags).toContain('held-image')
    expect(tags).not.toContain('img')
  })
})

describe('RL-9 · 没有会话地址的文档', () => {
  const CORPUS = [
    '# h',
    'para [ext](https://x.dev/a) `code` `/tmp/a.txt` shuvix://settings',
    '| a |\n|---|\n| 1 |',
    '```js\nconst a = 1\n```',
    '$x^2$',
    '![i](https://h.example/p.png)',
    '{{EMAIL_abcdefgh}}',
    '<details><summary>s</summary>body</details>'
  ].join('\n\n')

  it('RL-9 逐节点相同', () => {
    expect(gated(CORPUS)).toEqual(noLinks(CORPUS))
  })
})

describe('RL-10 · 地址的边界', () => {
  it.each(['shuvix://session/abc?x=1', 'shuvix://session/abc.def', 'shuvix://session/abc#e1/x'])(
    'RL-10 %s 不算，文字整段留着',
    (addr) => {
      expect(links(`see ${addr} next`)).toEqual([])
      expect(text(gated(`see ${addr} next`))).toContain(addr)
    }
  )

  it('RL-10 根上的文字也切（块级裸 HTML 后面跟的那段）', () => {
    expect(props('<div>x</div> shuvix://session/abc')).toEqual([{ session: 'abc' }])
  })
})
