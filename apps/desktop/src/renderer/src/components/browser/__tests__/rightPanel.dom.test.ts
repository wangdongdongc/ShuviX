// @vitest-environment jsdom
/**
 * 桌面右侧面板（components/browser/RightPanel.tsx，jsdom）—— 三个标签：小组件、智能体、文件（文件时间线，2026-11-18；
 * 收件箱与日历 2026-11-16 搬去了左侧栏，是那里的两种视图；见 sidebarModes 的 DS-V）：
 *
 *   RP-1 标签依次是 widget / agents / library，文字是 `panel.widget` / `panel.agents` / `library.tab`
 *   RP-2 widget 标签的数字 = 组件数；agents、library 没有数字；谁都不带琥珀点
 *   RP-3 持久化里留着已移除的标签（inbox / calendar / files / preview / 认不得的）→ 落到 widget，一次
 *        （文件那一页的键是 library，'files' 仍不是标签）
 *   RP-4 还在的标签不动
 *   RP-5 内容区是三块常驻的面板：小组件、智能体、文件；收件箱 / 日历不在这里
 *   RP-6 没开着的那些 visibility hidden + pointer-events none
 *   RP-7 WidgetPanel 不带 `mobile`（手机那一副只由手机壳给；原 WD-10）
 *   RP-8 标签栏的 onSelect('agents') → setActiveTab('agents')
 *   RP-9 活动标签还是过期的 'inbox' 的那一帧：三块都藏着、不抛
 *   TL-132…134（docs/file-library-timeline-tests.md §11）LibraryTimeline 只在自己那一页开着时 active；它的
 *        onOpenSession 是 chat store 的 setActiveSessionId；持久化的 'library' 不被兜底改掉
 *   RP-10 专注模式不淡、选中 S1：LibraryTimeline 的 `focusSessionId: null`
 *   RP-11 专注模式在淡、选中 S1：`focusSessionId: 'S1'`；onOpenSession 仍是 setActiveSessionId，active 不变
 *   RP-12 专注模式在淡、没有选中的会话：`focusSessionId: null`
 *   RP-13 专注模式在淡、选中从 S1 换成 S2：`focusSessionId` 跟着变成 'S2'
 *
 * `@shuvix/app-shell` 整份换成只有 PanelTabBar 与 LibraryTimeline 的替身 —— 面板要是还去拿 InboxPanel /
 * useInboxSections，vitest 的替身模块会在取不存在的导出时抛错，用例就红；`@shuvix/chat-ui` 只有 useChatStore
 * （面板只从它取 setActiveSessionId）；日历面板、跟踪项 adapter 都不 mock：右侧面板不该再引它们
 * （引了就会加载真模块）。右侧面板的 store、组件 store、两块面板换成替身。i18n 走真 en 资源。
 * 桌面 vitest 对渲染层只收 `*.test.ts`（本文件自己切 jsdom），一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

type Props = Record<string, unknown>

const rec = vi.hoisted(() => ({
  tabBar: [] as Props[],
  widgetPanel: [] as Props[],
  agentsPanel: [] as Props[],
  libraryPanel: [] as Props[],
  /** chat store 的 setActiveSessionId */
  openSession: null as unknown as Mock<(id: string | null) => void>,
  panel: {
    activeTab: 'widget' as string,
    setActiveTab: null as unknown as Mock<(tab: string) => void>,
    width: 360
  },
  widgets: [] as unknown[],
  /** useFocusDim 替身交回的值 */
  focusDim: { focusMode: false, dim: false },
  /** chat store 的 activeSessionId */
  activeSessionId: null as string | null
}))

vi.mock('@shuvix/app-shell', async () => {
  const { createElement: h } = await import('react')
  return {
    PanelTabBar: (props: Props) => {
      rec.tabBar.push(props)
      return h('div', { 'data-stub-tab-bar': '' })
    },
    LibraryTimeline: (props: Props) => {
      rec.libraryPanel.push(props)
      return h('div', { 'data-stub-library-panel': '' })
    },
    useFocusDim: () => rec.focusDim
  }
})

vi.mock('@shuvix/chat-ui', () => ({
  useChatStore: (
    selector: (s: { setActiveSessionId: unknown; activeSessionId: string | null }) => unknown
  ) => selector({ setActiveSessionId: rec.openSession, activeSessionId: rec.activeSessionId })
}))

