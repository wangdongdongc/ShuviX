// @vitest-environment jsdom
/**
 * KnowledgeGroup 的两层导航（`drill`，手机布局的资料库；jsdom）。
 *
 * 契约：给了 `drill` —— 一挂上就扫。`scope === null` 只画一行导航行（数量 = 这一组里的库：用户库连同空的、
 * 内置库；项目库与 bot 库不算）；`scope === 'knowledge'` 是各个库的那一页（「我的」在上、「内置」在下，每个库一行：
 * 名字 + 条目数，点它 = `onOpen('knowledge:<库的路径>', 名字)`，不就地展开）；`scope === 'knowledge:<库的路径>'`
 * 是那个库里的文件夹与条目（文件夹照旧就地展开，点条目 = `adapter.open`），库不在了是一句话；别的 scope 什么都不画。
 * 新建：库的输入行长在「知识库」那一页最上面，条目 / 文件夹的输入行长在库那一页最上面（或落点文件夹里）。
 *
 *   KG-10 / KG-11 / KG-12 顶层的导航行：数量、点、长按菜单
 *   KG-13 / KG-14 / KG-15 知识库那一页：两节与行、空态、工具栏
 *   KG-16 / KG-17 新建库：「+」与「⋯ → 新建知识库」同一行输入；回车 / Esc / 失败
 *   KG-18 点一个库 → onOpen，不展开
 *   KG-19 / KG-20 / KG-21 库的那一页：只有这个库的树、文件夹就地展开、点条目照开（就是活跃的那份也开）
 *   KG-22 / KG-23 库页的工具栏与「⋯」：新建条目 / 文件夹、刷新
 *   KG-24 只读的库；KG-25 空的可写库；KG-26 库不在了；KG-27 扫描没回来；KG-28 重扫时库没了
 *   KG-29 别的页开着：什么都不画
 *   KG-30 库页里长按子文件夹：往那一层新建
 *   KG-31 不给 drill：挂上不扫、没有导航行
 *   KG-32 顶层导航行的菜单里点「新建知识库」（B1）：先 `onOpen('knowledge', 名字)`，宿主换到那一页后输入行在最上面；
 *         从知识库那一页自己的「⋯」点：不调 onOpen；两种都不多扫一次
 *
 * 右键菜单走 ContextMenuProvider 的 `render` 注入。`@shuvix/chat-ui` 换成能改的小 store 与记下订阅者的
 * useAppEvent。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { KNOWLEDGE_USER_PROJECT_ID, type KnowledgeEntry } from '@shuvix/chat-protocol/knowledge'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'

const mocks = vi.hoisted(() => ({
  appEvents: new Map<string, Set<() => void>>(),
  chat: {
    sessions: [] as Array<{
      id: string
      projectId?: string | null
      settings: { notebookPath?: string }
    }>,
    activeSessionId: null as string | null
  }
}))

vi.mock('@shuvix/chat-ui', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    // 记下每个订阅者，用例里按事件名派发；回调走 ref，拿到的总是最新一次渲染的闭包
    useAppEvent: (type: string, handler: () => void) => {
      const ref = useRef(handler)
      ref.current = handler
      useEffect(() => {
        const fn = (): void => ref.current()
        if (!mocks.appEvents.has(type)) mocks.appEvents.set(type, new Set())
        mocks.appEvents.get(type)!.add(fn)
        return () => {
          mocks.appEvents.get(type)?.delete(fn)
        }
      }, [type])
    },
    useChatStore: (selector: (s: typeof mocks.chat) => unknown) => selector(mocks.chat),
    useChatHost: () => ({ appearance: { focusMode: false } })
  }
})

import { KnowledgeGroup } from './KnowledgeGroup'
import type {
  KnowledgeCreateResult,
  KnowledgeGroupAdapter,
  KnowledgeListing
} from './KnowledgeTreeView'
import { LIBRARY_KNOWLEDGE_BASE_PREFIX, type LibraryDrill } from './LibraryPage'
import { ContextMenuProvider } from '../contextmenu/ContextMenuProvider'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const stemOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')

const entry = (path: string, title = stemOf(path)): KnowledgeEntry => ({
  path,
  bundle: path.split('/').slice(0, 2).join('/'),
  type: 'Memory',
  title,
  description: '',
  status: 'stable',
  tags: [],
  trustTier: 'unverified',
  verifiedCurrent: false,
  stale: false
})

const NOTES = 'knowledge/notes'
const EMPTY = 'knowledge/empty'
const BUILTIN = 'builtin/shuvix'

/** 两个用户库（一个只有目录、没有条目）、内置库，外加必须被忽略的项目库与 bot 库 */
const LISTING: KnowledgeListing = {
  entries: [
    entry(`${NOTES}/n.md`, 'Note N'),
    entry(`${NOTES}/sub/deep.md`, 'Deep'),
    entry(`${NOTES}/sub/deeper/x.md`, 'X'),
    entry(`${BUILTIN}/guide.md`, 'Guide'),
    entry('projects/p1/a.md', 'Project entry'),
    entry('bots/k/b.md', 'Bot entry')
  ],
  root: '/kb-shuvix',
  userRoot: '/kb-user',
  dirs: [
    NOTES,
    `${NOTES}/sub`,
    `${NOTES}/sub/deeper`,
    EMPTY,
    BUILTIN,
    'projects',
    'projects/p1',
    'bots',
    'bots/k'
  ],
  bundleNames: { [BUILTIN]: 'ShuviX', 'projects/p1': 'Proj One', 'bots/k': 'Bot K' }
}
const withoutNotes: KnowledgeListing = {
  ...LISTING,
  entries: LISTING.entries.filter((e) => !e.path.startsWith(`${NOTES}/`)),
  dirs: (LISTING.dirs ?? []).filter((d) => d !== NOTES && !d.startsWith(`${NOTES}/`))
}

