// @vitest-environment jsdom
/**
 * svgSanitize 的 DOM 半 —— 真解析器下的两档净化。纯函数半在 `svgSanitize.test.ts`（node 环境）。
 *
 * ⚠️ 本文件的硬约束，违反了就是一整套假门：**每条「某东西被剥掉」的断言都必须同时断言
 * 「该留的还在」。** 没有 DOMParser 时 `sanitizeXxx()` 一律返回 ''（失败关闭），于是所有
 * `not.toContain(...)` 会全部空转变绿 —— 一个放错环境的文件会伪装成一整套安全门。
 * 第一条用例因此是环境自检；注意上面那行环境指令必须留在文件最顶端。
 *
 * 另一条纪律：**同一段输入同时喂两档、同时断言**。两档的差异（<style> / <foreignObject> /
 * 会发起请求的地址）只有对照着看才立得住 —— 单看手写档那一列，"顺手把 mermaid 也收紧了"
 * 是看不出来的，而那是行为变更、该走裁决。
 */
import { describe, it, expect } from 'vitest'
import { sanitizeRenderedSvg, sanitizeAuthoredSvg, SVG_SANITIZE_TIERS } from './svgSanitize'

/** 同一段输入喂两档 */
const both = (svg: string): { ren: string; aut: string } => ({
  ren: sanitizeRenderedSvg(svg),
  aut: sanitizeAuthoredSvg(svg)
})

describe('环境自检（这条红了，下面每一条安全断言都是空转的）', () => {
  it('jsdom 在位：DOMParser 可用，正常图能出来', () => {
    expect(typeof DOMParser).toBe('function')
    const { ren, aut } = both('<svg viewBox="0 0 4 4"><rect width="2" height="2"/></svg>')
    expect(ren).toContain('<rect')
    expect(aut).toContain('<rect')
  })
})

// ───────────────────────── 两档差异：三条具名金丝雀 ─────────────────────────
//
// 不变式第 2 层。每条都**双向**断言：手写档关掉 + mermaid 档保留。只断言前半句时，
// 把 mermaid 那档一起收紧也会绿 —— 那正是要拦住的。

describe('金丝雀 1 · <style>', () => {
  const INPUT = '<svg><rect id="keep"/><style>* { display:none }</style></svg>'

  it('手写档：<style> 整删（正文也不留），<rect> 还在', () => {
    const { aut } = both(INPUT)
    expect(aut).toContain('<rect')
    expect(aut).not.toContain('<style')
    expect(aut).not.toContain('display:none') // 标签删掉了、CSS 正文却当文本留下来就白做了
  })

  it('mermaid 档：<style> 保留（主题样式靠它，收紧它是行为变更）', () => {
    const { ren } = both(INPUT)
    expect(ren).toContain('<style')
    expect(ren).toContain('display:none')
    expect(ren).toContain('<rect')
  })
})

describe('金丝雀 2 · <foreignObject>', () => {
  // 两种大小写：HTML 解析器按 SVG 标签名调整表把 foreignobject 还原成 foreignObject，
  // 判定读的是 nodeName.toLowerCase()，所以两种写法必须同样命中
  for (const [label, INPUT] of [
    ['驼峰', '<svg><rect id="keep"/><foreignObject><div>HTMLISLAND</div></foreignObject></svg>'],
    ['全小写', '<svg><rect id="keep"/><foreignobject><div>HTMLISLAND</div></foreignobject></svg>']
  ] as const) {
    it(`手写档（${label}）：整棵子树删掉，内层 div 也不在，<rect> 还在`, () => {
      const { aut } = both(INPUT)
      expect(aut).toContain('<rect')
      expect(aut.toLowerCase()).not.toContain('foreignobject')
      expect(aut).not.toContain('<div')
      expect(aut).not.toContain('HTMLISLAND')
    })

    it(`mermaid 档（${label}）：保留（htmlLabels 靠它）`, () => {
      const { ren } = both(INPUT)
      expect(ren.toLowerCase()).toContain('foreignobject')
      expect(ren).toContain('HTMLISLAND')
      expect(ren).toContain('<rect')
    })
  }
})

