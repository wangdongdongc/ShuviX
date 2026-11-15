// @vitest-environment jsdom
/**
 * 手机布局的对话页顶栏、「⋯」下拉菜单与详情那一层的历史（mobile/MobileChatView.tsx，jsdom）。
 *
 * 契约：
 * - 顶栏三格：返回（后面的数字 = 别处还有几条会话在等你：挂着询问或有没看的新回复，去掉此刻开着的这一条）；
 *   标题 + 一行小字「在哪干活 · 状态」（有询问 > 正在回复；停着只有位置；位置空着就没有分隔点），点它推入详情；
 *   右边一颗「⋯」；
 * - 「⋯」的菜单：文件、后台任务（数 = 还在跑的）、产物 | 导出对话（笔记本会话没有）、分支会话（宿主给、形态给
 *   才有；这一轮在跑 / 被中断时置灰）| 详情。文件 / 任务 / 产物是底部抽屉；点菜单外、Esc、返回手势收起；
 * - 详情那一层连着浏览器历史：首页一条、子页再一条（都带着下面各层的标记），返回键 / 返回手势一层一层退；
 *   换了会话就是另一份详情；
 * - 空对话页（MobileEmptyChat，按会话 id 作 key）的入口行**直接**推入详情里的那一段：只压一条历史，带
 *   `shuvixMobileDetailDirect: true`，返回一步就回对话页；从首页进去的子页那个记号是 false。
 *
 *   CH-1..15  顶栏：三格、返回、返回键后面的数、小字与状态、没有活跃会话
 *   CH-20..39 菜单：位置、各种会话的项、任务数、置灰的分支、各项做什么、怎么收起、分支被拒的说明
 *   CH-40..49 详情的历史：推入、子页、一层一层退、前进、没有标记时直接收起、没有会话不画、换会话换一份
 *   CH-50..62 空对话页的入口：给 ChatBody 的空态、直接推入的那一段、返回一步、前进、记号不粘、换会话
 *
 * `@shuvix/chat-ui` / `@shuvix/app-shell` 整个换成替身（chat store 是工厂里建的真 zustand store）；
 * MobileSessionDetails / MobileEmptyChat / useSessionLocation / 笔记本也是替身；PullDownMenu、BottomSheet、detailHistory、
 * chat-protocol 的 sessionFork 是真的。jsdom 的 `history.back()` 异步发 popstate：`back()` 在 act 里等到它。
 * 文件是 `.ts`，一律 createElement。
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
  sessions: Array<Record<string, unknown>>
  asks: Record<string, number>
  streaming: Record<string, boolean>
  forkable: Record<string, boolean>
}
interface StoreApi {
  getState: () => ChatState
  setState: (patch: Partial<ChatState>) => void
}
interface InboxItem {
  session: { id: string }
}

const rec = vi.hoisted(() => ({
  store: null as unknown as StoreApi,
  location: 'Proj',
  tasks: {} as Record<string, Array<{ status: string }>>,
  sections: {
    waiting: [] as Array<{ session: { id: string } }>,
    unread: [] as Array<{ session: { id: string } }>,
    running: [] as Array<{ session: { id: string } }>
  },
  canFork: true,
  forkError: null as string | null,
  fork: null as unknown as (...args: unknown[]) => Promise<void>,
  clearForkError: null as unknown as () => void,
  exportSession: null as unknown as (...args: unknown[]) => Promise<void>,
  files: [] as Array<Record<string, unknown>>,
  bgPanel: [] as Array<Record<string, unknown>>,
  artifacts: [] as Array<Record<string, unknown>>,
  details: [] as Array<Record<string, unknown>>,
  /** 详情替身挂载过几次（每挂一次是一个新实例） */
  detailMounts: 0,
  /** 空对话页替身收到的 props */
  empties: [] as Array<Record<string, unknown>>,
  /** ChatBody 拿到的空态元素的 key（每次渲染记一次） */
  emptyKeys: [] as Array<string | null>
}))

vi.mock('@shuvix/chat-ui', async () => {
  const { create } = await import('zustand')
  const useChatStore = create<ChatState>(() => ({
    activeSessionId: null,
    sessions: [],
    asks: {},
    streaming: {},
    forkable: {}
  }))
  rec.store = useChatStore as unknown as StoreApi
  return {
    useChatStore,
    selectAllPendingCounts: (s: ChatState) => s.asks,
    selectStreamingSessions: (s: ChatState) => s.streaming,
    selectSessionForkable: (s: ChatState, id: string | null) => !!id && s.forkable[id] === true,
    useBgTasks: (id: string | null) => rec.tasks[id ?? ''] ?? [],
    useSessionFork: () => ({
      available: rec.canFork,
      forkSession: (...args: unknown[]) => rec.fork(...args),
      forkError: rec.forkError,
      clearForkError: () => rec.clearForkError()
    }),
    forkRefusalKey: (reason: string) => (reason === 'busy' ? 'chat.forkBusy' : 'chat.forkFailed'),
    RedactedText: ({ text }: { text: string }) => text
  }
})

