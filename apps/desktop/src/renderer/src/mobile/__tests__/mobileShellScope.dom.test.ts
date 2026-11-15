// @vitest-environment jsdom
/**
 * 手机布局「会话」页的两层与浏览器历史（mobile/MobileShell.tsx，jsdom）。
 *
 * 契约：顶层是收件箱那一行 + 侧栏的导航行（`drill.scope === null`）；进一组（或收件箱）压一条标了
 * `shuvixMobileScope` 的历史，返回键 / 返回手势退回顶层；在它上面再压的对话 / 小组件那一条也带着这个标记，
 * 所以从对话退回来落在那一组里，再退一次才回顶层。
 *
 *   MS-1  顶层：收件箱行、日历钮、没有返回键、没有标记
 *   MS-2  进一组：标题是那一组的名字、返回键、标记、drill.scope；顶栏没有日历钮与新对话钮（新对话在底部的工具栏里）
 *   MS-3 / MS-4 返回键与返回手势都回顶层
 *   MS-5 / MS-6 从组里 / 从顶层打开对话：历史上的标记，退回来落在哪
 *   MS-7  store 里换了活跃会话（不是点列表）时人在组里：对话那一条也带两个标记
 *   MS-8  小组件那一条同样带着组的标记
 *   MS-9  在组里再进另一组：不再压历史
 *   MS-10 收件箱页：InboxPanel、标题、标记；侧栏留在顶层并藏起来；顶栏没有新对话与日历
 *   MS-11 / MS-12 收件箱里点一行：已经活跃的那一条也推对话页；别的会话只推一次
 *   MS-13 重新加载留下的标记在挂载时摘掉
 *   MS-14 历史上没有标记时返回键直接收起
 *   MS-15 收件箱行上的数字与琥珀点
 *   MS-16 离开收件箱：那一页卸掉，侧栏回来
 *   MS-17 顶层：工具栏的槽挂着但藏着（交给侧栏的 `drill.toolbarSlot` 就是它），没有菜单的槽，标签栏在
 *   MS-18 进一组：返回那一行里有菜单的槽（`drill.menuSlot`）、工具栏的槽露出来、标签栏收起；退回顶层各归原位
 *   MS-19 收件箱页：没有菜单的槽、工具栏的槽藏着（它只给各组用）、标签栏收起（收件箱也是推入的一页）；退回顶层标签栏回来
 *   MS-20 搜索框：只在顶层（不在日历那种看法、组里、收件箱页）；输入的字交给 `drill.query`；有字才有清除钮，点它清空
 *   MS-21 收件箱那一行包在一张卡片里
 *   MS-22..29 对话页上面还开着详情（`shuvixMobileDetail`，见 detailHistory.ts）时会话没了：连详情那几条一起退掉，
 *         落在打开对话之前的那一条上（顶层或那一组）；没开详情照旧退一条；顶栏的返回键照旧退一条
 *
 * 资料库页的两层（`shuvixMobileLibrary`，值是钻到了第几层；知识库多一层某个库）、设置页的层数与收件箱里的跟踪项：
 *   MS-30 / MS-31 资料库页第一次切到才挂；顶层没有返回键与菜单的槽，工具栏的槽藏着；两个槽交给列表的 `libraryDrill`
 *   MS-32 / MS-33 / MS-34 进一组、再进一个库：各压一条（1、2），原有的记号留着；标题与返回键上的字；标签栏收起
 *   MS-35 / MS-36 / MS-37 返回键与返回手势一层一层退；go(-2) 一步回顶层
 *   MS-38 历史上没有记号时返回键直接收起一层
 *   MS-39..MS-44 从资料库的页里打开对话 / 小组件 / 详情：那几条也带着资料库的层数，退回来还在那一页
 *   MS-45 重新加载留下的记号在挂载时摘掉；MS-46 `libraryDrill` 的引用在无关的重渲染之间不变
 *   MS-50 / MS-51 / MS-52 设置页：`stacked`、额外的智能体分区；钻进分区（层数 > 0）标签栏收起，只在设置是当前页时
 *   MS-53 / MS-54 设置的分区开着时压的对话 / 小组件那一条也带着 `shuvixSettingsDepth`（B3）；没有那个记号就不带
 *   MS-55..MS-58 收件箱页带着跟踪项的 adapter（引用稳定；open = 打开那份笔记并推对话页）；资料库的侧栏不再有它
 *   MS-59 日历第一次切到才挂，拿到 `mobile` 与 `onOpenSession`；切回列表还挂着、藏起来
 *   MS-60 从日历里打开一条会话：推对话页
 *   MS-61 小组件页的 WidgetPanel 拿到 `mobile`
 *
 * 外壳挂的所有重组件都换成替身（侧栏、日历、小组件、设置、对话页、收件箱）；侧栏、设置、日历与小组件的替身记下 props，侧栏的还画出
 * `sessionsPrepend`。chat store 是按 selector 读、能订阅的小替身；小组件 store 是一个真的 zustand store。
 * jsdom 的 `history.back()` 异步发 popstate：`back()` 在 act 里等到它。文件是 `.ts`，一律 createElement。
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
  inbox: [] as Array<Record<string, unknown>>,
  /** SettingsPanel 替身每次渲染收到的 props */
  settings: [] as Array<Record<string, unknown>>,
  /** CalendarPanel / WidgetPanel 替身每次渲染收到的 props */
  calendar: [] as Array<Record<string, unknown>>,
  widget: [] as Array<Record<string, unknown>>,
  /** useInboxSections 交回的那份 */
  sections: { waiting: [] as unknown[], unread: [] as unknown[], running: [] as unknown[] },
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
  // 像 zustand 那样：写完通知订阅者 (state, prev)，id 没变也通知
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
    InboxPanel: (props: Props) => {
      rec.inbox.push(props)
      return h('div', { 'data-stub-inbox': '' })
    },
    useInboxSections: () => rec.sections,
    useProjects: () => projects,
    // 外壳按它读「设置此刻钻到第几层」的记号（app-shell useStackedHistory 压的）
    STACKED_SETTINGS_HISTORY_MARK: 'shuvixSettingsDepth'
  }
})

