// @vitest-environment jsdom
/**
 * 桌面侧栏的三种画法（components/sidebar/Sidebar.tsx 的 `mode` / `onOpenSession`，jsdom）。
 *
 * 契约：`full`（缺省，桌面）= 共享侧栏 + 窗口拖拽 / 悬浮徽标 + 底部设置栏 + 五个资料库分组（智能体 →
 * 安全策略 → Hooks → 技能 → 知识库；跟踪项 2026-11-10 起在收件箱页里，桌面侧栏没有这一组了）；`sessions`（手机
 * 「会话」页）= 共享侧栏，不带任何 caps、不画底部设置栏、不画那几组；`library`（手机「资料库」页）= 不画共享侧栏，
 * 只有那五组（跟踪项在收件箱页里），装在 `[data-mobile-list]` 里；给了 `libraryDrill`（两层导航）时那五组分在两张
 * `[data-library-card]` 里（智能体 / 技能 / 知识库，安全策略 / Hooks），各组都拿到同一个 `drill`。
 * Bots 不在资料库里了（2026-10-31）：它是共享侧栏的一节（`bots` 能力，bot 会话收在各自 bot 名下），full 与
 * sessions 两种画法都带着它。
 * 侧栏里每一次「打开会话」（点行，同一个再点一次也算；笔记本会话）都先写 store、再告诉 `onOpenSession`；
 * 选中 null（离开会话）不告诉它。换一个 onOpenSession 回调 → 之后用新的；分组的 adapter 引用不变（分组以
 * adapter 为扫描依赖，换引用会重扫）。
 *
 *   DS-1 full：caps {windowDrag, pin}、hideFooter false、groupsPrepend = Agent, Policy, Hook, Skill, Knowledge（没有 Tracking）
 *   DS-2 sessions：caps {}、hideFooter true、没有分组
 *   DS-3 library（不给 libraryDrill）：没有共享侧栏；五组按桌面的顺序在 [data-mobile-list] 里，没有 Tracking、
 *        没有 [data-library-card]，各组的 drill 是 undefined
 *   DS-4 拿到的 onSelectSession('s1') 叫两次 → store 写两次、onOpenSession 两次；null 不到 onOpenSession
 *   DS-5 Bots 分节 adapter 的 open('a.md') → onOpenSession(新会话 id)
 *   DS-6 换了回调重渲染 → 用新的；adapter 对象引用不变
 *   DS-7 桌面 bots 能力：newSession 的 session.create 形状、archive 先离开那份文件的笔记本、pickFolderAsProject、
 *        deleteSessions 的确认流程（详见文件末尾那一组）
 *   SE-1 / SE-2 「项目配置」的开法（2026-11-16）：不给 `onEditProject` = 桌面那个居中的对话框；给了（手机布局）就只
 *        调它、不挂对话框
 *   DS-V1..19 侧栏的三种视图（2026-11-16，只在 full）：顶上那一行是视图切换（条数 = 等你回答 + 新回复，有在等的才带点）；
 *        切到收件箱 / 日历 → 会话列表藏起来（`hideList`），那一种视图头一次用到才挂、之后一直挂着只切显示；
 *        sessions / library 没有切换、没有这两块。原先侧栏里的「收件箱」那一行（开右侧面板）没有了
 *
 * 整个 `@shuvix/app-shell` 换成记 props 的替身（共享 Sidebar 与六个分组、视图切换、收件箱面板、useInboxSections、
 * useProjects、useSessionDelete、SessionConfigDialog）；日历面板、跟踪项 adapter、视图 store 也是替身（store 的 hook
 * 不会让组件重渲染，改了视图就再 `render()` 一次）；`@shuvix/chat-ui` 只给按 selector 读的 store（setActiveSessionId
 * 是 spy）与 getChatApi；侧栏自己的三个弹窗（项目编辑 / 技能目录 / 确认框）换成替身；`window.api` 只铺用到的几项。
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
  /** 各分组替身每次渲染收到的 `drill` */
  groupDrills: new Map<string, unknown[]>(),
  /** 各分组替身挂上了几次（重挂 = 扫到的清单丢了） */
  groupMounts: new Map<string, number>(),
  confirms: [] as Array<Record<string, unknown>>,
  /** 项目编辑对话框的替身每次渲染收到的 props */
  projectDialogs: [] as Array<Record<string, unknown>>,
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
  chatApi: null as unknown as Record<string, Record<string, (...args: never[]) => unknown>>,
  /** 视图切换的替身每次渲染收到的 props */
  viewSwitch: [] as Array<Record<string, unknown>>,
  /** 收件箱面板 / 日历面板的替身每次渲染收到的 props，与各自挂上了几次 */
  inboxPanel: [] as Array<Record<string, unknown>>,
  calendarPanel: [] as Array<Record<string, unknown>>,
  inboxMounts: 0,
  calendarMounts: 0,
  /** useInboxSections 的替身交回的三节，与每次调用收到的参数 */
  sections: { waiting: [] as unknown[], unread: [] as unknown[], running: [] as unknown[] },
  sectionsArgs: [] as unknown[][],
  /** 视图 store 的替身 */
  view: 'sessions' as string,
  setView: null as unknown as Mock<(view: string) => void>,
  /** useTrackingAdapter 的替身：收到的 select 与交回的那一份 */
  trackingSelects: [] as unknown[],
  trackingAdapter: { tracking: 'adapter' } as Record<string, unknown>
}))

