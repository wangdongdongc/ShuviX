/**
 * 内置浏览器历史记录的纯函数（shared/browserHistory.ts）—— 记什么、地址栏里怎么显示、怎么打分、怎么内联补全。
 *
 *   BH-1   historyUrlOf：网页按 URL 规范化（协议 / 主机小写、缺省端口去掉、根路径补 /）；非缺省端口、查询、
 *          hash 原样；本地文件原样
 *   BH-2   网址里的用户名密码去掉（不落盘）
 *   BH-3   不记的回 null：about: / data: / blob: / view-source: / shuvix:// / javascript: / chrome:// / mailto: /
 *          空串 / 不是地址
 *   BH-4   长度上限：恰好 8192 字记、8193 字不记
 *   BH-5   inPageVisitCounts：只改锚点不算（含加 / 去锚点、hash 路由换成锚点）；hash 路由（#/ 与 #!/）、
 *          锚点换成 hash 路由、路径 / 查询 / 源变了算；认不出的地址按字符串是否相同
 *   BH-6   displayUrlOf：去协议与开头的 www.（不分大小写；wwwx.com 不动）；只有根路径且没有查询 / hash 时去掉
 *          那个 /；端口留着；路径里的转义还原（坏的转义原样）；file: 解码；认不出的原样
 *   BH-7   historyQueryWords：小写、按空白（含 tab / 换行 / 全角空格）切、去空
 *   BH-8   historyMatchScore 为 0：访问次数 0、没有词、有一个词网址和标题里都没有
 *   BH-9   匹配度三档 4 : 2 : 1（网址开头 / 词首 / 只是包含），多个词不走网址开头那一档
 *   BH-10  网址开头那一档认三种写法：省略过的、去协议的、完整的；不分大小写
 *   BH-11  汉字 / 假名：包含就算词首
 *   BH-12  常去度：敲过 1 次 ≡ 访问 6 次；访问次数封顶 30；最近访问分六档；只有根路径的 ×1.2（带查询的不算）
 *   BH-13  rankHistory：去掉 0 分、按分数降序、同分按最近访问、limit
 *   BH-14  内联补全：输入还在主机名里 → 补到站点首页；敲过 / 访问 4 次以上才补；file: 不补
 *   BH-15  不补：空串、带空白、输入就是整个主机名、不是开头
 *   BH-16  带 / 的补到整条网址；根网址只差一个 / 不补；带协议的输入、www.、大小写；http 输入对 https 网址不补
 *   BH-17  几个候选：分数高的赢、同分取补得短的；中文路径按还原后的字补、网址仍是转义的
 */
import { describe, expect, it } from 'vitest'
import {
  displayUrlOf,
  historyMatchScore,
  historyQueryWords,
  historyUrlOf,
  inPageVisitCounts,
  inlineCompletionFor,
  rankHistory,
  type HistorySuggestion,
  type HistoryUrlRecord
} from '../browserHistory'

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0)
const DAY = 86_400_000

/** 一条历史网址（缺省：访问 1 次、没敲过、刚访问过） */
function row(url: string, over: Partial<HistoryUrlRecord> = {}): HistoryUrlRecord {
  return { url, title: '', favicon: '', visitCount: 1, typedCount: 0, lastVisitAt: NOW, ...over }
}

/** 一条已打分的候选（内联补全吃的是 rankHistory 的结果） */
function scored(url: string, over: Partial<HistoryUrlRecord> = {}, score = 10): HistorySuggestion {
  return { ...row(url, over), score }
}

const score = (input: string, r: HistoryUrlRecord, now = NOW): number =>
  historyMatchScore(input, r, now)

describe('historyUrlOf（BH-1 ~ BH-4）', () => {
  it('BH-1 网页规范化：协议 / 主机小写、443 去掉、根路径补 /', () => {
    expect(historyUrlOf('HTTPS://Example.COM:443')).toBe('https://example.com/')
  })

  it('BH-1 非缺省端口、查询、hash 原样', () => {
    expect(historyUrlOf('http://a.com:8080/x?y#z')).toBe('http://a.com:8080/x?y#z')
  })

  it('BH-1 本地文件原样（转义留着）', () => {
    expect(historyUrlOf('file:///Users/x/a%20b.md')).toBe('file:///Users/x/a%20b.md')
  })

  it('BH-2 用户名密码去掉：user:pw@ 与只有 user@', () => {
    expect(historyUrlOf('https://user:pw@a.com/p')).toBe('https://a.com/p')
    expect(historyUrlOf('https://user@a.com/')).toBe('https://a.com/')
  })

  it.each([
    'about:blank',
    'data:text/html,x',
    'blob:https://a.com/u',
    'view-source:https://a.com',
    'shuvix://history',
    'javascript:x',
    'chrome://settings',
    'mailto:a@b',
    '',
    'not a url'
  ])('BH-3 %j → null', (url) => {
    expect(historyUrlOf(url)).toBeNull()
  })

  it('BH-4 恰好 8192 字：记下（原样）；8193 字：null', () => {
    const base = 'https://a.com/'
    const exact = base + 'x'.repeat(8192 - base.length)
    expect(exact).toHaveLength(8192)
    expect(historyUrlOf(exact)).toBe(exact)
    expect(historyUrlOf(exact + 'x')).toBeNull()
  })
})

