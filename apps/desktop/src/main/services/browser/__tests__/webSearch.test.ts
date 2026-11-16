/**
 * `web_search` 的浏览器一半（services/browser/webSearch.ts）：开 tab、等结果页稳定、人机验证、不透明跳转链接、
 * 中止、并发上限。browserViewService / settingsDao / electron 桩掉，searchResults 用真的；全程假时钟。
 *
 *   WS-1..4    正常路径、搜索引擎、条数上限、结果整理
 *   WS-5..11   等页面稳定（够一页 / 很少 / 读不到 / 卡住 / tab 没了），WS-33 / WS-34 近乎空白的页面
 *   WS-12..15b 页面正文的退路
 *   WS-16..24  人机验证：这次搜索立刻失败（SearchNeedsHumanCheck），验证页留着、全应用至多一张
 *   WS-35..42b 之后的搜索先看留下的那张（还挂着 / 过了 / 被关了 / 别的搜索引擎 / 中止）
 *   WS-43..49  Google 的不透明跳转链接
 *   WS-25..28  中止与出错
 *   WS-29..31  并发上限
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const h = vi.hoisted(() => ({
  setting: undefined as string | undefined,
  views: new Map<string, { webContents: unknown }>(),
  createTab: vi.fn(),
  closeTab: vi.fn(),
  noteAgentUse: vi.fn(),
  findByKey: vi.fn(),
  netRequest: vi.fn(),
  fromPartition: vi.fn()
}))

vi.mock('electron', () => ({
  net: { request: h.netRequest },
  session: { fromPartition: h.fromPartition }
}))
vi.mock('../browserViewService', () => ({
  BROWSER_PARTITION: 'persist:test-browser',
  createTab: h.createTab,
  getTabView: (id: string) => h.views.get(id) ?? null,
  closeTab: h.closeTab,
  noteAgentUse: h.noteAgentUse
}))
vi.mock('../../../dao/settingsDao', () => ({ settingsDao: { findByKey: h.findByKey } }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { SEARCH_ENGINES, searchUrl } from '../../../../shared/browserSearchEngines'
import {
  formatPageTextFallback,
  formatResults,
  SEARCH_PAGE_SCRIPT,
  SEARCH_PAGE_TEXT_SCRIPT,
  type SearchPageState,
  type SearchResult
} from '../searchResults'
import type { WebSearchOptions, WebSearchOutcome } from '../webSearch'

// ─── 夹具 ───────────────────────────────────────────────

const TAB_GONE = 'The search tab was closed before the results were read.'
const NO_PAGE = 'Google did not show a results page for this search.'
const GOTO_NOTE =
  "\n\nAddresses that start with https://www.google.com/goto are Google's own links to the result; opening one leads to the page."
const NEVER = new Promise<never>(() => undefined)

const results = (n: number, prefix = 'r'): SearchResult[] =>
  Array.from({ length: n }, (_, i) => ({
    title: `T${i + 1}`,
    url: `https://${prefix}${i + 1}.example/`,
    snippet: `s${i + 1}`
  }))
const stateOf = (
  list: unknown[],
  textLength = 1000,
  url = 'https://www.google.com/search?q=q'
): SearchPageState => ({
  url,
  title: 'q - Google Search',
  textLength,
  head: '',
  results: list as SearchResult[]
})
const resultsState = (n: number, url?: string): SearchPageState => stateOf(results(n), 1000, url)
const emptyState = (textLength: number, url?: string): SearchPageState =>
  stateOf([], textLength, url)
const checkState = (): SearchPageState => ({
  url: 'https://www.google.com/sorry/index?continue=x',
  title: '',
  textLength: 100,
  head: '',
  results: []
})
const goto = (token: string): string => `https://www.google.com/goto?url=${token}`

interface Page {
  id?: string
  destroyed: boolean
  loading: boolean
  /** webContents.getURL() 此刻的地址 */
  location: string
  /** 取数脚本这一刻看到的东西（可以是状态、undefined、拒绝、永不落定的 promise） */
  state: () => unknown
  /** 正文脚本交回的东西 */
  text: unknown
  loadURL: Mock<(url: string) => Promise<unknown>>
  executeJavaScript: Mock<(code: string) => Promise<unknown>>
}

/** 之后的 createTab 依次领走的页面；队列空了就是一张 5 条结果的页面 */
let queued: Page[] = []
let tabSeq = 0

function page(init: Partial<Pick<Page, 'loading' | 'state' | 'text' | 'location'>> = {}): Page {
  const p: Page = {
    destroyed: false,
    loading: false,
    location: 'https://www.google.com/search?q=q',
    state: () => resultsState(5),
    text: 'page text',
    ...init,
    loadURL: vi.fn(async () => undefined),
    executeJavaScript: vi.fn(async (code: string) =>
      code === SEARCH_PAGE_SCRIPT
        ? p.state()
        : code === SEARCH_PAGE_TEXT_SCRIPT
          ? p.text
          : undefined
    )
  }
  queued.push(p)
  return p
}
const showing =
  (state: unknown): (() => unknown) =>
  () =>
    state

const follow = vi.fn<(url: string) => Promise<string | undefined>>()

interface Tracked<T> {
  status: 'pending' | 'ok' | 'err'
  value?: T
  error?: unknown
}
function track<T>(promise: Promise<T>): Tracked<T> {
  const t: Tracked<T> = { status: 'pending' }
  promise.then(
    (value) => {
      t.status = 'ok'
      t.value = value
    },
    (error: unknown) => {
      t.status = 'err'
      t.error = error
    }
  )
  return t
}

let mod: typeof import('../webSearch')

