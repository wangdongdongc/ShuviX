// @vitest-environment jsdom
/**
 * 手机布局的后台任务页与任务详情页（mobile/MobileTasksPage.tsx，jsdom）。
 *
 * 契约：
 * - 列表页：「运行中」「已完成」两张卡片，顺序是桌面面板那份 `orderTasks`（等你回答的最前、每组最新的在上；已完成
 *   按结束时刻倒序、只露最近 5 条，更早的折在一行后面）。一行两排：标题，下面「类别 · 状态 · 时长」；行首一个点
 *   （`data-task-dot`，见 panelPure.taskDotState）。点命令 / 智能体的一行 → `onOpenTask`；点子会话的一行 → 打开那条
 *   会话。「清空」移掉已完成的（store 与宿主各一次）。底部一行：几条任务 · 几条在跑；
 * - 详情页：大标题是任务标题，下面同一行状态；运行中右上角是「停止」，结束后是「移除」（移除后退回列表）；内容是
 *   桌面面板展开的那一块（`BgTaskDetail`，`page`）。任务不在了 → 自己 `onBack()` 一次、什么都不画。
 *
 *   MT-1..9   列表页
 *   MT-10..14 详情页
 *
 * `@shuvix/chat-ui` 换成替身：`useBgTaskStore` / `useBgTasks` / `isTaskFinished` 是按源码路径引的真东西，chat store 是
 * 工厂里建的真 zustand store，`useBgTaskStatus` 交回固定的字；`@shuvix/app-shell` 的 `orderTasks` / `endedAgo` /
 * `FINISHED_PREVIEW` 是真的，`BgTaskDetail` 是记 props 的替身，哪些任务在等你由用例定。真 en 文案；时钟是假的。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'

type Props = Record<string, unknown>
interface BgStore {
  getState: () => {
    tasks: Record<string, TaskInfo>
    upsert: (task: TaskInfo) => void
    remove: (taskId: string) => void
    removeFinished: (sessionId: string) => void
  }
  setState: (patch: { tasks: Record<string, TaskInfo> }) => void
}

const rec = vi.hoisted(() => ({
  bg: null as unknown as BgStore,
  chat: null as unknown as { setState: (patch: Record<string, unknown>) => void },
  blocked: new Set<string>(),
  /** 宿主没有后台任务这一面（Chrome 面板）时是 null */
  host: null as unknown,
  details: [] as Array<Record<string, unknown>>
}))

vi.mock('@shuvix/chat-ui', async () => {
  const { create } = await import('zustand')
  const bg = await import('../../../../../../../packages/chat-ui/src/stores/bgTaskStore')
  const useChatStore = create<Record<string, unknown>>(() => ({ setActiveSessionId: () => {} }))
  rec.bg = bg.useBgTaskStore as unknown as BgStore
  rec.chat = useChatStore
  return {
    useChatStore,
    useBgTaskStore: bg.useBgTaskStore,
    useBgTasks: bg.useBgTasks,
    isTaskFinished: bg.isTaskFinished,
    useBgTaskStatus: () => ({ state: 'Running', duration: '1m' }),
    getHostApi: () => rec.host
  }
})

vi.mock('@shuvix/app-shell', async () => {
  const { createElement: h, useMemo } = await import('react')
  const order = await import('../../../../../../../packages/app-shell/src/panel/bgTaskOrder')
  return {
    FINISHED_PREVIEW: order.FINISHED_PREVIEW,
    endedAgo: order.endedAgo,
    orderTasks: order.orderTasks,
    basename: (p: string) => p.split('/').pop() ?? '',
    useBlockedTaskIds: (tasks: TaskInfo[]) => {
      const key = tasks
        .filter((task) => rec.blocked.has(task.taskId))
        .map((task) => task.taskId)
        .join('\n')
      return useMemo(() => new Set(key ? key.split('\n') : []), [key])
    },
    useTaskKindLabel: (task: TaskInfo) => `K:${task.kind}`,
    BgTaskDetail: (props: Props) => {
      rec.details.push(props)
      return h('div', { 'data-stub-task-detail': '' })
    }
  }
})

