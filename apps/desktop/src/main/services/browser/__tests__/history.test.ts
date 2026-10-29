/**
 * 内置浏览器的历史记录（history.ts）—— 哪次导航记成一次访问、记在谁头上、标题 / 图标记到哪、查询怎么交给落盘处。
 *
 *   HS-1   用户提交的导航 → addVisit({规范化的地址, title '', visitedAt: now, 'link', sessionId null})，用户名密码
 *          去掉；about: / data: / blob: / shuvix: / javascript: 什么也不记
 *   HS-2   同一个 tab 再提交同一个地址（刷新）不算；别的 tab 算；中间提交过 about:blank 之后再去同一个地址算
 *   HS-3   页内导航只改锚点不算；hash 路由 / 路径 / 查询变了算；doc → doc#install 若是完整导航（不是同文档）算
 *   HS-4   historyNoteUserNavigation(t, 'typed') → 下一次提交记成 typed、sessionId null（agent 动过也一样）；再敲
 *          一次当前地址也算；从地址栏去的只改锚点的同文档导航也算；generated → generated
 *   HS-5   挂着的 typed 被第一次提交用掉；60 秒后作废（恰好 60000 还算，60001 不算）；主框架加载失败与
 *          historyNoteUserNavigation(t, 'link') 都把它清掉；不记的提交（新 tab 自己那次 about:blank 比回车晚到）
 *          不用掉它
 *   HS-6   agent s1 动过 → 's1'；之后用户动了 → null；s1 之后 s2 → 's2'；没人记过的 tab → 用户
 *   HS-7   historyCopyActor：从 agent 的 tab 弹出的 → 同一个会话；从没记过的 tab → 用户；源 tab 不变
 *   HS-8   标题 / 图标记到这个 tab 最近记下的地址：标题 trim、截到 1024；空白标题、undefined 图标、超过 16384 的
 *          图标不记；还没提交过、刚提交 about:blank 都不记。最近一次**提交**与最近一次**记下**分开：只改锚点
 *          那次没记，标题仍记到 doc；再提交 doc#install（与最近提交的相同）仍是刷新；不能记的提交两者都清
 *   HS-9   historyForgetTab 之后同一个 tab、同一个地址重新算一次访问，记在用户头上
 *   HS-10  落盘处抛错（addVisit / setTitle / setFavicon）不往外抛；没注入落盘处：提交什么也不做、suggestHistory
 *          回 []、listHistory 回 {items:[], next:null}
 *   HS-11  第一次记下访问 → pruneBefore(now − 90 天)；24 小时内的下一次不修剪；满 24 小时再修剪；suggestHistory /
 *          listHistory 同样会修剪
 *   HS-12  suggestHistory：candidates(前 6 个小写的词, 400)、按分数排、缺省最多 12 条；空 / 全空白不碰落盘处；
 *          visitCount 0 的永远不回
 *   HS-13  listHistory：向落盘处要 limit + 1 条；key `天|网址id|会话id`（用户的末段为空）、数值转成 number、只有
 *          agent 的行带 sessionId + sessionTitle（回调给）；还有更多 → next = 最后一条的 lastId，否则 null；limit
 *          0→1、1000→500、不给 / NaN / Infinity→100、2.7→2；不认识的 actor → all；NaN / Infinity / 字符串的 cursor → null；搜索 trim
 *   HS-14  removeHistoryItems：合法的 key → removeGroup(天, Number(网址id), 会话id || null)；格式不对的、非字符串、
 *          不是数组的一律跳过；removeHistoryUrl / clearHistory 原样转交
 *
 * 落盘处是假的（setHistoryStore 注入的一组 vi.fn）；模块级的账（谁在动哪个 tab、最后提交的地址、上次修剪）
 * 每条用例都要新的：beforeEach 里 resetModules 再导入。时刻一律显式给 now。
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { HistoryGroupRow } from '../../../dao/browserHistoryDao'
import type { HistoryUrlRecord } from '../../../../shared/browserHistory'

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
}))

type History = typeof import('../history')

interface FakeStore {
  addVisit: Mock
  setTitle: Mock
  setFavicon: Mock
  candidates: Mock<(words: string[], limit: number) => HistoryUrlRecord[]>
  listGroups: Mock<
    (q: { search: string; actor: string; before: number | null; limit: number }) => unknown[]
  >
  removeGroup: Mock
  removeUrl: Mock
  clear: Mock
  pruneBefore: Mock
}

const NOW = Date.UTC(2026, 9, 29, 3, 0, 0)
const HOUR = 3_600_000
const DAY = 24 * HOUR
const RETENTION = 90 * DAY

let h: History
let store: FakeStore

function fakeStore(): FakeStore {
  return {
    addVisit: vi.fn(),
    setTitle: vi.fn(),
    setFavicon: vi.fn(),
    candidates: vi.fn(() => []),
    listGroups: vi.fn(() => []),
    removeGroup: vi.fn(),
    removeUrl: vi.fn(),
    clear: vi.fn(),
    pruneBefore: vi.fn()
  }
}

beforeEach(async () => {
  vi.resetModules()
  h = await import('../history')
  store = fakeStore()
  h.setHistoryStore(store as never)
})

/** 主框架提交了一次完整导航 */
const commit = (tab: string, url: string, now = NOW): void =>
  h.historyNoteCommit(tab, url, { sameDocument: false }, now)
