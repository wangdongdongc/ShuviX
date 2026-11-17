// @vitest-environment jsdom
/**
 * 手机布局的对话页顶栏、「⋯」下拉菜单与详情那一层的历史（mobile/MobileChatView.tsx，jsdom）。
 *
 * 契约：
 * - 顶栏三格：返回（后面的数字 = 别处还有几条会话在等你：挂着询问或有没看的新回复，去掉此刻开着的这一条）；
 *   标题 + 一行小字「在哪干活 · 状态」（有询问 > 正在回复；停着只有位置；位置空着就没有分隔点），点它推入详情；
 *   右边一颗「⋯」；
 * - 「⋯」的菜单：文件、后台任务（数 = 还在跑的）、产物 | 导出对话（笔记本会话没有）、分支会话（宿主给、形态给
 *   才有；这一轮在跑 / 被中断时置灰）| 详情。点菜单外、Esc、返回手势收起；
 * - 文件 / 任务 / 产物各是整屏推入的页面（2026-11-16，此前是底部抽屉）：一摞页面记在浏览器历史里
 *   （`shuvixMobilePanel`，见 panelHistory.ts），每进一层压一条、带着下面各层的标记；一摞都挂着、只露最上面那一页；
 *   页面自己的返回与返回手势一层一层退，退完还在对话页；「在对话中引用」之后、换了会话之后整摞收起（一次退够）；
 *   会话没了由外壳连同对话页一起退，这里不动；对话里点了任务状态 / 「已有新版」→ 推入列表页 + 详情页（子会话的
 *   任务只到列表页），已经开着这几页时不理；
 * - 详情那一层连着浏览器历史：首页一条、子页再一条（都带着下面各层的标记），返回键 / 返回手势一层一层退；
 *   换了会话就是另一份详情；
 * - 空对话页（MobileEmptyChat，按会话 id 作 key）的入口行**直接**推入详情里的那一段：只压一条历史，带
 *   `shuvixMobileDetailDirect: true`，返回一步就回对话页；从首页进去的子页那个记号是 false。
 *
 *   CH-1..15  顶栏：三格、返回、返回键后面的数、小字与状态、没有活跃会话
 *   CH-20..39 菜单：位置、各种会话的项、任务数、置灰的分支、各项做什么、怎么收起、分支被拒的说明
 *   CV-1..15  文件 / 任务 / 产物那一摞页面与浏览器历史
 *   CH-40..49 详情的历史：推入、子页、一层一层退、前进、没有标记时直接收起、没有会话不画、换会话换一份
 *   CH-50..62 空对话页的入口：给 ChatBody 的空态、直接推入的那一段、返回一步、前进、记号不粘、换会话
 *   MB-1..4   无人值守的一轮（docs/unattended-run-design.md §6）：标题前一个计时器图标，只在这条会话正在回复且
 *             store 里记着它无人值守时画；小字不加词；它不是单独的点击目标（手机上没有「我在这儿」）
 *
 * `@shuvix/chat-ui` / `@shuvix/app-shell` 整个换成替身（chat store 是工厂里建的真 zustand store）；
 * MobileSessionDetails / MobileEmptyChat / useSessionLocation / 笔记本、文件 / 任务 / 产物各页（MobileFilesPage /
 * MobileTasksPage / MobileArtifactsPage，记 props 与挂载次数）也是替身；PullDownMenu、detailHistory、panelHistory、
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
  sessionUnattended?: Record<string, true>
  taskRevealRequest?: { taskId: string } | null
  artifactRevealRequest?: { sessionId: string; name: string } | null
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
  /** 后台任务表（`useBgTaskStore.getState().tasks`）：任务 id → 只要 kind */
  bgTasks: {} as Record<string, { kind: string }>,
  /** 文件 / 任务 / 产物各页替身收到的 props（每次渲染记一次，带上哪一种与第几个实例） */
  pages: [] as Array<Record<string, unknown>>,
  /** 各页替身挂载过几次（每挂一次是一个新实例） */
  pageMounts: 0,
  /** 任务详情页替身：这些会话里找不到那条任务，一挂上就自己 onBack（真的那一页就是这样） */
  taskGoneIn: new Set<string>(),
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
    useBgTaskStore: { getState: () => ({ tasks: rec.bgTasks }) },
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
    basename: (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? '',
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
/** 一张推入页的替身：记 props、数挂载次数；文件页带一个输入框（看它在不在原处） */
async function pageStub(
  kind: string,
  extra?: (props: Props) => void
): Promise<(props: Props) => unknown> {
  const { createElement: h, useEffect, useState } = await import('react')
  return (props: Props) => {
    const [instance] = useState(() => ++rec.pageMounts)
    rec.pages.push({ ...props, kind, instance })
    useEffect(() => {
      extra?.(props)
      // 只在挂上时看一次
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return h(
      'div',
      { 'data-stub-page': kind, 'data-stub-page-instance': String(instance) },
      kind === 'files' ? h('input', { 'data-stub-page-input': '' }) : null
    )
  }
}
vi.mock('../MobileFilesPage', async () => ({ MobileFilesPage: await pageStub('files') }))
vi.mock('../MobileTasksPage', async () => ({
  MobileTasksPage: await pageStub('tasks'),
  MobileTaskDetailPage: await pageStub('task', (props) => {
    if (rec.taskGoneIn.has(String(props.sessionId))) (props.onBack as () => void)()
  })
}))
vi.mock('../MobileArtifactsPage', async () => ({
  MobileArtifactsPage: await pageStub('artifacts'),
  MobileArtifactDetailPage: await pageStub('artifact')
}))
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
const PANEL = 'shuvixMobilePanel'

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

// 文件 / 任务 / 产物那一摞页面（各页是替身）
const layerEls = (): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-mobile-panel-layer]'))
/** 挂着的各层，从下往上 */
const layers = (): Array<string | null> =>
  layerEls().map((el) => el.getAttribute('data-mobile-panel-layer'))
/** 露着的那几层（应该只有最上面一层） */
const shownLayers = (): Array<string | null> =>
  layerEls()
    .filter((el) => el.style.display !== 'none')
    .map((el) => el.getAttribute('data-mobile-panel-layer'))
const stack = (): unknown => state()?.[PANEL]
/** 某一种页面替身最近一次收到的 props（`match` 再挑：哪个文件夹、哪条任务） */
const pageProps = (kind: string, match: Record<string, unknown> = {}): Record<string, unknown> =>
  rec.pages.findLast(
    (p) => p.kind === kind && Object.entries(match).every(([key, value]) => p[key] === value)
  )!
const call = (props: Record<string, unknown>, name: string, ...args: unknown[]): void =>
  act(() => (props[name] as (...a: unknown[]) => void)(...args))

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
  // 前一个用例退回去之后留下的「前进」条目先截掉（不然再压一条时 history.length 不长）
  window.history.pushState(null, '')
  window.history.replaceState(null, '')
  rec.store.setState({
    activeSessionId: 's1',
    sessions: [session()],
    asks: {},
    streaming: {},
    forkable: { s1: true },
    sessionUnattended: {},
    taskRevealRequest: null,
    artifactRevealRequest: null
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
  rec.bgTasks = {}
  rec.pages.length = 0
  rec.pageMounts = 0
  rec.taskGoneIn = new Set()
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

  it('CH-22 with only finished tasks there is no number, and Tasks still opens the tasks page', () => {
    rec.tasks = { s1: [{ status: 'exited' }, { status: 'killed' }] }
    mount()
    openMenu()
    expect(menuCount('tasks')).toBeNull()
    expect(menu()!.querySelector('[data-mobile-menu-count]')).toBeNull()
    click(menuItem('tasks'))
    expect(shownLayers()).toEqual(['tasks'])
    expect(q('[data-mobile-panel-layer="tasks"] [data-stub-page="tasks"]')).not.toBeNull()
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

  it('CH-27 Files pushes the files page, not a sheet', () => {
    mount()
    pick('files')
    expect(menu()).toBeNull()
    expect(shownLayers()).toEqual(['files'])
    expect(q('[data-mobile-panel-layer="files"] [data-stub-page="files"]')).not.toBeNull()
    expect(q('[data-bottom-sheet]')).toBeNull()
  })

  it.each([
    ['no tasks', []],
    ['tasks', [{ status: 'running' }, { status: 'exited' }]]
  ])('CH-28 Background tasks with %s pushes the tasks page for the session', (_label, tasks) => {
    rec.tasks = { s1: tasks }
    mount()
    pick('tasks')
    expect(menu()).toBeNull()
    expect(shownLayers()).toEqual(['tasks'])
    expect(pageProps('tasks')).toMatchObject({ sessionId: 's1' })
    expect(q('[data-bottom-sheet]')).toBeNull()
  })

  it("CH-30 Artifacts pushes the session's artifacts page", () => {
    mount()
    pick('artifacts')
    expect(shownLayers()).toEqual(['artifacts'])
    expect(pageProps('artifacts')).toMatchObject({ sessionId: 's1' })
    expect(q('[data-bottom-sheet]')).toBeNull()
  })

  it('CH-31 Export chat exports this session and opens nothing', () => {
    mount()
    pick('export')
    expect(exportSession).toHaveBeenCalledTimes(1)
    expect(exportSession).toHaveBeenCalledWith('s1')
    expect(menu()).toBeNull()
    expect(layers()).toEqual([])
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
    expect(layers()).toEqual([])
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
    expect(layers()).toEqual([])
    expect(details()).toBeNull()
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

describe('MobileChatView: the files / tasks / artifacts pages and the browser history', () => {
  const seed = (marks: Record<string, unknown> = { [CHAT]: true, [SCOPE]: true }): void =>
    window.history.replaceState(marks, '')
  const filesAt = (dir: string): Record<string, unknown> => pageProps('files', { dir })
  /** 做一件事，当场（popstate 还没到）看一眼，再等到 popstate */
  async function thenPop(trigger: () => void, check: () => void = () => {}): Promise<void> {
    const popped = new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true })
    })
    act(trigger)
    check()
    await act(async () => {
      await popped
    })
  }
  const reveal = (patch: Partial<ChatState>): void => setStore(patch)

  it('CV-1 Files pushes one entry that keeps the marks below it and shows one page', () => {
    seed()
    mount()
    const before = window.history.length
    pick('files')
    expect(window.history.length).toBe(before + 1)
    expect(state()).toEqual({ [CHAT]: true, [SCOPE]: true, [PANEL]: ['files'] })
    expect(layers()).toEqual(['files'])
    expect(shownLayers()).toEqual(['files'])
    expect(filesAt('')).toMatchObject({ sessionId: 's1', dir: '', backLabel: M.detailsBack })
    expect(q('[data-bottom-sheet]')).toBeNull()
    expect(menu()).toBeNull()
    expect(details()).toBeNull()
  })

  it.each([
    ['tasks', ['tasks']],
    ['artifacts', ['artifacts']]
  ])('CV-1 %s pushes its own first page the same way', (id, expected) => {
    seed({ [CHAT]: true })
    mount()
    const before = window.history.length
    pick(id)
    expect(window.history.length).toBe(before + 1)
    expect(state()).toEqual({ [CHAT]: true, [PANEL]: expected })
    expect(shownLayers()).toEqual(expected)
  })

  it('CV-2 each folder is one more entry and one more page; only the last is shown', () => {
    seed()
    mount()
    pick('files')
    const before = window.history.length

    call(filesAt(''), 'onOpenDir', 'src')
    expect(window.history.length).toBe(before + 1)
    expect(state()).toEqual({ [CHAT]: true, [SCOPE]: true, [PANEL]: ['files', 'files:src'] })

    call(filesAt('src'), 'onOpenDir', 'src/main')
    expect(window.history.length).toBe(before + 2)
    expect(stack()).toEqual(['files', 'files:src', 'files:src/main'])
    expect(layers()).toEqual(['files', 'files:src', 'files:src/main'])
    expect(shownLayers()).toEqual(['files:src/main'])

    expect(filesAt('').backLabel).toBe(M.detailsBack)
    expect(filesAt('src').backLabel).toBe(M.files)
    expect(filesAt('src/main').backLabel).toBe('src')
    expect(filesAt('src/main')).toMatchObject({ sessionId: 's1', dir: 'src/main' })
  })

  it('CV-3 a task opens its detail page above the list', () => {
    seed()
    mount()
    pick('tasks')
    call(pageProps('tasks'), 'onOpenTask', 't1')
    expect(stack()).toEqual(['tasks', 'task:t1'])
    expect(shownLayers()).toEqual(['task:t1'])
    expect(pageProps('task')).toMatchObject({ sessionId: 's1', taskId: 't1' })
  })

  it('CV-3 an artifact opens its detail page above the list, keyed by its own session', () => {
    seed()
    mount()
    pick('artifacts')
    call(pageProps('artifacts'), 'onOpenArtifact', { sessionId: 'sub1', name: 'a.svg' })
    expect(stack()).toEqual(['artifacts', 'artifact:sub1/a.svg'])
    expect(shownLayers()).toEqual(['artifact:sub1/a.svg'])
    expect(pageProps('artifact')).toMatchObject({ sessionId: 's1', artifactKey: 'sub1/a.svg' })
  })

  it('CV-4 the pages below stay mounted: the root page is the same one after a folder and back', async () => {
    seed()
    mount()
    pick('files')
    const rootInput = q(
      '[data-mobile-panel-layer="files"] [data-stub-page-input]'
    ) as HTMLInputElement
    rootInput.value = 'typed'
    const instance = filesAt('').instance

    call(filesAt(''), 'onOpenDir', 'src')
    expect(rec.pageMounts).toBe(2)
    expect(q('[data-mobile-panel-layer="files"] [data-stub-page-input]')).toBe(rootInput)

    await back()
    expect(layers()).toEqual(['files'])
    expect(shownLayers()).toEqual(['files'])
    expect(rec.pageMounts).toBe(2)
    expect(filesAt('').instance).toBe(instance)
    const again = q('[data-mobile-panel-layer="files"] [data-stub-page-input]') as HTMLInputElement
    expect(again).toBe(rootInput)
    expect(again.value).toBe('typed')
  })

  it("CV-5 a page's back goes one level at a time and never closes the chat page", async () => {
    seed()
    mount()
    pick('files')
    call(filesAt(''), 'onOpenDir', 'src')
    const historyBack = vi.spyOn(window.history, 'back')

    await awaitPop(() => (filesAt('src').onBack as () => void)())
    expect(historyBack).toHaveBeenCalledTimes(1)
    expect(stack()).toEqual(['files'])
    expect(shownLayers()).toEqual(['files'])
    expect(mark(CHAT)).toBe(true)

    await awaitPop(() => (filesAt('').onBack as () => void)())
    expect(historyBack).toHaveBeenCalledTimes(2)
    expect(layers()).toEqual([])
    expect(mark(PANEL)).toBe(false)
    expect(mark(CHAT)).toBe(true)
    expect(mark(SCOPE)).toBe(true)
    expect(onBack).not.toHaveBeenCalled()
  })

  it.each<[string, () => void]>([
    ['the task detail', () => call(pageProps('tasks'), 'onOpenTask', 't1')],
    [
      'the artifact detail',
      () => call(pageProps('artifacts'), 'onOpenArtifact', { sessionId: 's1', name: 'a.svg' })
    ]
  ])("CV-5 %s's back lands on its list", async (label, openDetail) => {
    const kind = label.includes('task') ? 'tasks' : 'artifacts'
    const detail = label.includes('task') ? 'task' : 'artifact'
    seed()
    mount()
    pick(kind)
    openDetail()
    await awaitPop(() => (pageProps(detail).onBack as () => void)())
    expect(shownLayers()).toEqual([kind])
    await awaitPop(() => (pageProps(kind).onBack as () => void)())
    expect(layers()).toEqual([])
    expect(mark(CHAT)).toBe(true)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('CV-6 the back gesture does the same, and forward re-opens the stack stored on the entry', async () => {
    seed()
    mount()
    pick('files')
    call(filesAt(''), 'onOpenDir', 'src')

    await back()
    expect(shownLayers()).toEqual(['files'])
    await back()
    expect(layers()).toEqual([])
    expect(mark(CHAT)).toBe(true)
    expect(onBack).not.toHaveBeenCalled()

    await awaitPop(() => window.history.forward())
    expect(layers()).toEqual(['files'])
    await awaitPop(() => window.history.forward())
    expect(layers()).toEqual(['files', 'files:src'])
    expect(shownLayers()).toEqual(['files:src'])
  })

  it('CV-7 with no stack on the current entry, back closes the pages at once', () => {
    seed()
    mount()
    pick('files')
    window.history.replaceState({ [CHAT]: true }, '')
    const historyBack = vi.spyOn(window.history, 'back')
    const historyGo = vi.spyOn(window.history, 'go')
    call(filesAt(''), 'onBack')
    expect(layers()).toEqual([])
    expect(historyBack).not.toHaveBeenCalled()
    expect(historyGo).not.toHaveBeenCalled()
  })

  it('CV-8 no page is drawn without an active session, even with a stack on the entry', () => {
    rec.store.setState({ activeSessionId: null })
    seed({ [CHAT]: true, [PANEL]: ['files', 'files:src'] })
    mount()
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(layers()).toEqual([])
    expect(menuButton().disabled).toBe(true)
  })

  it('CV-8 a broken stack on the entry draws nothing', () => {
    seed({ [CHAT]: true, [PANEL]: ['tasks', 'files:src'] })
    mount()
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(layers()).toEqual([])
  })

  it('CV-9 a mention inserted from a folder three levels deep closes the whole stack in one go', async () => {
    seed()
    mount()
    pick('files')
    call(filesAt(''), 'onOpenDir', 'src')
    call(filesAt('src'), 'onOpenDir', 'src/main')
    const before = window.history.length
    const historyGo = vi.spyOn(window.history, 'go')
    const historyBack = vi.spyOn(window.history, 'back')

    await thenPop(
      () => (filesAt('src/main').onMentionInserted as () => void)(),
      // 页面当场收起，不等 popstate
      () => expect(layers()).toEqual([])
    )
    expect(historyGo).toHaveBeenCalledTimes(1)
    expect(historyGo).toHaveBeenCalledWith(-3)
    expect(historyBack).not.toHaveBeenCalled()
    expect(layers()).toEqual([])
    expect(state()).toEqual({ [CHAT]: true, [SCOPE]: true })
    expect(window.history.length).toBe(before)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('CV-9 with no stack on the entry the pages are cleared without touching history', () => {
    seed()
    mount()
    pick('files')
    window.history.replaceState({ [CHAT]: true }, '')
    const historyGo = vi.spyOn(window.history, 'go')
    call(filesAt(''), 'onMentionInserted')
    expect(layers()).toEqual([])
    expect(historyGo).not.toHaveBeenCalled()
  })

  it("CV-10 another session becoming active closes the pages: they were the other session's", async () => {
    seed()
    rec.store.setState({ sessions: [session(), session({ id: 'child', title: 'Child' })] })
    mount()
    pick('tasks')
    const historyGo = vi.spyOn(window.history, 'go')

    await thenPop(
      () => rec.store.setState({ activeSessionId: 'child' }),
      () => expect(layers()).toEqual([])
    )
    expect(historyGo).toHaveBeenCalledTimes(1)
    expect(historyGo).toHaveBeenCalledWith(-1)
    expect(layers()).toEqual([])
    expect(state()).toEqual({ [CHAT]: true, [SCOPE]: true })
    // 任务页没有换成新会话的再画一遍
    expect(rec.pages.some((p) => p.sessionId === 'child')).toBe(false)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('CV-10 another session becoming active with no page open touches no history', () => {
    seed()
    rec.store.setState({ sessions: [session(), session({ id: 's2' })] })
    mount()
    const historyGo = vi.spyOn(window.history, 'go')
    setStore({ activeSessionId: 's2' })
    expect(historyGo).not.toHaveBeenCalled()
  })

  it('CV-11 the session going away is left to the shell: no history call here, no page drawn', () => {
    seed()
    mount()
    pick('files')
    call(filesAt(''), 'onOpenDir', 'src')
    const historyGo = vi.spyOn(window.history, 'go')
    const historyBack = vi.spyOn(window.history, 'back')
    setStore({ activeSessionId: null })
    expect(historyGo).not.toHaveBeenCalled()
    expect(historyBack).not.toHaveBeenCalled()
    expect(layers()).toEqual([])
    expect(stack()).toEqual(['files', 'files:src'])
  })

  it.each([
    ['a command', { t9: { kind: 'bash' } }],
    ['an agent', { t9: { kind: 'agent' } }],
    ['a task the list does not know', {}]
  ])('CV-12 a task reveal for %s pushes the list, then its detail', async (_label, tasks) => {
    rec.bgTasks = tasks
    seed()
    mount()
    const before = window.history.length
    reveal({ taskRevealRequest: { taskId: 't9' } })
    expect(window.history.length).toBe(before + 2)
    expect(state()).toEqual({ [CHAT]: true, [SCOPE]: true, [PANEL]: ['tasks', 'task:t9'] })
    expect(layers()).toEqual(['tasks', 'task:t9'])
    expect(shownLayers()).toEqual(['task:t9'])
    expect(pageProps('task')).toMatchObject({ sessionId: 's1', taskId: 't9' })

    await back()
    expect(stack()).toEqual(['tasks'])
    expect(shownLayers()).toEqual(['tasks'])
    await back()
    expect(layers()).toEqual([])
    expect(mark(CHAT)).toBe(true)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('CV-12 a task reveal for a sub-session turn pushes the list only', async () => {
    rec.bgTasks = { t9: { kind: 'sub-session' } }
    seed()
    mount()
    const before = window.history.length
    reveal({ taskRevealRequest: { taskId: 't9' } })
    expect(window.history.length).toBe(before + 1)
    expect(stack()).toEqual(['tasks'])
    expect(shownLayers()).toEqual(['tasks'])
    expect(rec.pages.some((p) => p.kind === 'task')).toBe(false)
    await back()
    expect(layers()).toEqual([])
    expect(mark(CHAT)).toBe(true)
  })

  it('CV-12 the same request object seen again pushes nothing more; a new one does', async () => {
    seed()
    mount()
    const request = { taskId: 't9' }
    reveal({ taskRevealRequest: request })
    await back()
    await back()
    const before = window.history.length
    setStore({ asks: { s1: 1 } })
    expect(layers()).toEqual([])
    reveal({ taskRevealRequest: { taskId: 't9' } })
    expect(stack()).toEqual(['tasks', 'task:t9'])
    expect(window.history.length).toBe(before)
  })

  it('CV-13 an artifact reveal pushes the list, then its detail', async () => {
    seed()
    mount()
    const before = window.history.length
    reveal({ artifactRevealRequest: { sessionId: 'sub1', name: 'a.svg' } })
    expect(window.history.length).toBe(before + 2)
    expect(state()).toEqual({
      [CHAT]: true,
      [SCOPE]: true,
      [PANEL]: ['artifacts', 'artifact:sub1/a.svg']
    })
    expect(shownLayers()).toEqual(['artifact:sub1/a.svg'])
    expect(pageProps('artifact')).toMatchObject({ sessionId: 's1', artifactKey: 'sub1/a.svg' })
    await back()
    expect(shownLayers()).toEqual(['artifacts'])
  })

  it.each<[string, Partial<ChatState>]>([
    ['a task', { taskRevealRequest: { taskId: 't9' } }],
    ['an artifact', { artifactRevealRequest: { sessionId: 's1', name: 'a.svg' } }]
  ])('CV-14 with a page already open, a reveal of %s changes nothing', (_label, patch) => {
    seed()
    mount()
    pick('files')
    const before = window.history.length
    const push = vi.spyOn(window.history, 'pushState')
    reveal(patch)
    expect(push).not.toHaveBeenCalled()
    expect(window.history.length).toBe(before)
    expect(stack()).toEqual(['files'])
    expect(layers()).toEqual(['files'])
  })

  it('CV-14 a reveal with no active session pushes nothing', () => {
    rec.store.setState({ activeSessionId: null })
    seed()
    mount()
    const push = vi.spyOn(window.history, 'pushState')
    reveal({ taskRevealRequest: { taskId: 't9' } })
    reveal({ artifactRevealRequest: { sessionId: 's1', name: 'a.svg' } })
    expect(push).not.toHaveBeenCalled()
    expect(layers()).toEqual([])
  })

  it('CV-15 the session changing under a task detail goes back exactly as deep as the stack', async () => {
    seed()
    rec.store.setState({ sessions: [session(), session({ id: 's2', title: 'Second' })] })
    // 新会话里没有那条任务：详情页要是给它重画一遍，会自己再退一步
    rec.taskGoneIn = new Set(['s2'])
    mount()
    pick('tasks')
    call(pageProps('tasks'), 'onOpenTask', 't1')
    const historyGo = vi.spyOn(window.history, 'go')
    const historyBack = vi.spyOn(window.history, 'back')

    await thenPop(() => rec.store.setState({ activeSessionId: 's2' }))
    expect(historyGo).toHaveBeenCalledTimes(1)
    expect(historyGo).toHaveBeenCalledWith(-2)
    expect(historyBack).not.toHaveBeenCalled()
    expect(layers()).toEqual([])
    // 对话页那一条还在
    expect(state()).toEqual({ [CHAT]: true, [SCOPE]: true })
    expect(onBack).not.toHaveBeenCalled()
  })

  it('CV-15 after unmount the store is no longer listened to', () => {
    seed()
    mount()
    unmount()
    const push = vi.spyOn(window.history, 'pushState')
    const historyGo = vi.spyOn(window.history, 'go')
    rec.store.setState({ taskRevealRequest: { taskId: 't9' } })
    rec.store.setState({ activeSessionId: 's2' })
    expect(push).not.toHaveBeenCalled()
    expect(historyGo).not.toHaveBeenCalled()
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

describe('MobileChatView: an unattended run', () => {
  const icon = (): Element | null => q('[data-mobile-chat-unattended]')

  it('MB-1 replying and unattended: a timer before the title text, labelled, no extra words', () => {
    rec.store.setState({ streaming: { s1: true }, sessionUnattended: { s1: true } })
    mount()
    const el = icon()!
    expect(el).not.toBeNull()
    expect(el.tagName.toLowerCase()).toBe('svg')
    expect(titleButton().contains(el)).toBe(true)
    expect(el.getAttribute('aria-label')).toBe(en.toolCall.unattendedRun)
    expect(el.getAttribute('class')).toContain('text-warning')
    // 图标在标题文字之前，标题文字不变
    const title = titleButton().querySelector('span')!
    expect(title.firstElementChild).toBe(el)
    expect(title.textContent).toBe('My chat')
    // 小字还是「位置 · 正在回复」，不加词
    expect(subtitle()!.textContent).toBe(`Proj · ${en.inbox.replying}`)
    // 头部还是三个按钮：图标不是按钮
    expect(q('[data-mobile-chat-header]')!.querySelectorAll('button')).toHaveLength(3)
  })

  it('MB-1 the store still says unattended after the run ended: no icon', () => {
    rec.store.setState({ streaming: {}, sessionUnattended: { s1: true } })
    mount()
    expect(icon()).toBeNull()
    expect(subtitle()!.textContent).toBe('Proj')
  })

  it.each<[string, Partial<ChatState>]>([
    ['another session is unattended', { streaming: { s1: true }, sessionUnattended: { s2: true } }],
    ['attended and replying', { streaming: { s1: true }, sessionUnattended: {} }],
    [
      'another session is the one replying',
      { streaming: { s2: true }, sessionUnattended: { s1: true } }
    ],
    [
      'no active session',
      { activeSessionId: null, streaming: { s1: true }, sessionUnattended: { s1: true } }
    ],
    [
      'a host whose store has no such table',
      { streaming: { s1: true }, sessionUnattended: undefined }
    ]
  ])('MB-2 %s: no icon', (_label, patch) => {
    rec.store.setState(patch)
    expect(mount).not.toThrow()
    expect(icon()).toBeNull()
  })

  it('MB-3 a tap on the icon is a tap on the title: it opens the details, nothing else', () => {
    rec.store.setState({ streaming: { s1: true }, sessionUnattended: { s1: true } })
    mount()
    click(icon()!)
    expect(detailsPage()).toBe('index')
    expect(mark(DETAIL)).toBe(true)
    // 状态没被点掉
    expect(rec.store.getState().sessionUnattended).toStrictEqual({ s1: true })
  })

  it('MB-4 the icon follows the store without remounting the header', () => {
    rec.store.setState({ streaming: { s1: true } })
    mount()
    const header = q('[data-mobile-chat-header]')!
    const title = titleButton()
    expect(icon()).toBeNull()

    setStore({ sessionUnattended: { s1: true } })
    expect(icon()).not.toBeNull()

    setStore({ sessionUnattended: {} })
    expect(icon()).toBeNull()

    setStore({ sessionUnattended: { s1: true } })
    setStore({ streaming: {} })
    expect(icon()).toBeNull()

    expect(q('[data-mobile-chat-header]')).toBe(header)
    expect(titleButton()).toBe(title)
  })

  it('MB-4 waiting for an answer (not replying) while marked unattended: no icon', () => {
    rec.store.setState({ asks: { s1: 1 }, sessionUnattended: { s1: true } })
    mount()
    expect(icon()).toBeNull()
    expect(chatState()!.getAttribute('data-mobile-chat-state')).toBe('waiting')
  })
})
