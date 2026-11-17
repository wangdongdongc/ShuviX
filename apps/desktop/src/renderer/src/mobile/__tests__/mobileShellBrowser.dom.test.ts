// @vitest-environment jsdom
/**
 * 手机布局的「浏览器」那一摞页面在外壳里的那一层与浏览器历史（mobile/MobileShell.tsx，jsdom）。
 *
 * 契约（2026-11-17）：设置页的分区列表里多一行「浏览器」（额外分区 `browser`，排在 MCP 后面、与它同一张卡片，
 * 带 `onOpen`）—— 点它不进设置的分区，而是整屏推入 MobileBrowserPages。那一摞记在历史条目的
 * `shuvixMobileBrowser` 上（browserHistory.ts 的五种之一），每往里一层压一条、带着更长的那一摞与原有的记号；
 * 返回键 / 返回手势一层一层退。条目还带着 `shuvixMobileBrowserLoad`（这一次加载的 id）：别的加载留下的条目上的
 * 那一摞不认。对话页开着时不画这几页（对话那一条压在上面），退回来还是原来那一摞。这几页开着时交给设置面板的
 * `stackedValuesEpoch` 是 1，否则 0（收起时行尾的「N 个标签页」重取一遍，见 settingsPanelStacked）。
 *
 *   SH-1 设置面板拿到的额外分区：browser 在前（after mcp、capabilities、「Browser」、onOpen），agents 在后
 *   SH-2 / SH-3 点那一行：压一条 ['tabs']、画出那一层，设置没进分区（标签栏还在下面）；连点两下还是一条
 *   SH-4 / SH-5 / SH-6 onPush：再压一条、留着原有的记号；放不下的页不压；最深四层
 *   SH-7 / SH-8 / SH-9 返回键与返回手势都是一层一层退，退完回到设置的列表；没有带记号的条目时返回键直接收起
 *   SH-10 退到一条说的是同一摞的条目：数组还是原来那一个
 *   SH-11 重新加载留下的记号在挂载时摘掉
 *   SH-12 别的加载（或没有加载 id）的条目上的那一摞不认：退到它不把浏览器页盖回来
 *   SH-13 退到的那一条记号坏了 → 收起
 *   SH-14 / SH-15 / SH-17 对话页开着时不画；对话那一条压在上面、不带这一摞；退回来那一摞还在（中间进过详情也一样）
 *   SH-16 onOpenSession：选中那场会话并推入对话页，它已经是活跃会话时也推
 *   SH-18 那一层盖在外壳上（标签栏在它下面）；项目设置那一层不受牵连
 *   SH-19 stackedValuesEpoch：没开 0、开着 1、收起又是 0
 *
 * 替身与 mobileShellProject.dom.test.ts 同一套；SettingsPanel 的替身记下 props、给每个额外分区画一个会调
 * `onOpen` 的按钮，MobileBrowserPages 的替身记下 props、数挂载次数。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

type Props = Record<string, unknown>
interface ChatState {
  activeSessionId: string | null
  sessions: unknown[]
  setActiveSessionId: (id: string | null) => void
  setSessions: (sessions: unknown[]) => void
}

const rec = vi.hoisted(() => ({
  sidebar: [] as Array<Record<string, unknown>>,
  /** MobileProjectSettings 替身每次渲染收到的 props */
  project: [] as Array<Record<string, unknown>>,
  projectMounts: 0,
  /** SettingsPanel 替身每次渲染收到的 props */
  settings: [] as Array<Record<string, unknown>>,
  /** MobileBrowserPages 替身每次渲染收到的 props */
  browser: [] as Array<Record<string, unknown>>,
  browserMounts: 0,
  activeSessionId: null as string | null,
  listeners: new Set<(state: { activeSessionId: string | null }, prev: unknown) => void>(),
  setActive: null as unknown as (id: string | null) => void
}))

