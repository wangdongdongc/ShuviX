// @vitest-environment jsdom
/**
 * 收件箱面板的在跑记号（jsdom）—— 与侧栏同一套（S1，2026-11-11）：
 *
 *   INP-1 一张列表，按轻重缓急：等你回答 > 新回复 > agent 在干活 > 只剩后台命令
 *   INP-2 agent 在干活的行：行首是会话图标（蓝色实心呼吸），读屏文字与悬停提示「An agent is working」，不写命令
 *   INP-3 只剩后台命令的行：绿色实心不动，提示「Only background commands are running」
 *   INP-4 行首图标的形状按会话种类：定时运行 / bot / 笔记本 / 普通 / 有子会话（实心两片）
 *   INP-5 只剩后台命令的预览：第一条开着的命令（只取第一行、去两头空白），再有就 +N；结束的、别的会话的不算
 *   INP-6 只有 hook agent / 只有结束了的命令 → 不收；什么都没有 → 空页
 *   INP-7 挂着询问的行不画会话图标（问号），预览是询问数
 *   INP-8 父会话停着：抬头是线框两片、灰色；子会话的圆点 running、resident；点开后各自的行带各自的种类
 *   INP-9 父会话只剩后台命令、子会话在跑：父行绿色实心两片，圆点 running；这一家排在只剩后台命令的别家前面
 *   INP-10 只剩后台命令又有出错的新回复：只有新回复那一行（红点）
 *   INP-11 侧栏「收件箱」那一行的数字：等你回答 + 新回复，只是在跑的不算
 *
 * 收件箱在右侧面板里（2026-11-12 E1）：留着的那一条、选中态、按键的范围
 *
 *   INH-5..16, 19, 20  作为新回复打开的那条留在原处（held），切到别的会话才走；正开着的那条的行带选中；点行不动面板
 *   INT-6  侧栏「收件箱」那一行只打开面板：没有选中态，数字照旧
 *   INK-1/2/3/8  J / K / ⏎ 与数字键只在焦点落在面板里时归它；换了会话，焦点从面板里交还出去
 *
 * `@shuvix/chat-ui` 整份换成替身（同 projectSessionGroupsRunning）；后台任务的口径用 chat-ui 的真函数
 * （taskRunKind / selectBgRunKinds，按相对路径取源码）。selectBgRunKinds 按 tasks 的引用记忆，每个用例写一份新的。
 * 缺省的替身没有 `agent.pendingInputs`（询问表取不到），挂着询问的会话画成普通的一行；用例要卡片时给 `store.api`
 * 换一份带 pendingInputs 的。`useChatStore.subscribe` 是活的（`setActive` 通知它）：放掉留着的那条靠订阅，
 * inboxStore 只订一次（模块级），所以监听集从头到尾不清。替身的 hook 不会让组件重渲染，store 一改就 `rerender()`。
 * 数字键的两个上下文与 `useOptionHotkeys` 取真的（按相对路径）：面板给的 guard 要真的传到表单替身那里。
 * 文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { TaskInfo, TaskSubject } from '@shuvix/chat-protocol/types/task'
import type { SessionUnread } from '@shuvix/chat-protocol/sessionUnread'
import type { ChoiceInputRequest, InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

/** getChatApi() 交回的那一份（每个用例一份，同一用例里引用不变） */
interface FakeApi {
  agent: { pendingInputs?: () => Promise<Record<string, InputRequest[]>> }
  session: { markRead?: (id: string) => Promise<void>; markAllRead?: () => Promise<void> }
  message: { list: (id: string) => Promise<unknown[]> }
}
type StoreListener = (state: unknown, prev: unknown) => void

interface StoreSession {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
  settings: Record<string, unknown>
  createdAt: number
  updatedAt: number
  lastActiveAt: number
}
const store = vi.hoisted(() => ({
  sessions: [] as StoreSession[],
  activeSessionId: null as string | null,
  setActiveSessionId: (_id: string | null) => {},
  /** selectStreamingSessions 的结果 */
  streaming: {} as Record<string, boolean>,
  /** selectAllPendingCounts 的结果 */
  pending: {} as Record<string, number>,
  /** useBgTaskStore 的状态 */
  bg: { tasks: {} as Record<string, TaskInfo> },
  /** useUnreadStore 的状态 */
  unreadState: { unread: {} as Record<string, SessionUnread> },
  /** useChatStore.subscribe 的监听（inboxStore 第一次 hold 时订上，之后一直在） */
  listeners: new Set<StoreListener>(),
  api: { agent: {}, session: {}, message: { list: async () => [] } } as FakeApi,
  respondToInput: (_arg: unknown): Promise<{ success: boolean }> =>
    Promise.resolve({ success: true }),
  /** 表单替身的数字键选了什么：[请求 id, 行] */
  picks: [] as Array<[string, number]>
}))

