// @vitest-environment jsdom
/**
 * 地址栏组件（OmniboxField.tsx 的 Omnibox）—— 下拉建议、内联补全、键盘、回车开什么、页面区的截图。
 *
 *   OF-1   进编辑没打字：不问历史、不弹下拉；打字后每个键都 suggest(敲的字)
 *   OF-2   搜索建议：停手 120ms 才问一次 searchSuggest(trim 过的字, 引擎)；prop 关着、localhost:3000 / https://x
 *          不问；建议那几行补出来的部分加粗、没有「— Google Search」，「搜这段字」那行有
 *   OF-3   下拉先要一张页面区的截图顶上：原生页面 → capture(tabId, round(页面区宽 × dpr)) 一次，抓到之前不弹，
 *          抓到之后 pageCover {tabId, snapshot}、弹出；抓图失败 → snapshot ''、照弹；Esc / 失焦 / 回车 →
 *          pageCover null；空白页 / 内部页面 / 平铺墙 → 不抓图、snapshot ''、立刻弹
 *   OF-4   敲过的 github，打 git → 地址栏 github.com、选中 [3, 10]、aria-autocomplete both、第一行是网址
 *   OF-5   接着打 h（替换掉选中的部分）→ 仍是 github.com、[4, 10]；打 x → gitx、不补
 *   OF-6   退格（删掉补上的那段）→ git、不补、第一行是搜索；再打一个字又补
 *   OF-7   ← / → / Home / End 或在输入框里按下鼠标：收下补上的字（回车 → navigate(t1, https://github.com, typed)）；
 *          收下之后退格不再补
 *   OF-8   输入法组字中、光标不在末尾：不补；组字中的 Enter 什么也不做
 *   OF-9   ↓ 选第 1 行（aria-selected、aria-activedescendant omnibox-suggestions-1、地址栏显示那一行的字）；↑ 回去；
 *          到头停住；Tab / ⇧Tab 一样；带 ⌘ / Ctrl / Alt 的不动；没弹下拉时方向键不拦
 *   OF-10  Esc：选着第 2 行 → 第一下回到第 0 行、自己敲的字、仍在编辑；第二下结束编辑、不导航、显示复原；
 *          有内联补全时第一下撤掉补全（git、第 0 行是搜索）、第二下结束；没有补全、在第 0 行 → 一下结束
 *   OF-11  回车按行的种类：网址 → navigate(t1, url, typed)；搜索建议 → navigate(t1, Google(q), generated)；
 *          历史 → typed；「切换到此标签页」→ 只 activateTab(id)；没有选中的页 → createTab(url, transition)
 *   OF-12  点一行 = 在那一行上回车；行上 mousedown 不让输入框失焦
 *   OF-13  ⇧Delete 删选着的历史行：removeUrl 一次、在它回来之前那一行就没了、选中上移一行、回来之后再问一次历史；
 *          网址 / 搜索 / 切换行上什么也不做（不拦）；行尾的 × 同样删、不导航、仍在编辑
 *   OF-14  切换行有「Switch to this tab」标签；× 只在历史行上；敲的词（不分大小写）在网址与标题里加粗
 *
 * `window.api` 是 browserDomSupport 的假件；store 是真的；真 en 文案。假时钟（setTimeout / rAF / Date）：
 * 打分用的「此刻」是进编辑时的 Date.now()，钉在 NOW。打字走原生 value setter + 光标放到末尾 + InputEvent。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { Omnibox } from '../OmniboxField'
import { useBrowserTabsStore, type BrowserTabInfo } from '../../../stores/browserTabsStore'
import type { HistorySuggestion } from '../../../../../shared/browserHistory'
import {
  click,
  initEnI18n,
  installFakeApi,
  installRaf,
  mountInto,
  mouseDown,
  tabInfo,
  type FakeApi,
  type Mounted
} from './browserDomSupport'

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0)
const google = (q: string): string => `https://www.google.com/search?q=${encodeURIComponent(q)}`

let api: FakeApi
let m: Mounted | null = null

const T1 = tabInfo({ id: 't1', url: 'https://example.com/page', title: 'Example' })

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
const GH = hist('https://github.com/', { typedCount: 1, title: 'GitHub' })

/** 让假时钟走 ms（定时器、rAF、其间的微任务都跑完），在 act 里 */
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
/** 排着的帧与 resolved 的 IPC 回答都落定 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await tick(0)
}

async function mount(
  props: {
    tab?: BrowserTabInfo | null
    others?: BrowserTabInfo[]
    searchSuggest?: boolean
    viewMode?: 'single' | 'wall'
  } = {}
): Promise<void> {
  const tab = props.tab === undefined ? T1 : props.tab
  useBrowserTabsStore.setState({
    tabs: [...(tab ? [tab] : []), ...(props.others ?? [])],
    activeTabId: tab?.id ?? null,
    pageCover: null,
    omniboxFocusNonce: 0
  })
  m = await mountInto(Omnibox, {
    tab,
    engine: 'google',
    searchSuggest: props.searchSuggest ?? true,
    viewMode: props.viewMode ?? 'single'
  })
}

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const input = (): HTMLInputElement | null => $<HTMLInputElement>('[data-omnibox-input]')
const popup = (): HTMLElement | null => $('[data-omnibox-popup]')
const rows = (): HTMLElement[] => [
  ...m!.container.querySelectorAll<HTMLElement>('[data-omnibox-match]')
]
const rowKeys = (): string[] => rows().map((r) => r.getAttribute('data-omnibox-key') ?? '')
const row = (key: string): HTMLElement => {
  const el = $(`[data-omnibox-key="${key}"]`)
  if (!el) throw new Error(`no row ${key} (have ${rowKeys().join(', ')})`)
  return el
}
const selectedIndex = (): number =>
  rows().findIndex((r) => r.getAttribute('aria-selected') === 'true')
const sel = (): [number | null, number | null] => [input()!.selectionStart, input()!.selectionEnd]

/** 点地址栏进编辑（mousedown + 一帧：input 挂上、聚焦、整段选中） */
async function beginEdit(): Promise<HTMLInputElement> {
  mouseDown($('[data-omnibox-display]')!)
  await settle()
  const el = input()
  if (!el) throw new Error('omnibox did not enter edit mode')
  return el
}

