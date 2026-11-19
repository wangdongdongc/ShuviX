// @vitest-environment jsdom
/**
 * 日历面板的接线（components/browser/CalendarPanel.tsx，jsdom）—— 手机布局（`mobile`，2026-11-15）给三样子组件各
 * 换一副样子，其余的事（取数、打开、日报、行菜单）两种布局是同一份：
 *
 *   CM-1  mobile：根上 `data-calendar-panel="mobile"`；月历 `hideWeekNumber`；日报头 `card`；
 *         会话列表拿到 `drill = { scope: null, flat: true, onOpen }`
 *   CM-2  桌面（不传）：`data-calendar-panel=""`；`hideWeekNumber` / `card` 为 false；没有 `drill`
 *   CM-3  `drill` 跨重渲染是同一个对象
 *   CM-4  `drill.onOpen` 什么都不做
 *   CM-5  两种布局：列表拿到当天的会话与行菜单的回调（sessionsOverride / hideEmptyGroups / bots.adapter / caps.pin）
 *   CM-6  打开选中那天最后活跃的会话：切过去、报给宿主，不找那天的第一条消息
 *   CM-7  从更早的一天打开：滚到那天的第一条消息；查不到就不滚
 *   CM-8  日报的状态：还没回来 undefined → 回来 {excerpt, path} / null；换了日子先回到 undefined
 *   CM-9  writable：今天、昨天能写，明天不能
 *   CM-10 日报头的 onOpen：openReport → 刷会话列表 → 切过去 → 报给宿主；被拒就什么都不做
 *   CM-11 日报头的 onDelete → deleteReport 再从列表里拿掉那条会话；onRevealFile → app.revealPath
 *   CM-12 重拉分开算：daily.changed 只重查日报，session.listChanged 只重查会话
 *   CM-13 行菜单「复制链接」：`[标题](shuvix://session/<id>#<那天的第一条>)`
 *   CM-14 行菜单「配置」：弹会话设置
 *   CM-15 桌面、不淡：月历与日报头都拿到 `dim: false`
 *   CM-16 桌面、专注模式在淡：两样都拿到 `dim: true`；日报头 `card: false`
 *   CM-17 手机、专注模式在淡：两样都拿到 `dim: false`（手机没有专注模式）；日报头 `card`、月历 `hideWeekNumber`
 *   CM-18 专注模式开着但不淡（`focusMode: true, dim: false`）：两样都拿到 `dim: false`
 *
 * `@shuvix/app-shell` 与 `@shuvix/chat-ui` 整份换成记 props 的替身：CalendarView 替身照画 dayHeader、当天有会话就
 * 调 renderGroupedSessionsForDay（真的那个也是这样），于是日报头与会话列表的 props 都记得到。钟只假 `Date`（今天定在
 * 2025-06-18），定时器是真的，`flush()` 照常。桌面 vitest 对渲染层只收 `*.test.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement, type FunctionComponent, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { linkText, sessionLink } from '@shuvix/chat-protocol/dailyNotes'

type Props = Record<string, unknown>
type AnyFn = (...args: never[]) => unknown

const rec = vi.hoisted(() => ({
  calendarView: [] as Props[],
  header: [] as Props[],
  groups: [] as Props[],
  config: [] as Props[],
  appEvents: {} as Record<string, () => void>,
  /** useFocusDim 替身交回的值（每个用例在 beforeEach 里复位） */
  focusDim: { focusMode: false, dim: false },
  projects: [{ id: 'p1', name: 'Proj' }],
  requestDelete: (): void => {},
  store: null as unknown as {
    sessions: Array<{ id: string; title: string }>
    activeSessionId: string | null
    setActiveSessionId: Mock<(id: string) => void>
    requestScrollToMessage: Mock<(sessionId: string, entryId: string) => void>
    setSessions: Mock<(list: unknown) => void>
    removeSession: Mock<(id: string) => void>
  },
  calendar: null as unknown as {
    daysInMonth: Mock<(q: { year: number; month: number }) => Promise<string[]>>
    sessionsOnDay: Mock<(q: { day: string }) => Promise<unknown[]>>
    reportDaysInMonth: Mock<(q: { year: number; month: number }) => Promise<string[]>>
    reportOnDay: Mock<(q: { day: string }) => Promise<unknown>>
    openReport: Mock<(q: { day: string }) => Promise<{ id: string }>>
    deleteReport: Mock<(q: { day: string }) => Promise<{ sessionId: string | null }>>
    firstEntryOnDay: Mock<(q: { sessionId: string; day: string }) => Promise<string | null>>
  },
  revealPath: null as unknown as Mock<(path: string) => void>,
  sessionList: null as unknown as Mock<() => Promise<unknown[]>>,
  sessionCreate: null as unknown as Mock<(q: unknown) => Promise<{ id: string }>>,
  copyToClipboard: null as unknown as Mock<(text: string) => void>
}))

