// @vitest-environment jsdom
/**
 * 日历当天列表的头（DayReportHeader，jsdom）—— 日期 + 那天的日报。
 *
 *   DR-1 没有日报、能写：日期行尾一颗「新建」图标（无文字，aria-label / title 是说明）；点它 → onOpen 一次
 *   DR-2 没有日报、未来的日子：没有图标
 *   DR-3 还没查到（undefined）：既没有图标也没有日报行 —— 不先闪一颗图标再变成日报行
 *   DR-4 写了：日期下一行 = 文件名 + 「日记」小签，单行（不放正文摘录），没有新建图标；点它 / 回车 → onOpen
 *   DR-5 只有模板、Windows 路径：照样是文件名 + 小签
 *   DR-6 主区开着的正是这份日报：行按选中态画
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { DayReportHeader, type DayReportHeaderProps } from './DayReportHeader'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const DAY = new Date(2025, 2, 14)
const PATH = '/home/u/.shuvix/daily/2025-03-14.md'

let container: HTMLDivElement
let root: Root

function mount(props: Partial<DayReportHeaderProps>): void {
  act(() =>
    root.render(
      createElement(DayReportHeader, {
        day: DAY,
        report: null,
        writable: true,
        onOpen: () => {},
        ...props
      })
    )
  )
}

const writeButton = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('[data-daily-write]')
const reportRow = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-daily-report]')

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
})

describe('DayReportHeader', () => {
  it('DR-1 没有日报、能写：一颗无文字的新建图标，点它打开', () => {
    const onOpen = vi.fn()
    mount({ report: null, writable: true, onOpen })
    const button = writeButton()
    expect(button).not.toBeNull()
    expect(button!.textContent).toBe('')
    expect(button!.getAttribute('aria-label')).toBe(en.daily.write)
    expect(button!.title).toBe(en.daily.write)
    expect(reportRow()).toBeNull()
    // 日期本身在行里（图标靠它说明是哪一天）
    expect(container.textContent).toContain(
      DAY.toLocaleDateString('en', { month: 'long', day: 'numeric', weekday: 'short' })
    )
    act(() => button!.click())
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('DR-2 未来的日子：没有图标', () => {
    mount({ report: null, writable: false })
    expect(writeButton()).toBeNull()
    expect(reportRow()).toBeNull()
  })

  it('DR-3 还没查到：既没有图标也没有日报行', () => {
    mount({ report: undefined })
    expect(writeButton()).toBeNull()
    expect(reportRow()).toBeNull()
  })

  it('DR-4 写了：一行 = 文件名 + 「日记」小签（不放正文摘录）、没有新建图标；点它 / 回车都打开', () => {
    const onOpen = vi.fn()
    mount({ report: { excerpt: '修好了圆点 · 写测试', path: PATH }, onOpen })
    expect(writeButton()).toBeNull()
    const row = reportRow()!
    expect(row.querySelector('[data-daily-file]')!.textContent).toBe('2025-03-14.md')
    expect(row.querySelector('[data-daily-tag]')!.textContent).toBe(en.daily.tag)
    expect(row.textContent).not.toContain('修好了圆点')
    expect(row.className).not.toContain('sb-row-wrap')
    expect(row.title).toBe(en.daily.open)
    act(() => row.click())
    act(() => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it('DR-5 只有模板 / Windows 路径：照样是文件名 + 小签', () => {
    mount({ report: { excerpt: '', path: 'C:\\Users\\u\\.shuvix\\daily\\2025-03-14.md' } })
    expect(reportRow()!.textContent).toBe(`2025-03-14.md${en.daily.tag}`)
  })

  it('DR-6 主区开着的正是这份日报：行按选中态画', () => {
    mount({ report: { excerpt: 'x', path: PATH }, active: true })
    expect(reportRow()!.className).toContain('bg-bg-active')
    mount({ report: { excerpt: 'x', path: PATH }, active: false })
    expect(reportRow()!.className).not.toContain('bg-bg-active')
  })
})