function start(over: Partial<WebSearchOptions> = {}): Tracked<WebSearchOutcome> {
  return track(
    mod.runWebSearch({
      query: 'q',
      engine: 'google',
      limit: 8,
      sessionId: 'S',
      followRedirect: follow,
      ...over
    })
  )
}
const tick = (ms: number): Promise<unknown> => vi.advanceTimersByTimeAsync(ms)
const messageOf = (t: Tracked<unknown>): string | undefined =>
  t.error instanceof Error ? t.error.message : undefined

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => void unhandled.push(reason)

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  queued = []
  tabSeq = 0
  unhandled.length = 0
  h.views.clear()
  h.setting = undefined
  for (const fn of [
    h.createTab,
    h.closeTab,
    h.noteAgentUse,
    h.findByKey,
    h.netRequest,
    h.fromPartition
  ]) {
    fn.mockReset()
  }
  h.findByKey.mockImplementation(() => h.setting)
  h.fromPartition.mockImplementation((partition: string) => ({ partition }))
  h.createTab.mockImplementation(() => {
    const p = queued.shift() ?? (page(), queued.shift()!)
    p.id = `tab-${++tabSeq}`
    h.views.set(p.id, {
      webContents: {
        isDestroyed: () => p.destroyed,
        isLoadingMainFrame: () => p.loading,
        getURL: () => p.location,
        loadURL: p.loadURL,
        executeJavaScript: p.executeJavaScript
      }
    })
    return p.id
  })
  follow.mockReset()
  follow.mockImplementation(async () => undefined)
  process.on('unhandledRejection', onUnhandled)
  mod = await import('../webSearch')
})

afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  // 未处理的拒绝在真的宏任务之后才报
  await new Promise((r) => setTimeout(r, 0))
  process.off('unhandledRejection', onUnhandled)
  expect(unhandled).toEqual([])
})

// ─── 正常路径与搜索引擎 ─────────────────────────────────

describe('正常路径', () => {
  it('WS-1 开一个后台 tab、记在会话名下、取回结果、关掉；不读设置', async () => {
    const run = start({ query: 'a b&c' })
    await tick(1000)
    expect(run.status).toBe('ok')
    expect(h.createTab).toHaveBeenCalledTimes(1)
    expect(h.createTab.mock.calls[0]).toEqual([
      `https://www.google.com/search?q=${encodeURIComponent('a b&c')}`,
      { openerSessionId: 'S' }
    ])
    expect(h.noteAgentUse).toHaveBeenCalledWith('tab-1', 'S')
    expect(run.value).toEqual({
      engine: 'google',
      resultCount: 5,
      text: formatResults('a b&c', 'Google', results(5))
    })
    expect(h.closeTab.mock.calls).toEqual([['tab-1']])
    expect(h.findByKey).not.toHaveBeenCalled()
  })

  it.each(['bing', 'baidu', 'duckduckgo'] as const)(
    'WS-2 engine %s：地址、名字照表',
    async (engine) => {
      const run = start({ engine, query: 'x y' })
      await tick(1000)
      expect(h.createTab.mock.calls[0][0]).toBe(
        SEARCH_ENGINES[engine].template.replace('%s', 'x%20y')
      )
      expect(run.value?.engine).toBe(engine)
      expect(run.value?.text.startsWith(`${SEARCH_ENGINES[engine].name} results for "x y":`)).toBe(
        true
      )
    }
  )

  it('WS-2 configuredSearchEngine：没设 / 不认识的值 → google；设了就是它', () => {
    expect(mod.configuredSearchEngine()).toBe('google')
    h.setting = 'bing'
    expect(mod.configuredSearchEngine()).toBe('bing')
    for (const value of ['toString', 'yahoo']) {
      h.setting = value
      expect(mod.configuredSearchEngine()).toBe('google')
    }
    expect(h.findByKey).toHaveBeenCalledWith('browser.searchEngine')
  })

  it.each([
    [3, 3],
    [0, 1],
    [99, 10],
    [2.9, 2]
  ])('WS-3 limit %s → %s 条', async (limit, kept) => {
    page({ state: showing(resultsState(10)) })
    const run = start({ limit })
    await tick(1000)
    expect(run.value?.resultCount).toBe(kept)
    expect(run.value?.text).toBe(formatResults('q', 'Google', results(10).slice(0, kept)))
  })

  it('WS-4 结果经过整理：解包、去重、丢掉不是 http(s) 的', async () => {
    page({
      state: showing(
        stateOf([
          {
            title: 'Wrapped',
            url: 'https://www.google.com/url?q=https%3A%2F%2Fa.com%2F',
            snippet: 's'
          },
          { title: 'Dup', url: 'https://a.com/', snippet: '' },
          { title: 'Bad', url: 'javascript:alert(1)', snippet: '' }
        ])
      )
    })
    const run = start()
    await tick(1000)
    expect(run.value?.resultCount).toBe(1)
    expect(run.value?.text).toBe(
      formatResults('q', 'Google', [{ title: 'Wrapped', url: 'https://a.com/', snippet: 's' }])
    )
  })
})

// ─── 等页面稳定 ─────────────────────────────────────────