vi.mock('../../components/sidebar/Sidebar', async () => {
  const { createElement: h } = await import('react')
  return {
    Sidebar: (props: Props) => {
      rec.sidebar.push(props)
      return h('div', { 'data-stub-sidebar': String(props.mode) }, props.sessionsPrepend as never)
    }
  }
})
vi.mock('../../components/browser/CalendarPanel', async () => {
  const { createElement: h } = await import('react')
  return {
    CalendarPanel: (props: Props) => {
      rec.calendar.push(props)
      return h('div', { 'data-stub-calendar': '' })
    }
  }
})
vi.mock('../../components/browser/WidgetPanel', async () => {
  const { createElement: h } = await import('react')
  return {
    WidgetPanel: (props: Props) => {
      rec.widget.push(props)
      return h('div', { 'data-stub-widget': '' })
    }
  }
})
vi.mock('../../components/browser/AgentMonitorPanel', () => ({ AgentMonitorPanel: () => null }))
vi.mock('../../components/settings/SettingsPanel', async () => {
  const { createElement: h } = await import('react')
  return {
    SettingsPanel: (props: Props) => {
      rec.settings.push(props)
      return h('div', { 'data-stub-settings': '' })
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

import { MobileShell } from '../MobileShell'
import { useWidgetStore } from '../../stores/widgetStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SCOPE = 'shuvixMobileScope'
const CHAT = 'shuvixMobileChat'
const WIDGET = 'shuvixMobileWidget'
const DETAIL = 'shuvixMobileDetail'
const LIB = 'shuvixMobileLibrary'
const SETTINGS_DEPTH = 'shuvixSettingsDepth'

type Drill = {
  scope: string | null
  onOpen: (key: string, label: string) => void
  query?: string
  menuSlot?: HTMLElement | null
  toolbarSlot?: HTMLElement | null
}

let container: HTMLDivElement
let root: Root

function mount(): void {
  act(() => root.render(createElement(MobileShell)))
}

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const mark = (name: string): boolean =>
  Boolean((window.history.state as Record<string, unknown> | null)?.[name])
/** 「会话」页那个侧栏最近一次收到的 props */
const lastSidebar = (): Record<string, unknown> => {
  const props = rec.sidebar.filter((p) => p.mode === 'sessions').at(-1)
  if (!props) throw new Error('the sessions sidebar was never rendered')
  return props
}
const drill = (): Drill => lastSidebar().drill as Drill
/** 「资料库」页那个侧栏最近一次收到的 props */
const lastLibrary = (): Record<string, unknown> => {
  const props = rec.sidebar.filter((p) => p.mode === 'library').at(-1)
  if (!props) throw new Error('the library sidebar was never rendered')
  return props
}
const libDrill = (): Drill => lastLibrary().libraryDrill as Drill
/** 当前这条历史上资料库的层数（没有记号 = 0） */
const libMark = (): number => {
  const value = (window.history.state as Record<string, unknown> | null)?.[LIB]
  return typeof value === 'number' ? value : 0
}
const lastSettings = (): Record<string, unknown> => rec.settings.at(-1)!
const lastInbox = (): Record<string, unknown> => rec.inbox.at(-1)!
/** 侧栏替身外面那一层（收件箱 / 日历开着时外壳把它藏起来） */
const sidebarWrapper = (): HTMLElement => q('[data-stub-sidebar="sessions"]')!.parentElement!
const chatPage = (): HTMLElement | null => q('[data-mobile-page="chat"]')
const scopeTitle = (): string | null => q('[data-mobile-scope-title]')?.textContent ?? null
const menuSlot = (): HTMLElement | null => q('[data-mobile-scope-menu-slot]')
const toolbarSlot = (): HTMLElement => q('[data-mobile-scope-toolbar-slot]')!
const tabbar = (): HTMLElement => q('[data-mobile-tabbar]')!
const searchInput = (): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>('[data-mobile-search]')
const searchClear = (): HTMLElement | null => q('[data-mobile-search-clear]')
/** 在受控的输入框里打字：走原生的 value setter 再发 input 事件，React 才认 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 做一件会退一条历史的事，等到 popstate（jsdom 异步发） */
async function awaitPop(trigger: () => void): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true })
      trigger()
    })
  })
}
/** 返回手势 / 浏览器的返回键 */
const back = (): Promise<void> => awaitPop(() => window.history.back())

