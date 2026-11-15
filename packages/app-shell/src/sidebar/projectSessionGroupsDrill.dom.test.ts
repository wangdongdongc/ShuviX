// @vitest-environment jsdom
/**
 * ProjectSessionGroups 的两层导航（`drill`，手机布局的「聊天」页，jsdom）。
 *
 * 顶层（`scope: null`）：每个项目 / bot / 「聊天」是一行导航行，组的正文不画
 *   DR-1  导航行的次序（bot、项目、聊天）；没有会话行、没有「+」、没有空组的「新对话」
 *   DR-2  会话数（子会话不算；0 条不画）
 *   DR-3  点导航行 → `onOpen(组 key, 名字)`，不动折叠
 *   DR-4  「聊天」那一行包在 `[data-sidebar-section="temp-nav"]` 里
 *   DR-5  分节标题照旧，不是导航行
 *   DR-6  找不到文件的 bot、清单还没回来的 bot 也各是一行
 *   DR-7  顶层不取摘要、不扫知识库
 *   DR-8  右键导航行照旧开组菜单
 *
 * 进了某一组（`scope` = 组 key）：只画那一组
 *   DR-10..14 第一行「新对话」（项目 / 聊天直接建，bot 先选位置）、知识库文件夹
 *   DR-15..20 两层的行：时间、摘要（在等你回答 > 正在回复 > 最后一条回复）
 *   DR-21..23 摘要每条取一次、戳变了才重取、只取前 30 条；先放 30 行再「查看更多」
 *   DR-24..27 未读点、子会话、bot 行的位置、点行与右键
 *   DR-28..31 空组与不在了的组（项目被删、bot 不在了、bot 归档了）
 *   DR-32 从组里回到顶层
 *
 * 不传 `drill`（桌面）：
 *   DR-40 一切照旧
 *
 * `@shuvix/chat-ui` 换成替身（同 projectSessionGroupsRunning / Bots 那两份），`getChatApi().message.list` 是可数的 spy。
 * 替身的 store 不是响应式的：改了之后手动重渲染。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import type { SessionUnread } from '@shuvix/chat-protocol/sessionUnread'

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
interface PreviewMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}
const store = vi.hoisted(() => ({
  sessions: [] as StoreSession[],
  activeSessionId: null as string | null,
  setActiveSessionId: (_id: string | null) => {},
  streaming: {} as Record<string, boolean>,
  bgKinds: {} as Record<string, 'agent' | 'resident'>,
  unread: {} as Record<string, SessionUnread>,
  interrupted: {} as Record<string, boolean>,
  pending: {} as Record<string, number>
}))
const api = vi.hoisted(() => ({
  list: vi.fn<(id: string) => Promise<PreviewMessage[]>>()
}))

vi.mock('@shuvix/chat-ui', async () => {
  const { createElement: h } = await import('react')
  return {
    RedactedText: ({ text }: { text: string }) => text,
    RedactionSessionProvider: ({ children }: { children: unknown }) => children,
    BotAvatar: ({ name }: { name: string }) => h('span', { 'data-avatar': name }),
    useChatStore: Object.assign((selector: (s: typeof store) => unknown) => selector(store), {
      getState: () => store
    }),
    useBgTaskStore: (selector: (s: typeof store) => unknown) => selector(store),
    useUnreadStore: (selector: (s: { unread: Record<string, unknown> }) => unknown) =>
      selector({ unread: store.unread }),
    selectBgRunKinds: (s: typeof store) => s.bgKinds,
    selectStreamingSessions: (s: typeof store) => s.streaming,
    selectInterruptedSessions: (s: typeof store) => s.interrupted,
    selectAllPendingCounts: (s: typeof store) => s.pending,
    useChatHost: () => ({ appearance: { focusMode: false } }),
    useAppEvent: () => {},
    getChatApi: () => ({ message: { list: (id: string) => api.list(id) } })
  }
})

import {
  ProjectSessionGroups,
  TEMP_GROUP_KEY,
  type BotsSectionCaps,
  type ProjectSessionGroupsProps
} from './ProjectSessionGroups'
import type { BotGroupAdapter, BotGroupItem, BotRegistry } from './useBotRegistry'
import type { KnowledgeGroupAdapter, KnowledgeListing } from './KnowledgeTreeView'
import { ContextMenuProvider } from '../contextmenu/ContextMenuProvider'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = { id: 'p1', name: 'Proj' }
const S = en.sidebar
type Drill = NonNullable<ProjectSessionGroupsProps['drill']>

let container: HTMLDivElement
let root: Root
/** 每次弹出的菜单项 */
let menus: ContextMenuItem[][]
/** 「用户」依次点的那几项（取空 = 取消） */
let picks: Array<string | null>