import {
  MobileTaskDetailPage,
  MobileTasksPage,
  type MobileTaskDetailPageProps,
  type MobileTasksPageProps
} from '../MobileTasksPage'
import { taskDotState } from '../panelPure'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const M = en.mobile
const P = en.panel
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0)
const MIN = 60_000

const onBack = vi.fn<() => void>()
const onOpenTask = vi.fn<(taskId: string) => void>()
const setActiveSessionId = vi.fn<(id: string | null) => void>()
const stop = vi.fn<(params: unknown) => Promise<void>>()
const dismiss = vi.fn<(params: unknown) => Promise<void>>()
const clearDone = vi.fn<(params: unknown) => Promise<void>>()

let container: HTMLDivElement
let root: Root
let mounted = false

let seq = 0
function task(over: Partial<TaskInfo> & { taskId: string }): TaskInfo {
  seq += 1
  const kind = over.kind ?? 'bash'
  const subject =
    kind === 'bash'
      ? {
          kind: 'bash',
          command: 'x',
          cwd: '/',
          pid: 1,
          logPath: '/l',
          exitCode: null,
          signal: null
        }
      : kind === 'agent'
        ? { kind: 'agent', profileName: 'explore', depth: 1 }
        : { kind: 'sub-session', childSessionId: `child-${over.taskId}` }
  return {
    kind,
    sessionId: 's1',
    title: `Title ${over.taskId}`,
    status: 'running',
    detached: true,
    startedAt: NOW - 10 * MIN + seq,
    endedAt: null,
    subject,
    ...over
  } as TaskInfo
}
/** 一条结束了的任务：`ago` 分钟前结束 */
const ended = (taskId: string, ago: number, over: Partial<TaskInfo> = {}): TaskInfo =>
  task({ taskId, status: 'done', endedAt: NOW - ago * MIN, ...over })
function setTasks(...tasks: TaskInfo[]): void {
  act(() => rec.bg.setState({ tasks: Object.fromEntries(tasks.map((t) => [t.taskId, t])) }))
}

function mountList(over: Partial<MobileTasksPageProps> = {}): void {
  act(() =>
    root.render(createElement(MobileTasksPage, { sessionId: 's1', onBack, onOpenTask, ...over }))
  )
  // 时钟的头一拍
  act(() => {
    vi.advanceTimersByTime(0)
  })
  mounted = true
}
function mountDetail(over: Partial<MobileTaskDetailPageProps> = {}): void {
  act(() =>
    root.render(
      createElement(MobileTaskDetailPage, { sessionId: 's1', taskId: 't1', onBack, ...over })
    )
  )
  act(() => {
    vi.advanceTimersByTime(0)
  })
  mounted = true
}
function unmount(): void {
  if (!mounted) return
  act(() => root.unmount())
  mounted = false
}
const flush = (): Promise<void> => act(async () => {})

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(sel))
const text = (sel: string): string | null => q(sel)?.textContent ?? null
function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const groups = (): Array<string | null> =>
  qa('[data-mobile-task-group]').map((el) => el.getAttribute('data-mobile-task-group'))
const rowIds = (group: 'running' | 'finished'): Array<string | null> =>
  qa(`[data-mobile-task-group="${group}"] [data-mobile-task-row]`).map((el) =>
    el.getAttribute('data-task-id')
  )
const row = (id: string): HTMLElement => q(`[data-mobile-task-row][data-task-id="${id}"]`)!
const meta = (id: string): HTMLElement => row(id).querySelector<HTMLElement>('[data-task-meta]')!
const dot = (id: string): string | null =>
  row(id).querySelector('[data-task-dot]')!.getAttribute('data-task-dot')
