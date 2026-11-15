// @vitest-environment jsdom
/**
 * 手机布局「会话」页的两层与浏览器历史（mobile/MobileShell.tsx，jsdom）。
 *
 * 契约：顶层是收件箱那一行 + 侧栏的导航行（`drill.scope === null`）；进一组（或收件箱）压一条标了
 * `shuvixMobileScope` 的历史，返回键 / 返回手势退回顶层；在它上面再压的对话 / 小组件那一条也带着这个标记，
 * 所以从对话退回来落在那一组里，再退一次才回顶层。
 *
 *   MS-1  顶层：收件箱行、日历钮、没有返回键、没有标记
 *   MS-2  进一组：标题是那一组的名字、返回键、标记、drill.scope；日历钮没有，新对话钮还在
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
 *
 * 外壳挂的所有重组件都换成替身（侧栏、日历、小组件、设置、对话页、收件箱）；侧栏的替身记下 props 并画出
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
    useProjects: () => projects
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
vi.mock('../../components/browser/CalendarPanel', () => ({ CalendarPanel: () => null }))
vi.mock('../../components/browser/WidgetPanel', () => ({ WidgetPanel: () => null }))
vi.mock('../../components/browser/AgentMonitorPanel', () => ({ AgentMonitorPanel: () => null }))
vi.mock('../../components/settings/SettingsPanel', () => ({ SettingsPanel: () => null }))
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

type Drill = { scope: string | null; onOpen: (key: string, label: string) => void }

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
const lastInbox = (): Record<string, unknown> => rec.inbox.at(-1)!
/** 侧栏替身外面那一层（收件箱 / 日历开着时外壳把它藏起来） */
const sidebarWrapper = (): HTMLElement => q('[data-stub-sidebar="sessions"]')!.parentElement!
const chatPage = (): HTMLElement | null => q('[data-mobile-page="chat"]')
const scopeTitle = (): string | null => q('[data-mobile-scope-title]')?.textContent ?? null

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

  it('MS-2 entering a group: its name as the title, a back button, a history entry, no calendar toggle', () => {
    mount()
    openScope('p1', 'Proj')
    expect(scopeTitle()).toContain('Proj')
    expect(q('[data-mobile-scope-back]')).not.toBeNull()
    expect(mark(SCOPE)).toBe(true)
    expect(mark(CHAT)).toBe(false)
    expect(drill().scope).toBe('p1')
    expect(q('[data-mobile-calendar-toggle]')).toBeNull()
    expect(q('[data-mobile-new-chat]')).not.toBeNull()
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