describe('等结果页稳定', () => {
  it('WS-5 够一页的结果：第一次看到之后要再稳 600ms', async () => {
    const run = start()
    await tick(800)
    expect(run.status).toBe('pending')
    await tick(400)
    expect(run.status).toBe('ok')
  })

  it('WS-6 主框架还在加载就不算稳', async () => {
    const p = page({ loading: true })
    const run = start()
    await tick(5000)
    expect(run.status).toBe('pending')
    p.loading = false
    await tick(300)
    expect(run.status).toBe('ok')
  })

  it('WS-7 结果变多了就重新计时', async () => {
    const p = page({ state: showing(resultsState(1)) })
    const run = start()
    await tick(2000)
    p.state = showing(resultsState(4))
    await tick(600)
    expect(run.status).toBe('pending')
    await tick(300)
    expect(run.value?.resultCount).toBe(4)
  })

  it('WS-8 结果很少的页面多等一会儿（4 秒）', async () => {
    page({ state: showing(resultsState(2)) })
    const run = start()
    await tick(3000)
    expect(run.status).toBe('pending')
    await tick(1100)
    expect(run.status).toBe('pending')
    await tick(500)
    expect(run.value?.resultCount).toBe(2)
  })

  it('WS-9 读不到的那几次跳过去', async () => {
    let call = 0
    page({
      state: () => {
        call++
        if (call === 1) return Promise.reject(new Error('navigating'))
        if (call === 2) return undefined
        if (call === 3) return { url: 5 }
        if (call === 4) return { url: 'https://www.google.com/search?q=q', results: 'none' }
        return resultsState(5)
      }
    })
    const run = start()
    await tick(2500)
    expect(run.value?.resultCount).toBe(5)
  })

  it('WS-10 页面卡住：每次问 3 秒就放弃，到上限之后报没有结果页', async () => {
    const p = page({ state: () => NEVER, text: NEVER })
    const run = start()
    await tick(19_000)
    expect(run.status).toBe('pending')
    // 20 秒里 300ms + 3s 一轮：远少于不卡时的六十多次
    expect(p.executeJavaScript.mock.calls.length).toBeLessThanOrEqual(7)
    await tick(11_000)
    expect(messageOf(run)).toBe(NO_PAGE)
    expect(h.closeTab).toHaveBeenCalledWith('tab-1')
  })

  it.each(['view-gone', 'destroyed'] as const)('WS-11 等的途中 tab 没了（%s）', async (how) => {
    const p = page({ loading: true })
    const run = start()
    await tick(1000)
    if (how === 'view-gone') h.views.delete('tab-1')
    else p.destroyed = true
    await tick(300)
    expect(messageOf(run)).toBe(TAB_GONE)
    expect(h.closeTab).toHaveBeenCalledWith('tab-1')
    // 名额还回去了：再来两个都能开 tab
    start()
    start()
    await tick(0)
    expect(h.createTab).toHaveBeenCalledTimes(3)
  })

  it('WS-33 近乎空白的页面不算「结果很少」：接着等，之后出来的结果照取', async () => {
    const p = page({ state: showing(emptyState(50)) })
    const run = start()
    await tick(10_000)
    expect(run.status).toBe('pending')
    await tick(2000)
    p.state = showing(resultsState(5))
    await tick(1000)
    expect(run.value?.resultCount).toBe(5)
  })

  it('WS-34 界限：0 条 + 199 字不落定；0 条 + 200 字按「很少」落定；1 条 + 50 字也按「很少」落定', async () => {
    page({ state: showing(emptyState(199)) })
    page({ state: showing(emptyState(200)) })
    const a = start()
    const b = start()
    await tick(5000)
    expect(a.status).toBe('pending')
    expect(b.value?.resultCount).toBe(0)

    page({ state: showing(stateOf(results(1), 50)) })
    const c = start()
    await tick(4000)
    expect(c.status).toBe('pending')
    await tick(600)
    expect(c.value?.resultCount).toBe(1)
  })
})

// ─── 页面正文的退路 ─────────────────────────────────────

describe('页面正文的退路', () => {
  it('WS-12 没取到结果但页面有正文 → 把正文交回，地址用页面自己报的', async () => {
    const reported = 'https://www.google.com/search?q=q&sei=abc'
    page({ state: showing(emptyState(900, reported)), text: 'No results found for q.' })
    const run = start()
    await tick(4000)
    expect(run.status).toBe('pending')
    await tick(600)
    expect(run.value).toEqual({
      engine: 'google',
      resultCount: 0,
      text: formatPageTextFallback('q', 'Google', reported, 'No results found for q.')
    })
    expect(follow).not.toHaveBeenCalled()
  })

  it.each(['', '  \n\t '])('WS-13 正文是空的（%j）→ 报没有结果页', async (text) => {
    page({ state: showing(emptyState(900)), text })
    const run = start()
    await tick(5000)
    expect(messageOf(run)).toBe(NO_PAGE)
    expect(h.closeTab).toHaveBeenCalledWith('tab-1')
  })

  it('WS-13 一直近乎空白的页面：到 20 秒上限才报', async () => {
    page({ state: showing(emptyState(50)), text: '' })
    const run = start()
    await tick(19_500)
    expect(run.status).toBe('pending')
    await tick(1000)
    expect(messageOf(run)).toBe(NO_PAGE)
  })

  it('WS-14 到了上限但最后一次读到的页面有结果 → 照样整理', async () => {
    let n = 0
    page({ state: () => stateOf(results(5), 1000 + ++n) })
    const run = start()
    await tick(19_500)
    expect(run.status).toBe('pending')
    await tick(1000)
    expect(run.value?.resultCount).toBe(5)
    expect(run.value?.text).toBe(formatResults('q', 'Google', results(5)))
  })

  it('WS-15 取到的结果全被筛掉 → 页面正文的退路', async () => {
    const bad = results(3).map((r) => ({ ...r, url: 'javascript:void(0)' }))
    page({ state: showing(stateOf(bad)), text: 'body' })
    const run = start()
    await tick(1000)
    expect(run.value?.resultCount).toBe(0)
    expect(run.value?.text).toBe(
      formatPageTextFallback('q', 'Google', 'https://www.google.com/search?q=q', 'body')
    )
  })

  it('WS-15b 一次都没读到状态但正文读得到 → 退路里的地址是请求的那个', async () => {
    page({ state: () => undefined, text: 'some text' })
    const run = start({ query: 'x y' })
    await tick(21_000)
    expect(run.value?.text).toBe(
      formatPageTextFallback('x y', 'Google', searchUrl('x y', 'google'), 'some text')
    )
  })
})