/**
 * 往地址栏「打」字：原生 value setter、光标放到 caret（缺省末尾）、一个 InputEvent（inputType 缺省 insertText）
 */
function type(
  value: string,
  opts: { inputType?: string; isComposing?: boolean; caret?: number } = {}
): void {
  const el = input()!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    const caret = opts.caret ?? value.length
    el.setSelectionRange(caret, caret)
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: opts.inputType ?? 'insertText',
        isComposing: !!opts.isComposing
      })
    )
  })
}
/** 打完一段字、等历史回来、截图顶上、下拉弹出 */
async function typeAndSettle(value: string, opts?: Parameters<typeof type>[1]): Promise<void> {
  type(value, opts)
  await settle()
}

/** 在输入框上按一个键，回事件（看 defaultPrevented） */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    input()!.dispatchEvent(event)
  })
  return event
}

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  api = installFakeApi()
  installRaf()
})

afterEach(() => {
  m?.unmount()
  m = null
  document.querySelectorAll('[data-page-area]').forEach((el) => el.remove())
  vi.useRealTimers()
})

describe('什么时候问（OF-1 / OF-2）', () => {
  it('OF-1 进编辑没打字：不问历史、不弹、不抓图', async () => {
    await mount()
    const el = await beginEdit()
    expect(el.value).toBe('https://example.com/page')
    await tick(500)
    expect(api.browserHistory.suggest).not.toHaveBeenCalled()
    expect(api.browserHistory.searchSuggest).not.toHaveBeenCalled()
    expect(api.browserView.capture).not.toHaveBeenCalled()
    expect(popup()).toBeNull()
  })

  it('OF-1 打字：每个键都 suggest(敲的字)', async () => {
    await mount()
    await beginEdit()
    type('g')
    type('gi')
    type('git')
    await settle()
    expect(api.browserHistory.suggest.mock.calls).toEqual([['g'], ['gi'], ['git']])
  })

  it('OF-2 停手 120ms 才问一次搜索建议（trim 过的字、引擎）', async () => {
    await mount()
    await beginEdit()
    type('g')
    await tick(50)
    type('gi')
    await tick(50)
    type('git ')
    await tick(119)
    expect(api.browserHistory.searchSuggest).not.toHaveBeenCalled()
    await tick(1)
    expect(api.browserHistory.searchSuggest.mock.calls).toEqual([['git', 'google']])
    await tick(1000)
    expect(api.browserHistory.searchSuggest).toHaveBeenCalledTimes(1)
  })

  it('OF-2 prop 关着：不问搜索建议（历史照问）', async () => {
    await mount({ searchSuggest: false })
    await beginEdit()
    type('git')
    await tick(1000)
    expect(api.browserHistory.searchSuggest).not.toHaveBeenCalled()
    expect(api.browserHistory.suggest).toHaveBeenCalled()
  })

  it.each(['localhost:3000', 'https://x'])('OF-2 %s：不问搜索建议', async (text) => {
    await mount()
    await beginEdit()
    type(text)
    await tick(1000)
    expect(api.browserHistory.searchSuggest).not.toHaveBeenCalled()
  })

  it('OF-2 建议那几行：补出来的部分加粗、没有「— Google Search」；「搜这段字」那行有', async () => {
    api.browserHistory.searchSuggest.mockResolvedValue(['github desktop'])
    await mount()
    await beginEdit()
    type('git')
    await tick(120)
    await settle()
    expect(rowKeys()).toEqual(['search:git', 'search:github desktop'])
    const suggested = row('search:github desktop')
    expect([...suggested.querySelectorAll('b')].map((b) => b.textContent)).toEqual(['hub desktop'])
    expect(suggested.textContent).not.toContain('Google Search')
    expect(row('search:git').textContent).toContain('git — Google Search')
  })
})