vi.mock('@shuvix/app-shell', async () => {
  const { createElement: h } = await import('react')
  return {
    ChatBody: ({ header, banner, overlays, conversationEmptyState }: Props) => {
      // 真 ChatBody 在有活跃会话、对话还空着时画它；替身只要有活跃会话就画
      const sid = rec.store.getState().activeSessionId
      const empty = sid
        ? (conversationEmptyState as ((id: string) => { key: string | null }) | undefined)?.(sid)
        : null
      if (empty) rec.emptyKeys.push(empty.key)
      return h(
        'div',
        { 'data-stub-chat-body': '' },
        header as never,
        banner as never,
        empty as never,
        overlays as never
      )
    },
    MediaUrlProvider: ({ children }: { children: unknown }) => children,
    StatusBanner: () => null,
    WelcomeView: () => null,
    FilesPanel: (props: Props) => {
      rec.files.push(props)
      return h('div', { 'data-stub-files': '' })
    },
    BgTaskPanel: (props: Props) => {
      rec.bgPanel.push(props)
      return h('div', { 'data-stub-bg-tasks': '' })
    },
    ArtifactsPanel: (props: Props) => {
      rec.artifacts.push(props)
      return h('div', { 'data-stub-artifacts': '' })
    },
    ConfirmDialog: ({ title, description, onConfirm }: Props) =>
      h(
        'div',
        { 'data-stub-confirm': '' },
        h('h3', null, title as never),
        h('p', null, description as never),
        h('button', { type: 'button', onClick: onConfirm as () => void })
      ),
    useInboxSections: () => rec.sections,
    useSessionExport:
      () =>
      (...args: unknown[]) =>
        rec.exportSession(...args)
  }
})

vi.mock('../MobileEmptyChat', async () => {
  const { createElement: h } = await import('react')
  return {
    MobileEmptyChat: (props: Props) => {
      rec.empties.push(props)
      return h(
        'div',
        { 'data-stub-empty': String(props.sessionId) },
        ['extensions', 'knowledge', 'paths'].map((section) =>
          h('button', {
            key: section,
            type: 'button',
            'data-stub-empty-row': section,
            onClick: () => (props.onOpenSection as (s: string) => void)(section)
          })
        )
      )
    }
  }
})
vi.mock('../../components/notebook/NotebookSessionView', () => ({
  NotebookSessionView: () => null
}))
vi.mock('../../host/hostMedia', () => ({ hostMediaResolver: {} }))
vi.mock('../useSessionLocation', () => ({ useSessionLocation: () => rec.location }))
vi.mock('../MobileSessionDetails', async () => {
  const { createElement: h, useState } = await import('react')
  return {
    MobileSessionDetails: (props: Props) => {
      const [instance] = useState(() => ++rec.detailMounts)
      rec.details.push({ ...props, instance })
      return h('div', {
        'data-stub-details': String(props.page),
        'data-stub-details-session': String(props.sessionId),
        'data-stub-details-direct': String(props.direct),
        'data-stub-details-instance': String(instance)
      })
    }
  }
})

import { MobileChatView } from '../MobileChatView'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const M = en.mobile
const CHAT = 'shuvixMobileChat'
const SCOPE = 'shuvixMobileScope'
const DETAIL = 'shuvixMobileDetail'
const DIRECT = 'shuvixMobileDetailDirect'

const onBack = vi.fn<() => void>()
const fork = vi.fn<(...args: unknown[]) => Promise<void>>()
const clearForkError = vi.fn<() => void>()
const exportSession = vi.fn<(...args: unknown[]) => Promise<void>>()

let container: HTMLDivElement
let root: Root
let mounted = false

const session = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 's1',
  title: 'My chat',
  projectId: 'p1',
  parentId: null,
  storageKind: 'durable-sqlite-1',
  settings: {},
  ...over
})
const inbox = (...ids: string[]): InboxItem[] => ids.map((id) => ({ session: { id } }))
function setStore(patch: Partial<ChatState>): void {
  act(() => rec.store.setState(patch))
}

function mount(): void {
  act(() => root.render(createElement(MobileChatView, { onBack })))
  mounted = true
}
function unmount(): void {
  if (!mounted) return
  act(() => root.unmount())
  mounted = false
}

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const body = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const state = (): Record<string, unknown> | null =>
  window.history.state as Record<string, unknown> | null
const mark = (name: string): boolean => Boolean(state()?.[name])

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
/** 做一件会退 / 进一条历史的事，等到 popstate（jsdom 异步发） */
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

