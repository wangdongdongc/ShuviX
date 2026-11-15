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
 *
 * 卡片的样子（`card`，手机布局的日历，2026-11-15）：
 *
 *   DC-1  写了：一张卡片里的一行 ——「日记」+ 正文开头的一句 + 箭头；没有文件名、没有新建那一行
 *   DC-2  摘录为空：行里只有「日记」
 *   DC-3  点它 / 回车 / 空格都打开（空格不滚页面）；别的键不算
 *   DC-4  长按菜单：在文件夹中显示 / 复制路径 | 删除日报；不打开日报
 *   DC-5  菜单动作：定位文件、复制路径、删除先确认（确认才调，取消不调）
 *   DC-6  宿主没给 onRevealFile / onDelete：菜单只有复制路径
 *   DC-7  没有日报、能写：一行看得见的「写这一天的日记」，点它打开
 *   DC-8  没有日报、未来的日子：两种行都没有，也没有空卡片
 *   DC-9  还没查到：两种行都没有，也没有空卡片
 *   DC-10 日期那一行四种状态下都在，在卡片外面，不是 .sb-section
 *   DC-11 不能写的日子（未来）但已有日报：照样是日报行，没有新建那一行
 *   DC-12 active 不画选中态
 *   DC-13 卡片的行里没有 ⋮
 *   DC-14 `card: false` 与不传一样：桌面那一行（文件名 + 小签 + ⋮，新建是无字图标）
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { ContextMenuProvider } from '../contextmenu/ContextMenuProvider'
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

// ─────────────────────────── 卡片的样子（手机布局的日历） ───────────────────────────

const DATE_LABEL = DAY.toLocaleDateString('en', { month: 'long', day: 'numeric', weekday: 'short' })
const REPORT = { excerpt: 'Fixed the dots', path: PATH }

/** 每次弹出的菜单项 */
let menus: ContextMenuItem[][] = []
/** 「用户」下一次点的那一项（null = 取消） */
let nextPick: string | null = null

/** 带菜单宿主挂载：菜单项记进 `menus`，按 `nextPick` 回一项 */
function mountWithMenu(props: Partial<DayReportHeaderProps>): void {
  type ProviderProps = ComponentProps<typeof ContextMenuProvider>
  const provider: Omit<ProviderProps, 'children'> = {
    render: async (items: ContextMenuItem[]) => {
      menus.push(items)
      const pick = nextPick
      nextPick = null
      return pick
    }
  }
  act(() =>
    root.render(
      createElement(
        ContextMenuProvider,
        provider as ProviderProps,
        createElement(DayReportHeader, {
          day: DAY,
          report: null,
          writable: true,
          onOpen: () => {},
          ...props
        })
      )
    )
  )
}

const header = (): HTMLElement => container.querySelector<HTMLElement>('[data-day-report-header]')!
const moreButton = (): Element | null =>
  container.querySelector(`button[aria-label="${en.sidebar.moreActions}"]`)
const buttonByText = (text: string): HTMLButtonElement | null =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').trim() === text
  ) ?? null

/** 长按 / 右键那一行，等菜单的回调跑完 */
async function longPress(el: Element, pick: string | null = null): Promise<void> {
  nextPick = pick
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function keyDown(el: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => {
    el.dispatchEvent(event)
  })
  return event
}