type Adapter = KnowledgeGroupAdapter & {
  list: ReturnType<typeof vi.fn<() => Promise<KnowledgeListing>>>
  open: ReturnType<typeof vi.fn<(path: string, title: string) => void>>
  createBase?: ReturnType<typeof vi.fn<(name: string) => Promise<KnowledgeCreateResult>>>
  createEntry?: ReturnType<
    typeof vi.fn<(dir: string, title: string) => Promise<KnowledgeCreateResult>>
  >
  createFolder?: ReturnType<
    typeof vi.fn<(dir: string, name: string) => Promise<KnowledgeCreateResult>>
  >
}

function makeAdapter(
  listing: KnowledgeListing = LISTING,
  without: Array<'createBase' | 'createEntry' | 'createFolder'> = []
): Adapter {
  const adapter: Adapter = {
    list: vi.fn(async () => listing),
    open: vi.fn<(path: string, title: string) => void>(),
    openFolder: vi.fn(),
    createBase: vi.fn(async (name: string) => ({ success: true, id: `knowledge/${name}` })),
    createEntry: vi.fn(async (dir: string, title: string) => ({
      success: true,
      id: `${dir}/${title.toLowerCase()}.md`
    })),
    createFolder: vi.fn(async (dir: string, name: string) => ({
      success: true,
      id: `${dir}/${name}`
    }))
  }
  for (const key of without) delete adapter[key]
  return adapter
}

let container: HTMLDivElement
let root: Root
let mounted: boolean
let menus: ContextMenuItem[][]
let pick: string | null
const slots: HTMLElement[] = []

function slot(): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-test-slot', '')
  document.body.appendChild(el)
  slots.push(el)
  return el
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** 渲染（同一条用例里再调一次 = 同一个实例换 props），并等扫描回来 */
async function show(adapter: Adapter, drill?: LibraryDrill): Promise<void> {
  mounted = true
  type ProviderProps = ComponentProps<typeof ContextMenuProvider>
  const props: Omit<ProviderProps, 'children'> = {
    render: async (items: ContextMenuItem[]) => {
      menus.push(items)
      return pick
    }
  }
  act(() =>
    root.render(
      createElement(
        ContextMenuProvider,
        props as ProviderProps,
        createElement(KnowledgeGroup, { adapter, drill })
      )
    )
  )
  await flush()
}

const drillAt = (scope: string | null, extra: Partial<LibraryDrill> = {}): LibraryDrill => ({
  scope,
  onOpen: vi.fn(),
  ...extra
})
const baseScope = (path: string): string => `${LIBRARY_KNOWLEDGE_BASE_PREFIX}${path}`

const q = (sel: string, from: ParentNode = container): HTMLElement | null =>
  from.querySelector<HTMLElement>(sel)
