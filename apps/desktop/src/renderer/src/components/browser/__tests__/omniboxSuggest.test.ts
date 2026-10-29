/**
 * 地址栏下拉建议的组合规则（omniboxSuggest.ts 的 buildOmniboxMatches）—— 输入 + 历史 + 搜索建议 + 开着的 tab →
 * 一列建议（最多 8 行）与内联补全。引擎一律 google，「此刻」固定。
 *
 *   OS-1   空 / 全空白 → {matches: [], inline: null}
 *   OS-2   `git`、没有历史 → 只有一行「用 Google 搜 git」（search:git，fill 是敲的字，suggested 假）
 *   OS-3   像网址的输入：第一行打开它（example.org → https://example.org；localhost:3000 → http://），第二行是
 *          「搜这段字」
 *   OS-4   敲过的 github：允许内联时第一行是补出来的站点首页（fill github.com、inline github.com），标题 / 图标
 *          只取同一个网址的那条历史；不允许内联时第一行是搜索
 *   OS-5   开着的 tab：紧跟第一行、最多 2 行「切换到此标签页」；选中的那页、空白页、内部页面不算；每个词都要在
 *          标题或显示的网址里
 *   OS-6   历史网址正开在别的 tab 里 → 那一行变成 tab:<id>；那个 tab 已经有一行了 → 历史那条去掉
 *   OS-7   历史里的 https://example.org/ 与第一行的 https://example.org 是同一个：去掉
 *   OS-8   网址从开头对得上的历史最多 2 行排在搜索前面；第 3 条与只有标题对得上的排在搜索后面
 *   OS-9   搜索建议：只留以输入开头（不分大小写）且不等于输入的；同一条只要一行；搜索行合计最多 4 行（含
 *          「搜这段字」那行）；第一行本来就是搜索时不再补「搜这段字」
 *   OS-10  最多 8 行
 *   OS-11  历史可能是上一段输入的结果：按这段输入重新过滤（对不上的、visitCount 0 的去掉）、重新排
 */
import { describe, expect, it } from 'vitest'
import {
  buildOmniboxMatches,
  type OmniboxSuggestInput,
  type OmniboxTabLike
} from '../omniboxSuggest'
import type { HistorySuggestion } from '../../../../../shared/browserHistory'

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0)
const google = (q: string): string => `https://www.google.com/search?q=${encodeURIComponent(q)}`

function hist(url: string, over: Partial<HistorySuggestion> = {}): HistorySuggestion {
  return {
    url,
    title: '',
    favicon: '',
    visitCount: 1,
    typedCount: 0,
    lastVisitAt: NOW,
    score: 1,
    ...over
  }
}

const tabOf = (id: string, url: string, title = ''): OmniboxTabLike => ({ id, url, title })

function build(
  over: Partial<OmniboxSuggestInput> & { text: string }
): ReturnType<typeof buildOmniboxMatches> {
  return buildOmniboxMatches({
    engine: 'google',
    history: [],
    searchSuggestions: [],
    tabs: [],
    selectedTabId: null,
    allowInline: true,
    now: NOW,
    ...over
  })
}
const keys = (over: Partial<OmniboxSuggestInput> & { text: string }): string[] =>
  build(over).matches.map((m) => m.key)

describe('空输入与只有搜索（OS-1 / OS-2）', () => {
  it.each(['', '   ', '\t'])('OS-1 %j → 没有建议、没有内联', (text) => {
    expect(build({ text, history: [hist('https://github.com/', { typedCount: 3 })] })).toEqual({
      matches: [],
      inline: null
    })
  })

  it('OS-2 git、没有历史 → 只有一行「搜 git」', () => {
    expect(build({ text: 'git' })).toEqual({
      matches: [
        {
          kind: 'search',
          key: 'search:git',
          fill: 'git',
          query: 'git',
          url: google('git'),
          suggested: false
        }
      ],
      inline: null
    })
  })
})

describe('像网址的输入（OS-3）', () => {
  it('OS-3 example.org → 第一行打开 https://example.org，第二行「搜 example.org」', () => {
    const { matches, inline } = build({ text: 'example.org' })
    expect(inline).toBeNull()
    expect(matches).toEqual([
      {
        kind: 'url',
        key: 'url:https://example.org',
        fill: 'example.org',
        url: 'https://example.org'
      },
      {
        kind: 'search',
        key: 'search:example.org',
        fill: 'example.org',
        query: 'example.org',
        url: google('example.org'),
        suggested: false
      }
    ])
  })

  it('OS-3 localhost:3000 → http://localhost:3000', () => {
    const [first] = build({ text: 'localhost:3000' }).matches
    expect(first).toMatchObject({ kind: 'url', url: 'http://localhost:3000' })
  })
})

