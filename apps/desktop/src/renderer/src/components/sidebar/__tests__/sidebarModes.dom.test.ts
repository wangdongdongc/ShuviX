// @vitest-environment jsdom
/**
 * 桌面侧栏的三种画法（components/sidebar/Sidebar.tsx 的 `mode` / `onOpenSession`，jsdom）。
 *
 * 契约：`full`（缺省，桌面）= 共享侧栏 + 窗口拖拽 / 悬浮徽标 + 底部设置栏 + 六个资料库分组（跟踪项 → 智能体 →
 * 安全策略 → Hooks → 技能 → 知识库）；`sessions`（手机「会话」页）= 共享侧栏，不带任何 caps、不画底部设置栏、
 * 不画那六组；`library`（手机「资料库」页）= 不画共享侧栏，只有那六组，装在 `[data-mobile-list]` 里。
 * Bots 不在资料库里了（2026-10-31）：它是共享侧栏的一节（`bots` 能力，bot 会话收在各自 bot 名下），full 与
 * sessions 两种画法都带着它。
 * 侧栏里每一次「打开会话」（点行，同一个再点一次也算；笔记本会话）都先写 store、再告诉 `onOpenSession`；
 * 选中 null（离开会话）不告诉它。换一个 onOpenSession 回调 → 之后用新的；分组的 adapter 引用不变（分组以
 * adapter 为扫描依赖，换引用会重扫）。
 *
 *   DS-1 full：caps {windowDrag, pin}、hideFooter false、groupsPrepend = Tracking, Agent, Policy, Hook, Skill, Knowledge
 *   DS-2 sessions：caps {}、hideFooter true、没有分组
 *   DS-3 library：没有共享侧栏；六组都在 [data-mobile-list] 里
 *   DS-4 拿到的 onSelectSession('s1') 叫两次 → store 写两次、onOpenSession 两次；null 不到 onOpenSession
 *   DS-5 Bots 分节 adapter 的 open('a.md') → onOpenSession(新会话 id)
 *   DS-6 换了回调重渲染 → 用新的；adapter 对象引用不变
 *   DS-7 桌面 bots 能力：newSession 的 session.create 形状、archive 先离开那份文件的笔记本、pickFolderAsProject、
 *        deleteSessions 的确认流程（详见文件末尾那一组）
 *
 * 整个 `@shuvix/app-shell` 换成记 props 的替身（共享 Sidebar 与六个分组、useProjects、useSessionDelete、
 * SessionConfigDialog）；`@shuvix/chat-ui` 只给按 selector 读的 store（setActiveSessionId 是 spy）与 getChatApi；
 * 侧栏自己的三个弹窗（项目编辑 / 技能目录 / 确认框）换成替身；`window.api` 只铺用到的几项。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { REGISTRY_NOTE_PROJECT_IDS } from '@shuvix/chat-protocol/registryNotes'

type Props = Record<string, unknown>

const rec = vi.hoisted(() => ({
  shared: [] as Array<Record<string, unknown>>,
  groups: new Map<string, unknown[]>(),
  confirms: [] as Array<Record<string, unknown>>,
  storeSet: null as unknown as Mock<(id: string | null) => void>,
  state: {
    sessions: [] as Array<{
      id: string
      projectId?: string | null
      parentId?: string | null
      settings: Props
    }>,
    activeSessionId: null as string | null
  },
  /** getChatApi() 交回的那份（DS-7 换成可数的；缺省与之前一样） */
  chatApi: null as unknown as Record<string, Record<string, (...args: never[]) => unknown>>
}))

vi.mock('@shuvix/app-shell', async () => {
  const { createElement: h, Fragment } = await import('react')
  const projectsStub = { projects: [], archivedProjects: [] }
  const group = (name: string) => (props: { adapter: unknown }) => {
    if (!rec.groups.has(name)) rec.groups.set(name, [])
    rec.groups.get(name)!.push(props.adapter)
    return h('div', { 'data-stub-group': name })
  }
  return {
    Sidebar: (props: Props) => {
      rec.shared.push(props)
      return h(
        'div',
        { 'data-stub-shared': '' },
        h(Fragment, null, props.groupsPrepend as never),
        h(Fragment, null, props.overlays as never)
      )
    },
    TrackingGroup: group('Tracking'),
    AgentGroup: group('Agent'),
    PolicyGroup: group('Policy'),
    HookGroup: group('Hook'),
    SkillGroup: group('Skill'),
    KnowledgeGroup: group('Knowledge'),
    // 与真 hook 一样给稳定的引用（它的两张表都是 state）
    useProjects: () => projectsStub,
    useSessionDelete: () => ({ requestDelete: () => undefined, deleteDialog: null }),
    SessionConfigDialog: () => null
  }
})

