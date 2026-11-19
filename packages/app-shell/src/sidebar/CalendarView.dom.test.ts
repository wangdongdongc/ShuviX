// @vitest-environment jsdom
/**
 * 日历视图（CalendarView，jsdom）—— `hideWeekNumber`（手机布局的日历不画左边的周数一列）与它不该碰到的其余部分。
 *
 *   CV-1 缺省、宽 300：有周数一列（表头一格、每周一格，`data-week-numbers="true"`）
 *   CV-2 `hideWeekNumber`、宽 300：三样都没有；星期表头 7 格，第一周 7 格（CV-1 是 8 格）
 *   CV-3 桌面按宽度定的规则不变：239 没有，240 有
 *   CV-4 `hideWeekNumber: false` 与不传一样
 *   CV-5 `hideWeekNumber` + 宽 200：没有，不抛
 *   CV-6 其余不变：dayHeader 照画；当天没有会话 → 那句话、不调渲染函数；有 → 调一次、画它给的、没有那句话
 *   CV-7 圆点不变：有会话的日子 `rdp-has-sessions`，写了日报的日子 `rdp-has-report`
 *   CV-8 选日子：点一格 → onSelect(那天)；「今天」→ onSelect + onMonthChange(今天)
 *   CV-9 拖动侧栏时不画月历（带不带 `hideWeekNumber` 都一样）
 *
 * 专注模式淡化（`dim`；FADED = `opacity-30 hover:opacity-100 focus-within:opacity-100` 三个类一起在或一起不在）：
 *   CV-10 不传 dim、没有会话：月历格子 `[data-calendar-grid]` 与「这天没有会话」`[data-calendar-empty]` 都不淡
 *   CV-11 `dim: false`：同 CV-10
 *   CV-12 `dim: true`、没有会话：两样都淡
 *   CV-13 `dim: true`、有会话：月历淡；没有那句话；渲染函数给的节点与 dayHeader 自己及祖先（到滚动容器）都不带 opacity-30
 *   CV-14 `dim: true` 拖动侧栏：占位期间外层照淡；拖完月历回来，外层仍淡
 *   CV-15 dim true → false 重渲染：淡去掉
 *
 * 月历是真的 react-day-picker；`@shuvix/chat-ui` 这里只引了类型。i18n 走真 en 资源。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { Session } from '@shuvix/chat-ui'
import { CalendarView, type CalendarViewProps } from './CalendarView'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const MARCH_14 = new Date(2025, 2, 14)

let container: HTMLDivElement
let root: Root

function mount(props: Partial<CalendarViewProps> = {}): void {
  act(() =>
    root.render(
      createElement(CalendarView, {
        width: 300,
        selected: MARCH_14,
        month: MARCH_14,
        daysWithSessions: [],
        daySessions: [],
        renderGroupedSessionsForDay: () => null,
        onSelect: () => {},
        onMonthChange: () => {},
        ...props
      })
    )
  )
}

const picker = (): HTMLElement | null => container.querySelector<HTMLElement>('.rdp-root')
const weekHeader = (): NodeListOf<Element> =>
  container.querySelectorAll('th.rdp-week_number_header')
const weekCells = (): NodeListOf<Element> => container.querySelectorAll('.rdp-week_number')
const firstWeekCells = (): number => container.querySelector('tr.rdp-week')!.children.length
const dayCell = (key: string): HTMLElement =>
  container.querySelector<HTMLElement>(`td[data-day="${key}"]`)!

/** 周数一列在：表头一格、至少四周各一格、根上有标记、每周 8 格 */
function expectWeekNumbers(): void {
  expect(weekHeader()).toHaveLength(1)
  expect(weekCells().length).toBeGreaterThanOrEqual(4)
  expect(picker()!.getAttribute('data-week-numbers')).toBe('true')
  expect(firstWeekCells()).toBe(8)
}

/** 周数一列不在：三样都没有，星期表头 7 格、每周 7 格 */
function expectNoWeekNumbers(): void {
  expect(picker()).not.toBeNull()
  expect(weekHeader()).toHaveLength(0)
  expect(weekCells()).toHaveLength(0)
  expect(picker()!.getAttribute('data-week-numbers')).not.toBe('true')
  expect(container.querySelectorAll('th.rdp-weekday')).toHaveLength(7)
  expect(firstWeekCells()).toBe(7)
}

const FADED_CLASSES = ['opacity-30', 'hover:opacity-100', 'focus-within:opacity-100']