describe('金丝雀 3 · 会发起请求的地址', () => {
  const INPUT = '<svg><image href="https://evil.example/beacon.png"/><rect id="keep"/></svg>'

  it('手写档：远程 href 剥掉，<image> 元素与 <rect> 都还在', () => {
    const { aut } = both(INPUT)
    expect(aut).toContain('<image')
    expect(aut).toContain('<rect')
    expect(aut).not.toContain('evil.example')
  })

  it('mermaid 档：远程 href 保留（http/https 在那档是白名单协议）', () => {
    const { ren } = both(INPUT)
    expect(ren).toContain('evil.example')
    expect(ren).toContain('<rect')
  })
})

// ───────────────────────── 两档共同的黑名单 ─────────────────────────

describe('两档共同整删的元素', () => {
  // 被禁元素放在 keeper **之后**：`embed` / `img` 这类在 SVG 外来内容里属于 HTML
  // breakout 元素，解析期就会把后面的兄弟弹到 <svg> 外面去 —— 那时「兄弟还在」测的
  // 就不是遍历顺序而是解析器了。keeper 在前，两件事各自可测。
  const FORBIDDEN: [string, string][] = [
    ['script', '<script>alert(1)</script>'],
    ['iframe', '<iframe src="https://evil.example"></iframe>'],
    ['object', '<object data="x.swf"></object>'],
    ['embed', '<embed src="x.swf"/>'],
    ['set', '<set attributeName="fill" to="red"/>'],
    ['animate', '<animate attributeName="fill" to="red"/>']
  ]

  it.each(FORBIDDEN)('%s 两档都删，同时 <rect> 留下', (tag, markup) => {
    const { ren, aut } = both(`<svg><rect id="keep" width="2"/>${markup}</svg>`)
    for (const out of [ren, aut]) {
      expect(out).toContain('<rect')
      expect(out).toContain('width="2"')
      expect(out).not.toContain(`<${tag}`)
    }
    // 名单本身也得认这几个（避免「恰好被别的机制挡住」冒充成一条规则）
    expect(SVG_SANITIZE_TIERS.forbiddenTags.has(tag)).toBe(true)
  })

  it('待删元素不在遍历 live children 时就地 remove —— 后面的兄弟不会被跳过', () => {
    // 实现把待删元素推进 doomed 数组、遍历结束后才 remove，正是为了这条。
    // 谁「优化」成在 visit 里就地 el.remove()，children 集合当场缩短、索引前移，
    // <script> 后面的 <rect> 就会被跳过（onclick 留在 DOM 里）——那一刻这条立刻红。
    const { ren, aut } = both('<svg><script/><rect id="keep" onclick="alert(1)"/></svg>')
    for (const out of [ren, aut]) {
      expect(out).toContain('<rect')
      expect(out).toContain('keep') // 手写档会给 id 加前缀，所以只找原名子串
      expect(out).not.toContain('onclick')
      expect(out).not.toContain('<script')
    }
  })
})

describe('事件处理器属性', () => {
  it('任何 on* 都剥（含大写 ONCLICK 与 SVG 自有的 onbegin），而 opacity/offset 保留', () => {
    const { ren, aut } = both(
      '<svg><rect ONCLICK="a()" onbegin="b()" onRepeat="c()" opacity="0.5" offset="1"/></svg>'
    )
    for (const out of [ren, aut]) {
      expect(out).toContain('opacity="0.5"') // 前缀 "op" 同样以 o 开头 —— 别一刀砍成 startsWith('o')
      expect(out).toContain('offset="1"')
      expect(out.toLowerCase()).not.toContain('onclick')
      expect(out.toLowerCase()).not.toContain('onbegin')
      expect(out.toLowerCase()).not.toContain('onrepeat')
      expect(out).not.toContain('a()')
      expect(out).not.toContain('b()')
      expect(out).not.toContain('c()')
    }
  })
})

