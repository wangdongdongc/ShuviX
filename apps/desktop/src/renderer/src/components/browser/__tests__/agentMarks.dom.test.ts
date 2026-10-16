// @vitest-environment jsdom
/**
 * 「这页在 agent 手里」的几处标记，与标签条本身。
 *
 *   CB-U49  TabFavicon：圆点只在 CDP 接着（cdpAttached / cdpIntercepting）时出现；颜色 = 那个会话的颜色，
 *           开了请求拦截换成拦截色；agentActiveAt 之后 2 秒内 `data-agent-pulsing`，到点自己停；加载中转圈；
 *           页面崩了的警示图标压过一切；有站点图标时用它；
 *   CB-U50  AgentInfobar：只给**选中的**、接着 agent 的那页；四种说法（知道 / 不知道会话名 × 拦不拦截）；
 *           「View conversation」只在知道会话 id 时出现，点了 → browserView.openSession(id)；
 *   CB-U51  BrowserTabStrip：左键 mousedown 选中（已选中的不再选）、中键 mousedown 关、关闭按钮只关不选；
 *           `+` → createTab()；data-selected / aria-selected 只在选中的那个上；接着 agent 的标签悬停写
 *           「In use by “<会话>”」；右端「搜索标签页」弹原生菜单。
 *
 * jsdom 的 CSS 解析不认 `light-dark()`（整条 background 被丢掉），所以 sessionColor 换成回普通 rgb() 的
 * 桩 —— 这里断的是 TabFavicon / AgentInfobar 选了哪个颜色，颜色表本身由 sessionColor.test.ts 管。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { TabFavicon } from '../TabFavicon'
import { AgentInfobar } from '../AgentInfobar'
import { BrowserTabStrip } from '../BrowserTabStrip'
import { useBrowserTabsStore, type BrowserTabInfo } from '../../../stores/browserTabsStore'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  installRaf,
  mountInto,
  mouseDown,
  tabInfo,
  type FakeApi,
  type Mounted
} from './browserDomSupport'

vi.mock('../sessionColor', () => ({
  sessionDotColor: (id: string) => (id === 's1' ? 'rgb(1, 2, 3)' : 'rgb(4, 5, 6)'),
  INTERCEPTING_DOT_COLOR: 'rgb(217, 119, 6)'
}))

let api: FakeApi
let m: Mounted | null = null

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [
  ...m!.container.querySelectorAll<T>(sel)
]

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  installRaf()
  useBrowserTabsStore.setState({ tabs: [], activeTabId: null, omniboxFocusNonce: 0 })
})

afterEach(() => {
  m?.unmount()
  m = null
  vi.useRealTimers()
})

describe('TabFavicon（CB-U49）', () => {
  const favicon = async (tab: BrowserTabInfo): Promise<void> => {
    m = await mountInto(TabFavicon, { tab })
  }
  const dot = (): HTMLElement | null => $('[data-agent-dot]')

  it('CB-U49 没接着 agent：没有圆点（即使记着会话）', async () => {
    await favicon(tabInfo({ id: 't', agentSessionId: 's1', agentSessionTitle: 'A' }))
    expect(dot()).toBeNull()
  })

  it('CB-U49 接着：圆点带会话 id、用那个会话的颜色', async () => {
    await favicon(tabInfo({ id: 't', cdpAttached: true, agentSessionId: 's1' }))
    expect(dot()?.getAttribute('data-agent-dot')).toBe('s1')
    expect(dot()?.style.background).toBe('rgb(1, 2, 3)')
  })

  it('CB-U49 接着但还不知道是哪个会话：圆点 data-agent-dot 为空串', async () => {
    await favicon(tabInfo({ id: 't', cdpAttached: true }))
    expect(dot()?.getAttribute('data-agent-dot')).toBe('')
  })

  it('CB-U49 开了请求拦截：圆点换成拦截色（只拦截没 attached 也有圆点）', async () => {
    await favicon(
      tabInfo({ id: 't', cdpAttached: true, cdpIntercepting: true, agentSessionId: 's1' })
    )
    expect(dot()?.style.background).toBe('rgb(217, 119, 6)')
    m!.unmount()
    await favicon(tabInfo({ id: 't', cdpIntercepting: true, agentSessionId: 's2' }))
    expect(dot()).not.toBeNull()
    expect(dot()?.style.background).toBe('rgb(217, 119, 6)')
  })

  it('CB-U49 agentActiveAt 之后 2 秒内脉动，到点自己停；新的一次动作再脉动', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(50_000))
    await favicon(
      tabInfo({ id: 't', cdpAttached: true, agentSessionId: 's1', agentActiveAt: Date.now() })
    )
    expect(dot()?.getAttribute('data-agent-pulsing')).toBe('true')
    act(() => {
      vi.advanceTimersByTime(1999)
    })
    expect(dot()?.getAttribute('data-agent-pulsing')).toBe('true')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(dot()?.hasAttribute('data-agent-pulsing')).toBe(false)

    m!.unmount()
    await favicon(
      tabInfo({ id: 't', cdpAttached: true, agentSessionId: 's1', agentActiveAt: Date.now() })
    )
    expect(dot()?.getAttribute('data-agent-pulsing')).toBe('true')
  })

  it('CB-U49 没有 agentActiveAt（水合出来的）：不脉动', async () => {
    await favicon(tabInfo({ id: 't', cdpAttached: true, agentSessionId: 's1' }))
    expect(dot()?.hasAttribute('data-agent-pulsing')).toBe(false)
  })

  it('CB-U49 加载中转圈；有站点图标时用图标，否则地球', async () => {
    await favicon(tabInfo({ id: 't', isLoading: true, favicon: 'https://x.test/f.ico' }))
    expect($('.animate-spin')).not.toBeNull()
    expect($('img')).toBeNull()
    m!.unmount()
    await favicon(tabInfo({ id: 't', favicon: 'https://x.test/f.ico' }))
    expect($('img')?.getAttribute('src')).toBe('https://x.test/f.ico')
    expect($('.animate-spin')).toBeNull()
    m!.unmount()
    await favicon(tabInfo({ id: 't' }))
    expect($('svg.lucide-globe')).not.toBeNull()
  })

  it('CB-U49 页面崩了：警示图标压过转圈与站点图标', async () => {
    await favicon(
      tabInfo({
        id: 't',
        isLoading: true,
        favicon: 'https://x.test/f.ico',
        loadError: { errorCode: 0, errorDescription: 'oom', url: 'https://x.test/', crashed: true }
      })
    )
    expect($('svg.lucide-triangle-alert')).not.toBeNull()
    expect($('.animate-spin')).toBeNull()
    expect($('img')).toBeNull()
  })
})

describe('AgentInfobar（CB-U50）', () => {
  const bar = (): HTMLElement | null => $('[data-agent-infobar]')
  const mountBar = async (tabs: BrowserTabInfo[], active: string | null): Promise<void> => {
    useBrowserTabsStore.setState({ tabs, activeTabId: active })
    m = await mountInto(AgentInfobar, {})
  }

  it('CB-U50 选中的那页没接着 agent：没有提示条', async () => {
    await mountBar(
      [
        tabInfo({ id: 'a' }),
        tabInfo({ id: 'b', cdpAttached: true, agentSessionId: 's1', agentSessionTitle: 'Alpha' })
      ],
      'a'
    )
    expect(bar()).toBeNull()
  })

  it('CB-U50 没有选中的 tab：没有提示条', async () => {
    await mountBar([tabInfo({ id: 'b', cdpAttached: true, agentSessionId: 's1' })], null)
    expect(bar()).toBeNull()
  })

  it('CB-U50 选中的那页接着、知道会话：「“Alpha” is using this page」+ View conversation → openSession(s1)', async () => {
    await mountBar(
      [tabInfo({ id: 'b', cdpAttached: true, agentSessionId: 's1', agentSessionTitle: 'Alpha' })],
      'b'
    )
    expect(bar()?.getAttribute('data-agent-infobar')).toBe('s1')
    expect(bar()?.hasAttribute('data-intercepting')).toBe(false)
    expect(bar()?.textContent).toContain('“Alpha” is using this page')
    const open = $<HTMLButtonElement>('[data-agent-infobar-open]')
    expect(open?.textContent).toBe('View conversation')
    click(open!)
    expect(api.browserView.openSession.mock.calls).toEqual([['s1']])
  })

  it('CB-U50 知道 id 不知道标题（或标题全是空白）：「An agent is using this page」，按钮照有', async () => {
    await mountBar(
      [tabInfo({ id: 'b', cdpAttached: true, agentSessionId: 's1', agentSessionTitle: '   ' })],
      'b'
    )
    expect(bar()?.textContent).toContain('An agent is using this page')
    expect($('[data-agent-infobar-open]')).not.toBeNull()
  })

  it('CB-U50 不知道会话 id：没有 View conversation', async () => {
    await mountBar([tabInfo({ id: 'b', cdpAttached: true })], 'b')
    expect(bar()?.getAttribute('data-agent-infobar')).toBe('')
    expect(bar()?.textContent).toContain('An agent is using this page')
    expect($('[data-agent-infobar-open]')).toBeNull()
  })

  it('CB-U50 拦截中：知道 / 不知道会话名各一种说法，data-intercepting="true"', async () => {
    await mountBar(
      [
        tabInfo({
          id: 'b',
          cdpAttached: true,
          cdpIntercepting: true,
          agentSessionId: 's1',
          agentSessionTitle: 'Alpha'
        })
      ],
      'b'
    )
    expect(bar()?.getAttribute('data-intercepting')).toBe('true')
    expect(bar()?.textContent).toContain(
      '“Alpha” is using this page and intercepting its network requests — page content may be changed'
    )
    m!.unmount()
    await mountBar([tabInfo({ id: 'b', cdpIntercepting: true })], 'b')
    expect(bar()?.textContent).toContain(
      'An agent is using this page and intercepting its network requests — page content may be changed'
    )
  })

  it('CB-U50 选中换到没接着的那页：提示条消失', async () => {
    await mountBar(
      [
        tabInfo({ id: 'a' }),
        tabInfo({ id: 'b', cdpAttached: true, agentSessionId: 's1', agentSessionTitle: 'Alpha' })
      ],
      'b'
    )
    expect(bar()).not.toBeNull()
    act(() => useBrowserTabsStore.setState({ activeTabId: 'a' }))
    expect(bar()).toBeNull()
  })
})

describe('BrowserTabStrip（CB-U51）', () => {
  const tabEl = (id: string): HTMLElement => {
    const el = $(`[data-browser-tab="${id}"]`)
    if (!el) throw new Error(`no tab ${id}`)
    return el
  }
  const mountStrip = async (tabs: BrowserTabInfo[], active: string | null): Promise<void> => {
    useBrowserTabsStore.setState({ tabs, activeTabId: active })
    m = await mountInto(BrowserTabStrip, {})
  }
  const TABS = [
    tabInfo({ id: 'a', url: 'https://a.test/', title: 'Alpha' }),
    tabInfo({
      id: 'b',
      url: 'https://b.test/',
      title: 'Beta',
      cdpAttached: true,
      agentSessionId: 's1',
      agentSessionTitle: 'Research'
    }),
    tabInfo({ id: 'c', url: 'https://c.test/', title: 'Gamma' })
  ]

  it('CB-U51 data-selected / aria-selected 只在选中的那个上', async () => {
    await mountStrip(TABS, 'a')
    expect($$('[data-browser-tab]').map((el) => el.getAttribute('data-browser-tab'))).toEqual([
      'a',
      'b',
      'c'
    ])
    expect($$('[data-selected="true"]').map((el) => el.getAttribute('data-browser-tab'))).toEqual([
      'a'
    ])
    expect(tabEl('a').getAttribute('aria-selected')).toBe('true')
    expect(tabEl('b').getAttribute('aria-selected')).toBe('false')
    expect(tabEl('c').getAttribute('aria-selected')).toBe('false')
  })

  it('CB-U51 左键 mousedown 选中没选中的；已选中的不再发', async () => {
    await mountStrip(TABS, 'a')
    mouseDown(tabEl('c'))
    expect(api.browserView.activateTab.mock.calls).toEqual([['c']])
    mouseDown(tabEl('a'))
    expect(api.browserView.activateTab.mock.calls).toEqual([['c']])
    expect(api.browserView.closeTab).not.toHaveBeenCalled()
  })

  it('CB-U51 中键 mousedown 关掉它（不选中）', async () => {
    await mountStrip(TABS, 'a')
    mouseDown(tabEl('c'), 1)
    expect(api.browserView.closeTab.mock.calls).toEqual([['c']])
    expect(api.browserView.activateTab).not.toHaveBeenCalled()
  })

  it('CB-U51 关闭按钮：只关不选', async () => {
    await mountStrip(TABS, 'a')
    const close = tabEl('c').querySelector('[data-browser-tab-close]')!
    mouseDown(close)
    click(close)
    expect(api.browserView.closeTab.mock.calls).toEqual([['c']])
    expect(api.browserView.activateTab).not.toHaveBeenCalled()
  })

  it('CB-U51 `+` → createTab()（不带地址）', async () => {
    await mountStrip(TABS, 'a')
    click($('[data-browser-new-tab]')!)
    expect(api.browserView.createTab.mock.calls).toEqual([[undefined]])
  })

  it('CB-U51 悬停：标题 + 地址；接着 agent 的再加一行「In use by “Research”」', async () => {
    await mountStrip(TABS, 'a')
    expect(tabEl('b').getAttribute('title')).toBe('Beta\nhttps://b.test/\nIn use by “Research”')
    expect(tabEl('a').getAttribute('title')).toBe('Alpha\nhttps://a.test/')
    expect(tabEl('a').getAttribute('title')).not.toContain('In use by')
  })

  it('CB-U51 记着会话但已经没接着：悬停里没有 In use by', async () => {
    await mountStrip(
      [tabInfo({ id: 'x', title: 'X', agentSessionId: 's1', agentSessionTitle: 'Old' })],
      'x'
    )
    expect(tabEl('x').getAttribute('title')).not.toContain('In use by')
  })

  it('CB-U51 接着 agent 的标签上有那个会话的圆点', async () => {
    await mountStrip(TABS, 'a')
    expect(tabEl('b').querySelector('[data-agent-dot="s1"]')).not.toBeNull()
    expect(tabEl('a').querySelector('[data-agent-dot]')).toBeNull()
  })

  it('CB-U51 右端「搜索标签页」弹原生菜单', async () => {
    await mountStrip(TABS, 'a')
    click($('[data-browser-tab-search]')!)
    await flush()
    expect(api.contextMenu.popup).toHaveBeenCalledTimes(1)
  })
})