/** 三个淡化类：全在 → 'faded'，全不在 → 'none'，只在一部分 → 'partial'（不该出现） */
function fadeOf(el: Element): 'faded' | 'none' | 'partial' {
  const classes = el.className.split(/\s+/)
  const present = FADED_CLASSES.filter((c) => classes.includes(c)).length
  return present === FADED_CLASSES.length ? 'faded' : present === 0 ? 'none' : 'partial'
}

const grid = (): HTMLElement => container.querySelector<HTMLElement>('[data-calendar-grid]')!
const emptyHint = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-calendar-empty]')

/** el 自己与祖先（直到并包括滚动容器）都不带 opacity-30 */
function expectNoFadedAncestor(el: Element): void {
  let node: Element | null = el
  while (node && node !== container) {
    expect(node.className.split(/\s+/)).not.toContain('opacity-30')
    if (node.classList.contains('overflow-y-auto')) return
    node = node.parentElement
  }
  throw new Error('没走到滚动容器')
}

function session(id: string): Session {
  return {
    id,
    title: `Title ${id}`,
    projectId: null,
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    settings: {}
  } as unknown as Session
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('CalendarView 的周数一列（hideWeekNumber）', () => {
  it('CV-1 缺省、宽 300：有周数一列', () => {
    mount()
    expectWeekNumbers()
    expect(container.querySelectorAll('th.rdp-weekday')).toHaveLength(7)
  })

  it('CV-2 hideWeekNumber、宽 300：没有周数一列；星期 7 格、一周 7 格', () => {
    mount({ hideWeekNumber: true })
    expectNoWeekNumbers()
  })

  it('CV-3 桌面按宽度定的规则不变：239 没有，240 有', () => {
    mount({ width: 239 })
    expectNoWeekNumbers()
    mount({ width: 240 })
    expectWeekNumbers()
  })

  it('CV-4 hideWeekNumber: false 与不传一样', () => {
    mount({ hideWeekNumber: false })
    expectWeekNumbers()
  })

  it('CV-5 hideWeekNumber + 宽 200：没有，不抛', () => {
    expect(() => mount({ hideWeekNumber: true, width: 200 })).not.toThrow()
    expectNoWeekNumbers()
  })
})

describe('CalendarView 的其余部分不随 hideWeekNumber 变', () => {
  it.each([true, false])('CV-6 dayHeader 照画（hideWeekNumber=%s）', (hideWeekNumber) => {
    mount({
      hideWeekNumber,
      dayHeader: createElement('div', { 'data-test-day-header': '' }, 'header here')
    })
    expect(container.querySelector('[data-test-day-header]')!.textContent).toBe('header here')
  })

  it.each([true, false])(
    'CV-6 当天没有会话：那句话，不调渲染函数（hideWeekNumber=%s）',
    (hideWeekNumber) => {
      const render = vi.fn(() => null)
      mount({ hideWeekNumber, daySessions: [], renderGroupedSessionsForDay: render })
      expect(container.textContent).toContain(en.sidebar.noSessionsOnDay)
      expect(render).not.toHaveBeenCalled()
    }
  )

  it.each([true, false])(
    'CV-6 当天有会话：调渲染函数、画它给的，没有那句话（hideWeekNumber=%s）',
    (hideWeekNumber) => {
      const list = [session('s1')]
      const render = vi.fn((sessions: Session[]) =>
        createElement('div', { 'data-test-list': '' }, sessions.map((s) => s.id).join(','))
      )
      mount({ hideWeekNumber, daySessions: list, renderGroupedSessionsForDay: render })
      expect(render).toHaveBeenCalled()
      for (const call of render.mock.calls) expect(call[0]).toBe(list)
      expect(container.querySelector('[data-test-list]')!.textContent).toBe('s1')
      expect(container.textContent).not.toContain(en.sidebar.noSessionsOnDay)
    }
  )

  it.each([true, false])('CV-7 圆点不变（hideWeekNumber=%s）', (hideWeekNumber) => {
    mount({
      hideWeekNumber,
      daysWithSessions: [new Date(2025, 2, 10)],
      daysWithReports: [new Date(2025, 2, 11)]
    })
    expect(dayCell('2025-03-10').classList.contains('rdp-has-sessions')).toBe(true)
    expect(dayCell('2025-03-10').classList.contains('rdp-has-report')).toBe(false)
    expect(dayCell('2025-03-11').classList.contains('rdp-has-report')).toBe(true)
    expect(dayCell('2025-03-11').classList.contains('rdp-has-sessions')).toBe(false)
    expect(dayCell('2025-03-12').classList.contains('rdp-has-sessions')).toBe(false)
    expect(dayCell('2025-03-12').classList.contains('rdp-has-report')).toBe(false)
  })

  it.each([true, false])('CV-8 点一格 → onSelect(那天)（hideWeekNumber=%s）', (hideWeekNumber) => {
    const onSelect = vi.fn<(date: Date) => void>()
    mount({ hideWeekNumber, onSelect })
    const button = dayCell('2025-03-10').querySelector('button')!
    act(() => button.click())
    expect(onSelect).toHaveBeenCalledTimes(1)
    const picked = onSelect.mock.calls[0][0]
    expect([picked.getFullYear(), picked.getMonth(), picked.getDate()]).toEqual([2025, 2, 10])
  })

  it.each([true, false])(
    'CV-8 「今天」→ onSelect 与 onMonthChange 都拿到今天（hideWeekNumber=%s）',
    (hideWeekNumber) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(2025, 5, 18, 15, 30, 0))
      const onSelect = vi.fn<(date: Date) => void>()
      const onMonthChange = vi.fn<(date: Date) => void>()
      mount({ hideWeekNumber, onSelect, onMonthChange })
      const today = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => (b.textContent ?? '').trim() === en.sidebar.today
      )!
      act(() => today.click())
      const ymd = (d: Date): number[] => [d.getFullYear(), d.getMonth(), d.getDate()]
      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(ymd(onSelect.mock.calls[0][0])).toEqual([2025, 5, 18])
      // 月历自己翻到这个月时还会再报一次月份：第一次是「今天」这颗按钮给的那一天
      expect(onMonthChange).toHaveBeenCalled()
      expect(ymd(onMonthChange.mock.calls[0][0])).toEqual([2025, 5, 18])
    }
  )

  it.each([true, false])('CV-9 拖动侧栏时不画月历（hideWeekNumber=%s）', (hideWeekNumber) => {
    mount({ hideWeekNumber, isResizing: true })
    expect(picker()).toBeNull()
    expect(container.querySelector('td[data-day]')).toBeNull()
    // 列表那一半照常
    expect(container.textContent).toContain(en.sidebar.noSessionsOnDay)
  })
})

