// @vitest-environment jsdom
/**
 * 侧栏的「Bots」分节（ProjectSessionGroups 的 `bots` 能力 + useBotRegistry，jsdom）。
 *
 * 契约（2026-10-31：bot 会话只归属 bot）：注入 `bots` 时，项目组之前多一个「Bots」分节（`[data-sidebar-section="bots"]`），
 * 每个生效的 bot 一组（`[data-bot-group=<name>]`，按显示名排序），它的顶层会话（及挂在下面的子会话）都收进这一组，
 * 不再出现在项目组与「临时对话」里；行尾标这条会话在哪干活（`[data-session-location]`）。
 *
 *   PG-1 分组与次序：bot 组按显示名排；bot 会话（临时的、引用项目的、旧的项目成员）只在 bot 组里，子会话折在父行下；
 *        普通会话照旧在项目组 / 临时组；「Bots」分节在「项目」分节之前；不注入 bots → 没有这一节，bot 会话照旧分组
 *   PG-2 折叠：侧栏里 bot 组缺省收起、点组头展开；日历（hideEmptyGroups）里缺省摊开、只画当天有会话的 bot、
 *        组上没有菜单与「+」、整节没有菜单；当天一条 bot 会话都没有 → 整节不画
 *   PG-3 位置标签（只在顶层行）：项目名 / 归档项目的名字 / 名字为空 →「Unnamed Project」/ 都不在 →「Project deleted」/
 *        没有引用 →「Temporary」；子会话行与普通会话行没有标签；还没有会话的 bot 是一行「New Chat」，点它开位置选择
 *   PG-4 位置选择的内容：置灰的「Where should it work?」；最近用过的 8 个项目（最近 = 以它为 projectContextIdOf 的会话里
 *        最大的 lastActiveAt，同分按名字），其余按名字收进「More projects」子菜单；分隔线；「Open folder…」只在宿主给了
 *        pickFolderAsProject 时出现；「Temporary」垫底；项目没名字 → 「Unnamed Project」
 *   PG-5 位置选择的动作：项目（含子菜单里的）→ newSession(name, {workProject})、组跟着展开；临时 → {temp: true}；
 *        打开文件夹 → pickFolderAsProject，回 id 就用它建、回 null 什么都不建；取消 → 什么都不建；
 *        组头「+」与组菜单里的「New Chat」都开同一个选择
 *   PG-6 菜单：bot 组头 = New Chat / Edit bot / 分隔线 / Archive（Edit → open(文件名, 显示名)，Archive → archive(那个 bot)）；
 *        项目组 / 临时组的菜单里没有 new-bot-chat；分节头 = New bot / 打开文件夹 / 分隔线 / 刷新（刷新重扫）
 *   PG-7 定时运行：triggerRun 的会话折进组末一行 `[data-bot-runs]`（Scheduled runs + 条数），缺省收起、点它展开；
 *        其中有一条在跑 → Timer 图标脉动（用户自己开的那条在跑不算）；没有 → 没有这一行；折进去的行也带位置标签
 *   PG-8 找不到 / 归档：注册表里没有、也没归档的名字 → 置灰的 `[data-bot-missing-group]`（提示 + 会话，菜单只有
 *        「删掉这些会话」→ deleteSessions(name, 条数)；宿主不给 deleteSessions → 没有菜单）；归档的名字整组藏起来；
 *        list() 还没回来 / 一次都没成功（拒绝）→ 先按会话里的名字列出 `data-bot-group-pending` 的组（没有菜单、没有「+」、
 *        不当成找不到）；成功过之后再失败 → 留着上一次的分组
 *
 * 右键菜单走 ContextMenuProvider 的 `render` 注入：记录每次弹出的菜单；「用户」点哪一项从 `picks` 队列里按次序取
 * （取空 = 取消），在这一份菜单与它的子菜单里找，找不到或置灰也当取消。`@shuvix/chat-ui` 同 fork 那份测试换成替身，
 * 另给 BotAvatar。文件是 `.ts`，一律 createElement。
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

function registryOf(over: Partial<BotRegistry> = {}): BotRegistry {
  return { bots: [], shadowed: [], invalid: [], ...over }
}

/** 注入的 adapter：每个能力都是可数的 spy */
interface FakeAdapter extends BotGroupAdapter {
  list: Mock<() => Promise<BotRegistry>>
  open: Mock<BotGroupAdapter['open']>
  create: Mock<BotGroupAdapter['create']>
  openFolder: Mock<BotGroupAdapter['openFolder']>
  newSession: Mock<BotGroupAdapter['newSession']>
  archive: Mock<BotGroupAdapter['archive']>
  deleteFile: Mock<BotGroupAdapter['deleteFile']>
  deleteSessions: Mock<NonNullable<BotGroupAdapter['deleteSessions']>>
}

