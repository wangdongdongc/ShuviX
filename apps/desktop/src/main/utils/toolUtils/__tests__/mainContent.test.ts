/**
 * 网页正文清理（mainContent.ts）：转 Markdown 之前去掉站点导航、页眉页脚、侧栏和 cookie 横幅。
 *
 * 夹具约定：P(n) 是一个恰好 n 个非空白字符的 <p>（清理器数字数时去掉空白，所以填充不带空格）。
 * 断言靠唯一标记：KEEP-… 留着，GONE-… 没了。除非用例另说，页面在被删的块之外都有足够的正文
 * （MAIN：<main> + P(300)），两条安全网都不会触发；<p> 总量尽量不超过 400，免得段落安全网插手。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanMainContent, MAIN_CONTENT_MAX_HTML_CHARS } from '../mainContent'

const P = (n: number, ch = 'x'): string => `<p>${ch.repeat(n)}</p>`

const doc = (body: string, head = '', htmlAttrs = ''): string =>
  `<!doctype html><html${htmlAttrs}><head><title>T</title>${head}</head><body>${body}</body></html>`

const MAIN = `<main><h2>KEEP-MAIN</h2>${P(300, 'm')}</main>`
const NAV = '<nav><ul><li><a href="/a">GONE-NAV</a></li></ul></nav>'

/** 清理过：返回 HTML；没清理（null）就让用例失败 */
async function cleaned(html: string): Promise<string> {
  const result = await cleanMainContent(html)
  expect(result).not.toBeNull()
  return result!.html
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('导航', () => {
  it('MC-1 <main> 旁边的 <nav>：删掉，正文留着', async () => {
    const out = await cleaned(doc(NAV + MAIN))
    expect(out).not.toContain('GONE-NAV')
    expect(out).toContain('KEEP-MAIN')
  })

  it('MC-2 role=navigation 一样删', async () => {
    const out = await cleaned(
      doc(`<div role="navigation"><a href="/a">GONE-NAV-ROLE</a></div>${MAIN}`)
    )
    expect(out).not.toContain('GONE-NAV-ROLE')
    expect(out).toContain('KEEP-MAIN')
  })

  it('MC-3 包着 <article> 的 <nav> 留着；没别的可删 → null', async () => {
    const html = doc(
      `<nav><ul><li><a href="/x">KEEP-LINK</a></li></ul><article><h1>KEEP-ART</h1>${P(300)}</article></nav>`
    )
    expect(await cleanMainContent(html)).toBeNull()
  })

  it('MC-4 role=navigation 包着 role=main → null', async () => {
    const html = doc(
      `<div role="navigation"><a href="/x">KEEP-LINK</a><div role="main">${P(300)}</div></div>`
    )
    expect(await cleanMainContent(html)).toBeNull()
  })

  it('MC-5 导航里有 700 字段落也删（导航不受「有正文」保护）', async () => {
    const out = await cleaned(
      doc(`<nav><span>GONE-NAV</span>${P(700, 'n')}</nav><main>${P(2000, 'm')}</main>`)
    )
    expect(out).not.toContain('GONE-NAV')
    expect(out).not.toContain('n'.repeat(700))
    expect(out).toContain('m'.repeat(2000))
  })

  it('MC-6 外层 nav 包着 main 留着；main 里的目录 nav 删', async () => {
    const out = await cleaned(
      doc(
        `<nav><a href="/o">KEEP-OUTER</a><main><h2>KEEP-MAIN</h2><nav><a href="#t">GONE-TOC</a></nav>${P(300)}</main></nav>`
      )
    )
    expect(out).not.toContain('GONE-TOC')
    expect(out).toContain('KEEP-OUTER')
    expect(out).toContain('KEEP-MAIN')
  })
})

describe('页面家具', () => {
  it.each([
    ['role=search', '<div role="search"><input><span>GONE-X</span></div>'],
    ['role=dialog', '<div role="dialog"><span>GONE-X</span></div>'],
    ['role=alertdialog', '<div role="alertdialog"><span>GONE-X</span></div>'],
    ['<dialog open>', '<dialog open><span>GONE-X</span></dialog>']
  ])('MC-7 %s：删', async (_name, block) => {
    const out = await cleaned(doc(block + MAIN))
    expect(out).not.toContain('GONE-X')
    expect(out).toContain('KEEP-MAIN')
  })

  it('MC-9 <div hidden> 带文字：删，算清理过', async () => {
    const out = await cleaned(doc(`<div hidden>GONE-HIDDEN</div>${MAIN}`))
    expect(out).not.toContain('GONE-HIDDEN')
  })

  it.each([
    ['<iframe>', '<iframe src="https://example.test/f">GONE-IFRAME</iframe>'],
    ['<template>', '<template><p>GONE-TEMPLATE</p></template>'],
    ['<noscript>', '<noscript><span>GONE-NOSCRIPT</span></noscript>'],
    ['内联 <svg><title>', '<svg viewBox="0 0 1 1"><title>GONE-SVG</title><path d="M0 0"/></svg>']
  ])('MC-9 只删了 %s（没有可见文字）：不算清理过 → null', async (_name, block) => {
    expect(await cleanMainContent(doc(block + MAIN))).toBeNull()
  })

  it('MC-10 文章里的 svg 图标删掉，文章正文留着', async () => {
    const out = await cleaned(
      doc(
        `${NAV}<article><svg viewBox="0 0 1 1"><title>GONE-SVG-TITLE</title><path d="M0 0"/></svg><h2>KEEP-ART</h2>${P(300, 'a')}</article>`
      )
    )
    expect(out).not.toContain('<svg')
    expect(out).not.toContain('GONE-SVG-TITLE')
    expect(out).toContain('KEEP-ART')
    expect(out).toContain('a'.repeat(300))
  })

  it('MC-11 <div hidden> 里有 601 字段落：留着', async () => {
    const out = await cleaned(
      doc(`<div hidden><span>KEEP-H</span>${P(601, 'h')}</div>${NAV}${MAIN}`)
    )
    expect(out).toContain('KEEP-H')
    expect(out).toContain('h'.repeat(601))
    expect(out).not.toContain('GONE-NAV')
  })

  it('MC-12 边界：<div hidden> 里恰好 600 字段落 → 删', async () => {
    // main 要够大，删掉 600 字后段落安全网才不触发
    const out = await cleaned(
      doc(`<div hidden><span>GONE-H</span>${P(600, 'h')}</div><main>${P(1000, 'm')}</main>`)
    )
    expect(out).not.toContain('GONE-H')
    expect(out).not.toContain('h'.repeat(600))
  })

  it('MC-13 包着 <article> 的 role=dialog 留着', async () => {
    const out = await cleaned(
      doc(`<div role="dialog"><article><h2>KEEP-DLG</h2>${P(300)}</article></div>${NAV}`)
    )
    expect(out).toContain('KEEP-DLG')
    expect(out).toContain('role="dialog"')
  })

  it('MC-15 先删导航：search 块里唯一的长段落在子 nav 里 → 整个 search 块删掉', async () => {
    const out = await cleaned(
      doc(
        `<div role="search"><span>GONE-SEARCH</span><nav>${P(700, 'n')}</nav></div><main>${P(1200, 'm')}</main>`
      )
    )
    expect(out).not.toContain('GONE-SEARCH')
    expect(out).not.toContain('role="search"')
    expect(out).toContain('m'.repeat(1200))
  })
})

describe('aria-hidden', () => {
  it('MC-16 表格外的 aria-hidden=true：删', async () => {
    const out = await cleaned(doc(`<div aria-hidden="true">GONE-AH</div>${MAIN}`))
    expect(out).not.toContain('GONE-AH')
  })

  it('MC-17 表格里的 aria-hidden（行、单元格里的 span）：留着', async () => {
    const out = await cleaned(
      doc(
        `${NAV}<table><tr aria-hidden="true"><td>KEEP-ROW</td></tr><tr><td><span aria-hidden="true">KEEP-SPAN</span></td></tr></table>${MAIN}`
      )
    )
    expect(out).toContain('KEEP-ROW')
    expect(out).toContain('KEEP-SPAN')
    expect(out).not.toContain('GONE-NAV')
  })

  it('MC-18 aria-hidden=false：留着', async () => {
    const out = await cleaned(doc(`<div aria-hidden="false">KEEP-AF</div>${NAV}${MAIN}`))
    expect(out).toContain('KEEP-AF')
  })

  it('MC-19 aria-hidden 包着 <main>、或里面有 601 字段落：都留着', async () => {
    const out = await cleaned(
      doc(
        `<div aria-hidden="true"><main><h2>KEEP-WRAP</h2>${P(300)}</main></div><div aria-hidden="true"><span>KEEP-LONG</span>${P(601, 'l')}</div>${NAV}`
      )
    )
    expect(out).toContain('KEEP-WRAP')
    expect(out).toContain('KEEP-LONG')
    expect(out).toContain('l'.repeat(601))
    expect(out).not.toContain('GONE-NAV')
  })
})

describe('页脚 / 页眉', () => {
  const FOOTERS = [
    ['<footer>', (inner: string) => `<footer>${inner}</footer>`],
    ['role=contentinfo', (inner: string) => `<div role="contentinfo">${inner}</div>`]
  ] as const
  const HEADERS = [
    ['<header>', (inner: string) => `<header>${inner}</header>`],
    ['role=banner', (inner: string) => `<div role="banner">${inner}</div>`]
  ] as const

  it.each(FOOTERS)('MC-20 %s：站点页脚（链接 + 版权）删', async (_name, wrap) => {
    const out = await cleaned(
      doc(MAIN + wrap('<a href="/about">GONE-FOOT-LINK</a> © 2026 GONE-COPY'))
    )
    expect(out).not.toContain('GONE-FOOT-LINK')
    expect(out).not.toContain('GONE-COPY')
    expect(out).toContain('KEEP-MAIN')
  })

  it.each(FOOTERS)('MC-21 %s 在 <blockquote> 里：留着（引文出处）', async (_name, wrap) => {
    const out = await cleaned(
      doc(
        `${NAV}<main><h2>KEEP-MAIN</h2>${P(300)}<blockquote><p>quote</p>${wrap('KEEP-AUTHOR')}</blockquote></main>`
      )
    )
    expect(out).toContain('KEEP-AUTHOR')
    expect(out).not.toContain('GONE-NAV')
  })

  it('MC-22 <article> 里的短 <footer>（标签行）：删', async () => {
    const out = await cleaned(
      doc(`<article><h1>KEEP-T</h1>${P(300)}<footer>GONE-TAGS</footer></article>`)
    )
    expect(out).not.toContain('GONE-TAGS')
    expect(out).toContain('KEEP-T')
  })

  it('MC-23 <footer> 里有 601 字段落：留着', async () => {
    const out = await cleaned(
      doc(`${NAV}${MAIN}<footer><span>KEEP-F</span>${P(601, 'f')}</footer>`)
    )
    expect(out).toContain('KEEP-F')
    expect(out).toContain('f'.repeat(601))
  })

  it.each(HEADERS)('MC-24 %s：main 外、没有 h1 的站点页眉删', async (_name, wrap) => {
    const out = await cleaned(doc(wrap('<a href="/">GONE-LOGO</a><span>GONE-HDR</span>') + MAIN))
    expect(out).not.toContain('GONE-LOGO')
    expect(out).not.toContain('GONE-HDR')
    expect(out).toContain('KEEP-MAIN')
  })

  const CONTAINERS = [
    ['article', (inner: string) => `<article>${inner}</article>`],
    ['main', (inner: string) => `<main>${inner}</main>`],
    ['role=main', (inner: string) => `<div role="main">${inner}</div>`]
  ] as const
  it.each(
    HEADERS.flatMap(([hName, hWrap]) =>
      CONTAINERS.map(([cName, cWrap]) => [hName, cName, hWrap, cWrap] as const)
    )
  )('MC-25 %s 在 %s 里：留着', async (_h, _c, hWrap, cWrap) => {
    const out = await cleaned(doc(NAV + cWrap(hWrap('<span>KEEP-HDR</span>') + P(300))))
    expect(out).toContain('KEEP-HDR')
    expect(out).not.toContain('GONE-NAV')
  })

  it.each(HEADERS)('MC-26 %s 里有 h1：页眉留着，里面的 nav 删', async (_name, wrap) => {
    const out = await cleaned(
      doc(wrap('<h1>KEEP-H1</h1><nav><a href="/a">GONE-NAV-IN-HDR</a></nav>') + MAIN)
    )
    expect(out).toContain('KEEP-H1')
    expect(out).not.toContain('GONE-NAV-IN-HDR')
  })

  it('MC-27 先删导航：h1 在页眉的 nav 里 → nav 删掉后页眉没 h1，整个删', async () => {
    const out = await cleaned(
      doc(`<header><nav><h1>GONE-SITE</h1><a href="/a">GONE-LINK</a></nav></header>${MAIN}`)
    )
    expect(out).not.toContain('GONE-SITE')
    expect(out).not.toContain('GONE-LINK')
    expect(out).not.toContain('<header')
  })

  it('MC-28 <header> 里有 601 字段落、没有 h1：留着', async () => {
    const out = await cleaned(
      doc(`<header><span>KEEP-HDR</span>${P(601, 'e')}</header>${NAV}${MAIN}`)
    )
    expect(out).toContain('KEEP-HDR')
    expect(out).toContain('e'.repeat(601))
  })
})

describe('aside', () => {
  it('MC-29 正文外的短 aside（没有链接）：删', async () => {
    const out = await cleaned(doc(`<aside><span>GONE-ASIDE</span></aside>${MAIN}`))
    expect(out).not.toContain('GONE-ASIDE')
  })

  it('MC-31 文章里的提示框（只有一个短链接）：留着', async () => {
    const out = await cleaned(
      doc(
        `${NAV}<article>${P(300)}<aside><span>KEEP-NOTE-remember-to-check-the-settings-first</span> <a href="/s">see</a></aside></article>`
      )
    )
    expect(out).toContain('KEEP-NOTE')
  })

  it('MC-32 文章里的相关链接列表（链接文字过半）：删', async () => {
    const out = await cleaned(
      doc(
        `<article><h2>KEEP-ART</h2>${P(300)}<aside><ul><li><a href="/1">GONE-REL-1</a></li><li><a href="/2">GONE-REL-2</a></li></ul></aside></article>`
      )
    )
    expect(out).not.toContain('GONE-REL-1')
    expect(out).not.toContain('GONE-REL-2')
    expect(out).toContain('KEEP-ART')
  })

  it('MC-33 边界（文章里）：链接文字恰好 50% → 删', async () => {
    const out = await cleaned(
      doc(
        `<article><h2>KEEP-ART</h2>${P(300)}<aside><span>${'q'.repeat(10)}</span><a href="/z">${'z'.repeat(10)}</a></aside></article>`
      )
    )
    expect(out).not.toContain('z'.repeat(10))
    expect(out).not.toContain('<aside')
  })

  it('MC-33 边界（文章里）：链接文字 49% → 留着', async () => {
    const out = await cleaned(
      doc(
        `${NAV}<article><h2>KEEP-ART</h2>${P(300)}<aside><span>${'q'.repeat(51)}</span><a href="/z">${'z'.repeat(49)}</a></aside></article>`
      )
    )
    expect(out).toContain('z'.repeat(49))
    expect(out).toContain('q'.repeat(51))
  })

  it('MC-35 正文外的 aside 里有 601 字段落：留着', async () => {
    const out = await cleaned(
      doc(`<aside><span>KEEP-ASIDE</span>${P(601, 's')}</aside>${NAV}${MAIN}`)
    )
    expect(out).toContain('KEEP-ASIDE')
    expect(out).toContain('s'.repeat(601))
  })
})

describe('cookie 横幅', () => {
  const IDS = [
    'onetrust-consent-sdk',
    'onetrust-banner-sdk',
    'CybotCookiebotDialog',
    'cookie-law-info-bar'
  ]

  it.each(IDS)('MC-36 #%s：删', async (id) => {
    const out = await cleaned(doc(`<div id="${id}"><span>GONE-COOKIE</span> Accept</div>${MAIN}`))
    expect(out).not.toContain('GONE-COOKIE')
    expect(out).not.toContain(id)
  })

  it('MC-37 cookie 横幅里有 700 字段落也删', async () => {
    const out = await cleaned(
      doc(
        `<div id="onetrust-consent-sdk"><span>GONE-C</span>${P(700, 'c')}</div><main>${P(3000, 'm')}</main>`
      )
    )
    expect(out).not.toContain('GONE-C')
    expect(out).not.toContain('c'.repeat(700))
    expect(out).toContain('m'.repeat(3000))
  })

  it('MC-38a 不按 class / id 名字猜：都留着 → null', async () => {
    const html = doc(
      `<div class="nav sidebar footer header menu">KEEP-1</div><div id="sidebar">KEEP-2</div><ul class="navigation"><li><a href="/a">KEEP-3</a></li></ul>${MAIN}`
    )
    expect(await cleanMainContent(html)).toBeNull()
  })

  it('MC-38b 名字里带 cookie 的标题锚点、正文段：留着', async () => {
    const out = await cleaned(
      doc(
        `${NAV}<main><h2 id="what-is-cookie-consent">KEEP-H</h2><section class="cookie-banner-guide">KEEP-S how consent banners work</section>${P(300)}</main>`
      )
    )
    expect(out).toContain('KEEP-H')
    expect(out).toContain('KEEP-S')
    expect(out).not.toContain('GONE-NAV')
  })
})

describe('范围：只看 body 里面', () => {
  it('MC-39 没有家具的页面 → null', async () => {
    expect(await cleanMainContent(doc(MAIN))).toBeNull()
  })

  it('MC-40 <body role=dialog hidden aria-hidden> 自己不删 → null', async () => {
    const html = `<!doctype html><html><head><title>T</title></head><body role="dialog" hidden aria-hidden="true">${P(100)}</body></html>`
    expect(await cleanMainContent(html)).toBeNull()
  })

  it('MC-40b <html class="cookie-banner-open" hidden>：html 不删，nav 照删，正文还在', async () => {
    const out = await cleaned(doc(NAV + MAIN, '', ' class="cookie-banner-open" hidden'))
    expect(out).not.toContain('GONE-NAV')
    expect(out).toContain('KEEP-MAIN')
    expect(out).toContain('m'.repeat(300))
  })

  it('MC-40c 只有 head 里有「家具」（noscript）→ null', async () => {
    const html = doc(MAIN, '<noscript><style>.x{display:none}</style></noscript>')
    expect(await cleanMainContent(html)).toBeNull()
  })
})

describe('安全网', () => {
  it('MC-41 段落共 1000 字，401 在 nav 里（删完不到六成）→ null', async () => {
    const html = doc(`<nav>${P(401, 'n')}</nav><main>${P(599, 'm')}</main>`)
    expect(await cleanMainContent(html)).toBeNull()
  })

  it('MC-42 段落共 1000 字，400 在 nav 里（恰好六成）→ 清理', async () => {
    const out = await cleaned(doc(`<nav>${P(400, 'n')}</nav><main>${P(600, 'm')}</main>`))
    expect(out).not.toContain('n'.repeat(400))
  })

  it('MC-43 段落恰好 400 字：段落安全网不管 → 清理', async () => {
    const out = await cleaned(
      doc(`<nav>${P(300, 'n')}</nav><main>${P(100, 'm')}</main><div>${'d'.repeat(300)}</div>`)
    )
    expect(out).not.toContain('n'.repeat(300))
  })

  it('MC-43 段落 401 字（301 在 nav 里）→ null', async () => {
    const html = doc(
      `<nav>${P(301, 'n')}</nav><main>${P(100, 'm')}</main><div>${'d'.repeat(300)}</div>`
    )
    expect(await cleanMainContent(html)).toBeNull()
  })

  it('MC-44 全页文字：100 字里 76 在 nav → null；75 → 清理', async () => {
    expect(
      await cleanMainContent(
        doc(`<nav><span>${'n'.repeat(76)}</span></nav><div>${'d'.repeat(24)}</div>`)
      )
    ).toBeNull()
    const out = await cleaned(
      doc(`<nav><span>${'n'.repeat(75)}</span></nav><div>${'d'.repeat(25)}</div>`)
    )
    expect(out).not.toContain('n'.repeat(75))
  })

  it('MC-44b body 里的大段 script 不算可见文字：撑不住全页文字安全网 → null', async () => {
    const html = doc(
      `<nav><span>${'n'.repeat(400)}</span></nav><div>${'d'.repeat(50)}</div><script type="application/json">{"a":"${'j'.repeat(5000)}"}</script>`
    )
    expect(await cleanMainContent(html)).toBeNull()
  })

  it('MC-45 aria-hidden 的 <main> 占了大部分文字 → null', async () => {
    const html = doc(
      `<main aria-hidden="true"><h2>KEEP-MAIN</h2>${P(300, 'm')}</main><div>small</div>`
    )
    expect(await cleanMainContent(html)).toBeNull()
  })

  it('MC-46 大小上限：多一个字符 → null；恰好上限 → 清理', { timeout: 120_000 }, async () => {
    const base = doc(NAV + MAIN, '<!---->')
    const padTo = (total: number): string => {
      const html = base.replace('<!---->', `<!--${'c'.repeat(total - base.length)}-->`)
      expect(html.length).toBe(total)
      return html
    }
    expect(await cleanMainContent(padTo(MAIN_CONTENT_MAX_HTML_CHARS + 1))).toBeNull()
    const out = await cleaned(padTo(MAIN_CONTENT_MAX_HTML_CHARS))
    expect(out).not.toContain('GONE-NAV')
    expect(out).toContain('KEEP-MAIN')
  })

  it('MC-47 输出保留 doctype、<title> 和正文的标记', async () => {
    const main = `<main><h2>KEEP-MAIN</h2><p>${'m'.repeat(300)}</p><p>see <a href="https://example.test/x">a link</a></p></main>`
    const out = await cleaned(doc(NAV + main))
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(out).toContain('<title>T</title>')
    expect(out).toContain(main)
  })

  it('MC-48 不合法的 CSS 不往 console.error 写', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await cleaned(doc(NAV + MAIN, '<style>.a { color: ; }} @@@ { ;;</style>'))
    expect(out).toContain('KEEP-MAIN')
    expect(error).not.toHaveBeenCalled()
  })
})