/** 页内导航（pushState / 改 hash） */
const inPage = (tab: string, url: string, now = NOW): void =>
  h.historyNoteCommit(tab, url, { sameDocument: true }, now)

/** addVisit 收到的每一次访问（按顺序） */
const visits = (): Array<Record<string, unknown>> =>
  store.addVisit.mock.calls.map(([v]) => v as Record<string, unknown>)
const visitedUrls = (): string[] => visits().map((v) => String(v.url))
const last = (): Record<string, unknown> | undefined => visits().at(-1)

const DOC = 'https://docs.test/guide'

describe('什么算一次访问（HS-1 ~ HS-3）', () => {
  it('HS-1 用户提交 → 规范化的地址、空标题、now、link、sessionId null；用户名密码去掉', () => {
    commit('t1', 'HTTPS://User:pw@Example.COM/a', NOW)
    expect(visits()).toEqual([
      {
        url: 'https://example.com/a',
        title: '',
        visitedAt: NOW,
        transition: 'link',
        sessionId: null
      }
    ])
  })

  it.each([
    'about:blank',
    'data:text/html,hi',
    'blob:https://a.test/u',
    'shuvix://history',
    'javascript:void(0)'
  ])('HS-1 %s → 不记', (url) => {
    commit('t1', url)
    inPage('t1', url)
    expect(store.addVisit).not.toHaveBeenCalled()
  })

  it('HS-2 同一个 tab 再提交同一个地址（刷新）不算；别的 tab 同一个地址算', () => {
    commit('t1', 'https://a.test/')
    commit('t1', 'https://a.test/')
    commit('t1', 'https://A.test')
    expect(visitedUrls()).toEqual(['https://a.test/'])
    commit('t2', 'https://a.test/')
    expect(visitedUrls()).toEqual(['https://a.test/', 'https://a.test/'])
  })

  it('HS-2 中间提交过 about:blank：再去同一个地址算', () => {
    commit('t1', 'https://a.test/')
    commit('t1', 'about:blank')
    commit('t1', 'https://a.test/')
    expect(visitedUrls()).toEqual(['https://a.test/', 'https://a.test/'])
  })

  it('HS-3 同文档只改锚点：不算', () => {
    commit('t1', DOC)
    inPage('t1', `${DOC}#install`)
    inPage('t1', `${DOC}#usage`)
    inPage('t1', DOC)
    expect(visitedUrls()).toEqual([DOC])
  })

  it('HS-3 hash 路由、路径、查询变了：算', () => {
    commit('t1', DOC)
    inPage('t1', `${DOC}#/settings`)
    inPage('t1', 'https://docs.test/other')
    inPage('t1', 'https://docs.test/other?page=2')
    expect(visitedUrls()).toEqual([
      DOC,
      `${DOC}#/settings`,
      'https://docs.test/other',
      'https://docs.test/other?page=2'
    ])
  })

  it('HS-3 doc → doc#install 是完整导航（不是同文档）：算', () => {
    commit('t1', DOC)
    commit('t1', `${DOC}#install`)
    expect(visitedUrls()).toEqual([DOC, `${DOC}#install`])
  })
})

