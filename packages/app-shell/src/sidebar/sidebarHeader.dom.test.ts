// @vitest-environment jsdom
/**
 * 共享侧栏顶上那一行与「别的视图」的插槽（2026-11-16；jsdom）：`header` / `extraViews` / `hideList`。
 *
 * 契约：
 *   - 不给这三样：DOM 与原先一样（macOS + windowDrag 时顶上一条空的拖拽带，别的平台没有），列表多一个
 *     `data-sidebar-list`；
 *   - `header`：总有 `[data-sidebar-header]` 这一行，内容在 `.titlebar-no-drag` 里；只有 macOS + windowDrag
 *     时整行可拖，且不再另画那条空带；专注模式淡化时与底栏一样带淡化的 class；
 *   - `hideList`：列表 `display:none` 但不卸载（同一个节点、里面的组件不重挂），回来时滚动位置写回；
 *   - `extraViews`：画在列表之后、底栏之前，是否可见由宿主自己定。
 *
 * mock 同 sidebarFooter 那份，平台、专注模式、活动会话取自 hoisted 变量。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

const env = vi.hoisted(() => ({
  platform: 'web' as string,
  focusMode: false,
  activeSessionId: null as string | null
}))

vi.mock('@shuvix/chat-ui', () => ({
  getChatApi: () => ({
    app: {
      platform: env.platform,
      onNewChat: () => () => undefined,
      onNewProject: () => () => undefined
    },
    session: { create: vi.fn(), list: vi.fn() }
  }),
  useChatStore: Object.assign(
    (selector: (s: { sessions: never[]; activeSessionId: string | null }) => unknown) =>
      selector({ sessions: [], activeSessionId: env.activeSessionId }),
    { getState: () => ({ setSessions: vi.fn(), setActiveSessionId: vi.fn() }) }
  ),
  useChatHost: () => ({ appearance: { focusMode: env.focusMode } })
}))
vi.mock('./ProjectSessionGroups', () => ({
  ProjectSessionGroups: () => null,
  TEMP_GROUP_KEY: '__temp__'
}))

import { Sidebar, type SidebarProps } from './Sidebar'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(props: Partial<SidebarProps> = {}): void {
  act(() =>
    root.render(
      createElement(Sidebar, {
        projects: [],
        onOpenFolder: () => {},
        onOpenSettings: () => {},
        ...props
      })
    )
  )
}

const q = (sel: string): HTMLElement | null => container.querySelector(sel)
const sidebarRoot = (): HTMLElement => container.firstElementChild as HTMLElement
const kids = (): HTMLElement[] => Array.from(sidebarRoot().children) as HTMLElement[]
const list = (): HTMLElement => q('[data-sidebar-list]') as HTMLElement
const footer = (): HTMLElement =>
  (q('[data-sidebar-settings]') as HTMLElement).parentElement as HTMLElement
const headerNode = (): React.ReactElement => createElement('span', { 'data-my-header': '' })
const extraNode = (): React.ReactElement => createElement('div', { 'data-my-extra': '' })

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  env.platform = 'web'
  env.focusMode = false
  env.activeSessionId = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('shared Sidebar: without the new props', () => {
  it('SH-1 web: no header row; list then footer', () => {
    render()
    expect(q('[data-sidebar-header]')).toBeNull()
    expect(list().style.display).toBe('')
    expect(kids()).toEqual([list(), footer()])
  })

  it('SH-2 darwin + windowDrag: the empty drag strip comes first', () => {
    env.platform = 'darwin'
    render({ caps: { windowDrag: true } })
    expect(q('[data-sidebar-header]')).toBeNull()
    const strip = kids()[0]
    expect(strip.classList.contains('titlebar-drag')).toBe(true)
    expect(strip.children.length).toBe(0)
    expect(kids()[1]).toBe(list())
  })

  it('SH-3 darwin without windowDrag: no strip, no header', () => {
    env.platform = 'darwin'
    render()
    expect(q('[data-sidebar-header]')).toBeNull()
    expect(q('.titlebar-drag')).toBeNull()
    expect(kids()[0]).toBe(list())
  })

  it.each([[null], [undefined], [false]])('SH-8 header %s is no header', (header) => {
    render({ header })
    expect(q('[data-sidebar-header]')).toBeNull()
    expect(kids()).toEqual([list(), footer()])
    act(() => root.unmount())
    root = createRoot(container)
    env.platform = 'darwin'
    render({ header, caps: { windowDrag: true } })
    expect(q('[data-sidebar-header]')).toBeNull()
    expect(container.querySelectorAll('.titlebar-drag').length).toBe(1)
    expect(kids()[0].children.length).toBe(0)
  })

  it('SH-11 hideList omitted: no inline style at all', () => {
    render()
    expect(list().getAttribute('style')).toBeNull()
  })

  it('SH-13 extraViews omitted: nothing between list and footer', () => {
    render()
    expect(list().nextElementSibling).toBe(footer())
  })

  it('SH-17 density="touch" without the new props: as before', () => {
    render({ density: 'touch', hideFooter: true })
    expect(sidebarRoot().getAttribute('data-sidebar-density')).toBe('touch')
    expect(kids()).toEqual([list()])
    expect(Array.from(list().attributes).map((a) => a.name)).toEqual(['data-sidebar-list', 'class'])
    expect(list().classList.contains('px-3')).toBe(true)
  })
})

describe('shared Sidebar: header', () => {
  it('SH-4 web: the row is first, content in a no-drag box, row not draggable', () => {
    render({ header: headerNode() })
    const row = q('[data-sidebar-header]')!
    expect(kids()[0]).toBe(row)
    const box = row.querySelector('.titlebar-no-drag')!
    expect(box.querySelector('[data-my-header]')).not.toBeNull()
    expect(row.classList.contains('titlebar-drag')).toBe(false)
  })

  it('SH-5 darwin + windowDrag: the row is the drag strip (exactly one)', () => {
    env.platform = 'darwin'
    render({ header: headerNode(), caps: { windowDrag: true } })
    const row = q('[data-sidebar-header]')!
    expect(row.classList.contains('titlebar-drag')).toBe(true)
    expect(row.querySelector('.titlebar-no-drag [data-my-header]')).not.toBeNull()
    expect(container.querySelectorAll('.titlebar-drag').length).toBe(1)
    expect(kids()[1]).toBe(list())
  })

  it('SH-6 darwin without windowDrag: row present, not draggable', () => {
    env.platform = 'darwin'
    render({ header: headerNode() })
    expect(q('[data-sidebar-header]')).not.toBeNull()
    expect(q('.titlebar-drag')).toBeNull()
  })

  it.each([['win32'], ['linux']])('SH-7 %s with windowDrag: row present, no drag', (platform) => {
    env.platform = platform
    render({ header: headerNode(), caps: { windowDrag: true } })
    expect(q('[data-sidebar-header]')).not.toBeNull()
    expect(q('.titlebar-drag')).toBeNull()
  })

  it('SH-18 focus dim: the header row dims like the footer, only while dimming', () => {
    render({ header: headerNode() })
    const dimmed = (el: HTMLElement): boolean =>
      el.classList.contains('opacity-30') && el.classList.contains('hover:opacity-100')
    expect(dimmed(q('[data-sidebar-header]')!)).toBe(false)
    // 专注模式开着但没有选中会话：不淡化
    env.focusMode = true
    render({ header: headerNode() })
    expect(dimmed(q('[data-sidebar-header]')!)).toBe(false)
    env.activeSessionId = 's1'
    render({ header: headerNode() })
    expect(dimmed(q('[data-sidebar-header]')!)).toBe(true)
    expect(dimmed(footer())).toBe(true)
    env.focusMode = false
    render({ header: headerNode() })
    expect(dimmed(q('[data-sidebar-header]')!)).toBe(false)
  })
})

describe('shared Sidebar: hideList / extraViews', () => {
  it('SH-9 hideList: the list stays in the DOM, hidden, with its content', () => {
    render({ hideList: true, groupsPrepend: createElement('div', { 'data-prepend': '' }) })
    expect(list().style.display).toBe('none')
    expect(list().querySelector('[data-prepend]')).not.toBeNull()
  })

  it('SH-10 hide → show keeps the node, its children and the scroll position', () => {
    let mounts = 0
    function Counter(): React.JSX.Element {
      useEffect(() => {
        mounts++
      }, [])
      return createElement('div', { 'data-counter': '' })
    }
    const prepend = createElement(Counter)
    render({ groupsPrepend: prepend })
    const node = list()
    node.scrollTop = 120
    act(() => {
      node.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    render({ groupsPrepend: prepend, hideList: true })
    expect(list()).toBe(node)
    expect(node.style.display).toBe('none')
    render({ groupsPrepend: prepend, hideList: false })
    expect(list()).toBe(node)
    expect(node.style.display).toBe('')
    expect(node.getAttribute('style') ?? '').not.toContain('display')
    expect(mounts).toBe(1)
    expect(node.scrollTop).toBe(120)
  })

  it('SH-19 the position is written back when the hidden element reported 0', () => {
    render()
    const node = list()
    node.scrollTop = 75
    act(() => {
      node.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    render({ hideList: true })
    // 藏着时浏览器把位置压回 0，还发了一次 scroll：不能把记下的位置冲掉
    node.scrollTop = 0
    act(() => {
      node.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    expect(node.scrollTop).toBe(0)
    render({ hideList: false })
    expect(node.scrollTop).toBe(75)
  })

  it('SH-12 extraViews sits after the list and before the footer', () => {
    render({ extraViews: extraNode() })
    const extra = q('[data-my-extra]')!
    expect(kids()).toEqual([list(), extra, footer()])
    act(() => root.unmount())
    root = createRoot(container)
    render({ extraViews: extraNode(), hideFooter: true })
    const all = kids()
    expect(all[all.length - 1]).toBe(q('[data-my-extra]'))
  })

  it.each([[true], [false]])('SH-14 extraViews is rendered with hideList=%s', (hideList) => {
    render({ extraViews: extraNode(), hideList })
    expect(q('[data-my-extra]')).not.toBeNull()
  })

  it('SH-15 all three on web: header, hidden list, extra views, footer', () => {
    render({ header: headerNode(), extraViews: extraNode(), hideList: true })
    expect(kids()).toEqual([q('[data-sidebar-header]'), list(), q('[data-my-extra]'), footer()])
    expect(list().style.display).toBe('none')
  })

  it('SH-16 hideList with an open drill scope: still hidden', () => {
    expect(() =>
      render({ hideList: true, drill: { scope: 'p1', onOpen: () => {} } as SidebarProps['drill'] })
    ).not.toThrow()
    expect(list().style.display).toBe('none')
  })
})