function openScope(key: string, label: string): void {
  act(() => drill().onOpen(key, label))
}
function openSessionFromList(): void {
  act(() => (lastSidebar().onOpenSession as () => void)())
}
function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
/** 只数带着某个标记的 pushState */
const pushesWith = (spy: { mock: { calls: unknown[][] } }, name: string): number =>
  spy.mock.calls.filter(([state]) => Boolean((state as Record<string, unknown> | null)?.[name]))
    .length

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
  rec.inbox.length = 0
  rec.settings.length = 0
  rec.calendar.length = 0
  rec.widget.length = 0
  rec.sections = { waiting: [], unread: [], running: [] }
  rec.activeSessionId = null
  rec.listeners.clear()
  ;(rec.setActive as unknown as { mockClear: () => void }).mockClear()
  useWidgetStore.setState({ foregroundApp: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('MobileShell: the two levels of the Chats tab', () => {
  it('MS-1 the top level: the inbox row, the calendar toggle, no back button, no scope mark', () => {
    mount()
    expect(q('[data-stub-sidebar="sessions"] [data-mobile-inbox-row]')).not.toBeNull()
    expect(drill().scope).toBeNull()
    expect(q('[data-mobile-scope-back]')).toBeNull()
    expect(q('[data-mobile-scope-title]')).toBeNull()
    expect(q('[data-mobile-calendar-toggle]')).not.toBeNull()
    expect(q('[data-mobile-new-chat]')).not.toBeNull()
    expect(mark(SCOPE)).toBe(false)
  })

  it('MS-2 entering a group: its name as the title, a back button, a history entry, no header actions', () => {
    mount()
    openScope('p1', 'Proj')
    expect(scopeTitle()).toContain('Proj')
    expect(q('[data-mobile-scope-back]')).not.toBeNull()
    expect(mark(SCOPE)).toBe(true)
    expect(mark(CHAT)).toBe(false)
    expect(drill().scope).toBe('p1')
    // 顶栏右边不再是日历与新建：新建在底部的工具栏里，右边是那一组的「⋯」
    expect(q('[data-mobile-calendar-toggle]')).toBeNull()
    expect(q('[data-mobile-new-chat]')).toBeNull()
    expect(q('[data-mobile-inbox]')).toBeNull()
  })

  it('MS-3 the back button returns to the top level', async () => {
    mount()
    openScope('p1', 'Proj')
    await awaitPop(() => q('[data-mobile-scope-back]')!.click())
    expect(drill().scope).toBeNull()
    expect(q('[data-mobile-scope-back]')).toBeNull()
    expect(q('[data-mobile-calendar-toggle]')).not.toBeNull()
    expect(mark(SCOPE)).toBe(false)
  })

  it('MS-4 the back gesture returns to the top level', async () => {
    mount()
    openScope('p1', 'Proj')
    await back()
    expect(drill().scope).toBeNull()
    expect(q('[data-mobile-scope-back]')).toBeNull()
    expect(mark(SCOPE)).toBe(false)
  })

  it('MS-9 opening another group while inside one pushes no second entry', () => {
    mount()
    const push = vi.spyOn(window.history, 'pushState')
    openScope('p1', 'Proj')
    openScope('p2', 'Other')
    expect(push).toHaveBeenCalledTimes(1)
    expect(scopeTitle()).toContain('Other')
    expect(drill().scope).toBe('p2')
  })

  it('MS-13 a scope mark left by a reload is removed on mount', () => {
    window.history.replaceState({ [SCOPE]: true }, '')
    mount()
    expect(window.history.state).toBeNull()
    expect(drill().scope).toBeNull()
    expect(q('[data-mobile-scope-back]')).toBeNull()
  })

  it('MS-14 with no marked entry the back button closes the group at once', () => {
    mount()
    openScope('p1', 'Proj')
    window.history.replaceState(null, '')
    const historyBack = vi.spyOn(window.history, 'back')
    click(q('[data-mobile-scope-back]')!)
    expect(historyBack).not.toHaveBeenCalled()
    expect(drill().scope).toBeNull()
    expect(q('[data-mobile-scope-back]')).toBeNull()
  })
})

describe('MobileShell: a chat or a widget opened above a group', () => {
  it('MS-5 a chat opened from a group: back lands in the group, back again at the top', async () => {
    mount()
    openScope('p1', 'Proj')
    openSessionFromList()
    expect(chatPage()).not.toBeNull()
    expect(mark(CHAT)).toBe(true)
    expect(mark(SCOPE)).toBe(true)

    await back()
    expect(chatPage()).toBeNull()
    expect(drill().scope).toBe('p1')
    expect(scopeTitle()).toContain('Proj')
    expect(mark(SCOPE)).toBe(true)
    expect(mark(CHAT)).toBe(false)

    await back()
    expect(drill().scope).toBeNull()
    expect(mark(SCOPE)).toBe(false)
    expect(mark(CHAT)).toBe(false)
  })

  it("MS-5 the chat page's own back button lands in the group too", async () => {
    mount()
    openScope('p1', 'Proj')
    openSessionFromList()
    await awaitPop(() => q('[data-stub-chat-back]')!.click())
    expect(chatPage()).toBeNull()
    expect(drill().scope).toBe('p1')
    expect(mark(SCOPE)).toBe(true)
  })

  it('MS-6 a chat opened from the top level carries no scope mark; back closes it', async () => {
    mount()
    openSessionFromList()
    expect(chatPage()).not.toBeNull()
    expect(mark(CHAT)).toBe(true)
    expect(mark(SCOPE)).toBe(false)

    await back()
    expect(chatPage()).toBeNull()
    expect(drill().scope).toBeNull()
    expect(mark(CHAT)).toBe(false)
  })

  it('MS-7 a session that becomes active from elsewhere while inside a group: both marks', async () => {
    mount()
    openScope('p1', 'Proj')
    act(() => rec.setActive('s9'))
    expect(chatPage()).not.toBeNull()
    expect(mark(CHAT)).toBe(true)
    expect(mark(SCOPE)).toBe(true)

    await back()
    expect(chatPage()).toBeNull()
    expect(drill().scope).toBe('p1')
  })

  it('MS-8 a widget opened inside a group: its entry carries the scope mark; back keeps the group', async () => {
    mount()
    openScope('p1', 'Proj')
    act(() => useWidgetStore.setState({ foregroundApp: 'w1' }))
    expect(mark(WIDGET)).toBe(true)
    expect(mark(SCOPE)).toBe(true)

    await back()
    expect(useWidgetStore.getState().foregroundApp).toBeNull()
    expect(drill().scope).toBe('p1')
    expect(mark(SCOPE)).toBe(true)
    expect(mark(WIDGET)).toBe(false)
  })

  it('MS-8 a widget opened at the top level carries no scope mark', async () => {
    mount()
    act(() => useWidgetStore.setState({ foregroundApp: 'w1' }))
    expect(mark(WIDGET)).toBe(true)
    expect(mark(SCOPE)).toBe(false)
    await back()
    expect(useWidgetStore.getState().foregroundApp).toBeNull()
  })
})

describe('MobileShell: the inbox page', () => {
  it('MS-10 the inbox row opens the inbox page above a hidden top-level sidebar', () => {
    mount()
    click(q('[data-mobile-inbox-row]')!)
    expect(q('[data-mobile-inbox] [data-stub-inbox]')).not.toBeNull()
    expect(scopeTitle()).toContain(en.inbox.title)
    expect(q('[data-mobile-scope-back]')).not.toBeNull()
    expect(mark(SCOPE)).toBe(true)
    expect(drill().scope).toBeNull()
    expect(sidebarWrapper().style.display).toBe('none')
    expect(q('[data-mobile-new-chat]')).toBeNull()
    expect(q('[data-mobile-calendar-toggle]')).toBeNull()
  })

  it('MS-11 selecting the already active session from the inbox still pushes the chat page', async () => {
    rec.activeSessionId = 's1'
    mount()
    click(q('[data-mobile-inbox-row]')!)
    act(() => (lastInbox().onSelectSession as (id: string) => void)('s1'))
    expect(rec.setActive).toHaveBeenCalledWith('s1')
    expect(chatPage()).not.toBeNull()
    expect(mark(CHAT)).toBe(true)
    expect(mark(SCOPE)).toBe(true)

    await back()
    expect(chatPage()).toBeNull()
    expect(q('[data-mobile-inbox]')).not.toBeNull()
    expect(mark(SCOPE)).toBe(true)
  })

  it('MS-12 selecting another session from the inbox pushes the chat page exactly once', () => {
    rec.activeSessionId = 's1'
    mount()
    click(q('[data-mobile-inbox-row]')!)
    const push = vi.spyOn(window.history, 'pushState')
    act(() => (lastInbox().onSelectSession as (id: string) => void)('s2'))
    expect(rec.activeSessionId).toBe('s2')
    expect(chatPage()).not.toBeNull()
    expect(pushesWith(push, CHAT)).toBe(1)
    expect(push).toHaveBeenCalledTimes(1)
  })

  it.each<[string, number, number, string | null, boolean]>([
    ['one waiting and two unread', 1, 2, '3', true],
    ['two unread only', 0, 2, '2', false],
    ['nothing', 0, 0, null, false]
  ])('MS-15 the inbox row with %s', (_label, waiting, unread, count, alert) => {
    rec.sections = {
      waiting: Array.from({ length: waiting }, (_, i) => ({ id: `w${i}` })),
      unread: Array.from({ length: unread }, (_, i) => ({ id: `u${i}` })),
      running: [{ id: 'r' }]
    }
    mount()
    const row = q('[data-mobile-inbox-row]')!
    expect(row.textContent).toContain(en.inbox.title)
    expect(row.querySelector('[data-inbox-count]')?.textContent ?? null).toBe(count)
    expect(row.querySelector('[data-inbox-alert]') !== null).toBe(alert)
  })

  it('MS-16 leaving the inbox unmounts it and shows the sidebar again', async () => {
    mount()
    click(q('[data-mobile-inbox-row]')!)
    expect(q('[data-mobile-inbox]')).not.toBeNull()
    await back()
    expect(q('[data-mobile-inbox]')).toBeNull()
    expect(sidebarWrapper().style.display).toBe('')
    expect(q('[data-mobile-scope-back]')).toBeNull()
    expect(mark(SCOPE)).toBe(false)
    expect(q('[data-mobile-new-chat]')).not.toBeNull()
    expect(q('[data-mobile-calendar-toggle]')).not.toBeNull()
  })
})

describe('MobileShell: the slots and the tab bar', () => {
  it('MS-17 the top level: a hidden toolbar slot handed to the list, no menu slot, the tab bar', () => {
    mount()
    expect(toolbarSlot().style.display).toBe('none')
    expect(drill().toolbarSlot).toBe(toolbarSlot())
    expect(menuSlot()).toBeNull()
    expect(drill().menuSlot ?? null).toBeNull()
    expect(tabbar().style.display).toBe('')
  })

  it('MS-18 inside a group: the menu slot in the back row, the toolbar slot shown, the tab bar hidden', () => {
    mount()
    openScope('p1', 'Proj')
    const slot = menuSlot()
    expect(slot).not.toBeNull()
    expect(slot!.parentElement).toBe(q('[data-mobile-scope-back]')!.parentElement)
    expect(drill().menuSlot).toBe(slot)
    expect(drill().toolbarSlot).toBe(toolbarSlot())
    expect(toolbarSlot().style.display).toBe('')
    expect(tabbar().style.display).toBe('none')
    expect(drill().scope).toBe('p1')
  })

  it('MS-18 leaving the group puts the tab bar back and hides the toolbar slot again', async () => {
    mount()
    openScope('p1', 'Proj')
    await back()
    expect(tabbar().style.display).toBe('')
    expect(toolbarSlot().style.display).toBe('none')
    expect(menuSlot()).toBeNull()
    expect(drill().menuSlot ?? null).toBeNull()
    expect(drill().toolbarSlot).toBe(toolbarSlot())
  })

  it('MS-18 the toolbar slot is the same element at the top level and inside a group', () => {
    mount()
    const slot = toolbarSlot()
    openScope('p1', 'Proj')
    expect(toolbarSlot()).toBe(slot)
    openScope('p2', 'Other')
    expect(toolbarSlot()).toBe(slot)
    expect(drill().toolbarSlot).toBe(slot)
  })

  it('MS-19 the inbox page: no menu slot, the toolbar slot hidden, the tab bar hidden too (a pushed page); back at the top it returns', async () => {
    mount()
    click(q('[data-mobile-inbox-row]')!)
    expect(q('[data-mobile-inbox]')).not.toBeNull()
    expect(q('[data-mobile-scope-back]')).not.toBeNull()
    expect(menuSlot()).toBeNull()
    expect(drill().menuSlot ?? null).toBeNull()
    // 工具栏的槽只给各组用；标签栏只有四个顶层页面有
    expect(toolbarSlot().style.display).toBe('none')
    expect(tabbar().style.display).toBe('none')

    await back()
    expect(q('[data-mobile-inbox]')).toBeNull()
    expect(tabbar().style.display).toBe('')
    expect(toolbarSlot().style.display).toBe('none')
  })

  it("MS-18 a chat opened above a group keeps the group's bottom bar for the way back", async () => {
    mount()
    openScope('p1', 'Proj')
    openSessionFromList()
    expect(chatPage()).not.toBeNull()
    await back()
    expect(toolbarSlot().style.display).toBe('')
    expect(tabbar().style.display).toBe('none')
    expect(drill().menuSlot).toBe(menuSlot())
  })

  it('MS-21 the inbox row sits in a card', () => {
    mount()
    const card = q('[data-mobile-inbox-row]')!.closest('.sb-card')
    expect(card).not.toBeNull()
    expect(q('[data-stub-sidebar="sessions"]')!.contains(card)).toBe(true)
    expect(card!.querySelectorAll('[data-mobile-inbox-row]')).toHaveLength(1)
  })
})

describe('MobileShell: search', () => {
  it('MS-20 the top level has a search box; an empty one passes an empty query and has no clear button', () => {
    mount()
    expect(searchInput()).not.toBeNull()
    expect(searchInput()!.value).toBe('')
    expect(searchInput()!.getAttribute('aria-label')).toBe(en.mobile.search)
    expect(drill().query).toBe('')
    expect(searchClear()).toBeNull()
  })

  it('MS-20 what is typed is passed to the list as drill.query', () => {
    mount()
    typeInto(searchInput()!, 'alp')
    expect(searchInput()!.value).toBe('alp')
    expect(drill().query).toBe('alp')
    expect(drill().scope).toBeNull()
    expect(searchClear()).not.toBeNull()
    // 搜索不压历史：它不是一层
    expect(mark(SCOPE)).toBe(false)

    typeInto(searchInput()!, 'alpha ')
    expect(drill().query).toBe('alpha ')
  })

  it('MS-20 the clear button empties the box and the query, then goes away', () => {
    mount()
    typeInto(searchInput()!, 'alp')
    click(searchClear()!)
    expect(searchInput()!.value).toBe('')
    expect(drill().query).toBe('')
    expect(searchClear()).toBeNull()
  })

  it('MS-20 there is no search box inside a group or on the inbox page; it is back at the top level', async () => {
    mount()
    openScope('p1', 'Proj')
    expect(searchInput()).toBeNull()
    await back()
    expect(searchInput()).not.toBeNull()

    click(q('[data-mobile-inbox-row]')!)
    expect(searchInput()).toBeNull()
    await back()
    expect(searchInput()).not.toBeNull()
  })

  it('MS-20 there is no search box in the calendar view', () => {
    mount()
    click(q('[data-mobile-calendar-toggle]')!)
    expect(searchInput()).toBeNull()
    expect(sidebarWrapper().style.display).toBe('none')
    click(q('[data-mobile-calendar-toggle]')!)
    expect(searchInput()).not.toBeNull()
    expect(sidebarWrapper().style.display).toBe('')
  })
})

/**
 * 对话页上面还开着详情时关对话页（会话在详情里被删掉）：详情首页一条、子页再一条，都带着对话页的标记；
 * `closeChat` 连它们一起退掉。这里 MobileChatView 是替身，详情那几条历史由用例自己压（真的那个压的就是这样的条目）。
 */
describe('MobileShell: closing the chat page with the details open', () => {
  /** 详情那一层压的一条历史：带着下面各层的标记，再加上自己是哪一页 */
  const pushDetail = (page: string, direct?: boolean): void =>
    window.history.pushState(
      {
        ...((window.history.state as Record<string, unknown> | null) ?? {}),
        [DETAIL]: page,
        ...(direct === undefined ? {} : { shuvixMobileDetailDirect: direct })
      },
      ''
    )
  /** 从别处打开一条会话（不是点列表） */
  const openActive = (): void => act(() => rec.setActive('s1'))
  /** 这条会话被删掉：活跃会话变成 null，外壳退掉对话页那几条历史 */
  const deleted = (): Promise<void> => awaitPop(() => rec.setActive(null))

  it('MS-22 the details index is open and the session is deleted: one step back past both entries', async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openActive()
    pushDetail('index')
    await deleted()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-2)
    expect(chatPage()).toBeNull()
    expect(mark(CHAT)).toBe(false)
    expect(mark(DETAIL)).toBe(false)
    expect(mark(SCOPE)).toBe(false)
    expect(drill().scope).toBeNull()
  })

  it('MS-23 a section page is open: back past all three entries', async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openActive()
    pushDetail('index')
    pushDetail('paths')
    await deleted()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-3)
    expect(chatPage()).toBeNull()
    expect(mark(CHAT)).toBe(false)
    expect(mark(DETAIL)).toBe(false)
    expect(mark(SCOPE)).toBe(false)
  })

  it('MS-24 opened from a group: it lands in the group, and one more back reaches the top level', async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openScope('p1', 'Proj')
    openSessionFromList()
    pushDetail('index')
    expect(mark(SCOPE)).toBe(true)
    rec.activeSessionId = 's1'
    await deleted()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-2)
    expect(chatPage()).toBeNull()
    expect(drill().scope).toBe('p1')
    expect(mark(SCOPE)).toBe(true)
    expect(mark(CHAT)).toBe(false)
    expect(mark(DETAIL)).toBe(false)
    expect(toolbarSlot().style.display).toBe('')
    expect(tabbar().style.display).toBe('none')

    await back()
    expect(drill().scope).toBeNull()
    expect(mark(SCOPE)).toBe(false)
  })

  it('MS-25 no details open: a plain single step', async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openActive()
    await deleted()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-1)
    expect(chatPage()).toBeNull()
    expect(mark(CHAT)).toBe(false)
  })

  it('MS-26 the depth comes from the entry the history is on now', async () => {
    mount()
    openActive()
    pushDetail('index')
    pushDetail('paths')
    await back()
    expect(chatPage()).not.toBeNull()
    expect((window.history.state as Record<string, unknown>)[DETAIL]).toBe('index')
    const go = vi.spyOn(window.history, 'go')
    await deleted()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-2)
    expect(chatPage()).toBeNull()
    expect(mark(CHAT)).toBe(false)
  })

  it('MS-27 an unknown detail value counts as no details', async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openActive()
    pushDetail('bogus')
    await deleted()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-1)
  })

  it('MS-22d a section pushed directly from the empty chat page: back past two entries', async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openActive()
    pushDetail('paths', true)
    await deleted()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-2)
    expect(chatPage()).toBeNull()
    expect(mark(CHAT)).toBe(false)
    expect(mark(DETAIL)).toBe(false)
  })

  it('MS-23d a section reached through the index (direct: false): back past all three', async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openActive()
    pushDetail('index', false)
    pushDetail('paths', false)
    expect((window.history.state as Record<string, unknown>).shuvixMobileDetailDirect).toBe(false)
    await deleted()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-3)
    expect(chatPage()).toBeNull()
    expect(mark(CHAT)).toBe(false)
  })

  it('MS-24d an index entry carrying the direct mark is still one layer', async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openActive()
    pushDetail('index', true)
    await deleted()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-2)
    expect(chatPage()).toBeNull()
  })

  it('MS-25d an unknown detail value with the direct mark counts as no details', async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openActive()
    pushDetail('bogus', true)
    await deleted()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-1)
  })

  it('MS-26d a direct section opened from a group: it lands in the group, still open', async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openScope('p1', 'Proj')
    openSessionFromList()
    pushDetail('paths', true)
    expect(mark(SCOPE)).toBe(true)
    rec.activeSessionId = 's1'
    await deleted()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-2)
    expect(chatPage()).toBeNull()
    expect(drill().scope).toBe('p1')
    expect(mark(SCOPE)).toBe(true)
    expect(mark(CHAT)).toBe(false)
    expect(mark(DETAIL)).toBe(false)
  })

  it('MS-28 with no chat mark on the current entry the page closes without navigating', () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    const historyBack = vi.spyOn(window.history, 'back')
    openActive()
    window.history.replaceState(null, '')
    act(() => rec.setActive(null))
    expect(chatPage()).toBeNull()
    expect(go).not.toHaveBeenCalled()
    expect(historyBack).not.toHaveBeenCalled()
  })

  it("MS-29 the chat header's back button still goes one step", async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openSessionFromList()
    await awaitPop(() => q('[data-stub-chat-back]')!.click())
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-1)
    expect(chatPage()).toBeNull()
    expect(mark(CHAT)).toBe(false)
  })
})