vi.mock('@shuvix/chat-ui', async () => {
  const { vi: v } = await import('vitest')
  const state = (): ChatState => ({
    activeSessionId: rec.activeSessionId,
    sessions: [],
    setActiveSessionId: rec.setActive,
    setSessions: () => {}
  })
  rec.setActive = v.fn((id: string | null) => {
    const prev = state()
    rec.activeSessionId = id
    for (const listener of [...rec.listeners]) listener(state(), prev)
  })
  return {
    ChatHostProvider: ({ children }: { children: unknown }) => children,
    useChatHost: () => ({ appearance: {} }),
    getChatApi: () => ({ session: { create: async () => ({ id: 'new' }), list: async () => [] } }),
    useChatStore: Object.assign((selector: (s: ChatState) => unknown) => selector(state()), {
      getState: state,
      subscribe: (listener: (s: { activeSessionId: string | null }, prev: unknown) => void) => {
        rec.listeners.add(listener)
        return () => rec.listeners.delete(listener)
      }
    })
  }
})

vi.mock('@shuvix/app-shell', async () => {
  const { createElement: h } = await import('react')
  const projects = { projects: [] }
  return {
    InboxPanel: () => h('div', { 'data-stub-inbox': '' }),
    SidebarViewSwitch: () => h('div', { 'data-sidebar-view-switch': '' }),
    SIDEBAR_VIEW_LABEL_KEYS: {
      sessions: 'sidebar.viewSessions',
      inbox: 'inbox.title',
      calendar: 'panel.calendar'
    },
    useInboxSections: () => ({ waiting: [], unread: [], running: [] }),
    useProjects: () => projects,
    STACKED_SETTINGS_HISTORY_MARK: 'shuvixSettingsDepth'
  }
})

vi.mock('../../components/sidebar/Sidebar', async () => {
  const { createElement: h } = await import('react')
  return {
    Sidebar: (props: Props) => {
      rec.sidebar.push(props)
      return h('div', { 'data-stub-sidebar': String(props.mode) })
    }
  }
})
vi.mock('../../components/browser/CalendarPanel', () => ({ CalendarPanel: () => null }))
vi.mock('../../components/browser/WidgetPanel', () => ({ WidgetPanel: () => null }))
vi.mock('../../components/browser/AgentMonitorPanel', () => ({ AgentMonitorPanel: () => null }))
vi.mock('../../components/settings/SettingsPanel', async () => {
  const { createElement: h } = await import('react')
  return {
    SettingsPanel: (props: Props) => {
      rec.settings.push(props)
      const extra = (props.extraTabs ?? []) as Array<{ id: string; onOpen?: () => void }>
      return h(
        'div',
        { 'data-stub-settings': '' },
        extra.map((tab) =>
          h('button', { key: tab.id, 'data-settings-tab': tab.id, onClick: tab.onOpen })
        )
      )
    }
  }
})
vi.mock('../MobileBrowserPages', async () => {
  const { createElement: h, useEffect } = await import('react')
  return {
    MobileBrowserPages: (props: Props) => {
      rec.browser.push(props)
      useEffect(() => {
        rec.browserMounts++
      }, [])
      return h('div', { 'data-stub-browser': (props.stack as string[]).join(' > ') })
    }
  }
})
vi.mock('../MobileChatView', async () => {
  const { createElement: h } = await import('react')
  return {
    MobileChatView: ({ onBack }: { onBack: () => void }) =>
      h('button', { 'data-stub-chat-back': '', onClick: onBack })
  }
})
vi.mock('../MobileProjectSettings', async () => {
  const { createElement: h, useEffect } = await import('react')
  return {
    MobileProjectSettings: (props: Props) => {
      rec.project.push(props)
      useEffect(() => {
        rec.projectMounts++
      }, [])
      return h('div', { 'data-stub-project': String(props.page) })
    }
  }
})
vi.mock('../../stores/widgetStore', async () => {
  const { create } = await import('zustand')
  interface WidgetState {
    foregroundApp: string | null
    goHome: () => void
  }
  return {
    useWidgetStore: create<WidgetState>((set) => ({
      foregroundApp: null,
      goHome: () => set({ foregroundApp: null })
    }))
  }
})
vi.mock('../../stores/sidebarViewStore', async () => {
  const { create } = await import('zustand')
  interface ViewState {
    view: string
    setView: (view: string) => void
  }
  return {
    useSidebarViewStore: create<ViewState>((set) => ({
      view: 'sessions',
      setView: (view) => set({ view })
    }))
  }
})