vi.mock('@shuvix/app-shell', async () => {
  const { createElement: h } = await import('react')
  return {
    CalendarView: (props: Props) => {
      rec.calendarView.push(props)
      const list = props.daySessions as unknown[]
      const render = props.renderGroupedSessionsForDay as (sessions: unknown[]) => ReactNode
      return h(
        'div',
        { 'data-stub-calendar-view': '' },
        props.dayHeader as ReactNode,
        list.length > 0 ? render(list) : null
      )
    },
    DayReportHeader: (props: Props) => {
      rec.header.push(props)
      return h('div', { 'data-stub-day-header': '' })
    },
    ProjectSessionGroups: (props: Props) => {
      rec.groups.push(props)
      return h('div', { 'data-stub-groups': '' })
    },
    SessionConfigDialog: (props: Props) => {
      rec.config.push(props)
      return h('div', { 'data-stub-config': props.sessionId as string })
    },
    useFocusDim: () => rec.focusDim,
    useProjects: () => ({ projects: rec.projects }),
    useSessionDelete: () => ({ requestDelete: rec.requestDelete, deleteDialog: null })
  }
})

vi.mock('@shuvix/chat-ui', async () => {
  const { vi: v } = await import('vitest')
  rec.store = {
    sessions: [],
    activeSessionId: null,
    setActiveSessionId: v.fn(),
    requestScrollToMessage: v.fn(),
    setSessions: v.fn(),
    removeSession: v.fn()
  }
  rec.calendar = {
    daysInMonth: v.fn(),
    sessionsOnDay: v.fn(),
    reportDaysInMonth: v.fn(),
    reportOnDay: v.fn(),
    openReport: v.fn(),
    deleteReport: v.fn(),
    firstEntryOnDay: v.fn()
  }
  rec.revealPath = v.fn()
  rec.sessionList = v.fn()
  rec.sessionCreate = v.fn()
  rec.copyToClipboard = v.fn()
  const useChatStore = Object.assign(
    (selector: (s: typeof rec.store) => unknown) => selector(rec.store),
    { getState: () => rec.store }
  )
  return {
    getHostApi: () => ({ calendar: rec.calendar, app: { revealPath: rec.revealPath } }),
    getChatApi: () => ({
      agent: { onEvent: () => () => {} },
      session: { list: rec.sessionList, create: rec.sessionCreate }
    }),
    useAppEvent: (name: string, handler: () => void) => {
      rec.appEvents[name] = handler
    },
    useChatStore,
    isSubSession: () => false,
    copyToClipboard: (text: string) => rec.copyToClipboard(text)
  }
})

vi.mock('../../../stores/browserStore', () => ({
  useBrowserStore: (selector: (s: { width: number }) => unknown) => selector({ width: 360 })
}))

import { CalendarPanel, type CalendarPanelProps } from '../CalendarPanel'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** 今天：2025-06-18（周三）15:30，本地时间 */
const NOW = new Date(2025, 5, 18, 15, 30, 0).getTime()
const TODAY = '2025-06-18'
const YESTERDAY = '2025-06-17'
const TOMORROW = '2025-06-19'

