// @vitest-environment jsdom
/**
 * 右侧面板的标签栏（PanelTabBar，jsdom）—— 收件箱标签上的数字与琥珀点（2026-11-12 起收件箱是第一个标签）：
 *
 *   INT-1 badge > 0 → `data-panel-tab-badge` + 数字；alert → `data-panel-tab-alert` + 琥珀点（aria-hidden），点在数字前；
 *         badge 0、没有 alert → 两个属性、数字、点都没有；每个标签带 `data-panel-tab`，点一下 onSelect 一次
 *
 * 专注模式淡化（useFocusDim）换成替身（它读 chat-ui 的宿主与 store，与这里无关）。jsdom 没有 ResizeObserver，
 * 给一个什么都不做的；量出来的宽度都是 0，所以标签是「图标 + 文字」。文件是 `.ts`，一律 createElement。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CalendarDays, Inbox, Wrench } from 'lucide-react'

vi.mock('../sidebar/useFocusDim', () => ({
  useFocusDim: () => ({ focusMode: false, dim: false })
}))

import { PanelTabBar, type PanelTabItem } from './PanelTabBar'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const realResizeObserver = globalThis.ResizeObserver

beforeAll(() => {
  const noop = (): void => undefined
  globalThis.ResizeObserver = class {
    observe = noop
    unobserve = noop
    disconnect = noop
  } as unknown as typeof ResizeObserver
})

afterAll(() => {
  globalThis.ResizeObserver = realResizeObserver
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

const TABS: PanelTabItem[] = [
  { key: 'inbox', label: 'Inbox', Icon: Inbox, badge: 3, alert: true },
  { key: 'widget', label: 'Widget', Icon: Wrench, badge: 0 },
  { key: 'calendar', label: 'Calendar', Icon: CalendarDays }
]

function tab(key: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`button[data-panel-tab="${key}"]`)
  if (!el) throw new Error(`no tab ${key}`)
  return el
}

describe('INT-1 badge and alert', () => {
  it('INT-1 the inbox tab: alert attribute + amber dot before the count; widget with badge 0: nothing; select by click', () => {
    const onSelect = vi.fn()
    act(() => root.render(createElement(PanelTabBar, { tabs: TABS, activeKey: 'inbox', onSelect })))

    const inbox = tab('inbox')
    expect(inbox.getAttribute('data-panel-tab-alert')).toBe('')
    expect(inbox.getAttribute('data-panel-tab-badge')).toBe('3')
    const dot = inbox.querySelector<HTMLElement>('span.bg-amber-400[aria-hidden="true"]')
    expect(dot).not.toBeNull()
    const count = [...inbox.querySelectorAll('span')].find((el) => el.textContent === '3')
    expect(count).toBeDefined()
    // 点在数字前面（文档次序）
    expect(dot!.compareDocumentPosition(count!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const widget = tab('widget')
    expect(widget.hasAttribute('data-panel-tab-badge')).toBe(false)
    expect(widget.hasAttribute('data-panel-tab-alert')).toBe(false)
    expect(widget.textContent).not.toMatch(/\d/)
    expect(widget.querySelector('.bg-amber-400')).toBeNull()

    const calendar = tab('calendar')
    expect(calendar.hasAttribute('data-panel-tab-badge')).toBe(false)
    expect(calendar.hasAttribute('data-panel-tab-alert')).toBe(false)

    act(() => calendar.click())
    expect(onSelect.mock.calls).toEqual([['calendar']])
  })
})
