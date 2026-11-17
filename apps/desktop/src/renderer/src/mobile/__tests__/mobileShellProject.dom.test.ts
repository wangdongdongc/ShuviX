// @vitest-environment jsdom
/**
 * 手机布局的项目设置在外壳里的那一层与浏览器历史（mobile/MobileShell.tsx，jsdom）。
 *
 * 契约（2026-11-16）：项目那一组菜单里的「编辑项目」在手机上不开桌面那个居中的对话框，而是整屏推入
 * MobileProjectSettings。外壳把 `onEditProject` 交给「会话」页的侧栏；首页压一条标了
 * `shuvixMobileProject: { id, page: 'index' }` 的历史（原有的记号留着），子页再压一条；返回键 / 返回手势一层
 * 一层退。项目归档了（`onClosed`）：项目设置连同那一组的页面一步退掉，回到会话页顶层。对话页上面开着文件 / 任务 /
 * 产物那几页（`shuvixMobilePanel`，见 panelHistory.ts）时会话没了：连那几条一起退掉。
 *
 *   PS-1 顶层：侧栏拿到 onEditProject；调它压一条、画出那一页，返回键上是「会话」页的名字
 *   PS-2 在一组里：那一条留着组的记号，返回键上是那一组的名字
 *   PS-3 子页：再压一条，同一个组件实例（key = 项目 id）
 *   PS-4 返回键与返回手势都是一层一层退，组的页面还开着
 *   PS-5 onClosed：首页 / 子页 × 顶层 / 组里 → go(-1) / go(-2) / go(-2) / go(-3)，之后那一页没了、回到顶层
 *   PS-6 重新加载留下的记号在挂载时摘掉
 *   PS-7 对话页开着时不画项目设置
 *   PS-8 closeChat：对话页上面开着两层文件页 → go(-3)；没开 → go(-1)
 *
 * 替身与 mobileShellScope.dom.test.ts 同一套，另加 MobileProjectSettings 的替身（记下 props、数挂载次数）。
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
vi.mock('../../components/settings/SettingsPanel', () => ({ SettingsPanel: () => null }))
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

const SCOPE = 'shuvixMobileScope'
const CHAT = 'shuvixMobileChat'
const PROJECT = 'shuvixMobileProject'
const PANEL = 'shuvixMobilePanel'

type Drill = { scope: string | null; onOpen: (key: string, label: string) => void }
type SubPage = 'prompt' | 'extensions' | 'knowledge'

let container: HTMLDivElement
let root: Root

function mount(): void {
  act(() => root.render(createElement(MobileShell)))
}

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const historyState = (): Record<string, unknown> | null =>
  window.history.state as Record<string, unknown> | null
const mark = (name: string): boolean => Boolean(historyState()?.[name])
const lastSidebar = (): Record<string, unknown> => {
  const props = rec.sidebar.filter((p) => p.mode === 'sessions').at(-1)
  if (!props) throw new Error('the sessions sidebar was never rendered')
  return props
}
const drill = (): Drill => lastSidebar().drill as Drill
const projectPage = (): HTMLElement | null => q('[data-mobile-page="project"]')
const chatPage = (): HTMLElement | null => q('[data-mobile-page="chat"]')
const lastProject = (): Record<string, unknown> => rec.project.at(-1)!

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

function openScope(key: string, label: string): void {
  act(() => drill().onOpen(key, label))
}
/** 项目那一组菜单里的「编辑项目」 */
function editProject(id: string): void {
  act(() => (lastSidebar().onEditProject as (id: string) => void)(id))
}
function openPage(page: SubPage): void {
  act(() => (lastProject().onOpenPage as (page: SubPage) => void)(page))
}

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
  rec.activeSessionId = null
  rec.listeners.clear()
  ;(rec.setActive as unknown as { mockClear: () => void }).mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('MobileShell: the project settings page', () => {
  it('PS-1 at the top level: onEditProject pushes one entry and shows the index page', () => {
    mount()
    expect(typeof lastSidebar().onEditProject).toBe('function')
    expect(projectPage()).toBeNull()
    const before = window.history.length
    editProject('p1')
    expect(window.history.length).toBe(before + 1)
    expect(historyState()?.[PROJECT]).toEqual({ id: 'p1', page: 'index' })
    expect(mark(SCOPE)).toBe(false)
    expect(projectPage()).not.toBeNull()
    expect(lastProject()).toMatchObject({
      projectId: 'p1',
      page: 'index',
      backLabel: en.mobile.tabSessions
    })
  })

  it('PS-2 inside a group: the entry keeps the scope mark and the back label is the group name', () => {
    mount()
    openScope('p1', 'Proj')
    const before = window.history.length
    editProject('p1')
    expect(window.history.length).toBe(before + 1)
    expect(mark(SCOPE)).toBe(true)
    expect(historyState()?.[PROJECT]).toEqual({ id: 'p1', page: 'index' })
    expect(lastProject()).toMatchObject({ projectId: 'p1', page: 'index', backLabel: 'Proj' })
  })

  it.each(['prompt', 'extensions', 'knowledge'] as const)(
    'PS-3 onOpenPage(%s): one more entry, the same component instance',
    (page) => {
      mount()
      editProject('p1')
      const before = window.history.length
      openPage(page)
      expect(window.history.length).toBe(before + 1)
      expect(historyState()?.[PROJECT]).toEqual({ id: 'p1', page })
      expect(lastProject()).toMatchObject({ projectId: 'p1', page })
      expect(q(`[data-stub-project="${page}"]`)).not.toBeNull()
      expect(rec.projectMounts).toBe(1)
    }
  )

  it('PS-4 onBack goes one level at a time and leaves the group page open', async () => {
    mount()
    openScope('p1', 'Proj')
    editProject('p1')
    openPage('prompt')
    const historyBack = vi.spyOn(window.history, 'back')

    await awaitPop(() => (lastProject().onBack as () => void)())
    expect(historyBack).toHaveBeenCalledTimes(1)
    expect(lastProject().page).toBe('index')
    expect(historyState()?.[PROJECT]).toEqual({ id: 'p1', page: 'index' })
    expect(rec.projectMounts).toBe(1)

    await awaitPop(() => (lastProject().onBack as () => void)())
    expect(historyBack).toHaveBeenCalledTimes(2)
    expect(projectPage()).toBeNull()
    expect(mark(PROJECT)).toBe(false)
    expect(mark(SCOPE)).toBe(true)
    expect(drill().scope).toBe('p1')
  })

  it('PS-4b the browser back does the same, one level each', async () => {
    mount()
    editProject('p1')
    openPage('knowledge')
    await back()
    expect(lastProject().page).toBe('index')
    expect(projectPage()).not.toBeNull()
    await back()
    expect(projectPage()).toBeNull()
    expect(historyState()).toBeNull()
  })

  it('PS-4c with no marked entry onBack closes the page at once', () => {
    mount()
    editProject('p1')
    window.history.replaceState(null, '')
    const historyBack = vi.spyOn(window.history, 'back')
    act(() => (lastProject().onBack as () => void)())
    expect(historyBack).not.toHaveBeenCalled()
    expect(projectPage()).toBeNull()
  })

  it.each([
    { name: 'the index at the top level', inGroup: false, sub: false, steps: -1 },
    { name: 'the index inside a group', inGroup: true, sub: false, steps: -2 },
    { name: 'a sub page at the top level', inGroup: false, sub: true, steps: -2 },
    { name: 'a sub page inside a group', inGroup: true, sub: true, steps: -3 }
  ])('PS-5 onClosed from $name: history.go($steps)', async ({ inGroup, sub, steps }) => {
    mount()
    if (inGroup) openScope('p1', 'Proj')
    editProject('p1')
    if (sub) openPage('prompt')
    const go = vi.spyOn(window.history, 'go')
    await awaitPop(() => (lastProject().onClosed as () => void)())
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(steps)
    expect(projectPage()).toBeNull()
    expect(mark(PROJECT)).toBe(false)
    expect(mark(SCOPE)).toBe(false)
    expect(drill().scope).toBeNull()
  })

  it('PS-6 a project mark left by a reload is removed on mount', () => {
    window.history.replaceState({ [PROJECT]: { id: 'p1', page: 'index' } }, '')
    mount()
    expect(window.history.state).toBeNull()
    expect(projectPage()).toBeNull()
    expect(rec.project).toHaveLength(0)
  })

  it('PS-7 the project page is not drawn while the conversation page is open', async () => {
    mount()
    editProject('p1')
    act(() => rec.setActive('s1'))
    expect(chatPage()).not.toBeNull()
    expect(projectPage()).toBeNull()
    // 退回项目设置那一条：那一页又在了
    await back()
    expect(chatPage()).toBeNull()
    expect(projectPage()).not.toBeNull()
  })
})

