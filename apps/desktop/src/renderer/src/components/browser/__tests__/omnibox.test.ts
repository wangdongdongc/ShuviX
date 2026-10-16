/**
 * 地址栏（omnibox.ts）的纯函数：输入 → 要打开的地址，设置值 → 搜索引擎，地址 → 未聚焦时的显示。
 *
 *   CB-U7   带 http(s) / file 协议、about: / data: / view-source: 的原样打开（只去首尾空白）；
 *   CB-U8   有空白的是搜索词；
 *   CB-U9   localhost / *.localhost / IPv4 / [IPv6]（可带端口、路径）补 http://；
 *   CB-U10  像域名的（含国际化域名、大写）补 https://；
 *   CB-U11  其余（单个词、javascript:、mailto:、不像域名的、端口越界的）交给搜索引擎；空串 → null；
 *   CB-U12  四个搜索引擎的结果页地址与搜索词的编码（`$&` 不被当成替换模式）；
 *   CB-U13  设置值 → 搜索引擎：只认四个自有键，其余一律缺省 google；
 *   CB-U14  未聚焦时的显示：https / http / file / 其余。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEARCH_ENGINE,
  resolveOmniboxInput,
  SEARCH_ENGINES,
  searchEngineOf,
  searchUrl,
  urlDisplayOf
} from '../omnibox'

const google = (q: string): string => `https://www.google.com/search?q=${encodeURIComponent(q)}`

describe('原样打开（CB-U7）', () => {
  it.each([
    'https://a.b/c',
    'HTTP://X.COM',
    'file:///tmp/a.html',
    'file:///tmp/a b.html',
    'about:blank',
    'view-source:https://x.test/',
    'data:text/html,<p>two words</p>'
  ])('CB-U7 %s', (input) => {
    expect(resolveOmniboxInput(input, 'google')).toBe(input)
    expect(resolveOmniboxInput(`  ${input}\t`, 'google')).toBe(input)
  })
})

describe('有空白 → 搜索（CB-U8）', () => {
  it('CB-U8 hello world → Google 搜索（空格编码成 %20）', () => {
    expect(resolveOmniboxInput('hello world', 'google')).toBe(
      'https://www.google.com/search?q=hello%20world'
    )
  })

  it('CB-U8 像域名但带空白（example.com/a b）→ 搜索', () => {
    expect(resolveOmniboxInput('example.com/a b', 'google')).toBe(google('example.com/a b'))
  })
})

describe('补 http://（CB-U9）', () => {
  it.each([
    'localhost',
    'localhost:3000/x?y#z',
    'app.localhost:5173',
    '127.0.0.1',
    '192.168.1.1:8080/a',
    '255.255.255.255',
    '[::1]',
    '[::1]:5173/x'
  ])('CB-U9 %s', (input) => {
    expect(resolveOmniboxInput(input, 'google')).toBe(`http://${input}`)
  })
})

describe('补 https://（CB-U10）', () => {
  it.each([
    'example.com',
    'Example.COM',
    'example.com:8080/a',
    'sub.example.co.uk',
    'münchen.de',
    '例子.中国',
    'example.com?q=1'
  ])('CB-U10 %s', (input) => {
    expect(resolveOmniboxInput(input, 'google')).toBe(`https://${input}`)
  })
})

describe('其余 → 搜索；空 → null（CB-U11）', () => {
  it.each([
    'foo',
    'javascript:alert(1)',
    'mailto:a@b.c',
    'example.c',
    '1.2.3',
    '999.1.1.1',
    'user@example.com',
    'example.com:0',
    'example.com:65536'
  ])('CB-U11 %s → 搜索', (input) => {
    expect(resolveOmniboxInput(input, 'google')).toBe(google(input))
  })

  it.each(['', '   ', '\t\n'])('CB-U11 %j → null（不导航）', (input) => {
    expect(resolveOmniboxInput(input, 'google')).toBeNull()
    expect(resolveOmniboxInput(input, 'bing')).toBeNull()
  })

  it('CB-U11 搜索用的是传进来的那个引擎', () => {
    expect(resolveOmniboxInput('foo', 'baidu')).toBe('https://www.baidu.com/s?wd=foo')
    expect(resolveOmniboxInput('hello world', 'duckduckgo')).toBe(
      'https://duckduckgo.com/?q=hello%20world'
    )
  })
})

describe('搜索结果页地址（CB-U12）', () => {
  it.each([
    ['google', 'https://www.google.com/search?q='],
    ['bing', 'https://www.bing.com/search?q='],
    ['baidu', 'https://www.baidu.com/s?wd='],
    ['duckduckgo', 'https://duckduckgo.com/?q=']
  ] as const)('CB-U12 %s', (engine, prefix) => {
    expect(searchUrl('a b', engine)).toBe(`${prefix}a%20b`)
    expect(searchUrl('c++', engine)).toBe(`${prefix}c%2B%2B`)
    // `$&` 在 String.replace 的替换串里是「整段匹配」—— 搜索词里的它必须原样（编码后）出现
    expect(searchUrl('x $& y', engine)).toBe(`${prefix}x%20%24%26%20y`)
    expect(searchUrl('天气 北京', engine)).toBe(`${prefix}${encodeURIComponent('天气 北京')}`)
  })

  it('CB-U12 品牌名不翻译', () => {
    expect(
      Object.fromEntries(Object.entries(SEARCH_ENGINES).map(([id, e]) => [id, e.name]))
    ).toEqual({ google: 'Google', bing: 'Bing', baidu: '百度', duckduckgo: 'DuckDuckGo' })
  })
})

describe('设置值 → 搜索引擎（CB-U13）', () => {
  it.each(['google', 'bing', 'baidu', 'duckduckgo'] as const)('CB-U13 %s → 它自己', (id) => {
    expect(searchEngineOf(id)).toBe(id)
  })

  it.each([
    undefined,
    null,
    '',
    'yahoo',
    'GOOGLE',
    'toString',
    'constructor',
    '__proto__',
    'hasOwnProperty'
  ])('CB-U13 %j → google', (value) => {
    expect(searchEngineOf(value)).toBe('google')
  })

  it('CB-U13 缺省就是 google', () => {
    expect(DEFAULT_SEARCH_ENGINE).toBe('google')
  })
})

describe('未聚焦时的显示（CB-U14）', () => {
  it('CB-U14 https 根路径 → secure，host，rest 为空', () => {
    expect(urlDisplayOf('https://example.com')).toStrictEqual({
      kind: 'secure',
      host: 'example.com',
      rest: ''
    })
    expect(urlDisplayOf('https://example.com/')).toStrictEqual({
      kind: 'secure',
      host: 'example.com',
      rest: ''
    })
  })

  it('CB-U14 端口进 host，路径 / 查询 / 片段进 rest', () => {
    expect(urlDisplayOf('https://example.com:8443/a/b?c=1#d')).toStrictEqual({
      kind: 'secure',
      host: 'example.com:8443',
      rest: '/a/b?c=1#d'
    })
  })

  it('CB-U14 根路径带查询：rest 只有查询', () => {
    expect(urlDisplayOf('https://example.com/?q=1')).toStrictEqual({
      kind: 'secure',
      host: 'example.com',
      rest: '?q=1'
    })
  })

  it('CB-U14 地址里的账号密码不显示', () => {
    const d = urlDisplayOf('https://user:secret@example.com/x')
    expect(d).toStrictEqual({ kind: 'secure', host: 'example.com', rest: '/x' })
    expect(JSON.stringify(d)).not.toContain('secret')
    expect(JSON.stringify(d)).not.toContain('user')
  })

  it('CB-U14 http → insecure', () => {
    expect(urlDisplayOf('http://127.0.0.1:3000/p?x=1')).toStrictEqual({
      kind: 'insecure',
      host: '127.0.0.1:3000',
      rest: '/p?x=1'
    })
  })

  it('CB-U14 file: → local，路径解码', () => {
    expect(urlDisplayOf('file:///Users/me/My%20Doc.html')).toStrictEqual({
      kind: 'local',
      host: '',
      rest: '/Users/me/My Doc.html'
    })
  })

  it.each(['about:blank', 'data:text/html,<p>x</p>', 'not a url', ''])(
    'CB-U14 %j → other，原样',
    (url) => {
      expect(urlDisplayOf(url)).toStrictEqual({ kind: 'other', host: '', rest: url })
    }
  )
})