// 顶栏
const backButton = (): HTMLElement => q('[data-mobile-chat-header] [data-mobile-back]')!
const titleButton = (): HTMLElement => q('[data-mobile-chat-header] [data-mobile-chat-title]')!
const menuButton = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('[data-mobile-chat-header] [data-mobile-chat-menu]')!
const subtitle = (): HTMLElement | null => q('[data-mobile-chat-subtitle]')
const chatState = (): HTMLElement | null => q('[data-mobile-chat-state]')
const backCount = (): string | null => q('[data-mobile-back-count]')?.textContent ?? null

// 菜单
const menu = (): HTMLElement | null => body('[data-mobile-pulldown]')
const menuItems = (): HTMLButtonElement[] =>
  Array.from(
    document.body.querySelectorAll<HTMLButtonElement>(
      '[data-mobile-pulldown] [data-mobile-menu-item]'
    )
  )
const menuIds = (): Array<string | null> =>
  menuItems().map((el) => el.getAttribute('data-mobile-menu-item'))
const menuItem = (id: string): HTMLButtonElement =>
  document.body.querySelector<HTMLButtonElement>(
    `[data-mobile-pulldown] [data-mobile-menu-item="${id}"]`
  )!
const menuCount = (id: string): string | null =>
  menuItem(id).querySelector('[data-mobile-menu-count]')?.textContent ?? null
const menuGroups = (): number => menu()!.children.length
function openMenu(): void {
  click(menuButton())
}
function pick(id: string): void {
  openMenu()
  click(menuItem(id))
}

// 抽屉
const sheet = (): HTMLElement | null => q('[data-bottom-sheet]')
/** 抽屉的标题：把手下面那一行 */
const sheetTitle = (): string | null =>
  sheet()?.querySelector('[role="dialog"]')?.children[1]?.textContent ?? null

// 详情（替身）
const details = (): HTMLElement | null => q('[data-stub-details]')
const detailsPage = (): string | null => details()?.getAttribute('data-stub-details') ?? null
const lastDetails = (): Record<string, unknown> => rec.details.at(-1)!
const detailsDirect = (): string | null =>
  details()?.getAttribute('data-stub-details-direct') ?? null
const emptyRow = (section: string): HTMLElement => q(`[data-stub-empty-row="${section}"]`)!
const openSection = (section: string): void =>
  act(() => (lastDetails().onOpenSection as (s: string) => void)(section))

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  window.history.replaceState(null, '')
  rec.store.setState({
    activeSessionId: 's1',
    sessions: [session()],
    asks: {},
    streaming: {},
    forkable: { s1: true }
  })
  rec.location = 'Proj'
  rec.tasks = {}
  rec.sections = { waiting: [], unread: [], running: [] }
  rec.canFork = true
  rec.forkError = null
  onBack.mockReset()
  fork.mockReset().mockResolvedValue(undefined)
  clearForkError.mockReset()
  exportSession.mockReset().mockResolvedValue(undefined)
  rec.fork = fork
  rec.clearForkError = clearForkError
  rec.exportSession = exportSession
  rec.files.length = 0
  rec.bgPanel.length = 0
  rec.artifacts.length = 0
  rec.details.length = 0
  rec.detailMounts = 0
  rec.empties.length = 0
  rec.emptyKeys.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = false
})

afterEach(() => {
  unmount()
  container.remove()
  vi.restoreAllMocks()
})