import { MobileShell } from '../MobileShell'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAT = 'shuvixMobileChat'
const PROJECT = 'shuvixMobileProject'
const BROWSER = 'shuvixMobileBrowser'
const LOAD = 'shuvixMobileBrowserLoad'
const DETAIL = 'shuvixMobileDetail'

let container: HTMLDivElement
let root: Root

function mount(): void {
  act(() => root.render(createElement(MobileShell)))
}

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const click = (el: HTMLElement): void => act(() => el.click())
const historyState = (): Record<string, unknown> | null =>
  window.history.state as Record<string, unknown> | null
const stackHere = (): unknown => historyState()?.[BROWSER]
const browserPage = (): HTMLElement | null => q('[data-mobile-page="browser"]')
const chatPage = (): HTMLElement | null => q('[data-mobile-page="chat"]')
const settingsPage = (): HTMLElement => q('[data-mobile-page="settings"]')!
const tabbar = (): HTMLElement => q('[data-mobile-tabbar]')!
const lastSettings = (): Record<string, unknown> => rec.settings.at(-1)!
const lastBrowser = (): Record<string, unknown> => rec.browser.at(-1)!
/** 画出来的那一摞（没画 = null） */
const shown = (): string[] | null => (browserPage() ? (lastBrowser().stack as string[]) : null)

/** 做一件会退历史的事，等到 popstate（jsdom 异步发） */
async function awaitPop(trigger: () => void): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true })
      trigger()
    })
  })
}
const back = (): Promise<void> => awaitPop(() => window.history.back())

const toSettings = (): void => click(q('[data-mobile-tab="settings"]')!)
/** 设置列表里的「浏览器」那一行 */
const tapBrowserRow = (): void => click(q('[data-settings-tab="browser"]')!)
/** 挂上外壳、切到设置页、点开「浏览器」 */
function openBrowser(): void {
  mount()
  toSettings()
  tapBrowserRow()
}
const push = (page: string): void => act(() => (lastBrowser().onPush as (p: string) => void)(page))
const pressBack = (): void => (lastBrowser().onBack as () => void)()

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  window.history.replaceState(null, '')
  rec.sidebar.length = 0
  rec.project.length = 0
  rec.projectMounts = 0
  rec.settings.length = 0
  rec.browser.length = 0
  rec.browserMounts = 0
  rec.activeSessionId = null
  rec.listeners.clear()
  ;(rec.setActive as unknown as { mockClear: () => void }).mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  // 没落地的历史跳转别落进下一条用例
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('MobileShell: the Browser row in Settings', () => {
  it('SH-1 the settings panel gets the browser tab first (after mcp, in the capabilities card, with onOpen), then agents', () => {
    mount()
    toSettings()
    const extra = lastSettings().extraTabs as Array<Record<string, unknown>>
    expect(extra.map((tab) => tab.id)).toEqual(['browser', 'agents'])
    expect(extra[0]).toMatchObject({
      after: 'mcp',
      group: 'capabilities',
      label: en.browser.manager.title,
      content: null
    })
    expect(en.browser.manager.title).toBe('Browser')
    expect(typeof extra[0].onOpen).toBe('function')
    expect(lastSettings().stacked).toBe(true)
  })

  it('SH-2 tapping the row pushes one entry marked [tabs] and shows the pages; Settings stays on its list', () => {
    mount()
    toSettings()
    expect(browserPage()).toBeNull()
    const before = window.history.length
    tapBrowserRow()
    expect(window.history.length).toBe(before + 1)
    expect(stackHere()).toEqual(['tabs'])
    expect(typeof historyState()?.[LOAD]).toBe('string')
    expect(browserPage()).not.toBeNull()
    expect(shown()).toEqual(['tabs'])
    expect(rec.browserMounts).toBe(1)
    // 没进设置的分区：层数没动，标签栏没有被收起（只是被盖住）
    expect(tabbar().style.display).toBe('')
    expect(settingsPage().style.display).toBe('')
    expect(historyState()?.shuvixSettingsDepth).toBeUndefined()
  })

  it('SH-3 tapping the row twice still gives one entry', () => {
    mount()
    toSettings()
    const before = window.history.length
    const row = q('[data-settings-tab="browser"]')!
    act(() => {
      row.click()
      row.click()
    })
    expect(window.history.length).toBe(before + 1)
    expect(stackHere()).toEqual(['tabs'])
    expect(shown()).toEqual(['tabs'])
    // 从替身里再调一次 onOpen 也一样
    act(() => (lastSettings().extraTabs as Array<{ onOpen: () => void }>)[0].onOpen())
    expect(window.history.length).toBe(before + 1)
    expect(shown()).toEqual(['tabs'])
  })
})

