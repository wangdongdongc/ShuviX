// @vitest-environment jsdom
/**
 * 桌面右侧面板（components/browser/RightPanel.tsx，jsdom）—— 收件箱是第一个标签（2026-11-12 用户选定 E1）：
 *
 *   INT-2 标签依次是 inbox / widget / calendar / agents，第一个的文字是「收件箱」
 *   INT-3 收件箱标签的数字 = 等你回答 + 新回复（只是在跑的不算），有等你回答的才有琥珀点；widget 标签仍是组件数；
 *         useInboxSections 从不带 held 调（侧栏同一口径：留着的那条不计数）
 *   INT-4 持久化里留着已移除的标签（files / preview）→ 落到 inbox，一次；已有的标签不动
 *   INT-5 收件箱面板常驻挂载：别的标签开着时它的外层 visibility hidden + pointer-events none；tracking 是宿主给的那份
 *
 * `@shuvix/app-shell` 整份换成记 props 的替身（PanelTabBar / InboxPanel / useInboxSections）；右侧面板的 store、
 * 组件 store、跟踪项适配器、三块别的面板与 chat-ui 的 store 都换成替身。i18n 走真 en 资源。
 * 桌面 vitest 对渲染层只收 `*.test.ts`（本文件自己切 jsdom），一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

type Props = Record<string, unknown>
interface Sections {
  waiting: unknown[]
  unread: unknown[]
  running: unknown[]
}

const rec = vi.hoisted(() => ({
  tabBar: [] as Props[],
  inboxPanel: [] as Props[],
  panel: {
    activeTab: 'inbox' as string,
    setActiveTab: null as unknown as Mock<(tab: string) => void>,
    width: 360
  },
  widgets: [] as unknown[],
  sections: { waiting: [], unread: [], running: [] } as Sections,
  useInboxSections: null as unknown as Mock<(held?: unknown) => Sections>,
  tracking: { sentinel: 'tracking-adapter' }
}))

vi.mock('@shuvix/app-shell', async () => {
  const { vi: v } = await import('vitest')
  const { createElement: h } = await import('react')
  rec.useInboxSections = v.fn((_held?: unknown) => rec.sections)
  return {
    PanelTabBar: (props: Props) => {
      rec.tabBar.push(props)
      return h('div', { 'data-stub-tab-bar': '' })
    },
    InboxPanel: (props: Props) => {
      rec.inboxPanel.push(props)
      return h('div', { 'data-stub-inbox-panel': '' })
    },
    useInboxSections: (...args: [unknown?]) => rec.useInboxSections(...args)
  }
})

vi.mock('../../../stores/browserStore', () => ({
  useBrowserStore: (selector: (s: typeof rec.panel) => unknown) => selector(rec.panel)
}))
vi.mock('../../../stores/widgetStore', () => ({
  useWidgetStore: (selector: (s: { widgets: unknown[] }) => unknown) =>
    selector({ widgets: rec.widgets })
}))
vi.mock('../../../host/useTrackingAdapter', () => ({
  useTrackingAdapter: () => rec.tracking
}))
vi.mock('../WidgetPanel', () => ({ WidgetPanel: () => null }))
vi.mock('../CalendarPanel', () => ({ CalendarPanel: () => null }))
vi.mock('../AgentMonitorPanel', () => ({ AgentMonitorPanel: () => null }))
vi.mock('@shuvix/chat-ui', () => {
  const state = { setActiveSessionId: () => {} }
  return { useChatStore: (selector: (s: typeof state) => unknown) => selector(state) }
})

import { RightPanel } from '../RightPanel'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
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
  rec.tabBar.length = 0
  rec.inboxPanel.length = 0
  rec.panel.activeTab = 'inbox'
  rec.panel.setActiveTab = vi.fn()
  rec.widgets = []
  rec.sections = { waiting: [], unread: [], running: [] }
  rec.useInboxSections.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(): void {
  act(() => root.render(createElement(RightPanel)))
}

interface TabItem {
  key: string
  label: string
  badge?: number
  alert?: boolean
}
const lastTabs = (): TabItem[] => rec.tabBar.at(-1)!.tabs as TabItem[]
const tabOf = (key: string): TabItem => lastTabs().find((t) => t.key === key)!
const filled = (n: number): unknown[] => Array.from({ length: n }, (_, i) => ({ i }))
/** 收件箱面板替身的外层（各面板共存、按 visibility 切换的那一层） */
const inboxWrapper = (): HTMLElement => {
  const stub = container.querySelector<HTMLElement>('[data-stub-inbox-panel]')
  if (!stub) throw new Error('inbox panel not mounted')
  return stub.parentElement!
}

describe('INT-2 the tabs', () => {
  it('INT-2 inbox, widget, calendar, agents; the first is labelled Inbox', () => {
    render()
    expect(lastTabs().map((t) => t.key)).toEqual(['inbox', 'widget', 'calendar', 'agents'])
    expect(lastTabs()[0].label).toBe(en.inbox.title)
  })
})

describe('INT-3 the inbox badge', () => {
  it.each<[string, Sections, number, boolean]>([
    [
      'waiting + unread (running ignored)',
      { waiting: filled(2), unread: filled(1), running: filled(5) },
      3,
      true
    ],
    ['unread only', { waiting: [], unread: filled(1), running: filled(4) }, 1, false],
    ['nothing', { waiting: [], unread: [], running: [] }, 0, false]
  ])('INT-3 %s', (_label, sections, badge, alert) => {
    rec.sections = sections
    rec.widgets = filled(4)
    render()
    expect(tabOf('inbox').badge).toBe(badge)
    expect(tabOf('inbox').alert).toBe(alert)
    expect(tabOf('widget').badge).toBe(4)
    expect(rec.useInboxSections).toHaveBeenCalled()
    for (const args of rec.useInboxSections.mock.calls) {
      expect(args[0]).toBeUndefined()
    }
  })
})

describe('INT-4 an unknown active tab falls back to the inbox', () => {
  it.each(['files', 'preview'])('INT-4 %s → setActiveTab("inbox") once', (tab) => {
    rec.panel.activeTab = tab
    render()
    expect(rec.panel.setActiveTab.mock.calls).toEqual([['inbox']])
  })

  it.each(['calendar', 'inbox'])('INT-4 %s → left alone', (tab) => {
    rec.panel.activeTab = tab
    render()
    expect(rec.panel.setActiveTab).not.toHaveBeenCalled()
  })
})

describe('INT-5 the inbox panel stays mounted', () => {
  it('INT-5 widget tab active: the inbox panel is hidden, not unmounted, and gets the tracking adapter', () => {
    rec.panel.activeTab = 'widget'
    render()
    const wrapper = inboxWrapper()
    expect(wrapper.style.visibility).toBe('hidden')
    expect(wrapper.style.pointerEvents).toBe('none')
    expect(rec.inboxPanel.at(-1)!.tracking).toBe(rec.tracking)
  })

  it('INT-5 inbox tab active: no visibility style on its wrapper', () => {
    rec.panel.activeTab = 'inbox'
    render()
    const wrapper = inboxWrapper()
    expect(wrapper.style.visibility).toBe('')
    expect(wrapper.style.pointerEvents).toBe('')
    expect(rec.inboxPanel.at(-1)!.tracking).toBe(rec.tracking)
  })
})