describe('从地址栏去的（HS-4 / HS-5）', () => {
  it('HS-4 typed → 下一次提交记成 typed、sessionId null —— agent 动过（之前或之后）都一样', () => {
    h.historyNoteAgent('t1', 's1')
    h.historyNoteUserNavigation('t1', 'typed', NOW)
    commit('t1', 'https://a.test/')
    expect(last()).toMatchObject({ transition: 'typed', sessionId: null })

    h.historyNoteUserNavigation('t2', 'typed', NOW)
    h.historyNoteAgent('t2', 's2')
    commit('t2', 'https://b.test/')
    expect(last()).toMatchObject({ url: 'https://b.test/', transition: 'typed', sessionId: null })
  })

  it('HS-4 在地址栏里再敲一次当前地址：也算一次（typed）', () => {
    commit('t1', 'https://a.test/')
    h.historyNoteUserNavigation('t1', 'typed', NOW)
    commit('t1', 'https://a.test/')
    expect(visits().map((v) => v.transition)).toEqual(['link', 'typed'])
  })

  it('HS-4 从地址栏去的同文档、只改锚点：也算', () => {
    commit('t1', DOC)
    h.historyNoteUserNavigation('t1', 'typed', NOW)
    inPage('t1', `${DOC}#install`)
    expect(visitedUrls()).toEqual([DOC, `${DOC}#install`])
    expect(last()?.transition).toBe('typed')
  })

  it('HS-4 generated（从地址栏去的搜索）→ generated', () => {
    h.historyNoteUserNavigation('t1', 'generated', NOW)
    commit('t1', 'https://www.google.com/search?q=x')
    expect(last()).toMatchObject({ transition: 'generated', sessionId: null })
  })

  it('HS-5 被第一次提交用掉：下一次是 link', () => {
    h.historyNoteUserNavigation('t1', 'typed', NOW)
    commit('t1', 'https://a.test/')
    commit('t1', 'https://b.test/')
    expect(visits().map((v) => v.transition)).toEqual(['typed', 'link'])
  })

  it('HS-5 不记的提交不用掉它：about:blank 晚于回车提交，随后那次照样是 typed', () => {
    h.historyNoteUserNavigation('t1', 'typed', NOW)
    commit('t1', 'about:blank')
    commit('t1', 'https://a.test/')
    expect(visits().map((v) => [v.url, v.transition])).toEqual([['https://a.test/', 'typed']])
  })

  it('HS-5 60 秒后作废：恰好 60000ms 还是 typed，60001ms 是 link', () => {
    h.historyNoteUserNavigation('t1', 'typed', NOW)
    commit('t1', 'https://a.test/', NOW + 60_000)
    h.historyNoteUserNavigation('t2', 'typed', NOW)
    commit('t2', 'https://b.test/', NOW + 60_001)
    expect(visits().map((v) => [v.url, v.transition])).toEqual([
      ['https://a.test/', 'typed'],
      ['https://b.test/', 'link']
    ])
  })

  it("HS-5 主框架加载失败、historyNoteUserNavigation(t, 'link') 都把它清掉", () => {
    h.historyNoteUserNavigation('t1', 'typed', NOW)
    h.historyNoteFailed('t1')
    commit('t1', 'https://a.test/')
    h.historyNoteUserNavigation('t2', 'typed', NOW)
    h.historyNoteUserNavigation('t2', 'link', NOW)
    commit('t2', 'https://b.test/')
    expect(visits().map((v) => v.transition)).toEqual(['link', 'link'])
  })
})