vi.mock('@shuvix/chat-ui', async () => {
  const bgTasks = await import('../../../chat-ui/src/stores/bgTaskStore')
  const optionRows = await import('../../../chat-ui/src/components/chat/inputs/OptionRows')
  const { createElement: h } = await import('react')
  return {
    RedactedText: ({ text }: { text: string }) => text,
    RedactionSessionProvider: ({ children }: { children: unknown }) => children,
    useChatStore: Object.assign((selector: (s: typeof store) => unknown) => selector(store), {
      getState: () => store,
      subscribe: (listener: StoreListener) => {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      }
    }),
    selectStreamingSessions: (s: typeof store) => s.streaming,
    selectAllPendingCounts: (s: typeof store) => s.pending,
    useBgTaskStore: (selector: (s: typeof store.bg) => unknown) => selector(store.bg),
    selectBgRunKinds: bgTasks.selectBgRunKinds,
    taskRunKind: bgTasks.taskRunKind,
    useUnreadStore: (selector: (s: typeof store.unreadState) => unknown) =>
      selector(store.unreadState),
    getChatApi: () => store.api,
    getSessionChannelApi: () => ({
      agent: { respondToInput: (arg: unknown) => store.respondToInput(arg) }
    }),
    // 卡片里的表单：真的数字键 hook（两行），面板的 guard / 区域上下文要传得到这里
    InputRequestForm: ({ request }: { request: InputRequest }) => {
      optionRows.useOptionHotkeys(2, (i) => store.picks.push([request.id, i]))
      return h('div', { 'data-stub-form': request.id }, h('textarea', { 'data-stub-textarea': '' }))
    },
    useChatHost: () => ({ appearance: { focusMode: false } }),
    useAppEvent: () => {},
    copyToClipboard: () => {},
    useDialogClose: () => ({}),
    OptionHotkeyGuardContext: optionRows.OptionHotkeyGuardContext,
    OptionHotkeyScopeContext: optionRows.OptionHotkeyScopeContext,
    OPTION_HOTKEY_SCOPE_ATTR: optionRows.OPTION_HOTKEY_SCOPE_ATTR
  }
})

import { InboxPanel } from './InboxPanel'
import { InboxRow } from '../sidebar/InboxRow'
import { useInboxHoldStore } from './inboxStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function session(id: string, over: Partial<StoreSession> = {}): StoreSession {
  return {
    id,
    title: `Title ${id}`,
    projectId: null,
    parentId: null,
    settings: {},
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...over
  }
}

function bash(
  taskId: string,
  sessionId: string,
  command = `cmd ${taskId}`,
  over: Partial<TaskInfo> = {},
  subjectOver: Partial<TaskSubject> = {}
): TaskInfo {
  return {
    taskId,
    kind: 'bash',
    sessionId,
    title: taskId,
    status: 'running',
    detached: true,
    startedAt: 1,
    endedAt: null,
    subject: {
      kind: 'bash',
      command,
      cwd: '/tmp',
      pid: 1,
      logPath: `/tmp/${taskId}.log`,
      exitCode: null,
      signal: null,
      logCapped: false,
      ...subjectOver
    } as TaskSubject,
    ...over
  }
}
function agentTask(taskId: string, sessionId: string, parentToolCallId?: string): TaskInfo {
  return {
    taskId,
    kind: 'agent',
    sessionId,
    title: taskId,
    status: 'running',
    detached: true,
    startedAt: 1,
    endedAt: null,
    subject: { kind: 'agent', profileName: 'explore', depth: 1, parentToolCallId }
  }
}
const dispatched = (taskId: string, sessionId: string): TaskInfo =>
  agentTask(taskId, sessionId, `call_${taskId}`)
const hookAgent = (taskId: string, sessionId: string): TaskInfo => agentTask(taskId, sessionId)

/** 每次都是一份新的 tasks 对象（selectBgRunKinds 按引用记忆） */
function setTasks(list: TaskInfo[]): void {
  store.bg = { tasks: Object.fromEntries(list.map((t) => [t.taskId, t])) }
}
const unreadEntry = (failed = false): SessionUnread => ({ since: 1, failed, manual: false })
const unreadAt = (since: number): SessionUnread => ({ since, failed: false, manual: false })

/** 选中换一条：写 store，再像 zustand 那样通知订阅者 (state, prev) */
function setActive(id: string | null): void {
  const prev = { ...store }
  store.activeSessionId = id
  for (const listener of [...store.listeners]) listener(store, prev)
}
/** 每次点开会话那一刻，留着的是哪条 */
let heldAtSelect: Array<ReturnType<typeof useInboxHoldStore.getState>['held']> = []
/** 产品点开一条会话时调的那个（间谍） */
const selectSpy = vi.fn((id: string | null) => {
  heldAtSelect.push(useInboxHoldStore.getState().held)
  setActive(id)
})