describe('页面区的截图（OF-3）', () => {
  /** 页面区：宽 801.6 CSS px（dpr 2 → 1603） */
  function pageArea(): void {
    const el = document.createElement('div')
    el.setAttribute('data-page-area', '')
    el.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        width: 801.6,
        height: 500,
        top: 0,
        left: 0,
        right: 801.6,
        bottom: 500
      }) as DOMRect
    document.body.appendChild(el)
  }

  it('OF-3 原生页面：capture(t1, round(宽 × dpr)) 一次；抓到之前不弹；抓到之后 pageCover、弹出', async () => {
    pageArea()
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    let resolve!: (s: string) => void
    api.browserView.capture.mockImplementation(() => new Promise<string>((r) => (resolve = r)))
    try {
      await mount()
      await beginEdit()
      await typeAndSettle('git')
      expect(api.browserView.capture.mock.calls).toEqual([['t1', 1603]])
      expect(popup()).toBeNull()
      expect(useBrowserTabsStore.getState().pageCover).toBeNull()

      type('gith')
      await settle()
      expect(api.browserView.capture).toHaveBeenCalledTimes(1)

      await act(async () => resolve('data:image/png;base64,AAAA'))
      await settle()
      expect(useBrowserTabsStore.getState().pageCover).toEqual({
        tabId: 't1',
        snapshot: 'data:image/png;base64,AAAA'
      })
      expect(popup()).not.toBeNull()
      expect(input()!.getAttribute('aria-expanded')).toBe('true')
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
    }
  })

  it("OF-3 抓图失败：snapshot ''，照弹", async () => {
    api.browserView.capture.mockRejectedValue(new Error('no surface'))
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    expect(useBrowserTabsStore.getState().pageCover).toEqual({ tabId: 't1', snapshot: '' })
    expect(popup()).not.toBeNull()
  })

  it.each([
    ['Esc', async () => void press('Escape')],
    [
      '失焦',
      async () => {
        act(() => input()!.blur())
      }
    ],
    ['回车', async () => void press('Enter')]
  ] as const)('OF-3 %s → pageCover 回 null、下拉没了', async (_l, end) => {
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    expect(useBrowserTabsStore.getState().pageCover).not.toBeNull()
    await end()
    await settle()
    expect(useBrowserTabsStore.getState().pageCover).toBeNull()
    expect(popup()).toBeNull()
  })

  it.each([
    ['空白页', { tab: tabInfo({ id: 't1', url: 'about:blank' }) }],
    ['内部页面', { tab: tabInfo({ id: 't1', url: 'shuvix://history' }) }],
    ['平铺墙', { viewMode: 'wall' as const }]
  ])("OF-3 %s：不抓图、snapshot ''、立刻弹", async (_l, props) => {
    await mount(props)
    await beginEdit()
    type('git')
    // 不等任何截图：一轮微任务（历史的回答）就够
    await tick(0)
    expect(api.browserView.capture).not.toHaveBeenCalled()
    expect(useBrowserTabsStore.getState().pageCover).toEqual({ tabId: 't1', snapshot: '' })
    expect(popup()).not.toBeNull()
  })

  it("OF-3 没有选中的页：不抓图、pageCover {tabId: '', snapshot: ''}", async () => {
    await mount({ tab: null })
    await beginEdit()
    await typeAndSettle('git')
    expect(api.browserView.capture).not.toHaveBeenCalled()
    expect(useBrowserTabsStore.getState().pageCover).toEqual({ tabId: '', snapshot: '' })
    expect(popup()).not.toBeNull()
  })
})

