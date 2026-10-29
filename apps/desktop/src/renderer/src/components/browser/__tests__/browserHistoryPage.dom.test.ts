// @vitest-environment jsdom
/**
 * 历史记录页（BrowserHistoryPage，内部页面 shuvix://history）。
 *
 *   HP-1  挂载时 list({search:'', actor:'all', cursor:null, limit:100}) 一次，回来之前是转圈；一行都没有 → 空态
 *         「Pages you visit will appear here」；带搜索 / 过滤时 → 「No results」
 *   HP-2  按 item.day 分组、照收到的顺序；标题「Today - …」「Yesterday - …」、更早的只有日期
 *   HP-3  一行：时间、站点图标（没有 / 加载失败 → 地球）、标题（没有 → 显示的网址）、主机名、访问次数 > 1 才有 ×N
 *   HP-4  agent 打开的那行：会话标题 + 那个会话颜色的圆点；标题空 → Deleted conversation；点它 →
 *         browserView.openSession(sid)；用户的行没有
 *   HP-5  点一行 → navigate(tabId, url)（恰好两个参数：历史记录页里的导航不是从地址栏来的）；⌘ / Ctrl 点、中键点 →
 *         createTab(url)；默认动作都拦下
 *   HP-6  ×：那一行当场没了、remove([key])；remove 失败不抛、那一行也不回来
 *   HP-7  搜索框停手 200ms、trim 之后 → list({search, cursor:null})；All / Yours / Agents → actor all / user / agent，
 *         aria-pressed 跟着；上一次查询晚到的结果丢掉
 *   HP-8  只有 next 不为空时才有触底的哨兵；它进视野 → list(cursor = next)、结果接在后面；在途时不再要；换了搜索 /
 *         过滤之后旧 cursor 的哨兵进视野什么也不做（不拿旧 cursor 去要），旧 cursor 那一页晚到了也不接上去
 *   HP-9  清除浏览历史要确认：取消不清；确认 → clear() 一次、再从头 list 一次，清的时候按钮禁用；没有行、没有过滤时
 *         清除按钮禁用，设了过滤就可用
 *
 * `window.api` 是 browserDomSupport 的假件；store 是真的；真 en 文案。假时钟（搜索框的 200ms、Date 钉在本地
 * 2026-10-29 15:00 —— 「今天 / 昨天」按它算）。IntersectionObserver 是手动触发的桩；sessionColor 换成回普通 rgb()
 * 的替身（jsdom 的 CSS 解析不认 light-dark()）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { BrowserHistoryPage } from '../BrowserHistoryPage'
import { useBrowserTabsStore } from '../../../stores/browserTabsStore'
import type { HistoryItem, HistoryListResult } from '../../../../../shared/browserHistory'
import {
  click,
  initEnI18n,
  installFakeApi,
  installRaf,
  mountInto,
  type FakeApi,
  type Mounted
} from './browserDomSupport'

vi.mock('../sessionColor', () => ({
  sessionDotColor: (id: string) => (id === 's1' ? 'rgb(1, 2, 3)' : 'rgb(4, 5, 6)'),
  INTERCEPTING_DOT_COLOR: 'rgb(217, 119, 6)'
}))

let api: FakeApi
let m: Mounted | null = null

const TODAY = '2026-10-29'
const YESTERDAY = '2026-10-28'
const OLDER = '2026-10-20'
/** 本地某天某时（月份从 1 起） */
const at = (day: string, h: number, mi = 0): number => {
  const [y, mo, d] = day.split('-').map(Number)
  return new Date(y, mo - 1, d, h, mi).getTime()
}

function item(over: Partial<HistoryItem> & { url: string }): HistoryItem {
  const day = over.day ?? TODAY
  return {
    key: `${day}|${over.url.length}|${over.sessionId ?? ''}`,
    day,
    title: '',
    favicon: '',
    lastAt: at(day, 10),
    count: 1,
    ...over
  }
}
const page = (items: HistoryItem[], next: number | null = null): HistoryListResult => ({
  items,
  next
})

