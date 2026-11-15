// @vitest-environment jsdom
/**
 * 手机布局的会话详情页（mobile/MobileSessionDetails.tsx，jsdom）。
 *
 * 契约：首页是分组列表 —— 名称（就地改：失焦或回车存，去掉首尾空白；空的 / 没变的不存并退回；输入法组字中的回车
 * 不算）、位置、bot（只有 bot 会话）；扩展能力（有 MCP 可勾才有，数 = 勾着几台）与知识库（有库可选才有，数 = 选着的、
 * 还在的库）；三种访问权限（恒在，数 > 0 才画）；删除会话。带箭头的行各推入一页，页里是会话配置里对应的那一段。
 * 哪一页由外面管（`page` / `onOpenSection` / `onBack`）。
 *
 *   MD-1..5   首页的框架、返回、名称与位置、bot 行
 *   MD-6..13  改名：失焦 / 回车存一次、空与没变不存、组字中的回车、别的键、宿主收下之后才改 store
 *   MD-14..18 扩展能力那一行：有没有、数、跟着 store 变、tools.list 失败
 *   MD-19..20 知识库那一行：有没有、数只数还在的库
 *   MD-21..24 行的顺序、第二张卡没有行就不画、权限行的数、点一行
 *   MD-25..26 删除会话、确认框画在这一页里
 *   MD-27..29 各子页、子页的返回、首页 ↔ 子页是同一个组件
 *   MD-30     名称那一格与外面改了标题：没动过就跟上（失焦不写回旧标题）、打过字就留着、没存上就退回
 *
 * `@shuvix/chat-ui` 换成替身：`useChatStore` 是工厂里建的真 zustand store，`isImeComposing` 是按源码路径引的真函数；
 * `@shuvix/app-shell` 的 SessionConfigPanel 是记 props 的替身；`useSessionLocation` 是真的（只要 useProjects）。真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

type Props = Record<string, unknown>
interface ToolRow {
  name: string
  group?: string
  declaredBy?: string
}
interface StoreApi {
  getState: () => { sessions: Array<Record<string, unknown>> }
  setState: (patch: { sessions: Array<Record<string, unknown>> }) => void
}

const rec = vi.hoisted(() => ({
  store: null as unknown as StoreApi,
  updateSessionTitle: null as unknown as (id: string, title: string) => void,
  updateTitle: null as unknown as (params: { id: string; title: string }) => Promise<unknown>,
  toolsList: null as unknown as (sessionId: string) => Promise<ToolRow[]>,
  enabledTools: [] as string[],
  knowledge: {
    options: [] as Array<{ name: string }>,
    selected: [] as string[],
    explicit: false,
    toggle: (): void => {}
  },
  projects: [] as Array<{ id: string; name: string }>,
  archivedProjects: [] as Array<{ id: string; name: string }>,
  acl: null as { paths: number; sessions: number; widgets: number } | null,
  requestDelete: null as unknown as (id: string) => Promise<void>,
  deleteDialog: null as unknown,
  panel: [] as Array<Record<string, unknown>>
}))

vi.mock('@shuvix/chat-ui', async () => {
  const { vi: v } = await import('vitest')
  const { create } = await import('zustand')
  const ime = await import('../../../../../../../packages/chat-ui/src/utils/ime')
  interface State {
    sessions: Array<Record<string, unknown>>
    updateSessionTitle: (id: string, title: string) => void
  }
  const useChatStore = create<State>((set) => ({
    sessions: [],
    updateSessionTitle: v.fn((id: string, title: string) =>
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s))
      }))
    )
  }))
  rec.store = useChatStore as unknown as StoreApi
  rec.updateSessionTitle = useChatStore.getState().updateSessionTitle
  return {
    useChatStore,
    getChatApi: () => ({
      session: { updateTitle: (params: { id: string; title: string }) => rec.updateTitle(params) }
    }),
    getSessionChannelApi: () => ({
      tools: { list: (sessionId: string) => rec.toolsList(sessionId) }
    }),
    useSessionTools: () => ({ enabledTools: rec.enabledTools, setEnabledTools: () => {} }),
    useSessionKnowledgeBases: () => rec.knowledge,
    isImeComposing: ime.isImeComposing
  }
})

vi.mock('@shuvix/app-shell', async () => {
  const { createElement } = await import('react')
  return {
    SessionConfigPanel: (props: Props) => {
      rec.panel.push(props)
      return createElement('div', { 'data-stub-config-panel': String(props.section) })
    },
    useProjects: () => ({ projects: rec.projects, archivedProjects: rec.archivedProjects }),
    useSessionAclCounts: () => rec.acl,
    useSessionDelete: () => ({
      requestDelete: (id: string) => rec.requestDelete(id),
      deleteDialog: rec.deleteDialog
    })
  }
})

import { MobileSessionDetails } from '../MobileSessionDetails'
import type { MobileDetailPage } from '../detailHistory'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const M = en.mobile
const SECTIONS = ['extensions', 'knowledge', 'paths', 'sessions', 'widgets'] as const
type Section = (typeof SECTIONS)[number]
const SECTION_TITLE: Record<Section, string> = {
  extensions: en.sessionConfig.extensionsGroup,
  knowledge: en.sessionConfig.knowledgeGroup,
  paths: en.sessionAcl.title,
  sessions: en.sessionAcl.sessionsTitle,
  widgets: en.sessionAcl.widgetsTitle
}

const updateTitle = vi.fn<(params: { id: string; title: string }) => Promise<unknown>>()
const toolsList = vi.fn<(sessionId: string) => Promise<ToolRow[]>>()
const requestDelete = vi.fn<(id: string) => Promise<void>>()
const onOpenSection = vi.fn<(section: Section) => void>()
const onBack = vi.fn<() => void>()
const updateSessionTitle = (): ReturnType<typeof vi.fn> =>
  rec.updateSessionTitle as unknown as ReturnType<typeof vi.fn>

let container: HTMLDivElement
let root: Root

const session = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 's1',
  title: 'Title',
  projectId: 'p1',
  parentId: null,
  settings: {},
  ...over
})
function setSessions(...sessions: Array<Record<string, unknown>>): void {
  rec.store.setState({ sessions })
}
/** 外面改了标题（自动起的标题落地、桌面上改了名） */
function retitle(title: string): void {
  act(() =>
    rec.store.setState({
      sessions: rec.store.getState().sessions.map((s) => (s.id === 's1' ? { ...s, title } : s))
    })
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}
function render(page: MobileDetailPage = 'index', sessionId = 's1'): void {
  act(() =>
    root.render(
      h(MobileSessionDetails, {
        sessionId,
        page,
        onOpenSection: onOpenSection as (section: Section) => void,
        onBack
      })
    )
  )
}
async function mount(page: MobileDetailPage = 'index'): Promise<void> {
  render(page)
  await flush()
}

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const nameInput = (): HTMLInputElement =>
  container.querySelector<HTMLInputElement>('[data-mobile-detail-name]')!
const rowOf = (section: string): HTMLElement | null => q(`[data-mobile-detail-row="${section}"]`)
const countOf = (section: string): string | null =>
  rowOf(section)?.querySelector('[data-mobile-detail-count]')?.textContent ?? null
const rows = (): Array<string | null> =>
  Array.from(container.querySelectorAll('[data-mobile-detail-row]')).map((el) =>
    el.getAttribute('data-mobile-detail-row')
  )

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
function focus(): void {
  act(() => nameInput().focus())
}
function blur(): void {
  act(() => nameInput().blur())
}
/** 在受控的输入框里打字：走原生的 value setter 再发 input 事件，React 才认 */
function type(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(nameInput(), value)
    nameInput().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function keydown(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    nameInput().dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    )
  })
}

