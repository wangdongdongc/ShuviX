// @vitest-environment jsdom
/**
 * 后台任务面板：排序、已完成组的折叠、行上的文案、走字、揭示与 DOM 锚点（`BgTaskPanel` + `bgTaskOrder.ts`）。
 *
 *   D-*  顺序：运行中 = 等你回答的在前（只有运行中的才算等你）、其余启动时间倒序；已完成 = 结束时间倒序；活的变动即时重排
 *   F-*  已完成组只露最近 5 条，「显示更早的 N 条」/「只显示最近 5 条」；运行中从不折；清空 / 移除 / 组头折叠
 *   R-*  行文案：「Bash · Running · 1m05s」/「Ended 3m ago」/「Waiting for you」，状态点 `data-task-dot`
 *   T-*  走字：运行中每秒、只剩已完成的半分钟，换挡时先补一拍
 *   V-*  揭示：独占展开、折在线下的整组展开、header 折起的组打开、挂载前发出的请求挂载时补处理一次、只滚面板自己
 *   A-*  锚点：data-task-row / -status / -id、`.truncate` 是标题、展开互斥、子会话行只有「打开」、停止不展开
 *
 * 宿主面（`getHostApi()` 与 BashDetail 读日志的 `getSessionChannelApi()`）都落到同一个 `setChatApi` 注入的桩上。
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），一律 createElement。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import type { TaskInfo, TaskStatus } from '@shuvix/chat-protocol/types/task'

vi.mock('mermaid', () => ({ default: { initialize: () => {}, render: () => {} } }))

import {
  ChatHostProvider,
  setChatApi,
  useBgTaskStore,
  useChatStore,
  type ChatHostValue
} from '@shuvix/chat-ui'
import { BgTaskPanel } from './BgTaskPanel'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type ChatState = ReturnType<typeof useChatStore.getState>

const HOST: ChatHostValue = {
  appearance: { theme: 'light', darkTheme: 'd', lightTheme: 'l', fontSize: 14, focusMode: false },
  models: {
    activeProvider: '',
    activeModel: '',
    setActiveProvider: () => {},
    setActiveModel: () => {}
  },
  interactiveFigures: true
}

const HostProvider = ChatHostProvider as (props: {
  value: ChatHostValue
  children?: ReactNode
}) => React.JSX.Element

const bgTaskApi = {
  readLog: vi.fn(async (_p: { toolCallId: string; fromByte?: number; maxBytes?: number }) => ({
    text: '',
    nextByte: 0,
    exists: true
  })),
  clearDone: vi.fn(async (_p: { sessionId: string }) => {}),
  dismiss: vi.fn(async (_p: { toolCallId: string }) => {}),
  stop: vi.fn(async (_p: { toolCallId: string }) => {})
}

// ── 时间与任务 ────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 9, 7, 12, 0, 0)
const SEC = 1000
const MIN = 60 * SEC
/** T0 起 n 秒（负数 = 之前） */
const at = (n: number): number => T0 + n * SEC

function base(
  taskId: string,
  startedAt: number,
  endedAt: number | null,
  status: TaskStatus | undefined
): Omit<TaskInfo, 'kind' | 'subject'> {
  return {
    taskId,
    sessionId: 's1',
    title: `Task ${taskId}`,
    status: status ?? (endedAt === null ? 'running' : 'done'),
    detached: true,
    startedAt,
    endedAt
  }
}

function bash(
  taskId: string,
  startedAt: number,
  endedAt: number | null = null,
  status?: TaskStatus
): TaskInfo {
  return {
    ...base(taskId, startedAt, endedAt, status),
    kind: 'bash',
    subject: {
      kind: 'bash',
      command: `echo ${taskId}`,
      cwd: '/w',
      pid: 1,
      logPath: `/logs/${taskId}.log`,
      exitCode: endedAt === null ? null : 0,
      signal: null,
      logCapped: false
    }
  }
}

function sub(
  taskId: string,
  childSessionId: string,
  startedAt: number,
  endedAt: number | null = null,
  status?: TaskStatus
): TaskInfo {
  return {
    ...base(taskId, startedAt, endedAt, status),
    kind: 'sub-session',
    subject: { kind: 'sub-session', childSessionId }
  }
}

function agent(
  taskId: string,
  startedAt: number,
  endedAt: number | null = null,
  status?: TaskStatus
): TaskInfo {
  return {
    ...base(taskId, startedAt, endedAt, status),
    kind: 'agent',
    subject: { kind: 'agent', profileName: `prof-${taskId}`, depth: 1, parentToolCallId: 'tc' }
  }
}

/**
 * 已完成的 f1…fn：f1 结束得最晚（-10s），fn 最早；启动时间反过来（f1 启动得最早），
 * 于是「按结束倒序」与「按启动倒序」给出相反的两种顺序，断言分得出是哪一种
 */