describe('MobileShell: pushing browser pages', () => {
  it('SH-4 onPush(tab:7) pushes one more entry with the longer stack and keeps the marks already there', () => {
    mount()
    toSettings()
    window.history.replaceState({ somethingElse: 3 }, '')
    tapBrowserRow()
    expect(historyState()?.somethingElse).toBe(3)
    const loadId = historyState()?.[LOAD]
    const before = window.history.length
    push('tab:7')
    expect(window.history.length).toBe(before + 1)
    expect(stackHere()).toEqual(['tabs', 'tab:7'])
    expect(historyState()?.somethingElse).toBe(3)
    expect(historyState()?.[LOAD]).toBe(loadId)
    expect(shown()).toEqual(['tabs', 'tab:7'])
    // 同一个组件实例
    expect(rec.browserMounts).toBe(1)
  })

  it.each([
    { from: [] as string[], page: 'sites' },
    { from: [] as string[], page: 'site:a.test' },
    { from: [] as string[], page: 'tabs' },
    { from: ['tab:7'], page: 'tab:8' },
    { from: ['tab:7'], page: 'settings' },
    { from: ['settings'], page: 'tab:7' },
    { from: ['settings', 'sites', 'site:a.test'], page: 'site:b.test' }
  ])(
    'SH-5 a page that does not fit is not pushed: $page on top of tabs + $from',
    ({ from, page }) => {
      openBrowser()
      for (const step of from) push(step)
      const stack = ['tabs', ...from]
      const pushState = vi.spyOn(window.history, 'pushState')
      const before = window.history.length
      const prop = lastBrowser().stack
      push(page)
      expect(pushState).not.toHaveBeenCalled()
      expect(window.history.length).toBe(before)
      expect(stackHere()).toEqual(stack)
      expect(lastBrowser().stack).toBe(prop)
    }
  )

  it('SH-6 the full depth is four entries: tabs → settings → sites → site', () => {
    mount()
    toSettings()
    const before = window.history.length
    tapBrowserRow()
    push('settings')
    push('sites')
    push('site:a.test')
    expect(window.history.length).toBe(before + 4)
    expect(stackHere()).toEqual(['tabs', 'settings', 'sites', 'site:a.test'])
    expect(shown()).toEqual(['tabs', 'settings', 'sites', 'site:a.test'])
  })
})

