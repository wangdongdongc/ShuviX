// @vitest-environment jsdom
/**
 * 「聊天」分节（临时对话，`[data-group="temp"]`）与「项目」分节的空正文（ProjectSessionGroups 单独，jsdom）。
 *
 * 契约：侧栏里（不传 hideEmptyGroups）「聊天」分节常驻 —— 没有临时会话时正文是一行 `[data-temp-new-chat]`「New Chat」，
 * 点它 → onNewChat(null)；分节头多一颗 `[data-group-add]`「+」（title / aria-label 都是「New Chat」），同样 →
 * onNewChat(null)，不弹菜单、不折叠什么。日历（hideEmptyGroups）里没有临时会话就整节不画，有也没有「+」。
 * 「项目」分节（projectsSection）一个项目都没有、且给了 onNewProject 时，正文是一行 `[data-projects-empty]`
 * 「Open a folder as a project」，点它 → onNewProject；不给 onNewProject 就既没有这一行也没有菜单。
 *
 *   PC-1 只有项目会话：聊天分节在项目组之后，正文恰好一行「New Chat」、没有会话行；点它 → onNewChat(null)，
 *        不弹菜单、不折叠
 *   PC-2 有临时会话 → 行照常、没有「New Chat」行；会话来回变，那一行跟着出现 / 消失
 *   PC-3 不论有没有临时会话，聊天分节头都有「+」（title / aria-label「New Chat」），点它 → onNewChat(null) 一次，
 *        不弹菜单、不折叠、行数不变；项目分节头与项目组头都没有「+」—— 没有 bots 时整个容器只有这一颗
 *   PC-4 聊天分节头的菜单（右键 / ⋮ 同一份）只有 new-chat 一项，选它 → onNewChat(null)
 *   PC-5 日历：没有临时会话 → 没有聊天分节、没有「New Chat」行；有 → 行在、没有「New Chat」行、哪里都没有「+」
 *   PC-6 bot 会话（含引用项目的、它们的子会话）都收进 bot 组，不让聊天分节变「非空」；聊天的「+」不碰 bot 的
 *        newSession，bot 组自己的「+」仍开位置选择
 *   PC-7 子会话：父行在项目组里 → 子会话折在它下面，聊天分节仍是「New Chat」；父行在聊天里 → 子会话跟着它；
 *        父行不在列表里 → 子会话平铺在聊天里，聊天分节不空
 *   PC-8 项目分节：没有项目 + onNewProject → 提示行在项目分节头与聊天分节头之间，点它 / 分节头菜单 → onNewProject；
 *        `projectsSection: {}` → 分节头在、没有提示行、没有菜单；有项目 → 没有提示行；不给 projectsSection → 都没有
 *
 * 右键菜单走 ContextMenuProvider 的 `render` 注入（同 projectSessionGroupsBots）：记录每次弹出的菜单；「用户」点哪一项
 * 从 `picks` 队列里按次序取（取空 = 取消）。`@shuvix/chat-ui` 换成替身。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
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
  streaming: {} as Record<string, boolean>,
  interrupted: {} as Record<string, boolean>
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
    selectStreamingSessions: (s: typeof store) => s.streaming,
    useBgTaskStore: () => ({}),
    useUnreadStore: (selector: (s: { unread: Record<string, unknown> }) => unknown) =>
      selector({ unread: {} }),
    selectBgBusySessions: () => ({}),
    selectInterruptedSessions: (s: typeof store) => s.interrupted,
    selectAllPendingCounts: () => ({}),
    useChatHost: () => ({ appearance: { focusMode: false } }),
    useAppEvent: () => {},
    getChatApi: () => ({ message: { list: async () => [] } })
  }
})

import { ProjectSessionGroups, type ProjectSessionGroupsProps } from './ProjectSessionGroups'
import type { BotsSectionCaps } from './ProjectSessionGroups'
import type { BotGroupAdapter, BotGroupItem, BotRegistry } from './useBotRegistry'
import { ContextMenuProvider } from '../contextmenu/ContextMenuProvider'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = { id: 'p1', name: 'Proj' }
const S = en.sidebar

let container: HTMLDivElement
let root: Root
/** 每次弹出的菜单项 */
let menus: ContextMenuItem[][]
/** 「用户」依次点的那几项（取空 = 取消） */
let picks: Array<string | null>
let onNewChat: Mock<(projectId: string | null) => void>
let onToggleGroup: Mock<(key: string) => void>
let onNewProject: Mock<() => void>