function finishedTasks(n: number, prefix = 'f'): TaskInfo[] {
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1
    return bash(`${prefix}${i}`, at(-2000 + i), at(-10 * i))
  })
}

const finishedIds = (n: number, prefix = 'f'): string[] =>
  Array.from({ length: n }, (_, k) => `${prefix}${k + 1}`)

function upsert(...tasks: TaskInfo[]): void {
  act(() => {
    for (const task of tasks) useBgTaskStore.getState().upsert(task)
  })
}

function setChat(patch: Partial<ChatState>): void {
  act(() => useChatStore.setState(patch))
}

const pending = (n: number): ChatState['sessionPendingInputs'][string] =>
  Array.from({ length: n }, (_, i) => ({
    requestId: `q${i}`
  })) as unknown as ChatState['sessionPendingInputs'][string]

// ── 渲染与查询 ────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root

function render(): void {
  act(() => {
    root.render(
      createElement(
        HostProvider,
        { value: HOST },
        createElement('div', { 'data-outer': '' }, createElement(BgTaskPanel, { sessionId: 's1' }))
      )
    )
  })
}

/** 让 readLog 之类已解决的 promise 落地 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

const outer = (): HTMLElement => container.querySelector<HTMLElement>('[data-outer]')!
const panelRoot = (): HTMLElement => outer().firstElementChild as HTMLElement
const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-task-row]')]
const ids = (): string[] => rows().map((r) => r.getAttribute('data-task-id')!)
const rowOf = (id: string): HTMLElement | null =>
  rows().find((r) => r.getAttribute('data-task-id') === id) ?? null
const isExpanded = (id: string): boolean => (rowOf(id)?.children.length ?? 0) > 1
const expandedIds = (): string[] =>
  rows()
    .filter((r) => r.children.length > 1)
    .map((r) => r.getAttribute('data-task-id')!)
const titleRow = (id: string): HTMLElement => rowOf(id)!.firstElementChild as HTMLElement
const titleEl = (id: string): HTMLElement => rowOf(id)!.querySelector<HTMLElement>('.truncate')!
const statusLine = (id: string): HTMLElement => titleEl(id).nextElementSibling as HTMLElement
const statusText = (id: string): string => statusLine(id).textContent ?? ''
const dotOf = (id: string): string | null =>
  rowOf(id)!.querySelector('[data-task-dot]')?.getAttribute('data-task-dot') ?? null
const footer = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('[data-task-older]')
const groupHeader = (label: string): HTMLButtonElement | null =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.querySelector('.tabular-nums') && b.querySelector('span')?.textContent === label
  ) ?? null
const groupCount = (label: string): number | null => {
  const n = groupHeader(label)?.querySelector('.tabular-nums')?.textContent
  return n == null ? null : Number(n)
}
const clearButton = (): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Clear'
  )!

function click(el: Element): void {
  act(() => {
    ;(el as HTMLElement).click()
  })
}

const toggleRow = (id: string): void => click(titleRow(id))
const reveal = (id: string): void => act(() => useChatStore.getState().revealTask(id))
const readLogIds = (): string[] => bgTaskApi.readLog.mock.calls.map(([p]) => p.toolCallId)

// ── 生命周期 ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } })
  setChatApi({ bgTask: bgTaskApi } as unknown as ChatApi)
})

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']
  })
  vi.setSystemTime(T0)
  for (const fn of Object.values(bgTaskApi)) fn.mockClear()
  useBgTaskStore.setState({ tasks: {} })
  useChatStore.setState({
    taskRevealRequest: null,
    sessionViews: {},
    sessionAskCounts: {},
    sessionPendingInputs: {},
    activeSessionId: null
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

// ── (b) 顺序 ──────────────────────────────────────────────────────────────

describe('D ordering', () => {
  it('D-1 running: a blocked sub-session first, then bash newest first', () => {
    upsert(sub('ss1', 'c1', at(-100)), bash('b1', at(-50)), bash('b2', at(-10)))
    setChat({ sessionAskCounts: { c1: 1 } })
    render()
    expect(ids()).toEqual(['ss1', 'b2', 'b1'])
    expect(statusText('ss1')).toContain('Waiting for you')
  })

  it('D-2 a waiting-input bash leads; a bash / agent whose own id has asks but is running is not blocked', () => {
    upsert(bash('w1', at(-100), null, 'waiting-input'), agent('a3', at(-50)), bash('b2', at(-10)))
    setChat({ sessionAskCounts: { b2: 3, a3: 1 } })
    render()
    expect(ids()).toEqual(['w1', 'b2', 'a3'])
    expect(statusText('w1')).toContain('Waiting for you')
    expect(dotOf('w1')).toBe('blocked')
    for (const id of ['b2', 'a3']) {
      expect(statusText(id)).not.toContain('Waiting for you')
      expect(dotOf(id)).toBe('running')
    }
  })

  it('D-3 a viewed child is judged by its view: no pending inputs → not blocked; one arrives → top', () => {
    upsert(sub('ss1', 'c1', at(-100)), bash('b1', at(-10)))
    setChat({
      sessionViews: { c1: {} } as unknown as ChatState['sessionViews'],
      sessionPendingInputs: { c1: [] },
      sessionAskCounts: { c1: 2 }
    })
    render()
    expect(ids()).toEqual(['b1', 'ss1'])
    expect(statusText('ss1')).not.toContain('Waiting for you')

    setChat({ sessionPendingInputs: { c1: pending(1) } })
    expect(ids()).toEqual(['ss1', 'b1'])
    expect(statusText('ss1')).toContain('Waiting for you')
  })

  it('D-4 the blocked set changing reorders live, both ways', () => {
    upsert(sub('ss1', 'c1', at(-100)), bash('b1', at(-50)), bash('b2', at(-10)))
    render()
    expect(ids()).toEqual(['b2', 'b1', 'ss1'])
    setChat({ sessionAskCounts: { c1: 1 } })
    expect(ids()).toEqual(['ss1', 'b2', 'b1'])
    setChat({ sessionAskCounts: { c1: 0 } })
    expect(ids()).toEqual(['b2', 'b1', 'ss1'])
  })

  it('D-5 a new running task lands right below the blocked rows, above the other running ones', () => {
    upsert(sub('ss1', 'c1', at(-100)), bash('b1', at(-50)))
    setChat({ sessionAskCounts: { c1: 1 } })
    render()
    expect(ids()).toEqual(['ss1', 'b1'])
    upsert(bash('b2', at(0)))
    expect(ids()).toEqual(['ss1', 'b2', 'b1'])
  })

  it('D-6 finished by end time; a running task that finishes jumps to the top of Finished', () => {
    upsert(...finishedTasks(3), bash('r1', at(-5000)), bash('r0', at(-9000)))
    render()
    expect(ids()).toEqual(['r1', 'r0', 'f1', 'f2', 'f3'])

    // r1 跑完：从运行中的顶上挪到已完成的顶上（越过还在跑的 r0）
    upsert(bash('r1', at(-5000), at(0)))
    expect(ids()).toEqual(['r0', 'r1', 'f1', 'f2', 'f3'])
    expect(rowOf('r1')!.getAttribute('data-task-status')).toBe('done')
    expect(groupCount('Running')).toBe(1)
    expect(groupCount('Finished')).toBe(4)

    // 启动得最早、结束得最晚的那条，也落在已完成的最上面
    upsert(bash('r0', at(-9000), at(1), 'killed'))
    expect(ids()).toEqual(['r0', 'r1', 'f1', 'f2', 'f3'])
    expect(groupCount('Running')).toBeNull()
    expect(groupCount('Finished')).toBe(5)
  })

  it('D-7 done / error / killed sort together by end time; every running row precedes every finished row', () => {
    upsert(
      bash('k', at(-300), at(-30), 'killed'),
      bash('d', at(-200), at(-10), 'done'),
      bash('e', at(-100), at(-20), 'error'),
      bash('r1', at(-400)),
      bash('r2', at(-5))
    )
    render()
    expect(ids()).toEqual(['r2', 'r1', 'd', 'e', 'k'])
  })
})

// ── 已完成组的折叠 ────────────────────────────────────────────────────────

describe('F folding the finished group', () => {
  it('F-1 exactly 5 finished → 5 rows, no footer, count 5', () => {
    upsert(...finishedTasks(5))
    render()
    expect(ids()).toEqual(finishedIds(5))
    expect(footer()).toBeNull()
    expect(groupCount('Finished')).toBe(5)
  })

  it('F-2 6 finished → the 5 most recently ended; the oldest is folded; "Show 1 older"; count 6', () => {
    upsert(...finishedTasks(6))
    render()
    expect(ids()).toEqual(finishedIds(5))
    expect(rowOf('f6')).toBeNull()
    expect(footer()!.textContent).toBe('Show 1 older')
    expect(groupCount('Finished')).toBe(6)
  })

  it('F-3 12 finished → "Show 7 older" ↔ "Show only the latest 5"', () => {
    upsert(...finishedTasks(12))
    render()
    expect(ids()).toEqual(finishedIds(5))
    expect(footer()!.textContent).toBe('Show 7 older')
    expect(groupCount('Finished')).toBe(12)

    click(footer()!)
    expect(ids()).toEqual(finishedIds(12))
    expect(footer()!.textContent).toBe('Show only the latest 5')
    expect(groupCount('Finished')).toBe(12)

    click(footer()!)
    expect(ids()).toEqual(finishedIds(5))
    expect(footer()!.textContent).toBe('Show 7 older')
  })

  it('F-4 running never folds', () => {
    const running = Array.from({ length: 8 }, (_, i) => bash(`r${i + 1}`, at(-100 + i)))
    upsert(...running)
    render()
    expect(ids()).toHaveLength(8)
    expect(footer()).toBeNull()
    expect(groupCount('Running')).toBe(8)

    upsert(...finishedTasks(6))
    expect(ids()).toHaveLength(13)
    expect(ids().slice(8)).toEqual(finishedIds(5))
    expect(groupCount('Running')).toBe(8)
    expect(groupCount('Finished')).toBe(6)
    expect(footer()!.textContent).toBe('Show 1 older')
  })

  it('F-5 Clear resets the fold, calls clearDone once, keeps running rows', () => {
    upsert(bash('r1', at(-100)), ...finishedTasks(7))
    render()
    click(footer()!)
    expect(ids()).toHaveLength(8)

    click(clearButton())
    expect(bgTaskApi.clearDone).toHaveBeenCalledTimes(1)
    expect(bgTaskApi.clearDone).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(ids()).toEqual(['r1'])
    expect(groupCount('Finished')).toBeNull()

    upsert(...finishedTasks(7, 'g'))
    expect(ids()).toEqual(['r1', ...finishedIds(5, 'g')])
    expect(footer()!.textContent).toBe('Show 2 older')
  })

  it('F-6 Clear with an expanded finished row → nothing expanded (even when the id comes back)', async () => {
    const [f1, f2] = finishedTasks(2)
    upsert(bash('r1', at(-100)), f1!, f2!)
    render()
    toggleRow('f1')
    await flush()
    expect(expandedIds()).toEqual(['f1'])

    click(clearButton())
    expect(expandedIds()).toEqual([])
    upsert(f1!)
    expect(rowOf('f1')).not.toBeNull()
    expect(expandedIds()).toEqual([])
  })

  it('F-6 Clear with an expanded running row → it stays expanded', async () => {
    upsert(bash('r1', at(-100)), ...finishedTasks(3))
    render()
    toggleRow('r1')
    await flush()
    expect(expandedIds()).toEqual(['r1'])
    click(clearButton())
    expect(ids()).toEqual(['r1'])
    expect(expandedIds()).toEqual(['r1'])
  })

  it('F-7 the header chevron hides rows and footer; the count stays', () => {
    upsert(bash('r1', at(-100)), ...finishedTasks(6))
    render()
    click(groupHeader('Finished')!)
    expect(ids()).toEqual(['r1'])
    expect(footer()).toBeNull()
    expect(groupCount('Finished')).toBe(6)

    click(groupHeader('Finished')!)
    expect(ids()).toEqual(['r1', ...finishedIds(5)])
    expect(footer()!.textContent).toBe('Show 1 older')

    click(groupHeader('Running')!)
    expect(ids()).toEqual(finishedIds(5))
    expect(groupCount('Running')).toBe(1)
  })

  it('F-8 dismissing a visible row with 6 finished → 5 rows, no footer, count 5', () => {
    upsert(...finishedTasks(6))
    render()
    click(rowOf('f2')!.querySelector('button[title="Remove from list"]')!)
    expect(bgTaskApi.dismiss).toHaveBeenCalledTimes(1)
    expect(bgTaskApi.dismiss).toHaveBeenCalledWith({ toolCallId: 'f2' })
    expect(ids()).toEqual(['f1', 'f3', 'f4', 'f5', 'f6'])
    expect(footer()).toBeNull()
    expect(groupCount('Finished')).toBe(5)
    expect(expandedIds()).toEqual([])
  })
})

// ── 行文案 ────────────────────────────────────────────────────────────────

describe('R row text', () => {
  it('R-1 running bash: "Bash · Running · 1m05s", ticking each second; primary title; running dot', () => {
    upsert(bash('r1', at(-65)))
    render()
    expect(statusText('r1')).toBe('Bash · Running · 1m05s')
    advance(1000)
    expect(statusText('r1')).toBe('Bash · Running · 1m06s')
    expect(titleEl('r1').classList.contains('text-text-primary')).toBe(true)
    expect(titleEl('r1').classList.contains('text-text-secondary')).toBe(false)
    expect(dotOf('r1')).toBe('running')
  })

  it('R-2 finished rows say how long ago they ended, whatever the final status', () => {
    upsert(
      bash('j', at(-20), at(-10), 'done'),
      bash('m', at(-185 - 10), at(-185), 'error'),
      bash('h', at(-2 * 3600 - 10), at(-2 * 3600), 'killed'),
      bash('d', at(-3 * 86400 - 10), at(-3 * 86400), 'done')
    )
    render()
    expect(statusText('j')).toBe('Bash · Just ended · 10s')
    expect(statusText('m')).toBe('Bash · Ended 3m ago · 10s')
    expect(statusText('h')).toBe('Bash · Ended 2h ago · 10s')
    expect(statusText('d')).toBe('Bash · Ended 3d ago · 10s')
    for (const id of ['j', 'm', 'h', 'd']) {
      const text = rowOf(id)!.textContent ?? ''
      expect(text).not.toContain('Finished')
      expect(text).not.toContain('Running')
      expect(titleEl(id).classList.contains('text-text-secondary')).toBe(true)
      expect(titleEl(id).classList.contains('text-text-primary')).toBe(false)
      expect(dotOf(id)).toBe('ended')
    }
  })

  it('R-3 a task arriving after the clock stopped is not measured against the stale clock', () => {
    render()
    act(() => {
      vi.setSystemTime(T0 + 10 * MIN)
    })
    upsert(bash('f', T0 + 7 * MIN - 10 * SEC, T0 + 7 * MIN))
    // 停表期间面板的时钟还停在 T0：补的那一拍落地之前，它会把这条算成「刚刚」
    expect(statusText('f')).toContain('Just ended')
    advance(0)
    expect(statusText('f')).toContain('Ended 3m ago')
  })

  it('R-3 an end time later than the clock reads "Just ended"', () => {
    upsert(bash('f', at(-10), T0 + 500))
    render()
    expect(statusText('f')).toContain('Just ended')
  })

  it('R-4 a blocked running sub-session: "Waiting for you" in warning, warning tint, blocked dot', () => {
    upsert(sub('ss1', 'c1', at(-30)), bash('b1', at(-20)), bash('f1', at(-50), at(-40)))
    setChat({ sessionAskCounts: { c1: 1 } })
    render()
    expect(statusText('ss1')).toMatch(/^Sub-session · Waiting for you · \S+$/)
    expect(statusLine('ss1').classList.contains('text-warning')).toBe(true)
    expect(rowOf('ss1')!.className.split(/\s+/)).toContain('bg-warning/5')
    expect(dotOf('ss1')).toBe('blocked')
    for (const id of ['b1', 'f1']) {
      expect(statusLine(id).classList.contains('text-warning')).toBe(false)
      expect(rowOf(id)!.className).not.toContain('bg-warning')
      expect(dotOf(id)).not.toBe('blocked')
    }
  })

  it('R-4 a finished sub-session whose child still has asks is not blocked (only running tasks wait for you)', () => {
    upsert(
      sub('ss1', 'c1', at(-60), at(-30), 'done'),
      bash('w', at(-50), at(-40), 'waiting-input'),
      bash('r1', at(-5))
    )
    setChat({ sessionAskCounts: { c1: 2 } })
    render()
    expect(ids()).toEqual(['r1', 'ss1', 'w'])
    for (const id of ['ss1', 'w']) {
      expect(statusText(id)).not.toContain('Waiting for you')
      expect(statusText(id)).toContain('Just ended')
      expect(statusLine(id).classList.contains('text-warning')).toBe(false)
      expect(rowOf(id)!.className).not.toContain('bg-warning')
      expect(dotOf(id)).toBe('ended')
    }
  })

  it('R-5 every row has exactly one status dot, first in its title row', () => {
    upsert(
      sub('ss1', 'c1', at(-30)),
      bash('b1', at(-20)),
      agent('a1', at(-10)),
      bash('f1', at(-50), at(-40)),
      sub('ss2', 'c2', at(-60), at(-45), 'error')
    )
    setChat({ sessionAskCounts: { c1: 1 } })
    render()
    expect(rows()).toHaveLength(5)
    for (const row of rows()) {
      const dots = row.querySelectorAll('[data-task-dot]')
      expect(dots).toHaveLength(1)
      expect(row.firstElementChild!.firstElementChild).toBe(dots[0])
    }
  })
})

// ── 走字 ──────────────────────────────────────────────────────────────────

describe('T ticking', () => {
  it('T-1 only finished: the half-minute cadence', () => {
    upsert(bash('f', at(-70), at(-59)))
    render()
    expect(statusText('f')).toContain('Just ended')
    advance(1000)
    expect(statusText('f')).toContain('Just ended')
    advance(29_000)
    expect(statusText('f')).toContain('Ended 1m ago')
  })

  it('T-2 with something running the same finished row moves on after one second', () => {
    upsert(bash('f', at(-70), at(-59)), bash('r', at(-5)))
    render()
    expect(statusText('f')).toContain('Just ended')
    advance(1000)
    expect(statusText('f')).toContain('Ended 1m ago')
  })

  it('T-3 no tasks → no timers; the last running task finishing leaves exactly the 30 s interval', () => {
    render()
    expect(vi.getTimerCount()).toBe(0)

    upsert(bash('r', at(-5)))
    advance(0)
    expect(vi.getTimerCount()).toBe(1)

    upsert(bash('r', at(-5), at(0)))
    advance(0)
    expect(vi.getTimerCount()).toBe(1)

    act(() => useBgTaskStore.setState({ tasks: {} }))
    expect(vi.getTimerCount()).toBe(0)
  })
})

// ── 揭示 ──────────────────────────────────────────────────────────────────

describe('V reveal', () => {
  it('V-1 revealing a running bash expands it alone; the finished fold is unchanged', async () => {
    upsert(bash('r1', at(-100)), bash('r2', at(-50)), ...finishedTasks(7))
    render()
    toggleRow('r2')
    await flush()
    expect(expandedIds()).toEqual(['r2'])
    bgTaskApi.readLog.mockClear()

    reveal('r1')
    await flush()
    expect(expandedIds()).toEqual(['r1'])
    expect(readLogIds()).toContain('r1')
    expect(ids().slice(2)).toEqual(finishedIds(5))
    expect(footer()!.textContent).toBe('Show 2 older')
  })

  it('V-2 revealing a finished task inside the preview expands it; still 5 rows, footer unchanged', async () => {
    upsert(...finishedTasks(7))
    render()
    reveal('f3')
    await flush()
    expect(expandedIds()).toEqual(['f3'])
    expect(ids()).toEqual(finishedIds(5))
    expect(footer()!.textContent).toBe('Show 2 older')
  })

  it('V-3 revealing the oldest-ended of 7 unfolds the group; the footer folds it back', async () => {
    upsert(...finishedTasks(7))
    render()
    expect(rowOf('f7')).toBeNull()

    reveal('f7')
    await flush()
    expect(ids()).toEqual(finishedIds(7))
    expect(isExpanded('f7')).toBe(true)
    expect(footer()!.textContent).toBe('Show only the latest 5')
    expect(groupCount('Finished')).toBe(7)

    click(footer()!)
    expect(ids()).toEqual(finishedIds(5))
    expect(rowOf('f7')).toBeNull()
    expect(footer()!.textContent).toBe('Show 2 older')
  })

  it('V-4 after folding again, revealing the same id again unfolds again', async () => {
    upsert(...finishedTasks(7))
    render()
    reveal('f7')
    await flush()
    click(footer()!)
    expect(rowOf('f7')).toBeNull()

    reveal('f7')
    await flush()
    expect(ids()).toEqual(finishedIds(7))
    expect(isExpanded('f7')).toBe(true)
  })

  it('V-5 revealing a running task after a folded one folds Finished back to 5', async () => {
    upsert(bash('r1', at(-100)), ...finishedTasks(7))
    render()
    reveal('f7')
    await flush()
    expect(ids()).toHaveLength(8)

    reveal('r1')
    await flush()
    expect(ids()).toEqual(['r1', ...finishedIds(5)])
    expect(expandedIds()).toEqual(['r1'])
    expect(footer()!.textContent).toBe('Show 2 older')
  })

  it('V-6 an unknown id: no throw, nothing expands, the fold is unchanged', () => {
    upsert(...finishedTasks(7))
    render()
    expect(() => reveal('nope')).not.toThrow()
    expect(expandedIds()).toEqual([])
    expect(ids()).toEqual(finishedIds(5))
    expect(footer()!.textContent).toBe('Show 2 older')
  })

  it('V-7 a manual unfold survives a reveal; the footer still folds', async () => {
    upsert(...finishedTasks(7))
    render()
    click(footer()!)
    expect(ids()).toHaveLength(7)

    reveal('f2')
    await flush()
    expect(ids()).toEqual(finishedIds(7))
    expect(isExpanded('f2')).toBe(true)
    expect(footer()!.textContent).toBe('Show only the latest 5')

    click(footer()!)
    expect(ids()).toEqual(finishedIds(5))
    expect(footer()!.textContent).toBe('Show 2 older')
  })

  it('V-9 revealing a task in a header-collapsed group opens that group; an unknown id changes nothing', async () => {
    upsert(bash('r1', at(-100)), ...finishedTasks(3))
    render()
    click(groupHeader('Finished')!)
    click(groupHeader('Running')!)
    expect(ids()).toEqual([])

    expect(() => reveal('nope')).not.toThrow()
    expect(ids()).toEqual([])

    reveal('f2')
    await flush()
    expect(ids()).toEqual(finishedIds(3))
    expect(isExpanded('f2')).toBe(true)
    expect(groupCount('Running')).toBe(1)

    reveal('r1')
    await flush()
    expect(ids()).toEqual(['r1', ...finishedIds(3)])
    expect(expandedIds()).toEqual(['r1'])
  })

  describe('a request made before the panel mounted', () => {
    it('is applied on mount: expanded, its folded group unfolded', async () => {
      upsert(...finishedTasks(7))
      act(() => useChatStore.getState().revealTask('f7'))
      render()
      await flush()
      expect(ids()).toEqual(finishedIds(7))
      expect(isExpanded('f7')).toBe(true)
      expect(footer()!.textContent).toBe('Show only the latest 5')
    })

    it('is applied once: a remount with the same request still in the store expands nothing', async () => {
      upsert(...finishedTasks(7))
      act(() => useChatStore.getState().revealTask('f7'))
      render()
      await flush()
      expect(isExpanded('f7')).toBe(true)

      act(() => root.unmount())
      root = createRoot(container)
      expect(useChatStore.getState().taskRevealRequest?.taskId).toBe('f7')
      render()
      await flush()
      expect(expandedIds()).toEqual([])
      expect(ids()).toEqual(finishedIds(5))
      expect(footer()!.textContent).toBe('Show 2 older')
    })
  })
})

// ── 揭示时的滚动：只动面板自己的滚动容器 ──────────────────────────────────

describe('V-8 reveal scrolls only the panel container', () => {
  type Box = { top: number; bottom: number }
  let boxRect: Box
  let rowRects: Record<string, Box>
  let rectSpy: { mockRestore: () => void } | null = null
  const scrollIntoView = vi.fn()
  const hadScrollIntoView = 'scrollIntoView' in Element.prototype
  const originalScrollIntoView = Element.prototype.scrollIntoView

  const domRect = ({ top, bottom }: Box): DOMRect =>
    ({
      top,
      bottom,
      left: 0,
      right: 100,
      width: 100,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({})
    }) as DOMRect

  beforeAll(() => {
    Element.prototype.scrollIntoView = scrollIntoView
  })

  afterAll(() => {
    if (hadScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  beforeEach(() => {
    scrollIntoView.mockClear()
    boxRect = { top: 100, bottom: 300 }
    rowRects = {}
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const outerEl = container.querySelector('[data-outer]')
      if (outerEl && this === outerEl.firstElementChild) return domRect(boxRect)
      const id = this.getAttribute('data-task-id')
      if (id && rowRects[id]) return domRect(rowRects[id])
      return domRect({ top: 0, bottom: 0 })
    })
  })

  afterEach(() => {
    rectSpy?.mockRestore()
    rectSpy = null
  })

  function mount(...tasks: TaskInfo[]): void {
    upsert(...tasks)
    render()
    outer().scrollTop = 50
  }

  it('(a) a row below the box scrolls the panel by the overflow; ancestors and scrollIntoView untouched', async () => {
    mount(bash('r1', at(-100)), bash('r2', at(-50)))
    rowRects.r1 = { top: 600, bottom: 640 }
    expect(panelRoot().scrollTop).toBe(0)
    reveal('r1')
    await flush()
    expect(panelRoot().scrollTop).toBe(340)
    expect(outer().scrollTop).toBe(50)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('(b) a row taller than the box aligns its top with the box top', async () => {
    mount(bash('r1', at(-100)))
    rowRects.r1 = { top: 400, bottom: 1400 }
    reveal('r1')
    await flush()
    expect(panelRoot().scrollTop).toBe(300)
  })

  it('(c) a row above the box scrolls back up to it', async () => {
    mount(bash('r1', at(-100)))
    panelRoot().scrollTop = 500
    rowRects.r1 = { top: 20, bottom: 60 }
    reveal('r1')
    await flush()
    expect(panelRoot().scrollTop).toBe(420)
  })

  it('(d) a fully visible row does not scroll', async () => {
    mount(bash('r1', at(-100)))
    panelRoot().scrollTop = 70
    rowRects.r1 = { top: 150, bottom: 200 }
    reveal('r1')
    await flush()
    expect(panelRoot().scrollTop).toBe(70)
  })

  it('(e) a folded target still scrolls, once the unfold has committed', async () => {
    mount(...finishedTasks(7))
    rowRects.f7 = { top: 600, bottom: 640 }
    reveal('f7')
    await flush()
    expect(rowOf('f7')).not.toBeNull()
    expect(panelRoot().scrollTop).toBe(340)
    expect(outer().scrollTop).toBe(50)
  })

  it('(f) ticks and upserts do not scroll again; a new reveal does', async () => {
    mount(bash('r1', at(-100)))
    rowRects.r1 = { top: 600, bottom: 640 }
    reveal('r1')
    await flush()
    expect(panelRoot().scrollTop).toBe(340)

    panelRoot().scrollTop = 0
    advance(1000)
    upsert(bash('r2', at(0)))
    advance(1000)
    await flush()
    expect(panelRoot().scrollTop).toBe(0)

    reveal('r1')
    await flush()
    expect(panelRoot().scrollTop).toBe(340)
  })

  it('(g) revealing into a header-collapsed group opens it and scrolls to the row', async () => {
    mount(bash('r1', at(-100)), ...finishedTasks(2))
    click(groupHeader('Finished')!)
    expect(rowOf('f2')).toBeNull()
    rowRects.f2 = { top: 600, bottom: 640 }
    reveal('f2')
    await flush()
    expect(isExpanded('f2')).toBe(true)
    expect(panelRoot().scrollTop).toBe(340)
  })

  it('a request made before mount scrolls on mount', async () => {
    upsert(...finishedTasks(7))
    rowRects.f7 = { top: 600, bottom: 640 }
    act(() => useChatStore.getState().revealTask('f7'))
    render()
    await flush()
    expect(isExpanded('f7')).toBe(true)
    expect(panelRoot().scrollTop).toBe(340)
  })
})

// ── 锚点与交互契约 ────────────────────────────────────────────────────────

describe('A anchors and interaction contracts', () => {
  it('A-1 every row carries data-task-row (kind), data-task-status (raw status), data-task-id', () => {
    const tasks = [
      bash('b1', at(-10)),
      agent('a1', at(-20)),
      sub('ss1', 'c1', at(-30), null, 'waiting-input'),
      bash('b2', at(-100), at(-50), 'error'),
      agent('a2', at(-100), at(-60), 'killed'),
      sub('ss2', 'c2', at(-100), at(-70), 'done')
    ]
    upsert(...tasks)
    render()
    expect(rows()).toHaveLength(tasks.length)
    for (const task of tasks) {
      const row = rowOf(task.taskId)!
      expect(row.getAttribute('data-task-row')).toBe(task.kind)
      expect(row.getAttribute('data-task-status')).toBe(task.status)
      expect(row.getAttribute('data-task-id')).toBe(task.taskId)
    }
  })

  it('A-2 the first .truncate in a row is its title (text and title attribute)', () => {
    upsert(bash('b1', at(-10)), bash('f1', at(-100), at(-50)), sub('ss1', 'c1', at(-30)))
    setChat({ sessionAskCounts: { c1: 1 } })
    render()
    for (const id of ['b1', 'f1', 'ss1']) {
      const title = rowOf(id)!.querySelector<HTMLElement>('.truncate')!
      expect(title.textContent).toBe(`Task ${id}`)
      expect(title.getAttribute('title')).toBe(`Task ${id}`)
    }
  })

  it('A-4 expansion is mutually exclusive, across groups too', async () => {
    upsert(bash('r1', at(-10)), bash('r2', at(-20)), bash('f1', at(-100), at(-50)))
    render()
    toggleRow('r1')
    await flush()
    expect(expandedIds()).toEqual(['r1'])
    toggleRow('r2')
    await flush()
    expect(expandedIds()).toEqual(['r2'])
    toggleRow('f1')
    await flush()
    expect(expandedIds()).toEqual(['f1'])
    toggleRow('f1')
    expect(expandedIds()).toEqual([])
  })

  it('A-5 sub-session rows: no sub-agent anchors, not expandable, "Open" goes to the child session', async () => {
    upsert(sub('ss1', 'c1', at(-30)), bash('b1', at(-10)), sub('ss2', 'c2', at(-100), at(-50)))
    render()
    toggleRow('b1')
    await flush()
    expect(expandedIds()).toEqual(['b1'])

    for (const id of ['ss1', 'ss2']) {
      const row = rowOf(id)!
      expect([...row.attributes].some((a) => a.name.startsWith('data-subagent'))).toBe(false)
      expect(titleRow(id).classList.contains('cursor-pointer')).toBe(false)
      toggleRow(id)
      expect(expandedIds()).toEqual(['b1'])
    }

    const open = rowOf('ss1')!.querySelector<HTMLElement>('[data-task-open]')!
    expect(open.textContent).toBe('Open')
    click(open)
    expect(useChatStore.getState().activeSessionId).toBe('c1')
    expect(expandedIds()).toEqual(['b1'])
    click(rowOf('ss2')!.querySelector('[data-task-open]')!)
    expect(useChatStore.getState().activeSessionId).toBe('c2')
  })

  it('A-6 Stop calls stop({toolCallId}) without expanding the row', () => {
    upsert(bash('r1', at(-10)))
    render()
    click(rowOf('r1')!.querySelector('button[title="Stop task"]')!)
    expect(bgTaskApi.stop).toHaveBeenCalledTimes(1)
    expect(bgTaskApi.stop).toHaveBeenCalledWith({ toolCallId: 'r1' })
    expect(expandedIds()).toEqual([])
  })
})