describe('记在谁头上（HS-6 / HS-7）', () => {
  it('HS-6 agent s1 → s1；用户动了 → null；s1 之后 s2 → s2；没人记过 → 用户', () => {
    h.historyNoteAgent('t1', 's1')
    commit('t1', 'https://a.test/')
    h.historyNoteUser('t1')
    commit('t1', 'https://b.test/')
    h.historyNoteAgent('t1', 's1')
    h.historyNoteAgent('t1', 's2')
    commit('t1', 'https://c.test/')
    commit('t9', 'https://d.test/')
    expect(visits().map((v) => [v.url, v.sessionId])).toEqual([
      ['https://a.test/', 's1'],
      ['https://b.test/', null],
      ['https://c.test/', 's2'],
      ['https://d.test/', null]
    ])
  })

  it('HS-7 historyCopyActor：agent 的 tab 弹出的 → 同一个会话；没记过的 tab 弹出的 → 用户；源 tab 不变', () => {
    h.historyNoteAgent('src', 's1')
    h.historyCopyActor('src', 'pop')
    h.historyCopyActor('plain', 'pop2')
    commit('pop', 'https://pop.test/')
    commit('pop2', 'https://pop2.test/')
    commit('src', 'https://src.test/')
    expect(visits().map((v) => [v.url, v.sessionId])).toEqual([
      ['https://pop.test/', 's1'],
      ['https://pop2.test/', null],
      ['https://src.test/', 's1']
    ])
  })
})

describe('标题与站点图标（HS-8）', () => {
  it('HS-8 记到最近记下的地址：标题 trim；图标原样', () => {
    commit('t1', 'https://a.test/')
    h.historyNoteTitle('t1', '  Alpha  ')
    h.historyNoteFavicon('t1', 'https://a.test/favicon.ico')
    expect(store.setTitle.mock.calls).toEqual([['https://a.test/', 'Alpha']])
    expect(store.setFavicon.mock.calls).toEqual([['https://a.test/', 'https://a.test/favicon.ico']])
  })

  it('HS-8 空白标题、undefined 图标、超过 16384 字的图标不记；16384 字的记', () => {
    commit('t1', 'https://a.test/')
    h.historyNoteTitle('t1', '   ')
    h.historyNoteFavicon('t1', undefined)
    h.historyNoteFavicon('t1', '')
    const exact = 'data:image/png;base64,' + 'A'.repeat(16384 - 22)
    h.historyNoteFavicon('t1', exact + 'A')
    expect(store.setTitle).not.toHaveBeenCalled()
    expect(store.setFavicon).not.toHaveBeenCalled()
    h.historyNoteFavicon('t1', exact)
    expect(store.setFavicon.mock.calls).toEqual([['https://a.test/', exact]])
  })

  it('HS-8 标题截到 1024 字', () => {
    commit('t1', 'https://a.test/')
    h.historyNoteTitle('t1', 'x'.repeat(2000))
    expect(store.setTitle.mock.calls[0][1]).toBe('x'.repeat(1024))
  })

  it('HS-8 还没提交过、刚提交 about:blank：都不记', () => {
    h.historyNoteTitle('t1', 'Too early')
    h.historyNoteFavicon('t1', 'https://x/f.ico')
    commit('t1', 'https://a.test/')
    commit('t1', 'about:blank')
    h.historyNoteTitle('t1', 'Blank')
    h.historyNoteFavicon('t1', 'https://x/f.ico')
    expect(store.setTitle).not.toHaveBeenCalled()
    expect(store.setFavicon).not.toHaveBeenCalled()
  })

  it('HS-8 只改锚点那次没记：标题 / 图标仍记到 doc；再提交 doc#install（与最近提交的相同）仍是刷新', () => {
    commit('t1', DOC)
    inPage('t1', `${DOC}#install`)
    h.historyNoteTitle('t1', 'Guide')
    h.historyNoteFavicon('t1', 'https://docs.test/f.ico')
    expect(store.setTitle.mock.calls).toEqual([[DOC, 'Guide']])
    expect(store.setFavicon.mock.calls).toEqual([[DOC, 'https://docs.test/f.ico']])

    commit('t1', `${DOC}#install`)
    expect(visitedUrls()).toEqual([DOC])
  })

  it('HS-8 不能记的提交把两者都清掉：之后的标题不记；再去 doc 算一次新的访问', () => {
    commit('t1', DOC)
    inPage('t1', `${DOC}#install`)
    commit('t1', 'about:blank')
    h.historyNoteTitle('t1', 'Blank')
    expect(store.setTitle).not.toHaveBeenCalled()
    commit('t1', DOC)
    expect(visitedUrls()).toEqual([DOC, DOC])
  })
})