function bot(name: string, displayName = name, fileName = `${name}.md`): BotGroupItem {
  return { name, displayName, description: '', fileName }
}
function registryOf(over: Partial<BotRegistry> = {}): BotRegistry {
  return { bots: [], shadowed: [], invalid: [], ...over }
}
interface FakeAdapter extends BotGroupAdapter {
  list: Mock<() => Promise<BotRegistry>>
  newSession: Mock<BotGroupAdapter['newSession']>
}
function makeAdapter(registry: BotRegistry | (() => Promise<BotRegistry>)): FakeAdapter {
  return {
    list: vi.fn(typeof registry === 'function' ? registry : async () => registry),
    open: vi.fn(),
    create: vi.fn(),
    openFolder: vi.fn(),
    newSession: vi.fn(),
    archive: vi.fn(),
    deleteFile: vi.fn(),
    deleteSessions: vi.fn()
  }
}
/** 永远不回来的清单（还没扫回来） */
const pendingRegistry = (): Promise<BotRegistry> => new Promise<BotRegistry>(() => {})

const EMPTY_LISTING: KnowledgeListing = {
  entries: [],
  root: '/kb-shuvix',
  userRoot: '/kb-user',
  dirs: [],
  bundleNames: {}
}
const knowledgeAdapter = (): KnowledgeGroupAdapter & {
  list: Mock<() => Promise<KnowledgeListing>>
} => ({
  list: vi.fn(async () => EMPTY_LISTING),
  open: vi.fn(),
  openFolder: vi.fn()
})

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
const botRow = (
  id: string,
  name: string,
  settings: Record<string, unknown> = {},
  over: Partial<StoreSession> = {}
): StoreSession => temp(id, { settings: { bot: name, ...settings }, ...over })
const many = (count: number): StoreSession[] =>
  Array.from({ length: count }, (_, i) => row(`n${i}`))

const reply = (content: string): PreviewMessage[] => [{ id: 'm1', role: 'assistant', content }]

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** 最近一次 mount 用的 props：`rerender` 在它上面改几项再渲染一遍 */
let lastProps: Partial<ProjectSessionGroupsProps> = {}

async function mount(props: Partial<ProjectSessionGroupsProps> = {}): Promise<void> {
  lastProps = props
  type ProviderProps = ComponentProps<typeof ContextMenuProvider>
  const provider: Omit<ProviderProps, 'children'> = {
    render: async (items: ContextMenuItem[]) => {
      menus.push(items)
      const id = picks.length > 0 ? picks.shift()! : null
      if (id === null) return null
      const hit = items.find((item) => item.id === id)
      return hit && hit.enabled !== false ? id : null
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
          onEditProject: () => {},
          projectsSection: {},
          ...props
        })
      )
    )
  )
  await flush()
}
const rerender = (over: Partial<ProjectSessionGroupsProps> = {}): Promise<void> =>
  mount({ ...lastProps, ...over })

const drillAt = (scope: string | null, onOpen: Drill['onOpen'] = () => {}): Drill => ({
  scope,
  onOpen
})
const botsCaps = (registry: BotRegistry | (() => Promise<BotRegistry>)): BotsSectionCaps => ({
  adapter: makeAdapter(registry)
})
const SCOUT = registryOf({ bots: [bot('scout', 'Scout')] })

const navKeys = (): string[] =>
  [...container.querySelectorAll('[data-group-nav]')].map(
    (el) => el.getAttribute('data-group-nav')!
  )