describe('内联补全（OF-4 ~ OF-8）', () => {
  beforeEach(() => {
    api.browserHistory.suggest.mockResolvedValue([GH])
  })

  it('OF-4 打 git → github.com、补上的部分选中 [3, 10]、aria-autocomplete both、第一行是网址', async () => {
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    const el = input()!
    expect(el.value).toBe('github.com')
    expect(sel()).toEqual([3, 10])
    expect(el.getAttribute('aria-autocomplete')).toBe('both')
    expect(rows()[0].getAttribute('data-omnibox-match')).toBe('url')
    expect(rowKeys()[0]).toBe('url:https://github.com/')
    expect(selectedIndex()).toBe(0)
  })

  it('OF-5 接着打 h（替换掉选中的部分）→ 仍是 github.com、[4, 10]；打 x → gitx、不补', async () => {
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    await typeAndSettle('gith')
    expect(input()!.value).toBe('github.com')
    expect(sel()).toEqual([4, 10])

    await typeAndSettle('gitx')
    expect(input()!.value).toBe('gitx')
    expect(sel()).toEqual([4, 4])
    expect(rowKeys()[0]).toBe('search:gitx')
  })

  it('OF-6 退格删掉补上的那段 → git、不补、第一行是搜索；再打一个字又补', async () => {
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    await typeAndSettle('git', { inputType: 'deleteContentBackward' })
    expect(input()!.value).toBe('git')
    expect(rowKeys()[0]).toBe('search:git')

    await typeAndSettle('gith')
    expect(input()!.value).toBe('github.com')
    expect(sel()).toEqual([4, 10])
  })

  it.each([
    ['→', () => void press('ArrowRight')],
    ['←', () => void press('ArrowLeft')],
    ['Home', () => void press('Home')],
    ['End', () => void press('End')],
    ['在输入框里按下鼠标', () => void mouseDown(input()!)]
  ] as const)('OF-7 %s 收下补上的字：回车开 https://github.com（typed）', async (_l, accept) => {
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    accept()
    await settle()
    expect(input()!.value).toBe('github.com')
    press('Enter')
    expect(api.browserView.navigate.mock.calls).toEqual([['t1', 'https://github.com', 'typed']])
  })

  it('OF-7 对照：没收下就回车 → 补出来的站点首页 https://github.com/', async () => {
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    press('Enter')
    expect(api.browserView.navigate.mock.calls).toEqual([['t1', 'https://github.com/', 'typed']])
  })

  it('OF-7 收下之后退格：不再补', async () => {
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    press('ArrowRight')
    await settle()
    await typeAndSettle('github.co', { inputType: 'deleteContentBackward' })
    expect(input()!.value).toBe('github.co')
    expect(sel()).toEqual([9, 9])
  })

  it('OF-8 输入法组字中：不补', async () => {
    await mount()
    await beginEdit()
    await typeAndSettle('git', { isComposing: true })
    expect(input()!.value).toBe('git')
    expect(rowKeys()[0]).toBe('search:git')
  })

  it('OF-8 光标不在末尾：不补', async () => {
    await mount()
    await beginEdit()
    await typeAndSettle('git', { caret: 1 })
    expect(input()!.value).toBe('git')
    expect(rowKeys()[0]).toBe('search:git')
  })

  it('OF-8 组字中的 Enter 什么也不做（不导航、仍在编辑）', async () => {
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    press('Enter', { isComposing: true })
    expect(api.browserView.navigate).not.toHaveBeenCalled()
    expect(input()).not.toBeNull()
  })
})