describe('MobileChatView: the header', () => {
  it('CH-1 three cells: back, the title, one menu button', () => {
    mount()
    const header = q('[data-mobile-chat-header]')!
    expect(header.querySelector('[data-mobile-back]')).not.toBeNull()
    expect(header.querySelector('[data-mobile-chat-title]')).not.toBeNull()
    expect(header.querySelectorAll('[data-mobile-chat-menu]')).toHaveLength(1)
    expect(header.querySelectorAll('button')).toHaveLength(3)
    expect(titleButton().querySelector('span')!.textContent).toBe('My chat')
    expect(titleButton().getAttribute('title')).toBe(M.details)
    expect(menuButton().getAttribute('aria-label')).toBe(M.moreActions)
    expect(menuButton().getAttribute('aria-haspopup')).toBe('menu')
    expect(menuButton().getAttribute('aria-expanded')).toBe('false')
    expect(menuButton().disabled).toBe(false)
  })

  it('CH-2 the back button closes the chat page', () => {
    mount()
    click(backButton())
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('CH-3 no number when nobody else needs the user', () => {
    mount()
    expect(backCount()).toBeNull()
    expect(backButton().getAttribute('aria-label')).toBe(M.back)
  })

  it('CH-4 the number = other sessions waiting or unread, once each, without the open one', () => {
    rec.sections = {
      waiting: inbox('a', 's1'),
      unread: inbox('b', 'a'),
      running: inbox('r')
    }
    mount()
    expect(backCount()).toBe('2')
    const label = backButton().getAttribute('aria-label')!
    expect(label).toContain(M.back)
    expect(label).toContain(i18n.t('mobile.othersWaiting', { count: 2 }))
  })

  it('CH-4 exactly one other session: the singular wording', () => {
    rec.sections = { waiting: inbox('s1'), unread: inbox('b'), running: [] }
    mount()
    expect(backCount()).toBe('1')
    const one = i18n.t('mobile.othersWaiting', { count: 1 })
    expect(one).toBe(M.othersWaiting_one.replace('{{count}}', '1'))
    expect(one).not.toBe(i18n.t('mobile.othersWaiting', { count: 2 }).replace('2', '1'))
    expect(backButton().getAttribute('aria-label')).toBe(`${M.back} · ${one}`)
  })

  it('CH-5 only the open session is in the inbox: no number', () => {
    rec.sections = { waiting: inbox('s1'), unread: inbox('s1'), running: [] }
    mount()
    expect(backCount()).toBeNull()
    expect(backButton().getAttribute('aria-label')).toBe(M.back)
  })

  it('CH-6 running sessions do not count', () => {
    rec.sections = { waiting: [], unread: [], running: inbox('x') }
    mount()
    expect(backCount()).toBeNull()
  })

  it('CH-7 the subtitle of an idle session is its location alone', () => {
    mount()
    expect(subtitle()!.textContent).toBe('Proj')
    expect(chatState()).toBeNull()
  })

  it.each([1, 2])('CH-8 a session with %i pending ask(s) says so after the location', (count) => {
    rec.store.setState({ asks: { s1: count } })
    mount()
    const text = i18n.t('inbox.asks', { count })
    const el = q('[data-mobile-chat-state="waiting"]')!
    expect(el.textContent).toBe(text)
    expect(el.classList.contains('text-warning')).toBe(true)
    expect(subtitle()!.textContent).toBe(`Proj · ${text}`)
  })

  it('CH-9 a session whose turn runs says it is replying', () => {
    rec.store.setState({ streaming: { s1: true } })
    mount()
    const el = q('[data-mobile-chat-state="replying"]')!
    expect(el.textContent).toBe(en.inbox.replying)
    expect(el.classList.contains('text-accent')).toBe(true)
    expect(subtitle()!.textContent).toBe(`Proj · ${en.inbox.replying}`)
  })

  it('CH-10 waiting beats replying', () => {
    rec.store.setState({ asks: { s1: 1 }, streaming: { s1: true } })
    mount()
    expect(chatState()!.getAttribute('data-mobile-chat-state')).toBe('waiting')
    expect(q('[data-mobile-chat-state="replying"]')).toBeNull()
    expect(container.querySelectorAll('[data-mobile-chat-state]')).toHaveLength(1)
  })

  it("CH-11 another session's state does not leak into this header", () => {
    rec.store.setState({ asks: { other: 3 }, streaming: { other: true } })
    mount()
    expect(chatState()).toBeNull()
    expect(subtitle()!.textContent).toBe('Proj')
  })

  it.each<[string, Partial<ChatState>, () => string]>([
    ['waiting', { asks: { s1: 2 } }, () => i18n.t('inbox.asks', { count: 2 })],
    ['replying', { streaming: { s1: true } }, () => en.inbox.replying]
  ])(
    'CH-12 with an empty location the %s state stands alone, no separator',
    (kind, patch, text) => {
      rec.location = ''
      rec.store.setState(patch)
      mount()
      expect(chatState()!.getAttribute('data-mobile-chat-state')).toBe(kind)
      expect(subtitle()!.textContent).toBe(text())
      expect(subtitle()!.textContent).not.toContain('·')
    }
  )

  it('CH-13 an empty location and an idle session: the subtitle is there, empty', () => {
    rec.location = ''
    mount()
    expect(subtitle()).not.toBeNull()
    expect(subtitle()!.textContent).toBe('')
  })

  it('CH-14 no active session: no subtitle, a disabled menu, a title that opens nothing', () => {
    rec.store.setState({ activeSessionId: null })
    mount()
    expect(subtitle()).toBeNull()
    expect(menuButton().disabled).toBe(true)
    const push = vi.spyOn(window.history, 'pushState')
    click(titleButton())
    expect(push).not.toHaveBeenCalled()
    expect(details()).toBeNull()
    act(() => menuButton().click())
    expect(menu()).toBeNull()
  })

  it('CH-15 the state follows the store while the page is open', () => {
    mount()
    expect(chatState()).toBeNull()
    setStore({ asks: { s1: 1 } })
    expect(chatState()!.getAttribute('data-mobile-chat-state')).toBe('waiting')
    setStore({ asks: {}, streaming: { s1: true } })
    expect(chatState()!.getAttribute('data-mobile-chat-state')).toBe('replying')
    setStore({ streaming: {} })
    expect(chatState()).toBeNull()
    expect(subtitle()!.textContent).toBe('Proj')
  })
})

describe('MobileChatView: the pull-down menu', () => {
  it('CH-20 the menu opens anchored to the button', () => {
    mount()
    menuButton().getBoundingClientRect = () => ({ right: 380, bottom: 44 }) as DOMRect
    expect(menu()).toBeNull()
    openMenu()
    expect(menu()).not.toBeNull()
    expect(menuButton().getAttribute('aria-expanded')).toBe('true')
    expect(menu()!.style.top).toBe('50px')
    expect(menu()!.style.right).toBe(`${window.innerWidth - 380}px`)
  })

  it('CH-21 the items of a chat that can be forked, in three groups', () => {
    mount()
    openMenu()
    expect(menuIds()).toEqual(['files', 'tasks', 'artifacts', 'export', 'fork', 'details'])
    expect(menuItems().map((el) => el.textContent)).toEqual([
      M.files,
      M.backgroundTasks,
      M.artifacts,
      M.exportChat,
      M.forkChat,
      M.details
    ])
    expect(menuGroups()).toBe(3)
    expect(menuItem('fork').disabled).toBe(false)
  })

  it('CH-22 the number on Background tasks counts the running ones only', () => {
    rec.tasks = {
      s1: [{ status: 'running' }, { status: 'exited' }, { status: 'running' }, { status: 'killed' }]
    }
    mount()
    openMenu()
    expect(menuCount('tasks')).toBe('2')
    expect(menu()!.querySelectorAll('[data-mobile-menu-count]')).toHaveLength(1)
  })

  it('CH-22 with only finished tasks there is no number, but the sheet still lists them', () => {
    rec.tasks = { s1: [{ status: 'exited' }, { status: 'killed' }] }
    mount()
    openMenu()
    expect(menuCount('tasks')).toBeNull()
    expect(menu()!.querySelector('[data-mobile-menu-count]')).toBeNull()
    click(menuItem('tasks'))
    expect(sheet()!.querySelector('[data-stub-bg-tasks]')).not.toBeNull()
    expect(q('[data-mobile-tasks-empty]')).toBeNull()
  })

  it('CH-22 with no tasks there is no number', () => {
    mount()
    openMenu()
    expect(menu()!.querySelector('[data-mobile-menu-count]')).toBeNull()
  })

  it('CH-23 a notebook session has no export and no fork; the emptied group is dropped', () => {
    rec.store.setState({ sessions: [session({ settings: { notebookPath: 'a.md' } })] })
    mount()
    openMenu()
    expect(menuIds()).toEqual(['files', 'tasks', 'artifacts', 'details'])
    expect(menuGroups()).toBe(2)
  })

  it('CH-24 a host that cannot fork: no fork item, export stays', () => {
    rec.canFork = false
    mount()
    openMenu()
    expect(menuIds()).toEqual(['files', 'tasks', 'artifacts', 'export', 'details'])
  })

  it.each<[string, Record<string, unknown>]>([
    ['a legacy read-only store', { storageKind: undefined }],
    ['a hidden carrier project', { projectId: '__agents__' }],
    ['a Chrome tab session', { settings: { chromeTab: { installId: 'i', runId: 'r', tabId: 1 } } }]
  ])('CH-25 %s cannot be forked: no fork item', (_label, over) => {
    rec.store.setState({ sessions: [session(over)] })
    mount()
    openMenu()
    expect(menuIds()).not.toContain('fork')
    expect(menuIds()).toContain('export')
  })

  it('CH-26 fork is shown but disabled while the turn runs or is interrupted', () => {
    rec.store.setState({ forkable: {} })
    mount()
    openMenu()
    const item = menuItem('fork')
    expect(item.disabled).toBe(true)
    act(() => item.click())
    click(item)
    expect(fork).not.toHaveBeenCalled()
    expect(menu()).not.toBeNull()
  })

  it('CH-27 Files opens the files sheet', () => {
    mount()
    pick('files')
    expect(menu()).toBeNull()
    expect(sheet()!.querySelector('[data-stub-files]')).not.toBeNull()
    expect(sheetTitle()).toBe(M.files)
  })

  it('CH-28 Background tasks with no tasks: the sheet says so', () => {
    mount()
    pick('tasks')
    expect(menu()).toBeNull()
    expect(sheetTitle()).toBe(M.backgroundTasks)
    expect(q('[data-bottom-sheet] [data-mobile-tasks-empty]')!.textContent).toBe(M.noTasks)
    expect(q('[data-stub-bg-tasks]')).toBeNull()
  })

  it("CH-29 Background tasks with tasks: the session's task panel", () => {
    rec.tasks = { s1: [{ status: 'running' }, { status: 'exited' }] }
    mount()
    pick('tasks')
    expect(sheet()!.querySelector('[data-stub-bg-tasks]')).not.toBeNull()
    expect(rec.bgPanel.at(-1)).toMatchObject({ sessionId: 's1' })
    expect(q('[data-mobile-tasks-empty]')).toBeNull()
  })

  it("CH-30 Artifacts opens the session's artifacts", () => {
    mount()
    pick('artifacts')
    expect(q('[data-bottom-sheet] [data-mobile-artifacts] [data-stub-artifacts]')).not.toBeNull()
    expect(rec.artifacts.at(-1)).toMatchObject({ sessionId: 's1' })
    expect(sheetTitle()).toBe(M.artifacts)
  })

  it('CH-31 Export chat exports this session and opens nothing', () => {
    mount()
    pick('export')
    expect(exportSession).toHaveBeenCalledTimes(1)
    expect(exportSession).toHaveBeenCalledWith('s1')
    expect(menu()).toBeNull()
    expect(sheet()).toBeNull()
    expect(details()).toBeNull()
    expect(fork).not.toHaveBeenCalled()
  })

  it('CH-32 Fork chat forks the whole session', () => {
    mount()
    pick('fork')
    expect(fork).toHaveBeenCalledTimes(1)
    expect(fork.mock.calls[0]).toEqual(['s1'])
    expect(menu()).toBeNull()
    expect(exportSession).not.toHaveBeenCalled()
  })

  it('CH-33 Details opens the details index and pushes its history entry', () => {
    mount()
    pick('details')
    expect(menu()).toBeNull()
    expect(detailsPage()).toBe('index')
    expect(state()?.[DETAIL]).toBe('index')
  })

  it('CH-34 a tap outside closes the menu and picks nothing', () => {
    mount()
    openMenu()
    click(body('[data-mobile-pulldown-layer]')!)
    expect(menu()).toBeNull()
    expect(menuButton().getAttribute('aria-expanded')).toBe('false')
    expect(sheet()).toBeNull()
    expect(details()).toBeNull()
    expect(exportSession).not.toHaveBeenCalled()
    expect(fork).not.toHaveBeenCalled()
    expect(onBack).not.toHaveBeenCalled()
  })

  it('CH-35 Escape closes the menu', () => {
    mount()
    openMenu()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(menu()).toBeNull()
    expect(menuButton().getAttribute('aria-expanded')).toBe('false')
  })

  it('CH-39 the back gesture closes the menu', () => {
    mount()
    openMenu()
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(menu()).toBeNull()
    expect(menuButton().getAttribute('aria-expanded')).toBe('false')
    expect(sheet()).toBeNull()
    expect(details()).toBeNull()
  })

  it('CH-36 the sheet closes from its backdrop', () => {
    mount()
    pick('files')
    click(q('[data-bottom-sheet-backdrop]')!)
    expect(sheet()).toBeNull()
  })

  it('CH-37 inserting a mention from the files sheet closes it', () => {
    mount()
    pick('files')
    act(() => (rec.files.at(-1)!.onMentionInserted as () => void)())
    expect(sheet()).toBeNull()
  })

  it('CH-38 a refused fork shows one dialog that says why', () => {
    rec.forkError = 'busy'
    mount()
    const dialogs = container.querySelectorAll('[data-stub-confirm]')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0].querySelector('h3')!.textContent).toBe(en.chat.forkFailedTitle)
    expect(dialogs[0].querySelector('p')!.textContent).toBe(en.chat.forkBusy)
    click(dialogs[0].querySelector('button')!)
    expect(clearForkError).toHaveBeenCalledTimes(1)
  })

  it('CH-38 with no refusal there is no dialog', () => {
    mount()
    expect(q('[data-stub-confirm]')).toBeNull()
  })
})