// ───────────────────────── 手写档的 url() 取值 ─────────────────────────

describe('手写档 · url() 取值判定（不看属性名，见 urlFunctionsAreFragmentOnly）', () => {
  it('片段引用全部保留：fill / style / mask / clip-path / filter / marker-end', () => {
    // 这些 id 在本文档里没有定义，所以不会被 id 隔离改名 —— 断言只关心 url(#x) 活下来
    const { aut } = both(
      '<svg><rect fill="url(#grad)" style="fill:url(#g)" mask="url(#m)"' +
        ' clip-path="url(#c)" filter="url(#f)" marker-end="url(#me)"/></svg>'
    )
    for (const kept of [
      'fill="url(#grad)"',
      'style="fill:url(#g)"',
      'mask="url(#m)"',
      'clip-path="url(#c)"',
      'filter="url(#f)"',
      'marker-end="url(#me)"'
    ]) {
      expect(aut).toContain(kept)
    }
  })

  // 每条都配一个「该留的」同伴属性：整条属性被剥 ≠ 整个元素被剥
  const STRIPPED: [string, string, string][] = [
    [
      'style 里的远程背景图',
      'style="background-image:url(https://evil.example/x)"',
      'evil.example'
    ],
    ['fill 里的远程地址', 'fill="url(https://evil.example/x)"', 'evil.example'],
    ['协议相对地址', 'fill="url(//evil.example/x)"', 'evil.example'],
    // CSS ident-token 允许转义：这三种写法经「consume an escaped code point」后都还是
    // url(，字面量查找一个都看不见（真实 Chromium 里实测都发出了请求）。修法是
    // 「属性值里出现反斜杠即判危」——砍掉整个转义类，不是补这三个样本。
    ['转义形式 \\75 rl', 'style="fill:\\75 rl(https://evil.example/x)"', '75 rl'],
    ['转义形式 \\000075rl', 'style="fill:\\000075rl(https://evil.example/x)"', '000075rl'],
    ['转义形式 u\\72 l', 'style="fill:u\\72 l(https://evil.example/x)"', '72 l']
  ]

  it.each(STRIPPED)('手写档剥掉整条属性：%s', (_label, attr, marker) => {
    const { ren, aut } = both(`<svg><rect ${attr} stroke="blue"/></svg>`)
    expect(aut).toContain('<rect')
    expect(aut).toContain('stroke="blue"') // 同一元素上的正常属性不受牵连
    expect(aut).not.toContain(marker)
    expect(aut).not.toContain('evil.example')
    // mermaid 档不做这道判定（那边的 url() 来自 mermaid 自己的样式产物）
    expect(ren).toContain(marker)
  })
})

// ───────────────────────── URL 属性与解析期解码 ─────────────────────────

describe('URL 属性', () => {
  it('实体编码的 javascript: 被剥 —— 读的是解析器已解码的 attr.value，两档同样', () => {
    // &#106; 在解析期就变成 j，DOM 里的 attr.value 已经是 javascript:alert(1)。
    // 谁把判定改成对原始标记做字符串匹配，这条立刻红。
    const { ren, aut } = both('<svg><a href="&#106;avascript:alert(1)">LABEL</a></svg>')
    for (const out of [ren, aut]) {
      expect(out).toContain('<a')
      expect(out).toContain('LABEL') // 元素与文字都留下，只有 href 没了
      expect(out).not.toContain('href')
      expect(out).not.toContain('alert(1)')
    }
  })

  it('xlink:href 同样过白名单：远程剥、片段留（手写档）', () => {
    const { aut } = both('<svg><use xlink:href="https://evil.example/x"/><rect/></svg>')
    expect(aut).toContain('<use')
    expect(aut).not.toContain('evil.example')
    expect(both('<svg><use xlink:href="#g"/><rect/></svg>').aut).toContain('xlink:href="#g"')
  })

  it('<image> 的远程 href 剥掉但元素留下；data: 位图原样保留', () => {
    const remote = both('<svg><image href="https://evil.example/x.png"/><rect/></svg>')
    expect(remote.aut).toContain('<image')
    expect(remote.aut).not.toContain('href')
    expect(remote.aut).not.toContain('evil.example')

    const data = both('<svg><image href="data:image/png;base64,iVBORw0KGgo="/></svg>')
    expect(data.aut).toContain('href="data:image/png;base64,iVBORw0KGgo="')
    expect(data.ren).toContain('href="data:image/png;base64,iVBORw0KGgo="')
  })
})