// ─── 人机验证：立刻失败，验证页留着 ─────────────────────

describe('人机验证（这次搜索立刻失败，验证页留在浏览器里）', () => {
  it('WS-16 读到验证页 → 一轮之内以 SearchNeedsHumanCheck 失败；tab 不关，之后也没有人再盯它', async () => {
    const p = page({ state: showing(checkState()) })
    const run = start()
    await tick(400)
    expect(run.status).toBe('err')
    expect(run.error).toBeInstanceOf(mod.SearchNeedsHumanCheck)
    expect(run.error).toBeInstanceOf(Error)
    const error = run.error as InstanceType<typeof mod.SearchNeedsHumanCheck>
    expect(error.engineName).toBe('Google')
    expect(error.name).toBe('SearchNeedsHumanCheck')
    expect(h.closeTab).not.toHaveBeenCalled()
    const reads = p.executeJavaScript.mock.calls.length
    await tick(60_000)
    expect(p.executeJavaScript.mock.calls.length).toBe(reads)
    expect(p.loadURL).not.toHaveBeenCalled()
    expect(h.closeTab).not.toHaveBeenCalled()
    expect(h.createTab).toHaveBeenCalledTimes(1)
  })

  it('WS-17 消息是写给模型的：点名搜索引擎、验证页在浏览器的 tab 里、告诉用户、这一轮别再搜、换个办法', async () => {
    const message = new mod.SearchNeedsHumanCheck('Bing').message
    expect(message.startsWith('Bing is asking for a human check')).toBe(true)
    expect(message).toContain('this search returned nothing')
    expect(message).toContain("open in a tab of ShuviX's browser")
    expect(message).toContain('Tell the user')
    expect(message).toContain('complete the check in that tab')
    expect(message).toContain('Do not wait for them')
    expect(message).toContain('do not call web_search again in this turn')
    expect(message).toContain('another way')
    expect(message).not.toMatch(/Google/)

    h.setting = 'bing'
    page({ state: showing(checkState()) })
    const run = start({ engine: 'bing' })
    await tick(400)
    expect(messageOf(run)).toBe(message)
  })

  it('WS-18 失败时名额还回去：两次都撞上验证之后，别的搜索引擎的两个搜索都能开 tab，第三个排队', async () => {
    page({ state: showing(checkState()) })
    page({ state: showing(checkState()) })
    const a = start({ query: 'qa' })
    const b = start({ query: 'qb' })
    await tick(400)
    expect(a.status).toBe('err')
    expect(b.status).toBe('err')
    const c = start({ engine: 'bing', query: 'qc' })
    const d = start({ engine: 'bing', query: 'qd' })
    const e = start({ engine: 'bing', query: 'qe' })
    await tick(10)
    expect(h.createTab).toHaveBeenCalledTimes(4)
    await tick(1000)
    expect(c.status).toBe('ok')
    expect(d.status).toBe('ok')
    expect(h.createTab).toHaveBeenCalledTimes(5)
    await tick(1000)
    expect(e.status).toBe('ok')
  })

  it('WS-19 并行的两个搜索都撞上验证：只留先到的那张，另一个关掉自己的 tab，两个都是同一句话', async () => {
    page({ state: showing(checkState()) })
    page({ state: showing(checkState()) })
    const a = start({ query: 'qa' })
    const b = start({ query: 'qb' })
    await tick(400)
    expect(a.error).toBeInstanceOf(mod.SearchNeedsHumanCheck)
    expect(b.error).toBeInstanceOf(mod.SearchNeedsHumanCheck)
    expect(messageOf(b)).toBe(messageOf(a))
    expect(h.closeTab.mock.calls).toEqual([['tab-2']])
  })

  it('WS-20 留着的是别的搜索引擎的验证页时撞上自己的验证：也不留第二张', async () => {
    page({ state: showing(checkState()) })
    start({ query: 'qa' })
    await tick(400)
    page({ state: showing(checkState()) })
    const b = start({ engine: 'bing', query: 'qb' })
    await tick(400)
    expect(b.error).toBeInstanceOf(mod.SearchNeedsHumanCheck)
    expect((b.error as { engineName: string }).engineName).toBe('Bing')
    expect(h.closeTab.mock.calls).toEqual([['tab-2']])
  })

  it('WS-23 这些都不是验证页：有结果的页面、字样只在标题里、正文很长的页面', async () => {
    page({ state: showing({ ...resultsState(3), head: "I'm not a robot" }) })
    const a = start()
    await tick(1000)
    expect(a.value?.resultCount).toBe(3)

    page({ state: showing({ ...emptyState(300), title: 'not a robot - Google Search' }) })
    const b = start()
    page({ state: showing({ ...emptyState(3000), head: 'results about “not a robot” tests' }) })
    const c = start()
    await tick(5000)
    expect(b.value?.resultCount).toBe(0)
    expect(c.value?.resultCount).toBe(0)
    expect(h.closeTab.mock.calls.map((call) => call[0]).sort()).toEqual(['tab-1', 'tab-2', 'tab-3'])
  })

  it('WS-24 排着队的搜索轮到时验证页还挂着 → 不开 tab，直接同一句话', async () => {
    const pa = page({ loading: true })
    page({ loading: true })
    const a = start({ query: 'qa' })
    start({ query: 'qb' })
    const c = start({ query: 'qc' })
    await tick(1000)
    expect(h.createTab).toHaveBeenCalledTimes(2)
    pa.state = showing(checkState())
    await tick(400)
    expect(a.error).toBeInstanceOf(mod.SearchNeedsHumanCheck)
    expect(c.error).toBeInstanceOf(mod.SearchNeedsHumanCheck)
    expect(h.createTab).toHaveBeenCalledTimes(2)
    expect(h.closeTab).not.toHaveBeenCalledWith('tab-1')
  })
})

