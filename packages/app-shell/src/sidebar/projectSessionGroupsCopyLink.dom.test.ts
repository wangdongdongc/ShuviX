// @vitest-environment jsdom
/**
 * 会话行菜单里的「复制链接」（ProjectSessionGroups 的 `onCopyLink`，jsdom）。只有日历按天渲染时注入
 * （链接指向这条会话选中的那一天；拼链接、写剪贴板是宿主的事）。
 *
 *   CL-1 注入时排在菜单第一项（其余照旧）；点它 → onCopyLink(这一行的 id) 一次，子会话行也一样
 *   CL-2 不注入 → 没有这一项
 *   CL-3 只注入它（没有配置 / 删除）的笔记本行也长出 ⋮：菜单里就这一项
 *
 * 脚手架照 projectSessionGroupsFork.dom.test.ts：右键菜单经 ContextMenuProvider 的 `render` 注入，
 * 按预设回一个 id（模拟用户点了它）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'

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
  sessions: [] as StoreSession[],
  activeSessionId: null as string | null,
  setActiveSessionId: (_id: string | null) => {},
  /** selectStreamingSessions 的结果 */
  streaming: {} as Record<string, boolean>,
  /** selectInterruptedSessions 的结果 */
  interrupted: {} as Record<string, boolean>
}))

vi.mock('@shuvix/chat-ui', () => ({
  // 自动脱敏的标题标记：这里只看行菜单，原样交回标题
  RedactedText: ({ text }: { text: string }) => text,
  RedactionSessionProvider: ({ children }: { children: unknown }) => children,
  useChatStore: Object.assign((selector: (s: typeof store) => unknown) => selector(store), {
    getState: () => store
  }),
  selectStreamingSessions: (s: typeof store) => s.streaming,
  selectInterruptedSessions: (s: typeof store) => s.interrupted,
  selectAllPendingCounts: () => ({}),
  useChatHost: () => ({ appearance: { focusMode: false } }),
  useAppEvent: () => {},
  getChatApi: () => ({ message: { list: async () => [] } })
}))

import { ProjectSessionGroups, type ProjectSessionGroupsProps } from './ProjectSessionGroups'
import { ContextMenuProvider } from '../contextmenu/ContextMenuProvider'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = { id: 'p1', name: 'Proj' }
const HIDDEN = { id: '__knowledge__', name: 'Knowledge carrier' }

let container: HTMLDivElement
let root: Root
/** 每次弹出的菜单项；pick = 「用户」点的那一项（null = 取消；不在菜单里或置灰也当取消） */
let menus: ContextMenuItem[][]
let pick: string | null

function row(id: string, over: Partial<StoreSession> = {}): StoreSession {
  return {
    id,
    title: `Title ${id}`,
    projectId: PROJECT.id,
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

function mount(props: Partial<ProjectSessionGroupsProps> = {}): void {
  type ProviderProps = ComponentProps<typeof ContextMenuProvider>
  const provider: Omit<ProviderProps, 'children'> = {
    render: async (items: ContextMenuItem[]) => {
      menus.push(items)
      const hit = items.find((it) => it.id === pick)
      return hit && hit.enabled !== false ? pick : null
    }
  }
  act(() =>
    root.render(
      createElement(
        ContextMenuProvider,
        provider as ProviderProps,
        createElement(ProjectSessionGroups, {
          projects: [PROJECT, HIDDEN],
          collapsed: new Set<string>(),
          onToggleGroup: () => {},
          onNewChat: () => {},
          onDelete: () => {},
          onConfigureSession: () => {},
          ...props
        })
      )
    )
  )
}

/** 按标题找到那一行（`[data-session-row]`） */
function rowEl(id: string): HTMLElement {
  const title = `Title ${id}`
  const found = [...container.querySelectorAll<HTMLElement>('[data-session-row]')].find((el) =>
    el.textContent?.includes(title)
  )
  if (!found) throw new Error(`row ${id} not rendered`)
  return found
}

/** 右键这一行，回到弹出的菜单项（并按 pick 分发） */
async function menuOf(id: string): Promise<ContextMenuItem[]> {
  const target = rowEl(id)
  const before = menus.length
  await act(async () => {
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await flush()
  expect(menus.length).toBe(before + 1)
  return menus[menus.length - 1]
}
/** 菜单项的 id；分隔线记作 'separator' */
const ids = (items: ContextMenuItem[]): string[] => items.map((item) => item.id ?? item.type ?? '?')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  menus = []
  pick = null
  store.sessions = []
  store.activeSessionId = null
  store.streaming = {}
  store.interrupted = {}
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('行菜单里的「复制链接」', () => {
  it('CL-1 注入时排第一项；点它 → onCopyLink(行 id) 一次（子会话行也一样）', async () => {
    store.sessions = [row('s1'), row('child', { parentId: 's1' })]
    const onCopyLink = vi.fn()
    mount({ onCopyLink })
    pick = 'copy-link'
    const items = await menuOf('s1')
    expect(ids(items)).toEqual([
      'copy-link',
      'session-config',
      'export-session',
      'separator',
      'delete-session'
    ])
    expect(items[0]).toEqual({ id: 'copy-link', label: en.sidebar.copySessionLink })
    expect(onCopyLink).toHaveBeenCalledTimes(1)
    expect(onCopyLink).toHaveBeenCalledWith('s1')

    // 子会话默认折叠在父行里：展开再右键它
    await act(async () => {
      rowEl('s1').querySelector<HTMLElement>('[data-subs-toggle]')!.click()
    })
    await menuOf('child')
    expect(onCopyLink).toHaveBeenLastCalledWith('child')
  })

  it('CL-2 不注入 → 没有这一项', async () => {
    store.sessions = [row('s1')]
    mount({})
    expect(ids(await menuOf('s1'))).not.toContain('copy-link')
  })

  it('CL-3 只注入它的笔记本行：⋮ 照样长出来，菜单里就这一项', async () => {
    store.sessions = [row('nb', { settings: { notebookPath: 'a.md' } })]
    mount({ onCopyLink: vi.fn(), onDelete: undefined, onConfigureSession: undefined })
    expect(ids(await menuOf('nb'))).toEqual(['copy-link'])
  })
})