/**
 * 资料库页的两层：`libraryDrill`（scope / onOpen / 两个槽）交给 `mode="library"` 的侧栏；往下钻一层压一条标了
 * `shuvixMobileLibrary: <层数>` 的历史，返回键 / 返回手势一层一层退。
 */
describe('MobileShell: the library tab', () => {
  const toTab = (key: string): void => click(q(`[data-mobile-tab="${key}"]`)!)
  const openLibrary = (key: string, label: string): void => act(() => libDrill().onOpen(key, label))
  const openFromLibrary = (): void => act(() => (lastLibrary().onOpenSession as () => void)())
  const libraryTitle = (): string | null => q('[data-mobile-library-title]')?.textContent ?? null
  const libraryBack = (): HTMLElement | null => q('[data-mobile-library-back]')
  const libraryMenuSlot = (): HTMLElement | null => q('[data-mobile-library-menu-slot]')
  const libraryToolbarSlot = (): HTMLElement => q('[data-mobile-library-toolbar-slot]')!
  const state = (): Record<string, unknown> | null =>
    window.history.state as Record<string, unknown> | null
  const pushDetail = (page: string): void =>
    window.history.pushState({ ...(state() ?? {}), [DETAIL]: page }, '')

  it('MS-30 the library sidebar mounts on the first visit; the top level has no back button and no menu slot, a hidden toolbar slot, the tab bar', () => {
    mount()
    expect(rec.sidebar.some((p) => p.mode === 'library')).toBe(false)
    expect(q('[data-stub-sidebar="library"]')).toBeNull()

    toTab('library')
    expect(q('[data-stub-sidebar="library"]')).not.toBeNull()
    expect(q('[data-mobile-page="library"] h1')?.textContent).toBe(en.mobile.tabLibrary)
    expect(libraryBack()).toBeNull()
    expect(libraryTitle()).toBeNull()
    expect(libraryMenuSlot()).toBeNull()
    expect(lastLibrary().mode).toBe('library')
    expect(typeof lastLibrary().onOpenSession).toBe('function')
    expect(libDrill().scope).toBeNull()
    expect(libraryToolbarSlot().style.display).toBe('none')
    expect(tabbar().style.display).toBe('')
    expect(libMark()).toBe(0)
  })

  it('MS-31 the slots handed to the list: the toolbar slot always, the menu slot only while a page is open', async () => {
    mount()
    toTab('library')
    expect(libDrill().toolbarSlot).toBe(libraryToolbarSlot())
    expect(libDrill().menuSlot ?? null).toBeNull()

    openLibrary('agents', 'Agents')
    expect(libraryMenuSlot()).not.toBeNull()
    expect(libraryMenuSlot()!.parentElement).toBe(libraryBack()!.parentElement)
    expect(libDrill().menuSlot).toBe(libraryMenuSlot())
    expect(libDrill().toolbarSlot).toBe(libraryToolbarSlot())

    await back()
    expect(libraryMenuSlot()).toBeNull()
    expect(libDrill().menuSlot ?? null).toBeNull()
    expect(libDrill().toolbarSlot).toBe(libraryToolbarSlot())
  })

  it('MS-32 opening a group: one history entry marked 1, its name as the title, the back button named Library, the tab bar replaced by the library toolbar slot', () => {
    mount()
    toTab('library')
    const push = vi.spyOn(window.history, 'pushState')
    openLibrary('agents', 'Agents')
    expect(push).toHaveBeenCalledTimes(1)
    expect(state()).toEqual({ [LIB]: 1 })
    expect(libraryTitle()).toContain('Agents')
    expect((libraryBack()!.textContent ?? '').trim()).toBe(en.mobile.tabLibrary)
    expect(libDrill().scope).toBe('agents')
    expect(libraryToolbarSlot().style.display).toBe('')
    expect(tabbar().style.display).toBe('none')
    // 会话页那一组的工具栏的槽不归它管
    expect(toolbarSlot().style.display).toBe('none')
  })

  it('MS-33 the push keeps the marks already there: a library page above an open inbox page', async () => {
    mount()
    click(q('[data-mobile-inbox-row]')!)
    expect(mark(SCOPE)).toBe(true)
    // 收件箱页上标签栏是收起的（点不到）；这里直接切，只为在历史上留着会话页那一层的记号
    expect(tabbar().style.display).toBe('none')
    toTab('library')
    expect(tabbar().style.display).toBe('')
    openLibrary('agents', 'Agents')
    expect(state()).toEqual({ [SCOPE]: true, [LIB]: 1 })
    expect(tabbar().style.display).toBe('none')

    await back()
    expect(libDrill().scope).toBeNull()
    expect(libMark()).toBe(0)
    expect(mark(SCOPE)).toBe(true)
    expect(tabbar().style.display).toBe('')

    toTab('sessions')
    expect(q('[data-mobile-inbox]')).not.toBeNull()
    expect(tabbar().style.display).toBe('none')
  })

  it('MS-34 a second level (a knowledge base): two entries marked 1 then 2; the back button names the level below', () => {
    mount()
    toTab('library')
    const push = vi.spyOn(window.history, 'pushState')
    openLibrary('knowledge', 'Knowledge Base')
    openLibrary('knowledge:knowledge/notes', 'notes')
    expect(push.mock.calls.map(([s]) => (s as Record<string, unknown>)[LIB])).toEqual([1, 2])
    expect(libMark()).toBe(2)
    expect(libraryTitle()).toContain('notes')
    expect((libraryBack()!.textContent ?? '').trim()).toBe('Knowledge Base')
    expect(libDrill().scope).toBe('knowledge:knowledge/notes')
    expect(tabbar().style.display).toBe('none')
    expect(libraryToolbarSlot().style.display).toBe('')
  })

  /** 跑一遍「从第二层一层一层退回顶层」，`step` 是退一层的那个动作 */
  async function unwind(step: () => Promise<void>): Promise<void> {
    mount()
    toTab('library')
    openLibrary('knowledge', 'Knowledge Base')
    openLibrary('knowledge:knowledge/notes', 'notes')

    await step()
    expect(libDrill().scope).toBe('knowledge')
    expect(libraryTitle()).toContain('Knowledge Base')
    expect((libraryBack()!.textContent ?? '').trim()).toBe(en.mobile.tabLibrary)
    expect(libMark()).toBe(1)
    expect(tabbar().style.display).toBe('none')
    expect(libraryToolbarSlot().style.display).toBe('')

    await step()
    expect(libDrill().scope).toBeNull()
    expect(libMark()).toBe(0)
    expect(libraryBack()).toBeNull()
    expect(libraryMenuSlot()).toBeNull()
    expect(tabbar().style.display).toBe('')
    expect(libraryToolbarSlot().style.display).toBe('none')
  }

  it('MS-35 the back button goes one level per press', async () => {
    await unwind(() => awaitPop(() => libraryBack()!.click()))
  })

  it('MS-36 the back gesture goes one level per step', async () => {
    await unwind(back)
  })

  it('MS-37 history.go(-2) from the second level reaches the top level in one step', async () => {
    mount()
    toTab('library')
    openLibrary('knowledge', 'Knowledge Base')
    openLibrary('knowledge:knowledge/notes', 'notes')
    await awaitPop(() => window.history.go(-2))
    expect(libDrill().scope).toBeNull()
    expect(libMark()).toBe(0)
    expect(libraryBack()).toBeNull()
    expect(tabbar().style.display).toBe('')
  })

  it('MS-38 with no library mark on the current entry the back button closes one level without navigating', () => {
    mount()
    toTab('library')
    openLibrary('knowledge', 'Knowledge Base')
    openLibrary('knowledge:knowledge/notes', 'notes')
    window.history.replaceState(null, '')
    const historyBack = vi.spyOn(window.history, 'back')
    const go = vi.spyOn(window.history, 'go')
    click(libraryBack()!)
    expect(historyBack).not.toHaveBeenCalled()
    expect(go).not.toHaveBeenCalled()
    expect(libDrill().scope).toBe('knowledge')

    click(libraryBack()!)
    expect(historyBack).not.toHaveBeenCalled()
    expect(libDrill().scope).toBeNull()
    expect(libraryBack()).toBeNull()
  })

  it('MS-39 a chat opened from a library page carries the library depth; back lands on the page, back again at the top', async () => {
    mount()
    toTab('library')
    openLibrary('agents', 'Agents')
    openFromLibrary()
    expect(chatPage()).not.toBeNull()
    expect(state()).toEqual({ [CHAT]: true, [LIB]: 1 })

    await back()
    expect(chatPage()).toBeNull()
    expect(libDrill().scope).toBe('agents')
    expect(libMark()).toBe(1)
    expect(tabbar().style.display).toBe('none')
    expect(libraryToolbarSlot().style.display).toBe('')

    await back()
    expect(libDrill().scope).toBeNull()
    expect(libMark()).toBe(0)
    expect(tabbar().style.display).toBe('')
  })

  it('MS-40 a chat opened from the library top level carries no library mark', async () => {
    mount()
    toTab('library')
    openFromLibrary()
    expect(chatPage()).not.toBeNull()
    expect(state()).toEqual({ [CHAT]: true })
    await back()
    expect(chatPage()).toBeNull()
    expect(libDrill().scope).toBeNull()
  })

  it('MS-41 a session that becomes active from elsewhere while on a base page: the chat entry is marked 2 and back keeps the base page', async () => {
    mount()
    toTab('library')
    openLibrary('knowledge', 'Knowledge Base')
    openLibrary('knowledge:knowledge/notes', 'notes')
    act(() => rec.setActive('s1'))
    expect(chatPage()).not.toBeNull()
    expect(state()).toEqual({ [CHAT]: true, [LIB]: 2 })

    await back()
    expect(chatPage()).toBeNull()
    expect(libDrill().scope).toBe('knowledge:knowledge/notes')
    expect(libMark()).toBe(2)
  })

  it('MS-42 a widget entry carries the library depth; leaving the widget keeps the library page', async () => {
    mount()
    toTab('library')
    openLibrary('agents', 'Agents')
    act(() => useWidgetStore.setState({ foregroundApp: 'w' }))
    expect(state()).toEqual({ [WIDGET]: true, [LIB]: 1 })

    await awaitPop(() => useWidgetStore.getState().goHome())
    expect(useWidgetStore.getState().foregroundApp).toBeNull()
    expect(libDrill().scope).toBe('agents')
    expect(libMark()).toBe(1)
    expect(mark(WIDGET)).toBe(false)
  })

  it('MS-43 details above a chat above a library page: each back closes one layer and the page stays', async () => {
    mount()
    toTab('library')
    openLibrary('agents', 'Agents')
    openFromLibrary()
    pushDetail('index')
    expect(state()).toEqual({ [CHAT]: true, [LIB]: 1, [DETAIL]: 'index' })

    await back()
    expect(chatPage()).not.toBeNull()
    expect(libMark()).toBe(1)
    expect(libDrill().scope).toBe('agents')

    await back()
    expect(chatPage()).toBeNull()
    expect(libDrill().scope).toBe('agents')
    expect(libMark()).toBe(1)
  })

  it('MS-44 the session deleted with the details open over a library page: one step past both entries, onto the page', async () => {
    mount()
    toTab('library')
    openLibrary('agents', 'Agents')
    openFromLibrary()
    pushDetail('index')
    rec.activeSessionId = 's1'
    const go = vi.spyOn(window.history, 'go')
    await awaitPop(() => rec.setActive(null))
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-2)
    expect(chatPage()).toBeNull()
    expect(libDrill().scope).toBe('agents')
    expect(libMark()).toBe(1)
    expect(mark(CHAT)).toBe(false)
    expect(mark(DETAIL)).toBe(false)
  })

  it('MS-45 a library mark left by a reload is removed on mount', () => {
    window.history.replaceState({ [LIB]: 2 }, '')
    mount()
    expect(window.history.state).toBeNull()
    toTab('library')
    expect(libDrill().scope).toBeNull()
    expect(libraryBack()).toBeNull()
  })

  it('MS-46 libraryDrill keeps its identity across unrelated re-renders', () => {
    mount()
    toTab('library')
    const before = libDrill()
    const renders = rec.sidebar.filter((p) => p.mode === 'library').length
    toTab('sessions')
    typeInto(searchInput()!, 'alp')
    typeInto(searchInput()!, 'alpha')
    expect(rec.sidebar.filter((p) => p.mode === 'library').length).toBeGreaterThan(renders)
    expect(libDrill()).toBe(before)
  })

  it('MS-58 the library sidebar gets only mode, onOpenSession and libraryDrill', () => {
    mount()
    toTab('library')
    expect(Object.keys(lastLibrary()).sort()).toEqual(['libraryDrill', 'mode', 'onOpenSession'])
    openLibrary('agents', 'Agents')
    expect(Object.keys(lastLibrary()).sort()).toEqual(['libraryDrill', 'mode', 'onOpenSession'])
  })
})