/** 一个从外面结束的 list 回答 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: Error) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ─── IntersectionObserver 桩：记下每个观察者，intersect() 只叫醒还连着的 ───
interface FakeIO {
  callback: IntersectionObserverCallback
  targets: Element[]
  live: boolean
}
let observers: FakeIO[] = []
function installIntersectionObserver(): void {
  observers = []
  class IO {
    private readonly rec: FakeIO
    constructor(callback: IntersectionObserverCallback) {
      this.rec = { callback, targets: [], live: true }
      observers.push(this.rec)
    }
    observe(el: Element): void {
      this.rec.targets.push(el)
    }
    unobserve(): void {}
    disconnect(): void {
      this.rec.live = false
    }
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO
}
/** 此刻还连着、在看着某个元素的观察者 */
const watching = (): FakeIO[] => observers.filter((o) => o.live && o.targets.length > 0)
/** 哨兵进视野：叫醒每个还连着的观察者 */
function intersect(): void {
  const live = watching()
  act(() => {
    for (const o of live) {
      o.callback(
        o.targets.map((target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry),
        {} as IntersectionObserver
      )
    }
  })
}

async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await tick(0)
}

async function mount(): Promise<void> {
  m = await mountInto(BrowserHistoryPage, { tabId: 't1' })
  await settle()
}

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [
  ...m!.container.querySelectorAll<T>(sel)
]
const itemUrls = (): string[] =>
  $$('[data-history-item]').map((r) => r.getAttribute('data-history-url')!)
const rowOf = (url: string): HTMLElement => {
  const el = $(`[data-history-url="${url}"]`)
  if (!el) throw new Error(`no history row for ${url} (have ${itemUrls().join(', ')})`)
  return el
}
const listCalls = (): unknown[] => api.browserHistory.list.mock.calls.map(([q]) => q)
const searchBox = (): HTMLInputElement => $<HTMLInputElement>('[data-history-search]')!
const filter = (id: string): HTMLButtonElement =>
  $<HTMLButtonElement>(`[data-history-filter="${id}"]`)!
const buttonByText = (text: string): HTMLButtonElement | undefined =>
  $$<HTMLButtonElement>('button').find((b) => b.textContent?.trim() === text)

function typeSearch(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(searchBox(), value)
    searchBox().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const dateOf = (day: string): string => {
  const [y, mo, d] = day.split('-').map(Number)
  return new Intl.DateTimeFormat('en', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(new Date(y, mo - 1, d))
}
const timeOf = (ms: number): string =>
  new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms))

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 29, 15, 0))
  api = installFakeApi()
  installRaf()
  installIntersectionObserver()
  useBrowserTabsStore.setState({ tabs: [], activeTabId: null })
})

afterEach(() => {
  m?.unmount()
  m = null
  vi.useRealTimers()
})

describe('第一页与空态（HP-1）', () => {
  it("HP-1 挂载：list({search:'', actor:'all', cursor:null, limit:100}) 一次；回来之前是转圈", async () => {
    const d = deferred<HistoryListResult>()
    api.browserHistory.list.mockImplementation(() => d.promise)
    m = await mountInto(BrowserHistoryPage, { tabId: 't1' })
    await tick(0)
    expect(listCalls()).toEqual([{ search: '', actor: 'all', cursor: null, limit: 100 }])
    expect($('[data-browser-history-page] .animate-spin')).not.toBeNull()
    expect($('[data-history-empty]')).toBeNull()

    await act(async () => d.resolve(page([])))
    await settle()
    expect($('[data-history-empty]')?.textContent).toBe('Pages you visit will appear here')
    expect($('.animate-spin')).toBeNull()
    // 停手的 200ms 过了也不再要一次（搜索词没变）
    await tick(500)
    expect(listCalls()).toHaveLength(1)
  })

  it('HP-1 设了过滤或搜索、一行都没有 → No results', async () => {
    await mount()
    click(filter('agent'))
    await settle()
    expect($('[data-history-empty]')?.textContent).toBe('No results')

    click(filter('all'))
    await settle()
    expect($('[data-history-empty]')?.textContent).toBe('Pages you visit will appear here')
    typeSearch('zzz')
    await tick(200)
    await settle()
    expect($('[data-history-empty]')?.textContent).toBe('No results')
  })

  it('HP-1 list 失败：当作空的（不留在转圈）', async () => {
    api.browserHistory.list.mockRejectedValue(new Error('boom'))
    await mount()
    expect($('.animate-spin')).toBeNull()
    expect($('[data-history-empty]')).not.toBeNull()
  })
})