describe('忘掉一个 tab（HS-9）', () => {
  it('HS-9 historyForgetTab 之后：同一个 tab、同一个地址重新算一次，记在用户头上', () => {
    h.historyNoteAgent('t1', 's1')
    commit('t1', 'https://a.test/')
    h.historyForgetTab('t1')
    commit('t1', 'https://a.test/')
    expect(visits().map((v) => [v.url, v.sessionId])).toEqual([
      ['https://a.test/', 's1'],
      ['https://a.test/', null]
    ])
    // 标题记到新记下的那一次（不是忘掉之前的账）
    h.historyForgetTab('t1')
    h.historyNoteTitle('t1', 'After forget')
    expect(store.setTitle).not.toHaveBeenCalled()
  })
})

describe('落盘处出错或没注入（HS-10）', () => {
  it('HS-10 addVisit / setTitle / setFavicon 抛错：不往外抛', () => {
    store.addVisit.mockImplementation(() => {
      throw new Error('disk full')
    })
    store.setTitle.mockImplementation(() => {
      throw new Error('locked')
    })
    store.setFavicon.mockImplementation(() => {
      throw new Error('locked')
    })
    expect(() => commit('t1', 'https://a.test/')).not.toThrow()
    expect(() => h.historyNoteTitle('t1', 'T')).not.toThrow()
    expect(() => h.historyNoteFavicon('t1', 'https://a.test/f.ico')).not.toThrow()
    expect(store.addVisit).toHaveBeenCalledTimes(1)
    expect(store.setTitle).toHaveBeenCalledTimes(1)
    expect(store.setFavicon).toHaveBeenCalledTimes(1)
  })

  it('HS-10 没注入落盘处：提交、标题、删除都不抛；查询回空', () => {
    h.setHistoryStore(null)
    expect(() => commit('t1', 'https://a.test/')).not.toThrow()
    expect(() => h.historyNoteTitle('t1', 'T')).not.toThrow()
    expect(() => h.historyNoteFavicon('t1', 'https://a.test/f.ico')).not.toThrow()
    expect(() => h.removeHistoryItems(['2026-10-29|1|'])).not.toThrow()
    expect(() => h.removeHistoryUrl('https://a.test/')).not.toThrow()
    expect(() => h.clearHistory()).not.toThrow()
    expect(h.suggestHistory('a', 12, NOW)).toEqual([])
    expect(h.listHistory({}, () => 'x', NOW)).toEqual({ items: [], next: null })
    expect(store.addVisit).not.toHaveBeenCalled()
  })
})

describe('修剪（HS-11）', () => {
  it('HS-11 第一次记下 → pruneBefore(now − 90 天)；24 小时内不再修剪；满 24 小时再修剪', () => {
    commit('t1', 'https://a.test/', NOW)
    expect(store.pruneBefore.mock.calls).toEqual([[NOW - RETENTION]])
    commit('t1', 'https://b.test/', NOW + HOUR)
    commit('t1', 'https://c.test/', NOW + DAY - 1)
    expect(store.pruneBefore).toHaveBeenCalledTimes(1)
    commit('t1', 'https://d.test/', NOW + DAY)
    expect(store.pruneBefore.mock.calls).toEqual([[NOW - RETENTION], [NOW + DAY - RETENTION]])
  })

  it('HS-11 不记的提交（刷新 / about:blank）不修剪', () => {
    commit('t1', 'about:blank', NOW)
    expect(store.pruneBefore).not.toHaveBeenCalled()
  })

  it('HS-11 suggestHistory 也修剪', () => {
    h.suggestHistory('a', 12, NOW)
    expect(store.pruneBefore.mock.calls).toEqual([[NOW - RETENTION]])
    h.suggestHistory('b', 12, NOW + HOUR)
    expect(store.pruneBefore).toHaveBeenCalledTimes(1)
  })

  it('HS-11 listHistory 也修剪', () => {
    h.listHistory({}, () => '', NOW)
    expect(store.pruneBefore.mock.calls).toEqual([[NOW - RETENTION]])
  })
})

