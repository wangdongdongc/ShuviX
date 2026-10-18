/**
 * svgSanitize 单测 —— 覆盖不依赖 DOM 的那半：URL 协议白名单、`url()` 取值判定、两档名单本身。
 *
 * DOM 那半在 `svgSanitize.dom.test.ts`，该文件在头部用 vitest 的环境指令切到 jsdom。
 * **本文件的头注释里不能出现那条指令的字面串** —— vitest 解析的是文件首个注释块，
 * 一句「见隔壁那行 xxx」会把本文件也切进 jsdom，于是下面那条「node 环境没有 DOMParser」
 * 的断言直接红（正是它把这次事故当场拦下的）。
 *
 * 更正一则旧诊断：这里原先写着「切到 jsdom 时 Vite 的 /@fs/ URL 在含空格的仓库路径下
 * 解析不了，属本机路径怪癖」。**那个归因是错的。** 真正的原因是测试文件位于 vitest root
 * （`apps/desktop`）之外，被 Vite 的 fs 守卫挡掉 —— node 环境不按 /@fs/ URL 取模，所以
 * 只有 jsdom 会炸。`apps/desktop/vitest.config.ts` 里加一行
 * `server.fs.allow` 指向仓库根即可，packages/** 下的 jsdom 用例随之可跑（已实测）。
 *
 * ⚠️ 写 DOM 用例时的硬约束：**每条「某东西被剥掉」的断言都要同时断言「该留的还在」**。
 * 在 node 环境下 `sanitizeXxx()` 一律返回 ''（失败关闭），于是所有 not.toContain(...) 会
 * 全部空转变绿 —— 一个放错环境的文件会伪装成一整套安全门。
 */

import { describe, it, expect } from 'vitest'
import {
  sanitizeRenderedSvg,
  isSafeSvgUrl,
  urlFunctionsAreFragmentOnly,
  SVG_SANITIZE_TIERS,
  SVG_MAX_LENGTH
} from './svgSanitize'

// ─────────────────────────── URL 语料 ───────────────────────────
//
// 一份语料，三种用法：两档各自的期望表（下面三组按档位分组），以及不写任何期望输出的
// 纯蕴含不变式（URL_CORPUS）。分组即期望 —— 断言从组名来，不从每条字符串旁边抄一遍。

/** 两档都放行：空串、片段引用、data: 位图（含大写协议 —— 判定前先小写） */
const BOTH_ALLOW = [
  '',
  '#id',
  '#arrowhead', // mermaid 的 marker / use 引用大量使用片段
  'data:image/png;base64,iVBORw0KGgo=',
  'data:image/jpeg;base64,/9j/4AA=',
  'data:image/jpg;base64,/9j/4AA=',
  'data:image/gif;base64,R0lGOD=',
  'data:image/webp;base64,UklGRg=',
  'data:image/bmp;base64,Qk0=',
  'DATA:IMAGE/PNG;base64,iVBORw0KGgo='
]

/** 两档都拒：可执行协议、控制字符混淆、能携带脚本的 svg+xml、缺分号的伪 data: */
const BOTH_REJECT = [
  'data:image/svg+xml;base64,PHN2Zz4=',
  'data:image/svg+xml,<svg/>',
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'JAVASCRIPT:alert(1)',
  'vbscript:x',
  'data:text/html,<script>alert(1)</script>',
  // 浏览器解析 URL 时会先剔除这些字符再判定协议，按原样比对就会漏掉
  'java\nscript:alert(1)',
  'java\tscript:alert(1)',
  'java\rscript:alert(1)',
  'java script:alert(1)',
  ' javascript:alert(1)',
  '\x01javascript:alert(1)',
  // 无分号 → 不匹配 data: 位图白名单；协议 data: 也不在 http/https/mailto 里
  'data:image/png,raw'
]

/**
 * mermaid 档放行 / 手写档拒 —— 差异的全部内容就是「这个地址会不会发起一次真实请求」。
 * 相对 URL 也算：渲染进程的 base 是应用自身，一个相对路径同样是一次本地资源请求。
 */
const RENDERED_ONLY = [
  'http://x.com',
  'https://x.com',
  'mailto:a@b.c',
  'foo.png',
  '/a/b',
  './a',
  '../a',
  '//evil.com/x' // 协议相对：无协议 = 相对 URL，mermaid 档按相对放行
]

/** 纯蕴含不变式的语料：上面三组 + 几条怪写法（不写期望输出，只断言两档的偏序） */
const URL_CORPUS = [
  ...BOTH_ALLOW,
  ...BOTH_REJECT,
  ...RENDERED_ONLY,
  '#',
  'data:',
  'data:image/png',
  'DATA:IMAGE/SVG+XML;base64,PHN2Zz4=',
  'HTTP://X.COM',
  'h\x00ttp://x.com',
  '\\75 rl(#g)',
  'url(#g)',
  'blob:https://x/y',
  'file:///etc/passwd',
  'about:blank',
  'tel:+1',
  '?q=1',
  '   ',
  'x:y'
]

describe('isSafeSvgUrl', () => {
  it.each(BOTH_ALLOW)('两档都放行：%j', (u) => {
    expect(isSafeSvgUrl(u)).toBe(true)
    expect(isSafeSvgUrl(u, { localOnly: true })).toBe(true)
  })

  it.each(BOTH_REJECT)('两档都拒：%j', (u) => {
    expect(isSafeSvgUrl(u)).toBe(false)
    expect(isSafeSvgUrl(u, { localOnly: true })).toBe(false)
  })

  it.each(RENDERED_ONLY)('会发起请求的地址：mermaid 档放行、手写档拒 —— %j', (u) => {
    expect(isSafeSvgUrl(u)).toBe(true)
    expect(isSafeSvgUrl(u, { localOnly: true })).toBe(false)
  })
})