describe('按天分组（HP-2）', () => {
  it('HP-2 按 day 分组、照收到的顺序；Today - … / Yesterday - … / 只有日期', async () => {
    api.browserHistory.list.mockResolvedValue(
      page([
        item({ url: 'https://a.test/', day: TODAY }),
        item({ url: 'https://b.test/x', day: TODAY }),
        item({ url: 'https://c.test/xy', day: YESTERDAY }),
        item({ url: 'https://d.test/xyz', day: OLDER })
      ])
    )
    await mount()
    const days = $$('[data-history-day]')
    expect(days.map((d) => d.getAttribute('data-history-day'))).toEqual([TODAY, YESTERDAY, OLDER])
    expect(days.map((d) => d.querySelector('h2')?.textContent)).toEqual([
      `Today - ${dateOf(TODAY)}`,
      `Yesterday - ${dateOf(YESTERDAY)}`,
      dateOf(OLDER)
    ])
    expect(
      [...days[0].querySelectorAll('[data-history-item]')].map((r) =>
        r.getAttribute('data-history-url')
      )
    ).toEqual(['https://a.test/', 'https://b.test/x'])
  })
})

describe('一行的样子（HP-3 / HP-4）', () => {
  it('HP-3 时间、图标、标题、主机名、×N 只在次数 > 1 时', async () => {
    const lastAt = at(TODAY, 9, 5)
    api.browserHistory.list.mockResolvedValue(
      page([
        item({
          url: 'https://a.test:8443/p',
          title: 'Alpha',
          favicon: 'https://a.test/f.ico',
          count: 3,
          lastAt
        }),
        item({ url: 'https://zh.wikipedia.org/wiki/%E5%8C%97%E4%BA%AC', count: 1 })
      ])
    )
    await mount()
    const a = rowOf('https://a.test:8443/p')
    expect(a.textContent).toContain(timeOf(lastAt))
    expect(a.querySelector('img')?.getAttribute('src')).toBe('https://a.test/f.ico')
    expect(a.querySelector('svg.lucide-globe')).toBeNull()
    expect(a.querySelector('[data-history-open]')?.textContent).toBe('Alpha')
    expect(a.textContent).toContain('a.test:8443')
    expect(a.textContent).toContain('×3')

    const wiki = rowOf('https://zh.wikipedia.org/wiki/%E5%8C%97%E4%BA%AC')
    expect(wiki.querySelector('img')).toBeNull()
    expect(wiki.querySelector('svg.lucide-globe')).not.toBeNull()
    // 没有标题：显示的网址（去协议、转义还原）
    expect(wiki.querySelector('[data-history-open]')?.textContent).toBe(
      'zh.wikipedia.org/wiki/北京'
    )
    expect(wiki.textContent).toContain('zh.wikipedia.org')
    expect(wiki.textContent).not.toContain('×')
  })

  it('HP-3 图标加载失败 → 地球', async () => {
    api.browserHistory.list.mockResolvedValue(
      page([item({ url: 'https://a.test/', favicon: 'https://a.test/broken.ico' })])
    )
    await mount()
    const img = rowOf('https://a.test/').querySelector('img')!
    act(() => {
      img.dispatchEvent(new Event('error'))
    })
    expect(rowOf('https://a.test/').querySelector('img')).toBeNull()
    expect(rowOf('https://a.test/').querySelector('svg.lucide-globe')).not.toBeNull()
  })

  it('HP-4 agent 的行：会话标题 + 那个会话颜色的圆点；标题空 → Deleted conversation；点 → openSession；用户的行没有', async () => {
    api.browserHistory.list.mockResolvedValue(
      page([
        item({ url: 'https://agent.test/', sessionId: 's1', sessionTitle: 'Research run' }),
        item({ url: 'https://gone.test/', sessionId: 's2', sessionTitle: '' }),
        item({ url: 'https://mine.test/' })
      ])
    )
    await mount()
    const chip = rowOf('https://agent.test/').querySelector<HTMLElement>('[data-history-agent]')!
    expect(chip.getAttribute('data-history-agent')).toBe('s1')
    expect(chip.textContent).toBe('Research run')
    expect(chip.querySelector<HTMLElement>('span')!.style.background).toBe('rgb(1, 2, 3)')
    expect(rowOf('https://agent.test/').getAttribute('data-history-session')).toBe('s1')

    const gone = rowOf('https://gone.test/').querySelector<HTMLElement>('[data-history-agent]')!
    expect(gone.textContent).toBe('Deleted conversation')
    expect(gone.querySelector<HTMLElement>('span')!.style.background).toBe('rgb(4, 5, 6)')

    const mine = rowOf('https://mine.test/')
    expect(mine.querySelector('[data-history-agent]')).toBeNull()
    expect(mine.hasAttribute('data-history-session')).toBe(false)

    click(chip)
    expect(api.browserView.openSession.mock.calls).toEqual([['s1']])
    expect(api.browserView.navigate).not.toHaveBeenCalled()
  })
})