const count = (): string | null => text('[data-mobile-tasks-count]')
const older = (): HTMLElement | null => q('[data-mobile-tasks-older]')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  vi.setSystemTime(NOW)
  window.history.replaceState(null, '')
  seq = 0
  rec.bg.setState({ tasks: {} })
  rec.blocked = new Set()
  rec.details.length = 0
  onBack.mockReset()
  onOpenTask.mockReset()
  setActiveSessionId.mockReset()
  stop.mockReset().mockResolvedValue(undefined)
  dismiss.mockReset().mockResolvedValue(undefined)
  clearDone.mockReset().mockResolvedValue(undefined)
  rec.host = { bgTask: { stop, dismiss, clearDone } }
  rec.chat.setState({ setActiveSessionId })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = false
})

afterEach(() => {
  unmount()
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('MobileTasksPage: the list', () => {
  it('MT-1 no tasks: the empty text, no group, an empty toolbar', () => {
    mountList()
    expect(q('[data-mobile-panel="tasks"]')).not.toBeNull()
    expect(text('[data-mobile-tasks-empty]')).toBe(M.noTasks)
    expect(groups()).toEqual([])
    expect(count()).toBe('')
    expect(text('[data-mobile-panel-title]')).toBe(M.backgroundTasks)
    expect(text('[data-mobile-panel-back]')).toBe(M.detailsBack)
    click(q('[data-mobile-panel-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it("MT-1 another session's tasks are not this page's", () => {
    setTasks(task({ taskId: 'x', sessionId: 's2' }))
    mountList()
    expect(q('[data-mobile-tasks-empty]')).not.toBeNull()
    expect(qa('[data-mobile-task-row]')).toEqual([])
  })

  it('MT-2 running then finished; blocked first, newest start first; finished by end time', () => {
    setTasks(
      task({ taskId: 'r-old', startedAt: NOW - 9 * MIN }),
      task({ taskId: 'r-new', kind: 'agent', startedAt: NOW - 1 * MIN }),
      task({
        taskId: 'r-blocked',
        kind: 'agent',
        status: 'waiting-input',
        startedAt: NOW - 5 * MIN
      }),
      ended('f-early', 30),
      ended('f-late', 2, { status: 'error' }),
      ended('f-mid', 10, { status: 'killed', kind: 'sub-session' })
    )
    rec.blocked = new Set(['r-blocked'])
    mountList()
    expect(groups()).toEqual(['running', 'finished'])
    expect(rowIds('running')).toEqual(['r-blocked', 'r-new', 'r-old'])
    expect(rowIds('finished')).toEqual(['f-late', 'f-mid', 'f-early'])
    expect(row('r-new').getAttribute('data-mobile-task-row')).toBe('agent')
    expect(row('r-new').getAttribute('data-task-status')).toBe('running')
    expect(row('r-blocked').getAttribute('data-task-status')).toBe('waiting-input')
    expect(row('f-mid').getAttribute('data-mobile-task-row')).toBe('sub-session')
    expect(row('f-late').getAttribute('data-task-status')).toBe('error')
    expect(q('[data-mobile-task-group="running"]')!.textContent).toContain(P.tasksRunning)
    expect(q('[data-mobile-task-group="finished"]')!.textContent).toContain(P.tasksFinished)
    // 「清空」只在已完成那一组
    expect(qa('[data-mobile-tasks-clear]')).toHaveLength(1)
    expect(q('[data-mobile-task-group="running"] [data-mobile-tasks-clear]')).toBeNull()
  })

  it('MT-2 only running tasks: no finished group, and the other way round', () => {
    setTasks(task({ taskId: 'r1' }))
    mountList()
    expect(groups()).toEqual(['running'])
    setTasks(ended('f1', 1))
    expect(groups()).toEqual(['finished'])
  })

  it('MT-3 the second line: kind · state · duration', () => {
    setTasks(
      task({ taskId: 'run' }),
      task({ taskId: 'ask', kind: 'agent', status: 'waiting-input' }),
      ended('fin', 5),
      ended('now', 0)
    )
    rec.blocked = new Set(['ask'])
    mountList()
    expect(row('run').textContent).toContain('Title run')
    expect(meta('run').textContent).toBe('K:bash · Running · 1m')
    expect(meta('run').classList.contains('text-warning')).toBe(false)
    expect(meta('ask').textContent).toBe(`K:agent · ${P.tasksBlockedOn} · 1m`)
    expect(meta('ask').classList.contains('text-warning')).toBe(true)
    expect(meta('fin').textContent).toBe(
      `K:bash · ${i18n.t('panel.tasksEndedMinutesAgo', { count: 5 })} · 1m`
    )
    expect(meta('now').textContent).toBe(`K:bash · ${P.tasksEndedJustNow} · 1m`)
  })

  it('MT-4 the dot says what kind of running, waiting, failed or ended it is', () => {
    const list = [
      task({ taskId: 'blocked', kind: 'agent', status: 'waiting-input' }),
      task({ taskId: 'bash' }),
      task({ taskId: 'agent', kind: 'agent' }),
      task({ taskId: 'sub', kind: 'sub-session' }),
      ended('failed', 1, { status: 'error' }),
      ended('done', 2)
    ]
    setTasks(...list)
    rec.blocked = new Set(['blocked'])
    mountList()
    expect(dot('blocked')).toBe('blocked')
    expect(dot('bash')).toBe('resident')
    expect(dot('agent')).toBe('agent')
    expect(dot('sub')).toBe('agent')
    expect(dot('failed')).toBe('error')
    expect(dot('done')).toBe('ended')
    for (const t of list) expect(dot(t.taskId)).toBe(taskDotState(t, rec.blocked.has(t.taskId)))
  })

  it('MT-5 eight finished: five shown, the rest behind one row that toggles', () => {
    setTasks(...Array.from({ length: 8 }, (_, i) => ended(`f${i}`, i + 1)))
    mountList()
    expect(rowIds('finished')).toEqual(['f0', 'f1', 'f2', 'f3', 'f4'])
    expect(older()!.textContent).toBe(i18n.t('panel.tasksShowOlder', { count: 3 }))
    click(older()!)
    expect(rowIds('finished')).toHaveLength(8)
    expect(older()!.textContent).toBe(i18n.t('panel.tasksShowRecent', { count: 5 }))
    click(older()!)
    expect(rowIds('finished')).toHaveLength(5)
    expect(older()!.textContent).toBe(i18n.t('panel.tasksShowOlder', { count: 3 }))
  })

  it('MT-5 exactly five finished: no such row', () => {
    setTasks(...Array.from({ length: 5 }, (_, i) => ended(`f${i}`, i + 1)))
    mountList()
    expect(rowIds('finished')).toHaveLength(5)
    expect(older()).toBeNull()
  })

  it('MT-6 Clear removes the finished ones here and on the host; running rows stay', () => {
    setTasks(
      task({ taskId: 'r1' }),
      ended('f1', 1),
      ended('f2', 2),
      ended('other', 1, { sessionId: 's2' })
    )
    mountList()
    click(q('[data-mobile-tasks-clear]')!)
    expect(clearDone).toHaveBeenCalledTimes(1)
    expect(clearDone).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(Object.keys(rec.bg.getState().tasks).sort()).toEqual(['other', 'r1'])
    expect(groups()).toEqual(['running'])
    expect(rowIds('running')).toEqual(['r1'])
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('MT-6 a host that refuses the clear does not throw', async () => {
    clearDone.mockRejectedValue(new Error('offline'))
    setTasks(ended('f1', 1))
    mountList()
    expect(() => click(q('[data-mobile-tasks-clear]')!)).not.toThrow()
    await flush()
    expect(q('[data-mobile-tasks-empty]')).not.toBeNull()
  })

  it('MT-6 a host with no background-task side: the list is still cleared', () => {
    rec.host = null
    setTasks(ended('f1', 1))
    mountList()
    expect(() => click(q('[data-mobile-tasks-clear]')!)).not.toThrow()
    expect(rec.bg.getState().tasks).toEqual({})
  })

  it('MT-6 clearing while "older" is open resets it', () => {
    setTasks(...Array.from({ length: 8 }, (_, i) => ended(`f${i}`, i + 1)))
    mountList()
    click(older()!)
    expect(rowIds('finished')).toHaveLength(8)
    click(q('[data-mobile-tasks-clear]')!)
    setTasks(...Array.from({ length: 8 }, (_, i) => ended(`g${i}`, i + 1)))
    expect(rowIds('finished')).toHaveLength(5)
    expect(older()!.textContent).toBe(i18n.t('panel.tasksShowOlder', { count: 3 }))
  })

  it.each(['bash', 'agent'] as const)('MT-7 a tap on a %s row opens its detail', (kind) => {
    setTasks(task({ taskId: 't1', kind }))
    mountList()
    click(row('t1'))
    expect(onOpenTask).toHaveBeenCalledTimes(1)
    expect(onOpenTask).toHaveBeenCalledWith('t1')
    expect(setActiveSessionId).not.toHaveBeenCalled()
  })

  it('MT-7 a finished row opens its detail too', () => {
    setTasks(ended('t1', 3))
    mountList()
    click(row('t1'))
    expect(onOpenTask).toHaveBeenCalledWith('t1')
  })

  it('MT-8 a tap on a sub-session row opens that session, not a detail page', () => {
    setTasks(task({ taskId: 't1', kind: 'sub-session' }))
    mountList()
    click(row('t1'))
    expect(setActiveSessionId).toHaveBeenCalledTimes(1)
    expect(setActiveSessionId).toHaveBeenCalledWith('child-t1')
    expect(onOpenTask).not.toHaveBeenCalled()
  })

  it('MT-9 the toolbar: how many tasks, how many still running', () => {
    setTasks(
      task({ taskId: 'r1' }),
      task({ taskId: 'r2', status: 'waiting-input' }),
      ended('f1', 1)
    )
    mountList()
    expect(count()).toBe('3 tasks · 2 running')
    setTasks(ended('f1', 1), ended('f2', 2), ended('f3', 3))
    expect(count()).toBe('3 tasks')
    setTasks(task({ taskId: 'r1' }))
    expect(count()).toBe('1 task · 1 running')
  })
})

describe('MobileTaskDetailPage', () => {
  it('MT-10 a running command: its title, state line, Stop, and the output block', () => {
    const t1 = task({ taskId: 't1' })
    setTasks(t1)
    mountDetail()
    expect(q('[data-mobile-panel="task"]')).not.toBeNull()
    expect(text('[data-mobile-panel-title]')).toBe('Title t1')
    expect(text('[data-mobile-panel-back]')).toBe(M.backgroundTasks)
    const state = q('[data-mobile-panel-subtitle] [data-mobile-task-state]')!
    expect(state.getAttribute('data-mobile-task-state')).toBe('resident')
    expect(state.textContent).toBe('K:bash · Running · 1m')
    expect(text('[data-mobile-task-stop]')).toBe(M.taskStop)
    expect(q('[data-mobile-task-dismiss]')).toBeNull()
    const body = q('[data-mobile-task-detail]')!
    expect(body.getAttribute('data-mobile-task-detail')).toBe('bash')
    expect(body.getAttribute('data-task-id')).toBe('t1')
    expect(body.querySelector('[data-stub-task-detail]')).not.toBeNull()
    expect(rec.details.at(-1)).toEqual({ task: t1, page: true })
    click(q('[data-mobile-panel-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it.each<[string, Partial<TaskInfo>, boolean, string]>([
    ['a running agent', { kind: 'agent' }, false, 'agent'],
    ['an agent waiting for you', { kind: 'agent', status: 'waiting-input' }, true, 'blocked']
  ])('MT-10 %s: the state attribute and wording', (_label, over, blocked, attr) => {
    setTasks(task({ taskId: 't1', ...over }))
    if (blocked) rec.blocked = new Set(['t1'])
    mountDetail()
    const state = q('[data-mobile-task-state]')!
    expect(state.getAttribute('data-mobile-task-state')).toBe(attr)
    expect(state.textContent).toBe(
      blocked ? `K:agent · ${P.tasksBlockedOn} · 1m` : 'K:agent · Running · 1m'
    )
    expect(q('[data-mobile-task-detail]')!.getAttribute('data-mobile-task-detail')).toBe('agent')
    expect(q('[data-mobile-task-stop]')).not.toBeNull()
  })

  it('MT-11 Stop stops the task once and stays on the page', async () => {
    setTasks(task({ taskId: 't1' }))
    mountDetail()
    click(q('[data-mobile-task-stop]')!)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith({ toolCallId: 't1' })
    await flush()
    expect(q('[data-mobile-panel="task"]')).not.toBeNull()
    expect(onBack).not.toHaveBeenCalled()
    expect(rec.bg.getState().tasks.t1).toBeDefined()
  })

  it('MT-11 a refused stop is swallowed', async () => {
    stop.mockRejectedValue(new Error('offline'))
    setTasks(task({ taskId: 't1' }))
    mountDetail()
    expect(() => click(q('[data-mobile-task-stop]')!)).not.toThrow()
    await flush()
    expect(q('[data-mobile-panel="task"]')).not.toBeNull()
  })

  it.each<[string, 'done' | 'killed' | 'error', string]>([
    ['done', 'done', 'ended'],
    ['killed', 'killed', 'ended'],
    ['failed', 'error', 'error']
  ])('MT-12 a %s task: Remove instead of Stop, "ended … ago"', (_label, status, attr) => {
    setTasks(ended('t1', 7, { status }))
    mountDetail()
    expect(text('[data-mobile-task-dismiss]')).toBe(M.taskRemove)
    expect(q('[data-mobile-task-stop]')).toBeNull()
    const state = q('[data-mobile-task-state]')!
    expect(state.getAttribute('data-mobile-task-state')).toBe(attr)
    expect(state.textContent).toBe(
      `K:bash · ${i18n.t('panel.tasksEndedMinutesAgo', { count: 7 })} · 1m`
    )
  })

  it('MT-12 the page follows the task ending while it is open', () => {
    const t1 = task({ taskId: 't1' })
    setTasks(t1)
    mountDetail()
    expect(q('[data-mobile-task-stop]')).not.toBeNull()
    setTasks({ ...t1, status: 'killed', endedAt: NOW })
    expect(q('[data-mobile-task-stop]')).toBeNull()
    expect(q('[data-mobile-task-dismiss]')).not.toBeNull()
    expect(onBack).not.toHaveBeenCalled()
  })

  it('MT-13 Remove takes the task off the list, tells the host, and goes back once', async () => {
    setTasks(ended('t1', 1), task({ taskId: 't2' }))
    mountDetail()
    click(q('[data-mobile-task-dismiss]')!)
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(dismiss).toHaveBeenCalledWith({ toolCallId: 't1' })
    expect(Object.keys(rec.bg.getState().tasks)).toEqual(['t2'])
    await flush()
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(container.innerHTML).toBe('')
    expect(stop).not.toHaveBeenCalled()
  })

  it('MT-13 a refused removal is swallowed; the page still goes back', async () => {
    dismiss.mockRejectedValue(new Error('offline'))
    setTasks(ended('t1', 1))
    mountDetail()
    expect(() => click(q('[data-mobile-task-dismiss]')!)).not.toThrow()
    await flush()
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('MT-14 the task going away from elsewhere: back once, nothing drawn, not again later', () => {
    setTasks(ended('t1', 1), task({ taskId: 't2' }))
    mountDetail()
    act(() => rec.bg.getState().removeFinished('s1'))
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(container.innerHTML).toBe('')
    act(() => rec.bg.getState().upsert(task({ taskId: 't3' })))
    act(() => rec.bg.getState().remove('t2'))
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('MT-14 a task that was never there: back once, nothing drawn', () => {
    mountDetail({ taskId: 'nope' })
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(container.innerHTML).toBe('')
  })

  it("MT-14 another session's task with the same id is not this page's", () => {
    setTasks(task({ taskId: 't1', sessionId: 's2' }))
    mountDetail()
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(q('[data-mobile-panel="task"]')).toBeNull()
  })
})