vi.mock('@shuvix/chat-ui', async () => {
  const { vi: v } = await import('vitest')
  rec.storeSet = v.fn((id: string | null) => {
    rec.state.activeSessionId = id
  })
  const getState = (): Props => ({
    ...rec.state,
    setActiveSessionId: rec.storeSet,
    setSessions: (sessions: typeof rec.state.sessions) => {
      rec.state.sessions = sessions
    }
  })
  return {
    useChatStore: Object.assign((selector: (s: Props) => unknown) => selector(getState()), {
      getState
    }),
    getChatApi: () => rec.chatApi,
    // 会话 fork（行菜单「分支会话」）：这里只看三种形态，fork 本身不走
    useSessionFork: () => ({
      available: false,
      forkSession: async () => undefined,
      forkError: null,
      clearForkError: () => undefined
    }),
    forkRefusalKey: (reason: string) => reason
  }
})

vi.mock('../ProjectEditDialog', () => ({ ProjectEditDialog: () => null }))
vi.mock('../SkillDirDialog', () => ({ SkillDirDialog: () => null }))
vi.mock('../../common/ConfirmDialog', () => ({
  ConfirmDialog: (props: Props) => {
    rec.confirms.push(props)
    return null
  }
}))

import { Sidebar, type SidebarProps } from '../Sidebar'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const GROUP_ORDER = ['Tracking', 'Agent', 'Policy', 'Hook', 'Skill', 'Knowledge']

const api = {
  bot: {
    openNote: vi.fn<(arg: { fileName: string; title?: string }) => Promise<{ id: string }>>(),
    deleteByFile: vi.fn<(arg: { fileName: string }) => Promise<{ success: boolean }>>(),
    archive: vi.fn<(arg: { name: string }) => Promise<{ success: boolean }>>(),
    deleteSessions: vi.fn<(arg: { name: string }) => Promise<unknown>>(),
    list: vi.fn(async () => ({ bots: [], invalid: [] })),
    openFolder: vi.fn()
  },
  app: { openDirectoryDialog: vi.fn<() => Promise<string | null>>() },
  pinChat: { focus: vi.fn() }
}

/** getChatApi() 那份的可数版本（每个用例重建） */
interface FakeChatApi {
  session: {
    list: Mock<() => Promise<typeof rec.state.sessions>>
    create: Mock<(params: Record<string, unknown>) => Promise<{ id: string }>>
  }
  project: {
    list: Mock<() => Promise<Array<{ id: string; path: string }>>>
    create: Mock<(params: { path: string }) => Promise<{ id: string }>>
  }
  app: { openSettings: () => Promise<undefined> }
}
function freshChatApi(): FakeChatApi {
  return {
    session: {
      list: vi.fn(async () => rec.state.sessions),
      create: vi.fn(async (_params: Record<string, unknown>) => ({ id: 'created' }))
    },
    project: {
      list: vi.fn(async (): Promise<Array<{ id: string; path: string }>> => []),
      create: vi.fn(async (_params: { path: string }) => ({ id: 'p' }))
    },
    app: { openSettings: async () => undefined }
  }
}
let chat: FakeChatApi

let container: HTMLDivElement
let root: Root

/** Sidebar 的参数带缺省值（`= {}`），createElement 的重载认不出它的 props 类型 —— 显式收窄成必传 */
const SidebarComponent = Sidebar as (props: SidebarProps) => React.JSX.Element

function render(props: SidebarProps = {}): void {
  act(() => root.render(createElement(SidebarComponent, props)))
}