/**
 * 设置页：`SettingsPanel stacked`（替身记 props）。容器报上来的层数（`onStackedDepthChange`）> 0 时标签栏收起 ——
 * 只在设置是当前页的时候。设置的分区开着时（app-shell useStackedHistory 在当前条目上留着 `shuvixSettingsDepth`）
 * 再压的对话 / 小组件那一条也带着这个记号：退回来落在那一条上，设置还停在那个分区里（B3）。
 */
describe('MobileShell: the settings tab', () => {
  const toTab = (key: string): void => click(q(`[data-mobile-tab="${key}"]`)!)
  const setDepth = (depth: number): void =>
    act(() => (lastSettings().onStackedDepthChange as (depth: number) => void)(depth))
  const state = (): Record<string, unknown> | null =>
    window.history.state as Record<string, unknown> | null
  /** 设置里往下钻时 useStackedHistory 压的那一条（SettingsPanel 是替身，这里自己压） */
  const pushSettingsEntry = (depth: number): void =>
    window.history.pushState({ ...(state() ?? {}), [SETTINGS_DEPTH]: depth }, '')

  it('MS-50 the settings panel is stacked, reports its depth, and gets the agents monitor as an extra tab in the maintenance card', () => {
    mount()
    expect(rec.settings).toHaveLength(0)
    toTab('settings')
    expect(q('[data-mobile-page="settings"] [data-stub-settings]')).not.toBeNull()
    const props = lastSettings()
    expect(props.stacked).toBe(true)
    expect(typeof props.onStackedDepthChange).toBe('function')
    const extra = props.extraTabs as Array<Record<string, unknown>>
    expect(extra).toHaveLength(1)
    expect(extra[0].id).toBe('agents')
    expect(extra[0].group).toBe('maintenance')
    expect(extra[0].label).toBe(i18n.t('panel.agents'))
  })

  it('MS-51 a depth above 0 hides the tab bar; 0 shows it again; neither toolbar slot is ever shown', () => {
    mount()
    toTab('settings')
    expect(tabbar().style.display).toBe('')
    const slotsHidden = (): boolean =>
      toolbarSlot().style.display === 'none' &&
      q('[data-mobile-library-toolbar-slot]')!.style.display === 'none'
    expect(slotsHidden()).toBe(true)

    setDepth(1)
    expect(tabbar().style.display).toBe('none')
    expect(slotsHidden()).toBe(true)
    setDepth(2)
    expect(tabbar().style.display).toBe('none')
    expect(slotsHidden()).toBe(true)
    setDepth(0)
    expect(tabbar().style.display).toBe('')
    expect(slotsHidden()).toBe(true)
  })

  it('MS-52 the depth hides the tab bar only while Settings is the current tab', () => {
    mount()
    toTab('settings')
    toTab('sessions')
    setDepth(1)
    expect(tabbar().style.display).toBe('')
    toTab('library')
    expect(tabbar().style.display).toBe('')
    toTab('settings')
    expect(tabbar().style.display).toBe('none')
  })

  it('MS-53 a chat opened while a settings section is open carries the settings depth; back lands on that entry', async () => {
    mount()
    toTab('settings')
    pushSettingsEntry(1)
    act(() => rec.setActive('s1'))
    expect(chatPage()).not.toBeNull()
    expect(state()).toEqual({ [CHAT]: true, [SETTINGS_DEPTH]: 1 })

    await back()
    expect(chatPage()).toBeNull()
    expect(state()).toEqual({ [SETTINGS_DEPTH]: 1 })
  })

  it('MS-53 the settings depth rides along with the scope and library marks', () => {
    mount()
    openScope('p1', 'Proj')
    toTab('library')
    act(() => libDrill().onOpen('agents', 'Agents'))
    toTab('settings')
    pushSettingsEntry(2)
    act(() => rec.setActive('s1'))
    expect(state()).toEqual({ [CHAT]: true, [SCOPE]: true, [LIB]: 1, [SETTINGS_DEPTH]: 2 })
  })

  it('MS-54 a widget opened while a settings section is open carries the settings depth', async () => {
    mount()
    toTab('settings')
    pushSettingsEntry(1)
    act(() => useWidgetStore.setState({ foregroundApp: 'w1' }))
    expect(state()).toEqual({ [WIDGET]: true, [SETTINGS_DEPTH]: 1 })

    await back()
    expect(useWidgetStore.getState().foregroundApp).toBeNull()
    expect(state()).toEqual({ [SETTINGS_DEPTH]: 1 })
  })

  it.each<[string, Record<string, unknown> | null]>([
    ['no mark', null],
    ['a mark of 0', { [SETTINGS_DEPTH]: 0 }],
    ['a mark that is not a number', { [SETTINGS_DEPTH]: true }]
  ])('MS-53 / MS-54 with %s on the current entry neither entry carries it', async (_l, entry) => {
    mount()
    if (entry) window.history.pushState(entry, '')
    act(() => rec.setActive('s1'))
    expect(state()).toEqual({ [CHAT]: true })
    await back()

    act(() => useWidgetStore.setState({ foregroundApp: 'w1' }))
    expect(state()).toEqual({ [WIDGET]: true })
    await back()
  })
})