describe('HTML 外来内容的 breakout', () => {
  it('<img src=x onerror=…> 被解析器弹出 <svg> 之外，因此不进输出', () => {
    // img 在 SVG 外来内容里是 breakout 元素：解析期就被弹成 <svg> 的**兄弟**，
    // 于是 root.outerHTML 天然不含它 —— 这是解析器给的、而非净化器判的。
    // 把这份「侥幸」钉成被守护的已知行为：谁把解析目标换掉（见下面 no-xmlns 那条），
    // img 就可能落进 <svg> 里面，而那时净化器并没有 img 这条规则。
    const { ren, aut } = both('<svg><rect id="keep"/><img src=x onerror=alert(1)></svg>')
    for (const out of [ren, aut]) {
      expect(out).toContain('<rect')
      expect(out).not.toContain('<img')
      expect(out).not.toContain('onerror')
    }
  })
})

// ───────────────────────── 失败关闭与解析口径 ─────────────────────────

describe('失败关闭', () => {
  it.each([
    ['非 svg 根', '<div><rect/></div>'],
    ['纯文本段落，通篇没有 svg', '<p>text</p>'],
    ['只有文字', 'just prose'],
    ['空串', '']
  ])('两档都判死：%s', (_label, input) => {
    const { ren, aut } = both(input)
    expect(ren).toBe('')
    expect(aut).toBe('')
  })

  it('现状记录：<svg> 前面有别的内容时，仍取文档里第一个 <svg>', () => {
    // querySelector('svg') 找的是 body 的后代，不要求 <svg> 是第一个节点。
    // 与下面「两个并列 <svg> 只取第一个」同一个机制：图 = 解析树里第一个 <svg>。
    const { ren, aut } = both('<p>prose</p><svg><rect id="keep"/></svg>')
    for (const out of [ren, aut]) {
      expect(out).toContain('<rect')
      expect(out.startsWith('<svg')).toBe(true)
      expect(out).not.toContain('prose')
    }
  })

  it('现状记录：两个并列 <svg> 只有第一个进输出', () => {
    const { ren, aut } = both('<svg id="first"><rect/></svg><svg id="second"><circle/></svg>')
    for (const out of [ren, aut]) {
      expect(out).toContain('first')
      expect(out).not.toContain('second')
      expect(out).not.toContain('<circle')
    }
  })
})

describe('解析口径：text/html 而非 image/svg+xml', () => {
  it('没有 xmlns 的 <svg viewBox=…> 正常净化并出图', () => {
    // 这是现实里最高频的输入 —— 模型手写常常不写 xmlns。谁把解析改成 'image/svg+xml'，
    // 这条立刻红，而那正是会把大量正常图判死的改动（<br> 这类不闭合标签也会直接 parsererror）。
    const { ren, aut } = both(
      '<svg viewBox="0 0 320 120"><rect x="1" y="2" width="4" height="5" fill="var(--viz-1)"/></svg>'
    )
    for (const out of [ren, aut]) {
      expect(out).toContain('viewBox="0 0 320 120"')
      expect(out).toContain('fill="var(--viz-1)"')
      expect(out).toContain('<rect')
    }
  })
})

