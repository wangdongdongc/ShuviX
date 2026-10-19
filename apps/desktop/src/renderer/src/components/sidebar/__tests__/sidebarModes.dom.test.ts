// @vitest-environment jsdom
/**
 * 桌面侧栏的三种画法（components/sidebar/Sidebar.tsx 的 `mode` / `onOpenSession`，jsdom）。
 *
 * 契约：`full`（缺省，桌面）= 共享侧栏 + 窗口拖拽 / 悬浮徽标 + 底部设置栏 + 六个注册表分组（Bots → 智能体 →
 * 安全策略 → Hooks → 技能 → 知识库）；`sessions`（手机「会话」页）= 共享侧栏，不带任何 caps、不画底部设置栏、
 * 不画那六组；`library`（手机「资料库」页）= 不画共享侧栏，只有那六组，装在 `[data-mobile-list]` 里。
 * 侧栏里每一次「打开会话」（点行，同一个再点一次也算；笔记本会话）都先写 store、再告诉 `onOpenSession`；
 * 选中 null（离开会话）不告诉它。换一个 onOpenSession 回调 → 之后用新的；分组的 adapter 引用不变（分组以
 * adapter 为扫描依赖，换引用会重扫）。
 *
 *   DS-1 full：caps {windowDrag, pin}、hideFooter false、groupsPrepend = Bot, Agent, Policy, Hook, Skill, Knowledge
 *   DS-2 sessions：caps {}、hideFooter true、没有分组
 *   DS-3 library：没有共享侧栏；六组都在 [data-mobile-list] 里
 *   DS-4 拿到的 onSelectSession('s1') 叫两次 → store 写两次、onOpenSession 两次；null 不到 onOpenSession
 *   DS-5 Bot 分组 adapter 的 open('a.md') → onOpenSession(新会话 id)
 *   DS-6 换了回调重渲染 → 用新的；adapter 对象引用不变
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
    sessions: [] as Array<{ id: string; projectId?: string | null; settings: Props }>,
    activeSessionId: null as string | null
  }
}))

vi.mock('@shuvix/app-shell', async () => {
  const { createElement: h, Fragment } = await import('react')
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
    BotGroup: group('Bot'),
    AgentGroup: group('Agent'),
    PolicyGroup: group('Policy'),
    HookGroup: group('Hook'),
    SkillGroup: group('Skill'),
    KnowledgeGroup: group('Knowledge'),
    useProjects: () => ({ projects: [] }),
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
    getChatApi: () => ({
      session: { list: async () => rec.state.sessions, create: async () => ({ id: 'created' }) },
      project: { list: async () => [], create: async () => ({ id: 'p' }) },
      app: { openSettings: async () => undefined }
    }),
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

const GROUP_ORDER = ['Bot', 'Agent', 'Policy', 'Hook', 'Skill', 'Knowledge']

const api = {
  bot: {
    openNote: vi.fn<(arg: { fileName: string; title?: string }) => Promise<{ id: string }>>(),
    delete: vi.fn<(arg: { name: string }) => Promise<{ success: boolean }>>(),
    list: vi.fn(async () => ({ bots: [], invalid: [] })),
    openFolder: vi.fn()
  },
  pinChat: { focus: vi.fn() }
}

let container: HTMLDivElement
let root: Root

/** Sidebar 的参数带缺省值（`= {}`），createElement 的重载认不出它的 props 类型 —— 显式收窄成必传 */
const SidebarComponent = Sidebar as (props: SidebarProps) => React.JSX.Element

function render(props: SidebarProps = {}): void {
  act(() => root.render(createElement(SidebarComponent, props)))
}

const lastShared = (): Record<string, unknown> => rec.shared.at(-1)!
const lastAdapter = (name: string): unknown => rec.groups.get(name)?.at(-1)
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
  api.bot.delete.mockReset()
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
  it('DS-1 full: windowDrag + pin caps, the footer, and the six registry groups in order', () => {
    render()
    expect(lastShared().caps).toEqual({ windowDrag: true, pin: true })
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

    // 选中 null（删掉了正开着的那份 bot 的笔记本 → 离开它）：store 写 null，onOpenSession 不知道
    act(() => root.unmount())
    root = createRoot(container)
    rec.state.sessions = [
      { id: 'n1', projectId: REGISTRY_NOTE_PROJECT_IDS.bot, settings: { notebookPath: 'a.md' } }
    ]
    rec.state.activeSessionId = 'n1'
    rec.storeSet.mockClear()
    onOpenSession.mockClear()
    api.bot.delete.mockResolvedValue({ success: true })
    render({ mode: 'library', onOpenSession })
    const bots = lastAdapter('Bot') as { delete: (b: { name: string; fileName: string }) => void }
    act(() => bots.delete({ name: 'a', fileName: 'a.md' }))
    const confirm = rec.confirms.at(-1)
    expect(confirm).toBeDefined()
    await act(async () => {
      ;(confirm!.onConfirm as () => void)()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.bot.delete).toHaveBeenCalledWith({ name: 'a' })
    expect(rec.storeSet.mock.calls).toEqual([[null]])
    expect(onOpenSession).not.toHaveBeenCalled()
  })

  it('DS-5 the Bot group adapter opening a bot file tells onOpenSession the new session id', async () => {
    const onOpenSession = vi.fn()
    api.bot.openNote.mockResolvedValue({ id: 'note-1' })
    render({ mode: 'library', onOpenSession })
    const bots = lastAdapter('Bot') as { open: (fileName: string, title?: string) => Promise<void> }
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
    render({ onOpenSession: second })
    expect(GROUP_ORDER.map(lastAdapter)).toEqual(adaptersBefore)
    GROUP_ORDER.forEach((name, i) => expect(lastAdapter(name), name).toBe(adaptersBefore[i]))
    expect(lastShared().projectKnowledge).toBe(knowledgeBefore)

    act(() => (lastShared().onSelectSession as (id: string) => void)('s2'))
    expect(second.mock.calls).toEqual([['s2']])
    expect(first).not.toHaveBeenCalled()

    // 分组里的打开也走新的回调（拿的是重渲染之前那份 adapter）
    api.bot.openNote.mockResolvedValue({ id: 'note-2' })
    await act(async () => {
      await (adaptersBefore[0] as { open: (f: string) => Promise<void> }).open('b.md')
    })
    expect(second.mock.calls).toEqual([['s2'], ['note-2']])
    expect(first).not.toHaveBeenCalled()
  })
})