const lastShared = (): Record<string, unknown> => rec.shared.at(-1)!
const lastAdapter = (name: string): unknown => rec.groups.get(name)?.at(-1)
/** 「Bots」分节的 adapter（交给共享侧栏的 `bots` 能力） */
const botsAdapter = (): unknown => (lastShared().bots as { adapter: unknown } | undefined)?.adapter
const stubGroups = (scope: ParentNode = container): string[] =>
  [...scope.querySelectorAll('[data-stub-group]')].map((el) => el.getAttribute('data-stub-group')!)

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  rec.shared.length = 0
  rec.groups.clear()
  rec.confirms.length = 0
  rec.state.sessions = []
  rec.state.activeSessionId = null
  rec.storeSet.mockClear()
  api.bot.openNote.mockReset()
  api.bot.deleteByFile.mockReset()
  api.bot.archive.mockReset().mockResolvedValue({ success: true })
  api.bot.deleteSessions.mockReset().mockResolvedValue({ success: true, deletedSessions: 0 })
  api.app.openDirectoryDialog.mockReset()
  chat = freshChatApi()
  rec.chatApi = chat as unknown as typeof rec.chatApi
  ;(window as unknown as { api: unknown }).api = api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('desktop Sidebar modes', () => {
  it('DS-1 full: windowDrag + pin caps, the footer, the six library groups in order, and the bots section', () => {
    render()
    expect(lastShared().caps).toEqual({ windowDrag: true, pin: true })
    expect(botsAdapter()).toBeDefined()
    expect(lastShared().hideFooter).toBe(false)
    expect(stubGroups()).toEqual(GROUP_ORDER)
    expect(container.querySelector('[data-mobile-list]')).toBeNull()
  })

  it('DS-2 sessions: no caps, no footer, no groups', () => {
    render({ mode: 'sessions' })
    expect(lastShared().caps).toEqual({})
    expect(lastShared().hideFooter).toBe(true)
    expect(lastShared().groupsPrepend).toBeUndefined()
    expect(stubGroups()).toEqual([])
    expect(rec.groups.size).toBe(0)
  })

  it('DS-3 library: no shared sidebar; the six groups inside [data-mobile-list]', () => {
    render({ mode: 'library' })
    expect(rec.shared).toHaveLength(0)
    expect(container.querySelector('[data-stub-shared]')).toBeNull()
    const list = container.querySelector('[data-mobile-list]')
    expect(list).not.toBeNull()
    expect(stubGroups(list!)).toEqual(GROUP_ORDER)
    expect(stubGroups()).toEqual(GROUP_ORDER)
  })

  it('DS-4 every open — the same session twice too — writes the store and tells onOpenSession; null never reaches it', async () => {
    const onOpenSession = vi.fn()
    render({ mode: 'sessions', onOpenSession })
    const onSelect = lastShared().onSelectSession as (id: string) => void
    act(() => onSelect('s1'))
    act(() => onSelect('s1'))
    expect(rec.storeSet.mock.calls).toEqual([['s1'], ['s1']])
    expect(onOpenSession.mock.calls).toEqual([['s1'], ['s1']])

    // 选中 null（删掉了正开着的那份 bot 文件的笔记本 → 离开它）：store 写 null，onOpenSession 不知道
    act(() => root.unmount())
    root = createRoot(container)
    rec.state.sessions = [
      { id: 'n1', projectId: REGISTRY_NOTE_PROJECT_IDS.bot, settings: { notebookPath: 'a.md' } }
    ]
    rec.state.activeSessionId = 'n1'
    rec.storeSet.mockClear()
    onOpenSession.mockClear()
    api.bot.deleteByFile.mockResolvedValue({ success: true })
    render({ mode: 'sessions', onOpenSession })
    const bots = botsAdapter() as { deleteFile: (fileName: string) => void }
    act(() => bots.deleteFile('a.md'))
    const confirm = rec.confirms.at(-1)
    expect(confirm).toBeDefined()
    await act(async () => {
      ;(confirm!.onConfirm as () => void)()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.bot.deleteByFile).toHaveBeenCalledWith({ fileName: 'a.md' })
    expect(rec.storeSet.mock.calls).toEqual([[null]])
    expect(onOpenSession).not.toHaveBeenCalled()
  })

  it('DS-5 the bots section adapter opening a bot file tells onOpenSession the new session id', async () => {
    const onOpenSession = vi.fn()
    api.bot.openNote.mockResolvedValue({ id: 'note-1' })
    render({ mode: 'sessions', onOpenSession })
    const bots = botsAdapter() as { open: (fileName: string, title?: string) => Promise<void> }
    await act(async () => {
      await bots.open('a.md')
    })
    expect(api.bot.openNote).toHaveBeenCalledWith({ fileName: 'a.md', title: undefined })
    expect(rec.storeSet).toHaveBeenCalledWith('note-1')
    expect(onOpenSession.mock.calls).toEqual([['note-1']])
  })

  it('DS-6 a new callback on re-render is the one used; the adapters keep their identity', async () => {
    const first = vi.fn()
    const second = vi.fn()
    render({ onOpenSession: first })
    const adaptersBefore = GROUP_ORDER.map(lastAdapter)
    const knowledgeBefore = lastShared().projectKnowledge
    const botsBefore = lastShared().bots
    render({ onOpenSession: second })
    expect(GROUP_ORDER.map(lastAdapter)).toEqual(adaptersBefore)
    GROUP_ORDER.forEach((name, i) => expect(lastAdapter(name), name).toBe(adaptersBefore[i]))
    expect(lastShared().projectKnowledge).toBe(knowledgeBefore)
    // 「Bots」分节以 adapter 为扫描依赖：重渲染不换引用
    expect(lastShared().bots).toBe(botsBefore)

    act(() => (lastShared().onSelectSession as (id: string) => void)('s2'))
    expect(second.mock.calls).toEqual([['s2']])
    expect(first).not.toHaveBeenCalled()

    // 分组里的打开也走新的回调（拿的是重渲染之前那份 adapter）
    api.bot.openNote.mockResolvedValue({ id: 'note-2' })
    await act(async () => {
      await (botsBefore as { adapter: { open: (f: string) => Promise<void> } }).adapter.open('b.md')
    })
    expect(second.mock.calls).toEqual([['s2'], ['note-2']])
    expect(first).not.toHaveBeenCalled()
  })
})

/**
 * DS-7 桌面的 bots 能力（交给共享侧栏的 `bots`：adapter + pickFolderAsProject + archivedProjects）：
 *   - newSession(名字, 位置)：项目 → session.create({bot, workProject})；临时 → session.create({bot})（都不带 projectId）；
 *     建好刷新会话列表、选中它（onOpenSession 收到）
 *   - archive：正开着这份文件的 `__bots__` 笔记本 → 先离开它（选中 null），再 window.api.bot.archive({name})；
 *     开着别的就不动选中
 *   - pickFolderAsProject：取消 → null、不碰项目表；同路径已有项目 → 它的 id、不新建；否则新建、回新 id
 *   - deleteSessions：先弹确认框（标题 / 说明带名字与条数）；取消什么都不删；确认 → 开着其中一条（或它的子会话）
 *     就先离开 → window.api.bot.deleteSessions({name}) → 刷新会话列表
 */
describe('DS-7 the desktop bots adapter', () => {
  type Adapter = {
    newSession: (name: string, location: { workProject: string } | { temp: true }) => Promise<void>
    archive: (bot: { name: string; fileName: string }) => void
    deleteSessions: (name: string, count: number) => void
  }
  const caps = (): {
    adapter: Adapter
    pickFolderAsProject: () => Promise<string | null>
    archivedProjects: unknown
  } => lastShared().bots as never

  it('DS-7 newSession: a project location becomes workProject, temporary passes only the bot; the new session is selected', async () => {
    const onOpenSession = vi.fn()
    render({ onOpenSession })
    await act(async () => {
      await caps().adapter.newSession('scout', { workProject: 'p3' })
    })
    await act(async () => {
      await caps().adapter.newSession('scout', { temp: true })
    })
    expect(chat.session.create.mock.calls).toEqual([
      [{ bot: 'scout', workProject: 'p3' }],
      [{ bot: 'scout' }]
    ])
    expect(chat.session.list).toHaveBeenCalledTimes(2)
    expect(rec.storeSet.mock.calls).toEqual([['created'], ['created']])
    expect(onOpenSession.mock.calls).toEqual([['created'], ['created']])
  })

  it('DS-7 the caps carry the archived projects from useProjects', () => {
    render()
    expect(caps().archivedProjects).toEqual([])
    expect(typeof caps().pickFolderAsProject).toBe('function')
  })

  it("DS-7 archive: leaves the open notebook of that bot file first, then archives by name; another file's notebook stays open", async () => {
    rec.state.sessions = [
      {
        id: 'n1',
        projectId: REGISTRY_NOTE_PROJECT_IDS.bot,
        settings: { notebookPath: 'scout.md' }
      },
      { id: 'n2', projectId: REGISTRY_NOTE_PROJECT_IDS.bot, settings: { notebookPath: 'other.md' } }
    ]
    rec.state.activeSessionId = 'n1'
    render()
    act(() => caps().adapter.archive({ name: 'scout', fileName: 'scout.md' }))
    expect(rec.storeSet.mock.calls).toEqual([[null]])
    expect(api.bot.archive.mock.calls).toEqual([[{ name: 'scout' }]])
    expect(rec.storeSet.mock.invocationCallOrder[0]).toBeLessThan(
      api.bot.archive.mock.invocationCallOrder[0]
    )

    rec.storeSet.mockClear()
    rec.state.activeSessionId = 'n2'
    act(() => caps().adapter.archive({ name: 'scout', fileName: 'scout.md' }))
    expect(rec.storeSet).not.toHaveBeenCalled()
    expect(api.bot.archive).toHaveBeenCalledTimes(2)

    // 同一个文件名、却不是 `__bots__` 承载的笔记本：不是那份 bot 文件
    rec.state.sessions = [{ id: 'x', projectId: 'p1', settings: { notebookPath: 'scout.md' } }]
    rec.state.activeSessionId = 'x'
    act(() => caps().adapter.archive({ name: 'scout', fileName: 'scout.md' }))
    expect(rec.storeSet).not.toHaveBeenCalled()
  })

  it('DS-7 pickFolderAsProject: cancel → null; an existing project at that path is reused; otherwise a new one is created', async () => {
    render()
    api.app.openDirectoryDialog.mockResolvedValueOnce(null)
    expect(await caps().pickFolderAsProject()).toBeNull()
    expect(chat.project.list).not.toHaveBeenCalled()
    expect(chat.project.create).not.toHaveBeenCalled()

    api.app.openDirectoryDialog.mockResolvedValueOnce('/work/site')
    chat.project.list.mockResolvedValueOnce([
      { id: 'other', path: '/work/other' },
      { id: 'site', path: '/work/site' }
    ])
    expect(await caps().pickFolderAsProject()).toBe('site')
    expect(chat.project.create).not.toHaveBeenCalled()

    api.app.openDirectoryDialog.mockResolvedValueOnce('/work/new')
    chat.project.create.mockResolvedValueOnce({ id: 'fresh' })
    expect(await caps().pickFolderAsProject()).toBe('fresh')
    expect(chat.project.create.mock.calls).toEqual([[{ path: '/work/new' }]])
    // 只选位置：不顺手建会话
    expect(chat.session.create).not.toHaveBeenCalled()
  })

  it('DS-7 deleteSessions: a confirm dialog first (name + count); cancel deletes nothing', async () => {
    render()
    act(() => caps().adapter.deleteSessions('ghost', 3))
    const confirm = rec.confirms.at(-1)!
    expect(confirm.title).toBe(i18n.t('sidebar.botDeleteSessionsTitle', { name: 'ghost' }))
    expect(confirm.description).toBe(i18n.t('sidebar.botDeleteSessionsDesc', { count: 3 }))
    expect(String(confirm.title)).toContain('ghost')
    expect(String(confirm.description)).toContain('3')
    act(() => (confirm.onCancel as () => void)())
    expect(api.bot.deleteSessions).not.toHaveBeenCalled()
  })

  it.each<[string, string | null, boolean]>([
    ['the open session is one of them', 'g1', true],
    ['the open session is a sub-session of one of them', 'g1c', true],
    ['the open session belongs to another bot', 's1', false],
    ['nothing is open', null, false]
  ])(
    'DS-7 deleteSessions confirmed (%s): leave it if needed, delete by name, refresh the list',
    async (_label, active, leaves) => {
      rec.state.sessions = [
        { id: 'g1', parentId: null, settings: { bot: 'ghost' } },
        { id: 'g1c', parentId: 'g1', settings: {} },
        { id: 's1', parentId: null, settings: { bot: 'scout' } }
      ]
      rec.state.activeSessionId = active
      render()
      act(() => caps().adapter.deleteSessions('ghost', 1))
      const confirm = rec.confirms.at(-1)!
      await act(async () => {
        ;(confirm.onConfirm as () => void)()
        for (let i = 0; i < 4; i++) await Promise.resolve()
      })
      expect(api.bot.deleteSessions.mock.calls).toEqual([[{ name: 'ghost' }]])
      expect(chat.session.list).toHaveBeenCalledTimes(1)
      expect(chat.session.list.mock.invocationCallOrder[0]).toBeGreaterThan(
        api.bot.deleteSessions.mock.invocationCallOrder[0]
      )
      if (leaves) {
        expect(rec.storeSet.mock.calls).toEqual([[null]])
        expect(rec.storeSet.mock.invocationCallOrder[0]).toBeLessThan(
          api.bot.deleteSessions.mock.invocationCallOrder[0]
        )
      } else {
        expect(rec.storeSet).not.toHaveBeenCalled()
      }
    }
  )
})