describe('手写档 · 剥空判死', () => {
  it('整段都是被禁元素时手写档返回 ""，mermaid 档保留空 <svg>', () => {
    // 非空字符串会让调用方以为成功，于是用户看到一张**空白图卡**而不是错误卡加源码；
    // 而「模型整段写的都是被禁的东西」恰恰是最该让人看见源码的情形。
    // mermaid 档刻意不做这个判断：它的产物本就可能是一张合法的空图。
    expect(sanitizeAuthoredSvg('<svg><script>x</script></svg>')).toBe('')
    expect(sanitizeRenderedSvg('<svg><script>x</script></svg>')).not.toBe('')

    expect(sanitizeAuthoredSvg('<svg><style>*{fill:red}</style></svg>')).toBe('')
    expect(sanitizeRenderedSvg('<svg></svg>')).not.toBe('')
  })

  it('剩下一个元素就不算剥空（即便它自己的属性全被剥掉）', () => {
    const aut = sanitizeAuthoredSvg('<svg><image href="https://evil.example/x"/></svg>')
    expect(aut).not.toBe('')
    expect(aut).toContain('<image')
  })
})

describe('输入长度上限', () => {
  /** 一条超长属性值 —— 元素少、解析快；用几万个元素凑长度会让这条用例跑成分钟级 */
  const atLength = (total: number): string => {
    const shell = '<svg><rect d=""/></svg>'
    return shell.replace('d=""', `d="${'x'.repeat(total - shell.length)}"`)
  }
  const MAX = 256 * 1024

  it('恰好 256KB 仍正常出图（边界取等）', () => {
    const src = atLength(MAX)
    expect(src.length).toBe(MAX)
    expect(sanitizeAuthoredSvg(src)).toContain('<rect')
    expect(sanitizeRenderedSvg(src)).toContain('<rect')
  })

  it('超过 256KB 两档都判死（一张静态图远用不到这个量级）', () => {
    const src = atLength(MAX + 1)
    expect(src.length).toBe(MAX + 1)
    expect(sanitizeAuthoredSvg(src)).toBe('')
    expect(sanitizeRenderedSvg(src)).toBe('')
  })
})

// ───────────────────────── 手写档 · id 隔离 ─────────────────────────

describe('手写档 · id 隔离', () => {
  const GRAD =
    '<svg><defs><linearGradient id="grad"><stop offset="0"/></linearGradient></defs>' +
    '<rect fill="url(#grad)" clip-path="url(#grad)"/><use href="#grad"/></svg>'

  it('侧面 1：id 加前缀，且 url(#id) / href="#id" / clip-path 同步改写', () => {
    const aut = sanitizeAuthoredSvg(GRAD)
    const prefixed = /id="(s[a-z0-9]+)-grad"/.exec(aut)
    expect(prefixed, aut).not.toBeNull()
    const scoped = `${prefixed![1]}-grad`
    expect(aut).toContain(`fill="url(#${scoped})"`)
    expect(aut).toContain(`clip-path="url(#${scoped})"`)
    expect(aut).toContain(`href="#${scoped}"`)
    // 一个裸 #grad 都不许留下：漏掉一处引用就是「图画错了但不报错」
    expect(aut).not.toContain('#grad"')
    expect(aut).not.toContain('#grad)')
  })

  it('侧面 2：前缀取自内容 —— 同一段输入恒得同一份产物（缓存才成立）', () => {
    expect(sanitizeAuthoredSvg(GRAD)).toBe(sanitizeAuthoredSvg(GRAD))
  })

  it('侧面 3：两张不同的图都用 id="grad" 时前缀不同 —— 一条回复里两张图不会串色', () => {
    const one = sanitizeAuthoredSvg(
      '<svg><linearGradient id="grad"/><rect fill="url(#grad)" width="1"/></svg>'
    )
    const two = sanitizeAuthoredSvg(
      '<svg><linearGradient id="grad"/><rect fill="url(#grad)" width="2"/></svg>'
    )
    const idOf = (out: string): string => /id="([^"]+)"/.exec(out)![1]
    expect(idOf(one)).not.toBe(idOf(two))
    // 且各自内部仍自洽
    expect(one).toContain(`url(#${idOf(one)})`)
    expect(two).toContain(`url(#${idOf(two)})`)
  })

  it('侧面 4：未在本文档定义的引用不改名；无 id 的图一个字节都不动', () => {
    const dangling = sanitizeAuthoredSvg('<svg><rect id="a" fill="url(#nowhere)"/></svg>')
    expect(dangling).toContain('fill="url(#nowhere)"')
    expect(dangling).not.toContain('id="a"') // 定义过的那个照样加前缀

    const plain = '<svg><rect fill="red"/><circle r="1"/></svg>'
    expect(sanitizeAuthoredSvg(plain)).toBe(sanitizeRenderedSvg(plain))
  })

  it('mermaid 档不做 id 隔离（它用自己的 render id 加前缀，天然免疫）', () => {
    expect(sanitizeRenderedSvg(GRAD)).toContain('id="grad"')
    expect(sanitizeRenderedSvg(GRAD)).toContain('url(#grad)')
  })
})