/** 一条候选（缺省：用户访问 1 次、刚访问过） */
function cand(url: string, over: Partial<HistoryUrlRecord> = {}): HistoryUrlRecord {
  return { url, title: '', favicon: '', visitCount: 1, typedCount: 0, lastVisitAt: NOW, ...over }
}

describe('地址栏建议（HS-12）', () => {
  it('HS-12 candidates 收到前 6 个小写的词与 400', () => {
    h.suggestHistory('A b C d E f G h', 12, NOW)
    expect(store.candidates.mock.calls).toEqual([[['a', 'b', 'c', 'd', 'e', 'f'], 400]])
  })

  it('HS-12 按分数排；只有 agent 去过的（visitCount 0）不回', () => {
    store.candidates.mockReturnValue([
      cand('https://x.test/git-notes', { title: 'git notes' }),
      cand('https://github.com/', { typedCount: 3 }),
      cand('https://git.agent/', { visitCount: 0 })
    ])
    const out = h.suggestHistory('git', 12, NOW)
    expect(out.map((r) => r.url)).toEqual(['https://github.com/', 'https://x.test/git-notes'])
    expect(out[0].score).toBeGreaterThan(out[1].score)
  })

  it('HS-12 缺省最多 12 条；给了 limit 照它', () => {
    store.candidates.mockReturnValue(
      Array.from({ length: 15 }, (_, i) => cand(`https://git${i}.test/`))
    )
    expect(h.suggestHistory('git', undefined, NOW)).toHaveLength(12)
    expect(h.suggestHistory('git', 3, NOW)).toHaveLength(3)
  })

  it.each(['', '   ', '\t\n'])('HS-12 %j → []，不碰落盘处', (text) => {
    expect(h.suggestHistory(text, 12, NOW)).toEqual([])
    expect(store.candidates).not.toHaveBeenCalled()
    expect(store.pruneBefore).not.toHaveBeenCalled()
  })
})

/** listGroups 回的一行 */
function group(over: Partial<HistoryGroupRow> & { lastId: number }): HistoryGroupRow {
  return {
    urlId: 1,
    url: 'https://a.test/',
    title: 'A',
    favicon: '',
    sessionId: null,
    day: '2026-10-29',
    lastAt: NOW,
    count: 1,
    ...over
  }
}