/** 在一份菜单（含子菜单）里找一项 */
function findItem(items: ContextMenuItem[], id: string): ContextMenuItem | undefined {
  for (const item of items) {
    if (item.id === id) return item
    const inSub = item.submenu ? findItem(item.submenu, id) : undefined
    if (inSub) return inSub
  }
  return undefined
}

function bot(name: string, displayName = name, fileName = `${name}.md`): BotGroupItem {
  return { name, displayName, description: '', fileName }
}

/** 注入的 adapter：每个能力都是可数的 spy */
interface FakeAdapter extends BotGroupAdapter {
  list: Mock<() => Promise<BotRegistry>>
  newSession: Mock<BotGroupAdapter['newSession']>
}

function makeAdapter(registry: BotRegistry): FakeAdapter {
  return {
    list: vi.fn(async () => registry),
    open: vi.fn(),
    create: vi.fn(),
    openFolder: vi.fn(),
    newSession: vi.fn(),
    archive: vi.fn(),
    deleteFile: vi.fn(),
    deleteSessions: vi.fn()
  }
}

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
/** 一条 bot 会话（只归属 bot；settings 里可带 workProject） */
const botRow = (
  id: string,
  name: string,
  settings: Record<string, unknown> = {},
  over: Partial<StoreSession> = {}
): StoreSession => row(id, { settings: { bot: name, ...settings }, ...over })

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** 缺省：项目 [p1]、projectsSection 带 onNewProject、onNewChat / onToggleGroup 是 spy、不是日历 */
async function mount(
  bots: Partial<BotsSectionCaps> | undefined,
  props: Partial<ProjectSessionGroupsProps> = {}
): Promise<void> {
  type ProviderProps = ComponentProps<typeof ContextMenuProvider>
  const provider: Omit<ProviderProps, 'children'> = {
    render: async (items: ContextMenuItem[]) => {
      menus.push(items)
      const id = picks.length > 0 ? picks.shift()! : null
      if (id === null) return null
      const hit = findItem(items, id)
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
          onToggleGroup,
          onNewChat,
          onDelete: () => {},
          onEditProject: () => {},
          projectsSection: { onNewProject },
          ...(bots ? { bots: bots as BotsSectionCaps } : {}),
          ...props
        })
      )
    )
  )
  await flush()
}

/** 一个容器里的会话行（按标题里的 id；标题是行里第一个 truncate 的 span） */
const rowIds = (el: Element): string[] =>
  [...el.querySelectorAll('[data-session-row]')].map(
    (r) => /^Title (.+)$/.exec(r.querySelector('span.truncate')?.textContent ?? '')?.[1] ?? '?'
  )
const rowEl = (id: string): HTMLElement => {
  const found = [...container.querySelectorAll<HTMLElement>('[data-session-row]')].find((el) =>
    el.textContent?.includes(`Title ${id}`)
  )
  if (!found) throw new Error(`row ${id} not rendered`)
  return found
}
/** 聊天分节头 */
const chatsHeader = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-group="temp"]')
/** 聊天分节（分节头的父节点：头 + 正文） */
const chatsBox = (): HTMLElement => {
  const header = chatsHeader()
  if (!header) throw new Error('Chats section not rendered')
  return header.parentElement!
}
/** 「项目」/「Bots」分节头 */
const sectionHeader = (label: string): HTMLElement | null =>
  [...container.querySelectorAll<HTMLElement>('[data-group="section"]')].find((el) =>
    el.textContent?.startsWith(label)
  ) ?? null
/** 一个项目组的容器（组头的父节点） */
const projectGroupBox = (name: string): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('[data-group="project"]')].find((el) =>
    el.textContent?.includes(name)
  )!.parentElement!