function choice(id: string, createdAt = 0): ChoiceInputRequest {
  return {
    id,
    kind: 'choice',
    toolName: 'ask',
    question: `Question ${id}?`,
    options: [
      { label: 'A', description: '' },
      { label: 'B', description: '' }
    ],
    createdAt
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function mountPage(): Promise<void> {
  act(() => root.render(createElement(InboxPanel)))
  await flush()
}
/** 替身的 hook 不重渲染：store 改了之后手动再画一遍 */
async function rerender(): Promise<void> {
  await mountPage()
}

const itemRow = (id: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-inbox-item="${id}"]`)
function mustRow(id: string): HTMLElement {
  const el = itemRow(id)
  if (!el) throw new Error(`no inbox row for ${id}`)
  return el
}
/** 行首那一格（InboxLine 把它放在与上层对齐的槽里） */
const leading = (row: HTMLElement): HTMLElement =>
  row.firstElementChild?.firstElementChild as HTMLElement
const iconIn = (row: HTMLElement): SVGElement => {
  const svg = row.querySelector<SVGElement>('[data-session-icon]')
  if (!svg) throw new Error('no session icon in the row')
  return svg
}
const has = (el: Element, cls: string): boolean => el.classList.contains(cls)

beforeAll(async () => {
  // jsdom 没有 scrollIntoView（开着的卡片挂上时会滚到它）
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  store.sessions = []
  store.activeSessionId = null
  store.streaming = {}
  store.pending = {}
  store.unreadState = { unread: {} }
  store.api = { agent: {}, session: {}, message: { list: async () => [] } }
  store.respondToInput = vi.fn(async () => ({ success: true }))
  store.picks = []
  selectSpy.mockClear()
  heldAtSelect = []
  store.setActiveSessionId = selectSpy
  useInboxHoldStore.setState({ held: null })
  setTasks([])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  ;(document.activeElement as HTMLElement | null)?.blur?.()
})

describe('INP-1 one list, by priority', () => {
  it('INP-1 waiting, then unread, then agent working, then background commands only', async () => {
    store.sessions = [
      session('A', { lastActiveAt: 300 }),
      session('B', { lastActiveAt: 100 }),
      session('C', { lastActiveAt: 200 }),
      session('D', { lastActiveAt: 400 }),
      session('E', { lastActiveAt: 50 })
    ]
    store.pending = { E: 1 }
    store.streaming = { C: true }
    store.unreadState = { unread: { D: unreadEntry() } }
    setTasks([bash('d1', 'D'), dispatched('b1', 'B'), bash('a1', 'A')])
    await mountPage()

    const order = [
      ...container.querySelectorAll<HTMLElement>('[data-inbox-item],[data-inbox-unread]')
    ].map((el) => el.getAttribute('data-inbox-item') ?? el.getAttribute('data-inbox-unread'))
    expect(order).toEqual(['E', 'D', 'C', 'B', 'A'])

    expect(mustRow('E').getAttribute('data-inbox-kind')).toBe('waiting')
    expect(itemRow('D')).toBeNull()
    expect(container.querySelector('[data-inbox-unread="D"]')).not.toBeNull()
    expect(mustRow('C').getAttribute('data-run')).toBe('agent')
    expect(mustRow('B').getAttribute('data-run')).toBe('agent')
    expect(mustRow('A').getAttribute('data-run')).toBe('resident')
  })
})

describe('INP-2 / INP-3 the leading glyph', () => {
  it('INP-2 agent working (turn plus an open command): blue, solid, breathing; no command preview', async () => {
    store.sessions = [session('S')]
    store.streaming = { S: true }
    setTasks([bash('t1', 'S')])
    await mountPage()
    const row = mustRow('S')
    const cell = leading(row)
    expect(cell.getAttribute('role')).toBe('img')
    expect(cell.getAttribute('aria-label')).toBe(en.sidebar.runAgent)
    expect(cell.getAttribute('title')).toBe(en.sidebar.runAgent)
    const svg = iconIn(row)
    expect(svg.getAttribute('data-session-icon')).toBe('chat')
    expect(svg.getAttribute('data-run')).toBe('agent')
    expect(svg.getAttribute('fill')).toBe('currentColor')
    for (const cls of ['text-accent', 'animate-pulse', 'motion-reduce:animate-none']) {
      expect(has(svg, cls), cls).toBe(true)
    }
    expect(row.querySelector('[data-inbox-commands]')).toBeNull()
  })

  it('INP-3 background commands only: green, solid, still', async () => {
    store.sessions = [session('S')]
    setTasks([bash('t1', 'S')])
    await mountPage()
    const row = mustRow('S')
    const cell = leading(row)
    expect(cell.getAttribute('aria-label')).toBe(en.sidebar.runResident)
    expect(cell.getAttribute('title')).toBe(en.sidebar.runResident)
    const svg = iconIn(row)
    expect(svg.getAttribute('data-run')).toBe('resident')
    expect(svg.getAttribute('fill')).toBe('currentColor')
    expect(has(svg, 'text-success')).toBe(true)
    expect(has(svg, 'animate-pulse')).toBe(false)
  })
})

describe('INP-4 shape by session type', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['trigger run', { triggerRun: true }, 'trigger'],
    ['bot', { bot: 'b' }, 'bot'],
    ['notebook', { notebookPath: 'n.md' }, 'notebook'],
    ['trigger run of a bot', { triggerRun: true, bot: 'b' }, 'trigger'],
    ['plain', {}, 'chat']
  ])('INP-4 %s → %s', async (_label, settings, shape) => {
    store.sessions = [session('S', { settings })]
    store.streaming = { S: true }
    await mountPage()
    expect(iconIn(mustRow('S')).getAttribute('data-session-icon')).toBe(shape)
  })

  it('INP-4 plain with an idle child in the store → family, solid', async () => {
    store.sessions = [session('S'), session('K', { parentId: 'S' })]
    store.streaming = { S: true }
    await mountPage()
    const svg = iconIn(mustRow('S'))
    expect(svg.getAttribute('data-session-icon')).toBe('family')
    expect(has(svg, 'lucide-messages-square-solid')).toBe(true)
  })
})

describe('INP-5 the background-command preview', () => {
  it('INP-5 the first open command, first line trimmed, then +N', async () => {
    store.sessions = [session('S'), session('O')]
    setTasks([
      bash('t1', 'S', '  tail -f log  ', { startedAt: 1 }),
      bash('t2', 'S', 'npm run dev\n--port 3000', { startedAt: 2 }),
      bash('t3', 'S', 'echo done', { startedAt: 3, status: 'done', endedAt: 4 }),
      bash('t4', 'S', 'top', { startedAt: 4 }, { host: 'devbox', pid: -1 }),
      bash('o1', 'O', 'other', { startedAt: 0 })
    ])
    await mountPage()
    const preview = mustRow('S').querySelector<HTMLElement>('[data-inbox-commands]')
    expect(preview?.getAttribute('data-inbox-commands')).toBe('3')
    expect(preview!.querySelector('.font-mono')?.textContent).toBe('tail -f log')
    const more = [...preview!.children].find((el) => !el.classList.contains('font-mono'))
    expect(more?.textContent).toBe(' +2')
  })

  it('INP-5 a single command: its first line, no +N', async () => {
    store.sessions = [session('S')]
    setTasks([bash('t2', 'S', 'npm run dev\n--port 3000', { startedAt: 2 })])
    await mountPage()
    const preview = mustRow('S').querySelector<HTMLElement>('[data-inbox-commands]')
    expect(preview?.getAttribute('data-inbox-commands')).toBe('1')
    expect(preview!.querySelector('.font-mono')?.textContent).toBe('npm run dev')
    expect(preview!.textContent).toBe('npm run dev')
  })
})

describe('INP-6 what does not count', () => {
  it.each<[string, () => TaskInfo]>([
    ['only a hook-agent task', () => hookAgent('h1', 'S')],
    ['only a finished bash', () => bash('t1', 'S', 'x', { status: 'done', endedAt: 2 })]
  ])('INP-6 %s → not listed, the page is empty', async (_label, make) => {
    store.sessions = [session('S')]
    setTasks([make()])
    await mountPage()
    expect(itemRow('S')).toBeNull()
    expect(container.querySelector('[data-inbox-empty]')).not.toBeNull()
  })
})

describe('INP-7 a waiting row', () => {
  it('INP-7 asks + turn + command: one waiting row, no session icon, the ask count as preview', async () => {
    store.sessions = [session('S')]
    store.pending = { S: 1 }
    store.streaming = { S: true }
    setTasks([bash('t1', 'S')])
    await mountPage()
    expect(container.querySelectorAll('[data-inbox-item]')).toHaveLength(1)
    const row = mustRow('S')
    expect(row.getAttribute('data-inbox-kind')).toBe('waiting')
    expect(row.getAttribute('data-run')).toBe('agent')
    expect(row.querySelector('[data-session-icon]')).toBeNull()
    expect(row.textContent).toContain(en.inbox.asks_one.replace('{{count}}', '1'))
  })
})

describe('INP-8 an idle family head', () => {
  it('INP-8 outline head, pips running + resident, children folded until the toggle', async () => {
    store.sessions = [
      session('R'),
      session('K1', { parentId: 'R', createdAt: 2 }),
      session('K2', { parentId: 'R', createdAt: 3 })
    ]
    setTasks([bash('k1', 'K1', 'serve'), dispatched('k2', 'K2')])
    await mountPage()

    const head = container.querySelector<HTMLElement>('[data-inbox-family-head="R"]')
    expect(head).not.toBeNull()
    const svg = iconIn(head!)
    expect(svg.getAttribute('data-session-icon')).toBe('family')
    expect(has(svg, 'lucide-messages-square')).toBe(true)
    expect(has(svg, 'lucide-messages-square-solid')).toBe(false)
    expect(has(svg, 'text-text-tertiary')).toBe(true)
    expect(svg.hasAttribute('data-run')).toBe(false)

    const pips = [...head!.querySelectorAll('[data-pip]')].map((p) => p.getAttribute('data-pip'))
    expect(pips).toEqual(['running', 'resident'])
    const toggle = head!.querySelector<HTMLButtonElement>('[data-inbox-family-toggle]')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(itemRow('K1')).toBeNull()
    expect(itemRow('K2')).toBeNull()

    act(() => toggle!.click())
    expect(mustRow('K2').getAttribute('data-run')).toBe('agent')
    expect(mustRow('K1').getAttribute('data-run')).toBe('resident')
    expect(mustRow('K1').querySelector('[data-inbox-commands]')).not.toBeNull()
  })
})

describe('INP-9 a resident parent with a running child', () => {
  it('INP-9 green solid family icon, one running pip, ranked before another resident family', async () => {
    store.sessions = [
      session('R', { lastActiveAt: 100 }),
      session('K', { parentId: 'R', lastActiveAt: 200 }),
      session('O', { lastActiveAt: 900 })
    ]
    store.streaming = { K: true }
    setTasks([bash('r1', 'R'), bash('o1', 'O')])
    await mountPage()

    const row = mustRow('R')
    expect(row.getAttribute('data-run')).toBe('resident')
    const svg = iconIn(row)
    expect(svg.getAttribute('data-session-icon')).toBe('family')
    expect(has(svg, 'lucide-messages-square-solid')).toBe(true)
    expect(has(svg, 'text-success')).toBe(true)
    const pips = [...row.querySelectorAll('[data-pip]')].map((p) => p.getAttribute('data-pip'))
    expect(pips).toEqual(['running'])

    const order = [...container.querySelectorAll<HTMLElement>('[data-inbox-item]')].map((el) =>
      el.getAttribute('data-inbox-item')
    )
    expect(order.indexOf('R')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('R')).toBeLessThan(order.indexOf('O'))
  })
})

describe('INP-10 resident with a failed new reply', () => {
  it('INP-10 only the unread row, marked failed, with a red dot', async () => {
    store.sessions = [session('S')]
    store.unreadState = { unread: { S: unreadEntry(true) } }
    setTasks([bash('t1', 'S')])
    await mountPage()
    expect(itemRow('S')).toBeNull()
    const rows = container.querySelectorAll<HTMLElement>('[data-inbox-unread]')
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.getAttribute('data-inbox-unread')).toBe('S')
    expect(row.hasAttribute('data-inbox-failed')).toBe(true)
    expect(leading(row).querySelector('.bg-error')).not.toBeNull()
  })
})

describe('INP-11 the sidebar inbox count', () => {
  const mountRow = (): HTMLElement => {
    act(() => root.render(createElement(InboxRow, { onOpen: () => {} })))
    const el = container.querySelector<HTMLElement>('[data-inbox-row]')
    if (!el) throw new Error('no inbox row')
    return el
  }

  it.each<[string, () => void, string, string | null]>([
    [
      'resident + unread',
      () => {
        setTasks([bash('t1', 'S')])
        store.unreadState = { unread: { S: unreadEntry() } }
      },
      '1',
      null
    ],
    ['resident only', () => setTasks([bash('t1', 'S')]), '0', null],
    [
      'background agent + unread',
      () => {
        setTasks([dispatched('d1', 'S')])
        store.unreadState = { unread: { S: unreadEntry() } }
      },
      '0',
      null
    ],
    [
      'asks + resident',
      () => {
        setTasks([bash('t1', 'S')])
        store.pending = { S: 1 }
      },
      '1',
      '1'
    ]
  ])('INP-11 %s', (_label, arrange, count, waiting) => {
    store.sessions = [session('S')]
    arrange()
    const el = mountRow()
    expect(el.getAttribute('data-inbox-count')).toBe(count)
    expect(el.getAttribute('data-inbox-waiting')).toBe(waiting)
  })
})

// ─── 留着的那一条与选中态（INH） ──────────────────────────────────────

const unreadRow = (id: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-inbox-unread="${id}"]`)
function mustUnread(id: string): HTMLElement {
  const el = unreadRow(id)
  if (!el) throw new Error(`no unread row for ${id}`)
  return el
}
/** 行里点开会话的那颗按钮（行首那一格不是按钮时，它就是行里的第一颗） */
const openButtonOf = (row: HTMLElement): HTMLButtonElement => {
  const el = row.querySelector<HTMLButtonElement>('button')
  if (!el) throw new Error('no open button in the row')
  return el
}
/** 上层那一行：标题 + 时间 */
const firstLine = (row: HTMLElement): HTMLElement =>
  openButtonOf(row).firstElementChild as HTMLElement
const titleOf = (row: HTMLElement): HTMLElement => firstLine(row).firstElementChild as HTMLElement
const metaOf = (row: HTMLElement): HTMLElement => firstLine(row).lastElementChild as HTMLElement
const unreadOrder = (): string[] =>
  [...container.querySelectorAll<HTMLElement>('[data-inbox-unread]')].map(
    (el) => el.getAttribute('data-inbox-unread')!
  )
const panelRoot = (): HTMLElement => {
  const el = container.querySelector<HTMLElement>('[data-inbox-panel]')
  if (!el) throw new Error('no inbox panel')
  return el
}
const isSelected = (el: Element): boolean =>
  el.getAttribute('aria-current') === 'true' && el.getAttribute('data-selected') === ''

const S_UNREAD = unreadAt(200)
const U_UNREAD = unreadAt(100)

/** INH-5 的起点：S、U 各有一条新回复，什么都没开着；标为已读可用 */
async function arrangeTwoUnread(): Promise<void> {
  store.sessions = [session('S'), session('U'), session('T')]
  store.unreadState = { unread: { S: S_UNREAD, U: U_UNREAD } }
  store.api.session.markRead = vi.fn(async () => {})
  await mountPage()
}

/** INH-6 的样子：点开 S（作为新回复），主进程随即清掉了它的未读 */
async function arrangeHeldS(): Promise<void> {
  await arrangeTwoUnread()
  act(() => openButtonOf(mustUnread('S')).click())
  store.unreadState = { unread: { U: U_UNREAD } }
  await rerender()
}

describe('INH-5 / INH-6 opening an unread row', () => {
  it('INH-5 a click holds S before selecting it; the panel and the row stay', async () => {
    await arrangeTwoUnread()
    act(() => openButtonOf(mustUnread('S')).click())
    expect(selectSpy.mock.calls).toEqual([['S']])
    expect(heldAtSelect).toHaveLength(1)
    expect(heldAtSelect[0]).toEqual({ sessionId: 'S', unread: S_UNREAD })
    expect(heldAtSelect[0]!.unread).toBe(S_UNREAD)
    expect(container.querySelector('[data-inbox-panel]')).not.toBeNull()
    expect(unreadRow('S')).not.toBeNull()
  })

  it('INH-6 once read, S stays where it was, drawn as read and selected; U is unchanged', async () => {
    await arrangeTwoUnread()
    const timeBefore = metaOf(mustUnread('S')).textContent
    act(() => openButtonOf(mustUnread('S')).click())
    store.unreadState = { unread: { U: U_UNREAD } }
    await rerender()

    expect(unreadOrder()).toEqual(['S', 'U'])
    const s = mustUnread('S')
    expect(s.hasAttribute('data-inbox-held')).toBe(true)
    expect(isSelected(s)).toBe(true)
    expect(titleOf(s).classList.contains('font-semibold')).toBe(false)
    const icon = leading(s).querySelector<SVGElement>('[data-session-icon="chat"]')
    expect(icon).not.toBeNull()
    expect(icon!.getAttribute('fill')).toBe('currentColor')
    expect(has(icon!, 'text-accent')).toBe(true)
    expect(leading(s).querySelector('.bg-accent')).toBeNull()
    expect(container.querySelector('[data-inbox-mark-read="S"]')).toBeNull()
    expect(container.querySelector('[data-inbox-mark-read="U"]')).not.toBeNull()
    expect(metaOf(s).textContent).toBe(timeBefore)

    const u = mustUnread('U')
    expect(u.hasAttribute('aria-current')).toBe(false)
    expect(u.hasAttribute('data-selected')).toBe(false)
    expect(titleOf(u).classList.contains('font-semibold')).toBe(true)
    expect(leading(u).querySelector('.bg-accent')).not.toBeNull()
  })
})

describe('INH-7 selected while still unread', () => {
  it('INH-7 the open session with a live unread: selected, but bold with dot and ✓', async () => {
    store.sessions = [session('S')]
    store.unreadState = { unread: { S: S_UNREAD } }
    store.api.session.markRead = vi.fn(async () => {})
    store.activeSessionId = 'S'
    await mountPage()
    const s = mustUnread('S')
    expect(isSelected(s)).toBe(true)
    expect(s.hasAttribute('data-inbox-held')).toBe(false)
    expect(titleOf(s).classList.contains('font-semibold')).toBe(true)
    expect(leading(s).querySelector('.bg-accent')).not.toBeNull()
    expect(container.querySelector('[data-inbox-mark-read="S"]')).not.toBeNull()
  })
})

describe('INH-8 / INH-9 / INH-16 when the held row leaves', () => {
  it.each<[string, string | null]>([
    ['another session', 'T'],
    ['no session', null]
  ])('INH-8 switching to %s releases S', async (_label, next) => {
    await arrangeHeldS()
    act(() => setActive(next))
    await rerender()
    expect(unreadRow('S')).toBeNull()
    expect(useInboxHoldStore.getState().held).toBeNull()
  })

  it('INH-9 opening U from the list moves the hold to U', async () => {
    await arrangeHeldS()
    act(() => openButtonOf(mustUnread('U')).click())
    store.unreadState = { unread: {} }
    await rerender()
    expect(unreadRow('S')).toBeNull()
    const u = mustUnread('U')
    expect(u.hasAttribute('data-inbox-held')).toBe(true)
    expect(u.getAttribute('aria-current')).toBe('true')
    expect(useInboxHoldStore.getState().held).toEqual({ sessionId: 'U', unread: U_UNREAD })
    expect(container.querySelectorAll('[data-inbox-held]')).toHaveLength(1)
  })

  it('INH-16 a switch away while the panel is unmounted still releases; back to S does not revive it', async () => {
    await arrangeHeldS()
    store.unreadState = { unread: {} }
    act(() => root.unmount())
    root = createRoot(container)
    act(() => setActive('T'))
    act(() => setActive('S'))
    await mountPage()
    expect(unreadRow('S')).toBeNull()
    expect(useInboxHoldStore.getState().held).toBeNull()
  })
})

describe('INH-10 the effect path', () => {
  it('INH-10 S becomes active (not from the list) while unread; after its unread is cleared it stays held', async () => {
    store.sessions = [session('S')]
    store.unreadState = { unread: { S: S_UNREAD } }
    store.activeSessionId = 'S'
    await mountPage()
    store.unreadState = { unread: {} }
    await rerender()
    const s = mustUnread('S')
    expect(s.hasAttribute('data-inbox-held')).toBe(true)
    expect(useInboxHoldStore.getState().held).toEqual({ sessionId: 'S', unread: S_UNREAD })
  })
})

describe('INH-11 the sidebar count ignores the held row', () => {
  it('INH-11 held S is listed in the panel but not counted; a live unread U is', async () => {
    store.sessions = [session('S'), session('U')]
    store.unreadState = { unread: { S: S_UNREAD } }
    store.activeSessionId = 'S'
    const both = (): void =>
      act(() =>
        root.render(
          createElement(
            'div',
            null,
            createElement(InboxRow, { onOpen: () => {} }),
            createElement(InboxPanel)
          )
        )
      )
    both()
    await flush()
    store.unreadState = { unread: {} }
    both()
    await flush()
    const row = container.querySelector<HTMLElement>('[data-inbox-row]')!
    expect(row.getAttribute('data-inbox-count')).toBe('0')
    expect(mustUnread('S').hasAttribute('data-inbox-held')).toBe(true)

    store.unreadState = { unread: { U: U_UNREAD } }
    both()
    await flush()
    expect(row.getAttribute('data-inbox-count')).toBe('1')
  })
})

describe('INH-12 mark all read', () => {
  it('INH-12 only the held row → no button', async () => {
    store.api.session.markAllRead = vi.fn(async () => {})
    await arrangeHeldS()
    store.unreadState = { unread: {} }
    await rerender()
    expect(mustUnread('S').hasAttribute('data-inbox-held')).toBe(true)
    expect(container.querySelector('[data-inbox-mark-all-read]')).toBeNull()
  })

  it('INH-12 held S plus live U → the button, one call per click', async () => {
    const markAllRead = vi.fn(async () => {})
    store.api.session.markAllRead = markAllRead
    await arrangeHeldS()
    const button = container.querySelector<HTMLButtonElement>('[data-inbox-mark-all-read]')
    expect(button).not.toBeNull()
    act(() => button!.click())
    expect(markAllRead).toHaveBeenCalledTimes(1)
  })

  it('INH-12 live U but no markAllRead in the api → no button', async () => {
    store.sessions = [session('U')]
    store.unreadState = { unread: { U: U_UNREAD } }
    await mountPage()
    expect(unreadRow('U')).not.toBeNull()
    expect(container.querySelector('[data-inbox-mark-all-read]')).toBeNull()
  })
})

describe('INH-13 the selected row, by row kind', () => {
  it.each<[string, () => void, string]>([
    [
      'a live unread row',
      () => {
        store.sessions = [session('X'), session('O')]
        store.unreadState = { unread: { X: S_UNREAD } }
        store.streaming = { O: true }
      },
      '[data-inbox-unread="X"]'
    ],
    [
      'a running row',
      () => {
        store.sessions = [session('X'), session('O')]
        store.streaming = { X: true, O: true }
      },
      '[data-inbox-item="X"][data-run="agent"]'
    ],
    [
      'a waiting row without pendingInputs',
      () => {
        store.sessions = [session('X'), session('O')]
        store.pending = { X: 1 }
        store.streaming = { O: true }
      },
      '[data-inbox-item="X"][data-inbox-kind="waiting"]'
    ],
    [
      'a collapsed ask row (another session’s ask is the open one)',
      () => {
        store.sessions = [
          session('Y', { lastActiveAt: 900 }),
          session('X', { lastActiveAt: 100 }),
          session('O')
        ]
        store.pending = { X: 1, Y: 1 }
        store.streaming = { O: true }
        store.api.agent.pendingInputs = async () => ({ X: [choice('qx')], Y: [choice('qy')] })
      },
      '[data-inbox-ask-session="X"]'
    ],
    [
      'an idle family head',
      () => {
        store.sessions = [session('X'), session('K', { parentId: 'X' }), session('O')]
        store.streaming = { K: true, O: true }
      },
      '[data-inbox-family-head="X"]'
    ]
  ])('INH-13 %s', async (_label, arrange, selector) => {
    arrange()
    store.activeSessionId = 'X'
    await mountPage()
    const target = container.querySelector<HTMLElement>(selector)
    expect(target).not.toBeNull()
    expect(isSelected(target!)).toBe(true)
    expect([...container.querySelectorAll('[aria-current]')]).toEqual([target])
    expect([...container.querySelectorAll('[data-selected]')]).toEqual([target])
  })
})

describe('INH-14 a held family head', () => {
  it('INH-14 R opened as unread with a running folded child: held head, pips kept, no ✓', async () => {
    store.sessions = [session('R'), session('K', { parentId: 'R' })]
    store.streaming = { K: true }
    store.unreadState = { unread: { R: S_UNREAD } }
    store.api.session.markRead = vi.fn(async () => {})
    store.activeSessionId = 'R'
    await mountPage()
    store.unreadState = { unread: {} }
    await rerender()
    const head = mustUnread('R')
    expect(head.hasAttribute('data-inbox-held')).toBe(true)
    expect(head.getAttribute('aria-current')).toBe('true')
    expect(head.querySelector('[data-pip="running"]')).not.toBeNull()
    expect(head.querySelector('[data-inbox-mark-read]')).toBeNull()
    expect(itemRow('K')).toBeNull()
  })
})

describe('INH-15 clicking rows opens the session; the panel stays', () => {
  it('INH-15 a running row and a family head call setActiveSessionId once each', async () => {
    store.sessions = [session('A'), session('R'), session('K', { parentId: 'R' })]
    store.streaming = { A: true, K: true }
    await mountPage()
    act(() => openButtonOf(mustRow('A')).click())
    expect(selectSpy.mock.calls).toEqual([['A']])
    expect(container.querySelector('[data-inbox-panel]')).not.toBeNull()

    selectSpy.mockClear()
    const head = container.querySelector<HTMLElement>('[data-inbox-family-head="R"]')!
    act(() => openButtonOf(head).click())
    expect(selectSpy.mock.calls).toEqual([['R']])
    expect(container.querySelector('[data-inbox-panel]')).not.toBeNull()
  })

  it('INH-15 a collapsed ask row expands in place without opening; the card ↗ opens the session', async () => {
    store.sessions = [session('Y', { lastActiveAt: 900 }), session('X', { lastActiveAt: 100 })]
    store.pending = { X: 1, Y: 1 }
    store.api.agent.pendingInputs = async () => ({ X: [choice('qx')], Y: [choice('qy')] })
    await mountPage()
    expect(container.querySelector('[data-inbox-card-session="Y"]')).not.toBeNull()
    const row = container.querySelector<HTMLElement>('[data-inbox-ask-session="X"]')!
    act(() => openButtonOf(row).click())
    const card = container.querySelector<HTMLElement>('[data-inbox-card-session="X"]')
    expect(card).not.toBeNull()
    expect(selectSpy).not.toHaveBeenCalled()

    act(() => card!.querySelector<HTMLButtonElement>('[data-inbox-open-session]')!.click())
    expect(selectSpy.mock.calls).toEqual([['X']])
    expect(container.querySelector('[data-inbox-panel]')).not.toBeNull()
  })
})

describe('INH-19 one line or two', () => {
  const lines = (row: HTMLElement): number => openButtonOf(row).children.length

  it('INH-19 agent running → 1 line; resident with a command → 2', async () => {
    store.sessions = [session('A'), session('B')]
    store.streaming = { A: true }
    setTasks([bash('t1', 'B', 'npm run dev')])
    await mountPage()
    expect(lines(mustRow('A'))).toBe(1)
    expect(lines(mustRow('B'))).toBe(2)
  })

  it.each<[string, unknown[], number]>([
    [
      'an assistant message with text',
      [{ id: 'm1', role: 'assistant', content: 'Done.', blocks: [] }],
      2
    ],
    ['no messages', [], 1]
  ])('INH-19 unread row, message.list returns %s → %d line(s)', async (_label, messages, n) => {
    store.sessions = [session('S')]
    store.unreadState = { unread: { S: S_UNREAD } }
    store.api.message.list = async () => messages
    await mountPage()
    expect(lines(mustUnread('S'))).toBe(n)
  })
})

describe('INH-20 a held child pip in the panel', () => {
  it('INH-20 the held child is a grey read pip; a live unread sibling stays an accent unread pip', async () => {
    store.sessions = [
      session('P'),
      session('K', { parentId: 'P' }),
      session('L', { parentId: 'P' })
    ]
    store.unreadState = { unread: { K: unreadAt(300) } }
    store.activeSessionId = 'K'
    await mountPage()
    store.unreadState = { unread: { L: unreadAt(100) } }
    await rerender()
    const head = container.querySelector<HTMLElement>('[data-inbox-family-head="P"]')!
    const pips = [...head.querySelectorAll<HTMLElement>('[data-pip]')]
    expect(pips.map((p) => p.getAttribute('data-pip'))).toEqual(['read', 'unread'])
    expect(has(pips[0], 'bg-text-tertiary/50')).toBe(true)
    expect(has(pips[1], 'bg-accent')).toBe(true)
  })
})

// ─── 侧栏那一行只打开面板（INT-6） ──────────────────────────────────────

describe('INT-6 the sidebar inbox row', () => {
  it.each<[string, string | null]>([
    ['nothing open', null],
    ['S open', 'S']
  ])(
    'INT-6 with %s: a click only opens the panel; never selected; the count stays',
    (_label, active) => {
      store.sessions = [session('S'), session('U')]
      store.pending = { S: 1 }
      store.unreadState = { unread: { U: unreadEntry() } }
      store.activeSessionId = active
      const onOpen = vi.fn()
      const draw = (): HTMLElement => {
        act(() => root.render(createElement(InboxRow, { onOpen })))
        return container.querySelector<HTMLElement>('[data-inbox-row]')!
      }
      const notSelected = (el: HTMLElement): void => {
        expect(el.hasAttribute('aria-current')).toBe(false)
        expect(el.hasAttribute('data-selected')).toBe(false)
        expect(
          [...el.classList].some((c) => c === 'bg-bg-active' || c.startsWith('bg-bg-active/'))
        ).toBe(false)
      }
      let row = draw()
      notSelected(row)
      expect(row.getAttribute('data-inbox-count')).toBe('2')
      expect(row.getAttribute('data-inbox-waiting')).toBe('1')
      expect(row.querySelector('.animate-ping')).not.toBeNull()

      act(() => row.click())
      expect(onOpen).toHaveBeenCalledTimes(1)
      expect(selectSpy).not.toHaveBeenCalled()
      row = draw()
      notSelected(row)
      expect(row.getAttribute('data-inbox-count')).toBe('2')

      store.pending = {}
      row = draw()
      expect(row.hasAttribute('data-inbox-waiting')).toBe(false)
      expect(row.querySelector('.animate-ping')).toBeNull()
    }
  )
})

// ─── 按键只在焦点落在面板里时归它（INK） ──────────────────────────────────────

/** 在此刻的焦点（没有就 body）上按一下；回「被拦下了没有」 */
function pressKey(key: string, target?: Element): boolean {
  const at = target ?? document.activeElement ?? document.body
  let dispatched = true
  act(() => {
    dispatched = at.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true })
    )
  })
  return !dispatched
}
const openCard = (): string | null =>
  container.querySelector('[data-inbox-card-session]')?.getAttribute('data-inbox-card-session') ??
  null

