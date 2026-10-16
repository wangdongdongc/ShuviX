/**
 * 共用的代码高亮 `rehypeHighlightShared` —— 全进程只建一次的那个变换。
 *
 * react-markdown 每次渲染都新建一个 unified 处理器、重新调用每个插件的 attacher；rehype-highlight 的 attacher
 * 每次都 `createLowlight(common)`，把三十多种语法重新注册一遍。改成 attacher 每次交回同一个变换函数之后，
 * 要钉住的是「省掉的只有那次注册」：
 *
 *   F-2 生产表里不再有 rehype-highlight 的默认导出（逐项按引用的那条在 rehypeSanitizeRawHtml.test.ts 的 0 组）
 *   F-3 同一份语料（各种语言、未注册的语言、没写语言、行内代码、裸写的 pre>code）：生产管线与「同一格换回原版
 *       rehype-highlight」的管线产出逐节点相同的树
 *   F-4 attacher 每次交回同一个变换，挂在哪个处理器上都一样
 *   F-5 变换不带文档状态：同一份 A 不论夹在 B 之后、还是各用一个新处理器，结果都相同
 *   F-6 未注册语言的告警只记在那份文档自己的 file 上，不串到下一份
 *
 * 跑的是生产那两张表（`markdownRemarkPlugins` / `markdownRehypePlugins`）—— 与 rehypeSanitizeRawHtml.test.ts
 * 同一条理由：手抄插件表证明不了线上那条链。
 */
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeHighlight from 'rehype-highlight'
import { unified, type Processor } from 'unified'
import { VFile } from 'vfile'
import { describe, it, expect } from 'vitest'
import {
  markdownRemarkPlugins,
  markdownRehypePlugins,
  rehypeHighlightShared
} from './markdownPlugins'

type RehypePlugins = typeof markdownRehypePlugins

function processor(rehypePlugins: RehypePlugins): Processor {
  return unified()
    .use(remarkParse)
    .use(markdownRemarkPlugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypePlugins) as unknown as Processor
}

/** 跑到 hast 为止；file 也交回来（告警记在它上面） */
function run(proc: Processor, md: string): { tree: unknown; file: VFile } {
  const file = new VFile(md)
  const tree = proc.runSync(proc.parse(file), file)
  return { tree, file }
}

/** 生产表里高亮那一格换回原版 rehype-highlight（每次挂载都新建一个 lowlight） */
const stockPlugins = markdownRehypePlugins.map((p) =>
  p === rehypeHighlightShared ? rehypeHighlight : p
) as RehypePlugins

const CORPUS: Array<[string, string]> = [
  ['js', '```js\nconst a = 1\nfunction f() { return a }\n```'],
  ['ts', '```ts\ninterface X { a: number }\nconst x: X = { a: 1 }\n```'],
  ['python', '```python\ndef f(x):\n    return x + 1\n```'],
  ['json', '```json\n{ "a": [1, true, null] }\n```'],
  ['bash', '```bash\nfor f in *.md; do echo "$f"; done\n```'],
  ['未注册的语言', '```wat\n(module (func $f))\n```'],
  ['没写语言', '```\nplain text block\n```'],
  ['行内代码', 'call `foo()` and `/tmp/a.txt` here'],
  ['裸写的 pre>code', '<pre><code class="language-js">let y = 2</code></pre>']
]

describe('共用的高亮（F-2…F-6）', () => {
  it('F-2 生产表里不再有 rehype-highlight 的默认导出', () => {
    expect(markdownRehypePlugins).not.toContain(rehypeHighlight)
    expect(markdownRehypePlugins).toContain(rehypeHighlightShared)
    // 对照组确实是「只换了那一格」
    expect(stockPlugins).toContain(rehypeHighlight)
    expect(stockPlugins).toHaveLength(markdownRehypePlugins.length)
  })

  it.each(CORPUS)('F-3 %s：与原版 rehype-highlight 产出逐节点相同的树', (_label, md) => {
    const ours = run(processor(markdownRehypePlugins), md).tree
    const stock = run(processor(stockPlugins), md).tree
    expect(ours).toEqual(stock)
  })

  it('F-3 非空证：语料里的围栏确实被高亮了（否则上一条可能是两边都没高亮的假绿）', () => {
    const tree = run(processor(markdownRehypePlugins), CORPUS[0][1]).tree
    expect(JSON.stringify(tree)).toContain('hljs-keyword')
  })

  it('F-4 attacher 每次交回同一个变换；挂在两个不同的处理器上也是同一个', () => {
    expect(rehypeHighlightShared()).toBe(rehypeHighlightShared())
    const procA = unified()
    const procB = unified()
    const viaA = (rehypeHighlightShared as (this: unknown) => unknown).call(procA)
    const viaB = (rehypeHighlightShared as (this: unknown) => unknown).call(procB)
    expect(viaA).toBe(viaB)
    expect(viaA).toBe(rehypeHighlightShared())
  })

  it('F-5 变换不带文档状态：A → B → A 同一个处理器，与两个新处理器各跑一次 A，结果都相同', () => {
    const A = '```js\nconst a = 1\n```\n\ntext `inline`'
    const B = '```python\nclass B:\n    pass\n```'
    const shared = processor(markdownRehypePlugins)
    const first = run(shared, A).tree
    run(shared, B)
    const again = run(shared, A).tree
    const fresh1 = run(processor(markdownRehypePlugins), A).tree
    const fresh2 = run(processor(markdownRehypePlugins), A).tree
    expect(again).toEqual(first)
    expect(fresh1).toEqual(first)
    expect(fresh2).toEqual(first)
  })

  it('F-6 未注册语言的告警只记在那份文档自己的 file 上', () => {
    const proc = processor(markdownRehypePlugins)
    const withWat = run(proc, '```wat\n(module)\n```').file
    const plain = run(proc, '```js\nconst ok = 1\n```').file
    expect(withWat.messages.map((m) => m.ruleId)).toEqual(['missing-language'])
    expect(String(withWat.messages[0].reason)).toContain('wat')
    expect(plain.messages).toEqual([])
  })
})