interface DaySession {
  id: string
  title: string
  projectId: string | null
  lastActiveAt: number
  settings: Record<string, unknown>
}
const S1: DaySession = {
  id: 's1',
  title: 'Day [one]',
  projectId: 'p1',
  lastActiveAt: NOW - 60_000,
  settings: {}
}

const windowApi = {
  bot: { list: vi.fn(async () => ({ bots: [], shadowed: [], invalid: [] })) },
  pinChat: { focus: vi.fn() }
}

let container: HTMLDivElement
let root: Root
let daySessions: DaySession[]

async function flush(rounds = 2): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function mount(props: CalendarPanelProps = {}): Promise<void> {
  // 组件的参数有缺省值（`= {}`），createElement 的重载对不上：按函数组件的类型给
  const Panel = CalendarPanel as FunctionComponent<CalendarPanelProps>
  act(() => root.render(createElement(Panel, props)))
  await flush()
}

const lastView = (): Props => rec.calendarView.at(-1)!
const lastHeader = (): Props => rec.header.at(-1)!
const lastGroups = (): Props => rec.groups.at(-1)!
const fn = <T extends AnyFn>(value: unknown): T => {
  expect(typeof value).toBe('function')
  return value as T
}

/** 用户在月历上点了另一天 */
async function selectDay(date: Date): Promise<void> {
  const onSelect = fn<(d: Date) => void>(lastView().onSelect)
  act(() => onSelect(date))
  await flush()
}