/** 一个注入的 adapter：list 缺省回 `registry`（可整个换掉） */
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
/** 一条 bot 会话（只归属 bot；settings 里可带 workProject / triggerRun） */
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
          onToggleGroup: () => {},
          onNewChat: () => {},
          onDelete: () => {},
          onEditProject: () => {},
          projectsSection: {},
          ...(bots ? { bots: bots as BotsSectionCaps } : {}),
          ...props
        })
      )
    )
  )
  await flush()
}

const groupEl = (name: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[data-bot-group="${name}"]`)
  if (!el) throw new Error(`bot group ${name} not rendered`)
  return el
}
const groupOrder = (): string[] =>
  [...container.querySelectorAll('[data-bot-group]')].map(
    (el) => el.getAttribute('data-bot-group')!
  )
/** 一个容器里的会话行（按标题里的 id；标题是行里第一个 truncate 的 span，位置标签在它后面） */
const rowIds = (el: Element): string[] =>
  [...el.querySelectorAll('[data-session-row]')].map(
    (r) => /^Title (.+)$/.exec(r.querySelector('span.truncate')?.textContent ?? '')?.[1] ?? '?'
  )
/** 组（容器里第一个 AnimatedCollapse）是不是收起的 */
const isCollapsed = (el: Element): boolean =>
  (el.querySelector<HTMLElement>('.grid')!.style.gridTemplateRows ?? '') === '0fr'
const rowEl = (id: string): HTMLElement => {
  const found = [...container.querySelectorAll<HTMLElement>('[data-session-row]')].find((el) =>
    el.textContent?.includes(`Title ${id}`)
  )
  if (!found) throw new Error(`row ${id} not rendered`)
  return found
}
const locationOf = (id: string): string | null =>
  rowEl(id).querySelector('[data-session-location]')?.textContent ?? null
/** 「项目」/「Bots」/「临时对话」分节的组头 */
const sectionHeader = (label: string): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('[data-group="section"], [data-group="temp"]')].find(
    (el) => el.textContent?.startsWith(label)
  )!
/** 一个项目组的容器（组头的父节点） */
const projectGroupBox = (name: string): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('[data-group="project"]')].find((el) =>
    el.textContent?.includes(name)
  )!.parentElement!
const tempGroupBox = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-group="temp"]')?.parentElement ?? null

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
const headerOf = (name: string): HTMLElement =>
  groupEl(name).querySelector<HTMLElement>('[data-group="bot"]')!
const toggleButtonOf = (name: string): HTMLElement =>
  headerOf(name).querySelector<HTMLElement>('button')!
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

// ─── PG-1 ─────────────────────────────────────

describe('PG-1 分组与次序', () => {
  it('PG-1 bot 组按显示名排；bot 会话只在自己的组里（子会话折在父行下）；普通会话照旧；Bots 分节在项目分节之前', async () => {
    store.sessions = [
      botRow('b1', 'zed'),
      botRow('b2', 'alpha', { workProject: 'p1' }),
      // 旧数据：仍是项目成员的 bot 会话，也进 bot 组
      botRow('b3', 'alpha', {}, { projectId: 'p1' }),
      row('b2c', { parentId: 'b2', createdAt: 2, settings: { workProject: 'p1' } }),
      row('m1', { projectId: 'p1' }),
      row('t1')
    ]
    const adapter = makeAdapter(
      registryOf({ bots: [bot('zed', 'Zed'), bot('alpha', 'Alpha'), bot('mid', 'Beta')] })
    )
    await mount({ adapter })

    expect(adapter.list).toHaveBeenCalledTimes(1)
    expect(groupOrder()).toEqual(['alpha', 'mid', 'zed'])
    expect(rowIds(groupEl('alpha'))).toEqual(['b2', 'b2c', 'b3'])
    expect(rowEl('b2c').hasAttribute('data-sub')).toBe(true)
    expect(rowIds(groupEl('zed'))).toEqual(['b1'])
    expect(rowIds(groupEl('mid'))).toEqual([])

    expect(rowIds(projectGroupBox('Proj'))).toEqual(['m1'])
    expect(rowIds(tempGroupBox()!)).toEqual(['t1'])

    const section = container.querySelector('[data-sidebar-section="bots"]')!
    expect(section.querySelectorAll('[data-bot-group]')).toHaveLength(3)
    // DOM 次序：Bots 分节头 → 它的组 → 项目分节头
    expect(sectionHeader('Bots')).toBeTruthy()
    expect(
      section.compareDocumentPosition(sectionHeader(S.projects)) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      sectionHeader('Bots').compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('PG-1 不注入 bots：没有 Bots 分节，bot 会话照旧按项目 / 临时分组', async () => {
    store.sessions = [botRow('b1', 'zed'), botRow('b2', 'zed', {}, { projectId: 'p1' })]
    await mount(undefined)
    expect(container.querySelector('[data-sidebar-section="bots"]')).toBeNull()
    expect(container.querySelector('[data-bot-group]')).toBeNull()
    expect(rowIds(projectGroupBox('Proj'))).toEqual(['b2'])
    expect(rowIds(tempGroupBox()!)).toEqual(['b1'])
    expect(container.querySelector('[data-session-location]')).toBeNull()
  })
})

// ─── PG-2 ─────────────────────────────────────

describe('PG-2 折叠：侧栏与日历', () => {
  it('PG-2 侧栏：bot 组缺省收起，点组头展开、再点收起', async () => {
    store.sessions = [botRow('b1', 'scout')]
    await mount({ adapter: makeAdapter(registryOf({ bots: [bot('scout')] })) })
    expect(isCollapsed(groupEl('scout'))).toBe(true)
    await click(toggleButtonOf('scout'))
    expect(isCollapsed(groupEl('scout'))).toBe(false)
    await click(toggleButtonOf('scout'))
    expect(isCollapsed(groupEl('scout'))).toBe(true)
  })

  it('PG-2 日历：有会话的 bot 组摊开、定时运行也摊开；没有会话的 bot 不画；组上没有菜单与「+」，分节也没有菜单', async () => {
    store.sessions = [
      botRow('b1', 'scout'),
      botRow('r1', 'scout', { triggerRun: true }),
      botRow('x1', 'other')
    ]
    const adapter = makeAdapter(registryOf({ bots: [bot('scout'), bot('idle'), bot('other')] }))
    await mount(
      { adapter },
      { hideEmptyGroups: true, sessionsOverride: store.sessions.slice(0, 2) as never }
    )

    expect(groupOrder()).toEqual(['scout'])
    expect(isCollapsed(groupEl('scout'))).toBe(false)
    expect(
      groupEl('scout').querySelector('[data-bot-runs-toggle]')!.getAttribute('data-bot-runs-toggle')
    ).toBe('expanded')
    expect(container.querySelector('[data-group-add]')).toBeNull()
    expect(container.querySelector('[data-bot-new-chat]')).toBeNull()

    await rightClick(headerOf('scout'))
    await rightClick(sectionHeader('Bots'))
    expect(menus).toEqual([])
  })

  it('PG-2 日历：当天一条 bot 会话都没有 → 整个 Bots 分节不画', async () => {
    store.sessions = [botRow('b1', 'scout'), row('t1')]
    await mount(
      { adapter: makeAdapter(registryOf({ bots: [bot('scout')] })) },
      { hideEmptyGroups: true, sessionsOverride: [store.sessions[1]] as never }
    )
    expect(container.querySelector('[data-sidebar-section="bots"]')).toBeNull()
  })
})

// ─── PG-3 ─────────────────────────────────────

describe('PG-3 位置标签与空 bot', () => {
  it('PG-3 顶层行标位置：项目名 / 归档项目 / 未命名 / 已删 / 临时；子会话行与普通会话行不标', async () => {
    store.sessions = [
      botRow('a', 'scout', { workProject: 'p1' }),
      botRow('b', 'scout', { workProject: 'arch' }),
      botRow('c', 'scout', { workProject: 'blank' }),
      botRow('d', 'scout', { workProject: 'gone' }),
      botRow('e', 'scout'),
      botRow('f', 'scout', { workProject: 'arch-blank' }),
      row('ac', { parentId: 'a', createdAt: 2, settings: { workProject: 'p1' } }),
      row('m1', { projectId: 'p1' })
    ]
    await mount(
      {
        adapter: makeAdapter(registryOf({ bots: [bot('scout')] })),
        archivedProjects: [
          { id: 'arch', name: 'Old Project' },
          { id: 'arch-blank', name: '' }
        ]
      },
      {
        projects: [
          { id: 'p1', name: 'Proj' },
          { id: 'blank', name: '' }
        ]
      }
    )

    expect(locationOf('a')).toBe('Proj')
    expect(locationOf('b')).toBe('Old Project')
    expect(locationOf('c')).toBe(S.unnamedProject)
    expect(locationOf('d')).toBe(S.botProjectGone)
    expect(locationOf('e')).toBe(S.botTempLocation)
    expect(locationOf('f')).toBe(S.unnamedProject)
    expect(locationOf('ac')).toBeNull()
    expect(locationOf('m1')).toBeNull()
    expect([S.unnamedProject, S.botProjectGone, S.botTempLocation]).toEqual([
      'Unnamed Project',
      'Project deleted',
      'Temporary'
    ])
  })

  it('PG-3 不给 archivedProjects：引用归档项目的会话按「Project deleted」标', async () => {
    store.sessions = [botRow('b', 'scout', { workProject: 'arch' })]
    await mount({ adapter: makeAdapter(registryOf({ bots: [bot('scout')] })) })
    expect(locationOf('b')).toBe(S.botProjectGone)
  })

  it('PG-3 还没有会话的 bot：一行「New Chat」，点它开位置选择', async () => {
    await mount({ adapter: makeAdapter(registryOf({ bots: [bot('scout')] })) })
    const empty = groupEl('scout').querySelector('[data-bot-new-chat]')!
    expect(empty.textContent).toBe(S.newChat)
    await click(empty)
    expect(menus).toHaveLength(1)
    expect(menus[0][0]).toEqual({ id: 'where', label: S.botWhere, enabled: false })
  })
})

// ─── PG-4 / PG-5：位置选择 ─────────────────────────────────────

describe('PG-4 位置选择的内容', () => {
  /** 十个项目：名字次序与「最近」次序刻意不同 */
  const TEN = [
    { id: 'p0', name: 'Kilo' },
    { id: 'p1', name: 'Alpha' },
    { id: 'p2', name: 'Zulu' },
    { id: 'p3', name: 'Echo' },
    { id: 'p4', name: 'Bravo' },
    { id: 'p5', name: 'Yankee' },
    { id: 'p6', name: 'Delta' },
    { id: 'p7', name: 'X-ray' },
    { id: 'p8', name: 'Mike' },
    { id: 'p9', name: 'Golf' }
  ]

  it('PG-4 置灰的标题；最近 8 个（成员会话与引用它的 bot 会话都算，同分按名字）；其余按名字进子菜单；分隔线；打开文件夹；临时', async () => {
    store.sessions = [
      botRow('scout-1', 'scout', { workProject: 'p2' }, { lastActiveAt: 900 }),
      row('m5', { projectId: 'p5', lastActiveAt: 800 }),
      row('m5b', { projectId: 'p5', lastActiveAt: 10 }),
      row('m7', { projectId: 'p7', lastActiveAt: 700 }),
      // 不在列表里的项目：不进选择
      botRow('scout-2', 'scout', { workProject: 'gone' }, { lastActiveAt: 999 }),
      // 最不常用的两个：Mike（2）比 Golf（1）近，子菜单里却按名字排（Golf 在前）
      row('m8', { projectId: 'p8', lastActiveAt: 2 }),
      row('m9', { projectId: 'p9', lastActiveAt: 1 }),
      // 其余五个同分（0）按名字：Alpha Bravo Delta Echo Kilo
      ...['p0', 'p1', 'p3', 'p4', 'p6'].map((p) => row(`z-${p}`, { projectId: p, lastActiveAt: 3 }))
    ]
    const adapter = makeAdapter(registryOf({ bots: [bot('scout')] }))
    await mount({ adapter, pickFolderAsProject: vi.fn(async () => null) }, { projects: TEN })
    await click(groupEl('scout').querySelector('[data-group-add]')!)

    expect(menus).toHaveLength(1)
    const items = menus[0]
    expect(items[0]).toEqual({ id: 'where', label: S.botWhere, enabled: false })
    expect(items.slice(1, 9).map((i) => i.label)).toEqual([
      'Zulu',
      'Yankee',
      'X-ray',
      'Alpha',
      'Bravo',
      'Delta',
      'Echo',
      'Kilo'
    ])
    expect(items.slice(1, 9).map((i) => i.id)).toEqual(
      ['p2', 'p5', 'p7', 'p1', 'p4', 'p6', 'p3', 'p0'].map((p) => `project:${p}`)
    )
    expect(items[9]).toMatchObject({ id: 'more-projects', label: S.botMoreProjects })
    expect(items[9].submenu!.map((i) => [i.id, i.label])).toEqual([
      ['project:p9', 'Golf'],
      ['project:p8', 'Mike']
    ])
    expect(ids(items.slice(10))).toEqual(['separator', 'open-folder', 'temp'])
    expect(findItem(items, 'open-folder')!.label).toBe(S.botOpenFolder)
    expect(findItem(items, 'temp')!.label).toBe(S.botTempLocation)
  })

  it('PG-4 不到 9 个项目 → 没有子菜单；不给 pickFolderAsProject → 没有「打开文件夹」；没名字的项目标「Unnamed Project」', async () => {
    await mount(
      { adapter: makeAdapter(registryOf({ bots: [bot('scout')] })) },
      {
        projects: [
          { id: 'p1', name: 'Proj' },
          { id: 'p2', name: '' }
        ]
      }
    )
    await click(groupEl('scout').querySelector('[data-bot-new-chat]')!)
    const items = menus[0]
    expect(ids(items)).toEqual(['where', 'project:p2', 'project:p1', 'separator', 'temp'])
    expect(findItem(items, 'project:p2')!.label).toBe(S.unnamedProject)
  })
})

describe('PG-5 位置选择的动作', () => {
  const projects = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }))

  async function setup(caps: Partial<BotsSectionCaps> = {}): Promise<FakeAdapter> {
    store.sessions = [botRow('b1', 'scout')]
    const adapter = makeAdapter(registryOf({ bots: [bot('scout', 'Scout')] }))
    await mount({ adapter, ...caps }, { projects })
    return adapter
  }
  const addButton = (): HTMLElement => groupEl('scout').querySelector('[data-group-add]')!

  it('PG-5 选一个项目 → newSession(名字, {workProject})，组跟着展开', async () => {
    const adapter = await setup()
    expect(isCollapsed(groupEl('scout'))).toBe(true)
    picks = ['project:p3']
    await click(addButton())
    expect(adapter.newSession.mock.calls).toEqual([['scout', { workProject: 'p3' }]])
    expect(isCollapsed(groupEl('scout'))).toBe(false)
  })

  it('PG-5 子菜单里的项目同样', async () => {
    const adapter = await setup()
    picks = ['project:p9']
    await click(addButton())
    expect(findItem(menus[0], 'more-projects')!.submenu!.map((i) => i.id)).toContain('project:p9')
    expect(adapter.newSession.mock.calls).toEqual([['scout', { workProject: 'p9' }]])
  })

  it('PG-5 临时 → {temp: true}；取消 → 什么都不建、组不展开', async () => {
    const adapter = await setup()
    picks = [null]
    await click(addButton())
    expect(adapter.newSession).not.toHaveBeenCalled()
    expect(isCollapsed(groupEl('scout'))).toBe(true)
    picks = ['temp']
    await click(addButton())
    expect(adapter.newSession.mock.calls).toEqual([['scout', { temp: true }]])
  })

  it('PG-5 打开文件夹 → pickFolderAsProject；回 id 就用它建，回 null 什么都不建', async () => {
    const pick = vi.fn<() => Promise<string | null>>()
    const adapter = await setup({ pickFolderAsProject: pick })
    pick.mockResolvedValueOnce(null)
    picks = ['open-folder']
    await click(addButton())
    expect(pick).toHaveBeenCalledTimes(1)
    expect(adapter.newSession).not.toHaveBeenCalled()

    pick.mockResolvedValueOnce('p-new')
    picks = ['open-folder']
    await click(addButton())
    expect(pick).toHaveBeenCalledTimes(2)
    expect(adapter.newSession.mock.calls).toEqual([['scout', { workProject: 'p-new' }]])
  })

  it('PG-5 组菜单里的「New Chat」开同一个位置选择', async () => {
    const adapter = await setup()
    picks = ['new-bot-chat', 'temp']
    await rightClick(headerOf('scout'))
    expect(menus).toHaveLength(2)
    expect(menus[1][0]).toEqual({ id: 'where', label: S.botWhere, enabled: false })
    expect(adapter.newSession.mock.calls).toEqual([['scout', { temp: true }]])
  })
})

// ─── PG-6 ─────────────────────────────────────

describe('PG-6 菜单', () => {
  it('PG-6 bot 组头：New Chat / Edit bot / 分隔线 / Archive；Edit → open(文件名, 显示名)；Archive → archive(那个 bot)', async () => {
    const scout = bot('scout', 'Scout', 'scout-file.md')
    const adapter = makeAdapter(registryOf({ bots: [scout] }))
    await mount({ adapter })

    picks = ['edit-bot']
    await rightClick(headerOf('scout'))
    expect(ids(menus[0])).toEqual(['new-bot-chat', 'edit-bot', 'separator', 'archive-bot'])
    expect(menus[0].map((i) => i.label).filter(Boolean)).toEqual([
      S.newChat,
      S.editBot,
      S.archiveBot
    ])
    expect(adapter.open.mock.calls).toEqual([['scout-file.md', 'Scout']])

    picks = ['archive-bot']
    await rightClick(headerOf('scout'))
    expect(adapter.archive.mock.calls).toEqual([[scout]])
    expect(adapter.newSession).not.toHaveBeenCalled()
  })

  it('PG-6 项目组 / 临时组的菜单里没有 new-bot-chat', async () => {
    store.sessions = [row('m1', { projectId: 'p1' }), row('t1')]
    await mount({ adapter: makeAdapter(registryOf({ bots: [bot('scout')] })) })
    await rightClick(container.querySelector('[data-group="project"]')!)
    await rightClick(container.querySelector('[data-group="temp"]')!)
    expect(ids(menus[0])).toEqual(['new-chat', 'edit-project'])
    expect(ids(menus[1])).toEqual(['new-chat'])
  })

  it('PG-6 分节头：New bot / 打开文件夹 / 分隔线 / 刷新；刷新重扫', async () => {
    const adapter = makeAdapter(registryOf({ bots: [bot('scout')] }))
    await mount({ adapter })
    picks = ['refresh']
    await rightClick(sectionHeader('Bots'))
    expect(ids(menus[0])).toEqual(['new-bot', 'open-folder', 'separator', 'refresh'])
    expect(adapter.list).toHaveBeenCalledTimes(2)

    picks = ['new-bot']
    await rightClick(sectionHeader('Bots'))
    expect(adapter.create).toHaveBeenCalledTimes(1)
  })
})

// ─── PG-7 ─────────────────────────────────────

describe('PG-7 定时运行', () => {
  const runsToggle = (name: string): HTMLElement =>
    groupEl(name).querySelector<HTMLElement>('[data-bot-runs-toggle]')!
  const timerIcon = (name: string): Element => runsToggle(name).querySelector('svg')!

  it('PG-7 triggerRun 的会话折进末尾一行（条数）；缺省收起，点它展开；折进去的行也带位置标签', async () => {
    store.sessions = [
      botRow('own', 'scout', { workProject: 'p1' }),
      botRow('run1', 'scout', { triggerRun: true }),
      botRow('run2', 'scout', { triggerRun: true, workProject: 'p1' })
    ]
    await mount({ adapter: makeAdapter(registryOf({ bots: [bot('scout')] })) })

    const runs = groupEl('scout').querySelector('[data-bot-runs]')!
    expect(rowIds(runs)).toEqual(['run1', 'run2'])
    // 自己开的那条在前，不在定时运行里
    expect(rowIds(groupEl('scout'))).toEqual(['own', 'run1', 'run2'])
    expect(runsToggle('scout').textContent).toBe(`${S.botTriggerRuns}2`)
    expect(runsToggle('scout').getAttribute('data-bot-runs-toggle')).toBe('collapsed')
    expect(isCollapsed(runs)).toBe(true)

    await click(runsToggle('scout'))
    expect(runsToggle('scout').getAttribute('data-bot-runs-toggle')).toBe('expanded')
    expect(isCollapsed(runs)).toBe(false)

    expect(locationOf('run1')).toBe(S.botTempLocation)
    expect(locationOf('run2')).toBe('Proj')
  })

  it('PG-7 有一条运行在跑 → Timer 图标脉动；只有自己开的那条在跑 → 不脉动', async () => {
    store.sessions = [botRow('own', 'scout'), botRow('run1', 'scout', { triggerRun: true })]
    store.streaming = { own: true }
    await mount({ adapter: makeAdapter(registryOf({ bots: [bot('scout')] })) })
    expect(timerIcon('scout').getAttribute('class')).not.toContain('animate-pulse')
    act(() => root.unmount())

    root = createRoot(container)
    store.streaming = { run1: true }
    await mount({ adapter: makeAdapter(registryOf({ bots: [bot('scout')] })) })
    expect(timerIcon('scout').getAttribute('class')).toContain('animate-pulse')
  })

  it('PG-7 没有定时运行 → 没有这一行', async () => {
    store.sessions = [botRow('own', 'scout')]
    await mount({ adapter: makeAdapter(registryOf({ bots: [bot('scout')] })) })
    expect(groupEl('scout').querySelector('[data-bot-runs]')).toBeNull()
  })
})

// ─── PG-8 ─────────────────────────────────────

describe('PG-8 找不到 / 归档 / 还没扫回来', () => {
  it('PG-8 注册表里没有、也没归档 → 置灰的找不到组：提示 + 会话；菜单只有「删掉这些会话」→ deleteSessions(名字, 条数)', async () => {
    store.sessions = [
      botRow('g1', 'ghost'),
      botRow('g2', 'ghost', { triggerRun: true }),
      row('g1c', { parentId: 'g1', createdAt: 2 }),
      botRow('a1', 'shelved'),
      botRow('s1', 'scout')
    ]
    const adapter = makeAdapter(registryOf({ bots: [bot('scout')], archived: ['shelved'] }))
    await mount({ adapter })

    const missing = container.querySelector<HTMLElement>('[data-bot-missing-group="ghost"]')!
    expect(missing).toBeTruthy()
    expect(missing.textContent).toContain(S.botFileMissing)
    expect(rowIds(missing)).toEqual(['g1', 'g1c', 'g2'])
    // 归档的名字整组藏起来：不画组、不当成找不到、它的会话不出现
    expect(container.querySelector('[data-bot-missing-group="shelved"]')).toBeNull()
    expect(container.querySelector('[data-bot-group="shelved"]')).toBeNull()
    expect(container.textContent).not.toContain('Title a1')
    expect(groupOrder()).toEqual(['scout'])

    picks = ['delete-sessions']
    await rightClick(missing.querySelector('[data-group="bot"]')!)
    expect(ids(menus[0])).toEqual(['delete-sessions'])
    expect(menus[0][0].label).toBe(S.botDeleteSessions)
    // 条数是这一组的顶层会话（定时运行的也算）
    expect(adapter.deleteSessions.mock.calls).toEqual([['ghost', 2]])
  })

  it('PG-8 宿主不给 deleteSessions → 找不到的组没有菜单', async () => {
    store.sessions = [botRow('g1', 'ghost')]
    const adapter = makeAdapter(registryOf())
    const { deleteSessions: _drop, ...rest } = adapter
    await mount({ adapter: rest as BotGroupAdapter })
    await rightClick(
      container.querySelector('[data-bot-missing-group="ghost"] [data-group="bot"]')!
    )
    expect(menus).toEqual([])
  })

  it('PG-8 list() 还没回来：按会话里的名字先列出 pending 组（会话在、没有菜单与「+」），不当成找不到', async () => {
    store.sessions = [botRow('b1', 'scout'), botRow('b2', 'other')]
    const adapter = makeAdapter(() => new Promise<BotRegistry>(() => {}))
    await mount({ adapter })

    expect(groupOrder()).toEqual(['other', 'scout'])
    for (const name of ['other', 'scout']) {
      expect(groupEl(name).hasAttribute('data-bot-group-pending')).toBe(true)
    }
    expect(rowIds(groupEl('scout'))).toEqual(['b1'])
    expect(container.querySelector('[data-bot-missing-group]')).toBeNull()
    expect(container.querySelector('[data-group-add]')).toBeNull()
    expect(container.querySelector('[data-bots-empty]')).toBeNull()
    await rightClick(headerOf('scout'))
    expect(menus).toEqual([])
  })

  it('PG-8 一次都没成功（拒绝）：同样是 pending 组，没有找不到的组', async () => {
    store.sessions = [botRow('b1', 'scout')]
    const adapter = makeAdapter(async () => {
      throw new Error('EACCES')
    })
    await mount({ adapter })
    expect(adapter.list).toHaveBeenCalledTimes(1)
    expect(groupEl('scout').hasAttribute('data-bot-group-pending')).toBe(true)
    expect(container.querySelector('[data-bot-missing-group]')).toBeNull()
    expect(rowIds(groupEl('scout'))).toEqual(['b1'])
  })

  it('PG-8 成功过之后再失败（聚焦重扫被拒）→ 留着上一次的分组', async () => {
    store.sessions = [botRow('b1', 'scout')]
    const adapter = makeAdapter(registryOf({ bots: [bot('scout', 'Scout')] }))
    await mount({ adapter })
    expect(groupEl('scout').hasAttribute('data-bot-group-pending')).toBe(false)

    adapter.list.mockRejectedValueOnce(new Error('EACCES'))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(adapter.list).toHaveBeenCalledTimes(2)
    expect(groupOrder()).toEqual(['scout'])
    expect(groupEl('scout').hasAttribute('data-bot-group-pending')).toBe(false)
    expect(groupEl('scout').querySelector('[data-group-add]')).not.toBeNull()
    expect(container.querySelector('[data-bot-missing-group]')).toBeNull()
  })
})
