// @vitest-environment jsdom
/**
 * 项目知识库挪进项目组（2026-10-10，jsdom）—— ProjectKnowledgeFolder 与 KnowledgeGroup 的分工。
 *
 * 契约：每个项目组里有一行「项目知识库」文件夹（`[data-project-knowledge=<projectId>]`，文案
 * `sidebar.projectKnowledge`、悬停 `sidebar.projectKnowledgeHint`），**总在**——库目录还没有、一条条目都
 * 没有也在（它是手动新建的落点）；条目数 > 0 时标签旁一个数字；默认折叠，点一下展开，空库展开后是
 * `sidebar.projectKnowledgeEmpty`。只列 `projects/<projectId>/…`：别的项目的、用户库的、内置库的都不进来。
 * 菜单 = 新建条目 / 新建文件夹，落点是库根 `projects/<projectId>`。扫描：所属项目组展开（`enabled`）才扫，
 * 同一刻的并发扫描合成一次 `adapter.list()`，`knowledge.changed` 只在 enabled 时重扫。
 * 「知识库」分组则不再画任何 `projects` / `projects/…` 的目录与条目。
 *
 *   PK-1 组折叠（enabled=false）：不扫，但文件夹行照样在（没有数字）
 *   PK-2 组展开：扫一次；数字只数本项目的条目；文案与悬停提示
 *   PK-3 空库（目录都没有）：没有数字，展开后是空态文案
 *   PK-4 展开 → 只有本项目的行；子目录默认折叠；点行 → adapter.open(条目 id, 标题)
 *   PK-5 菜单 = [new-entry, new-folder]；新建条目：展开 + 草稿行，回车 → createEntry('projects/p1', 标题)，
 *        重扫，再 open 新条目；adapter 不给 createFolder 时菜单里就没有那一项
 *   PK-6 两个文件夹同时展开：在途的 list() 合成一次
 *   PK-7 knowledge.changed：enabled 时重扫，组折叠时不扫
 *   KG-1 「知识库」分组：清单里有项目库的条目与目录，也一行都不画；用户库照常
 *
 * `@shuvix/chat-ui` 替掉 useAppEvent（记下回调，好手动派发）/ useChatStore / useChatHost；右键菜单走
 * ContextMenuProvider 的 `render` 注入。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { KnowledgeEntry } from '@shuvix/chat-protocol/knowledge'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'

const appEvents = vi.hoisted(() => new Map<string, Set<() => void>>())

vi.mock('@shuvix/chat-ui', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    // 记下每个订阅者，用例里按事件名派发；回调走 ref，拿到的总是最新一次渲染的闭包
    useAppEvent: (type: string, handler: () => void) => {
      const ref = useRef(handler)
      ref.current = handler
      useEffect(() => {
        const fn = (): void => ref.current()
        if (!appEvents.has(type)) appEvents.set(type, new Set())
        appEvents.get(type)!.add(fn)
        return () => {
          appEvents.get(type)?.delete(fn)
        }
      }, [type])
    },
    useChatStore: (selector: (s: { sessions: never[]; activeSessionId: null }) => unknown) =>
      selector({ sessions: [], activeSessionId: null }),
    useChatHost: () => ({ appearance: { focusMode: false } })
  }
})

import { ProjectKnowledgeFolder } from './ProjectKnowledgeFolder'
import { KnowledgeGroup } from './KnowledgeGroup'
import type { KnowledgeGroupAdapter, KnowledgeListing } from './KnowledgeTreeView'
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

/** 一份同时有两个项目库、一个用户库与内置库的清单 —— 每个视图只该挑出属于自己的那一份 */
const LISTING: KnowledgeListing = {
  entries: [
    entry('projects/p1/a.md', 'Alpha'),
    entry('projects/p1/b.md', 'Beta'),
    entry('projects/p1/sub/c.md', 'Gamma'),
    entry('projects/p2/x.md', 'Other project'),
    entry('knowledge/notes/n.md', 'User note'),
    entry('builtin/shuvix/guide.md', 'Guide')
  ],
  root: '/kb-shuvix',
  userRoot: '/kb-user',
  dirs: [
    'projects',
    'projects/p1',
    'projects/p1/sub',
    'projects/p2',
    'knowledge/notes',
    'builtin/shuvix'
  ],
  bundleNames: { 'projects/p1': 'Proj One', 'projects/p2': 'Proj Two', 'builtin/shuvix': 'ShuviX' }
}