describe('MobileShell: going back in the browser pages', () => {
  it('SH-7 onBack on a tab page goes one history step back; the list is on top again', async () => {
    openBrowser()
    push('tab:7')
    const historyBack = vi.spyOn(window.history, 'back')
    await awaitPop(pressBack)
    expect(historyBack).toHaveBeenCalledTimes(1)
    expect(shown()).toEqual(['tabs'])
    expect(stackHere()).toEqual(['tabs'])
    expect(rec.browserMounts).toBe(1)
  })

  it('SH-8 the browser back pops one level each time; after the last the Settings list and the tab bar are back', async () => {
    openBrowser()
    push('settings')
    push('sites')
    push('site:a.test')
    await back()
    expect(shown()).toEqual(['tabs', 'settings', 'sites'])
    await back()
    expect(shown()).toEqual(['tabs', 'settings'])
    await back()
    expect(shown()).toEqual(['tabs'])
    await back()
    expect(browserPage()).toBeNull()
    expect(historyState()).toBeNull()
    expect(settingsPage().style.display).toBe('')
    expect(q('[data-mobile-page="settings"] [data-stub-settings]')).not.toBeNull()
    expect(tabbar().style.display).toBe('')
  })

  it('SH-9 onBack on the tabs list closes the pages; Settings is still the selected tab', async () => {
    openBrowser()
    await awaitPop(pressBack)
    expect(browserPage()).toBeNull()
    expect(stackHere()).toBeUndefined()
    expect(settingsPage().style.display).toBe('')
    expect(q('[data-mobile-page="sessions"]')?.style.display).toBe('none')
  })

  it('SH-9b with no marked entry onBack closes the pages at once', () => {
    openBrowser()
    window.history.replaceState(null, '')
    const historyBack = vi.spyOn(window.history, 'back')
    act(pressBack)
    expect(historyBack).not.toHaveBeenCalled()
    expect(browserPage()).toBeNull()
  })

  it('SH-10 a pop onto an entry that says the same stack keeps the same array', async () => {
    openBrowser()
    push('tab:7')
    const stack = lastBrowser().stack
    // 页面里一个 #锚点 的前进：那一条带着同样的记号
    window.history.pushState({ ...historyState() }, '')
    await back()
    expect(stackHere()).toEqual(['tabs', 'tab:7'])
    expect(lastBrowser().stack).toBe(stack)
    expect(rec.browserMounts).toBe(1)
  })
})

describe('MobileShell: browser marks the shell did not just push', () => {
  it('SH-11 a mark left by a reload on the current entry is removed on mount', () => {
    window.history.replaceState({ [BROWSER]: ['tabs', 'tab:7'], [LOAD]: 'earlier-load' }, '')
    mount()
    expect(window.history.state).toBeNull()
    toSettings()
    expect(browserPage()).toBeNull()
    expect(rec.browser).toHaveLength(0)
  })

  it.each([
    { name: 'another load’s id', load: { [LOAD]: 'earlier-load' } },
    { name: 'no load id', load: {} }
  ])(
    'SH-12 back onto an older entry carrying a stack with $name does not open the pages',
    async ({ load }) => {
      // 上一次加载留下的：下面一条还标着 ['tabs']，上面是重新加载时所在的那一条
      window.history.pushState({ [BROWSER]: ['tabs'], ...load }, '')
      window.history.pushState({ [BROWSER]: ['tabs', 'tab:7'], ...load }, '')
      mount()
      expect(window.history.state).toBeNull()
      await back()
      expect(stackHere()).toEqual(['tabs'])
      expect(browserPage()).toBeNull()
      expect(rec.browser).toHaveLength(0)
      expect(q('[data-mobile-page="sessions"]')?.style.display).toBe('')
    }
  )

  it('SH-12b on such an entry the row still opens the pages from the start', async () => {
    window.history.pushState({ [BROWSER]: ['tabs', 'tab:7'], [LOAD]: 'earlier-load' }, '')
    window.history.pushState(null, '')
    mount()
    await back()
    toSettings()
    tapBrowserRow()
    expect(shown()).toEqual(['tabs'])
    expect(stackHere()).toEqual(['tabs'])
    expect(historyState()?.[LOAD]).not.toBe('earlier-load')
  })

  it('SH-13 a pop onto an entry whose mark is malformed closes the pages', async () => {
    openBrowser()
    const valid = { ...historyState() }
    window.history.pushState({ ...valid, [BROWSER]: ['tabs', 'sites'] }, '')
    window.history.pushState(valid, '')
    expect(shown()).toEqual(['tabs'])
    await back()
    expect(stackHere()).toEqual(['tabs', 'sites'])
    expect(browserPage()).toBeNull()
  })
})

