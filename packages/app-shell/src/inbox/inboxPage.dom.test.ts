// @vitest-environment jsdom
/**
 * 收件箱页的在跑记号（jsdom）—— 与侧栏同一套（S1，2026-11-11）：
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
 * `@shuvix/chat-ui` 整份换成替身（同 projectSessionGroupsRunning）；后台任务的口径用 chat-ui 的真函数
 * （taskRunKind / selectBgRunKinds，按相对路径取源码）。selectBgRunKinds 按 tasks 的引用记忆，每个用例写一份新的。
 * 询问表取不到（替身没有 `agent.pendingInputs`），挂着询问的会话画成普通的一行。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { TaskInfo, TaskSubject } from '@shuvix/chat-protocol/types/task'
import type { SessionUnread } from '@shuvix/chat-protocol/sessionUnread'

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
  unreadState: { unread: {} as Record<string, SessionUnread> }
}))

vi.mock('@shuvix/chat-ui', async () => {
  const bgTasks = await import('../../../chat-ui/src/stores/bgTaskStore')
  return {
    RedactedText: ({ text }: { text: string }) => text,
    RedactionSessionProvider: ({ children }: { children: unknown }) => children,
    useChatStore: Object.assign((selector: (s: typeof store) => unknown) => selector(store), {
      getState: () => store,
      subscribe: () => () => {}
    }),
    selectStreamingSessions: (s: typeof store) => s.streaming,
    selectAllPendingCounts: (s: typeof store) => s.pending,
    useBgTaskStore: (selector: (s: typeof store.bg) => unknown) => selector(store.bg),
    selectBgRunKinds: bgTasks.selectBgRunKinds,
    taskRunKind: bgTasks.taskRunKind,
    useUnreadStore: (selector: (s: typeof store.unreadState) => unknown) =>
      selector(store.unreadState),
    getChatApi: () => ({ agent: {}, session: {}, message: { list: async () => [] } }),
    getSessionChannelApi: () => ({ agent: {} }),
    InputRequestForm: () => null,
    useChatHost: () => ({ appearance: { focusMode: false } }),
    useAppEvent: () => {},
    copyToClipboard: () => {},
    useDialogClose: () => ({})
  }
})

import { InboxPage } from './InboxPage'
import { InboxRow } from '../sidebar/InboxRow'

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

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function mountPage(): Promise<void> {
  act(() => root.render(createElement(InboxPage)))
  await flush()
}

const itemRow = (id: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-inbox-item="${id}"]`)
function mustRow(id: string): HTMLElement {
  const el = itemRow(id)
  if (!el) throw new Error(`no inbox row for ${id}`)
  return el
}
const leading = (row: HTMLElement): HTMLElement => row.firstElementChild as HTMLElement
const iconIn = (row: HTMLElement): SVGElement => {
  const svg = row.querySelector<SVGElement>('[data-session-icon]')
  if (!svg) throw new Error('no session icon in the row')
  return svg
}
const has = (el: Element, cls: string): boolean => el.classList.contains(cls)

beforeAll(async () => {
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
  setTasks([])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
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
    act(() => root.render(createElement(InboxRow)))
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