describe('键盘在行间走（OF-9 / OF-10）', () => {
  const H1 = hist('https://git1.test/', { lastVisitAt: NOW - 1 })
  const H2 = hist('https://git2.test/', { lastVisitAt: NOW - 2 })

  beforeEach(() => {
    api.browserHistory.suggest.mockResolvedValue([H1, H2])
  })

  async function ready(): Promise<void> {
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    expect(rowKeys()).toEqual([
      'search:git',
      'history:https://git1.test/',
      'history:https://git2.test/'
    ])
  }

  it('OF-9 ↓ 选第 1 行：aria-selected、aria-activedescendant、地址栏显示那一行的字；↑ 回去', async () => {
    await ready()
    const down = press('ArrowDown')
    expect(down.defaultPrevented).toBe(true)
    expect(selectedIndex()).toBe(1)
    expect(input()!.getAttribute('aria-activedescendant')).toBe('omnibox-suggestions-1')
    expect(rows()[1].id).toBe('omnibox-suggestions-1')
    expect(input()!.value).toBe('git1.test')

    press('ArrowUp')
    expect(selectedIndex()).toBe(0)
    expect(input()!.getAttribute('aria-activedescendant')).toBe('omnibox-suggestions-0')
    expect(input()!.value).toBe('git')
  })

  it('OF-9 到头停住：最上面再 ↑ 不动、最下面再 ↓ 不动', async () => {
    await ready()
    press('ArrowUp')
    expect(selectedIndex()).toBe(0)
    for (let i = 0; i < 5; i++) press('ArrowDown')
    expect(selectedIndex()).toBe(2)
    expect(input()!.value).toBe('git2.test')
  })

  it('OF-9 Tab / ⇧Tab 与 ↓ / ↑ 一样（拦下默认的换焦点）', async () => {
    await ready()
    expect(press('Tab').defaultPrevented).toBe(true)
    expect(selectedIndex()).toBe(1)
    expect(press('Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(selectedIndex()).toBe(0)
  })

  it.each([{ metaKey: true }, { ctrlKey: true }, { altKey: true }])(
    'OF-9 带修饰键 %j 的 ↓：不动、不拦',
    async (mods) => {
      await ready()
      const e = press('ArrowDown', mods)
      expect(e.defaultPrevented).toBe(false)
      expect(selectedIndex()).toBe(0)
    }
  )

  it('OF-9 没弹下拉（还没打字）：方向键 / Tab 不拦', async () => {
    await mount()
    await beginEdit()
    expect(press('ArrowDown').defaultPrevented).toBe(false)
    expect(press('Tab').defaultPrevented).toBe(false)
  })

  it('OF-10 选着第 2 行：第一下 Esc 回到第 0 行与自己敲的字、仍在编辑；第二下结束编辑、不导航、显示复原', async () => {
    await ready()
    press('ArrowDown')
    press('ArrowDown')
    expect(input()!.value).toBe('git2.test')

    expect(press('Escape').defaultPrevented).toBe(true)
    expect(input()).not.toBeNull()
    expect(input()!.value).toBe('git')
    expect(selectedIndex()).toBe(0)
    expect(popup()).not.toBeNull()

    press('Escape')
    await settle()
    expect(input()).toBeNull()
    expect($('[data-omnibox-display]')?.getAttribute('data-omnibox-display')).toBe(
      'https://example.com/page'
    )
    expect(api.browserView.navigate).not.toHaveBeenCalled()
    expect(api.browserView.createTab).not.toHaveBeenCalled()
  })

  it('OF-10 有内联补全：第一下 Esc 撤掉补全（git、第 0 行是搜索、仍在编辑）；第二下结束', async () => {
    api.browserHistory.suggest.mockResolvedValue([GH])
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    expect(input()!.value).toBe('github.com')

    press('Escape')
    await settle()
    expect(input()!.value).toBe('git')
    expect(rowKeys()[0]).toBe('search:git')
    expect(selectedIndex()).toBe(0)

    press('Escape')
    await settle()
    expect(input()).toBeNull()
    expect(api.browserView.navigate).not.toHaveBeenCalled()
  })

  it('OF-10 没有补全、在第 0 行：一下 Esc 就结束', async () => {
    await ready()
    press('Escape')
    await settle()
    expect(input()).toBeNull()
    expect(api.browserView.navigate).not.toHaveBeenCalled()
  })
})

describe('回车开什么（OF-11 / OF-12）', () => {
  it('OF-11 网址 → navigate(t1, url, typed)', async () => {
    await mount()
    await beginEdit()
    await typeAndSettle('example.org')
    press('Enter')
    expect(api.browserView.navigate.mock.calls).toEqual([['t1', 'https://example.org', 'typed']])
    expect(input()).toBeNull()
  })

  it('OF-11 「搜这段字」→ navigate(t1, Google(q), generated)', async () => {
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    press('Enter')
    expect(api.browserView.navigate.mock.calls).toEqual([['t1', google('git'), 'generated']])
  })

  it('OF-11 搜索建议 → navigate(t1, Google(建议), generated)', async () => {
    api.browserHistory.searchSuggest.mockResolvedValue(['github desktop'])
    await mount()
    await beginEdit()
    type('git')
    await tick(120)
    await settle()
    press('ArrowDown')
    press('Enter')
    expect(api.browserView.navigate.mock.calls).toEqual([
      ['t1', google('github desktop'), 'generated']
    ])
  })

  it('OF-11 历史 → navigate(t1, 那个网址, typed)', async () => {
    api.browserHistory.suggest.mockResolvedValue([hist('https://git1.test/')])
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    press('ArrowDown')
    press('Enter')
    expect(api.browserView.navigate.mock.calls).toEqual([['t1', 'https://git1.test/', 'typed']])
  })

  it('OF-11 「切换到此标签页」→ 只 activateTab(t2)', async () => {
    await mount({
      others: [tabInfo({ id: 't2', url: 'https://docs.test/b', title: 'Docs Bravo' })]
    })
    await beginEdit()
    await typeAndSettle('bravo')
    expect(rowKeys()).toContain('tab:t2')
    press('ArrowDown')
    press('Enter')
    expect(api.browserView.activateTab.mock.calls).toEqual([['t2']])
    expect(api.browserView.navigate).not.toHaveBeenCalled()
    expect(api.browserView.createTab).not.toHaveBeenCalled()
  })

  it('OF-11 没有选中的页：createTab(url, typed) / createTab(搜索, generated)', async () => {
    await mount({ tab: null })
    await beginEdit()
    await typeAndSettle('example.org')
    press('Enter')
    await beginEdit()
    await typeAndSettle('hello world')
    press('Enter')
    expect(api.browserView.createTab.mock.calls).toEqual([
      ['https://example.org', 'typed'],
      [google('hello world'), 'generated']
    ])
    expect(api.browserView.navigate).not.toHaveBeenCalled()
  })

  it('OF-12 点一行 = 在那一行上回车；行上的 mousedown 被拦下、输入框不失焦', async () => {
    api.browserHistory.suggest.mockResolvedValue([hist('https://git1.test/')])
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    const target = row('history:https://git1.test/')
    expect(mouseDown(target).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input())
    click(target)
    expect(api.browserView.navigate.mock.calls).toEqual([['t1', 'https://git1.test/', 'typed']])
  })
})

describe('从历史里删一行（OF-13）', () => {
  let server: HistorySuggestion[]
  let finishRemove: () => void

  beforeEach(() => {
    server = [
      hist('https://git1.test/', { lastVisitAt: NOW - 1 }),
      hist('https://git2.test/', { lastVisitAt: NOW - 2 })
    ]
    api.browserHistory.suggest.mockImplementation(async () => [...server])
    api.browserHistory.removeUrl.mockImplementation(
      (url: string) =>
        new Promise<void>((resolve) => {
          finishRemove = () => {
            server = server.filter((r) => r.url !== url)
            resolve()
          }
        })
    )
  })

  async function ready(): Promise<void> {
    await mount()
    await beginEdit()
    await typeAndSettle('git')
    expect(rowKeys()).toEqual([
      'search:git',
      'history:https://git1.test/',
      'history:https://git2.test/'
    ])
  }

  it('OF-13 ⇧Delete：removeUrl 一次、那一行当场没了、选中上移一行；回来之后再问一次历史', async () => {
    await ready()
    press('ArrowDown')
    press('ArrowDown')
    const asked = api.browserHistory.suggest.mock.calls.length
    const e = press('Delete', { shiftKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(api.browserHistory.removeUrl.mock.calls).toEqual([['https://git2.test/']])
    expect(rowKeys()).toEqual(['search:git', 'history:https://git1.test/'])
    expect(selectedIndex()).toBe(1)
    await settle()
    expect(api.browserHistory.suggest.mock.calls.length).toBe(asked)

    await act(async () => finishRemove())
    await settle()
    expect(api.browserHistory.suggest.mock.calls.length).toBe(asked + 1)
    expect(api.browserHistory.suggest.mock.calls.at(-1)).toEqual(['git'])
    expect(rowKeys()).toEqual(['search:git', 'history:https://git1.test/'])
  })

  it('OF-13 网址 / 搜索 / 切换行上的 ⇧Delete：什么也不做、不拦', async () => {
    await mount({ others: [tabInfo({ id: 't2', url: 'https://gitx.test/', title: 'git tab' })] })
    await beginEdit()
    await typeAndSettle('git')
    expect(rowKeys().slice(0, 2)).toEqual(['search:git', 'tab:t2'])
    expect(press('Delete', { shiftKey: true }).defaultPrevented).toBe(false)
    press('ArrowDown')
    expect(press('Delete', { shiftKey: true }).defaultPrevented).toBe(false)
    expect(api.browserHistory.removeUrl).not.toHaveBeenCalled()

    // 网址行（第一行打开 example.org）
    await typeAndSettle('example.org')
    expect(rows()[0].getAttribute('data-omnibox-match')).toBe('url')
    expect(press('Delete', { shiftKey: true }).defaultPrevented).toBe(false)
    expect(api.browserHistory.removeUrl).not.toHaveBeenCalled()
  })

  it('OF-13 行尾的 ×：删那一行，不导航、仍在编辑', async () => {
    await ready()
    const remove = row('history:https://git1.test/').querySelector('[data-omnibox-remove]')!
    expect(mouseDown(remove).defaultPrevented).toBe(true)
    click(remove)
    expect(api.browserHistory.removeUrl.mock.calls).toEqual([['https://git1.test/']])
    expect(rowKeys()).toEqual(['search:git', 'history:https://git2.test/'])
    expect(api.browserView.navigate).not.toHaveBeenCalled()
    expect(input()).not.toBeNull()
    expect(document.activeElement).toBe(input())
  })
})

describe('每一行的样子（OF-14）', () => {
  it('OF-14 切换行有「Switch to this tab」；× 只在历史行上；敲的词（不分大小写）在网址与标题里加粗', async () => {
    api.browserHistory.suggest.mockResolvedValue([
      hist('https://git1.test/', { title: 'My Git notes' })
    ])
    await mount({ others: [tabInfo({ id: 't2', url: 'https://tab.test/', title: 'GIT tab' })] })
    await beginEdit()
    await typeAndSettle('Git')
    expect(rowKeys()).toEqual(['search:Git', 'tab:t2', 'history:https://git1.test/'])

    const tabRow = row('tab:t2')
    expect(tabRow.querySelector('[data-omnibox-switch]')?.textContent).toContain(
      'Switch to this tab'
    )
    expect(tabRow.querySelector('[data-omnibox-remove]')).toBeNull()
    expect([...tabRow.querySelectorAll('b')].map((b) => b.textContent)).toEqual(['GIT'])

    const historyRow = row('history:https://git1.test/')
    expect(historyRow.querySelector('[data-omnibox-remove]')).not.toBeNull()
    expect(historyRow.querySelector('[data-omnibox-switch]')).toBeNull()
    expect([...historyRow.querySelectorAll('b')].map((b) => b.textContent)).toEqual(['git', 'Git'])

    const searchRow = row('search:Git')
    expect(searchRow.querySelector('[data-omnibox-remove]')).toBeNull()
    expect(searchRow.querySelector('[data-omnibox-switch]')).toBeNull()
  })
})