/**
 * 对话页上面开着文件 / 任务 / 产物那几页时会话没了：`closeChat` 连那几条一起退掉。MobileChatView 是替身，那几条
 * 历史由用例自己压（真的那个压的就是这样的条目：带着下面各层的记号，再加一摞页面）。
 */
describe('MobileShell: closing the chat page with panel pages open', () => {
  const pushPanel = (stack: string[]): void =>
    window.history.pushState({ ...(historyState() ?? {}), [PANEL]: stack }, '')
  const openActive = (): void => act(() => rec.setActive('s1'))
  const deleted = (): Promise<void> => awaitPop(() => rec.setActive(null))

  it('PS-8 two files pages above the chat: one step back past all three entries', async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openActive()
    pushPanel(['files'])
    pushPanel(['files', 'files:src'])
    await deleted()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-3)
    expect(chatPage()).toBeNull()
    expect(mark(CHAT)).toBe(false)
    expect(mark(PANEL)).toBe(false)
  })

  it('PS-8b a task detail above the chat inside a group: lands in the group', async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openScope('p1', 'Proj')
    openActive()
    pushPanel(['tasks'])
    pushPanel(['tasks', 'task:t1'])
    await deleted()
    expect(go).toHaveBeenCalledWith(-3)
    expect(chatPage()).toBeNull()
    expect(drill().scope).toBe('p1')
    expect(mark(SCOPE)).toBe(true)
    expect(mark(PANEL)).toBe(false)
  })

  it('PS-8c a broken panel mark counts as no panel: the depth is that of the chat entry alone', async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openActive()
    pushPanel(['files:src'])
    await deleted()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-1)
  })

  it('PS-8d no panel and no details: a plain single step', async () => {
    mount()
    const go = vi.spyOn(window.history, 'go')
    openActive()
    await deleted()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-1)
    expect(chatPage()).toBeNull()
  })
})