// ─── 人机验证：之后的搜索先看留下的那张 ─────────────────

describe('人机验证（留下的验证页）', () => {
  /** 先来一次撞上验证的搜索，留下 tab-1 */
  async function leaveCheckTab(engine: 'google' | 'bing' = 'google'): Promise<Page> {
    const p = page({ state: showing(checkState()) })
    const run = start({ engine, query: 'first' })
    await tick(400)
    expect(run.error).toBeInstanceOf(mod.SearchNeedsHumanCheck)
    expect(h.closeTab).not.toHaveBeenCalled()
    return p
  }

  it('WS-35 还是验证页、同一个搜索引擎 → 不开 tab、不关它，直接失败；再来一次也一样', async () => {
    const left = await leaveCheckTab()
    const reads = left.executeJavaScript.mock.calls.length
    const b = start({ query: 'qb' })
    await tick(10)
    expect(b.error).toBeInstanceOf(mod.SearchNeedsHumanCheck)
    expect((b.error as { engineName: string }).engineName).toBe('Google')
    expect(left.executeJavaScript.mock.calls.length).toBe(reads + 1)
    expect(left.executeJavaScript.mock.calls.at(-1)).toEqual([SEARCH_PAGE_SCRIPT])
    const c = start({ query: 'qc' })
    await tick(10)
    expect(c.error).toBeInstanceOf(mod.SearchNeedsHumanCheck)
    expect(h.createTab).toHaveBeenCalledTimes(1)
    expect(h.closeTab).not.toHaveBeenCalled()
    expect(left.loadURL).not.toHaveBeenCalled()
    expect(follow).not.toHaveBeenCalled()
  })

  it.each([
    ['undefined', () => undefined],
    ['malformed', () => ({ url: 5 })],
    ['results not a list', () => ({ url: 'https://www.google.com/search?q=q', results: 'x' })],
    ['rejects', () => Promise.reject(new Error('navigating'))],
    ['never answers', () => NEVER]
  ] as Array<[string, () => unknown]>)(
    'WS-36 留下的那张读不出来（%s）按还挂着算',
    async (_name, state) => {
      const left = await leaveCheckTab()
      left.state = state
      const b = start({ query: 'qb' })
      await tick(2900)
      if (_name === 'never answers') expect(b.status).toBe('pending')
      await tick(200)
      expect(b.error).toBeInstanceOf(mod.SearchNeedsHumanCheck)
      expect(h.createTab).toHaveBeenCalledTimes(1)
      expect(h.closeTab).not.toHaveBeenCalled()
    }
  )

  it('WS-37 用户过了、页面还在搜索引擎上 → 收掉那张，照常搜；之后不再看它', async () => {
    const left = await leaveCheckTab()
    left.state = showing(resultsState(5))
    left.location = 'https://www.google.com/search?q=first'
    const b = start({ query: 'qb' })
    await tick(10)
    expect(h.closeTab.mock.calls).toEqual([['tab-1']])
    expect(h.createTab).toHaveBeenCalledTimes(2)
    expect(h.createTab.mock.calls[1]).toEqual([searchUrl('qb', 'google'), { openerSessionId: 'S' }])
    await tick(1000)
    expect(b.value).toEqual({
      engine: 'google',
      resultCount: 5,
      text: formatResults('qb', 'Google', results(5))
    })
    expect(h.closeTab.mock.calls).toEqual([['tab-1'], ['tab-2']])

    const reads = left.executeJavaScript.mock.calls.length
    const c = start({ query: 'qc' })
    await tick(1000)
    expect(c.status).toBe('ok')
    expect(left.executeJavaScript.mock.calls.length).toBe(reads)
    expect(h.closeTab.mock.calls).toEqual([['tab-1'], ['tab-2'], ['tab-3']])
  })

  it.each(['https://news.example/story', 'about:blank', ''])(
    'WS-38 用户过了、那张 tab 已经在看别的（%j）→ 不关它，照常搜，之后不再看它',
    async (location) => {
      const left = await leaveCheckTab()
      left.state = showing(emptyState(5000, 'https://news.example/story'))
      left.location = location
      const b = start({ query: 'qb' })
      await tick(1000)
      expect(b.value?.resultCount).toBe(5)
      expect(h.closeTab.mock.calls).toEqual([['tab-2']])

      // 忘掉了：就算它又变回验证页，也不拦后面的搜索
      left.state = showing(checkState())
      const reads = left.executeJavaScript.mock.calls.length
      const c = start({ query: 'qc' })
      await tick(1000)
      expect(c.status).toBe('ok')
      expect(left.executeJavaScript.mock.calls.length).toBe(reads)
    }
  )

  it.each(['view-gone', 'destroyed'] as const)(
    'WS-39 那张被关了（%s）→ 忘掉它、不去关它，照常搜',
    async (how) => {
      const left = await leaveCheckTab()
      if (how === 'view-gone') h.views.delete('tab-1')
      else left.destroyed = true
      const b = start({ query: 'qb' })
      await tick(1000)
      expect(b.value?.resultCount).toBe(5)
      expect(h.closeTab.mock.calls).toEqual([['tab-2']])
      const c = start({ query: 'qc' })
      await tick(1000)
      expect(c.status).toBe('ok')
      expect(h.closeTab).not.toHaveBeenCalledWith('tab-1')
    }
  )

  it('WS-40 留下的是别的搜索引擎的验证页、还挂着 → 不拦、不碰它；那个搜索引擎的搜索仍然被拦', async () => {
    const left = await leaveCheckTab('google')
    const b = start({ engine: 'bing', query: 'qb' })
    await tick(1000)
    expect(b.value?.engine).toBe('bing')
    expect(b.value?.resultCount).toBe(5)
    expect(h.createTab.mock.calls[1][0]).toBe(searchUrl('qb', 'bing'))
    expect(h.closeTab.mock.calls).toEqual([['tab-2']])
    expect(left.loadURL).not.toHaveBeenCalled()

    const c = start({ engine: 'google', query: 'qc' })
    await tick(10)
    expect(c.error).toBeInstanceOf(mod.SearchNeedsHumanCheck)
    expect(h.createTab).toHaveBeenCalledTimes(2)
    expect(h.closeTab.mock.calls).toEqual([['tab-2']])
  })

  it('WS-41 过了之后又撞上验证 → 旧的收掉，新的这张留下并记住', async () => {
    const left = await leaveCheckTab()
    left.state = showing(resultsState(5))
    page({ state: showing(checkState()) })
    const b = start({ query: 'qb' })
    await tick(400)
    expect(b.error).toBeInstanceOf(mod.SearchNeedsHumanCheck)
    expect(h.closeTab.mock.calls).toEqual([['tab-1']])

    const c = start({ query: 'qc' })
    await tick(10)
    expect(c.error).toBeInstanceOf(mod.SearchNeedsHumanCheck)
    expect(h.createTab).toHaveBeenCalledTimes(2)
    expect(h.closeTab.mock.calls).toEqual([['tab-1']])
  })

  it('WS-42 正在看留下的那张时被中止 → 以 reason 失败，不开 tab、不关它，名额还回去，它还记着', async () => {
    const left = await leaveCheckTab()
    left.state = () => NEVER
    const abort = new AbortController()
    const b = start({ query: 'qb', signal: abort.signal })
    await tick(1000)
    const reason = new Error('stopped')
    abort.abort(reason)
    await tick(1000)
    expect(b.status).toBe('pending')
    await tick(1100)
    expect(b.error).toBe(reason)
    expect(h.createTab).toHaveBeenCalledTimes(1)
    expect(h.closeTab).not.toHaveBeenCalled()

    // 名额还回去了：别的搜索引擎的两个搜索都能开 tab（各自先看一眼留下的那张，3 秒）
    start({ engine: 'bing', query: 'qc' })
    start({ engine: 'bing', query: 'qd' })
    await tick(3100)
    expect(h.createTab).toHaveBeenCalledTimes(3)
    // 还记着：同一个搜索引擎的仍然被拦
    left.state = showing(checkState())
    await tick(2000)
    const e = start({ query: 'qe' })
    await tick(10)
    expect(e.error).toBeInstanceOf(mod.SearchNeedsHumanCheck)
    expect(h.closeTab).not.toHaveBeenCalledWith('tab-1')
  })

  it('WS-42b 留下的那张已经过了、读完时调用已中止 → 以 reason 失败，不收它、不开 tab', async () => {
    const left = await leaveCheckTab()
    let release: (state: unknown) => void = () => undefined
    left.state = () => new Promise((resolve) => (release = resolve))
    const abort = new AbortController()
    const b = start({ query: 'qb', signal: abort.signal })
    await tick(100)
    const reason = new Error('stopped')
    abort.abort(reason)
    release(resultsState(5))
    await tick(10)
    expect(b.error).toBe(reason)
    expect(h.createTab).toHaveBeenCalledTimes(1)
    expect(h.closeTab).not.toHaveBeenCalled()
  })
})