vi.mock('../../../stores/browserStore', () => ({
  useBrowserStore: (selector: (s: typeof rec.panel) => unknown) => selector(rec.panel)
}))
vi.mock('../../../stores/widgetStore', () => ({
  useWidgetStore: (selector: (s: { widgets: unknown[] }) => unknown) =>
    selector({ widgets: rec.widgets })
}))
vi.mock('../WidgetPanel', async () => {
  const { createElement: h } = await import('react')
  return {
    WidgetPanel: (props: Props) => {
      rec.widgetPanel.push(props)
      return h('div', { 'data-stub-widget-panel': '' })
    }
  }
})
vi.mock('../AgentMonitorPanel', async () => {
  const { createElement: h } = await import('react')
  return {
    AgentMonitorPanel: (props: Props) => {
      rec.agentsPanel.push(props)
      return h('div', { 'data-stub-agents-panel': '' })
    }
  }
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
  rec.widgetPanel.length = 0
  rec.agentsPanel.length = 0
  rec.libraryPanel.length = 0
  rec.openSession = vi.fn()
  rec.panel.activeTab = 'widget'
  rec.panel.setActiveTab = vi.fn()
  rec.widgets = []
  rec.focusDim = { focusMode: false, dim: false }
  rec.activeSessionId = null
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
/** 某块面板替身的外层（各面板共存、按 visibility 切换的那一层） */
const wrapperOf = (name: 'widget' | 'agents' | 'library'): HTMLElement => {
  const stub = container.querySelector<HTMLElement>(`[data-stub-${name}-panel]`)
  if (!stub) throw new Error(`${name} panel not mounted`)
  const wrapper = stub.parentElement!
  // 外层带着自己的名字（e2e 的页面对象按它找面板）
  expect(wrapper.getAttribute('data-right-panel-pane')).toBe(name)
  return wrapper
}
const hidden = (el: HTMLElement): boolean =>
  el.style.visibility === 'hidden' && el.style.pointerEvents === 'none'
const shown = (el: HTMLElement): boolean =>
  el.style.visibility === '' && el.style.pointerEvents === ''

describe('the right panel tabs', () => {
  it('RP-1 widget, agents, library — and nothing else', () => {
    render()
    expect(lastTabs().map((t) => t.key)).toEqual(['widget', 'agents', 'library'])
    expect(lastTabs().map((t) => t.label)).toEqual([
      en.panel.widget,
      en.panel.agents,
      en.library.tab
    ])
  })

  it.each([[0], [3]])('RP-2 the widget badge is the widget count (%i); no alert anywhere', (n) => {
    rec.widgets = filled(n)
    render()
    expect(tabOf('widget').badge).toBe(n)
    expect(tabOf('agents').badge).toBeUndefined()
    expect(tabOf('library').badge).toBeUndefined()
    expect(lastTabs()).toHaveLength(3)
    for (const tab of lastTabs()) expect(tab.alert).toBeFalsy()
  })

  it.each(['inbox', 'calendar', 'files', 'preview', '', 'nonsense'])(
    'RP-3 a removed or unknown active tab %j → setActiveTab("widget") once',
    (tab) => {
      rec.panel.activeTab = tab
      render()
      expect(rec.panel.setActiveTab.mock.calls).toEqual([['widget']])
    }
  )

  it.each(['widget', 'agents', 'library'])('RP-4 %s → left alone', (tab) => {
    rec.panel.activeTab = tab
    render()
    expect(rec.panel.setActiveTab).not.toHaveBeenCalled()
  })

  it('RP-8 selecting a tab writes the store', () => {
    render()
    const onSelect = rec.tabBar.at(-1)!.onSelect as (key: string) => void
    act(() => onSelect('agents'))
    expect(rec.panel.setActiveTab.mock.calls).toEqual([['agents']])
    expect(rec.tabBar.at(-1)!.activeKey).toBe('widget')
    act(() => onSelect('library'))
    expect(rec.panel.setActiveTab.mock.calls).toEqual([['agents'], ['library']])
  })

  it('TL-134 a persisted "library" tab stays: no fallback write, the tab bar shows it active', () => {
    rec.panel.activeTab = 'library'
    render()
    expect(rec.panel.setActiveTab).not.toHaveBeenCalled()
    expect(rec.tabBar.at(-1)!.activeKey).toBe('library')
  })
})

describe('the right panel content', () => {
  it('RP-5 three always-mounted panels: widgets, agents, library; no inbox, no calendar', () => {
    render()
    const content = wrapperOf('widget').parentElement!
    expect(wrapperOf('agents').parentElement).toBe(content)
    expect(wrapperOf('library').parentElement).toBe(content)
    expect(content.children).toHaveLength(3)
    expect(content.children[0]).toBe(wrapperOf('widget'))
    expect(content.children[1]).toBe(wrapperOf('agents'))
    expect(content.children[2]).toBe(wrapperOf('library'))
    expect(container.querySelector('[data-inbox-panel]')).toBeNull()
    expect(container.querySelector('[data-calendar-panel]')).toBeNull()
  })

  it('RP-6 only the active panel is visible; the agents panel polls only while active', () => {
    rec.panel.activeTab = 'widget'
    render()
    expect(shown(wrapperOf('widget'))).toBe(true)
    expect(hidden(wrapperOf('agents'))).toBe(true)
    expect(hidden(wrapperOf('library'))).toBe(true)
    expect(rec.agentsPanel.at(-1)!.active).toBe(false)

    rec.panel.activeTab = 'agents'
    render()
    expect(hidden(wrapperOf('widget'))).toBe(true)
    expect(shown(wrapperOf('agents'))).toBe(true)
    expect(hidden(wrapperOf('library'))).toBe(true)
    expect(rec.agentsPanel.at(-1)!.active).toBe(true)

    rec.panel.activeTab = 'library'
    render()
    expect(hidden(wrapperOf('widget'))).toBe(true)
    expect(hidden(wrapperOf('agents'))).toBe(true)
    expect(shown(wrapperOf('library'))).toBe(true)
    expect(rec.agentsPanel.at(-1)!.active).toBe(false)
  })

  it.each([
    ['widget', false],
    ['agents', false],
    ['library', true]
  ])('TL-132 active tab %s → LibraryTimeline active = %s', (tab, active) => {
    rec.panel.activeTab = tab
    render()
    expect(rec.libraryPanel.length).toBeGreaterThan(0)
    for (const props of rec.libraryPanel) expect(props.active).toBe(active)
  })

  it('TL-133 the timeline opens a session through the chat store', () => {
    render()
    const onOpenSession = rec.libraryPanel.at(-1)!.onOpenSession as (id: string) => void
    act(() => onOpenSession('S1'))
    expect(rec.openSession.mock.calls).toEqual([['S1']])
  })

  it.each(['widget', 'agents', 'library'])(
    'RP-7 WidgetPanel is rendered with no `mobile` prop (active tab: %s)',
    (tab) => {
      rec.panel.activeTab = tab
      render()
      expect(rec.widgetPanel.length).toBeGreaterThan(0)
      for (const props of rec.widgetPanel) {
        expect('mobile' in props).toBe(false)
        expect(props.mobile).toBeUndefined()
      }
    }
  )

  it('RP-9 a stale "inbox" before the fallback lands: all three panels hidden, nothing throws', () => {
    rec.panel.activeTab = 'inbox'
    expect(() => render()).not.toThrow()
    expect(hidden(wrapperOf('widget'))).toBe(true)
    expect(hidden(wrapperOf('agents'))).toBe(true)
    expect(hidden(wrapperOf('library'))).toBe(true)
    expect(rec.agentsPanel.at(-1)!.active).toBe(false)
    expect(rec.libraryPanel.at(-1)!.active).toBe(false)
  })
})

describe('focus mode in the file timeline', () => {
  it('RP-10 focus mode not dimming, S1 selected: focusSessionId is null', () => {
    rec.activeSessionId = 'S1'
    render()
    expect(rec.libraryPanel.at(-1)!.focusSessionId).toBeNull()
  })

  it('RP-11 focus mode dimming, S1 selected: focusSessionId is S1; opening and active are unchanged', () => {
    rec.focusDim = { focusMode: true, dim: true }
    rec.activeSessionId = 'S1'
    rec.panel.activeTab = 'library'
    render()
    const props = rec.libraryPanel.at(-1)!
    expect(props.focusSessionId).toBe('S1')
    expect(props.onOpenSession).toBe(rec.openSession)
    expect(props.active).toBe(true)
  })

  it('RP-11 the same with the library tab not open: active stays false', () => {
    rec.focusDim = { focusMode: true, dim: true }
    rec.activeSessionId = 'S1'
    render()
    expect(rec.libraryPanel.at(-1)!.focusSessionId).toBe('S1')
    expect(rec.libraryPanel.at(-1)!.active).toBe(false)
  })

  it('RP-12 focus mode dimming, no session selected: focusSessionId is null', () => {
    rec.focusDim = { focusMode: true, dim: true }
    rec.activeSessionId = null
    render()
    expect(rec.libraryPanel.at(-1)!.focusSessionId).toBeNull()
  })

  it('RP-13 focus mode dimming, selection S1 → S2: focusSessionId follows', () => {
    rec.focusDim = { focusMode: true, dim: true }
    rec.activeSessionId = 'S1'
    render()
    expect(rec.libraryPanel.at(-1)!.focusSessionId).toBe('S1')
    rec.activeSessionId = 'S2'
    render()
    expect(rec.libraryPanel.at(-1)!.focusSessionId).toBe('S2')
  })
})
