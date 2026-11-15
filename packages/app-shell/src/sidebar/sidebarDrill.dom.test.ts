// @vitest-environment jsdom
/**
 * 共享侧栏的两层导航（Sidebar.tsx 的 `drill`，手机布局，jsdom）。
 *
 * 契约：同一个滚动容器先后画顶层与某一组 —— `groupsPrepend` 只在顶层画；进组时列表回到顶上，退回顶层时回到
 * 离开前的位置。顶层的位置是在顶层滚动时记下的（进组那一刻再读就晚了：组里内容短，浏览器已经把位置压回去了）。
 *
 *   SB-1 不给 drill：groupsPrepend 在，没有导航行
 *   SB-2 顶层：groupsPrepend 在，导航行在
 *   SB-3 进了某一组：groupsPrepend 不画，只有那一组
 *   SB-4 顶层滚到 120 → 进组 0 → 回顶层 120
 *   SB-5 从一组直接换到另一组 → 0；再回顶层还是原来的 120；在组里滚动不改记下的顶层位置
 *   SB-6 同一组、换一个 drill 对象重渲染 → 不动滚动位置
 *   SB-7 不给 drill：重渲染从不动滚动位置
 *   SB-8 一挂上就在某一组里，再回顶层 → 0
 *   SB-9 浏览器把短页面的位置压回 0 也不丢顶层的位置
 *
 * jsdom 没有布局：`scrollTop` 可写可读、不夹值，也不会自己发 scroll 事件 —— 用例里设完位置手动发一次。
 * Sidebar 与 ProjectSessionGroups 是真的；`@shuvix/chat-ui` 同 sidebarSections 那份测试换成替身。
 * 文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

interface StoreSession {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
  storageKind?: string
  settings: Record<string, unknown>
  createdAt: number
  updatedAt: number
  lastActiveAt: number
}

const store = vi.hoisted(() => ({
  sessions: [] as unknown[],
  activeSessionId: null as string | null
}))

vi.mock('@shuvix/chat-ui', async () => {
  const { createElement: h } = await import('react')
  const state = (): Record<string, unknown> => ({
    ...store,
    setSessions: () => {},
    setActiveSessionId: () => {}
  })
  return {
    RedactedText: ({ text }: { text: string }) => text,
    RedactionSessionProvider: ({ children }: { children: unknown }) => children,
    BotAvatar: ({ name }: { name: string }) => h('span', { 'data-avatar': name }),
    getChatApi: () => ({
      app: {
        platform: 'web',
        onNewChat: () => () => undefined,
        onNewProject: () => () => undefined
      },
      session: { create: async () => ({ id: 'new' }), list: async () => [] },
      message: { list: async () => [] }
    }),
    useChatStore: Object.assign(
      (selector: (s: Record<string, unknown>) => unknown) => selector(state()),
      { getState: state }
    ),
    selectStreamingSessions: () => ({}),
    useBgTaskStore: () => ({}),
    useUnreadStore: (selector: (s: { unread: Record<string, unknown> }) => unknown) =>
      selector({ unread: {} }),
    selectBgRunKinds: () => ({}),
    selectInterruptedSessions: () => ({}),
    selectAllPendingCounts: () => ({}),
    useChatHost: () => ({ appearance: { focusMode: false } }),
    useAppEvent: () => {}
  }
})

import { Sidebar, type SidebarProps } from './Sidebar'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Drill = NonNullable<SidebarProps['drill']>

const PROJECTS = [
  { id: 'p1', name: 'Proj' },
  { id: 'p2', name: 'Other' }
]

let container: HTMLDivElement
let root: Root

function row(id: string, over: Partial<StoreSession> = {}): StoreSession {
  return {
    id,
    title: `Title ${id}`,
    projectId: null,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    settings: {},
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...over
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(props: Partial<SidebarProps> = {}): Promise<void> {
  act(() =>
    root.render(
      createElement(Sidebar, {
        projects: PROJECTS,
        onOpenFolder: () => {},
        onOpenSettings: () => {},
        groupsPrepend: createElement('div', { 'data-prepend': '' }),
        hideFooter: true,
        density: 'touch',
        ...props
      })
    )
  )
  await flush()
}
/** 每次都是新的 drill 对象（宿主每次渲染都新建一个） */
const at = (scope: string | null): Drill => ({ scope, onOpen: () => {} })
const renderAt = (scope: string | null): Promise<void> => render({ drill: at(scope) })

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const navKeys = (): string[] =>
  [...container.querySelectorAll('[data-group-nav]')].map(
    (el) => el.getAttribute('data-group-nav')!
  )