// ─── 不透明跳转链接 ─────────────────────────────────────

describe('Google 的不透明跳转链接', () => {
  const linked = (...urls: string[]): SearchPageState =>
    stateOf(urls.map((url, i) => ({ title: `T${i + 1}`, url, snippet: '' })))

  it('WS-43 一个一个跟，换成真实地址；不走 net.request', async () => {
    page({ state: showing(linked(goto('t1'), 'https://b.com/', goto('t3'))) })
    const pending: Array<(target: string) => void> = []
    follow.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    const run = start()
    await tick(1000)
    expect(follow.mock.calls).toEqual([[goto('t1')]])
    await tick(1000)
    expect(follow).toHaveBeenCalledTimes(1)
    pending[0]('https://a.com/')
    await tick(0)
    expect(follow.mock.calls).toEqual([[goto('t1')], [goto('t3')]])
    expect(run.status).toBe('pending')
    pending[1]('https://c.com/')
    await tick(0)
    expect(run.value?.resultCount).toBe(3)
    expect(run.value?.text).toBe(
      formatResults('q', 'Google', [
        { title: 'T1', url: 'https://a.com/', snippet: '' },
        { title: 'T2', url: 'https://b.com/', snippet: '' },
        { title: 'T3', url: 'https://c.com/', snippet: '' }
      ])
    )
    expect(run.value?.text).not.toContain('goto')
    expect(h.netRequest).not.toHaveBeenCalled()
  })

  it.each([
    ['returns undefined', async () => undefined],
    [
      'throws',
      async () => {
        throw new Error('network')
      }
    ],
    ['returns ftp', async () => 'ftp://x'],
    ['returns another goto link', async () => goto('again')]
  ] as Array<[string, () => Promise<string | undefined>]>)(
    'WS-44 第一次跟不出来（%s）就停，剩下的留着 Google 的链接',
    async (_name, second) => {
      page({ state: showing(linked(goto('t1'), goto('t2'), goto('t3'))) })
      follow.mockImplementationOnce(async () => 'https://a.com/').mockImplementationOnce(second)
      const run = start()
      await tick(1000)
      expect(follow.mock.calls).toEqual([[goto('t1')], [goto('t2')]])
      expect(run.value?.resultCount).toBe(3)
      expect(run.value?.text).toBe(
        formatResults('q', 'Google', [
          { title: 'T1', url: 'https://a.com/', snippet: '' },
          { title: 'T2', url: goto('t2'), snippet: '' },
          { title: 'T3', url: goto('t3'), snippet: '' }
        ])
      )
      expect(run.value?.text.endsWith(GOTO_NOTE)).toBe(true)
    }
  )

  it('WS-45 解开之后指向同一个地址的结果只留第一条，resultCount 按去重后算', async () => {
    page({ state: showing(linked('https://z.com/', goto('t1'), goto('t2'), goto('t3'))) })
    follow
      .mockImplementationOnce(async () => 'https://same.com/')
      .mockImplementationOnce(async () => 'https://same.com/')
      .mockImplementationOnce(async () => 'https://z.com/')
    const run = start()
    await tick(1000)
    expect(follow).toHaveBeenCalledTimes(3)
    expect(run.value?.resultCount).toBe(2)
    expect(run.value?.text).toBe(
      formatResults('q', 'Google', [
        { title: 'T1', url: 'https://z.com/', snippet: '' },
        { title: 'T2', url: 'https://same.com/', snippet: '' }
      ])
    )
  })

  it('WS-46 花在跟链接上的时间有上限：到 4 秒就不再跟下一个', async () => {
    page({ state: showing(linked(goto('t1'), goto('t2'), goto('t3'), goto('t4'))) })
    let n = 0
    follow.mockImplementation(
      () =>
        new Promise((resolve) => {
          const target = `https://r${++n}.example/`
          setTimeout(() => resolve(target), 2500)
        })
    )
    const run = start()
    await tick(1000)
    expect(follow).toHaveBeenCalledTimes(1)
    await tick(2500)
    expect(follow).toHaveBeenCalledTimes(2)
    await tick(2500)
    expect(follow).toHaveBeenCalledTimes(2)
    expect(run.value?.text).toBe(
      formatResults('q', 'Google', [
        { title: 'T1', url: 'https://r1.example/', snippet: '' },
        { title: 'T2', url: 'https://r2.example/', snippet: '' },
        { title: 'T3', url: goto('t3'), snippet: '' },
        { title: 'T4', url: goto('t4'), snippet: '' }
      ])
    )
  })

  it('WS-47 跟链接的途中被中止 → 不再跟下一个，以 reason 失败，关掉 tab', async () => {
    page({ state: showing(linked(goto('t1'), goto('t2'), 'https://c.com/')) })
    let release: (target: string) => void = () => undefined
    follow.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    const abort = new AbortController()
    const run = start({ signal: abort.signal })
    await tick(1000)
    expect(follow).toHaveBeenCalledTimes(1)
    const reason = new Error('stopped')
    abort.abort(reason)
    release('https://a.com/')
    await tick(0)
    expect(run.error).toBe(reason)
    expect(follow).toHaveBeenCalledTimes(1)
    expect(h.closeTab).toHaveBeenCalledWith('tab-1')
  })

  it('WS-48 没有这种链接就不跟（WS-12 的退路里也不跟）', async () => {
    const run = start()
    await tick(1000)
    expect(run.status).toBe('ok')
    expect(follow).not.toHaveBeenCalled()
  })

  describe('WS-49 缺省的跟法（浏览器分区的 net.request）', () => {
    type Handler = (...args: unknown[]) => void
    interface FakeRequest {
      handlers: Record<string, Handler>
      on: Mock<(event: string, cb: Handler) => void>
      end: Mock<() => void>
      abort: Mock<() => void>
    }
    let request: FakeRequest
    const kept = formatResults('q', 'Google', [
      { title: 'T1', url: goto('t1'), snippet: '' },
      { title: 'T2', url: 'https://b.com/', snippet: '' },
      { title: 'T3', url: 'https://c.com/', snippet: '' }
    ])

    beforeEach(() => {
      const handlers: Record<string, Handler> = {}
      request = {
        handlers,
        on: vi.fn((event: string, cb: Handler) => void (handlers[event] = cb)),
        end: vi.fn(),
        abort: vi.fn()
      }
      h.netRequest.mockImplementation(() => request)
      page({ state: showing(linked(goto('t1'), 'https://b.com/', 'https://c.com/')) })
    })

    it('请求的形状：GET、不自动跟跳转、用浏览器分区的会话', async () => {
      start({ followRedirect: undefined })
      await tick(1000)
      expect(h.fromPartition).toHaveBeenCalledWith('persist:test-browser')
      expect(h.netRequest.mock.calls).toEqual([
        [
          {
            url: goto('t1'),
            method: 'GET',
            redirect: 'manual',
            session: { partition: 'persist:test-browser' }
          }
        ]
      ])
      expect(request.end).toHaveBeenCalledTimes(1)
      expect(follow).not.toHaveBeenCalled()
    })

    it('redirect → 换成它指向的地址，请求随即中断', async () => {
      const run = start({ followRedirect: undefined })
      await tick(1000)
      request.handlers.redirect(302, 'GET', 'https://a.com/')
      await tick(0)
      expect(run.value?.text).toBe(
        formatResults('q', 'Google', [
          { title: 'T1', url: 'https://a.com/', snippet: '' },
          { title: 'T2', url: 'https://b.com/', snippet: '' },
          { title: 'T3', url: 'https://c.com/', snippet: '' }
        ])
      )
      expect(request.abort).toHaveBeenCalledTimes(1)
    })

    it.each(['response', 'error'] as const)('%s → 链接留着', async (event) => {
      const run = start({ followRedirect: undefined })
      await tick(1000)
      request.handlers[event](
        event === 'error' ? new Error('net::ERR_FAILED') : { statusCode: 200 }
      )
      await tick(0)
      expect(run.value?.text).toBe(kept)
    })

    it('什么都没等到 → 3 秒后链接留着；之后迟到的 redirect 不改变什么', async () => {
      const run = start({ followRedirect: undefined })
      await tick(1000)
      await tick(2500)
      expect(run.status).toBe('pending')
      await tick(600)
      expect(run.value?.text).toBe(kept)
      expect(() => request.handlers.redirect(302, 'GET', 'https://late.com/')).not.toThrow()
      await tick(0)
      expect(run.value?.text).toBe(kept)
      expect(request.abort).toHaveBeenCalledTimes(1)
    })
  })
})