describe('打开一行（HP-5）', () => {
  const URL = 'https://a.test/page'
  beforeEach(() => {
    api.browserHistory.list.mockResolvedValue(page([item({ url: URL, title: 'A page' })]))
  })
  const link = (): HTMLAnchorElement =>
    rowOf(URL).querySelector<HTMLAnchorElement>('[data-history-open]')!
  function clickLink(init: MouseEventInit = {}): MouseEvent {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
    act(() => {
      link().dispatchEvent(e)
    })
    return e
  }

  it('HP-5 点一行 → navigate(t1, url)（恰好两个参数），默认动作拦下', async () => {
    await mount()
    expect(clickLink().defaultPrevented).toBe(true)
    expect(api.browserView.navigate.mock.calls).toEqual([['t1', URL]])
    expect(api.browserView.createTab).not.toHaveBeenCalled()
  })

  it.each([{ metaKey: true }, { ctrlKey: true }])('HP-5 %j 点 → createTab(url)', async (mods) => {
    await mount()
    expect(clickLink(mods).defaultPrevented).toBe(true)
    expect(api.browserView.createTab.mock.calls).toEqual([[URL]])
    expect(api.browserView.navigate).not.toHaveBeenCalled()
  })

  it('HP-5 中键点 → createTab(url)；别的键的 auxclick 不理', async () => {
    await mount()
    const middle = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    act(() => {
      link().dispatchEvent(middle)
    })
    expect(middle.defaultPrevented).toBe(true)
    expect(api.browserView.createTab.mock.calls).toEqual([[URL]])

    const right = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 })
    act(() => {
      link().dispatchEvent(right)
    })
    expect(right.defaultPrevented).toBe(false)
    expect(api.browserView.createTab).toHaveBeenCalledTimes(1)
  })
})

describe('删一行（HP-6）', () => {
  const A = item({ url: 'https://a.test/', day: TODAY })
  const B = item({ url: 'https://b.test/x', day: TODAY })

  it('HP-6 ×：那一行当场没了、remove([key])', async () => {
    const d = deferred<void>()
    api.browserHistory.remove.mockImplementation(() => d.promise)
    api.browserHistory.list.mockResolvedValue(page([A, B]))
    await mount()
    click(rowOf(A.url).querySelector('[data-history-remove]')!)
    expect(itemUrls()).toEqual([B.url])
    expect(api.browserHistory.remove.mock.calls).toEqual([[[A.key]]])
    await act(async () => d.resolve())
    await settle()
    expect(itemUrls()).toEqual([B.url])
  })

  it('HP-6 remove 失败：不抛、那一行也不回来', async () => {
    api.browserHistory.remove.mockRejectedValue(new Error('locked'))
    api.browserHistory.list.mockResolvedValue(page([A, B]))
    await mount()
    click(rowOf(A.url).querySelector('[data-history-remove]')!)
    await settle()
    expect(itemUrls()).toEqual([B.url])
  })
})