const qa = (sel: string, from: ParentNode = container): HTMLElement[] => [
  ...from.querySelectorAll<HTMLElement>(sel)
]
const must = (sel: string, from: ParentNode = container): HTMLElement => {
  const el = q(sel, from)
  if (!el) throw new Error(`${sel} not rendered`)
  return el
}
const NAV = '[data-group-nav="knowledge"]'
const navCount = (): string | null => q('[data-group-count]')?.textContent ?? null
const dirSel = (path: string): string => `[data-knowledge-dir="${path}"]`
const rowSel = (path: string): string => `[data-knowledge-row="${path}"]`
const rowPaths = (scope: ParentNode = container): string[] =>
  qa('[data-knowledge-row]', scope).map((el) => el.getAttribute('data-knowledge-row') ?? '')
const dirPaths = (scope: ParentNode = container): string[] =>
  qa('[data-knowledge-dir]', scope).map((el) => el.getAttribute('data-knowledge-dir') ?? '')
const sectionKeys = (): string[] =>
  qa('[data-library-section]').map((el) => el.getAttribute('data-library-section') ?? '')
const sectionDirs = (key: string): string[] => dirPaths(must(`[data-library-section="${key}"]`))
const countText = (): string | null => q('[data-library-count]')?.textContent ?? null
const emptyText = (): string | null => q('[data-library-empty]')?.textContent ?? null
const draft = (kind: string): HTMLElement | null => q(`[data-knowledge-draft="${kind}"]`)
/** 目录行下面那层折叠容器（AnimatedCollapse 根）是否展开 */
const dirOpen = (path: string): boolean =>
  (must(dirSel(path)).nextElementSibling as HTMLElement | null)?.style.gridTemplateRows === '1fr'
/** a 在 b 之前（文档顺序） */
const before = (a: Element, b: Element): boolean =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
const label = (): string => i18n.t('sidebar.knowledgeGroup')

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await flush()
}
async function contextMenu(el: Element): Promise<ContextMenuItem[]> {
  const count = menus.length
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await flush()
  expect(menus.length).toBe(count + 1)
  return menus[menus.length - 1]
}
/** 点一颗会弹菜单的按钮 */
async function menuByClick(el: Element): Promise<ContextMenuItem[]> {
  const count = menus.length
  await click(el)
  expect(menus.length).toBe(count + 1)
  return menus[menus.length - 1]
}
const ids = (items: ContextMenuItem[]): Array<string | undefined> =>
  items.map((item) => ('id' in item ? item.id : undefined))
async function emit(type: string): Promise<void> {
  await act(async () => {
    for (const fn of [...(mocks.appEvents.get(type) ?? [])]) fn()
  })
  await flush()
  await flush()
}
/** 在输入行里打字（受控输入：走原生 setter 再发 input） */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function press(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
  await flush()
  await flush()
}
const inputOf = (kind: string): HTMLInputElement => must('input', draft(kind)!) as HTMLInputElement

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
  mounted = false
  mocks.appEvents.clear()
  mocks.chat.sessions = []
  mocks.chat.activeSessionId = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  container.remove()
  for (const el of slots.splice(0)) el.remove()
})

