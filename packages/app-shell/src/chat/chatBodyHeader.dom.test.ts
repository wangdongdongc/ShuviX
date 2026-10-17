// @vitest-environment jsdom
/**
 * ChatBody 的 `header` 插槽（web 客户端的手机布局换掉整个顶栏；jsdom）。
 *
 * 契约：不传 `header` → 照旧画共享 ChatHeader，headerCaps / headerHeightClassName / onOpenSessionConfig /
 * rightActions 原样交给它；传了 → 宿主的顶栏是根节点的第一个孩子，ChatHeader 一次都不画；横幅、浮层与
 * 「欢迎 / 对话 / 笔记本」三态切换不受影响。
 *
 *   CB-1 不传 header：ChatHeader 收到 caps、高度类、onOpenSessionConfig、rightActions
 *   CB-2 传了 header：它是第一个孩子，ChatHeader 没画过
 *   CB-3 传了 header：横幅、浮层、欢迎 / 对话 / 笔记本照常
 *
 * `./ChatHeader` 换成记下 props 的替身；`@shuvix/chat-ui` 只给 Conversation 替身与一个按 selector 读的
 * store；会话面板的 `useSessionPanelTool` 恒为 null。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

interface StoreState {
  activeSessionId: string | null
  sessions: Array<{ id: string; settings: { notebookPath?: string } }>
}

const hoisted = vi.hoisted(() => ({
  headerProps: [] as Array<Record<string, unknown>>,
  state: { activeSessionId: null, sessions: [] } as StoreState
}))

vi.mock('./ChatHeader', async () => {
  const { createElement: h } = await import('react')
  return {
    ChatHeader: (props: Record<string, unknown>) => {
      hoisted.headerProps.push(props)
      return h('div', { 'data-shared-header': '' })
    }
  }
})

vi.mock('@shuvix/chat-ui', async () => {
  const { createElement: h } = await import('react')
  return {
    Conversation: ({ sessionId, emptyState }: { sessionId: string; emptyState?: unknown }) =>
      h('div', { 'data-conversation': sessionId }, emptyState as never),
    useChatStore: (selector: (s: StoreState) => unknown) => selector(hoisted.state)
  }
})

vi.mock('../panel/SessionPanel', () => ({ useSessionPanelTool: () => null }))

import { ChatBody, type ChatBodyProps } from './ChatBody'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(props: Partial<ChatBodyProps>): void {
  act(() =>
    root.render(
      createElement(ChatBody, {
        welcome: createElement('div', { 'data-welcome': '' }),
        renderNotebook: (path: string, sid: string) =>
          createElement('div', { 'data-notebook': `${sid}:${path}` }),
        ...props
      })
    )
  )
}

const q = (sel: string): Element | null => container.querySelector(sel)

beforeEach(() => {
  hoisted.headerProps.length = 0
  hoisted.state = { activeSessionId: null, sessions: [] }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ChatBody header slot', () => {
  it('CB-1 without a header the shared ChatHeader gets caps, height class, onOpenSessionConfig and rightActions', () => {
    const caps = { windowDrag: true, editableTitle: true, sessionConfig: true }
    const onOpenSessionConfig = vi.fn()
    const rightActions = createElement('span', { 'data-right': '' })
    render({ headerCaps: caps, headerHeightClassName: 'h-10', onOpenSessionConfig, rightActions })
    expect(q('[data-shared-header]')).not.toBeNull()
    const last = hoisted.headerProps.at(-1)!
    expect(last.caps).toBe(caps)
    expect(last.heightClassName).toBe('h-10')
    expect(last.onOpenSessionConfig).toBe(onOpenSessionConfig)
    expect(last.rightActions).toBe(rightActions)
    // 共享顶栏仍是根节点的第一个孩子
    expect(container.firstElementChild?.firstElementChild?.hasAttribute('data-shared-header')).toBe(
      true
    )
  })

  it('CB-2 a host header is the first child and ChatHeader is never rendered', () => {
    render({
      header: createElement('div', { 'data-host-header': '' }),
      headerCaps: { sessionConfig: true },
      rightActions: createElement('span', { 'data-right': '' })
    })
    const bodyRoot = container.firstElementChild!
    expect(bodyRoot.firstElementChild?.hasAttribute('data-host-header')).toBe(true)
    expect(q('[data-shared-header]')).toBeNull()
    expect(q('[data-right]')).toBeNull()
    expect(hoisted.headerProps).toHaveLength(0)
  })

  it('CB-3 with a host header the banner, overlays and the welcome / conversation / notebook switch still render', () => {
    const base: Partial<ChatBodyProps> = {
      header: createElement('div', { 'data-host-header': '' }),
      banner: createElement('div', { 'data-banner': '' }),
      overlays: createElement('div', { 'data-overlay': '' }),
      conversationEmptyState: (sid: string) => createElement('i', { 'data-empty': sid })
    }
    // 没有活跃会话 → 欢迎页
    render(base)
    expect(q('[data-banner]')).not.toBeNull()
    expect(q('[data-overlay]')).not.toBeNull()
    expect(q('[data-welcome]')).not.toBeNull()
    expect(q('[data-conversation]')).toBeNull()

    // 普通会话 → 对话（带宿主的空态）
    hoisted.state = { activeSessionId: 's1', sessions: [{ id: 's1', settings: {} }] }
    render(base)
    expect(q('[data-welcome]')).toBeNull()
    expect(q('[data-conversation]')?.getAttribute('data-conversation')).toBe('s1')
    expect(q('[data-empty]')?.getAttribute('data-empty')).toBe('s1')
    expect(q('[data-banner]')).not.toBeNull()
    expect(q('[data-overlay]')).not.toBeNull()

    // 笔记本会话 → 笔记本
    hoisted.state = {
      activeSessionId: 'n1',
      sessions: [{ id: 'n1', settings: { notebookPath: 'notes/a.md' } }]
    }
    render(base)
    expect(q('[data-conversation]')).toBeNull()
    expect(q('[data-notebook]')?.getAttribute('data-notebook')).toBe('n1:notes/a.md')
    expect(q('[data-banner]')).not.toBeNull()
    expect(q('[data-overlay]')).not.toBeNull()
    expect(q('[data-host-header]')).not.toBeNull()
    expect(hoisted.headerProps).toHaveLength(0)
  })
})