describe('搜索与过滤（HP-7）', () => {
  it('HP-7 搜索框停手 200ms、trim → list({search, cursor:null})', async () => {
    await mount()
    typeSearch('  gi')
    await tick(100)
    typeSearch('  git ')
    await tick(199)
    expect(listCalls()).toHaveLength(1)
    await tick(1)
    await settle()
    expect(listCalls()).toEqual([
      { search: '', actor: 'all', cursor: null, limit: 100 },
      { search: 'git', actor: 'all', cursor: null, limit: 100 }
    ])
  })

  it('HP-7 All / Yours / Agents → actor all / user / agent；aria-pressed 跟着', async () => {
    await mount()
    expect(filter('all').getAttribute('aria-pressed')).toBe('true')
    click(filter('user'))
    await settle()
    expect(filter('user').getAttribute('aria-pressed')).toBe('true')
    expect(filter('all').getAttribute('aria-pressed')).toBe('false')
    click(filter('agent'))
    await settle()
    click(filter('all'))
    await settle()
    expect(listCalls().map((q) => (q as { actor: string }).actor)).toEqual([
      'all',
      'user',
      'agent',
      'all'
    ])
    expect(listCalls().every((q) => (q as { cursor: unknown }).cursor === null)).toBe(true)
    expect([filter('all'), filter('user'), filter('agent')].map((b) => b.textContent)).toEqual([
      'All',
      'Yours',
      'Agents'
    ])
  })

  it('HP-7 上一次查询晚到的结果丢掉', async () => {
    const first = deferred<HistoryListResult>()
    api.browserHistory.list
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(page([item({ url: 'https://agent.test/', sessionId: 's1' })]))
    m = await mountInto(BrowserHistoryPage, { tabId: 't1' })
    await tick(0)
    click(filter('agent'))
    await settle()
    expect(itemUrls()).toEqual(['https://agent.test/'])

    await act(async () => first.resolve(page([item({ url: 'https://stale.test/' })], 99)))
    await settle()
    expect(itemUrls()).toEqual(['https://agent.test/'])
    expect(watching()).toEqual([])
  })
})

describe('翻页（HP-8）', () => {
  const P1 = [item({ url: 'https://p1.test/' })]
  const P2 = [item({ url: 'https://p2.test/x' })]

  it('HP-8 没有下一页：没有哨兵', async () => {
    api.browserHistory.list.mockResolvedValue(page(P1, null))
    await mount()
    expect(watching()).toEqual([])
  })

  it('HP-8 有下一页：哨兵进视野 → list(cursor = next)、接在后面；在途时不再要；没有更多之后哨兵没了', async () => {
    const second = deferred<HistoryListResult>()
    api.browserHistory.list
      .mockResolvedValueOnce(page(P1, 42))
      .mockImplementationOnce(() => second.promise)
    await mount()
    expect(watching()).toHaveLength(1)

    intersect()
    await settle()
    intersect()
    await settle()
    expect(listCalls()).toEqual([
      { search: '', actor: 'all', cursor: null, limit: 100 },
      { search: '', actor: 'all', cursor: 42, limit: 100 }
    ])

    await act(async () => second.resolve(page(P2, null)))
    await settle()
    expect(itemUrls()).toEqual(['https://p1.test/', 'https://p2.test/x'])
    expect(watching()).toEqual([])
  })

  it('HP-8 换了过滤、新的一页还没回来：旧 cursor 的哨兵进视野什么也不做', async () => {
    const filtered = deferred<HistoryListResult>()
    api.browserHistory.list
      .mockResolvedValueOnce(page(P1, 42))
      .mockImplementationOnce(() => filtered.promise)
    await mount()
    click(filter('user'))
    await settle()
    intersect()
    await settle()
    expect(listCalls()).toEqual([
      { search: '', actor: 'all', cursor: null, limit: 100 },
      { search: '', actor: 'user', cursor: null, limit: 100 }
    ])
    await act(async () => filtered.resolve(page([item({ url: 'https://mine.test/' })], null)))
    await settle()
    expect(itemUrls()).toEqual(['https://mine.test/'])
  })

  it('HP-8 旧 cursor 那一页在途时换了搜索：它晚到了也不接上去', async () => {
    const stale = deferred<HistoryListResult>()
    api.browserHistory.list
      .mockResolvedValueOnce(page(P1, 42))
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(page([item({ url: 'https://fresh.test/' })], null))
    await mount()
    intersect()
    await settle()
    expect(listCalls()).toHaveLength(2)

    typeSearch('fresh')
    await tick(200)
    await settle()
    expect(listCalls().at(-1)).toEqual({ search: 'fresh', actor: 'all', cursor: null, limit: 100 })
    expect(itemUrls()).toEqual(['https://fresh.test/'])

    await act(async () => stale.resolve(page(P2, 7)))
    await settle()
    expect(itemUrls()).toEqual(['https://fresh.test/'])
    expect(watching()).toEqual([])
  })
})