describe('KnowledgeGroup drill: the top level', () => {
  it('KG-10 one nav row; the count is the bases of this group (user bases incl. an empty one + the builtin), scanned once at mount', async () => {
    const adapter = makeAdapter()
    await show(adapter, drillAt(null))
    const row = must(NAV)
    expect(row.getAttribute('data-group')).toBe('knowledge')
    expect(row.textContent).toContain(label())
    expect(navCount()).toBe('3')
    expect(adapter.list).toHaveBeenCalledTimes(1)
    expect(dirPaths()).toEqual([])
    expect(rowPaths()).toEqual([])
    expect(q('[data-library-page]')).toBeNull()
  })

  it('KG-11 a click on the nav row → onOpen("knowledge", the group label)', async () => {
    const drill = drillAt(null)
    const adapter = makeAdapter()
    await show(adapter, drill)
    await click(must('button', must(NAV)))
    expect(drill.onOpen).toHaveBeenCalledTimes(1)
    expect(drill.onOpen).toHaveBeenCalledWith('knowledge', label())
    expect(dirPaths()).toEqual([])
    expect(adapter.list).toHaveBeenCalledTimes(1)
  })

  it('KG-12 the nav row’s menu: new base only when the host can create one; open folder; refresh', async () => {
    const adapter = makeAdapter()
    await show(adapter, drillAt(null))
    expect(ids(await contextMenu(must(NAV)))).toEqual([
      'new-base',
      undefined,
      'open-folder',
      undefined,
      'refresh'
    ])

    pick = 'open-folder'
    await contextMenu(must(NAV))
    expect(adapter.openFolder).toHaveBeenCalledTimes(1)
    pick = 'refresh'
    await contextMenu(must(NAV))
    expect(adapter.list).toHaveBeenCalledTimes(2)

    act(() => root.unmount())
    root = createRoot(container)
    pick = null
    await show(makeAdapter(LISTING, ['createBase']), drillAt(null))
    expect(ids(await contextMenu(must(NAV)))).toEqual(['open-folder', undefined, 'refresh'])
  })

  it.each(['agents', 'skills', 'policies'])(
    'KG-29 another page open (%s): nothing is drawn, yet it scanned once',
    async (scope) => {
      const adapter = makeAdapter()
      await show(adapter, drillAt(scope))
      expect(container.children).toHaveLength(0)
      expect(adapter.list).toHaveBeenCalledTimes(1)
    }
  )

  it('KG-31 without drill: nothing is scanned at mount and the header is not a nav row', async () => {
    const adapter = makeAdapter()
    await show(adapter)
    expect(adapter.list).not.toHaveBeenCalled()
    const header = must('[data-group="knowledge"]')
    expect(header.hasAttribute('data-group-nav')).toBe(false)
    expect(q('[data-group-count]')).toBeNull()
    expect(q('[data-library-page]')).toBeNull()

    // 展开才扫；库是就地展开的树行
    await click(must('button', header))
    expect(adapter.list).toHaveBeenCalledTimes(1)
    expect(dirPaths()).toContain(NOTES)
    expect(q('[data-library-row]')).toBeNull()
    expect(q('[data-library-toolbar]')).toBeNull()
  })
})

