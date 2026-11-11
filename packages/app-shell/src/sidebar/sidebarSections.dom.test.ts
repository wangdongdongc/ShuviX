// @vitest-environment jsdom
/**
 * 共享侧栏的分节骨架，尤其是全新安装（一个会话、一个项目都没有）那一刻（Sidebar.tsx → ProjectSessionGroups，jsdom）。
 *
 * 契约：空不空都是同一套分节 —— groupsPrepend →（注入了 `bots` 时）「Bots」分节 →「项目」分节 →「聊天」分节
 * （`[data-group="temp"]`）。没有项目时「项目」分节的正文是一行 `[data-projects-empty]`「打开一个文件夹作为项目」
 * （点它 → onOpenFolder）；没有临时会话时「聊天」分节的正文是一行 `[data-temp-new-chat]`「新对话」，它与分节头的
 * 「+」都直接开一条临时会话（session.create({projectId: null}) → 刷新列表 → 选中它）。不再有居中的那颗大按钮。
 *
 *   SE-1  全新安装 + bots：prepend → Bots 分节（bot 组与它的「新对话」）→ 项目分节头 → 项目提示 → 聊天分节头 →
 *         「新对话」行；恰好两个 section 分节头、没有项目组、没有写着 emptyHint 的 <button>；清单只扫一次
 *   SE-1b 同上，注册表是空的：Bots 分节里是「还没有 bot」那一行，仍在项目提示与「新对话」行之上
 *   SE-2  全新安装、不给 bots：没有 Bots 分节；一个项目分节头、一个聊天分节头（项目在前），提示与「新对话」行都在；
 *         touch 密度下聊天分节的「+」在 `[data-sidebar-density="touch"]` 里（base.css 让它常亮）
 *   SE-3  对照组：有一个项目、没有会话 → 没有项目提示，项目组在；Bots / 项目分节都在；聊天分节照样有「新对话」行
 *   SE-4  点项目提示 → onOpenFolder 一次，不建会话
 *   SE-5  点「新对话」行 → create({projectId: null}) → list → setActiveSessionId('new')；聊天分节头的「+」同样
 *         再建一条；onOpenFolder 一次都不调
 *   SE-6  只有侧栏不显示的会话（隐藏载体项目里的笔记本、项目已不在列表里的会话）→ 与 SE-2 同样的骨架，没有会话行
 *
 * ProjectSessionGroups 是真的（分节确实画出来）；`@shuvix/chat-ui` 换成侧栏与分组会碰的那几样（同
 * projectSessionGroupsBots 那份测试），session.create / session.list 与 store 的两个 setter 是可数的 spy。
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

/** 侧栏建会话那条路上的几个 spy：create 回 {id:'new'}，list 回带着它的列表 */
const api = vi.hoisted(() => {
  const created = {
    id: 'new',
    title: 'Title new',
    projectId: null,
    parentId: null,
    settings: {},
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1
  }
  return {
    created,
    create: vi.fn(async (_params: { projectId: string | null }) => ({ id: 'new' })),
    list: vi.fn(async () => [created]),
    setSessions: vi.fn((_sessions: unknown[]) => {}),
    setActiveSessionId: vi.fn((_id: string | null) => {})
  }
})