type Adapter = KnowledgeGroupAdapter & {
  list: ReturnType<typeof vi.fn<() => Promise<KnowledgeListing>>>
  open: ReturnType<typeof vi.fn<(path: string, title: string) => void>>
  createEntry: ReturnType<
    typeof vi.fn<(dir: string, title: string) => Promise<{ success: boolean; id?: string }>>
  >
  createFolder?: ReturnType<
    typeof vi.fn<(dir: string, name: string) => Promise<{ success: boolean; id?: string }>>
  >
}

function makeAdapter(listing: KnowledgeListing = LISTING, withFolder = true): Adapter {
  const a: Adapter = {
    list: vi.fn(async () => listing),
    open: vi.fn<(path: string, title: string) => void>(),
    openFolder: vi.fn(),
    createEntry: vi.fn(async (dir: string, title: string) => ({
      success: true,
      id: `${dir}/${title.toLowerCase()}.md`
    })),
    ...(withFolder
      ? {
          createFolder: vi.fn(async (dir: string, name: string) => ({
            success: true,
            id: `${dir}/${name}`
          }))
        }
      : {})
  }
  return a
}

let container: HTMLDivElement
let root: Root
let menus: ContextMenuItem[][]
let pick: string | null

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(child: ReactElement): Promise<void> {
  await act(async () => {
    type ProviderProps = ComponentProps<typeof ContextMenuProvider>
    const props: Omit<ProviderProps, 'children'> = {
      render: async (items: ContextMenuItem[]) => {
        menus.push(items)
        return pick
      }
    }
    root.render(createElement(ContextMenuProvider, props as ProviderProps, child))
  })
  await flush()
}

const folderEl = (projectId = 'p1'): HTMLElement => {
  const el = container.querySelector(`[data-project-knowledge="${projectId}"]`) as HTMLElement
  if (!el) throw new Error(`folder ${projectId} not rendered`)
  return el
}
/** 标签旁的数字；没画为 null */
const countOf = (projectId = 'p1'): string | null =>
  folderEl(projectId).querySelector('span.tabular-nums')?.textContent ?? null
/** 文件夹正文（AnimatedCollapse 根）是否展开 */
const isOpen = (projectId = 'p1'): boolean =>
  (folderEl(projectId).nextElementSibling as HTMLElement | null)?.style.gridTemplateRows === '1fr'
const rowPaths = (scope: ParentNode = container): string[] =>
  [...scope.querySelectorAll('[data-knowledge-row]')].map(
    (el) => el.getAttribute('data-knowledge-row') ?? ''
  )
const dirPaths = (scope: ParentNode = container): string[] =>
  [...scope.querySelectorAll('[data-knowledge-dir]')].map(
    (el) => el.getAttribute('data-knowledge-dir') ?? ''
  )