describe('清除浏览历史（HP-9）', () => {
  it('HP-9 取消：不清', async () => {
    api.browserHistory.list.mockResolvedValue(page([item({ url: 'https://a.test/' })]))
    await mount()
    click($('[data-history-clear]')!)
    expect($('[data-history-clear-confirm]')?.textContent).toContain('Clear all history')
    click(buttonByText('Cancel')!)
    expect($('[data-history-clear-confirm]')).toBeNull()
    expect(api.browserHistory.clear).not.toHaveBeenCalled()
    expect(listCalls()).toHaveLength(1)
  })

  it('HP-9 确认：clear() 一次、清的时候按钮禁用；之后从头 list 一次，回到清除按钮', async () => {
    const d = deferred<void>()
    api.browserHistory.clear.mockImplementation(() => d.promise)
    api.browserHistory.list
      .mockResolvedValueOnce(page([item({ url: 'https://a.test/' })]))
      .mockResolvedValueOnce(page([]))
    await mount()
    click($('[data-history-clear]')!)
    click($('[data-history-clear-confirm]')!)
    await tick(0)
    expect(api.browserHistory.clear).toHaveBeenCalledTimes(1)
    expect($<HTMLButtonElement>('[data-history-clear-confirm]')!.disabled).toBe(true)
    expect(buttonByText('Cancel')!.disabled).toBe(true)

    await act(async () => d.resolve())
    await settle()
    expect(listCalls()).toEqual([
      { search: '', actor: 'all', cursor: null, limit: 100 },
      { search: '', actor: 'all', cursor: null, limit: 100 }
    ])
    expect(api.browserHistory.list.mock.invocationCallOrder[1]).toBeGreaterThan(
      api.browserHistory.clear.mock.invocationCallOrder[0]
    )
    expect($('[data-history-clear-confirm]')).toBeNull()
    expect(itemUrls()).toEqual([])
    expect($<HTMLButtonElement>('[data-history-clear]')!.disabled).toBe(true)
  })

  it('HP-9 没有行、没有过滤：清除按钮禁用；设了过滤（哪怕没有行）就可用', async () => {
    await mount()
    expect($<HTMLButtonElement>('[data-history-clear]')!.disabled).toBe(true)
    click(filter('agent'))
    await settle()
    expect($<HTMLButtonElement>('[data-history-clear]')!.disabled).toBe(false)
    click(filter('all'))
    await settle()
    typeSearch('x')
    await tick(200)
    await settle()
    expect($<HTMLButtonElement>('[data-history-clear]')!.disabled).toBe(false)
  })

  it('HP-9 有行：清除按钮可用', async () => {
    api.browserHistory.list.mockResolvedValue(page([item({ url: 'https://a.test/' })]))
    await mount()
    expect($<HTMLButtonElement>('[data-history-clear]')!.disabled).toBe(false)
  })
})