/** 跟踪项在收件箱里（资料库不再有它的入口）：收件箱页拿到的 `tracking` 就是 useTrackingAdapter 那一份 */
describe('MobileShell: tracking in the inbox', () => {
  type Tracking = Record<string, (...args: unknown[]) => unknown>
  const tracking = (): Tracking => lastInbox().tracking as Tracking
  const openNote = vi.fn(async (_arg: { fileName: string; title?: string }) => ({ id: 't1' }))

  beforeEach(() => {
    openNote.mockClear()
    ;(window as unknown as { api: unknown }).api = { tracking: { openNote } }
  })
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('MS-55 the inbox page gets a tracking adapter beside onSelectSession', () => {
    mount()
    click(q('[data-mobile-inbox-row]')!)
    for (const name of ['list', 'open', 'openFolder', 'revealFile', 'remove', 'setStatus']) {
      expect(typeof tracking()[name], name).toBe('function')
    }
    expect(typeof lastInbox().onSelectSession).toBe('function')
  })

  it('MS-56 the tracking adapter is the same object after leaving and re-entering the inbox', async () => {
    mount()
    click(q('[data-mobile-inbox-row]')!)
    const first = tracking()
    const select = lastInbox().onSelectSession
    await back()
    typeInto(searchInput()!, 'x')
    click(q('[data-mobile-inbox-row]')!)
    expect(tracking()).toBe(first)
    expect(lastInbox().onSelectSession).toBe(select)
  })

  it('MS-57 opening a tracked item opens its note, selects it and pushes the chat page above the inbox', async () => {
    mount()
    click(q('[data-mobile-inbox-row]')!)
    await act(async () => {
      await tracking().open('t.md', 'T')
    })
    expect(openNote.mock.calls).toEqual([[{ fileName: 't.md', title: 'T' }]])
    expect(rec.setActive).toHaveBeenCalledWith('t1')
    expect(chatPage()).not.toBeNull()
    expect(mark(CHAT)).toBe(true)
    expect(mark(SCOPE)).toBe(true)

    await back()
    expect(chatPage()).toBeNull()
    expect(q('[data-mobile-inbox]')).not.toBeNull()
  })

  it('MS-57 the chat page is pushed even when that note is already the active session', async () => {
    rec.activeSessionId = 't1'
    mount()
    click(q('[data-mobile-inbox-row]')!)
    const push = vi.spyOn(window.history, 'pushState')
    await act(async () => {
      await tracking().open('t.md', 'T')
    })
    expect(chatPage()).not.toBeNull()
    expect(pushesWith(push, CHAT)).toBe(1)
    expect(mark(SCOPE)).toBe(true)
  })

  it('MS-57 a note that is no longer there opens nothing', async () => {
    openNote.mockRejectedValueOnce(new Error('gone'))
    mount()
    click(q('[data-mobile-inbox-row]')!)
    await act(async () => {
      await tracking().open('gone.md', 'Gone')
    })
    expect(rec.setActive).not.toHaveBeenCalled()
    expect(chatPage()).toBeNull()
    expect(mark(CHAT)).toBe(false)
  })
})