describe('inPageVisitCounts（BH-5）', () => {
  const D = 'https://a.com/doc'
  it.each([
    ['#a → #b', `${D}#a`, `${D}#b`],
    ['同一个地址', `${D}#a`, `${D}#a`],
    ['加锚点', D, `${D}#install`],
    ['去锚点', `${D}#install`, D],
    ['hash 路由换成锚点', `${D}#/x`, `${D}#top`]
  ])('BH-5 %s → 不算', (_l, prev, next) => {
    expect(inPageVisitCounts(prev, next)).toBe(false)
  })

  it.each([
    ['#/a → #/b', `${D}#/a`, `${D}#/b`],
    ['#!/a → #!/b', `${D}#!/a`, `${D}#!/b`],
    ['锚点换成 hash 路由', `${D}#a`, `${D}#/x`],
    ['路径变了', D, 'https://a.com/other'],
    ['查询变了', D, `${D}?page=2`],
    ['源变了', D, 'https://b.com/doc']
  ])('BH-5 %s → 算', (_l, prev, next) => {
    expect(inPageVisitCounts(prev, next)).toBe(true)
  })

  it('BH-5 认不出的地址：按字符串是否相同', () => {
    expect(inPageVisitCounts('garbage', 'garbage')).toBe(false)
    expect(inPageVisitCounts('garbage', 'other garbage')).toBe(true)
    expect(inPageVisitCounts(D, 'garbage')).toBe(true)
  })
})

describe('displayUrlOf（BH-6）', () => {
  it.each([
    ['https://www.github.com/', 'github.com'],
    ['HTTPS://WWW.Example.COM/', 'example.com'],
    ['http://www.a.com/x', 'a.com/x'],
    ['https://wwwx.com/', 'wwwx.com'],
    ['https://a.com/', 'a.com'],
    ['https://a.com/?q=1', 'a.com/?q=1'],
    ['https://a.com/#x', 'a.com/#x'],
    ['http://a.com:8080/', 'a.com:8080'],
    ['http://a.com:8080/p?q#h', 'a.com:8080/p?q#h'],
    ['https://zh.wikipedia.org/wiki/%E5%8C%97%E4%BA%AC', 'zh.wikipedia.org/wiki/北京'],
    ['https://a.com/%E4%B8', 'a.com/%E4%B8'],
    ['file:///Users/x/a%20b.md', 'file:///Users/x/a b.md'],
    ['not a url', 'not a url']
  ])('BH-6 %s → %s', (url, shown) => {
    expect(displayUrlOf(url)).toBe(shown)
  })
})

describe('historyQueryWords（BH-7）', () => {
  it('BH-7 小写、按空白切（tab / 换行 / 全角空格）、去空', () => {
    expect(historyQueryWords('  GitHub\tDocs\nFoo　Bar  ')).toEqual([
      'github',
      'docs',
      'foo',
      'bar'
    ])
  })

  it.each(['', '   ', '\t\n　'])('BH-7 %j → []', (input) => {
    expect(historyQueryWords(input)).toEqual([])
  })
})

describe('historyMatchScore 的 0 分（BH-8）', () => {
  const r = row('https://github.com/x', { title: 'GitHub Docs' })

  it('BH-8 访问次数 0（只有 agent 去过）→ 0，哪怕网址从开头对得上', () => {
    expect(score('git', { ...r, visitCount: 0, typedCount: 3 })).toBe(0)
  })

  it('BH-8 没有词 → 0', () => {
    expect(score('', r)).toBe(0)
    expect(score('   ', r)).toBe(0)
  })

  it('BH-8 有一个词网址和标题里都没有 → 0', () => {
    expect(score('gitlab', r)).toBe(0)
    expect(score('github nope', r)).toBe(0)
  })
})

