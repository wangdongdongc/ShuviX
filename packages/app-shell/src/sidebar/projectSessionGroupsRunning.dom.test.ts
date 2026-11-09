// @vitest-environment jsdom
/**
 * 侧栏的「在跑」：这一轮在跑（selectStreamingSessions）或还有没结束的后台任务（selectBgBusySessions），
 * ProjectSessionGroups 把两者合起来传给行（jsdom）。
 *
 *   RUN-1 只有后台任务 / 只有这一轮 / 两者 / 都没有：前三者行上 `data-running`；不相干的行不亮
 *   RUN-2 分支的启用只看这一轮：只有后台任务 → 行亮着、分支可点；这一轮在跑 → 置灰；被中断 + 后台任务 → 置灰；临时行同样
 *   RUN-3 带展开子会话的父行：只有子会话有任务 → 只亮子行；只有父有 → 只亮父行，折叠钮在；后台任务不挡待答徽标
 *
 * 两张表都用同一个可变 `store`（按 selector 读）：选择器本身的口径在 chat-ui 的 bgTaskStore.test.ts。
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
  /** selectBgBusySessions 的结果 */
  bgBusy: {} as Record<string, boolean>,
  /** selectInterruptedSessions 的结果 */
  interrupted: {} as Record<string, boolean>,
  /** selectAllPendingCounts 的结果 */
  pending: {} as Record<string, number>
}))

vi.mock('@shuvix/chat-ui', () => ({
  RedactedText: ({ text }: { text: string }) => text,
  RedactionSessionProvider: ({ children }: { children: unknown }) => children,
  useChatStore: Object.assign((selector: (s: typeof store) => unknown) => selector(store), {
    getState: () => store
  }),
  useBgTaskStore: (selector: (s: typeof store) => unknown) => selector(store),
  useUnreadStore: (selector: (s: { unread: Record<string, unknown> }) => unknown) =>
    selector({ unread: {} }),
  selectBgBusySessions: (s: typeof store) => s.bgBusy,
  selectStreamingSessions: (s: typeof store) => s.streaming,
  selectInterruptedSessions: (s: typeof store) => s.interrupted,
  selectAllPendingCounts: (s: typeof store) => s.pending,
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

let container: HTMLDivElement
let root: Root
let menus: ContextMenuItem[][]

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
const temp = (id: string, over: Partial<StoreSession> = {}): StoreSession =>
  row(id, { projectId: null, ...over })

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
      return null
    }
  }
  act(() =>
    root.render(
      createElement(
        ContextMenuProvider,
        provider as ProviderProps,
        createElement(ProjectSessionGroups, {
          projects: [PROJECT],
          collapsed: new Set<string>(),
          onToggleGroup: () => {},
          onNewChat: () => {},
          onDelete: () => {},
          onConfigureSession: () => {},
          onForkSession: () => {},
          ...props
        })
      )
    )
  )
}

function rowEl(id: string): HTMLElement {
  const title = `Title ${id}`
  const found = [...container.querySelectorAll<HTMLElement>('[data-session-row]')].find((el) =>
    el.textContent?.includes(title)
  )
  if (!found) throw new Error(`row ${id} not rendered`)
  return found
}
const running = (id: string): boolean => rowEl(id).hasAttribute('data-running')