vi.mock('@shuvix/app-shell', async () => {
  const { createElement: h, Fragment, useEffect } = await import('react')
  const projectsStub = { projects: [], archivedProjects: [] }
  const group = (name: string) => (props: { adapter: unknown; drill?: unknown }) => {
    if (!rec.groups.has(name)) rec.groups.set(name, [])
    rec.groups.get(name)!.push(props.adapter)
    if (!rec.groupDrills.has(name)) rec.groupDrills.set(name, [])
    rec.groupDrills.get(name)!.push(props.drill)
    useEffect(() => {
      rec.groupMounts.set(name, (rec.groupMounts.get(name) ?? 0) + 1)
    }, [])
    return h('div', { 'data-stub-group': name })
  }
  return {
    Sidebar: (props: Props) => {
      rec.shared.push(props)
      return h(
        'div',
        { 'data-stub-shared': '' },
        h(Fragment, null, props.header as never),
        h(Fragment, null, props.groupsPrepend as never),
        h(Fragment, null, props.extraViews as never),
        h(Fragment, null, props.overlays as never)
      )
    },
    SidebarViewSwitch: (props: Record<string, unknown>) => {
      rec.viewSwitch.push(props)
      return h('div', { 'data-stub-view-switch': '' })
    },
    InboxPanel: (props: Record<string, unknown>) => {
      rec.inboxPanel.push(props)
      useEffect(() => {
        rec.inboxMounts++
      }, [])
      return h('div', { 'data-stub-inbox-panel': '' })
    },
    useInboxSections: (...args: unknown[]) => {
      rec.sectionsArgs.push(args)
      return rec.sections
    },
    toSidebarView: (value: unknown) => value,
    TrackingGroup: group('Tracking'),
    AgentGroup: group('Agent'),
    PolicyGroup: group('Policy'),
    HookGroup: group('Hook'),
    SkillGroup: group('Skill'),
    KnowledgeGroup: group('Knowledge'),
    // 侧栏按它认「知识库某个库的那一页」比「知识库那一页」深一层（滚动位置）
    LIBRARY_KNOWLEDGE_BASE_PREFIX: 'knowledge:',
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

vi.mock('../../../stores/sidebarViewStore', async () => {
  const { vi: v } = await import('vitest')
  rec.setView = v.fn((view: string) => {
    rec.view = view
  })
  return {
    useSidebarViewStore: (selector: (st: Props) => unknown) =>
      selector({ view: rec.view, setView: rec.setView })
  }
})
vi.mock('../../../host/useTrackingAdapter', () => ({
  useTrackingAdapter: (select: unknown) => {
    rec.trackingSelects.push(select)
    return rec.trackingAdapter
  }
}))
vi.mock('../../browser/CalendarPanel', async () => {
  const { createElement: h, useEffect } = await import('react')
  return {
    CalendarPanel: (props: Record<string, unknown>) => {
      rec.calendarPanel.push(props)
      useEffect(() => {
        rec.calendarMounts++
      }, [])
      return h('div', { 'data-stub-calendar-panel': '' })
    }
  }
})
vi.mock('../ProjectEditDialog', () => ({
  ProjectEditDialog: (props: Props) => {
    rec.projectDialogs.push(props)
    return null
  }
}))
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

/** 桌面侧栏资料库里的那几组（跟踪项不在：它在收件箱页） */
const GROUP_ORDER = ['Agent', 'Policy', 'Hook', 'Skill', 'Knowledge']

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
/** 某一组的替身最近一次收到的 `drill` */
const lastDrill = (name: string): unknown => rec.groupDrills.get(name)?.at(-1)
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
  rec.groupDrills.clear()
  rec.groupMounts.clear()
  rec.confirms.length = 0
  rec.projectDialogs.length = 0
  rec.state.sessions = []
  rec.state.activeSessionId = null
  rec.storeSet.mockClear()
  rec.viewSwitch.length = 0
  rec.inboxPanel.length = 0
  rec.calendarPanel.length = 0
  rec.inboxMounts = 0
  rec.calendarMounts = 0
  rec.sections = { waiting: [], unread: [], running: [] }
  rec.sectionsArgs.length = 0
  rec.view = 'sessions'
  rec.setView.mockClear()
  rec.trackingSelects.length = 0
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
  it('DS-1 full: windowDrag + pin caps, the footer, the five library groups in order (no Tracking), and the bots section', () => {
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

  it('DS-3 library without libraryDrill: no shared sidebar; the five groups in the desktop order inside [data-mobile-list], no Tracking, no cards, no drill', () => {
    render({ mode: 'library' })
    expect(rec.shared).toHaveLength(0)
    expect(container.querySelector('[data-stub-shared]')).toBeNull()
    const list = container.querySelector('[data-mobile-list]')
    expect(list).not.toBeNull()
    expect(stubGroups(list!)).toEqual(GROUP_ORDER)
    expect(stubGroups()).toEqual(GROUP_ORDER)
    expect(rec.groups.has('Tracking')).toBe(false)
    expect(container.querySelector('[data-library-card]')).toBeNull()
    for (const name of GROUP_ORDER) expect(lastDrill(name), name).toBeUndefined()
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

/** 把视图 store 换到 `view` 并重渲染（替身的 hook 不会自己让组件重渲染） */
function switchTo(view: string, props: SidebarProps = {}): void {
  rec.view = view
  render(props)
}
const lastSwitch = (): Record<string, unknown> => rec.viewSwitch.at(-1)!
const pane = (key: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-sidebar-view-pane="${key}"]`)
const panes = (): string[] =>
  [...container.querySelectorAll('[data-sidebar-view-pane]')].map(
    (el) => el.getAttribute('data-sidebar-view-pane')!
  )

describe('DS-V the three sidebar views (full only)', () => {
  it('DS-V1 full, sessions view: the header is the view switch wired to the store; the list shows', () => {
    render()
    expect(container.querySelectorAll('[data-stub-view-switch]')).toHaveLength(1)
    const header = lastShared().header as { props: Record<string, unknown> }
    expect(header.props.value).toBe('sessions')
    expect(lastSwitch().value).toBe('sessions')
    expect(lastSwitch().onChange).toBe(rec.setView)
    expect(lastSwitch().size).toBeUndefined()
    expect(lastShared().hideList).toBe(false)
    expect(lastShared().extraViews).toBeDefined()
  })

  it.each<[number, number, number, number, boolean]>([
    [0, 0, 2, 0, false],
    [0, 3, 0, 3, false],
    [2, 0, 0, 2, true],
    [1, 4, 5, 5, true]
  ])(
    'DS-V2 waiting %i, unread %i, running %i → count %i, alert %s',
    (waiting, unread, running, count, alert) => {
      const rows = (n: number): unknown[] => Array.from({ length: n }, (_, i) => ({ id: i }))
      rec.sections = { waiting: rows(waiting), unread: rows(unread), running: rows(running) }
      render()
      expect(lastSwitch().inboxCount).toBe(count)
      expect(lastSwitch().inboxAlert).toBe(alert)
    }
  )

  it('DS-V3 the count is taken without a held row', () => {
    render()
    expect(rec.sectionsArgs.length).toBeGreaterThan(0)
    for (const args of rec.sectionsArgs) expect(args[0]).toBeUndefined()
  })

  it.each([['inbox'], ['calendar']])('DS-V4 full, %s view: the list is hidden', (view) => {
    rec.view = view
    render()
    expect(lastShared().hideList).toBe(true)
    expect(lastSwitch().value).toBe(view)
  })

  it('DS-V5 the switch changes only the view', () => {
    render()
    act(() => (lastSwitch().onChange as (v: string) => void)('calendar'))
    expect(rec.setView.mock.calls).toEqual([['calendar']])
    expect(rec.storeSet).not.toHaveBeenCalled()
  })

  it('DS-V6 full, sessions view from the start: neither pane is mounted', () => {
    render()
    expect(panes()).toEqual([])
    expect(rec.inboxPanel).toHaveLength(0)
    expect(rec.calendarPanel).toHaveLength(0)
  })

  it('DS-V7..11 a pane mounts on first use and then stays, only its display changes', () => {
    render()
    switchTo('inbox')
    // V7
    expect(panes()).toEqual(['inbox'])
    const inboxPane = pane('inbox')!
    expect(inboxPane.style.display).toBe('')
    expect(inboxPane.querySelector('[data-stub-inbox-panel]')).not.toBeNull()
    expect(rec.inboxPanel.at(-1)!.tracking).toBe(rec.trackingAdapter)
    expect('onSelectSession' in rec.inboxPanel.at(-1)!).toBe(false)
    expect(Object.keys(rec.inboxPanel.at(-1)!)).toEqual(['tracking'])
    expect(rec.calendarPanel).toHaveLength(0)
    // V8
    expect(rec.trackingSelects.length).toBeGreaterThan(0)
    for (const select of rec.trackingSelects) expect(select).toBe(rec.storeSet)

    // V9
    switchTo('calendar')
    expect(panes()).toEqual(['inbox', 'calendar'])
    expect(pane('inbox')!.style.display).toBe('none')
    expect(pane('calendar')!.style.display).toBe('')
    expect(pane('calendar')!.querySelector('[data-stub-calendar-panel]')).not.toBeNull()
    for (const props of rec.calendarPanel) {
      expect('mobile' in props).toBe(false)
      expect('onOpenSession' in props).toBe(false)
    }
    expect(lastShared().hideList).toBe(true)

    // V10
    switchTo('sessions')
    expect(panes()).toEqual(['inbox', 'calendar'])
    expect(pane('inbox')!.style.display).toBe('none')
    expect(pane('calendar')!.style.display).toBe('none')
    expect(rec.inboxMounts).toBe(1)
    expect(rec.calendarMounts).toBe(1)
    expect(lastShared().hideList).toBe(false)

    // V11
    switchTo('inbox')
    expect(pane('inbox')).toBe(inboxPane)
    expect(inboxPane.style.display).toBe('')
    expect(pane('calendar')!.style.display).toBe('none')
    expect(rec.inboxMounts).toBe(1)
    expect(rec.calendarMounts).toBe(1)
    // V19：交给收件箱的 adapter 从头到尾是同一个
    for (const props of rec.inboxPanel) expect(props.tracking).toBe(rec.trackingAdapter)
  })

  it('DS-V12 the inbox as the initial view: mounted and shown on the first render', () => {
    rec.view = 'inbox'
    render()
    expect(rec.shared[0].hideList).toBe(true)
    expect(panes()).toEqual(['inbox'])
    expect(pane('inbox')!.style.display).toBe('')
    expect(rec.calendarPanel).toHaveLength(0)
    expect(rec.inboxMounts).toBe(1)
  })

  it('DS-V13 the calendar as the initial view: mirror', () => {
    rec.view = 'calendar'
    render()
    expect(rec.shared[0].hideList).toBe(true)
    expect(panes()).toEqual(['calendar'])
    expect(pane('calendar')!.style.display).toBe('')
    expect(rec.inboxPanel).toHaveLength(0)
    expect(rec.calendarMounts).toBe(1)
  })

  it('DS-V14 the panes are inbox then calendar whichever was opened first', () => {
    render()
    switchTo('calendar')
    expect(panes()).toEqual(['calendar'])
    switchTo('inbox')
    expect(panes()).toEqual(['inbox', 'calendar'])
    expect(pane('inbox')!.style.display).toBe('')
    expect(pane('calendar')!.style.display).toBe('none')
    expect(rec.calendarMounts).toBe(1)
  })

  it('DS-V15 full: no inbox row — the Library heading is followed directly by the five groups', () => {
    render()
    const heading = container.querySelector('[data-sidebar-section="library"]')!
    expect(heading.textContent).toBe(en.sidebar.library)
    const following: string[] = []
    for (let el = heading.nextElementSibling; el; el = el.nextElementSibling) {
      if (!el.hasAttribute('data-stub-group')) break
      following.push(el.getAttribute('data-stub-group')!)
    }
    expect(following).toEqual(GROUP_ORDER)
    expect(heading.nextElementSibling!.getAttribute('data-stub-group')).toBe('Agent')
    expect(container.querySelector('[data-inbox-row]')).toBeNull()
  })

  it('DS-V16 sessions with the store on inbox: no switch, no panes, the list shows', () => {
    rec.view = 'inbox'
    render({ mode: 'sessions' })
    expect(lastShared().header).toBeUndefined()
    expect(lastShared().extraViews).toBeUndefined()
    expect(lastShared().hideList).toBe(false)
    expect(lastShared().groupsPrepend).toBeUndefined()
    expect(panes()).toEqual([])
    expect(container.querySelector('[data-stub-view-switch]')).toBeNull()
    expect(rec.inboxPanel).toHaveLength(0)
    expect(rec.calendarPanel).toHaveLength(0)
  })

  it('DS-V16 library with the store on inbox: no shared sidebar, no switch, no panes', () => {
    rec.view = 'inbox'
    render({ mode: 'library' })
    expect(rec.shared).toHaveLength(0)
    expect(panes()).toEqual([])
    expect(container.querySelector('[data-stub-view-switch]')).toBeNull()
    expect(rec.inboxPanel).toHaveLength(0)
    expect(rec.calendarPanel).toHaveLength(0)
  })

  it('DS-V17 library with a libraryDrill and the store on calendar: the same', () => {
    rec.view = 'calendar'
    render({ mode: 'library', libraryDrill: { scope: null, onOpen: vi.fn() } })
    expect(rec.shared).toHaveLength(0)
    expect(panes()).toEqual([])
    expect(container.querySelector('[data-stub-view-switch]')).toBeNull()
    expect(rec.inboxPanel).toHaveLength(0)
    expect(rec.calendarPanel).toHaveLength(0)
  })

  it('DS-V18 an unrelated prop change does not remount the pane', () => {
    rec.view = 'inbox'
    render({ onOpenSession: vi.fn() })
    const before = pane('inbox')
    const adaptersBefore = GROUP_ORDER.map(lastAdapter)
    render({ onOpenSession: vi.fn() })
    expect(pane('inbox')).toBe(before)
    expect(rec.inboxMounts).toBe(1)
    GROUP_ORDER.forEach((name, i) => expect(lastAdapter(name), name).toBe(adaptersBefore[i]))
    expect(rec.inboxPanel.at(-1)!.tracking).toBe(rec.trackingAdapter)
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

/**
 * 两层导航（手机布局的会话页）：`drill` 只在 `mode="sessions"` 时交给共享侧栏；`full`（桌面）与 `library` 都不认它。
 * 分组上面不再有前置的内容（原先的 `sessionsPrepend` —— 「收件箱」那一行 —— 2026-11-16 没有了）。
 *
 *   DS-8 sessions：drill 原样交下去；分组上面什么都不放、没有视图切换、没有资料库分组
 *   DS-9 full：不认 drill，与 DS-1 一样
 *   DS-10 sessions 不给 drill：与 DS-2 一样
 *   DS-11 library：没有共享侧栏
 */
describe('drill (phone sessions page)', () => {
  it('DS-8 sessions: drill reaches the shared sidebar as is; nothing is prepended', () => {
    const drill = { scope: 'p1', onOpen: vi.fn() }
    render({ mode: 'sessions', drill })
    expect(lastShared().drill).toBe(drill)
    expect(lastShared().groupsPrepend).toBeUndefined()
    expect(container.querySelector('[data-stub-view-switch]')).toBeNull()
    expect(stubGroups()).toEqual([])
    expect(lastShared().caps).toEqual({})
    expect(lastShared().hideFooter).toBe(true)
  })

  it('DS-8 sessions: a top-level drill (scope null) is passed through too', () => {
    const drill = { scope: null, onOpen: vi.fn() }
    render({ mode: 'sessions', drill })
    expect(lastShared().drill).toBe(drill)
  })

  it('DS-9 full: drill is not used; no inbox row; the five groups are as on the desktop', () => {
    const drill = { scope: 'p1', onOpen: vi.fn() }
    render({ drill })
    expect(lastShared().drill).toBeUndefined()
    expect(container.querySelector('[data-inbox-row]')).toBeNull()
    expect(stubGroups()).toEqual(GROUP_ORDER)
    expect(lastShared().caps).toEqual({ windowDrag: true, pin: true })
    expect(lastShared().hideFooter).toBe(false)
  })

  it('DS-10 sessions without drill: no drill and nothing prepended', () => {
    render({ mode: 'sessions' })
    expect(lastShared().drill).toBeUndefined()
    expect(lastShared().groupsPrepend).toBeUndefined()
  })

  it('DS-11 library: no shared sidebar', () => {
    const drill = { scope: 'p1', onOpen: vi.fn() }
    render({ mode: 'library', drill })
    expect(rec.shared).toHaveLength(0)
    expect(container.querySelector('[data-stub-shared]')).toBeNull()
  })

  it('DS-17 library with a libraryDrill: still no shared sidebar', () => {
    const drill = { scope: 'p1', onOpen: vi.fn() }
    render({ mode: 'library', drill, libraryDrill: { scope: null, onOpen: vi.fn() } })
    expect(rec.shared).toHaveLength(0)
    expect(container.querySelector('[data-stub-shared]')).toBeNull()
    expect(container.querySelector('[data-stub-view-switch]')).toBeNull()
  })
})

/**
 * 资料库的两层导航（手机布局的资料库页）：`libraryDrill` 只在 `mode="library"` 时用。
 *
 *   DS-12 顶层（scope null）：两张 [data-library-card]（都带 sb-card；第二张有内联的上边距）—— 智能体 / 技能 / 知识库，
 *         安全策略 / Hooks；没有 Tracking；各组拿到的 drill 就是传进来的那个对象
 *   DS-13 进了某一组：还是两张 [data-library-card]，但不带 sb-card、没有内联边距；五组都还挂着（没有重挂）、
 *         拿到新的 drill，adapter 引用不变
 *   DS-14 full / sessions 不认 libraryDrill
 *   DS-15 libraryDrill 换了对象，各组的 adapter 引用不变
 *   DS-16 资料库分组 adapter 的 open → 写 store、告诉 onOpenSession；同一份再开一次也告诉（手机要再推一次对话页）
 *   DS-18 各层共用 [data-mobile-list] 这一个滚动容器（B6）：往下钻一层回到顶上，退回来回到离开那一层时的位置
 *         （位置在 scroll 事件里记）；同一层横着换（点不出来，只有重渲染能到）走「退回来」那条路：记过就回到记的
 *         位置，没记过回 0；不给 libraryDrill 时谁也不碰 scrollTop
 */
describe('libraryDrill (phone library page)', () => {
  const LIBRARY_CARDS = [
    ['Agent', 'Skill', 'Knowledge'],
    ['Policy', 'Hook']
  ]
  const cards = (): HTMLElement[] => [
    ...container.querySelectorAll<HTMLElement>('[data-library-card]')
  ]
  const scroller = (): HTMLElement => container.querySelector<HTMLElement>('[data-mobile-list]')!
  /** 用户把列表滚到 `top`（jsdom 的 scrollTop 是个普通属性；React 的 onScroll 直接挂在元素上） */
  function scrollTo(top: number): void {
    act(() => {
      scroller().scrollTop = top
      scroller().dispatchEvent(new Event('scroll'))
    })
  }
  const libraryAt = (scope: string | null, onOpen = vi.fn()): SidebarProps => ({
    mode: 'library',
    libraryDrill: { scope, onOpen }
  })

  it('DS-12 the top level: two cards (agents / skills / knowledge, policies / hooks), no Tracking, every group gets the same drill object', () => {
    const libraryDrill = { scope: null, onOpen: vi.fn() }
    render({ mode: 'library', libraryDrill })
    expect(rec.shared).toHaveLength(0)
    const list = scroller()
    expect(list.getAttribute('data-sidebar-density')).toBe('touch')
    expect(cards()).toHaveLength(2)
    expect(cards().map((card) => stubGroups(card))).toEqual(LIBRARY_CARDS)
    for (const card of cards()) {
      expect(list.contains(card)).toBe(true)
      expect(card.classList.contains('sb-card')).toBe(true)
    }
    expect(cards()[0].style.marginTop).toBe('')
    expect(cards()[1].getAttribute('style') ?? '').toContain('margin-top')
    expect(container.querySelector('[data-stub-group="Tracking"]')).toBeNull()
    expect(rec.groups.has('Tracking')).toBe(false)
    for (const name of GROUP_ORDER) expect(lastDrill(name), name).toBe(libraryDrill)
  })

  it('DS-13 a group page open: the same two wrappers without the card look; the five groups stay mounted with the new drill', () => {
    render(libraryAt(null))
    const adaptersBefore = GROUP_ORDER.map(lastAdapter)
    const mountsBefore = GROUP_ORDER.map((name) => rec.groupMounts.get(name))
    expect(mountsBefore).toEqual([1, 1, 1, 1, 1])

    const libraryDrill = { scope: 'agents', onOpen: vi.fn() }
    render({ mode: 'library', libraryDrill })
    expect(cards()).toHaveLength(2)
    expect(cards().map((card) => stubGroups(card))).toEqual(LIBRARY_CARDS)
    for (const card of cards()) {
      expect(card.classList.contains('sb-card')).toBe(false)
      expect(card.getAttribute('style') ?? '').not.toContain('margin-top')
    }
    for (const name of GROUP_ORDER) expect(lastDrill(name), name).toBe(libraryDrill)
    expect(GROUP_ORDER.map((name) => rec.groupMounts.get(name))).toEqual(mountsBefore)
    GROUP_ORDER.forEach((name, i) => expect(lastAdapter(name), name).toBe(adaptersBefore[i]))
  })

  it('DS-14 full and sessions ignore libraryDrill', () => {
    const libraryDrill = { scope: 'agents', onOpen: vi.fn() }
    render({ libraryDrill })
    expect(stubGroups()).toEqual(GROUP_ORDER)
    for (const name of GROUP_ORDER) expect(lastDrill(name), name).toBeUndefined()
    expect(container.querySelector('[data-stub-view-switch]')).not.toBeNull()
    expect(container.querySelector('[data-library-card]')).toBeNull()
    expect(container.querySelector('[data-mobile-list]')).toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    rec.groups.clear()
    rec.groupDrills.clear()
    render({ mode: 'sessions', libraryDrill })
    expect(stubGroups()).toEqual([])
    expect(rec.groups.size).toBe(0)
    expect(container.querySelector('[data-library-card]')).toBeNull()
  })

  it('DS-15 a new libraryDrill object on re-render leaves the adapters’ identity alone', () => {
    render(libraryAt(null))
    const adaptersBefore = GROUP_ORDER.map(lastAdapter)
    render(libraryAt(null))
    render(libraryAt('knowledge'))
    render(libraryAt('knowledge:knowledge/notes'))
    GROUP_ORDER.forEach((name, i) => expect(lastAdapter(name), name).toBe(adaptersBefore[i]))
    expect(GROUP_ORDER.map((name) => rec.groupMounts.get(name))).toEqual([1, 1, 1, 1, 1])
  })

  it('DS-16 a library adapter’s open writes the store and tells onOpenSession, also when that note is opened again', async () => {
    const onOpenSession = vi.fn()
    const openNote = vi.fn(async (_arg: { fileName: string; title?: string }) => ({ id: 'n9' }))
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ...api,
      subAgent: { openNote }
    }
    render({ mode: 'library', onOpenSession, libraryDrill: { scope: 'agents', onOpen: vi.fn() } })
    const agents = lastAdapter('Agent') as {
      open: (fileName: string, title?: string) => Promise<void>
    }
    await act(async () => {
      await agents.open('a.md', 'A')
    })
    expect(openNote).toHaveBeenCalledWith({ fileName: 'a.md', title: 'A' })
    expect(rec.storeSet.mock.calls).toEqual([['n9']])
    expect(onOpenSession.mock.calls).toEqual([['n9']])

    // 已经是活跃的那一份再开一次：手机还得再推一次对话页
    await act(async () => {
      await agents.open('a.md', 'A')
    })
    expect(rec.storeSet.mock.calls).toEqual([['n9'], ['n9']])
    expect(onOpenSession.mock.calls).toEqual([['n9'], ['n9']])
  })

  it('DS-18 going deeper resets the scroller to the top; going back returns to the position recorded for that page', () => {
    render(libraryAt(null))
    expect(scroller().scrollTop).toBe(0)

    render(libraryAt('knowledge'))
    expect(scroller().scrollTop).toBe(0)
    scrollTo(300)

    render(libraryAt('knowledge:knowledge/notes'))
    expect(scroller().scrollTop).toBe(0)
    scrollTo(50)

    render(libraryAt('knowledge'))
    expect(scroller().scrollTop).toBe(300)

    // 顶层从没滚过：回到 0
    render(libraryAt(null))
    expect(scroller().scrollTop).toBe(0)
  })

  it('DS-18 the top level’s own position comes back after a group page', () => {
    render(libraryAt(null))
    scrollTo(200)
    render(libraryAt('agents'))
    expect(scroller().scrollTop).toBe(0)
    scrollTo(40)
    render(libraryAt(null))
    expect(scroller().scrollTop).toBe(200)
  })

  it('DS-18 entering a page again starts at the top: the position recorded on an earlier visit is dropped', () => {
    render(libraryAt(null))
    render(libraryAt('agents'))
    scrollTo(120)
    render(libraryAt(null))
    render(libraryAt('agents'))
    expect(scroller().scrollTop).toBe(0)
  })

  it('DS-18 sideways at the same depth (re-render only): the stored position of that page, or 0', () => {
    render(libraryAt(null))
    render(libraryAt('agents'))
    scrollTo(120)
    // 同一层换一组不算「往下钻」：没记过 → 0
    render(libraryAt('skills'))
    expect(scroller().scrollTop).toBe(0)
    scrollTo(70)
    // 记过的那一页 → 回到记的位置
    render(libraryAt('agents'))
    expect(scroller().scrollTop).toBe(120)
  })

  it('DS-18 a re-render at the same scope leaves the scroll position alone', () => {
    render(libraryAt('agents'))
    scrollTo(90)
    render(libraryAt('agents'))
    expect(scroller().scrollTop).toBe(90)
  })

  it('DS-18 without libraryDrill nothing touches scrollTop', () => {
    render({ mode: 'library' })
    scrollTo(77)
    render({ mode: 'library' })
    expect(scroller().scrollTop).toBe(77)
    render({ mode: 'library', onOpenSession: vi.fn() })
    expect(scroller().scrollTop).toBe(77)
  })
})

/**
 * 项目那一组菜单里的「编辑项目」：共享侧栏调 `onEditProject(projectId)`。桌面缺省开居中的对话框；手机布局给了
 * 自己的回调（整屏推入的项目设置页），对话框就不挂。
 */
describe('desktop Sidebar: how "edit project" opens', () => {
  const editFromShared = (id: string): void =>
    act(() => (lastShared().onEditProject as (id: string) => void)(id))

  it('SE-1 without onEditProject the centred project dialog opens (and closes through its onClose)', () => {
    render()
    expect(rec.projectDialogs).toHaveLength(0)
    editFromShared('p1')
    expect(rec.projectDialogs.at(-1)?.projectId).toBe('p1')
    const count = rec.projectDialogs.length
    act(() => (rec.projectDialogs.at(-1)!.onClose as () => void)())
    expect(rec.projectDialogs).toHaveLength(count)
  })

  it('SE-2 with onEditProject it is called with the project id and no dialog is mounted', () => {
    const onEditProject = vi.fn()
    render({ mode: 'sessions', onEditProject })
    editFromShared('p1')
    expect(onEditProject).toHaveBeenCalledTimes(1)
    expect(onEditProject).toHaveBeenCalledWith('p1')
    expect(rec.projectDialogs).toHaveLength(0)
  })
})