/** 滚动容器：顶层是 groupsPrepend 的父节点，组里是那一页的父节点 —— 同一个节点 */
function scroller(): HTMLElement {
  const inner = q('[data-prepend]') ?? q('[data-scope-list]')
  if (!inner?.parentElement) throw new Error('no scroller')
  return inner.parentElement
}
/** 用户滚到某个位置：jsdom 不会自己发 scroll 事件 */
function scrollTo(top: number): void {
  const el = scroller()
  el.scrollTop = top
  act(() => {
    el.dispatchEvent(new Event('scroll'))
  })
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  store.sessions = [row('a1', { projectId: 'p1' }), row('b1', { projectId: 'p2' }), row('t1')]
  store.activeSessionId = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Sidebar drill: what is drawn', () => {
  it('SB-1 without drill the prepend slot is drawn and there are no nav rows', async () => {
    await render()
    expect(q('[data-prepend]')).not.toBeNull()
    expect(q('[data-group-nav]')).toBeNull()
    expect(q('[data-scope-list]')).toBeNull()
  })

  it('SB-2 at the top level the prepend slot is drawn above the nav rows', async () => {
    await renderAt(null)
    const prepend = q('[data-prepend]')
    expect(prepend).not.toBeNull()
    expect(navKeys()).toEqual(['p2', 'p1', '__no_project__'])
    const firstNav = q('[data-group-nav]')!
    expect(
      prepend!.compareDocumentPosition(firstNav) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(q('[data-session-row]')).toBeNull()
  })

  it('SB-3 inside a group the prepend slot is not drawn; only that group is', async () => {
    await renderAt('p1')
    expect(q('[data-prepend]')).toBeNull()
    expect(q('[data-scope-list="p1"]')).not.toBeNull()
    expect(q('[data-group-nav]')).toBeNull()
    expect(container.querySelectorAll('[data-session-row]')).toHaveLength(1)
  })

  it('SB-3 the top level and a group page share one scroller', async () => {
    await renderAt(null)
    const top = scroller()
    await renderAt('p1')
    expect(q('[data-scope-list="p1"]')!.parentElement).toBe(top)
    await renderAt(null)
    expect(scroller()).toBe(top)
  })
})

describe('Sidebar drill: scroll position', () => {
  it('SB-4 entering a group goes to the top; leaving restores the top-level position', async () => {
    await renderAt(null)
    scrollTo(120)
    await renderAt('p1')
    expect(scroller().scrollTop).toBe(0)
    await renderAt(null)
    expect(scroller().scrollTop).toBe(120)
  })

  it('SB-4 the position restored is the last one scrolled to at the top level', async () => {
    await renderAt(null)
    scrollTo(120)
    scrollTo(300)
    await renderAt('p1')
    await renderAt(null)
    expect(scroller().scrollTop).toBe(300)

    // 回来之后再滚、再进再出：记的是新的位置
    scrollTo(40)
    await renderAt('p2')
    expect(scroller().scrollTop).toBe(0)
    await renderAt(null)
    expect(scroller().scrollTop).toBe(40)
  })

  it('SB-5 switching from one group straight to another goes to the top; the top level is still remembered', async () => {
    await renderAt(null)
    scrollTo(120)
    await renderAt('p1')
    scrollTo(55)
    await renderAt('p2')
    expect(q('[data-scope-list="p2"]')).not.toBeNull()
    expect(scroller().scrollTop).toBe(0)
    await renderAt(null)
    expect(scroller().scrollTop).toBe(120)
  })

  it('SB-5 scrolling inside a group does not change the remembered top-level position', async () => {
    await renderAt(null)
    scrollTo(120)
    await renderAt('p1')
    scrollTo(55)
    scrollTo(10)
    await renderAt(null)
    expect(scroller().scrollTop).toBe(120)
  })

  it('SB-6 a re-render in the same group with a new drill object leaves the position alone', async () => {
    await renderAt('p1')
    scrollTo(77)
    await renderAt('p1')
    expect(scroller().scrollTop).toBe(77)
  })

  it('SB-6 a re-render at the top level with a new drill object leaves the position alone', async () => {
    await renderAt(null)
    scrollTo(64)
    await renderAt(null)
    expect(scroller().scrollTop).toBe(64)
  })

  it('SB-7 without drill, re-renders never touch the position', async () => {
    await render()
    scrollTo(90)
    await render()
    expect(scroller().scrollTop).toBe(90)
    await render({ projects: [...PROJECTS] })
    expect(scroller().scrollTop).toBe(90)
  })

  it('SB-8 mounted straight into a group, then back to the top level: the top', async () => {
    await renderAt('p1')
    scrollTo(33)
    await renderAt(null)
    expect(scroller().scrollTop).toBe(0)
  })

  it('SB-9 a browser clamping the short group page to 0 does not lose the top-level position', async () => {
    await renderAt(null)
    const el = scroller()
    // 浏览器的样子：组那一页内容短，一画上去位置就被压回 0，内容再长回来也还是 0
    let stored = 0
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => {
        if (el.querySelector('[data-scope-list]')) stored = 0
        return stored
      },
      set: (value: number) => {
        stored = el.querySelector('[data-scope-list]') ? 0 : value
      }
    })
    scrollTo(400)
    expect(el.scrollTop).toBe(400)

    await renderAt('p1')
    expect(scroller()).toBe(el)
    expect(el.scrollTop).toBe(0)
    // 压回去时浏览器也会发一次 scroll
    act(() => {
      el.dispatchEvent(new Event('scroll'))
    })

    await renderAt(null)
    expect(el.scrollTop).toBe(400)
  })
})