async function click(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

async function contextMenu(el: Element): Promise<ContextMenuItem[]> {
  const before = menus.length
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await flush()
  expect(menus.length).toBe(before + 1)
  return menus[menus.length - 1]
}
const ids = (items: ContextMenuItem[]): Array<string | undefined> =>
  items.map((item) => ('id' in item ? item.id : undefined))

async function emit(type: string): Promise<void> {
  await act(async () => {
    for (const fn of appEvents.get(type) ?? []) fn()
  })
  // 重扫要穿过 listShared 的 finally 那一串微任务才落到 setState：多排几轮
  await flush()
  await flush()
}

const folder = (adapter: Adapter, enabled = true, projectId = 'p1'): ReactElement =>
  createElement(ProjectKnowledgeFolder, { projectId, adapter, enabled })

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
  appEvents.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ProjectKnowledgeFolder', () => {
  it('PK-1 所属项目组折叠（enabled=false）：一次都不扫，但文件夹行照样在、没有数字、默认折叠', async () => {
    const adapter = makeAdapter()
    await render(folder(adapter, false))

    expect(adapter.list).not.toHaveBeenCalled()
    expect(folderEl().textContent).toContain(en.sidebar.projectKnowledge)
    expect(countOf()).toBeNull()
    expect(isOpen()).toBe(false)
  })

  it('PK-2 组展开：扫一次；数字只数本项目的条目（别的项目 / 用户库 / 内置库都不算）；文案与悬停提示', async () => {
    const adapter = makeAdapter()
    await render(folder(adapter))

    expect(adapter.list).toHaveBeenCalledTimes(1)
    expect(countOf()).toBe('3')
    expect(folderEl().textContent).toContain(en.sidebar.projectKnowledge)
    expect(folderEl().getAttribute('title')).toBe(en.sidebar.projectKnowledgeHint)
    // 默认折叠
    expect(isOpen()).toBe(false)
  })

  it('PK-3 空库（目录都还没有）：行照样在、没有数字；展开后是空态文案，没有任何行', async () => {
    const adapter = makeAdapter({ ...LISTING, entries: [], dirs: [] })
    await render(folder(adapter))

    expect(countOf()).toBeNull()
    await click(folderEl())
    expect(isOpen()).toBe(true)
    const body = folderEl().nextElementSibling as HTMLElement
    expect(body.textContent).toContain(en.sidebar.projectKnowledgeEmpty)
    expect(rowPaths(body)).toEqual([])
    expect(dirPaths(body)).toEqual([])
  })

  it('PK-4 展开即重扫；只有本项目的行；子目录默认折叠；点行 → adapter.open(条目 id, 标题)', async () => {
    const adapter = makeAdapter()
    await render(folder(adapter))
    expect(adapter.list).toHaveBeenCalledTimes(1)

    await click(folderEl())
    expect(adapter.list).toHaveBeenCalledTimes(2)
    const body = folderEl().nextElementSibling as HTMLElement
    // 折叠只收高度，行都在 DOM 里：子目录里的那条也在
    expect(rowPaths(body).sort()).toEqual(
      ['projects/p1/a.md', 'projects/p1/b.md', 'projects/p1/sub/c.md'].sort()
    )
    // 库本身就是这个文件夹：没有 `projects` 容器行、也没有库那一行，只有库里的子目录
    expect(dirPaths(body)).toEqual(['projects/p1/sub'])
    const sub = body.querySelector('[data-knowledge-dir="projects/p1/sub"]') as HTMLElement
    expect((sub.nextElementSibling as HTMLElement).style.gridTemplateRows).not.toBe('1fr')

    await click(body.querySelector('[data-knowledge-row="projects/p1/a.md"]')!)
    expect(adapter.open).toHaveBeenCalledWith('projects/p1/a.md', 'Alpha')
  })

  it('PK-5 菜单 = [new-entry, new-folder]，落点是库根；新建条目：展开、草稿行、回车 → createEntry → 重扫 → 打开新条目', async () => {
    const adapter = makeAdapter({ ...LISTING, entries: [], dirs: [] })
    await render(folder(adapter))
    expect(isOpen()).toBe(false)

    pick = 'new-entry'
    const items = await contextMenu(folderEl())
    expect(ids(items)).toEqual(['new-entry', 'new-folder'])
    // 输入框长在收着的地方没人看得见：先展开
    expect(isOpen()).toBe(true)
    const draft = container.querySelector('[data-knowledge-draft="entry"]')
    expect(draft).not.toBeNull()
    // 草稿开着时不显示空态文案
    expect(folderEl().nextElementSibling!.textContent).not.toContain(
      en.sidebar.projectKnowledgeEmpty
    )

    const input = draft!.querySelector('input') as HTMLInputElement
    const listCalls = adapter.list.mock.calls.length
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Note')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await flush()

    expect(adapter.createEntry).toHaveBeenCalledWith('projects/p1', 'Note')
    expect(adapter.list.mock.calls.length).toBeGreaterThan(listCalls)
    expect(adapter.open).toHaveBeenCalledWith('projects/p1/note.md', 'Note')
    expect(container.querySelector('[data-knowledge-draft]')).toBeNull()

    // 新建文件夹同一个落点
    pick = 'new-folder'
    await contextMenu(folderEl())
    const folderDraft = container.querySelector('[data-knowledge-draft="folder"]')
    expect(folderDraft).not.toBeNull()
    const folderInput = folderDraft!.querySelector('input') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(folderInput, 'api')
      folderInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      folderInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await flush()
    expect(adapter.createFolder).toHaveBeenCalledWith('projects/p1', 'api')
  })

  it('PK-5b 宿主没给 createFolder：菜单里只有 new-entry', async () => {
    const adapter = makeAdapter(LISTING, false)
    await render(folder(adapter))
    expect(ids(await contextMenu(folderEl()))).toEqual(['new-entry'])
  })

  it('PK-6 两个项目的文件夹同时展开：在途的 list() 合成一次；各自只数自己的条目', async () => {
    let resolve!: (l: KnowledgeListing) => void
    const pending = new Promise<KnowledgeListing>((r) => (resolve = r))
    const adapter = makeAdapter()
    adapter.list.mockImplementation(() => pending)

    await render(
      createElement('div', null, folder(adapter, true, 'p1'), folder(adapter, true, 'p2'))
    )
    expect(adapter.list).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolve(LISTING)
    })
    await flush()
    expect(countOf('p1')).toBe('3')
    expect(countOf('p2')).toBe('1')
  })

  it('PK-7 knowledge.changed：组展开时重扫（新条目跟着出来），组折叠时不扫', async () => {
    const adapter = makeAdapter({ ...LISTING, entries: [] })
    await render(folder(adapter))
    expect(countOf()).toBeNull()

    adapter.list.mockResolvedValue(LISTING)
    await emit('knowledge.changed')
    expect(adapter.list).toHaveBeenCalledTimes(2)
    expect(countOf()).toBe('3')

    // 组折叠：事件来了也不扫
    const idle = makeAdapter()
    await render(folder(idle, false))
    await emit('knowledge.changed')
    expect(idle.list).not.toHaveBeenCalled()
  })
})

describe('KnowledgeGroup —— 项目库不在这一组里', () => {
  it('KG-1 清单里有项目库的条目与目录：分组里一行都不画（连 `projects` 容器也没有）；用户库与内置库照常', async () => {
    const adapter = makeAdapter()
    await render(createElement(KnowledgeGroup, { adapter }))
    await click(container.querySelector('[data-group="knowledge"] button')!)
    expect(adapter.list).toHaveBeenCalled()

    const dirs = dirPaths()
    expect(dirs.filter((d) => d === 'projects' || d.startsWith('projects/'))).toEqual([])
    expect(dirs).toEqual(expect.arrayContaining(['knowledge/notes', 'builtin/shuvix']))
    // 内置库置顶
    expect(dirs[0]).toBe('builtin/shuvix')
    const rows = rowPaths()
    expect(rows.filter((p) => p.startsWith('projects/'))).toEqual([])
    expect(rows).toEqual(
      expect.arrayContaining(['knowledge/notes/n.md', 'builtin/shuvix/guide.md'])
    )
  })
})