describe('urlFunctionsAreFragmentOnly', () => {
  /** 放行：属性值里每一个 url( 都是片段引用（渐变/遮罩的正常写法），或根本没有 url( */
  const FRAGMENT_ONLY = [
    'url(#g)',
    "url( '#g' )",
    'url("#g")',
    'URL(#g)',
    'Url(  #g  )',
    'url(#a) url(#b)',
    'fill:url(#a);stroke:var(--viz-1);opacity:.5',
    'M0 0 L10 10',
    'var(--viz-1)',
    '',
    'translate(4,4) scale(2)'
  ]

  /** 拒绝：任何会发起请求的 url()、残缺的 url(，以及**任何含反斜杠的值** */
  const NOT_FRAGMENT_ONLY = [
    'url(https://x)',
    'url("https://x")',
    "url('https://x')",
    'url(//x)',
    'url(/a/b)',
    'url(data:image/png;base64,AAA)',
    'url(https:', // 不闭合：判定按正向要求写，残缺形式因此落在拒绝一侧
    'url(',
    'url()',
    'fill:url(#a);stroke:url(https://x)', // 合法 + 非法混排
    // CSS 的函数名是 ident-token，允许转义：这三种写法经「consume an escaped code point」
    // 后都还是 url(，字面量查找一个都看不见（真实 Chromium 里实测都发出了请求）。
    // 一刀切成「出现反斜杠即判危」，砍掉的是整个转义类而不是已知的几个样本。
    '\\75 rl(#g)',
    '\\000075rl(#g)',
    'u\\72 l(#g)',
    // 合法写法不需要反斜杠，所以连「看着无害」的也拒
    'fill:\\23 g',
    'M0 0 \\',
    'url(#g)\\'
  ]

  it.each(FRAGMENT_ONLY)('放行：%j', (v) => {
    expect(urlFunctionsAreFragmentOnly(v)).toBe(true)
  })

  it.each(NOT_FRAGMENT_ONLY)('拒绝：%j', (v) => {
    expect(urlFunctionsAreFragmentOnly(v)).toBe(false)
  })
})

/**
 * 不变式第 1 层（纯函数半）—— 「手写档严格强于 mermaid 档」写成**蕴含**，不写任何期望输出。
 *
 * 为什么必须是这种形式：靠一批样本的期望表断言这条不变式，会随白名单演进腐烂成空转门
 * （语料没覆盖到的地方它照样绿）。蕴含式不关心某条地址该不该放行 —— 它只钉两档的偏序，
 * 语料越怪越好。
 */
describe('两档偏序不变式（URL 语料）', () => {
  it.each(URL_CORPUS)('localOnly 放行 ⇒ 无 localOnly 也放行：%j', (u) => {
    if (isSafeSvgUrl(u, { localOnly: true })) expect(isSafeSvgUrl(u)).toBe(true)
  })
})

/**
 * 不变式第 3 层 —— 直接对**名单本身**断言。
 *
 * 这是唯一不可能空转的形式：往 FORBIDDEN_TAGS 加标签自动两档生效（差集不变），
 * 往 AUTHORED_FORBIDDEN_TAGS 加一条则必须回来改这条用例 —— 强制写下理由。
 */
describe('SVG_SANITIZE_TIERS', () => {
  const rendered = SVG_SANITIZE_TIERS.forbiddenTags
  const authored = new Set([...rendered, ...SVG_SANITIZE_TIERS.authoredExtraTags])

  it('手写档的有效名单 ⊇ mermaid 档的名单', () => {
    for (const tag of rendered) expect(authored.has(tag)).toBe(true)
  })

  it('两档差集恰为 {style, foreignobject} —— 手写档多关的就这两个标签', () => {
    const extra = [...authored].filter((tag) => !rendered.has(tag)).sort()
    expect(extra).toEqual(['foreignobject', 'style'])
  })

  it('名单全小写：判定用 nodeName.toLowerCase() 比对，大写项等于一条永不命中的规则', () => {
    for (const set of [rendered, SVG_SANITIZE_TIERS.authoredExtraTags]) {
      for (const tag of set) expect(tag).toBe(tag.toLowerCase())
    }
  })

  it('URL 属性表覆盖名字就是地址的那批，且同样全小写', () => {
    for (const name of ['href', 'xlink:href', 'src']) {
      expect(SVG_SANITIZE_TIERS.urlAttributes.has(name)).toBe(true)
    }
    for (const name of SVG_SANITIZE_TIERS.urlAttributes) expect(name).toBe(name.toLowerCase())
  })
})

describe('sanitizeRenderedSvg', () => {
  it('returns empty for empty input', () => {
    expect(sanitizeRenderedSvg('')).toBe('')
  })

  it('fails closed when no DOM parser is available', () => {
    // node 环境没有 DOMParser —— 契约是「宁可不出图，也不放行未经检查的标记」。
    // 这同时是生产侧的兜底分支（理论不可达：调用方都在渲染端）。
    expect(typeof DOMParser).toBe('undefined')
    expect(sanitizeRenderedSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toBe('')
  })
})

describe('SVG_MAX_LENGTH', () => {
  it('SS-L1 导出的长度上限 = 256KB（mermaid 的 outputLimit 对齐它，见 mermaidFence）', () => {
    expect(SVG_MAX_LENGTH).toBe(262144)
  })
})