async function fire(event: 'daily.changed' | 'session.listChanged'): Promise<void> {
  const handler = rec.appEvents[event]
  expect(typeof handler).toBe('function')
  act(() => handler())
  await flush()
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const MODES: Array<[string, boolean]> = [
  ['mobile', true],
  ['desktop', false]
]

beforeAll(async () => {
  ;(window as unknown as { api: unknown }).api = windowApi
  if (i18n.isInitialized) {
    await i18n.changeLanguage('en')
    return
  }
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  rec.calendarView.length = 0
  rec.header.length = 0
  rec.groups.length = 0
  rec.config.length = 0
  rec.appEvents = {}
  rec.focusDim = { focusMode: false, dim: false }
  rec.requestDelete = vi.fn()
  rec.store.sessions = []
  rec.store.activeSessionId = null
  rec.store.setActiveSessionId.mockReset()
  rec.store.requestScrollToMessage.mockReset()
  rec.store.setSessions.mockReset()
  rec.store.removeSession.mockReset()
  daySessions = [S1]
  rec.calendar.daysInMonth.mockReset().mockResolvedValue([])
  rec.calendar.sessionsOnDay.mockReset().mockImplementation(async () => daySessions)
  rec.calendar.reportDaysInMonth.mockReset().mockResolvedValue([])
  rec.calendar.reportOnDay.mockReset().mockResolvedValue(null)
  rec.calendar.openReport.mockReset().mockResolvedValue({ id: 'r1' })
  rec.calendar.deleteReport.mockReset().mockResolvedValue({ sessionId: null })
  rec.calendar.firstEntryOnDay.mockReset().mockResolvedValue(null)
  rec.revealPath.mockReset()
  rec.sessionList.mockReset().mockResolvedValue([])
  rec.sessionCreate.mockReset().mockResolvedValue({ id: 'new' })
  rec.copyToClipboard.mockReset()
  windowApi.pinChat.focus.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('CalendarPanel：手机与桌面各给子组件什么', () => {
  it('CM-1 mobile：根上的标记、月历不画周数、日报是卡片、会话平铺', async () => {
    await mount({ mobile: true })
    expect(
      container.querySelector('[data-calendar-panel]')!.getAttribute('data-calendar-panel')
    ).toBe('mobile')
    expect(lastView().hideWeekNumber).toBe(true)
    expect(lastHeader().card).toBe(true)
    const drill = lastGroups().drill as { scope: unknown; flat: unknown; onOpen: unknown }
    expect(drill).toBeDefined()
    expect(drill.scope).toBeNull()
    expect(drill.flat).toBe(true)
    expect(typeof drill.onOpen).toBe('function')
  })

  it('CM-2 桌面（不传）：空标记、按宽度定周数、日报是一行、没有 drill', async () => {
    await mount()
    expect(
      container.querySelector('[data-calendar-panel]')!.getAttribute('data-calendar-panel')
    ).toBe('')
    expect(container.querySelector('[data-calendar-panel="mobile"]')).toBeNull()
    expect(lastView().hideWeekNumber).toBe(false)
    expect(lastHeader().card).toBe(false)
    expect(rec.groups.length).toBeGreaterThan(0)
    for (const props of rec.groups) expect(props.drill).toBeUndefined()
  })

  it('CM-2 mobile: false 明写与不传一样', async () => {
    await mount({ mobile: false })
    expect(
      container.querySelector('[data-calendar-panel]')!.getAttribute('data-calendar-panel')
    ).toBe('')
    expect(lastView().hideWeekNumber).toBe(false)
    expect(lastHeader().card).toBe(false)
    expect(lastGroups().drill).toBeUndefined()
  })

  it('CP-1 桌面（不传）：根上没有自己的底色（跟着侧栏走），骨架的 class 还在', async () => {
    await mount()
    const rootEl = container.querySelector<HTMLElement>('[data-calendar-panel=""]')!
    expect(rootEl).not.toBeNull()
    expect(rootEl.classList.contains('bg-bg-primary')).toBe(false)
    for (const cls of ['flex', 'flex-col', 'h-full', 'overflow-hidden']) {
      expect(rootEl.classList.contains(cls), cls).toBe(true)
    }
  })

  it('CP-2 mobile：根上是页面的底色', async () => {
    await mount({ mobile: true })
    const rootEl = container.querySelector<HTMLElement>('[data-calendar-panel="mobile"]')!
    expect(rootEl).not.toBeNull()
    expect(rootEl.classList.contains('bg-bg-primary')).toBe(true)
  })

  it('CM-3 drill 跨重渲染是同一个对象', async () => {
    await mount({ mobile: true })
    const first = rec.groups[0].drill
    const before = rec.groups.length
    await fire('daily.changed')
    await fire('session.listChanged')
    expect(rec.groups.length).toBeGreaterThan(before)
    for (const props of rec.groups) expect(props.drill).toBe(first)
  })

  it('CM-4 drill.onOpen 什么都不做', async () => {
    const onOpenSession = vi.fn()
    await mount({ mobile: true, onOpenSession })
    const drill = lastGroups().drill as { onOpen: (scope: string, id?: string) => unknown }
    const renders = rec.groups.length
    expect(() => act(() => void drill.onOpen('p1', 'x'))).not.toThrow()
    expect(rec.store.setActiveSessionId).not.toHaveBeenCalled()
    expect(onOpenSession).not.toHaveBeenCalled()
    expect(rec.groups.length).toBe(renders)
  })
})

describe('CalendarPanel：两种布局共用的那一半', () => {
  it.each(MODES)('CM-5 列表拿到当天的会话与行菜单的回调（%s）', async (_label, mobile) => {
    await mount({ mobile })
    expect(rec.calendar.sessionsOnDay.mock.calls[0][0]).toEqual({ day: TODAY })
    const props = lastGroups()
    expect(props.sessionsOverride).toBe(daySessions)
    expect(props.projects).toBe(rec.projects)
    expect(props.hideEmptyGroups).toBe(true)
    expect(typeof (props.bots as { adapter?: { list?: unknown } }).adapter?.list).toBe('function')
    expect(typeof props.onSelect).toBe('function')
    expect(props.onDelete).toBe(rec.requestDelete)
    expect(typeof props.onConfigureSession).toBe('function')
    expect(typeof props.onCopyLink).toBe('function')
    expect(props.caps).toEqual({ pin: true })
    // 月历拿到的也是同一份
    expect(lastView().daySessions).toBe(daySessions)
  })

  it.each(MODES)(
    'CM-6 打开选中那天最后活跃的会话：切过去、报给宿主，不找那天的第一条消息（%s）',
    async (_label, mobile) => {
      const onOpenSession = vi.fn()
      await mount({ mobile, onOpenSession })
      const onSelect = fn<(id: string) => void>(lastGroups().onSelect)
      act(() => onSelect('s1'))
      await flush()
      expect(rec.store.setActiveSessionId.mock.calls).toEqual([['s1']])
      expect(onOpenSession.mock.calls).toEqual([['s1']])
      expect(rec.calendar.firstEntryOnDay).not.toHaveBeenCalled()
      expect(rec.store.requestScrollToMessage).not.toHaveBeenCalled()
      expect(windowApi.pinChat.focus).not.toHaveBeenCalled()
    }
  )

  it.each(MODES)('CM-7 从更早的一天打开：滚到那天的第一条消息（%s）', async (_label, mobile) => {
    const onOpenSession = vi.fn()
    rec.calendar.firstEntryOnDay.mockResolvedValue('e9')
    await mount({ mobile, onOpenSession })
    await selectDay(new Date(2025, 5, 17))
    expect(rec.calendar.sessionsOnDay.mock.calls.at(-1)![0]).toEqual({ day: YESTERDAY })
    const onSelect = fn<(id: string) => void>(lastGroups().onSelect)
    act(() => onSelect('s1'))
    await flush()
    expect(rec.store.setActiveSessionId.mock.calls).toEqual([['s1']])
    expect(onOpenSession.mock.calls).toEqual([['s1']])
    expect(rec.calendar.firstEntryOnDay.mock.calls).toEqual([[{ sessionId: 's1', day: YESTERDAY }]])
    expect(rec.store.requestScrollToMessage.mock.calls).toEqual([['s1', 'e9']])
  })

  it.each(MODES)('CM-7 那天的消息查不到：不滚（%s）', async (_label, mobile) => {
    rec.calendar.firstEntryOnDay.mockResolvedValue(null)
    await mount({ mobile })
    await selectDay(new Date(2025, 5, 17))
    const onSelect = fn<(id: string) => void>(lastGroups().onSelect)
    act(() => onSelect('s1'))
    await flush()
    expect(rec.calendar.firstEntryOnDay).toHaveBeenCalledTimes(1)
    expect(rec.store.setActiveSessionId.mock.calls).toEqual([['s1']])
    expect(rec.store.requestScrollToMessage).not.toHaveBeenCalled()
  })

  it.each(MODES)(
    'CM-8 日报的状态：没回来 undefined → 回来的那份；换了日子先回到 undefined（%s）',
    async (_label, mobile) => {
      const first = deferred<unknown>()
      const second = deferred<unknown>()
      rec.calendar.reportOnDay.mockReset().mockImplementation(({ day }) => {
        return day === TODAY ? first.promise : second.promise
      })
      await mount({ mobile })
      expect(rec.calendar.reportOnDay.mock.calls).toEqual([[{ day: TODAY }]])
      expect('report' in lastHeader()).toBe(true)
      expect(lastHeader().report).toBeUndefined()

      const report = { excerpt: 'Fixed the dots', path: '/home/u/.shuvix/daily/2025-06-18.md' }
      first.resolve(report)
      await flush()
      expect(lastHeader().report).toEqual(report)

      await selectDay(new Date(2025, 5, 17))
      expect(rec.calendar.reportOnDay.mock.calls.at(-1)![0]).toEqual({ day: YESTERDAY })
      expect(lastHeader().report).toBeUndefined()
      second.resolve(null)
      await flush()
      expect(lastHeader().report).toBeNull()
    }
  )

  it.each(MODES)('CM-9 writable：今天、昨天能写，明天不能（%s）', async (_label, mobile) => {
    await mount({ mobile })
    expect(lastHeader().writable).toBe(true)
    expect((lastHeader().day as Date).getDate()).toBe(18)
    await selectDay(new Date(2025, 5, 19))
    expect(rec.calendar.reportOnDay.mock.calls.at(-1)![0]).toEqual({ day: TOMORROW })
    expect(lastHeader().writable).toBe(false)
    await selectDay(new Date(2025, 5, 17))
    expect(lastHeader().writable).toBe(true)
  })

  it.each(MODES)(
    'CM-10 日报头的 onOpen：openReport → 刷列表 → 切过去 → 报给宿主（%s）',
    async (_label, mobile) => {
      const onOpenSession = vi.fn()
      const list = [{ id: 'r1', title: 'Daily' }]
      rec.sessionList.mockResolvedValue(list)
      await mount({ mobile, onOpenSession })
      const onOpen = fn<() => void>(lastHeader().onOpen)
      act(() => onOpen())
      await flush()
      expect(rec.calendar.openReport.mock.calls).toEqual([[{ day: TODAY }]])
      expect(rec.store.setSessions.mock.calls).toEqual([[list]])
      expect(rec.store.setActiveSessionId.mock.calls).toEqual([['r1']])
      expect(onOpenSession.mock.calls).toEqual([['r1']])
    }
  )

  it.each(MODES)('CM-10 openReport 被拒：什么都不做（%s）', async (_label, mobile) => {
    const onOpenSession = vi.fn()
    rec.calendar.openReport.mockRejectedValue(new Error('future day'))
    await mount({ mobile, onOpenSession })
    const onOpen = fn<() => void>(lastHeader().onOpen)
    act(() => onOpen())
    await flush()
    expect(rec.calendar.openReport).toHaveBeenCalledTimes(1)
    expect(rec.sessionList).not.toHaveBeenCalled()
    expect(rec.store.setSessions).not.toHaveBeenCalled()
    expect(rec.store.setActiveSessionId).not.toHaveBeenCalled()
    expect(onOpenSession).not.toHaveBeenCalled()
  })

  it.each(MODES)(
    'CM-11 日报头的 onDelete → deleteReport 再拿掉那条会话；onRevealFile → revealPath（%s）',
    async (_label, mobile) => {
      rec.calendar.deleteReport.mockResolvedValue({ sessionId: 'r1' })
      await mount({ mobile })
      const onDelete = fn<() => void>(lastHeader().onDelete)
      act(() => onDelete())
      await flush()
      expect(rec.calendar.deleteReport.mock.calls).toEqual([[{ day: TODAY }]])
      expect(rec.store.removeSession.mock.calls).toEqual([['r1']])

      const onRevealFile = fn<(path: string) => void>(lastHeader().onRevealFile)
      act(() => onRevealFile('/home/u/.shuvix/daily/2025-06-18.md'))
      expect(rec.revealPath.mock.calls).toEqual([['/home/u/.shuvix/daily/2025-06-18.md']])
    }
  )

  it.each(MODES)('CM-11 那份日报没有笔记本会话：不拿掉任何会话（%s）', async (_label, mobile) => {
    rec.calendar.deleteReport.mockResolvedValue({ sessionId: null })
    await mount({ mobile })
    const onDelete = fn<() => void>(lastHeader().onDelete)
    act(() => onDelete())
    await flush()
    expect(rec.calendar.deleteReport).toHaveBeenCalledTimes(1)
    expect(rec.store.removeSession).not.toHaveBeenCalled()
  })

  it.each(MODES)(
    'CM-12 daily.changed 只重查日报，session.listChanged 只重查会话（%s）',
    async (_label, mobile) => {
      await mount({ mobile })
      expect(rec.calendar.reportOnDay).toHaveBeenCalledTimes(1)
      expect(rec.calendar.sessionsOnDay).toHaveBeenCalledTimes(1)

      await fire('daily.changed')
      expect(rec.calendar.reportOnDay).toHaveBeenCalledTimes(2)
      expect(rec.calendar.reportDaysInMonth).toHaveBeenCalledTimes(2)
      expect(rec.calendar.sessionsOnDay).toHaveBeenCalledTimes(1)
      expect(rec.calendar.daysInMonth).toHaveBeenCalledTimes(1)

      await fire('session.listChanged')
      expect(rec.calendar.sessionsOnDay).toHaveBeenCalledTimes(2)
      expect(rec.calendar.daysInMonth).toHaveBeenCalledTimes(2)
      expect(rec.calendar.reportOnDay).toHaveBeenCalledTimes(2)
    }
  )

  it.each(MODES)(
    'CM-13 行菜单「复制链接」：标题 + 指向那天第一条消息的会话链接（%s）',
    async (_label, mobile) => {
      rec.calendar.firstEntryOnDay.mockResolvedValue('e1')
      await mount({ mobile })
      const onCopyLink = fn<(id: string) => void>(lastGroups().onCopyLink)
      act(() => onCopyLink('s1'))
      await flush()
      expect(rec.calendar.firstEntryOnDay.mock.calls).toEqual([[{ sessionId: 's1', day: TODAY }]])
      expect(rec.copyToClipboard.mock.calls).toEqual([
        [`[${linkText(S1.title)}](${sessionLink('s1', 'e1')})`]
      ])
      // 标题里的方括号是转义过的，链接带着那条消息
      expect(rec.copyToClipboard.mock.calls[0][0]).toBe('[Day \\[one\\]](shuvix://session/s1#e1)')
    }
  )

  it.each(MODES)('CM-13 那天的消息查不到：只链会话本身（%s）', async (_label, mobile) => {
    rec.calendar.firstEntryOnDay.mockRejectedValue(new Error('gone'))
    daySessions = [{ ...S1, title: '' }]
    await mount({ mobile })
    const onCopyLink = fn<(id: string) => void>(lastGroups().onCopyLink)
    act(() => onCopyLink('s1'))
    await flush()
    expect(rec.copyToClipboard.mock.calls).toEqual([
      [`[${en.sidebar.untitledSession}](${sessionLink('s1')})`]
    ])
  })

  it.each(MODES)('CM-14 行菜单「配置」：弹会话设置，关掉就收（%s）', async (_label, mobile) => {
    await mount({ mobile })
    expect(container.querySelector('[data-stub-config]')).toBeNull()
    const onConfigure = fn<(id: string) => void>(lastGroups().onConfigureSession)
    act(() => onConfigure('s1'))
    expect(container.querySelector('[data-stub-config="s1"]')).not.toBeNull()
    expect(rec.config.at(-1)!.sessionId).toBe('s1')
    const onClose = fn<() => void>(rec.config.at(-1)!.onClose)
    act(() => onClose())
    expect(container.querySelector('[data-stub-config]')).toBeNull()
  })
})

describe('CalendarPanel：专注模式淡化交给月历与日报头', () => {
  it('CM-15 桌面、不淡：两样都拿到 dim: false', async () => {
    await mount()
    expect(lastView().dim).toBe(false)
    expect(lastHeader().dim).toBe(false)
  })

  it('CM-16 桌面、专注模式在淡：两样都拿到 dim: true；日报头不是卡片', async () => {
    rec.focusDim = { focusMode: true, dim: true }
    await mount()
    expect(lastView().dim).toBe(true)
    expect(lastHeader().dim).toBe(true)
    expect(lastHeader().card).toBe(false)
  })

  it('CM-17 手机、专注模式在淡：两样都拿到 dim: false；日报头是卡片、月历不画周数', async () => {
    rec.focusDim = { focusMode: true, dim: true }
    await mount({ mobile: true })
    expect(lastView().dim).toBe(false)
    expect(lastHeader().dim).toBe(false)
    expect(lastHeader().card).toBe(true)
    expect(lastView().hideWeekNumber).toBe(true)
  })

  it('CM-18 专注模式开着但不淡：两样都拿到 dim: false', async () => {
    rec.focusDim = { focusMode: true, dim: false }
    await mount()
    expect(lastView().dim).toBe(false)
    expect(lastHeader().dim).toBe(false)
  })
})