describe('MobileShell: a conversation above the browser pages', () => {
  it('SH-14 while the chat page is open the browser pages are not drawn; the chat entry sits above theirs', () => {
    openBrowser()
    push('tab:7')
    const before = window.history.length
    act(() => rec.setActive('s1'))
    expect(chatPage()).not.toBeNull()
    expect(browserPage()).toBeNull()
    expect(window.history.length).toBe(before + 1)
    expect(historyState()?.[CHAT]).toBe(true)
    expect(stackHere()).toBeUndefined()
  })

  it('SH-15 closing the conversation brings the pages back with the stack they had', async () => {
    openBrowser()
    push('tab:7')
    act(() => rec.setActive('s1'))
    await awaitPop(() => click(q('[data-stub-chat-back]')!))
    expect(chatPage()).toBeNull()
    expect(shown()).toEqual(['tabs', 'tab:7'])
    expect(stackHere()).toEqual(['tabs', 'tab:7'])
  })

  it('SH-16 onOpenSession selects the session and pushes the chat page', () => {
    openBrowser()
    push('tab:7')
    act(() => (lastBrowser().onOpenSession as (id: string) => void)('s1'))
    expect(rec.setActive).toHaveBeenCalledWith('s1')
    expect(rec.activeSessionId).toBe('s1')
    expect(chatPage()).not.toBeNull()
    expect(browserPage()).toBeNull()
    expect(historyState()?.[CHAT]).toBe(true)
  })

  it('SH-16b also when that session was already the active one', () => {
    rec.activeSessionId = 's1'
    openBrowser()
    push('tab:7')
    expect(chatPage()).toBeNull()
    const before = window.history.length
    act(() => (lastBrowser().onOpenSession as (id: string) => void)('s1'))
    expect(chatPage()).not.toBeNull()
    expect(window.history.length).toBe(before + 1)
  })

  it('SH-17 a details page pushed and popped inside the conversation does not lose the stack', async () => {
    openBrowser()
    push('tab:7')
    act(() => rec.setActive('s1'))
    window.history.pushState({ ...historyState(), [DETAIL]: 'index' }, '')
    await back()
    expect(chatPage()).not.toBeNull()
    expect(browserPage()).toBeNull()
    await back()
    expect(chatPage()).toBeNull()
    expect(shown()).toEqual(['tabs', 'tab:7'])
  })
})

describe('MobileShell: the browser layer and its neighbours', () => {
  it('SH-18 the layer covers the shell (tab bar included) and leaves the project settings alone', () => {
    openBrowser()
    const layer = browserPage()!
    expect(layer.className).toContain('absolute inset-0')
    expect(layer.contains(tabbar())).toBe(false)
    // 画在标签栏与设置页之后：盖在它们上面
    expect(tabbar().compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      settingsPage().compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(q('[data-mobile-page="project"]')).toBeNull()
    expect(historyState()?.[PROJECT]).toBeUndefined()
    expect(rec.project).toHaveLength(0)
  })

  it('SH-19 stackedValuesEpoch is 0 before, 1 while the pages are open (at any depth), 0 again after', async () => {
    mount()
    toSettings()
    expect(lastSettings().stackedValuesEpoch).toBe(0)
    tapBrowserRow()
    expect(lastSettings().stackedValuesEpoch).toBe(1)
    push('tab:7')
    expect(lastSettings().stackedValuesEpoch).toBe(1)
    await back()
    expect(lastSettings().stackedValuesEpoch).toBe(1)
    await back()
    expect(browserPage()).toBeNull()
    expect(lastSettings().stackedValuesEpoch).toBe(0)
  })
})