// ───────────────────────── 不变式第 1 层（DOM 半）─────────────────────────

/**
 * 「手写档剥掉的 ⊇ mermaid 档剥掉的」—— 两个集合都**从输出算出来**，不抄期望值。
 *
 * 语料越怪越好：这条不关心某个 token 该不该被剥，只钉两档的偏序。往共同黑名单里加标签
 * 自动两档生效（差集不变），只往手写档加则必须同时更新上面那三条金丝雀。
 */
describe('两档偏序不变式（DOM 语料）', () => {
  /** 探针 token：出现在某条语料里、且能在输出里用子串找回来的标记 */
  const TOKENS = [
    '<style',
    'display:none',
    'foreignObject',
    'HTMLISLAND',
    '<script',
    '<iframe',
    '<object',
    '<embed',
    '<set',
    '<animate',
    '<img',
    'onclick',
    'onerror',
    'evil.example',
    'mailto:',
    'javascript:',
    'url(https',
    'url(//',
    '75 rl',
    'xlink:href',
    'KEEPME'
  ]

  const CORPUS = [
    '<svg><rect id="KEEPME"/><style>* { display:none }</style></svg>',
    '<svg><rect id="KEEPME"/><foreignObject><div>HTMLISLAND</div></foreignObject></svg>',
    '<svg><rect id="KEEPME"/><script>x</script><iframe src="y"></iframe></svg>',
    '<svg><rect id="KEEPME"/><object data="x"></object><embed src="y"/></svg>',
    '<svg><rect id="KEEPME"/><set attributeName="f"/><animate attributeName="f"/></svg>',
    '<svg><rect id="KEEPME" onclick="a()"/><img src=x onerror=alert(1)></svg>',
    '<svg><image href="https://evil.example/x"/><rect id="KEEPME"/></svg>',
    '<svg><a href="mailto:a@evil.example">t</a><rect id="KEEPME"/></svg>',
    '<svg><a href="javascript:alert(1)">t</a><rect id="KEEPME"/></svg>',
    '<svg><rect id="KEEPME" fill="url(https://evil.example/x)"/></svg>',
    '<svg><rect id="KEEPME" fill="url(//evil.example/x)"/></svg>',
    '<svg><rect id="KEEPME" style="fill:\\75 rl(#g)"/></svg>',
    '<svg><use xlink:href="https://evil.example/x"/><rect id="KEEPME"/></svg>',
    '<svg><use xlink:href="#KEEPME"/><rect id="KEEPME"/></svg>',
    '<svg viewBox="0 0 4 4"><rect id="KEEPME" fill="var(--viz-1)"/></svg>'
  ]

  it.each(CORPUS)('mermaid 档剥掉的 ⊆ 手写档剥掉的：%s', (input) => {
    const { ren, aut } = both(input)
    // 语料都是「有一个 <svg> 根、长度也没超限」的输入：mermaid 档非空，
    // 所以下面的包含关系不可能靠「两边都是空串」空转过去
    expect(ren).not.toBe('')
    const present = TOKENS.filter((t) => input.includes(t))
    expect(present.length).toBeGreaterThan(0)
    const strippedBy = (out: string): string[] => present.filter((t) => !out.includes(t))
    expect(strippedBy(aut)).toEqual(expect.arrayContaining(strippedBy(ren)))
  })
})