describe('匹配度的三档（BH-9 ~ BH-11）', () => {
  const r = row('https://github.com/x', { title: 'GitHub Docs' })

  it('BH-9 git（网址开头）: docs（标题词首）: hub（只是包含）= 4 : 2 : 1；两个词的 github docs = 2', () => {
    const hub = score('hub', r)
    expect(hub).toBeGreaterThan(0)
    expect(score('git', r) / hub).toBeCloseTo(4)
    expect(score('docs', r) / hub).toBeCloseTo(2)
    expect(score('github docs', r) / hub).toBeCloseTo(2)
  })

  it('BH-10 网址开头那一档：省略过的写法、去协议的写法、完整写法，不分大小写', () => {
    const deep = row('https://github.com/x')
    const tier1 = score('ithub', deep)
    expect(tier1).toBeGreaterThan(0)
    expect(score('github.com/x', deep) / tier1).toBeCloseTo(4)
    expect(score('https://git', deep) / tier1).toBeCloseTo(4)
    expect(score('GIT', deep) / tier1).toBeCloseTo(4)

    // 省略过的写法去掉了 www.：带 www. 的输入靠去协议的那种写法对上
    const www = row('https://www.github.com/')
    const wwwTier1 = score('ithub', www)
    expect(wwwTier1).toBeGreaterThan(0)
    expect(score('www.github', www) / wwwTier1).toBeCloseTo(4)
    expect(score('github', www) / wwwTier1).toBeCloseTo(4)
  })

  it('BH-11 汉字 / 假名包含就算词首：「ニュース」与英文词首同一档；词中间的假名也一样', () => {
    const jp = row('https://example.org/n', { title: '今日のニュース' })
    const en = row('https://example.org/n', { title: 'today news' })
    const asWordStart = score('news', en)
    expect(score('ニュース', jp)).toBeCloseTo(asWordStart)
    expect(score('ュース', jp)).toBeCloseTo(asWordStart)
    // 对照：英文词中间只是「包含」那一档
    expect(score('ews', en) / asWordStart).toBeCloseTo(0.5)
  })
})

describe('常去度（BH-12）', () => {
  const deep = 'https://a.com/x'

  it('BH-12 敲过 1 次 + 访问 1 次 ≡ 没敲过 + 访问 6 次', () => {
    expect(score('a.com', row(deep, { typedCount: 1, visitCount: 1 }))).toBeCloseTo(
      score('a.com', row(deep, { typedCount: 0, visitCount: 6 }))
    )
  })

  it('BH-12 访问次数封顶 30：31 ≡ 300 ≡ 30；29 < 30', () => {
    const at = (visitCount: number): number => score('a.com', row(deep, { visitCount }))
    expect(at(31)).toBeCloseTo(at(300))
    expect(at(31)).toBeCloseTo(at(30))
    expect(at(29)).toBeLessThan(at(30))
  })

  it('BH-12 最近访问六档：<1 天 > <4 天 > <14 天 > <31 天 > <90 天 > ≥90 天（档内不分）', () => {
    const ago = (days: number): number =>
      score('a.com', row(deep, { lastVisitAt: NOW - days * DAY }))
    const buckets = [0.5, 2, 10, 20, 60, 100].map(ago)
    for (let i = 1; i < buckets.length; i++) expect(buckets[i]).toBeLessThan(buckets[i - 1])
    // 档内一样：刚访问 ≡ 23 小时前；恰好 1 天落进下一档
    expect(ago(0)).toBeCloseTo(ago(23 / 24))
    expect(ago(1)).toBeCloseTo(ago(3.9))
    expect(ago(1)).toBeLessThan(ago(0.999))
    expect(ago(90)).toBeCloseTo(ago(400))
  })

  it('BH-12 只有根路径的网址 ×1.2；/?q=1 不算根', () => {
    const page = score('a.com', row(deep))
    expect(score('a.com', row('https://a.com/')) / page).toBeCloseTo(1.2)
    expect(score('a.com', row('https://a.com/?q=1'))).toBeCloseTo(page)
  })
})

describe('rankHistory（BH-13）', () => {
  it('BH-13 去掉 0 分、按分数降序、同分按最近访问降序、只留 limit 条', () => {
    const rows = [
      row('https://other.test/', { title: 'nothing' }),
      row('https://a.com/x', { title: 'Docs about git', lastVisitAt: NOW - 1000 }),
      row('https://git.test/', { typedCount: 2 }),
      row('https://b.com/y', { title: 'Docs about git', lastVisitAt: NOW - 10 }),
      row('https://git.only-agent/', { visitCount: 0 })
    ]
    const ranked = rankHistory('git', rows, NOW, 10)
    expect(ranked.map((r) => r.url)).toEqual([
      'https://git.test/',
      'https://b.com/y',
      'https://a.com/x'
    ])
    expect(ranked.every((r) => r.score > 0)).toBe(true)
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score)
    expect(ranked[1].score).toBeCloseTo(ranked[2].score)
    expect(ranked[0]).toMatchObject({ typedCount: 2, visitCount: 1 })

    expect(rankHistory('git', rows, NOW, 2).map((r) => r.url)).toEqual([
      'https://git.test/',
      'https://b.com/y'
    ])
    expect(rankHistory('git', rows, NOW, 0)).toEqual([])
  })
})