describe('内联补全的第一行（OS-4）', () => {
  const GH = hist('https://github.com/', {
    typedCount: 1,
    visitCount: 2,
    title: 'GitHub',
    favicon: 'https://github.com/favicon.ico'
  })

  it('OS-4 敲过的 github、允许内联：第一行是站点首页，带同一个网址那条历史的标题 / 图标；那条历史不重复', () => {
    const { matches, inline } = build({ text: 'git', history: [GH] })
    expect(inline).toBe('github.com')
    expect(matches[0]).toEqual({
      kind: 'url',
      key: 'url:https://github.com/',
      fill: 'github.com',
      url: 'https://github.com/',
      title: 'GitHub',
      favicon: 'https://github.com/favicon.ico'
    })
    expect(matches.map((m) => m.key)).not.toContain('history:https://github.com/')
    // 第一行不是搜索：补一行「搜 git」
    expect(matches.map((m) => m.key)).toContain('search:git')
  })

  it('OS-4 补出来的首页不在历史里（敲过的是深一层的页面）：第一行没有标题 / 图标', () => {
    const deep = hist('https://github.com/foo/bar', { typedCount: 1, title: 'Foo' })
    const { matches, inline } = build({ text: 'git', history: [deep] })
    expect(inline).toBe('github.com')
    expect(matches[0]).toEqual({
      kind: 'url',
      key: 'url:https://github.com/',
      fill: 'github.com',
      url: 'https://github.com/'
    })
    expect(matches.map((m) => m.key)).toContain('history:https://github.com/foo/bar')
  })

  it('OS-4 不允许内联：第一行是搜索，github 那条在历史里', () => {
    const { matches, inline } = build({ text: 'git', history: [GH], allowInline: false })
    expect(inline).toBeNull()
    expect(matches[0]).toMatchObject({ kind: 'search', key: 'search:git' })
    expect(matches[1]).toMatchObject({
      kind: 'history',
      key: 'history:https://github.com/',
      fill: 'github.com',
      title: 'GitHub'
    })
  })
})

describe('开着的 tab（OS-5 / OS-6）', () => {
  const TABS = [
    tabOf('t1', 'https://docs.test/a', 'Docs Alpha'),
    tabOf('t2', 'https://docs.test/b', 'Docs Bravo'),
    tabOf('t3', 'https://docs.test/c', 'Docs Charlie'),
    tabOf('t4', 'https://docs.test/d', 'Docs Delta'),
    tabOf('t5', 'about:blank', 'docs blank'),
    tabOf('t6', 'shuvix://settings', 'Settings docs')
  ]

  it('OS-5 紧跟第一行、最多 2 行；选中的那页不算', () => {
    const { matches } = build({ text: 'docs', tabs: TABS, selectedTabId: 't1' })
    expect(matches.map((m) => m.key).slice(0, 3)).toEqual(['search:docs', 'tab:t2', 'tab:t3'])
    expect(matches.filter((m) => m.kind === 'tab')).toHaveLength(2)
    expect(matches[1]).toEqual({
      kind: 'tab',
      key: 'tab:t2',
      fill: 'docs.test/b',
      tabId: 't2',
      url: 'https://docs.test/b',
      title: 'Docs Bravo',
      favicon: ''
    })
  })

  it('OS-5 空白页、内部页面从不出现', () => {
    expect(keys({ text: 'blank', tabs: TABS, selectedTabId: 't1' })).not.toContain('tab:t5')
    expect(keys({ text: 'settings', tabs: TABS, selectedTabId: 't1' })).not.toContain('tab:t6')
  })

  it('OS-5 每个词都要在标题或显示的网址里', () => {
    expect(keys({ text: 'docs charlie', tabs: TABS, selectedTabId: 't1' })).toEqual([
      'search:docs charlie',
      'tab:t3'
    ])
    // 显示的网址（去协议）里有 docs.test/d
    expect(keys({ text: 'test/d', tabs: TABS, selectedTabId: 't1' })).toContain('tab:t4')
    expect(keys({ text: 'docs nothing', tabs: TABS, selectedTabId: 't1' })).toEqual([
      'search:docs nothing'
    ])
  })

  it('OS-6 历史网址正开在别的 tab 里（tab 自己对不上这个词）→ 那条历史变成 tab:<id>', () => {
    const { matches } = build({
      text: 'gamma',
      history: [hist('https://x.test/page', { title: 'Gamma report' })],
      tabs: [tabOf('t2', 'https://x.test/page', '')],
      selectedTabId: 't1'
    })
    expect(matches.map((m) => m.key)).toEqual(['search:gamma', 'tab:t2'])
  })

  it('OS-6 那个 tab 已经有一行「切换」：历史那条去掉（同一个网址，带不带结尾 / 都算）', () => {
    const { matches } = build({
      text: 'gamma',
      history: [hist('https://gamma.test/', { title: 'Gamma' })],
      tabs: [tabOf('t2', 'https://gamma.test', 'Gamma')],
      selectedTabId: 't1'
    })
    expect(matches.map((m) => m.key)).toEqual(['search:gamma', 'tab:t2'])
  })
})