// ─── 中止与出错 ─────────────────────────────────────────

describe('中止与出错', () => {
  it('WS-25 一开始就已中止 → 以 reason 失败，不开 tab', async () => {
    const abort = new AbortController()
    const reason = new Error('stopped')
    abort.abort(reason)
    const run = start({ signal: abort.signal })
    await tick(0)
    expect(run.error).toBe(reason)
    expect(h.createTab).not.toHaveBeenCalled()
    expect(h.closeTab).not.toHaveBeenCalled()
  })

  it('WS-26 等页面时被中止 → 一轮之内失败，关掉 tab，名额还回去', async () => {
    page({ loading: true })
    const abort = new AbortController()
    const run = start({ signal: abort.signal })
    await tick(450)
    const reason = new Error('stopped')
    abort.abort(reason)
    await tick(300)
    expect(run.error).toBe(reason)
    expect(h.closeTab.mock.calls).toEqual([['tab-1']])
    start()
    start()
    await tick(0)
    expect(h.createTab).toHaveBeenCalledTimes(3)
  })

  it('WS-27 读到验证页的那一轮调用已中止 → 以 reason 失败，tab 关掉、不留作验证页', async () => {
    page({ state: showing(checkState()) })
    const abort = new AbortController()
    const run = start({ signal: abort.signal })
    await tick(100)
    const reason = new Error('stopped')
    abort.abort(reason)
    await tick(300)
    expect(run.error).toBe(reason)
    expect(h.closeTab.mock.calls).toEqual([['tab-1']])
    const next = start()
    await tick(1000)
    expect(next.status).toBe('ok')
  })

  it('WS-28 createTab 抛错 → 原样失败，没有 tab 可关，名额还回去', async () => {
    const error = new Error('too many tabs')
    h.createTab.mockImplementationOnce(() => {
      throw error
    })
    const run = start()
    await tick(0)
    expect(run.error).toBe(error)
    expect(h.closeTab).not.toHaveBeenCalled()
    start()
    start()
    await tick(0)
    expect(h.createTab).toHaveBeenCalledTimes(3)
  })
})