describe('MobileChatView: the details layer and the browser history', () => {
  /** 对话页那一条历史（外壳压的），这里代它立着 */
  const seed = (marks: Record<string, unknown> = { [CHAT]: true, [SCOPE]: true }): void =>
    window.history.replaceState(marks, '')

  it('CH-40 the title opens the index and pushes one entry that keeps the marks below it', () => {
    seed()
    mount()
    const push = vi.spyOn(window.history, 'pushState')
    click(titleButton())
    expect(push).toHaveBeenCalledTimes(1)
    expect(state()).toEqual({ [CHAT]: true, [SCOPE]: true, [DETAIL]: 'index', [DIRECT]: false })
    expect(lastDetails()).toMatchObject({ sessionId: 's1', page: 'index' })
    expect(detailsPage()).toBe('index')
  })

  it('CH-41 with no group below, only the chat mark is carried', () => {
    seed({ [CHAT]: true })
    mount()
    click(titleButton())
    expect(state()).toEqual({ [CHAT]: true, [DETAIL]: 'index', [DIRECT]: false })
  })

  it('CH-42 opening a section pushes one more entry', () => {
    seed()
    mount()
    const push = vi.spyOn(window.history, 'pushState')
    click(titleButton())
    openSection('paths')
    expect(push).toHaveBeenCalledTimes(2)
    expect(state()).toEqual({ [CHAT]: true, [SCOPE]: true, [DETAIL]: 'paths', [DIRECT]: false })
    expect(detailsPage()).toBe('paths')
    expect(lastDetails()).toMatchObject({ sessionId: 's1', page: 'paths' })
  })

  it("CH-43 the page's back goes one step at a time and never closes the chat page", async () => {
    seed()
    mount()
    click(titleButton())
    openSection('paths')

    await awaitPop(() => (lastDetails().onBack as () => void)())
    expect(detailsPage()).toBe('index')
    expect(state()?.[DETAIL]).toBe('index')

    await awaitPop(() => (lastDetails().onBack as () => void)())
    expect(details()).toBeNull()
    expect(mark(DETAIL)).toBe(false)
    expect(mark(CHAT)).toBe(true)
    expect(mark(SCOPE)).toBe(true)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('CH-44 the back gesture does the same', async () => {
    seed()
    mount()
    click(titleButton())
    openSection('paths')

    await back()
    expect(detailsPage()).toBe('index')
    expect(state()?.[DETAIL]).toBe('index')

    await back()
    expect(details()).toBeNull()
    expect(mark(DETAIL)).toBe(false)
    expect(mark(CHAT)).toBe(true)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('CH-45 going forward re-opens the page stored on that entry', async () => {
    seed()
    mount()
    click(titleButton())
    openSection('paths')
    await back()
    await back()
    expect(details()).toBeNull()

    await awaitPop(() => window.history.forward())
    expect(detailsPage()).toBe('index')
    await awaitPop(() => window.history.forward())
    expect(detailsPage()).toBe('paths')
  })

  it('CH-46 with no detail mark on the current entry, back closes the details at once', () => {
    seed()
    mount()
    click(titleButton())
    window.history.replaceState(null, '')
    const historyBack = vi.spyOn(window.history, 'back')
    act(() => (lastDetails().onBack as () => void)())
    expect(details()).toBeNull()
    expect(historyBack).not.toHaveBeenCalled()
  })

  it('CH-47 the details are not drawn without an active session', () => {
    seed()
    mount()
    click(titleButton())
    expect(details()).not.toBeNull()
    setStore({ activeSessionId: null })
    expect(details()).toBeNull()
  })

  it('CH-49 another session becoming active is another details page, not the same one re-used', () => {
    seed()
    rec.store.setState({ sessions: [session(), session({ id: 's2', title: 'Second' })] })
    mount()
    click(titleButton())
    const first = details()!.getAttribute('data-stub-details-instance')
    expect(details()!.getAttribute('data-stub-details-session')).toBe('s1')

    setStore({ activeSessionId: 's2' })
    expect(details()!.getAttribute('data-stub-details-session')).toBe('s2')
    expect(details()!.getAttribute('data-stub-details-instance')).not.toBe(first)
    expect(rec.detailMounts).toBe(2)
    expect(lastDetails()).toMatchObject({ sessionId: 's2', page: 'index' })
  })

  it('CH-49 the same session re-rendering keeps its details instance', () => {
    seed()
    mount()
    click(titleButton())
    setStore({ asks: { s1: 1 } })
    openSection('paths')
    expect(rec.detailMounts).toBe(1)
    expect(detailsPage()).toBe('paths')
  })

  it('CH-48 after unmount a popstate reaches nothing', () => {
    seed()
    mount()
    click(titleButton())
    unmount()
    const before = rec.details.length
    expect(() =>
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
    ).not.toThrow()
    expect(rec.details.length).toBe(before)
    expect(body('[data-mobile-pulldown-layer]')).toBeNull()
  })
})

describe('MobileChatView: the empty page entries open a section directly', () => {
  const seed = (marks: Record<string, unknown> = { [CHAT]: true, [SCOPE]: true }): void =>
    window.history.replaceState(marks, '')

  it('CH-50 the empty state given to ChatBody is MobileEmptyChat for the active session', () => {
    mount()
    expect(q('[data-stub-empty]')!.getAttribute('data-stub-empty')).toBe('s1')
    expect(rec.empties.at(-1)).toMatchObject({ sessionId: 's1' })
    expect(typeof rec.empties.at(-1)!.onOpenSection).toBe('function')
  })

  it('CH-50 the empty state element is keyed by the session id', () => {
    rec.store.setState({ sessions: [session(), session({ id: 's2', title: 'Second' })] })
    mount()
    expect(rec.emptyKeys.at(-1)).toBe('s1')
    setStore({ activeSessionId: 's2' })
    expect(rec.emptyKeys.at(-1)).toBe('s2')
    expect(q('[data-stub-empty]')!.getAttribute('data-stub-empty')).toBe('s2')
  })

  it('CH-51 tapping an entry pushes exactly one entry, marked direct, keeping the marks below', () => {
    seed()
    mount()
    const before = window.history.length
    const push = vi.spyOn(window.history, 'pushState')
    click(emptyRow('paths'))
    expect(push).toHaveBeenCalledTimes(1)
    expect(window.history.length).toBe(before + 1)
    expect(state()).toEqual({ [CHAT]: true, [SCOPE]: true, [DETAIL]: 'paths', [DIRECT]: true })
  })

  it('CH-52 the details then show that section, told it was opened directly', () => {
    seed()
    mount()
    click(emptyRow('paths'))
    expect(detailsPage()).toBe('paths')
    expect(lastDetails()).toMatchObject({ sessionId: 's1', page: 'paths', direct: true })
  })

  it.each(['extensions', 'knowledge', 'paths'])(
    'CH-53 the %s entry opens its own section directly',
    (section) => {
      seed()
      mount()
      const push = vi.spyOn(window.history, 'pushState')
      click(emptyRow(section))
      expect(push).toHaveBeenCalledTimes(1)
      expect(state()).toEqual({ [CHAT]: true, [SCOPE]: true, [DETAIL]: section, [DIRECT]: true })
      expect(lastDetails()).toMatchObject({ page: section, direct: true })
    }
  )

  it("CH-54 the page's back from a direct section is one step back to the chat page", async () => {
    seed()
    mount()
    click(emptyRow('paths'))
    const historyBack = vi.spyOn(window.history, 'back')
    await awaitPop(() => (lastDetails().onBack as () => void)())
    expect(historyBack).toHaveBeenCalledTimes(1)
    expect(details()).toBeNull()
    expect(mark(DETAIL)).toBe(false)
    expect(mark(CHAT)).toBe(true)
    expect(mark(SCOPE)).toBe(true)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('CH-55 the back gesture from a direct section does the same', async () => {
    seed()
    mount()
    click(emptyRow('paths'))
    await back()
    expect(details()).toBeNull()
    expect(mark(DETAIL)).toBe(false)
    expect(mark(CHAT)).toBe(true)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('CH-56 going forward re-opens the direct section as direct', async () => {
    seed()
    mount()
    click(emptyRow('paths'))
    await back()
    await awaitPop(() => window.history.forward())
    expect(detailsPage()).toBe('paths')
    expect(lastDetails()).toMatchObject({ page: 'paths', direct: true })
  })

  it('CH-57 the index opened from the title is not direct', () => {
    seed()
    mount()
    click(titleButton())
    expect(state()?.[DIRECT]).toBe(false)
    expect(lastDetails()).toMatchObject({ page: 'index', direct: false })
  })

  it('CH-58 a section opened from the index is not direct, and back lands on the index', async () => {
    seed()
    mount()
    click(titleButton())
    openSection('paths')
    expect(state()?.[DIRECT]).toBe(false)
    expect(lastDetails()).toMatchObject({ page: 'paths', direct: false })
    await back()
    expect(detailsPage()).toBe('index')
    expect(detailsDirect()).toBe('false')
  })

  it('CH-59 the direct flag does not stick to later pages', async () => {
    seed()
    mount()
    click(emptyRow('paths'))
    expect(detailsDirect()).toBe('true')
    await back()
    click(titleButton())
    expect(lastDetails()).toMatchObject({ page: 'index', direct: false })
    openSection('paths')
    expect(lastDetails()).toMatchObject({ page: 'paths', direct: false })
    expect(state()?.[DIRECT]).toBe(false)
  })

  it('CH-60 a direct section whose entry lost its mark closes at once and resets the flag', () => {
    seed()
    mount()
    click(emptyRow('paths'))
    window.history.replaceState({}, '')
    const historyBack = vi.spyOn(window.history, 'back')
    act(() => (lastDetails().onBack as () => void)())
    expect(details()).toBeNull()
    expect(historyBack).not.toHaveBeenCalled()
    click(titleButton())
    expect(lastDetails()).toMatchObject({ page: 'index', direct: false })
  })

  it('CH-61 an index entry carrying the direct mark is still an ordinary index', () => {
    seed()
    mount()
    window.history.replaceState({ [CHAT]: true, [DETAIL]: 'index', [DIRECT]: true }, '')
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(detailsPage()).toBe('index')
    expect(lastDetails()).toMatchObject({ page: 'index', direct: false })
  })

  it('CH-62 another session becoming active under a direct section: a new page, same section', () => {
    seed()
    rec.store.setState({ sessions: [session(), session({ id: 's2', title: 'Second' })] })
    mount()
    click(emptyRow('paths'))
    const first = details()!.getAttribute('data-stub-details-instance')
    setStore({ activeSessionId: 's2' })
    expect(details()!.getAttribute('data-stub-details-instance')).not.toBe(first)
    expect(lastDetails()).toMatchObject({ sessionId: 's2', page: 'paths', direct: true })
  })
})