/** 手机布局的日历与小组件页：外壳把 `mobile` 交给两块面板（它们各自换成手机的样子） */
describe('MobileShell: the calendar and the Widgets tab get the phone layout', () => {
  const toTab = (key: string): void => click(q(`[data-mobile-tab="${key}"]`)!)
  const calendarStub = (): HTMLElement | null => q('[data-stub-calendar]')
  const lastCalendar = (): Record<string, unknown> => rec.calendar.at(-1)!

  it('MS-59 the calendar is mounted on its first toggle, gets mobile and onOpenSession, and stays mounted when toggled back', () => {
    mount()
    expect(rec.calendar).toHaveLength(0)
    expect(calendarStub()).toBeNull()

    click(q('[data-mobile-calendar-toggle]')!)
    expect(calendarStub()).not.toBeNull()
    expect(lastCalendar().mobile).toBe(true)
    expect(typeof lastCalendar().onOpenSession).toBe('function')
    const wrapper = calendarStub()!.parentElement!
    expect(wrapper.getAttribute('data-sidebar-density')).toBe('touch')
    expect(wrapper.hasAttribute('data-mobile-scale')).toBe(true)
    expect(wrapper.style.display).toBe('')

    click(q('[data-mobile-calendar-toggle]')!)
    expect(calendarStub()).not.toBeNull()
    expect(calendarStub()!.parentElement!.style.display).toBe('none')
    expect(lastCalendar().mobile).toBe(true)
  })

  it('MS-60 opening a session from the calendar pushes the chat page', async () => {
    mount()
    click(q('[data-mobile-calendar-toggle]')!)
    expect(chatPage()).toBeNull()
    expect(mark(CHAT)).toBe(false)

    act(() => (lastCalendar().onOpenSession as (id: string) => void)('s1'))
    expect(mark(CHAT)).toBe(true)
    expect(chatPage()).not.toBeNull()

    await back()
    expect(chatPage()).toBeNull()
    // 退回来还是日历那种看法
    expect(calendarStub()!.parentElement!.style.display).toBe('')
  })

  it('MS-61 the Widgets tab renders WidgetPanel with mobile', () => {
    mount()
    expect(rec.widget).toHaveLength(0)
    toTab('widgets')
    expect(q('[data-mobile-page="widgets"] [data-stub-widget]')).not.toBeNull()
    expect(rec.widget.at(-1)!.mobile).toBe(true)
  })
})