const navRow = (key: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[data-group-nav="${key}"]`)
  if (!el) throw new Error(`nav row ${key} not rendered`)
  return el
}
const navCount = (key: string): string | null =>
  navRow(key).querySelector('[data-group-count]')?.textContent ?? null
const scopeList = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-scope-list]')
const sessionRows = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-session-row]')
]
const rowIds = (): string[] =>
  sessionRows().map(
    (r) => /^Title (.+)$/.exec(r.querySelector('span.truncate')?.textContent ?? '')?.[1] ?? '?'
  )
const rowEl = (id: string): HTMLElement => {
  const found = sessionRows().find(
    (el) => el.querySelector('span.truncate')?.textContent === `Title ${id}`
  )
  if (!found) throw new Error(`row ${id} not rendered`)
  return found
}
const previewOf = (id: string): HTMLElement | null =>
  rowEl(id).querySelector<HTMLElement>('[data-session-preview]')
const timeOf = (id: string): string | null =>
  rowEl(id).querySelector('[data-session-time]')?.textContent ?? null
const newChatRow = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-scope-new-chat]')
const emptyHint = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-scope-empty]')
const viewMore = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-view-more]')
const calledIds = (): string[] => api.list.mock.calls.map(([id]) => id)
/** a 在 b 之前（文档顺序） */
const before = (a: Element, b: Element): boolean =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await flush()
}
async function rightClick(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await flush()
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
  picks = []
  lastProps = {}
  store.sessions = []
  store.activeSessionId = null
  store.setActiveSessionId = () => {}
  store.streaming = {}
  store.bgKinds = {}
  store.unread = {}
  store.interrupted = {}
  store.pending = {}
  api.list.mockReset()
  api.list.mockImplementation(async () => [])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** DR-1 的那一套：项目里两条、一条临时、bot scout 一条 */
const baseSessions = (): StoreSession[] => [row('a1'), row('a2'), temp('t1'), botRow('b1', 'scout')]

// ─── 顶层 ─────────────────────────────────────

describe('drill top level', () => {
  it('DR-1 one nav row per group, in the order bot, project, chats; no session rows or add buttons', async () => {
    store.sessions = baseSessions()
    await mount({ drill: drillAt(null), bots: botsCaps(SCOUT) })

    expect(navKeys()).toEqual(['bot:scout', 'p1', TEMP_GROUP_KEY])
    expect(sessionRows()).toHaveLength(0)
    expect(container.querySelector('[data-group-add]')).toBeNull()
    expect(container.querySelector('[data-temp-new-chat]')).toBeNull()
    expect(scopeList()).toBeNull()
  })

  it('DR-1 an empty chats group is a nav row too, without the inline new-chat row', async () => {
    store.sessions = [row('a1')]
    await mount({ drill: drillAt(null) })
    expect(navKeys()).toEqual(['p1', TEMP_GROUP_KEY])
    expect(container.querySelector('[data-temp-new-chat]')).toBeNull()
    expect(container.querySelector('[data-group-add]')).toBeNull()
  })

  it('DR-2 each nav row shows its session count; an empty group shows none', async () => {
    store.sessions = baseSessions()
    await mount({
      drill: drillAt(null),
      bots: botsCaps(SCOUT),
      projects: [PROJECT, { id: 'p2', name: 'Empty' }]
    })
    expect(navCount('p1')).toBe('2')
    expect(navCount(TEMP_GROUP_KEY)).toBe('1')
    expect(navCount('bot:scout')).toBe('1')
    expect(navCount('p2')).toBeNull()
  })

  it('DR-2 sub-sessions are not counted', async () => {
    store.sessions = [
      row('a1'),
      row('c1', { parentId: 'a1', createdAt: 2 }),
      row('c2', { parentId: 'a1', createdAt: 3 })
    ]
    await mount({ drill: drillAt(null) })
    expect(navCount('p1')).toBe('1')
  })

  it('DR-3 clicking a nav row opens that group with its key and label, without toggling', async () => {
    store.sessions = baseSessions()
    const onOpen = vi.fn()
    const onToggleGroup = vi.fn()
    await mount({
      drill: drillAt(null, onOpen),
      bots: botsCaps(SCOUT),
      onToggleGroup,
      projects: [PROJECT, { id: 'p2', name: '' }]
    })

    await click(navRow('p1').querySelector('button')!)
    await click(navRow(TEMP_GROUP_KEY).querySelector('button')!)
    await click(navRow('bot:scout').querySelector('button')!)
    await click(navRow('p2').querySelector('button')!)
    expect(onOpen.mock.calls).toEqual([
      ['p1', 'Proj'],
      [TEMP_GROUP_KEY, S.tempChats],
      ['bot:scout', 'Scout'],
      ['p2', S.unnamedProject]
    ])
    expect(onToggleGroup).not.toHaveBeenCalled()
    // 还在顶层：点一下不就地展开
    expect(sessionRows()).toHaveLength(0)
  })

  it('DR-4 the chats nav row sits in its own temp-nav wrapper', async () => {
    store.sessions = baseSessions()
    await mount({ drill: drillAt(null) })
    const wrapper = container.querySelector('[data-sidebar-section="temp-nav"]')
    expect(wrapper).not.toBeNull()
    expect(wrapper!.contains(navRow(TEMP_GROUP_KEY))).toBe(true)
    expect(wrapper!.contains(navRow('p1'))).toBe(false)
  })

  it('DR-5 the section headers remain and are not nav rows', async () => {
    store.sessions = baseSessions()
    await mount({ drill: drillAt(null), bots: botsCaps(SCOUT) })
    const sections = [...container.querySelectorAll<HTMLElement>('[data-group="section"]')]
    expect(sections).toHaveLength(2)
    expect(sections[0].textContent).toContain(S.botsGroup)
    expect(sections[1].textContent).toContain(S.projects)
    for (const section of sections) expect(section.hasAttribute('data-group-nav')).toBe(false)
  })

  it('DR-6 a bot whose file is missing is a nav row inside its missing group', async () => {
    store.sessions = [botRow('g1', 'ghost'), botRow('g2', 'ghost')]
    const onOpen = vi.fn()
    await mount({ drill: drillAt(null, onOpen), bots: botsCaps(registryOf()) })

    const group = container.querySelector('[data-bot-missing-group="ghost"]')
    expect(group).not.toBeNull()
    expect(group!.contains(navRow('bot:ghost'))).toBe(true)
    expect(navCount('bot:ghost')).toBe('2')
    expect(sessionRows()).toHaveLength(0)
    await click(navRow('bot:ghost').querySelector('button')!)
    expect(onOpen.mock.calls).toEqual([['bot:ghost', 'ghost']])
  })

  it('DR-6 while the registry is pending a bot is a nav row labelled by its name', async () => {
    store.sessions = [botRow('b1', 'scout')]
    const onOpen = vi.fn()
    await mount({ drill: drillAt(null, onOpen), bots: botsCaps(pendingRegistry) })

    expect(container.querySelector('[data-bot-group-pending]')!.contains(navRow('bot:scout'))).toBe(
      true
    )
    expect(navRow('bot:scout').textContent).toContain('scout')
    expect(navCount('bot:scout')).toBe('1')
    expect(sessionRows()).toHaveLength(0)
    await click(navRow('bot:scout').querySelector('button')!)
    expect(onOpen.mock.calls).toEqual([['bot:scout', 'scout']])
  })

  it('DR-7 the top level fetches no previews and scans no knowledge base', async () => {
    store.sessions = baseSessions()
    const projectKnowledge = knowledgeAdapter()
    await mount({
      drill: drillAt(null),
      bots: botsCaps(
        registryOf({ bots: [{ ...bot('scout', 'Scout'), knowledgeBundle: 'bots/k1' }] })
      ),
      projectKnowledge
    })
    expect(api.list).not.toHaveBeenCalled()
    expect(projectKnowledge.list).not.toHaveBeenCalled()
    expect(container.querySelector('[data-project-knowledge]')).toBeNull()
    expect(container.querySelector('[data-bot-knowledge]')).toBeNull()
  })

  it('DR-8 a context menu on a project nav row still opens the group menu', async () => {
    store.sessions = baseSessions()
    const onNewChat = vi.fn()
    picks = ['new-chat']
    await mount({ drill: drillAt(null), onNewChat })
    await rightClick(navRow('p1'))
    expect(menus).toHaveLength(1)
    expect(menus[0].map((item) => item.id)).toEqual(['new-chat', 'edit-project'])
    expect(onNewChat.mock.calls).toEqual([['p1']])
  })
})

// ─── 进了某一组 ─────────────────────────────────────

describe('drill inside a group: the page', () => {
  it('DR-10 only that group is drawn, starting with the new-chat row', async () => {
    store.sessions = baseSessions()
    await mount({ drill: drillAt('p1'), bots: botsCaps(SCOUT) })

    expect(container.querySelectorAll('[data-scope-list]')).toHaveLength(1)
    expect(scopeList()!.getAttribute('data-scope-list')).toBe('p1')
    expect(container.querySelector('[data-group-nav]')).toBeNull()
    expect(container.querySelector('[data-group="section"]')).toBeNull()
    expect(container.querySelector('[data-group]')).toBeNull()
    expect(rowIds()).toEqual(['a1', 'a2'])
    expect(scopeList()!.firstElementChild).toBe(newChatRow())
    expect(newChatRow()!.textContent).toContain(S.newChat)
  })

  it('DR-11 the new-chat row of a project starts a chat in that project', async () => {
    store.sessions = baseSessions()
    const onNewChat = vi.fn()
    await mount({ drill: drillAt('p1'), onNewChat })
    await click(newChatRow()!)
    expect(onNewChat.mock.calls).toEqual([['p1']])
  })

  it('DR-11 the new-chat row of the chats group starts a temporary chat', async () => {
    store.sessions = baseSessions()
    const onNewChat = vi.fn()
    await mount({ drill: drillAt(TEMP_GROUP_KEY), bots: botsCaps(SCOUT), onNewChat })
    expect(rowIds()).toEqual(['t1'])
    await click(newChatRow()!)
    expect(onNewChat.mock.calls).toEqual([[null]])
  })

  it('DR-12 the new-chat row of a bot opens the location picker first', async () => {
    store.sessions = baseSessions()
    const caps = botsCaps(SCOUT)
    const adapter = caps.adapter as FakeAdapter
    const onNewChat = vi.fn()
    await mount({ drill: drillAt('bot:scout'), bots: caps, onNewChat })
    expect(rowIds()).toEqual(['b1'])

    // 关掉菜单：什么都不建
    await click(newChatRow()!)
    expect(menus).toHaveLength(1)
    const where = menus[0].find((item) => item.id === 'where')
    expect(where).toBeDefined()
    expect(where!.enabled).toBe(false)
    expect(menus[0].some((item) => item.id === 'temp')).toBe(true)
    expect(adapter.newSession).not.toHaveBeenCalled()

    picks = ['temp']
    await click(newChatRow()!)
    expect(adapter.newSession.mock.calls).toEqual([['scout', { temp: true }]])
    expect(onNewChat).not.toHaveBeenCalled()
  })

  it('DR-13 a bot scope while the registry is pending: no new-chat row, the sessions are listed', async () => {
    store.sessions = baseSessions()
    await mount({ drill: drillAt('bot:scout'), bots: botsCaps(pendingRegistry) })
    expect(newChatRow()).toBeNull()
    expect(rowIds()).toEqual(['b1'])
    expect(emptyHint()).toBeNull()
  })

  it('DR-13 a bot scope whose file is missing: no new-chat row, the sessions are listed', async () => {
    store.sessions = [botRow('g1', 'ghost')]
    await mount({ drill: drillAt('bot:ghost'), bots: botsCaps(SCOUT) })
    expect(newChatRow()).toBeNull()
    expect(rowIds()).toEqual(['g1'])
    expect(emptyHint()).toBeNull()
  })

  it('DR-14 a project scope shows its knowledge folder between the new-chat row and the sessions', async () => {
    store.sessions = baseSessions()
    const projectKnowledge = knowledgeAdapter()
    await mount({ drill: drillAt('p1'), projectKnowledge })
    const folder = container.querySelector('[data-project-knowledge="p1"]')
    expect(folder).not.toBeNull()
    expect(scopeList()!.contains(folder)).toBe(true)
    expect(before(newChatRow()!, folder!)).toBe(true)
    expect(before(folder!, rowEl('a1'))).toBe(true)
    expect(container.querySelector('[data-bot-knowledge]')).toBeNull()
  })

  it('DR-14 a bot scope shows the bot knowledge folder when the bot has a base', async () => {
    store.sessions = baseSessions()
    const projectKnowledge = knowledgeAdapter()
    await mount({
      drill: drillAt('bot:scout'),
      bots: botsCaps(
        registryOf({ bots: [{ ...bot('scout', 'Scout'), knowledgeBundle: 'bots/k1' }] })
      ),
      projectKnowledge
    })
    const folder = container.querySelector('[data-bot-knowledge="scout"]')
    expect(folder).not.toBeNull()
    expect(before(newChatRow()!, folder!)).toBe(true)
    expect(before(folder!, rowEl('b1'))).toBe(true)
    expect(container.querySelector('[data-project-knowledge]')).toBeNull()
  })

  it('DR-14 a bot without a base, the chats group, and a host without knowledge show no folder', async () => {
    store.sessions = baseSessions()
    const projectKnowledge = knowledgeAdapter()
    await mount({ drill: drillAt('bot:scout'), bots: botsCaps(SCOUT), projectKnowledge })
    expect(container.querySelector('[data-bot-knowledge]')).toBeNull()

    await rerender({ drill: drillAt(TEMP_GROUP_KEY) })
    expect(scopeList()!.getAttribute('data-scope-list')).toBe(TEMP_GROUP_KEY)
    expect(container.querySelector('[data-project-knowledge]')).toBeNull()
    expect(container.querySelector('[data-bot-knowledge]')).toBeNull()

    await rerender({ drill: drillAt('p1'), projectKnowledge: undefined })
    expect(rowIds()).toEqual(['a1', 'a2'])
    expect(container.querySelector('[data-project-knowledge]')).toBeNull()
  })
})

describe('drill inside a group: rows', () => {
  it('DR-15 every row is in the detail form', async () => {
    store.sessions = baseSessions()
    await mount({ drill: drillAt('p1') })
    expect(sessionRows()).toHaveLength(2)
    for (const el of sessionRows()) {
      expect(el.querySelector('[data-session-detail]')).not.toBeNull()
      expect(el.querySelector('[data-session-time]')).not.toBeNull()
    }
  })

  it('DR-16 the time is hours and minutes for today, month and day for earlier', async () => {
    store.sessions = [
      row('a1', { lastActiveAt: Date.now() }),
      row('a2', { lastActiveAt: new Date(2020, 2, 5, 12).getTime() })
    ]
    await mount({ drill: drillAt('p1') })
    expect(timeOf('a1')).toMatch(/^\d{2}:\d{2}$/)
    expect(timeOf('a2')).toBe('03-05')
  })

  it('DR-17 waiting questions win over replying and the last reply', async () => {
    store.sessions = [row('s1'), row('s2')]
    store.pending = { s1: 2, s2: 1 }
    store.streaming = { s1: true }
    api.list.mockImplementation(async () => reply('a finished reply'))
    await mount({ drill: drillAt('p1') })

    expect(previewOf('s1')!.textContent).toBe('2 questions waiting')
    expect(previewOf('s1')!.classList.contains('text-warning')).toBe(true)
    expect(previewOf('s2')!.textContent).toBe('1 question waiting')
    expect(previewOf('s2')!.classList.contains('text-warning')).toBe(true)
  })

  it('DR-18 a session whose turn is running says so, even when a preview was fetched', async () => {
    store.sessions = [row('s1')]
    store.streaming = { s1: true }
    api.list.mockImplementation(async () => reply('a finished reply'))
    await mount({ drill: drillAt('p1') })
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(previewOf('s1')!.textContent).toBe(en.inbox.replying)
    expect(previewOf('s1')!.classList.contains('text-warning')).toBe(false)
  })

  it('DR-19 an idle session shows its last reply as plain text once it is fetched', async () => {
    store.sessions = [row('s1')]
    const pending = deferred<PreviewMessage[]>()
    api.list.mockImplementation(() => pending.promise)
    await mount({ drill: drillAt('p1') })
    expect(previewOf('s1')).toBeNull()

    await act(async () => pending.resolve(reply('**Done** with `x`')))
    await flush()
    expect(previewOf('s1')!.textContent).toBe('Done with x')
    expect(previewOf('s1')!.classList.contains('text-warning')).toBe(false)
  })

  it.each<[string, () => Promise<PreviewMessage[]>]>([
    ['resolves with no messages', async () => []],
    [
      'rejects',
      async () => {
        throw new Error('disconnected')
      }
    ]
  ])('DR-20 idle and the fetch %s: no preview, the time is still shown', async (_label, impl) => {
    store.sessions = [row('s1')]
    api.list.mockImplementation(impl)
    await mount({ drill: drillAt('p1') })
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(previewOf('s1')).toBeNull()
    expect(timeOf('s1')).not.toBeNull()
  })

  it('DR-21 one fetch per top-level session of the group; nothing more on an unchanged re-render', async () => {
    store.sessions = [...baseSessions(), row('c1', { parentId: 'a1', createdAt: 2 })]
    await mount({ drill: drillAt('p1'), bots: botsCaps(SCOUT) })
    expect(calledIds()).toEqual(['a1', 'a2'])

    store.sessions = [...store.sessions]
    await rerender()
    expect(api.list).toHaveBeenCalledTimes(2)
  })

  it.each<[string, () => void]>([
    [
      'its last activity',
      () => {
        store.sessions = store.sessions.map((s) => (s.id === 'a2' ? { ...s, lastActiveAt: 99 } : s))
      }
    ],
    [
      'its turn running',
      () => {
        store.streaming = { a2: true }
      }
    ],
    [
      'when its unread reply arrived',
      () => {
        store.unread = { a2: { since: 5 } as SessionUnread }
      }
    ]
  ])('DR-21 a change to %s refetches that session once', async (_label, change) => {
    store.sessions = baseSessions()
    await mount({ drill: drillAt('p1') })
    expect(calledIds()).toEqual(['a1', 'a2'])

    change()
    await rerender()
    expect(calledIds()).toEqual(['a1', 'a2', 'a2'])
    await rerender()
    expect(api.list).toHaveBeenCalledTimes(3)
  })

  it('DR-22 30 sessions: 30 rows and no view-more', async () => {
    store.sessions = many(30)
    await mount({ drill: drillAt('p1') })
    expect(sessionRows()).toHaveLength(30)
    expect(viewMore()).toBeNull()
  })

  it('DR-22 31 sessions: 30 rows, then view-more shows the last one', async () => {
    store.sessions = many(31)
    await mount({ drill: drillAt('p1') })
    expect(sessionRows()).toHaveLength(30)
    expect(viewMore()!.textContent).toBe(`${S.viewMore}1`)

    await click(viewMore()!)
    expect(sessionRows()).toHaveLength(31)
    expect(viewMore()).toBeNull()
  })

  it('DR-22 55 sessions: view-more adds 20 and leaves 5', async () => {
    store.sessions = many(55)
    await mount({ drill: drillAt('p1') })
    expect(sessionRows()).toHaveLength(30)
    expect(viewMore()!.textContent).toBe(`${S.viewMore}25`)

    await click(viewMore()!)
    expect(sessionRows()).toHaveLength(50)
    expect(viewMore()!.textContent).toBe(`${S.viewMore}5`)
  })

  it('DR-23 previews are fetched for the first 30 sessions only, also after view-more', async () => {
    store.sessions = many(35)
    const first30 = store.sessions.slice(0, 30).map((s) => s.id)
    await mount({ drill: drillAt('p1') })
    expect(calledIds()).toEqual(first30)

    await click(viewMore()!)
    expect(sessionRows()).toHaveLength(35)
    expect(calledIds()).toEqual(first30)
  })

  it('DR-24 an unread session carries its dot in the gutter of the row', async () => {
    store.sessions = [row('s1'), row('s2')]
    store.unread = { s1: { since: 1 } as SessionUnread }
    await mount({ drill: drillAt('p1') })
    const dot = rowEl('s1').querySelector('[data-unread]')
    expect(dot).not.toBeNull()
    expect(dot!.parentElement).toBe(rowEl('s1'))
    expect(dot!.getAttribute('data-unread')).toBe('')
    expect(rowEl('s2').querySelector('[data-unread]')).toBeNull()

    store.unread = { s1: { since: 1, failed: true } as SessionUnread }
    await rerender()
    expect(rowEl('s1').querySelector('[data-unread]')!.getAttribute('data-unread')).toBe('failed')
  })

  it('DR-25 sub-sessions fold under their parent, in the detail form too', async () => {
    store.sessions = [row('a1'), row('c1', { parentId: 'a1', createdAt: 2 })]
    await mount({ drill: drillAt('p1') })

    const parent = rowEl('a1')
    const toggle = parent.querySelector<HTMLElement>('[data-subs-toggle]')
    expect(toggle).not.toBeNull()
    expect(parent.getAttribute('data-subs')).toBe('collapsed')

    await click(toggle!)
    expect(rowEl('a1').getAttribute('data-subs')).toBe('expanded')
    const child = rowEl('c1')
    expect(child.hasAttribute('data-sub')).toBe(true)
    expect(child.querySelector('[data-session-detail]')).not.toBeNull()
  })

  it('DR-26 bot rows say where they work; project rows do not', async () => {
    store.sessions = [
      botRow('b1', 'scout'),
      botRow('b2', 'scout', { workProject: 'p1' }),
      row('a1')
    ]
    await mount({ drill: drillAt('bot:scout'), bots: botsCaps(SCOUT) })
    const location = (id: string): string | null =>
      rowEl(id).querySelector('[data-session-location]')?.textContent ?? null
    expect(location('b1')).toBe(S.botTempLocation)
    expect(location('b2')).toBe('Proj')

    await rerender({ drill: drillAt('p1') })
    expect(rowIds()).toEqual(['a1'])
    expect(rowEl('a1').querySelector('[data-session-location]')).toBeNull()
  })

  it('DR-27 a row click selects through onSelect', async () => {
    store.sessions = baseSessions()
    const onSelect = vi.fn()
    const setActive = vi.fn()
    store.setActiveSessionId = setActive
    await mount({ drill: drillAt('p1'), onSelect })
    await click(rowEl('a2'))
    expect(onSelect.mock.calls).toEqual([['a2']])
    expect(setActive).not.toHaveBeenCalled()
  })

  it('DR-27 without onSelect a row click selects through the store', async () => {
    store.sessions = baseSessions()
    const setActive = vi.fn()
    store.setActiveSessionId = setActive
    await mount({ drill: drillAt('p1') })
    await click(rowEl('a2'))
    expect(setActive.mock.calls).toEqual([['a2']])
  })

  it('DR-27 a context menu on a row opens the session menu', async () => {
    store.sessions = baseSessions()
    await mount({ drill: drillAt('p1') })
    await rightClick(rowEl('a1'))
    expect(menus).toHaveLength(1)
    const ids = menus[0].map((item) => item.id)
    expect(ids).toContain('export-session')
    expect(ids).toContain('delete-session')
  })
})

describe('drill inside a group: empty and gone', () => {
  it('DR-28 a project with no sessions: the empty hint and the new-chat row', async () => {
    store.sessions = [temp('t1')]
    await mount({ drill: drillAt('p1') })
    expect(emptyHint()!.textContent).toBe(en.mobile.scopeEmpty)
    expect(newChatRow()).not.toBeNull()
    expect(sessionRows()).toHaveLength(0)
  })

  it('DR-28 the chats group with no sessions: the empty hint and the new-chat row', async () => {
    store.sessions = [row('a1')]
    await mount({ drill: drillAt(TEMP_GROUP_KEY) })
    expect(emptyHint()!.textContent).toBe(en.mobile.scopeEmpty)
    expect(newChatRow()).not.toBeNull()
    expect(sessionRows()).toHaveLength(0)
  })

  it('DR-28 a bot with no sessions: the empty hint and the new-chat row', async () => {
    await mount({ drill: drillAt('bot:scout'), bots: botsCaps(SCOUT) })
    expect(emptyHint()!.textContent).toBe(en.mobile.scopeEmpty)
    expect(newChatRow()).not.toBeNull()
  })

  it('DR-29 a project that is gone: the gone hint, no new-chat row, no knowledge folder', async () => {
    store.sessions = baseSessions()
    const projectKnowledge = knowledgeAdapter()
    await mount({ drill: drillAt('deleted-project-id'), projectKnowledge })
    expect(scopeList()!.getAttribute('data-scope-list')).toBe('deleted-project-id')
    expect(emptyHint()!.textContent).toBe(en.mobile.scopeGone)
    expect(newChatRow()).toBeNull()
    expect(container.querySelector('[data-project-knowledge]')).toBeNull()
    expect(sessionRows()).toHaveLength(0)
    expect(projectKnowledge.list).not.toHaveBeenCalled()
  })

  it('DR-29 a key from the object prototype is not a project', async () => {
    store.sessions = baseSessions()
    await mount({ drill: drillAt('toString') })
    expect(emptyHint()!.textContent).toBe(en.mobile.scopeGone)
    expect(newChatRow()).toBeNull()
  })

  it('DR-30 a bot that does not exist and has no sessions is gone', async () => {
    store.sessions = baseSessions()
    await mount({ drill: drillAt('bot:nobody'), bots: botsCaps(SCOUT) })
    expect(emptyHint()!.textContent).toBe(en.mobile.scopeGone)
    expect(newChatRow()).toBeNull()
    expect(sessionRows()).toHaveLength(0)
  })

  it('DR-30 while the registry is pending an unknown bot reads as empty, not gone', async () => {
    store.sessions = baseSessions()
    await mount({ drill: drillAt('bot:nobody'), bots: botsCaps(pendingRegistry) })
    expect(emptyHint()!.textContent).toBe(en.mobile.scopeEmpty)
    expect(newChatRow()).toBeNull()
  })

  it('DR-30 a bot whose file is missing but which still has sessions lists them', async () => {
    store.sessions = [botRow('g1', 'ghost'), botRow('g2', 'ghost')]
    await mount({ drill: drillAt('bot:ghost'), bots: botsCaps(SCOUT) })
    expect(rowIds()).toEqual(['g1', 'g2'])
    expect(emptyHint()).toBeNull()
  })

  it('DR-31 an archived bot has no nav row and its group lists nothing', async () => {
    store.sessions = [botRow('o1', 'old'), botRow('o2', 'old'), row('a1')]
    const registry = registryOf({ bots: [bot('scout', 'Scout')], archived: ['old'] })
    await mount({ drill: drillAt(null), bots: botsCaps(registry) })
    expect(navKeys()).toEqual(['bot:scout', 'p1', TEMP_GROUP_KEY])
    expect(container.querySelector('[data-bot-missing-group]')).toBeNull()

    await rerender({ drill: drillAt('bot:old') })
    expect(scopeList()!.getAttribute('data-scope-list')).toBe('bot:old')
    expect(sessionRows()).toHaveLength(0)
    expect(emptyHint()!.textContent).toBe(en.mobile.scopeGone)
    expect(newChatRow()).toBeNull()
    expect(api.list).not.toHaveBeenCalled()
  })

  it('DR-32 leaving a group brings the nav rows back', async () => {
    store.sessions = baseSessions()
    await mount({ drill: drillAt('p1'), bots: botsCaps(SCOUT) })
    expect(scopeList()).not.toBeNull()
    expect(navKeys()).toEqual([])

    await rerender({ drill: drillAt(null) })
    expect(scopeList()).toBeNull()
    expect(navKeys()).toEqual(['bot:scout', 'p1', TEMP_GROUP_KEY])
    expect(sessionRows()).toHaveLength(0)
  })
})

// ─── 桌面（不传 drill） ─────────────────────────────────────

describe('without drill (desktop)', () => {
  it('DR-40 the tree is unchanged: no nav rows, no detail rows, no preview fetches', async () => {
    store.sessions = baseSessions()
    await mount({ bots: botsCaps(SCOUT) })

    expect(container.querySelector('[data-group-nav]')).toBeNull()
    expect(container.querySelector('[data-group-count]')).toBeNull()
    expect(scopeList()).toBeNull()
    expect(container.querySelector('[data-session-detail]')).toBeNull()
    expect(container.querySelector('[data-session-time]')).toBeNull()
    expect(container.querySelector('[data-sidebar-section="temp-nav"]')).toBeNull()
    expect(rowIds()).toEqual(expect.arrayContaining(['a1', 'a2', 't1', 'b1']))
    expect(api.list).not.toHaveBeenCalled()

    const tempHeader = container.querySelector<HTMLElement>('[data-group="temp"]')!
    expect(tempHeader.classList.contains('sb-section')).toBe(true)
    expect(tempHeader.querySelector('[data-group-add]')).not.toBeNull()
  })

  it('DR-40 an expanded project shows 8 rows before view-more', async () => {
    store.sessions = many(10)
    await mount()
    expect(sessionRows()).toHaveLength(8)
    expect(viewMore()!.textContent).toBe(`${S.viewMore}2`)
    expect(api.list).not.toHaveBeenCalled()
  })
})