describe('内联补全（BH-14 ~ BH-17）', () => {
  it('BH-14 输入还在主机名里：深一层的页面提升成站点首页（url 是首页，地址栏补到主机名）', () => {
    expect(
      inlineCompletionFor('git', [scored('https://github.com/foo/bar', { typedCount: 1 })])
    ).toEqual({ url: 'https://github.com/', fill: 'github.com' })
  })

  it('BH-14 没敲过：访问 3 次不补，4 次补', () => {
    expect(
      inlineCompletionFor('git', [scored('https://github.com/', { visitCount: 3 })])
    ).toBeNull()
    expect(inlineCompletionFor('git', [scored('https://github.com/', { visitCount: 4 })])).toEqual({
      url: 'https://github.com/',
      fill: 'github.com'
    })
  })

  it('BH-14 file: 的网址不补', () => {
    expect(
      inlineCompletionFor('file:///Users/x/g', [
        scored('file:///Users/x/git.md', { typedCount: 3, visitCount: 9 })
      ])
    ).toBeNull()
  })

  it.each([
    ['空串', ''],
    ['末尾空白', 'git '],
    ['中间空白', 'gi t'],
    ['就是整个主机名', 'github.com'],
    ['不是开头', 'hub']
  ])('BH-15 %s → null', (_l, input) => {
    expect(
      inlineCompletionFor(input, [scored('https://github.com/foo/bar', { typedCount: 1 })])
    ).toBeNull()
  })

  it('BH-16 带 / 的输入补到整条网址，url 是那条网址', () => {
    expect(
      inlineCompletionFor('github.com/fo', [scored('https://github.com/foo', { typedCount: 1 })])
    ).toEqual({ url: 'https://github.com/foo', fill: 'github.com/foo' })
  })

  it('BH-16 github.com/ 而只有根网址：没东西可补 → null', () => {
    expect(
      inlineCompletionFor('github.com/', [scored('https://github.com/', { typedCount: 1 })])
    ).toBeNull()
  })

  it('BH-16 带协议的输入补完整写法；www. 照网址自己的写法；大小写保留用户敲的', () => {
    const gh = [scored('https://github.com/', { typedCount: 1 })]
    expect(inlineCompletionFor('https://git', gh)).toEqual({
      url: 'https://github.com/',
      fill: 'https://github.com'
    })
    expect(
      inlineCompletionFor('www.goo', [scored('https://www.google.com/', { typedCount: 1 })])
    ).toEqual({ url: 'https://www.google.com/', fill: 'www.google.com' })
    expect(inlineCompletionFor('GIT', gh)).toEqual({
      url: 'https://github.com/',
      fill: 'GIThub.com'
    })
  })

  it('BH-16 http:// 的输入对 https 网址 → null', () => {
    expect(
      inlineCompletionFor('http://git', [scored('https://github.com/', { typedCount: 1 })])
    ).toBeNull()
  })

  it('BH-17 分数高的赢；同分取补得短的（与顺序无关）', () => {
    const lab = scored('https://gitlab.com/', { typedCount: 1 }, 20)
    const hub = scored('https://github.com/', { typedCount: 1 }, 10)
    expect(inlineCompletionFor('git', [hub, lab])?.fill).toBe('gitlab.com')
    expect(inlineCompletionFor('git', [lab, hub])?.fill).toBe('gitlab.com')

    const long = scored('https://github.com/', { typedCount: 1 }, 10)
    const short = scored('https://gitx.io/', { typedCount: 1 }, 10)
    expect(inlineCompletionFor('git', [long, short])).toEqual({
      url: 'https://gitx.io/',
      fill: 'gitx.io'
    })
    expect(inlineCompletionFor('git', [short, long])?.fill).toBe('gitx.io')
  })

  it('BH-17 中文路径：按还原后的字补，url 仍是转义的那条', () => {
    const wiki = 'https://zh.wikipedia.org/wiki/%E5%8C%97%E4%BA%AC'
    expect(
      inlineCompletionFor('zh.wikipedia.org/wiki/北', [scored(wiki, { typedCount: 1 })])
    ).toEqual({ url: wiki, fill: 'zh.wikipedia.org/wiki/北京' })
  })
})