describe('去重与历史的位置（OS-7 / OS-8）', () => {
  it('OS-7 历史里的 https://example.org/ 与第一行的 https://example.org 是同一个：去掉', () => {
    expect(
      keys({ text: 'example.org', history: [hist('https://example.org/', { title: 'Example' })] })
    ).toEqual(['url:https://example.org', 'search:example.org'])
  })

  it('OS-8 网址开头对得上的前 2 条排在搜索前；第 3 条与只有标题对得上的排在搜索后', () => {
    expect(
      keys({
        text: 'git',
        allowInline: false,
        history: [
          hist('https://git1.test/', { lastVisitAt: NOW - 1 }),
          hist('https://git2.test/', { lastVisitAt: NOW - 2 }),
          hist('https://git3.test/', { lastVisitAt: NOW - 3 }),
          hist('https://other.test/', { title: 'git notes' })
        ],
        searchSuggestions: ['git status']
      })
    ).toEqual([
      'search:git',
      'history:https://git1.test/',
      'history:https://git2.test/',
      'search:git status',
      'history:https://git3.test/',
      'history:https://other.test/'
    ])
  })
})

describe('搜索建议（OS-9）', () => {
  it('OS-9 第一行是搜索：只留以输入开头且不等于输入的、同一条只一行、最多 4 行；不再补「搜这段字」', () => {
    const { matches } = build({
      text: 'git',
      searchSuggestions: [
        'github',
        'GIT',
        'git',
        'gitlab',
        'learn git',
        'gitlab',
        'git status',
        'git log',
        'git diff'
      ]
    })
    expect(matches.map((m) => m.key)).toEqual([
      'search:git',
      'search:github',
      'search:gitlab',
      'search:git status',
      'search:git log'
    ])
    expect(matches.filter((m) => m.key === 'search:git')).toHaveLength(1)
    expect(matches[1]).toEqual({
      kind: 'search',
      key: 'search:github',
      fill: 'github',
      query: 'github',
      url: google('github'),
      suggested: true
    })
  })

  it('OS-9 不分大小写：GitHub 以 git 开头', () => {
    expect(keys({ text: 'git', searchSuggestions: ['GitHub Desktop'] })).toEqual([
      'search:git',
      'search:GitHub Desktop'
    ])
  })

  it('OS-9 第一行是网址：「搜这段字」那行算在 4 行里', () => {
    const { matches } = build({
      text: 'example.org',
      searchSuggestions: [
        'example.org login',
        'example.org api',
        'example.org docs',
        'example.org blog'
      ]
    })
    expect(matches.map((m) => [m.key, m.kind === 'search' ? m.suggested : null])).toEqual([
      ['url:https://example.org', null],
      ['search:example.org', false],
      ['search:example.org login', true],
      ['search:example.org api', true],
      ['search:example.org docs', true]
    ])
  })
})

describe('上限（OS-10）', () => {
  it('OS-10 最多 8 行', () => {
    const { matches } = build({
      text: 'git',
      allowInline: false,
      history: Array.from({ length: 10 }, (_, i) =>
        hist(`https://git${i}.test/`, { lastVisitAt: NOW - i })
      ),
      searchSuggestions: ['git a', 'git b', 'git c', 'git d', 'git e'],
      tabs: [
        tabOf('t2', 'https://tab2.test/', 'git tab'),
        tabOf('t3', 'https://tab3.test/', 'git')
      ],
      selectedTabId: 't1'
    })
    expect(matches).toHaveLength(8)
    expect(matches.map((m) => m.key)).toEqual([
      'search:git',
      'tab:t2',
      'tab:t3',
      'history:https://git0.test/',
      'history:https://git1.test/',
      'search:git a',
      'search:git b',
      'search:git c'
    ])
  })
})

describe('上一段输入的结果（OS-11）', () => {
  it('OS-11 对不上这段输入的、visitCount 0 的去掉；按这段输入重新排（不看带来的 score）', () => {
    const { matches } = build({
      text: 'git',
      allowInline: false,
      history: [
        hist('https://gist.test/', { score: 500 }),
        hist('https://git.a/', { score: 999 }),
        hist('https://git.agent/', { visitCount: 0, typedCount: 2, score: 800 }),
        hist('https://git.b/', { typedCount: 3, score: 1 })
      ]
    })
    expect(matches.map((m) => m.key)).toEqual([
      'search:git',
      'history:https://git.b/',
      'history:https://git.a/'
    ])
  })

  it('OS-11 内联补全同样用重新排过的：带来的 score 再高、对不上也不补', () => {
    const { inline } = build({
      text: 'gith',
      history: [
        hist('https://gitlab.com/', { typedCount: 5, score: 999 }),
        hist('https://github.com/', { typedCount: 1, score: 1 })
      ]
    })
    expect(inline).toBe('github.com')
  })
})