// ─── 并发 ───────────────────────────────────────────────

describe('并发上限', () => {
  it('WS-29 同时至多两个搜索 tab；第三个等前面有一个收场；各关各的', async () => {
    const p1 = page({ loading: true })
    const p2 = page({ loading: true })
    const a = start({ query: 'q1' })
    const b = start({ query: 'q2' })
    const c = start({ query: 'q3' })
    await tick(3000)
    expect(h.createTab).toHaveBeenCalledTimes(2)
    p1.loading = false
    await tick(300)
    expect(a.status).toBe('ok')
    expect(h.createTab).toHaveBeenCalledTimes(3)
    expect(h.createTab.mock.calls[2][0]).toBe(searchUrl('q3', 'google'))
    p2.loading = false
    await tick(1000)
    expect(b.status).toBe('ok')
    expect(c.status).toBe('ok')
    expect(h.closeTab.mock.calls.map((call) => call[0]).sort()).toEqual(['tab-1', 'tab-2', 'tab-3'])
  })

  it('WS-30 排着队的被中止 → 失败、不开 tab；后来的照样等到有名额才开', async () => {
    const p1 = page({ loading: true })
    page({ loading: true })
    start({ query: 'q1' })
    start({ query: 'q2' })
    const abort = new AbortController()
    const c = start({ query: 'q3', signal: abort.signal })
    await tick(1000)
    const reason = new Error('stopped')
    abort.abort(reason)
    await tick(0)
    expect(c.error).toBe(reason)
    const d = start({ query: 'q4' })
    await tick(3000)
    expect(h.createTab).toHaveBeenCalledTimes(2)
    p1.loading = false
    await tick(300)
    expect(h.createTab).toHaveBeenCalledTimes(3)
    expect(h.createTab.mock.calls[2][0]).toBe(searchUrl('q4', 'google'))
    await tick(1000)
    expect(d.status).toBe('ok')
  })

  it('WS-31 失败的搜索同样把名额还回去', async () => {
    page({ loading: true })
    page({ loading: true })
    const a = start({ query: 'q1' })
    start({ query: 'q2' })
    const c = start({ query: 'q3' })
    await tick(1000)
    expect(h.createTab).toHaveBeenCalledTimes(2)
    h.views.delete('tab-1')
    await tick(300)
    expect(messageOf(a)).toBe(TAB_GONE)
    expect(h.createTab).toHaveBeenCalledTimes(3)
    await tick(1000)
    expect(c.status).toBe('ok')
  })
})