async function arrangeTwoAsks(): Promise<void> {
  store.sessions = [session('S1', { lastActiveAt: 900 }), session('S2', { lastActiveAt: 100 })]
  store.pending = { S1: 1, S2: 1 }
  store.api.agent.pendingInputs = async () => ({ S1: [choice('q1')], S2: [choice('q2')] })
  await mountPage()
}

describe('INK-1 / INK-2 J, K and Enter', () => {
  it('INK-1 J on the body does nothing; J / K with focus in the panel step through the asks', async () => {
    await arrangeTwoAsks()
    expect(openCard()).toBe('S1')
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    expect(pressKey('j', document.body)).toBe(false)
    expect(openCard()).toBe('S1')

    panelRoot().focus()
    expect(document.activeElement).toBe(panelRoot())
    expect(pressKey('j')).toBe(true)
    expect(openCard()).toBe('S2')
    expect(pressKey('k')).toBe(true)
    expect(openCard()).toBe('S1')
  })

  it('INK-2 with everything collapsed: Enter on the body is ignored, on the panel opens S1, on a row button is left alone', async () => {
    await arrangeTwoAsks()
    act(() => container.querySelector<HTMLButtonElement>('[data-inbox-collapse]')!.click())
    expect(openCard()).toBeNull()

    expect(pressKey('Enter', document.body)).toBe(false)
    expect(openCard()).toBeNull()

    panelRoot().focus()
    expect(pressKey('Enter')).toBe(true)
    expect(openCard()).toBe('S1')

    act(() => container.querySelector<HTMLButtonElement>('[data-inbox-collapse]')!.click())
    expect(openCard()).toBeNull()
    const rowButton = openButtonOf(
      container.querySelector<HTMLElement>('[data-inbox-ask-session="S1"]')!
    )
    rowButton.focus()
    expect(document.activeElement).toBe(rowButton)
    expect(pressKey('Enter')).toBe(false)
    expect(openCard()).toBeNull()
  })
})