async function forkEnabled(id: string): Promise<boolean | undefined> {
  const target = rowEl(id)
  const before = menus.length
  await act(async () => {
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await flush()
  expect(menus.length).toBe(before + 1)
  const item = menus[menus.length - 1].find((it) => it.id === 'fork-session')
  expect(item).toBeDefined()
  return item!.enabled
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  menus = []
  store.sessions = []
  store.activeSessionId = null
  store.streaming = {}
  store.bgBusy = {}
  store.interrupted = {}
  store.pending = {}
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('RUN-1 the row is running on either source', () => {
  it.each<[string, Record<string, boolean>, Record<string, boolean>, boolean]>([
    ['background task only', {}, { s1: true }, true],
    ['turn only', { s1: true }, {}, true],
    ['both', { s1: true }, { s1: true }, true],
    ['neither', {}, {}, false]
  ])('RUN-1 %s', (_label, streaming, bgBusy, expected) => {
    store.sessions = [row('s1'), row('s2')]
    store.streaming = streaming
    store.bgBusy = bgBusy
    mount()
    expect(running('s1')).toBe(expected)
    expect(running('s2')).toBe(false)
  })

  it.each<[string, Record<string, boolean>, Record<string, boolean>]>([
    ['background task', {}, { t1: true }],
    ['turn', { t1: true }, {}]
  ])('RUN-1 a temporary row runs on a %s too', (_label, streaming, bgBusy) => {
    store.sessions = [temp('t1'), temp('t2')]
    store.streaming = streaming
    store.bgBusy = bgBusy
    mount()
    expect(running('t1')).toBe(true)
    expect(running('t2')).toBe(false)
  })
})

describe('RUN-2 fork enablement follows the turn, not the background task', () => {
  it.each<
    [
      string,
      (id: string) => StoreSession,
      Record<string, boolean>,
      Record<string, boolean>,
      Record<string, boolean>,
      boolean
    ]
  >([
    ['background task only', row, {}, { s1: true }, {}, true],
    ['turn running', row, { s1: true }, {}, {}, false],
    ['turn running and background task', row, { s1: true }, { s1: true }, {}, false],
    ['interrupted and background task', row, {}, { s1: true }, { s1: true }, false],
    ['temp row, background task only', temp, {}, { s1: true }, {}, true],
    ['temp row, turn running', temp, { s1: true }, {}, {}, false],
    ['temp row, interrupted and background task', temp, {}, { s1: true }, { s1: true }, false]
  ])('RUN-2 %s', async (_label, make, streaming, bgBusy, interrupted, enabled) => {
    store.sessions = [make('s1')]
    store.streaming = streaming
    store.bgBusy = bgBusy
    store.interrupted = interrupted
    mount()
    expect(running('s1')).toBe(Boolean(streaming.s1 || bgBusy.s1))
    expect(await forkEnabled('s1')).toBe(enabled)
  })
})

describe('RUN-3 parent, child, and the pending-ask badge', () => {
  const family = (): StoreSession[] => [
    row('parent'),
    row('child', { parentId: 'parent', createdAt: 2 })
  ]
  const parentToggle = (): HTMLElement | null =>
    rowEl('parent').querySelector('button[data-subs-toggle]')

  it('RUN-3 a task on the expanded child lights only the child', () => {
    store.sessions = family()
    store.bgBusy = { child: true }
    mount()
    expect(rowEl('child').hasAttribute('data-sub')).toBe(true)
    expect(running('child')).toBe(true)
    expect(running('parent')).toBe(false)
    expect(parentToggle()).not.toBeNull()
  })

  it('RUN-3 a task on the parent lights only the parent, and its toggle stays', () => {
    store.sessions = family()
    store.bgBusy = { parent: true }
    mount()
    expect(running('parent')).toBe(true)
    expect(running('child')).toBe(false)
    expect(parentToggle()).not.toBeNull()
    expect(parentToggle()!.querySelector('svg')!.classList).toContain(
      'lucide-messages-square-solid'
    )
  })

  it('RUN-3 the pending-ask badge still shows on a row lit by a background task', () => {
    store.sessions = [row('s1'), row('s2')]
    store.bgBusy = { s1: true }
    store.pending = { s1: 3 }
    mount()
    expect(running('s1')).toBe(true)
    expect(
      rowEl('s1').querySelector('[data-pending-asks]')?.getAttribute('data-pending-asks')
    ).toBe('3')
    expect(rowEl('s2').querySelector('[data-pending-asks]')).toBeNull()
  })
})