const MCP_TOOLS: ToolRow[] = [
  { name: 'mcp:a', group: 'mcp:a' },
  { name: 'mcp:b', group: 'mcp:b', declaredBy: 'Work' },
  { name: 'mcp:c', group: 'mcp:c', declaredBy: 'Work' },
  { name: 'mcp:d', group: 'mcp:d' },
  { name: 'read', group: 'general' },
  { name: 'mcp:x', group: '__skills__' }
]

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  setSessions(session())
  updateSessionTitle().mockClear()
  updateTitle.mockReset().mockResolvedValue({})
  toolsList.mockReset().mockResolvedValue([])
  requestDelete.mockReset().mockResolvedValue(undefined)
  onOpenSection.mockReset()
  onBack.mockReset()
  rec.updateTitle = updateTitle
  rec.toolsList = toolsList
  rec.requestDelete = requestDelete
  rec.enabledTools = []
  rec.knowledge = { options: [], selected: [], explicit: false, toggle: () => {} }
  rec.projects = [{ id: 'p1', name: 'Proj' }]
  rec.archivedProjects = []
  rec.acl = null
  rec.deleteDialog = null
  rec.panel.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('MobileSessionDetails: the index page', () => {
  it('MD-1 the index frame: title, back label, no section content', async () => {
    await mount()
    expect(q('[data-mobile-details="index"]')).not.toBeNull()
    expect(q('[data-mobile-details-title]')!.textContent).toBe(M.details)
    expect(q('[data-mobile-details-back]')!.textContent).toBe(M.detailsBack)
    expect(q('[data-mobile-detail-section]')).toBeNull()
    expect(q('[data-stub-config-panel]')).toBeNull()
  })

  it('MD-2 the back button calls onBack', async () => {
    await mount()
    click(q('[data-mobile-details-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onOpenSection).not.toHaveBeenCalled()
  })

  it('MD-3 name and location', async () => {
    await mount()
    expect(nameInput().value).toBe('Title')
    expect(q('[data-mobile-detail-location]')!.textContent).toBe('Proj')
  })

  it('MD-4 the location is empty while the project list is loading', async () => {
    rec.projects = []
    await mount()
    expect(q('[data-mobile-detail-location]')!.textContent).toBe('')
  })

  it('MD-5 the bot row shows the bound bot, trimmed', async () => {
    setSessions(session({ projectId: null, settings: { bot: ' scout ' } }))
    await mount()
    expect(q('[data-mobile-detail-bot]')!.textContent).toBe('scout')
  })

  it('MD-5 a session that is not a bot session has no bot row', async () => {
    await mount()
    expect(q('[data-mobile-detail-bot]')).toBeNull()
  })
})

describe('MobileSessionDetails: renaming in place', () => {
  it('MD-6 blur saves a trimmed, changed name', async () => {
    await mount()
    focus()
    type('  New name ')
    blur()
    await flush()
    expect(updateTitle).toHaveBeenCalledTimes(1)
    expect(updateTitle).toHaveBeenCalledWith({ id: 's1', title: 'New name' })
    expect(updateSessionTitle()).toHaveBeenCalledWith('s1', 'New name')
  })

  it('MD-7 Enter saves, once', async () => {
    await mount()
    focus()
    type('New')
    keydown('Enter')
    await flush()
    expect(updateTitle).toHaveBeenCalledTimes(1)
    expect(updateTitle).toHaveBeenCalledWith({ id: 's1', title: 'New' })
    expect(document.activeElement).not.toBe(nameInput())
  })

  it.each([
    ['an empty name', ''],
    ['a blank name', '   ']
  ])('MD-8 %s restores the title and saves nothing', async (_label, text) => {
    await mount()
    focus()
    type(text)
    blur()
    await flush()
    expect(updateTitle).not.toHaveBeenCalled()
    expect(nameInput().value).toBe('Title')
  })

  it('MD-9 an unchanged name (padding aside) restores and saves nothing', async () => {
    await mount()
    focus()
    type('  Title  ')
    blur()
    await flush()
    expect(updateTitle).not.toHaveBeenCalled()
    expect(nameInput().value).toBe('Title')
  })

  it('MD-10 blur without typing saves nothing', async () => {
    await mount()
    focus()
    blur()
    await flush()
    expect(updateTitle).not.toHaveBeenCalled()
    expect(updateSessionTitle()).not.toHaveBeenCalled()
  })

  it.each<[string, KeyboardEventInit]>([
    ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }]
  ])('MD-11 Enter during IME composition (%s) does nothing', async (_label, init) => {
    await mount()
    focus()
    type('新名')
    keydown('Enter', init)
    await flush()
    expect(updateTitle).not.toHaveBeenCalled()
    expect(nameInput().value).toBe('新名')
    expect(document.activeElement).toBe(nameInput())
  })

  it('MD-12 other keys do not save', async () => {
    await mount()
    focus()
    type('New')
    keydown('a')
    keydown('Escape')
    keydown('Tab')
    await flush()
    expect(updateTitle).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(nameInput())
  })

  it('MD-13 the store is updated only after the host accepted the name', async () => {
    let accept!: () => void
    updateTitle.mockReturnValue(new Promise<void>((resolve) => (accept = resolve)))
    await mount()
    focus()
    type('New')
    blur()
    await flush()
    expect(updateTitle).toHaveBeenCalledTimes(1)
    expect(updateSessionTitle()).not.toHaveBeenCalled()
    await act(async () => accept())
    await flush()
    expect(updateSessionTitle()).toHaveBeenCalledWith('s1', 'New')
  })

  it('MD-30 a title changed elsewhere reaches an untouched field; focus and blur then save nothing', async () => {
    await mount()
    retitle('Auto title')
    expect(nameInput().value).toBe('Auto title')
    focus()
    blur()
    await flush()
    expect(updateTitle).not.toHaveBeenCalled()
    expect(nameInput().value).toBe('Auto title')
  })

  it('MD-30 text the user typed survives a title change elsewhere; blur saves the typed text', async () => {
    await mount()
    focus()
    type('Mine')
    retitle('Auto title')
    expect(nameInput().value).toBe('Mine')
    blur()
    await flush()
    expect(updateTitle).toHaveBeenCalledTimes(1)
    expect(updateTitle).toHaveBeenCalledWith({ id: 's1', title: 'Mine' })
    expect(updateSessionTitle()).toHaveBeenCalledWith('s1', 'Mine')
    expect(nameInput().value).toBe('Mine')
  })

  it('MD-30 a save the host rejects: no unhandled rejection, the store untouched, the field back at the title', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      updateTitle.mockRejectedValue(new Error('disconnected'))
      await mount()
      focus()
      type('New')
      blur()
      await flush()
      // unhandledRejection 在微任务清空之后才发：让出一个宏任务
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(updateTitle).toHaveBeenCalledTimes(1)
      expect(unhandled).toEqual([])
      expect(updateSessionTitle()).not.toHaveBeenCalled()
      expect(nameInput().value).toBe('Title')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('MobileSessionDetails: the extensions and knowledge rows', () => {
  it('MD-14 the extensions row is there when the session has MCP servers; its number = the selected ones', async () => {
    toolsList.mockResolvedValue(MCP_TOOLS)
    rec.enabledTools = ['mcp:a', '-mcp:c']
    await mount()
    expect(toolsList).toHaveBeenCalledWith('s1')
    expect(rowOf('extensions')).not.toBeNull()
    expect(rowOf('extensions')!.textContent).toContain(SECTION_TITLE.extensions)
    expect(countOf('extensions')).toBe('2')
  })

  it('MD-15 an opt-out beats a tick on the same server: the row has no number', async () => {
    toolsList.mockResolvedValue([{ name: 'mcp:a', group: 'mcp:a' }])
    rec.enabledTools = ['mcp:a', '-mcp:a']
    await mount()
    expect(rowOf('extensions')).not.toBeNull()
    expect(countOf('extensions')).toBeNull()
  })

  it('MD-16 no MCP servers → no extensions row', async () => {
    toolsList.mockResolvedValue([
      { name: 'read', group: 'general' },
      { name: 'mcp:x', group: '__skills__' }
    ])
    await mount()
    expect(rowOf('extensions')).toBeNull()
  })

  it('MD-17 the number follows the selection without listing the tools again', async () => {
    toolsList.mockResolvedValue(MCP_TOOLS)
    rec.enabledTools = ['mcp:a', '-mcp:c']
    await mount()
    rec.enabledTools = ['mcp:a', 'mcp:d', '-mcp:c']
    render()
    await flush()
    expect(countOf('extensions')).toBe('3')
    expect(toolsList).toHaveBeenCalledTimes(1)
  })

  it('MD-18 a failed tools.list leaves no extensions row and breaks nothing else', async () => {
    toolsList.mockRejectedValue(new Error('offline'))
    await mount()
    expect(rowOf('extensions')).toBeNull()
    expect(rows()).toEqual(['paths', 'sessions', 'widgets'])
    expect(nameInput().value).toBe('Title')
    expect(q('[data-mobile-detail-delete]')).not.toBeNull()
  })

  it('MD-19 the knowledge row is there when there are bases to pick; its number = the selected ones', async () => {
    rec.knowledge = { ...rec.knowledge, options: [{ name: 'notes' }, { name: 'work' }] }
    rec.knowledge.selected = ['notes']
    await mount()
    expect(rowOf('knowledge')!.textContent).toContain(SECTION_TITLE.knowledge)
    expect(countOf('knowledge')).toBe('1')

    rec.knowledge = { ...rec.knowledge, selected: [] }
    render()
    expect(rowOf('knowledge')).not.toBeNull()
    expect(countOf('knowledge')).toBeNull()
  })

  it('MD-19 a selected base that no longer exists is not counted', async () => {
    rec.knowledge = {
      ...rec.knowledge,
      options: [{ name: 'notes' }, { name: 'work' }],
      selected: ['notes', 'gone']
    }
    await mount()
    expect(countOf('knowledge')).toBe('1')

    rec.knowledge = { ...rec.knowledge, selected: ['gone'] }
    render()
    expect(rowOf('knowledge')).not.toBeNull()
    expect(countOf('knowledge')).toBeNull()
  })

  it('MD-20 no bases to pick → no knowledge row', async () => {
    rec.knowledge = { ...rec.knowledge, options: [], selected: ['gone'] }
    await mount()
    expect(rowOf('knowledge')).toBeNull()
  })
})

describe('MobileSessionDetails: rows, access counts, delete', () => {
  it('MD-21 the row order with everything present', async () => {
    toolsList.mockResolvedValue(MCP_TOOLS)
    rec.knowledge = { ...rec.knowledge, options: [{ name: 'notes' }], selected: ['notes'] }
    await mount()
    expect(rows()).toEqual([...SECTIONS])
  })

  it('MD-22 with no MCP servers and no bases the second card is absent', async () => {
    await mount()
    expect(rows()).toEqual(['paths', 'sessions', 'widgets'])
    const card = rowOf('paths')!.parentElement!
    expect(rowOf('sessions')!.parentElement).toBe(card)
    expect(rowOf('widgets')!.parentElement).toBe(card)
    // 名称卡、权限卡、删除卡：没有一张空卡夹在中间
    expect(card.parentElement!.children).toHaveLength(3)
  })

  it('MD-23 the access rows always exist; a number only when it is above zero', async () => {
    await mount()
    expect(rows()).toEqual(['paths', 'sessions', 'widgets'])
    expect(container.querySelector('[data-mobile-detail-count]')).toBeNull()

    rec.acl = { paths: 4, sessions: 0, widgets: 2 }
    render()
    expect(countOf('paths')).toBe('4')
    expect(countOf('sessions')).toBeNull()
    expect(countOf('widgets')).toBe('2')
  })

  it.each(SECTIONS)('MD-24 the %s row opens its section', async (section) => {
    toolsList.mockResolvedValue(MCP_TOOLS)
    rec.knowledge = { ...rec.knowledge, options: [{ name: 'notes' }] }
    await mount()
    click(rowOf(section)!)
    expect(onOpenSection).toHaveBeenCalledTimes(1)
    expect(onOpenSection).toHaveBeenCalledWith(section)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('MD-25 delete chat asks the shared delete flow for this session', async () => {
    await mount()
    const button = q('[data-mobile-detail-delete]')!
    expect(button.textContent).toBe(M.deleteChat)
    click(button)
    expect(requestDelete).toHaveBeenCalledTimes(1)
    expect(requestDelete).toHaveBeenCalledWith('s1')
  })

  it.each<MobileDetailPage>(['index', 'paths'])(
    'MD-26 the delete confirmation is drawn inside the page (%s)',
    async (page) => {
      rec.deleteDialog = h('div', { 'data-stub-delete-dialog': '' }) as ReactNode
      await mount(page)
      expect(q('[data-mobile-details] [data-stub-delete-dialog]')).not.toBeNull()
    }
  )
})

describe('MobileSessionDetails: section pages', () => {
  it.each(SECTIONS)('MD-27 the %s page holds that part of the session config', async (section) => {
    await mount(section)
    expect(q(`[data-mobile-details="${section}"]`)).not.toBeNull()
    expect(q('[data-mobile-details-back]')!.textContent).toBe(M.details)
    expect(q('[data-mobile-details-title]')!.textContent).toBe(SECTION_TITLE[section])
    expect(
      q(`[data-mobile-detail-section="${section}"] [data-stub-config-panel="${section}"]`)
    ).not.toBeNull()
    expect(rec.panel.at(-1)).toEqual({ sessionId: 's1', section })
    expect(q('[data-mobile-detail-name]')).toBeNull()
    expect(q('[data-mobile-detail-row]')).toBeNull()
    expect(q('[data-mobile-detail-delete]')).toBeNull()
  })

  it('MD-28 back on a section page calls onBack', async () => {
    await mount('paths')
    click(q('[data-mobile-details-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onOpenSection).not.toHaveBeenCalled()
  })

  it('MD-29 index → section → index is one component: the tools are listed once, the name is back', async () => {
    toolsList.mockResolvedValue(MCP_TOOLS)
    await mount('index')
    await mount('paths')
    expect(q('[data-mobile-detail-name]')).toBeNull()
    await mount('index')
    expect(toolsList).toHaveBeenCalledTimes(1)
    expect(nameInput().value).toBe('Title')
    expect(rowOf('extensions')).not.toBeNull()
  })
})