describe('INK-3 digit keys on the open card', () => {
  it('INK-3 only with focus in the panel, never while typing', async () => {
    store.sessions = [session('S1')]
    store.pending = { S1: 1 }
    store.api.agent.pendingInputs = async () => ({ S1: [choice('q1')] })
    await mountPage()
    expect(container.querySelector('[data-stub-form="q1"]')).not.toBeNull()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    expect(pressKey('1', document.body)).toBe(false)
    expect(store.picks).toEqual([])

    panelRoot().focus()
    expect(pressKey('1')).toBe(true)
    expect(store.picks).toEqual([['q1', 0]])

    const textarea = container.querySelector<HTMLTextAreaElement>('[data-stub-textarea]')!
    textarea.focus()
    expect(document.activeElement).toBe(textarea)
    pressKey('1')
    expect(store.picks).toEqual([['q1', 0]])
  })
})

describe('INK-8 focus is handed back when another session opens', () => {
  it('INK-8 focus in the panel is blurred on a switch; focus outside is left alone', async () => {
    store.sessions = [session('A'), session('B')]
    store.streaming = { A: true, B: true }
    await mountPage()
    const button = openButtonOf(mustRow('A'))
    button.focus()
    expect(document.activeElement).toBe(button)
    act(() => setActive('B'))
    await rerender()
    expect(document.activeElement).toBe(document.body)

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    try {
      outside.focus()
      expect(document.activeElement).toBe(outside)
      act(() => setActive('A'))
      await rerender()
      expect(document.activeElement).toBe(outside)
    } finally {
      outside.remove()
    }
  })
})