const groupEl = (name: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[data-bot-group="${name}"]`)
  if (!el) throw new Error(`bot group ${name} not rendered`)
  return el
}
const chatsAdd = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-group="temp"] [data-group-add]')
/** a 在 DOM 里排在 b 前面 */
const before = (a: Element, b: Element): boolean =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

async function rightClick(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await flush()
}
async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await flush()
}
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
  picks = []
  onNewChat = vi.fn()
  onToggleGroup = vi.fn()
  onNewProject = vi.fn()
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

// ─── PC-1 / PC-2 ─────────────────────────────────────

describe('PC-1 / PC-2 聊天分节的正文', () => {
  it('PC-1 只有项目会话：聊天分节在项目组之后，正文恰好一行 New Chat；点它 → onNewChat(null)，不弹菜单、不折叠', async () => {
    store.sessions = [row('m1', { projectId: 'p1' })]
    await mount(undefined)

    const header = chatsHeader()
    expect(header).not.toBeNull()
    expect(header!.textContent?.startsWith(S.tempChats)).toBe(true)
    expect(before(container.querySelector('[data-group="project"]')!, header!)).toBe(true)

    const box = chatsBox()
    const newChat = box.querySelectorAll<HTMLElement>('[data-temp-new-chat]')
    expect(newChat).toHaveLength(1)
    expect(newChat[0].textContent).toBe(S.newChat)
    expect(rowIds(box)).toEqual([])

    await click(newChat[0])
    expect(onNewChat.mock.calls).toEqual([[null]])
    expect(menus).toEqual([])
    expect(onToggleGroup).not.toHaveBeenCalled()
  })

  it('PC-2 有临时会话 → 行照常、没有 New Chat 行；会话来回变，那一行跟着出现 / 消失', async () => {
    store.sessions = [row('t1'), row('t2'), row('m1', { projectId: 'p1' })]
    await mount(undefined)
    expect(rowIds(chatsBox())).toEqual(['t1', 't2'])
    expect(container.querySelector('[data-temp-new-chat]')).toBeNull()

    store.sessions = [row('m1', { projectId: 'p1' })]
    await mount(undefined)
    expect(rowIds(chatsBox())).toEqual([])
    expect(chatsBox().querySelector('[data-temp-new-chat]')).not.toBeNull()

    store.sessions = [row('t1')]
    await mount(undefined)
    expect(container.querySelector('[data-temp-new-chat]')).toBeNull()
    expect(rowIds(chatsBox())).toEqual(['t1'])
  })
})

// ─── PC-3 / PC-4 ─────────────────────────────────────

describe('PC-3 / PC-4 聊天分节头的「+」与菜单', () => {
  it.each([
    ['without temporary sessions', (): StoreSession[] => [row('m1', { projectId: 'p1' })]],
    ['with temporary sessions', (): StoreSession[] => [row('t1'), row('m1', { projectId: 'p1' })]]
  ])(
    'PC-3 %s: the Chats header has a "+" (New Chat) → onNewChat(null) once, no menu, no toggle',
    async (_label, sessions) => {
      store.sessions = sessions()
      await mount(undefined)

      const add = chatsAdd()
      expect(add).not.toBeNull()
      expect(add!.getAttribute('title')).toBe(S.newChat)
      expect(add!.getAttribute('aria-label')).toBe(S.newChat)
      expect(chatsHeader()!.querySelector('[data-has-add]')).not.toBeNull()

      const rowsBefore = container.querySelectorAll('[data-session-row]').length
      await click(add!)
      expect(onNewChat.mock.calls).toEqual([[null]])
      expect(menus).toEqual([])
      expect(onToggleGroup).not.toHaveBeenCalled()
      expect(container.querySelectorAll('[data-session-row]')).toHaveLength(rowsBefore)

      // 只有聊天分节头有「+」：项目分节头、项目组头都没有
      expect(sectionHeader(S.projects)!.querySelector('[data-group-add]')).toBeNull()
      expect(sectionHeader(S.projects)!.querySelector('[data-has-add]')).toBeNull()
      expect(
        container.querySelector('[data-group="project"]')!.querySelector('[data-group-add]')
      ).toBeNull()
      expect(container.querySelectorAll('[data-group-add]')).toHaveLength(1)
    }
  )

  it('PC-4 没有临时会话：右键聊天分节头 → 只有 new-chat；选它 → onNewChat(null)；⋮ 打开同一份', async () => {
    await mount(undefined)

    picks = ['new-chat']
    await rightClick(chatsHeader()!)
    expect(menus).toHaveLength(1)
    expect(ids(menus[0])).toEqual(['new-chat'])
    expect(menus[0][0].label).toBe(S.newChat)
    expect(onNewChat.mock.calls).toEqual([[null]])

    const more = [...chatsHeader()!.querySelectorAll<HTMLElement>('button')].find(
      (b) => b.getAttribute('aria-label') === S.moreActions
    )
    expect(more).toBeDefined()
    await click(more!)
    expect(menus).toHaveLength(2)
    expect(menus[1]).toEqual(menus[0])
    // 取空 = 取消：这一次什么都不建
    expect(onNewChat).toHaveBeenCalledTimes(1)
  })
})

// ─── PC-5 ─────────────────────────────────────

describe('PC-5 日历（hideEmptyGroups）', () => {
  const calendar = (sessions: StoreSession[]): Partial<ProjectSessionGroupsProps> => ({
    hideEmptyGroups: true,
    sessionsOverride: sessions as never,
    projectsSection: undefined
  })

  it.each([
    ['only a project session', (): StoreSession[] => [row('m1', { projectId: 'p1' })]],
    ['no session at all', (): StoreSession[] => []]
  ])('PC-5 %s that day → no Chats section, no New Chat row', async (_label, sessions) => {
    store.sessions = sessions()
    await mount(
      { adapter: makeAdapter({ bots: [bot('scout')], shadowed: [], invalid: [] }) },
      calendar(store.sessions)
    )
    expect(chatsHeader()).toBeNull()
    expect(container.querySelector('[data-temp-new-chat]')).toBeNull()
  })

  it('PC-5 a temporary session that day → its row, no New Chat row, and no "+" anywhere', async () => {
    store.sessions = [row('t1'), botRow('b1', 'scout')]
    await mount(
      { adapter: makeAdapter({ bots: [bot('scout')], shadowed: [], invalid: [] }) },
      calendar(store.sessions)
    )
    expect(chatsHeader()).not.toBeNull()
    expect(rowIds(chatsBox())).toEqual(['t1'])
    expect(container.querySelector('[data-temp-new-chat]')).toBeNull()
    expect(container.querySelector('[data-group-add]')).toBeNull()
  })
})

// ─── PC-6 / PC-7 ─────────────────────────────────────

describe('PC-6 / PC-7 bot 会话与子会话不让聊天分节变「非空」', () => {
  it('PC-6 bot 会话（含引用项目的、子会话）都在 bot 组里；聊天的「+」不碰 newSession，bot 组的「+」仍开位置选择', async () => {
    store.sessions = [
      botRow('b1', 'scout'),
      botRow('b2', 'scout', { workProject: 'p1' }),
      row('b1c', { parentId: 'b1', createdAt: 2 })
    ]
    const adapter = makeAdapter({ bots: [bot('scout')], shadowed: [], invalid: [] })
    await mount({ adapter })

    expect(chatsBox().querySelector('[data-temp-new-chat]')).not.toBeNull()
    expect(rowIds(chatsBox())).toEqual([])
    expect(rowIds(groupEl('scout'))).toEqual(['b1', 'b1c', 'b2'])
    expect(rowEl('b1c').hasAttribute('data-sub')).toBe(true)

    await click(chatsAdd()!)
    expect(onNewChat.mock.calls).toEqual([[null]])
    expect(adapter.newSession).not.toHaveBeenCalled()
    expect(menus).toEqual([])

    await click(groupEl('scout').querySelector('[data-group-add]')!)
    expect(menus).toHaveLength(1)
    expect(menus[0][0].id).toBe('where')
    expect(onNewChat).toHaveBeenCalledTimes(1)
  })

  it('PC-7 父行在项目组里 → 子会话折在它下面（即便子会话自己没有项目），聊天分节仍是 New Chat', async () => {
    store.sessions = [
      row('m1', { projectId: 'p1' }),
      row('m1c', { parentId: 'm1', projectId: null, createdAt: 2 })
    ]
    await mount(undefined)
    expect(rowIds(projectGroupBox('Proj'))).toEqual(['m1', 'm1c'])
    expect(rowEl('m1c').hasAttribute('data-sub')).toBe(true)
    expect(chatsBox().querySelector('[data-temp-new-chat]')).not.toBeNull()
    expect(rowIds(chatsBox())).toEqual([])
  })

  it('PC-7 父行在聊天里 → 子会话跟着它，没有 New Chat 行', async () => {
    store.sessions = [row('tp'), row('tc', { parentId: 'tp', createdAt: 2 })]
    await mount(undefined)
    expect(rowIds(chatsBox())).toEqual(['tp', 'tc'])
    expect(rowEl('tc').hasAttribute('data-sub')).toBe(true)
    expect(container.querySelector('[data-temp-new-chat]')).toBeNull()
  })

  it('PC-7 父行不在列表里 → 子会话平铺在聊天里，没有 New Chat 行', async () => {
    store.sessions = [row('orphan', { parentId: 'gone', projectId: null })]
    await mount(undefined)
    expect(rowIds(chatsBox())).toEqual(['orphan'])
    expect(rowEl('orphan').hasAttribute('data-sub')).toBe(false)
    expect(container.querySelector('[data-temp-new-chat]')).toBeNull()
  })
})

// ─── PC-8 ─────────────────────────────────────

describe('PC-8 项目分节的空正文', () => {
  it('PC-8 没有项目 + onNewProject：提示行在项目分节头与聊天分节头之间；点它 / 分节头菜单 → onNewProject', async () => {
    await mount(undefined, { projects: [] })

    const projects = sectionHeader(S.projects)
    const hint = container.querySelector<HTMLElement>('[data-projects-empty]')
    expect(projects).not.toBeNull()
    expect(hint).not.toBeNull()
    expect(hint!.textContent).toBe(S.emptyHint)
    expect(before(projects!, hint!)).toBe(true)
    expect(before(hint!, chatsHeader()!)).toBe(true)

    await click(hint!)
    expect(onNewProject).toHaveBeenCalledTimes(1)
    expect(onNewChat).not.toHaveBeenCalled()

    picks = ['new-project']
    await rightClick(projects!)
    expect(menus).toHaveLength(1)
    expect(ids(menus[0])).toEqual(['new-project'])
    expect(onNewProject).toHaveBeenCalledTimes(2)
    expect(onNewChat).not.toHaveBeenCalled()
  })

  it('PC-8 没有项目、projectsSection 不给 onNewProject：分节头在，没有提示行，右键没有菜单', async () => {
    await mount(undefined, { projects: [], projectsSection: {} })
    expect(sectionHeader(S.projects)).not.toBeNull()
    expect(container.querySelector('[data-projects-empty]')).toBeNull()
    await rightClick(sectionHeader(S.projects)!)
    expect(menus).toEqual([])
  })

  it('PC-8 有项目 + onNewProject：没有提示行', async () => {
    await mount(undefined, { projects: [PROJECT] })
    expect(container.querySelector('[data-group="project"]')).not.toBeNull()
    expect(container.querySelector('[data-projects-empty]')).toBeNull()
  })

  it('PC-8 不给 projectsSection、没有项目：没有项目分节头，也没有提示行', async () => {
    await mount(undefined, { projects: [], projectsSection: undefined })
    expect(sectionHeader(S.projects)).toBeNull()
    expect(container.querySelector('[data-projects-empty]')).toBeNull()
    // 聊天分节照样在
    expect(chatsBox().querySelector('[data-temp-new-chat]')).not.toBeNull()
  })
})