describe('KnowledgeGroup drill: the knowledge page (the bases)', () => {
  it('KG-13 Mine above Built-in; one row per base: its name, the entry count through sub-folders, a lock on the builtin only', async () => {
    await show(makeAdapter(), drillAt('knowledge'))
    expect(must('[data-library-page]').getAttribute('data-library-page')).toBe('knowledge')
    expect(q(NAV)).toBeNull()
    expect(sectionKeys()).toEqual(['mine', 'builtin'])
    expect(qa('[data-library-section-label]').map((el) => el.textContent)).toEqual([
      i18n.t('mobile.libraryMine'),
      i18n.t('mobile.libraryBuiltin')
    ])
    expect(sectionDirs('mine')).toEqual([EMPTY, NOTES])
    expect(sectionDirs('builtin')).toEqual([BUILTIN])
    // 项目库与 bot 库不在这一组
    expect(dirPaths().some((p) => p.startsWith('projects') || p.startsWith('bots'))).toBe(false)

    const part = (path: string, what: string): string | null =>
      q(`[data-library-row-${what}]`, must(dirSel(path)))?.textContent ?? null
    expect(must(dirSel(NOTES)).hasAttribute('data-library-row')).toBe(true)
    expect(part(EMPTY, 'title')).toBe('empty')
    expect(part(NOTES, 'title')).toBe('notes')
    expect(part(BUILTIN, 'title')).toBe('ShuviX')
    expect(part(EMPTY, 'description')).toBe(i18n.t('mobile.libraryEntries', { count: 0 }))
    expect(part(NOTES, 'description')).toBe(i18n.t('mobile.libraryEntries', { count: 3 }))
    expect(part(BUILTIN, 'description')).toBe(i18n.t('mobile.libraryEntries', { count: 1 }))
    expect(q('[data-library-row-lock]', must(dirSel(BUILTIN)))).not.toBeNull()
    expect(q('[data-library-row-lock]', must(dirSel(NOTES)))).toBeNull()
    expect(q('[data-library-row-lock]', must(dirSel(EMPTY)))).toBeNull()
    // 这一页不画条目
    expect(rowPaths()).toEqual([])
  })

  it('KG-14 no bases → the empty sentence; the builtin alone → no Mine section', async () => {
    await show(
      makeAdapter({ entries: [], root: '/kb', userRoot: '/kb-user', dirs: [], bundleNames: {} }),
      drillAt('knowledge')
    )
    expect(sectionKeys()).toEqual([])
    expect(emptyText()).toBe(i18n.t('sidebar.knowledgeEmpty'))

    act(() => root.unmount())
    root = createRoot(container)
    await show(
      makeAdapter({
        entries: [entry(`${BUILTIN}/guide.md`, 'Guide'), entry('projects/p1/a.md')],
        root: '/kb',
        userRoot: '/kb-user',
        dirs: [BUILTIN, 'projects', 'projects/p1'],
        bundleNames: { [BUILTIN]: 'ShuviX' }
      }),
      drillAt('knowledge')
    )
    expect(sectionKeys()).toEqual(['builtin'])
    expect(emptyText()).toBeNull()
    expect(countText()).toBe(i18n.t('mobile.libraryCount', { count: 1, name: label() }))
  })

  it('KG-15 the toolbar: all bases, then how many are the user’s; the new button only when the host can create a base', async () => {
    await show(makeAdapter(), drillAt('knowledge'))
    expect(countText()).toBe(
      `${i18n.t('mobile.libraryCount', { count: 3, name: label() })} · ${i18n.t(
        'mobile.libraryOwn',
        { count: 2 }
      )}`
    )
    const add = must('[data-library-new]')
    expect(add.getAttribute('aria-label')).toBe(i18n.t('knowledge.newBase'))

    act(() => root.unmount())
    root = createRoot(container)
    await show(makeAdapter(LISTING, ['createBase']), drillAt('knowledge'))
    expect(q('[data-library-new]')).toBeNull()
    expect(q('[data-library-toolbar]')).not.toBeNull()
  })

  it('KG-16 "+" starts a base draft above the first section; Enter creates it, rescans and shows the new base', async () => {
    const adapter = makeAdapter()
    await show(adapter, drillAt('knowledge'))
    expect(draft('base')).toBeNull()
    await click(must('[data-library-new]'))
    const row = draft('base')!
    expect(row).not.toBeNull()
    expect(before(row, must('[data-library-section]'))).toBe(true)

    adapter.list.mockResolvedValue({
      ...LISTING,
      dirs: [...(LISTING.dirs ?? []), 'knowledge/fresh']
    })
    await typeInto(inputOf('base'), 'fresh')
    await press(inputOf('base'), 'Enter')
    expect(adapter.createBase!.mock.calls).toEqual([['fresh']])
    expect(adapter.list).toHaveBeenCalledTimes(2)
    expect(draft('base')).toBeNull()
    expect(sectionDirs('mine')).toContain('knowledge/fresh')
    // 建的是库：不打开任何笔记
    expect(adapter.open).not.toHaveBeenCalled()
  })

  it('KG-16 Escape drops the draft without creating; a refusal keeps the draft and shows the host’s reason', async () => {
    const adapter = makeAdapter()
    await show(adapter, drillAt('knowledge'))
    await click(must('[data-library-new]'))
    await typeInto(inputOf('base'), 'whatever')
    await press(inputOf('base'), 'Escape')
    expect(draft('base')).toBeNull()
    expect(adapter.createBase).not.toHaveBeenCalled()

    adapter.createBase!.mockResolvedValue({ success: false, error: 'taken' })
    await click(must('[data-library-new]'))
    await typeInto(inputOf('base'), 'notes')
    await press(inputOf('base'), 'Enter')
    expect(adapter.createBase!.mock.calls).toEqual([['notes']])
    expect(draft('base')).not.toBeNull()
    expect(draft('base')!.textContent).toContain('taken')
    expect(adapter.list).toHaveBeenCalledTimes(1)
  })

  it('KG-17 the page’s own menu → new-base starts the same draft', async () => {
    const menuSlot = slot()
    const adapter = makeAdapter()
    await show(adapter, drillAt('knowledge', { menuSlot }))
    const button = must('[data-library-menu]', menuSlot)
    expect(button.getAttribute('aria-label')).toBe(i18n.t('sidebar.moreActions'))
    pick = 'new-base'
    expect(ids(await menuByClick(button))).toEqual([
      'new-base',
      undefined,
      'open-folder',
      undefined,
      'refresh'
    ])
    expect(draft('base')).not.toBeNull()
    expect(before(draft('base')!, must('[data-library-section]'))).toBe(true)
  })

  it('KG-18 a tap on a base → onOpen("knowledge:<path>", its name); nothing expands in place', async () => {
    const drill = drillAt('knowledge')
    const adapter = makeAdapter()
    await show(adapter, drill)
    await click(must(dirSel(NOTES)))
    expect(drill.onOpen).toHaveBeenCalledTimes(1)
    expect(drill.onOpen).toHaveBeenCalledWith(baseScope(NOTES), 'notes')
    expect(baseScope(NOTES)).toBe('knowledge:knowledge/notes')
    expect(rowPaths()).toEqual([])
    expect(adapter.open).not.toHaveBeenCalled()

    await click(must(dirSel(BUILTIN)))
    expect(drill.onOpen).toHaveBeenLastCalledWith('knowledge:builtin/shuvix', 'ShuviX')
    expect(drill.onOpen).toHaveBeenCalledTimes(2)
  })

  it('KG-32 new base picked from the top-level nav row’s menu: onOpen first, then the draft at the top of the knowledge page; no extra scan', async () => {
    const adapter = makeAdapter()
    const drill = drillAt(null)
    await show(adapter, drill)
    pick = 'new-base'
    await contextMenu(must(NAV))
    expect(drill.onOpen).toHaveBeenCalledTimes(1)
    expect(drill.onOpen).toHaveBeenCalledWith('knowledge', label())
    expect(adapter.list).toHaveBeenCalledTimes(1)

    // 宿主换到「知识库」那一页：输入行在最上面
    await show(adapter, drillAt('knowledge'))
    expect(draft('base')).not.toBeNull()
    expect(before(draft('base')!, must('[data-library-section]'))).toBe(true)
    expect(adapter.list).toHaveBeenCalledTimes(1)

    await typeInto(inputOf('base'), 'fresh')
    await press(inputOf('base'), 'Enter')
    expect(adapter.createBase!.mock.calls).toEqual([['fresh']])
  })

  it('KG-32 new base picked from the knowledge page’s own menu does not call onOpen and does not rescan', async () => {
    const menuSlot = slot()
    const adapter = makeAdapter()
    const drill = drillAt('knowledge', { menuSlot })
    await show(adapter, drill)
    pick = 'new-base'
    await menuByClick(must('[data-library-menu]', menuSlot))
    expect(drill.onOpen).not.toHaveBeenCalled()
    expect(draft('base')).not.toBeNull()
    expect(adapter.list).toHaveBeenCalledTimes(1)
  })
})

