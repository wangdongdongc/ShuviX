// @vitest-environment jsdom
/**
 * 会话行菜单里的「分支会话」（ProjectSessionGroups 的 `onForkSession`，jsdom）。
 *
 * 契约：宿主注入 `onForkSession` 且这条会话的形态给 fork（chat-protocol `isForkableSessionShape`：真实的非隐藏
 * 项目、不是笔记本、不是 Chrome 标签页、新格式存储）时，行菜单里多一项
 * `{id:'fork-session', label: sidebar.forkSession}`，排在 `export-session` 之后、分隔线与 `delete-session`
 * 之前；在跑 / 被中断时这一项还在但置灰（`enabled: false`），空闲时 `enabled: true`。点它 →
 * `onForkSession(<这一行的 id>)`，恰好一次。
 *
 *   S-1 空闲的项目会话：菜单 = 配置、导出、分支（enabled true）、分隔线、删除；不注入配置 / 删除时 = 导出、分支
 *   S-2 在跑 / 被中断：分支在，enabled false（选不中它，onForkSession 不被调）
 *   S-3 临时会话、笔记本、隐藏项目、Chrome 标签页、旧格式存储、缺省存储类型、宿主不注入 onForkSession → 没有这一项
 *   S-4 选中它 → onForkSession(行 id) 一次：顶层行与子会话行都一样
 *
 * 右键菜单走 ContextMenuProvider 的 `render` 注入：记录菜单项、按预设回一个 id（模拟用户点了它）——
 * 预设的 id 不在这份菜单里、或那一项置灰，就回 null（真菜单点不出它）。`@shuvix/chat-ui` 替掉
 * useChatStore（按 selector 读可变的 `store`）与侧栏会读的三个选择器、useChatHost、getChatApi。
 * 文件是 `.ts`，一律 createElement。
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
const forkItem = (items: ContextMenuItem[]): ContextMenuItem | undefined =>
  items.find((item) => item.id === 'fork-session')

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

describe('行菜单里的「分支会话」', () => {
  it('S-1 空闲的项目会话：配置、导出、分支（enabled true）、分隔线、删除', async () => {
    store.sessions = [row('s1')]
    mount({ onForkSession: vi.fn() })
    const items = await menuOf('s1')
    expect(ids(items)).toEqual([
      'session-config',
      'export-session',
      'fork-session',
      'separator',
      'delete-session'
    ])
    expect(forkItem(items)).toEqual({
      id: 'fork-session',
      label: en.sidebar.forkSession,
      enabled: true
    })
    expect(en.sidebar.forkSession).toBe('Fork Session')
  })

  it('S-1 不注入配置与删除：菜单只有导出、分支（没有孤零零的分隔线）', async () => {
    store.sessions = [row('s1')]
    mount({ onForkSession: vi.fn(), onConfigureSession: undefined, onDelete: undefined })
    const items = await menuOf('s1')
    expect(ids(items)).toEqual(['export-session', 'fork-session'])
    expect(forkItem(items)!.enabled).toBe(true)
  })

  it.each<[string, Partial<typeof store>]>([
    ['在跑', { streaming: { s1: true } }],
    ['被中断', { interrupted: { s1: true } }]
  ])('S-2 %s：分支还在、置灰；选不中它', async (_label, patch) => {
    Object.assign(store, patch)
    store.sessions = [row('s1'), row('s2')]
    const onForkSession = vi.fn()
    mount({ onForkSession })
    pick = 'fork-session'
    const items = await menuOf('s1')
    expect(ids(items)).toEqual([
      'session-config',
      'export-session',
      'fork-session',
      'separator',
      'delete-session'
    ])
    expect(forkItem(items)).toEqual({
      id: 'fork-session',
      label: en.sidebar.forkSession,
      enabled: false
    })
    expect(onForkSession).not.toHaveBeenCalled()
    // 别的会话不受影响
    expect(forkItem(await menuOf('s2'))!.enabled).toBe(true)
  })

  it.each<[string, Partial<StoreSession>]>([
    ['临时会话（不属于项目）', { projectId: null }],
    ['笔记本会话', { settings: { notebookPath: 'notes/a.md' } }],
    ['隐藏项目里的会话', { projectId: HIDDEN.id }],
    ['Chrome 标签页会话', { settings: { chromeTab: { installId: 'i', runId: 'r', tabId: 4 } } }],
    ['旧格式存储', { storageKind: 'harness-v3-jsonl' }],
    ['缺省存储类型（按旧格式理解）', { storageKind: undefined }]
  ])('S-3 %s：没有分支这一项', async (_label, over) => {
    store.sessions = [row('s1', over)]
    mount({ onForkSession: vi.fn() })
    const items = await menuOf('s1')
    expect(forkItem(items)).toBeUndefined()
    expect(ids(items)).toContain('delete-session')
  })

  it('S-3 宿主不注入 onForkSession：形态给的会话上也没有这一项', async () => {
    store.sessions = [row('s1')]
    mount()
    const items = await menuOf('s1')
    expect(forkItem(items)).toBeUndefined()
    expect(ids(items)).toEqual(['session-config', 'export-session', 'separator', 'delete-session'])
  })

  it('S-4 选中它 → onForkSession(行 id) 恰好一次', async () => {
    store.sessions = [row('s1'), row('s2')]
    const onForkSession = vi.fn()
    const onDelete = vi.fn()
    const onConfigureSession = vi.fn()
    mount({ onForkSession, onDelete, onConfigureSession })
    pick = 'fork-session'
    await menuOf('s2')
    expect(onForkSession.mock.calls).toEqual([['s2']])
    expect(onDelete).not.toHaveBeenCalled()
    expect(onConfigureSession).not.toHaveBeenCalled()
  })

  it('S-4 子会话行同样：onForkSession(子会话 id)', async () => {
    store.sessions = [row('parent'), row('child', { parentId: 'parent', createdAt: 2 })]
    const onForkSession = vi.fn()
    mount({ onForkSession })
    const childRow = rowEl('child')
    expect(childRow.hasAttribute('data-sub')).toBe(true)
    pick = 'fork-session'
    const items = await menuOf('child')
    expect(forkItem(items)!.enabled).toBe(true)
    expect(onForkSession.mock.calls).toEqual([['child']])
  })
})