describe('历史记录页（HS-13）', () => {
  it('HS-13 要 limit + 1 条；key / 数值 / 只有 agent 的行带会话；还有更多 → next = 最后一条的 lastId', () => {
    const title = vi.fn((sid: string) => (sid === 's1' ? 'Research' : ''))
    store.listGroups.mockReturnValue([
      group({ lastId: 30, urlId: 7, sessionId: 's1', lastAt: BigInt(NOW) as unknown as number }),
      group({ lastId: 20, urlId: 8, count: BigInt(3) as unknown as number }),
      group({ lastId: 10, urlId: 9 })
    ])
    const out = h.listHistory({ limit: 2 }, title, NOW)
    expect(store.listGroups.mock.calls).toEqual([
      [{ search: '', actor: 'all', before: null, limit: 3 }]
    ])
    expect(out.items).toEqual([
      {
        key: '2026-10-29|7|s1',
        day: '2026-10-29',
        url: 'https://a.test/',
        title: 'A',
        favicon: '',
        lastAt: NOW,
        count: 1,
        sessionId: 's1',
        sessionTitle: 'Research'
      },
      {
        key: '2026-10-29|8|',
        day: '2026-10-29',
        url: 'https://a.test/',
        title: 'A',
        favicon: '',
        lastAt: NOW,
        count: 3
      }
    ])
    expect(typeof out.items[0].lastAt).toBe('number')
    expect(typeof out.items[1].count).toBe('number')
    expect(out.items[1]).not.toHaveProperty('sessionId')
    expect(out.items[1]).not.toHaveProperty('sessionTitle')
    expect(title.mock.calls).toEqual([['s1']])
    expect(out.next).toBe(20)
  })

  it('HS-13 没有更多：next null；会话查不到标题 → 空串', () => {
    store.listGroups.mockReturnValue([group({ lastId: 5, sessionId: 'gone' })])
    const out = h.listHistory({ limit: 2 }, () => '', NOW)
    expect(out.next).toBeNull()
    expect(out.items[0]).toMatchObject({ sessionId: 'gone', sessionTitle: '' })
  })

  it.each([
    [0, 2],
    [1000, 501],
    [undefined, 101],
    [Number.NaN, 101],
    [Number.POSITIVE_INFINITY, 101],
    [2.7, 3]
  ] as const)('HS-13 limit %s → 向落盘处要 %s 条', (limit, asked) => {
    h.listHistory(limit === undefined ? {} : { limit }, () => '', NOW)
    expect(store.listGroups.mock.calls[0][0].limit).toBe(asked)
  })

  it('HS-13 actor：认识的照给，不认识的 → all', () => {
    for (const actor of ['all', 'user', 'agent'] as const) {
      h.listHistory({ actor }, () => '', NOW)
    }
    h.listHistory({ actor: 'bogus' as never }, () => '', NOW)
    expect(store.listGroups.mock.calls.map(([q]) => q.actor)).toEqual([
      'all',
      'user',
      'agent',
      'all'
    ])
  })

  it('HS-13 cursor：有限的数照给；NaN / Infinity / 字符串 / null → null', () => {
    h.listHistory({ cursor: 42 }, () => '', NOW)
    for (const cursor of [Number.NaN, Number.POSITIVE_INFINITY, '42' as never, null]) {
      h.listHistory({ cursor }, () => '', NOW)
    }
    expect(store.listGroups.mock.calls.map(([q]) => q.before)).toEqual([42, null, null, null, null])
  })

  it('HS-13 搜索 trim', () => {
    h.listHistory({ search: '  foo bar  ' }, () => '', NOW)
    expect(store.listGroups.mock.calls[0][0].search).toBe('foo bar')
  })
})

describe('删除（HS-14）', () => {
  it('HS-14 合法的 key → removeGroup(天, Number(网址id), 会话id || null)', () => {
    h.removeHistoryItems(['2026-10-29|5|', '2026-10-28|12|s1', '2026-10-27|3|a|b'])
    expect(store.removeGroup.mock.calls).toEqual([
      ['2026-10-29', 5, null],
      ['2026-10-28', 12, 's1'],
      ['2026-10-27', 3, 'a|b']
    ])
  })

  it('HS-14 格式不对的、非字符串的跳过；不是数组什么也不做', () => {
    h.removeHistoryItems(['bad', '2026-1-1|1|', '2026-10-29|x|', '2026-10-29|1', 42, null, {}])
    h.removeHistoryItems('2026-10-29|1|')
    h.removeHistoryItems(undefined)
    h.removeHistoryItems({ 0: '2026-10-29|1|', length: 1 })
    expect(store.removeGroup).not.toHaveBeenCalled()
  })

  it('HS-14 removeHistoryUrl / clearHistory 原样转交', () => {
    h.removeHistoryUrl('https://a.test/x')
    h.clearHistory()
    expect(store.removeUrl.mock.calls).toEqual([['https://a.test/x']])
    expect(store.clear).toHaveBeenCalledTimes(1)
  })
})
