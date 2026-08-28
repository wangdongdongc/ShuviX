/**
 * read_page 的链接目标精简。
 *
 * 这个改动是**有损**的（和 snapshot 的压缩不同，后者按 W3C accname 规范可证明无损），
 * 丢的东西可以精确定位：链接目标。所以用例的重点在两处 ——「正文一个字都不能少」，
 * 以及「自证提示必须在，它是模型找回 URL 的唯一线索」。
 */
import { describe, it, expect } from 'vitest'
import { stripLinkTargets, formatReadPage } from '../readPage'

const page = { title: '测试页', url: 'https://example.com/x', html: '' }

describe('stripLinkTargets', () => {
  it('普通链接：保留方括号里的文字，去掉目标', () => {
    // 保留方括号是有意的：模型据此知道这里曾是一个链接，只是目标没给
    const r = stripLinkTargets('看 [文档](https://a.example/very/long/path?q=1) 里的说明')
    expect(r.markdown).toBe('看 [文档] 里的说明')
    expect(r.stripped).toBe(1)
  })

  it('图片：alt 是信息，CDN 地址不是', () => {
    const r = stripLinkTargets('![截图](https://cdn.example/a1b2c3.png)')
    expect(r.markdown).toBe('![截图]')
    expect(r.stripped).toBe(1)
  })

  it('图片套在链接里 → 两层都去掉（回归钉）', () => {
    // 实测 hn 首行就是这个形状。图片先剥、链接后剥；若链接的方括号不允许套一层，
    // 外层 URL 会漏出来（改造中真漏过一次）
    const r = stripLinkTargets(
      '[![Y Combinator](https://news.ycombinator.com/y18.svg)](https://news.ycombinator.com)'
    )
    expect(r.markdown).toBe('[![Y Combinator]]')
    expect(r.stripped).toBe(2)
  })

  it('尖括号形式的目标 `(<url>)` 同样去掉', () => {
    expect(stripLinkTargets('[a](<https://x.example/a b>)').markdown).toBe('[a]')
  })

  it('正文一个字都不少：所有链接文字原样保留', () => {
    const md = '[一](u1) 中间 [二](u2) 结尾 ![三](u3)'
    const r = stripLinkTargets(md)
    for (const t of ['一', '中间', '二', '结尾', '三']) expect(r.markdown).toContain(t)
    expect(r.stripped).toBe(3)
  })

  it('没有链接时原样返回', () => {
    const md = '# 标题\n\n一段普通文字。'
    const r = stripLinkTargets(md)
    expect(r.markdown).toBe(md)
    expect(r.stripped).toBe(0)
  })

  it('不改坏代码：`arr[0](x)` 与 markdown 链接语法完全同形', () => {
    // 「从数组取函数再调用」在语法上就是 [text](url)。不跳过代码区域就会被剥成
    // `handlers[0]` —— 实测确认过会坏。read_page 大量用于读文档，这不是理论风险。
    const fenced = '```js\nconst fn = handlers[0](arg)\n```'
    expect(stripLinkTargets(fenced).markdown).toBe(fenced)
    const inline = '调用 `cb[i](x)` 即可'
    expect(stripLinkTargets(inline).markdown).toBe(inline)
    const tilde = '~~~py\nf = fns[2](3)\n~~~'
    expect(stripLinkTargets(tilde).markdown).toBe(tilde)
    // 代码块里的 markdown 链接示例也该原样保留
    const sample = '```md\n参见 [文档](https://a.example)\n```'
    expect(stripLinkTargets(sample).markdown).toBe(sample)
    // 但代码块**之外**的链接照剥
    const mixed = '`code[0](x)` 和 [真链接](https://a.example)'
    expect(stripLinkTargets(mixed).markdown).toBe('`code[0](x)` 和 [真链接]')
  })

  it('链接文字本身是行内代码时照样剥（MDN 的主流写法）', () => {
    // 回归钉：曾按代码区切段后分别处理，把 [`code`](url) 拆成 `[` + 代码 + `](url)`，
    // 两边都匹配不上，URL 全留下 —— mdn 的收益因此从 56% 掉到 27%。改为遮蔽还原。
    const r = stripLinkTargets('参见 [`aria-label`](https://developer.mozilla.org/x) 属性')
    expect(r.markdown).toBe('参见 [`aria-label`] 属性')
    expect(r.stripped).toBe(1)
  })
})

describe('formatReadPage', () => {
  const many = Array.from(
    { length: 40 },
    (_, i) => `[链接${i}](https://example.com/path/${i}?x=1)`
  ).join('\n')

  it('自证提示：说清少了什么、怎么补', () => {
    const out = formatReadPage(page, many)
    expect(out).toContain('40 link targets omitted')
    expect(out).toContain('[label]') // 少了什么
    expect(out).toContain('evaluate') // 怎么补
    // 提示要在表头，不能在几千行之后的结尾 —— 那里未必被读到
    expect(out.indexOf('omitted')).toBeLessThan(out.indexOf('链接0'))
  })

  it('省不到阈值的小页面：逐字节与不做这件事时相同，也不加提示', () => {
    // 只有一两个链接时，提示比省下来的还贵（实测 example.com 54 → 67 tok，净亏）
    const tiny = '一段文字 [了解更多](https://x.example/a)。'
    const out = formatReadPage(page, tiny)
    expect(out).toBe(`Page: ${page.title}\nURL: ${page.url}\n\n${tiny}`)
    expect(out).not.toContain('omitted')
  })

  it('没有链接时不加提示', () => {
    expect(formatReadPage(page, '# 只有标题')).not.toContain('omitted')
  })

  it('体量：链接密集的页面显著变小', () => {
    const before = `Page: ${page.title}\nURL: ${page.url}\n\n${many}`
    expect(formatReadPage(page, many).length).toBeLessThan(before.length * 0.6)
  })

  it('单数/复数文案', () => {
    const one = '[a](https://example.com/' + 'x'.repeat(300) + ')'
    expect(formatReadPage(page, one)).toContain('1 link target omitted')
  })
})