vi.mock('@shuvix/chat-ui', async () => {
  const { createElement: h } = await import('react')
  const state = (): Record<string, unknown> => ({
    ...store,
    setSessions: api.setSessions,
    setActiveSessionId: api.setActiveSessionId
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
      session: { create: api.create, list: api.list },
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
import type { BotsSectionCaps } from './ProjectSessionGroups'
import type { BotRegistry } from './useBotRegistry'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const S = en.sidebar

let container: HTMLDivElement
let root: Root

function botsCaps(registry: BotRegistry): BotsSectionCaps {
  return {
    adapter: {
      list: vi.fn(async () => registry),
      open: vi.fn(),
      create: vi.fn(),
      openFolder: vi.fn(),
      newSession: vi.fn(),
      archive: vi.fn(),
      deleteFile: vi.fn()
    }
  }
}
const SCOUT: BotRegistry = {
  bots: [{ name: 'scout', displayName: 'Scout', description: '', fileName: 'scout.md' }],
  shadowed: [],
  invalid: []
}
const NO_BOTS: BotRegistry = { bots: [], shadowed: [], invalid: [] }

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

async function render(props: Partial<SidebarProps>): Promise<void> {
  act(() =>
    root.render(
      createElement(Sidebar, {
        projects: [],
        onOpenFolder: () => {},
        onOpenSettings: () => {},
        groupsPrepend: createElement('div', { 'data-prepend': '' }),
        ...props
      })
    )
  )
  await flush()
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await flush()
}

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const all = (sel: string): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(sel)]
/** a 在 DOM 里排在 b 前面 */
const before = (a: Element, b: Element): boolean =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
/** 依次排在前面（每一个都在下一个之前） */
const inOrder = (...els: Array<Element | null>): void => {
  for (const el of els) expect(el).not.toBeNull()
  for (let i = 0; i + 1 < els.length; i++) expect(before(els[i]!, els[i + 1]!)).toBe(true)
}
/** 「项目」/「Bots」分节头 */
const sectionHeader = (label: string): HTMLElement | null =>
  all('[data-group="section"]').find((el) => el.textContent?.startsWith(label)) ?? null
/** 旧的居中大按钮（写着 emptyHint 的 <button>） */
const hintButton = (): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === S.emptyHint
  )

/** 全新安装时（不论有没有 Bots 分节）共有的那半截：项目分节头 → 提示 → 聊天分节头 →「新对话」行 */
function expectFreshProjectsAndChats(): void {
  const projects = sectionHeader(S.projects)
  const hint = q('[data-projects-empty]')
  const chats = q('[data-group="temp"]')
  const newChat = q('[data-temp-new-chat]')
  inOrder(projects, hint, chats, newChat)
  expect(hint!.textContent).toBe(S.emptyHint)
  expect(chats!.textContent?.startsWith(S.tempChats)).toBe(true)
  expect(newChat!.textContent).toBe(S.newChat)
  expect(q('[data-group="project"]')).toBeNull()
  expect(hintButton()).toBeUndefined()
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  store.sessions = []
  store.activeSessionId = null
  api.create.mockClear()
  api.list.mockClear()
  api.setSessions.mockClear()
  api.setActiveSessionId.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('shared Sidebar sections on a fresh install', () => {
  it('SE-1 fresh install + bots: prepend → Bots section → Projects header → hint → Chats header → New Chat row', async () => {
    const bots = botsCaps(SCOUT)
    await render({ bots })

    const section = q('[data-sidebar-section="bots"]')
    expect(section).not.toBeNull()
    expect(section!.querySelector('[data-bot-group="scout"]')).not.toBeNull()
    expect(section!.querySelector('[data-bot-new-chat]')).not.toBeNull()
    expect(bots.adapter.list).toHaveBeenCalledTimes(1)

    inOrder(
      q('[data-prepend]'),
      section,
      sectionHeader(S.projects),
      q('[data-projects-empty]'),
      q('[data-group="temp"]'),
      q('[data-temp-new-chat]')
    )
    expectFreshProjectsAndChats()

    // 分节头恰好两个：Bots 与项目（聊天是 temp 形态）
    expect(all('[data-group="section"]')).toHaveLength(2)
    expect(sectionHeader(S.botsGroup)).not.toBeNull()
  })

  it('SE-1b fresh install + bots with an empty registry: the "no bots yet" row, above the Projects hint and the New Chat row', async () => {
    await render({ bots: botsCaps(NO_BOTS) })
    const section = q('[data-sidebar-section="bots"]')
    expect(section).not.toBeNull()
    const empty = section!.querySelector('[data-bots-empty]')
    expect(empty?.textContent).toBe(S.botsEmpty)
    inOrder(empty, q('[data-projects-empty]'), q('[data-temp-new-chat]'))
    expectFreshProjectsAndChats()
  })

  it('SE-2 fresh install without bots: one Projects header and one Chats header (Projects first), the hint and the New Chat row', async () => {
    await render({})
    expect(q('[data-sidebar-section="bots"]')).toBeNull()
    expect(all('[data-group="section"]')).toHaveLength(1)
    expect(all('[data-group="temp"]')).toHaveLength(1)
    expect(before(sectionHeader(S.projects)!, q('[data-group="temp"]')!)).toBe(true)
    expectFreshProjectsAndChats()
  })

  it('SE-2 touch density: the Chats "+" sits under [data-sidebar-density="touch"]', async () => {
    await render({ density: 'touch' })
    expect(q('[data-sidebar-density="touch"] [data-group="temp"] [data-group-add]')).not.toBeNull()
  })

  it('SE-3 control: one project and no sessions → no hint, the project group is there; Chats still has its New Chat row', async () => {
    await render({ projects: [{ id: 'p1', name: 'Proj' }], bots: botsCaps(NO_BOTS) })
    expect(q('[data-projects-empty]')).toBeNull()
    expect(q('[data-group="project"]')).not.toBeNull()
    expect(q('[data-sidebar-section="bots"]')).not.toBeNull()
    expect(sectionHeader(S.projects)).not.toBeNull()
    expect(q('[data-group="temp"]')).not.toBeNull()
    expect(q('[data-temp-new-chat]')?.textContent).toBe(S.newChat)
  })

  it('SE-4 clicking the Projects hint opens a folder, and creates no session', async () => {
    const onOpenFolder = vi.fn()
    await render({ onOpenFolder })
    await click(q('[data-projects-empty]')!)
    expect(onOpenFolder).toHaveBeenCalledTimes(1)
    expect(api.create).not.toHaveBeenCalled()
  })

  it('SE-5 the New Chat row and the Chats "+" each create a temporary session, refresh the list and select it', async () => {
    const onOpenFolder = vi.fn()
    await render({ onOpenFolder })

    await click(q('[data-temp-new-chat]')!)
    expect(api.create.mock.calls).toEqual([[{ projectId: null }]])
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.setSessions.mock.calls).toEqual([[[api.created]]])
    expect(api.setActiveSessionId.mock.calls).toEqual([['new']])
    // 次序：先建、再刷新列表、最后选中
    const [createAt] = api.create.mock.invocationCallOrder
    const [listAt] = api.list.mock.invocationCallOrder
    const [selectAt] = api.setActiveSessionId.mock.invocationCallOrder
    expect(createAt).toBeLessThan(listAt)
    expect(listAt).toBeLessThan(selectAt)

    await click(q('[data-group="temp"] [data-group-add]')!)
    expect(api.create.mock.calls).toEqual([[{ projectId: null }], [{ projectId: null }]])
    expect(api.setActiveSessionId.mock.calls).toEqual([['new'], ['new']])
    expect(onOpenFolder).not.toHaveBeenCalled()
  })

  it('SE-6 only sessions the sidebar does not show → the same skeleton as a fresh install, no session rows', async () => {
    store.sessions = [
      row('note', { projectId: '__agents__', settings: { notebookPath: 'scout.md' } }),
      row('stray', { projectId: 'gone' })
    ]
    await render({})
    expect(all('[data-group="section"]')).toHaveLength(1)
    expect(all('[data-group="temp"]')).toHaveLength(1)
    expectFreshProjectsAndChats()
    expect(q('[data-session-row]')).toBeNull()
  })
})