describe('DayReportHeader 卡片的样子（card）', () => {
  beforeEach(() => {
    menus = []
    nextPick = null
  })

  it('DC-1 写了：卡片里一行 = 「日记」+ 摘录 + 箭头；没有文件名、没有新建那一行', () => {
    mount({ card: true, report: REPORT })
    const rootEl = header()
    expect(rootEl.hasAttribute('data-day-report-card')).toBe(true)
    expect(container.querySelectorAll('[data-daily-report]')).toHaveLength(1)
    const row = reportRow()!
    expect(row.getAttribute('role')).toBe('button')
    expect(row.tabIndex).toBe(0)
    expect(row.title).toBe(en.daily.open)
    expect(row.querySelector('[data-daily-tag]')!.textContent).toBe(en.daily.tag)
    expect(row.querySelector('[data-daily-excerpt]')!.textContent).toBe('Fixed the dots')
    expect(row.querySelector('svg[class*="lucide-chevron-right"]')).not.toBeNull()
    expect(container.querySelector('[data-daily-file]')).toBeNull()
    expect(container.textContent).not.toContain('2025-03-14.md')
    expect(writeButton()).toBeNull()
  })

  it('DC-2 摘录为空：没有摘录那一行，行里只有「日记」', () => {
    mount({ card: true, report: { excerpt: '', path: PATH } })
    expect(container.querySelector('[data-daily-excerpt]')).toBeNull()
    expect(reportRow()!.textContent).toBe(en.daily.tag)
  })

  it('DC-3 点它 / 回车 / 空格都打开（空格 preventDefault）；别的键不算', () => {
    const onOpen = vi.fn()
    mount({ card: true, report: REPORT, onOpen })
    const row = reportRow()!
    act(() => row.click())
    expect(onOpen).toHaveBeenCalledTimes(1)
    keyDown(row, 'Enter')
    expect(onOpen).toHaveBeenCalledTimes(2)
    const space = keyDown(row, ' ')
    expect(onOpen).toHaveBeenCalledTimes(3)
    expect(space.defaultPrevented).toBe(true)
    expect(keyDown(row, 'a').defaultPrevented).toBe(false)
    expect(keyDown(row, 'Tab').defaultPrevented).toBe(false)
    expect(onOpen).toHaveBeenCalledTimes(3)
  })

  it('DC-4 长按菜单：在文件夹中显示 / 复制路径 | 删除日报；不打开日报', async () => {
    const onOpen = vi.fn()
    mountWithMenu({
      card: true,
      report: REPORT,
      onOpen,
      onRevealFile: () => {},
      onDelete: () => {}
    })
    await longPress(reportRow()!)
    expect(menus).toHaveLength(1)
    expect(menus[0]).toEqual([
      { id: 'reveal', label: en.daily.revealFile },
      { id: 'copy-path', label: en.daily.copyPath },
      { type: 'separator' },
      { id: 'delete', label: en.daily.delete }
    ])
    expect(onOpen).not.toHaveBeenCalled()
  })

  describe('DC-5 菜单动作', () => {
    it('DC-5 reveal → onRevealFile(路径)', async () => {
      const onRevealFile = vi.fn()
      const onDelete = vi.fn()
      mountWithMenu({ card: true, report: REPORT, onRevealFile, onDelete })
      await longPress(reportRow()!, 'reveal')
      expect(onRevealFile.mock.calls).toEqual([[PATH]])
      expect(onDelete).not.toHaveBeenCalled()
    })

    it('DC-5 copy-path → 剪贴板拿到路径', async () => {
      const writeText = vi.fn(async (_text: string) => {})
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText }
      })
      try {
        const onRevealFile = vi.fn()
        mountWithMenu({ card: true, report: REPORT, onRevealFile, onDelete: () => {} })
        await longPress(reportRow()!, 'copy-path')
        expect(writeText.mock.calls).toEqual([[PATH]])
        expect(onRevealFile).not.toHaveBeenCalled()
      } finally {
        delete (navigator as unknown as { clipboard?: unknown }).clipboard
      }
    })

    it('DC-5 delete → 先确认：确认才调 onDelete，框收掉', async () => {
      const onDelete = vi.fn()
      mountWithMenu({ card: true, report: REPORT, onRevealFile: () => {}, onDelete })
      await longPress(reportRow()!, 'delete')
      expect(onDelete).not.toHaveBeenCalled()
      expect(container.textContent).toContain(en.daily.confirmDeleteTitle)
      expect(container.textContent).toContain(
        i18n.t('daily.confirmDeleteDescription', { day: DATE_LABEL })
      )
      expect(container.textContent).toContain(DATE_LABEL)
      const confirm = buttonByText(en.common.delete)!
      act(() => confirm.click())
      expect(onDelete).toHaveBeenCalledTimes(1)
      expect(container.textContent).not.toContain(en.daily.confirmDeleteTitle)
      expect(buttonByText(en.common.delete)).toBeNull()
    })

    it('DC-5 delete → 取消：不调 onDelete，框收掉', async () => {
      const onDelete = vi.fn()
      mountWithMenu({ card: true, report: REPORT, onRevealFile: () => {}, onDelete })
      await longPress(reportRow()!, 'delete')
      const cancel = buttonByText(en.common.cancel)!
      act(() => cancel.click())
      // 关闭有一段退出动画，之后才真的卸掉
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
      })
      expect(onDelete).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain(en.daily.confirmDeleteTitle)
      expect(reportRow()).not.toBeNull()
    })
  })

  it('DC-6 宿主没给 onRevealFile / onDelete：菜单只有复制路径', async () => {
    mountWithMenu({ card: true, report: REPORT })
    await longPress(reportRow()!)
    expect(menus).toEqual([[{ id: 'copy-path', label: en.daily.copyPath }]])
  })

  it('DC-7 没有日报、能写：一行看得见的「写这一天的日记」，点它打开', () => {
    const onOpen = vi.fn()
    mount({ card: true, report: null, writable: true, onOpen })
    const buttons = container.querySelectorAll<HTMLButtonElement>('button[data-daily-write]')
    expect(buttons).toHaveLength(1)
    expect((buttons[0].textContent ?? '').trim()).toBe(en.mobile.writeDiary)
    expect(reportRow()).toBeNull()
    act(() => buttons[0].click())
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('DC-8 没有日报、未来的日子：两种行都没有，也没有空卡片', () => {
    mount({ card: true, report: null, writable: false })
    expect(writeButton()).toBeNull()
    expect(reportRow()).toBeNull()
    expect(header().querySelector('.rounded-xl')).toBeNull()
  })

  it('DC-9 还没查到：两种行都没有，也没有空卡片', () => {
    mount({ card: true, report: undefined, writable: true })
    expect(writeButton()).toBeNull()
    expect(reportRow()).toBeNull()
    expect(header().querySelector('.rounded-xl')).toBeNull()
  })

  it.each<[string, Partial<DayReportHeaderProps>]>([
    ['写了', { report: REPORT, writable: true }],
    ['没有、能写', { report: null, writable: true }],
    ['没有、未来', { report: null, writable: false }],
    ['还没查到', { report: undefined, writable: true }]
  ])('DC-10 日期那一行总在，在卡片外面，不是 .sb-section（%s）', (_label, props) => {
    mount({ card: true, ...props })
    expect(header().textContent).toContain(DATE_LABEL)
    for (const cardEl of header().querySelectorAll('.rounded-xl')) {
      expect(cardEl.textContent).not.toContain(DATE_LABEL)
    }
    expect(header().querySelector('.sb-section')).toBeNull()
  })

  it('DC-11 不能写的日子但已有日报：照样是日报行，没有新建那一行', () => {
    mount({ card: true, report: REPORT, writable: false })
    expect(reportRow()).not.toBeNull()
    expect(reportRow()!.querySelector('[data-daily-excerpt]')!.textContent).toBe('Fixed the dots')
    expect(writeButton()).toBeNull()
  })

  it('DC-12 active 不画选中态', () => {
    mount({ card: true, report: REPORT, active: true })
    expect(reportRow()!.className.split(/\s+/)).not.toContain('bg-bg-active')
    expect(reportRow()!.className).not.toContain('bg-bg-active')
  })

  it('DC-13 卡片的行里没有 ⋮', () => {
    mountWithMenu({ card: true, report: REPORT, onRevealFile: () => {}, onDelete: () => {} })
    expect(moreButton()).toBeNull()
    expect(reportRow()!.querySelector('button')).toBeNull()
  })

  it.each<[string, Partial<DayReportHeaderProps>]>([
    ['card: false', { card: false }],
    ['不传', {}]
  ])('DC-14 桌面不变（%s）：文件名 + 小签 + ⋮，新建是无字图标', (_label, props) => {
    mount({ ...props, report: REPORT })
    expect(container.querySelector('[data-day-report-card]')).toBeNull()
    expect(header()).not.toBeNull()
    expect(container.querySelector('[data-daily-excerpt]')).toBeNull()
    expect(container.querySelector('[data-daily-file]')!.textContent).toBe('2025-03-14.md')
    expect(moreButton()).not.toBeNull()
    expect(header().querySelector('.sb-section')).not.toBeNull()

    mount({ ...props, report: null, writable: true })
    expect(container.querySelector('[data-day-report-card]')).toBeNull()
    const button = writeButton()!
    expect(button.textContent).toBe('')
    expect(button.getAttribute('aria-label')).toBe(en.daily.write)
  })
})