describe('KnowledgeGroup drill: a base page', () => {
  it('KG-19 the page of one base: its tree in a card, nothing of the other bases, no sections', async () => {
    await show(makeAdapter(), drillAt(baseScope(NOTES)))
    expect(must('[data-library-page]').getAttribute('data-library-page')).toBe(baseScope(NOTES))
    const base = must(`[data-library-knowledge-base="${NOTES}"]`)
    expect(base.classList.contains('sb-card')).toBe(true)
    expect(q(rowSel(`${NOTES}/n.md`), base)).not.toBeNull()
    expect(q(dirSel(`${NOTES}/sub`), base)).not.toBeNull()
    expect(rowPaths().every((p) => p.startsWith(`${NOTES}/`))).toBe(true)
    expect(dirPaths().every((p) => p.startsWith(`${NOTES}/`))).toBe(true)
    // 库本身不再是一行：这一页就是它
    expect(q(dirSel(NOTES))).toBeNull()
    expect(sectionKeys()).toEqual([])
    expect(emptyText()).toBeNull()
  })

  it('KG-20 folders expand in place; drill.onOpen is not called', async () => {
    const drill = drillAt(baseScope(NOTES))
    await show(makeAdapter(), drill)
    expect(dirOpen(`${NOTES}/sub`)).toBe(false)
    await click(must(dirSel(`${NOTES}/sub`)))
    expect(dirOpen(`${NOTES}/sub`)).toBe(true)
    expect(dirOpen(`${NOTES}/sub/deeper`)).toBe(false)
    expect(drill.onOpen).not.toHaveBeenCalled()
    await click(must(dirSel(`${NOTES}/sub`)))
    expect(dirOpen(`${NOTES}/sub`)).toBe(false)
  })

  it('KG-21 a tap on an entry → adapter.open(path, title), also when its notebook is the active session', async () => {
    const adapter = makeAdapter()
    await show(adapter, drillAt(baseScope(NOTES)))
    await click(must(rowSel(`${NOTES}/n.md`)))
    expect(adapter.open.mock.calls).toEqual([[`${NOTES}/n.md`, 'Note N']])

    mocks.chat.sessions = [
      { id: 'k1', projectId: KNOWLEDGE_USER_PROJECT_ID, settings: { notebookPath: 'notes/n.md' } }
    ]
    mocks.chat.activeSessionId = 'k1'
    await show(adapter, drillAt(baseScope(NOTES)))
    await click(must(rowSel(`${NOTES}/n.md`)))
    expect(adapter.open).toHaveBeenCalledTimes(2)
    expect(adapter.open.mock.calls[1]).toEqual([`${NOTES}/n.md`, 'Note N'])
    // 手机上列表与对话是两屏：行不画选中底色
    expect(must(rowSel(`${NOTES}/n.md`)).className).not.toContain('bg-bg-active')
  })

  it('KG-22 the base toolbar: the entry count; "+" starts an entry draft above the rows; Enter creates, rescans and opens it', async () => {
    const adapter = makeAdapter()
    await show(adapter, drillAt(baseScope(NOTES)))
    expect(countText()).toBe(i18n.t('mobile.libraryEntriesCount', { count: 3 }))
    const add = must('[data-library-new]')
    expect(add.getAttribute('aria-label')).toBe(i18n.t('knowledge.newEntry'))

    await click(add)
    const row = draft('entry')!
    expect(row).not.toBeNull()
    expect(before(row, must(rowSel(`${NOTES}/n.md`)))).toBe(true)
    expect(must(`[data-library-knowledge-base="${NOTES}"]`).contains(row)).toBe(true)

    await typeInto(inputOf('entry'), 'Fresh')
    await press(inputOf('entry'), 'Enter')
    expect(adapter.createEntry!.mock.calls).toEqual([[NOTES, 'Fresh']])
    expect(adapter.list).toHaveBeenCalledTimes(2)
    expect(adapter.open.mock.calls).toEqual([[`${NOTES}/fresh.md`, 'Fresh']])
    expect(adapter.list.mock.invocationCallOrder[1]).toBeLessThan(
      adapter.open.mock.invocationCallOrder[0]
    )
    expect(draft('entry')).toBeNull()
  })

  it('KG-23 the base menu on a writable base: new entry, new folder, refresh', async () => {
    const menuSlot = slot()
    const adapter = makeAdapter()
    await show(adapter, drillAt(baseScope(NOTES), { menuSlot }))
    const button = must('[data-library-menu]', menuSlot)
    expect(ids(await menuByClick(button))).toEqual([
      'new-entry',
      'new-folder',
      undefined,
      'refresh'
    ])

    pick = 'new-folder'
    await menuByClick(button)
    expect(draft('folder')).not.toBeNull()
    await typeInto(inputOf('folder'), 'drafts')
    await press(inputOf('folder'), 'Enter')
    expect(adapter.createFolder!.mock.calls).toEqual([[NOTES, 'drafts']])
    expect(adapter.open).not.toHaveBeenCalled()

    const scans = adapter.list.mock.calls.length
    pick = 'refresh'
    await menuByClick(button)
    expect(adapter.list).toHaveBeenCalledTimes(scans + 1)

    pick = 'new-entry'
    await menuByClick(button)
    expect(draft('entry')).not.toBeNull()
  })

  it('KG-23 a host without createFolder: new entry, refresh', async () => {
    const menuSlot = slot()
    await show(makeAdapter(LISTING, ['createFolder']), drillAt(baseScope(NOTES), { menuSlot }))
    expect(ids(await menuByClick(must('[data-library-menu]', menuSlot)))).toEqual([
      'new-entry',
      undefined,
      'refresh'
    ])
  })

  it('KG-24 a read-only base page: its rows, no new button, a menu with refresh only', async () => {
    const menuSlot = slot()
    const adapter = makeAdapter()
    await show(adapter, drillAt(baseScope(BUILTIN), { menuSlot }))
    expect(rowPaths()).toEqual([`${BUILTIN}/guide.md`])
    expect(q('[data-library-new]')).toBeNull()
    expect(countText()).toBe(i18n.t('mobile.libraryEntriesCount', { count: 1 }))
    expect(ids(await menuByClick(must('[data-library-menu]', menuSlot)))).toEqual(['refresh'])
    expect(draft('entry')).toBeNull()

    await click(must(rowSel(`${BUILTIN}/guide.md`)))
    expect(adapter.open.mock.calls).toEqual([[`${BUILTIN}/guide.md`, 'Guide']])
  })

  it('KG-25 an empty writable base: the empty sentence without the card look; "+" replaces it with the draft', async () => {
    await show(makeAdapter(), drillAt(baseScope(EMPTY)))
    const base = must(`[data-library-knowledge-base="${EMPTY}"]`)
    expect(base.classList.contains('sb-card')).toBe(false)
    expect(emptyText()).toBe(i18n.t('sidebar.knowledgeEmpty'))
    expect(countText()).toBe(i18n.t('mobile.libraryEntriesCount', { count: 0 }))
    expect(q('[data-library-new]')).not.toBeNull()

    await click(must('[data-library-new]'))
    expect(emptyText()).toBeNull()
    expect(draft('entry')).not.toBeNull()
  })

  it('KG-26 a base that is not there: the gone sentence, no new button, refresh only, a count of zero', async () => {
    const menuSlot = slot()
    await show(makeAdapter(), drillAt(baseScope('knowledge/nope'), { menuSlot }))
    expect(must('[data-library-knowledge-base="knowledge/nope"]')).not.toBeNull()
    expect(emptyText()).toBe(i18n.t('mobile.scopeGone'))
    expect(q('[data-library-new]')).toBeNull()
    expect(countText()).toBe(i18n.t('mobile.libraryEntriesCount', { count: 0 }))
    expect(ids(await menuByClick(must('[data-library-menu]', menuSlot)))).toEqual(['refresh'])
    expect(rowPaths()).toEqual([])
  })

  it('KG-27 before the scan resolves a base page shows neither the base nor the gone sentence', async () => {
    const adapter = makeAdapter()
    let release: (listing: KnowledgeListing) => void = () => {}
    adapter.list.mockImplementation(
      () =>
        new Promise<KnowledgeListing>((resolve) => {
          release = resolve
        })
    )
    await show(adapter, drillAt(baseScope(NOTES)))
    expect(adapter.list).toHaveBeenCalledTimes(1)
    expect(must('[data-library-page]')).not.toBeNull()
    expect(q('[data-library-knowledge-base]')).toBeNull()
    expect(emptyText()).toBeNull()

    await act(async () => {
      release(LISTING)
    })
    await flush()
    expect(q(`[data-library-knowledge-base="${NOTES}"]`)).not.toBeNull()
    expect(emptyText()).toBeNull()
  })

  it('KG-28 a base that disappears on a rescan while its page is open → the gone sentence', async () => {
    const adapter = makeAdapter()
    await show(adapter, drillAt(baseScope(NOTES)))
    expect(q(rowSel(`${NOTES}/n.md`))).not.toBeNull()

    adapter.list.mockResolvedValue(withoutNotes)
    await emit('knowledge.changed')
    expect(adapter.list).toHaveBeenCalledTimes(2)
    expect(emptyText()).toBe(i18n.t('mobile.scopeGone'))
    expect(rowPaths()).toEqual([])
    expect(q('[data-library-new]')).toBeNull()
    expect(countText()).toBe(i18n.t('mobile.libraryEntriesCount', { count: 0 }))
  })

  it('KG-30 a long press on a sub-folder: new entry / new folder; the draft opens inside that folder and createEntry gets its path', async () => {
    const adapter = makeAdapter()
    await show(adapter, drillAt(baseScope(NOTES)))
    const sub = `${NOTES}/sub`
    expect(dirOpen(sub)).toBe(false)

    pick = 'new-entry'
    expect(ids(await contextMenu(must(dirSel(sub))))).toEqual(['new-entry', 'new-folder'])
    // 输入行长在落点文件夹里：先把它展开
    expect(dirOpen(sub)).toBe(true)
    const row = draft('entry')!
    expect(row).not.toBeNull()
    expect((must(dirSel(sub)).nextElementSibling as HTMLElement).contains(row)).toBe(true)
    // 库根上不再多画一行
    expect(qa('[data-knowledge-draft]')).toHaveLength(1)

    await typeInto(inputOf('entry'), 'Inner')
    await press(inputOf('entry'), 'Enter')
    expect(adapter.createEntry!.mock.calls).toEqual([[sub, 'Inner']])
    expect(adapter.open.mock.calls).toEqual([[`${sub}/inner.md`, 'Inner']])
  })
})