describe('CalendarView 的专注模式淡化（dim）', () => {
  it('CV-10 不传 dim、没有会话：月历与那句话都不淡', () => {
    mount()
    expect(grid()).not.toBeNull()
    expect(emptyHint()).not.toBeNull()
    expect(fadeOf(grid())).toBe('none')
    expect(fadeOf(emptyHint()!)).toBe('none')
    // 过渡类常在，不算淡
    expect(grid().className.split(/\s+/)).toContain('transition-opacity')
  })

  it('CV-11 dim: false 与不传一样', () => {
    mount({ dim: false })
    expect(fadeOf(grid())).toBe('none')
    expect(fadeOf(emptyHint()!)).toBe('none')
  })

  it('CV-12 dim: true、没有会话：月历与那句话都淡', () => {
    mount({ dim: true })
    expect(fadeOf(grid())).toBe('faded')
    expect(fadeOf(emptyHint()!)).toBe('faded')
    expect(grid().querySelector('.rdp-root')).not.toBeNull()
  })

  it('CV-13 dim: true、有会话：月历淡；会话列表与 dayHeader 不被外层淡', () => {
    mount({
      dim: true,
      daySessions: [session('s1')],
      dayHeader: createElement('div', { 'data-test-day-header': '' }, 'header'),
      renderGroupedSessionsForDay: () => createElement('div', { 'data-test-list': '' }, 'list')
    })
    expect(fadeOf(grid())).toBe('faded')
    expect(emptyHint()).toBeNull()
    expectNoFadedAncestor(container.querySelector('[data-test-list]')!)
    expectNoFadedAncestor(container.querySelector('[data-test-day-header]')!)
  })

  it('CV-14 dim: true 拖动侧栏：占位期间外层照淡，拖完月历回来仍淡', () => {
    mount({ dim: true, isResizing: true })
    expect(picker()).toBeNull()
    expect(grid()).not.toBeNull()
    expect(fadeOf(grid())).toBe('faded')
    expect(grid().querySelector('[aria-hidden]')).not.toBeNull()
    mount({ dim: true, isResizing: false })
    expect(picker()).not.toBeNull()
    expect(fadeOf(grid())).toBe('faded')
  })

  it('CV-15 dim true → false 重渲染：淡去掉', () => {
    mount({ dim: true })
    expect(fadeOf(grid())).toBe('faded')
    mount({ dim: false })
    expect(fadeOf(grid())).toBe('none')
    expect(fadeOf(emptyHint()!)).toBe('none')
  })
})
