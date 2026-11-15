// @vitest-environment jsdom
/**
 * 注册表三组（AgentGroup / PolicyGroup / HookGroup）的两层导航（`drill`，手机布局的资料库；jsdom）。
 *
 * 契约：给了 `drill` —— 一挂上就扫（顶层那一行要写数量）；`scope === null` 只画一行导航行
 * `[data-group][data-group-nav=<key>]`（数量 = 在生效的那几份，同名里被压过的与解析不过的不算；点它 =
 * `drill.onOpen(key, 名字)`，长按 = 这一组的菜单）；`scope` 是自己 → 只画这一组的那一页（LibraryPage：
 * 「我的」在上、「内置」在下，行上仍带各组原来的锚点，点一行 / 长按一行还是原来那几个 adapter 函数，底部工具栏
 * 是数量与新建，顶栏的「⋯」是这一组的菜单）；`scope` 是别的页 → 什么都不画，但照样扫过。不给 `drill` → 桌面的树，
 * 一样都不变（展开才扫）。
 *
 * 一份用例表按三组各跑一遍，编号是 AG-n / PG-n / HG-n（n 同设计清单的 RG-n）：
 *   1 顶层只有导航行、挂上就扫一次      2 数量（生效的；零 / 扫描没回来都不画）   3 点导航行 → onOpen
 *   4 导航行的长按菜单                  5 别的页开着：什么都不画，轮到自己不再扫   6 自己的页：两节与行的顺序
 *   7 行的内容与旧锚点                  8 被压过的行                            9 解析不过的文件
 *   10 空的节不画                       11 点一行交给谁                         12 点的就是活跃的那份笔记也照开
 *   13 长按一行                         14 工具栏那句话                         15 新建
 *   16 「⋯」画进 menuSlot               17 工具栏画进 toolbarSlot                18 事件 / 聚焦重扫
 *   19 list 抛了                        20 drill 换了对象不重扫
 *   21 / 22（策略、hook）停用的行与开关  23 不给 drill：桌面的树照旧               24 同一拍里卸掉：不扫
 *   25（策略、hook）停用但没被压过的照样计数（A3，现状）
 *
 * 右键菜单走 ContextMenuProvider 的 `render` 注入：记录菜单项、按预设回一个 id。`@shuvix/chat-ui` 换成能改的
 * 小 store（12 用）与记下订阅者的 useAppEvent（18 用）。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { REGISTRY_NOTE_PROJECT_IDS } from '@shuvix/chat-protocol/registryNotes'
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

import { AgentGroup } from './AgentGroup'
import { PolicyGroup } from './PolicyGroup'
import { HookGroup } from './HookGroup'
import type { LibraryDrill } from './LibraryPage'
import { ContextMenuProvider } from '../contextmenu/ContextMenuProvider'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** 三组的条目共有的那几个字段（停用那两项只有策略 / hook 认） */
interface Item {
  name: string
  displayName: string
  description?: string
  source: 'builtin' | 'user'
  fileName: string
  overridden?: boolean
  overriddenBy?: string
  objectId?: string
  disableable?: boolean
  disabled?: boolean
}
interface InvalidFile {
  fileName: string
  error: string
}
interface Listing {
  items: Item[]
  invalid: InvalidFile[]
}

interface GroupCase {
  id: 'AG' | 'PG' | 'HG'
  Component: ComponentType<{ adapter: never; drill?: LibraryDrill }>
  /** nav key，也是 data-group 的值与 list() 结果里清单的键 */
  key: 'agents' | 'policies' | 'hooks'
  labelKey: string
  /** 行锚点的词干：data-<attr>-row / -builtin-row / -invalid-row / -overridden / -disabled */
  attr: 'agent' | 'policy' | 'hook'
  newId: string
  newLabelKey: string
  deleteId: string
  deleteFileId: string
  overriddenKey: string
  event: string
  carrier: { user: string; builtin: string }
  /** 这一组有没有停用开关 */
  disableable: boolean
}

const CASES: GroupCase[] = [
  {
    id: 'AG',
    Component: AgentGroup as GroupCase['Component'],
    key: 'agents',
    labelKey: 'sidebar.agentsGroup',
    attr: 'agent',
    newId: 'new-agent',
    newLabelKey: 'sidebar.newAgent',
    deleteId: 'delete-agent',
    deleteFileId: 'delete-agent-file',
    overriddenKey: 'tool.subAgentOverridden',
    event: 'agent.changed',
    carrier: {
      user: REGISTRY_NOTE_PROJECT_IDS.agent,
      builtin: REGISTRY_NOTE_PROJECT_IDS.agentBuiltin
    },
    disableable: false
  },
  {
    id: 'PG',
    Component: PolicyGroup as GroupCase['Component'],
    key: 'policies',
    labelKey: 'sidebar.policiesGroup',
    attr: 'policy',
    newId: 'new-policy',
    newLabelKey: 'sidebar.newPolicy',
    deleteId: 'delete-policy',
    deleteFileId: 'delete-policy-file',
    overriddenKey: 'settings.policyOverridden',
    event: 'policy.changed',
    carrier: {
      user: REGISTRY_NOTE_PROJECT_IDS.policy,
      builtin: REGISTRY_NOTE_PROJECT_IDS.policyBuiltin
    },
    disableable: true
  },
  {
    id: 'HG',
    Component: HookGroup as GroupCase['Component'],
    key: 'hooks',
    labelKey: 'sidebar.hooksGroup',
    attr: 'hook',
    newId: 'new-hook',
    newLabelKey: 'sidebar.newHook',
    deleteId: 'delete-hook',
    deleteFileId: 'delete-hook-file',
    overriddenKey: 'settings.hookOverridden',
    event: 'hook.changed',
    carrier: {
      user: REGISTRY_NOTE_PROJECT_IDS.hook,
      builtin: REGISTRY_NOTE_PROJECT_IDS.hookBuiltin
    },
    disableable: true
  }
]

// 夹具：两份生效的内置、一份生效的用户文件（压过了内置 b3）、一份被它遮蔽的同名用户文件、被压过的内置 b3、
// 一份解析不过的文件
const B1: Item = {
  name: 'b1',
  displayName: 'Builtin One',
  description: 'the first builtin',
  source: 'builtin',
  fileName: 'b1.md',
  disableable: true
}
const B2: Item = { name: 'b2', displayName: 'Builtin Two', source: 'builtin', fileName: 'b2.md' }
const B3: Item = {
  name: 'b3',
  displayName: 'Builtin Three',
  description: 'the overridden builtin',
  source: 'builtin',
  fileName: 'b3.md',
  overridden: true,
  overriddenBy: 'u1.md'
}
const U1: Item = {
  name: 'b3',
  displayName: 'User One',
  description: 'the live user file',
  source: 'user',
  fileName: 'u1.md'
}
const U2: Item = {
  name: 'b3',
  displayName: 'User Two',
  source: 'user',
  fileName: 'u2.md',
  overridden: true,
  overriddenBy: 'u1.md'
}
const BAD: InvalidFile = { fileName: 'bad.md', error: 'boom' }
/** 交给 adapter 的顺序故意把内置与用户交错开 */
const FIXTURE: Listing = { items: [B1, U1, B2, U2, B3], invalid: [BAD] }

interface FakeAdapter {
  list: ReturnType<typeof vi.fn<() => Promise<Record<string, unknown>>>>
  open: ReturnType<typeof vi.fn>
  openBuiltin: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  createOverride: ReturnType<typeof vi.fn>
  openFolder: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  deleteFile: ReturnType<typeof vi.fn>
  setEnabled?: ReturnType<typeof vi.fn>
}

let container: HTMLDivElement
let root: Root
let mounted: boolean
let menus: ContextMenuItem[][]
/** 「用户」在弹出的菜单里点的那一项（null = 取消） */
let pick: string | null
const slots: HTMLElement[] = []

function slot(): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-test-slot', '')
  document.body.appendChild(el)
  slots.push(el)
  return el
}

/** list() 依次交回 `listings`（最后一份之后一直是它） */
function makeAdapter(c: GroupCase, ...listings: Listing[]): FakeAdapter {
  let call = 0
  const adapter: FakeAdapter = {
    list: vi.fn(async () => {
      const listing = listings[Math.min(call, listings.length - 1)] ?? { items: [], invalid: [] }
      call += 1
      return { [c.key]: listing.items, invalid: listing.invalid }
    }),
    open: vi.fn(),
    openBuiltin: vi.fn(),
    create: vi.fn(),
    createOverride: vi.fn(),
    openFolder: vi.fn(),
    delete: vi.fn(),
    deleteFile: vi.fn()
  }
  if (c.disableable) adapter.setEnabled = vi.fn()
  return adapter
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

function element(c: GroupCase, adapter: FakeAdapter, drill?: LibraryDrill): React.ReactElement {
  type ProviderProps = ComponentProps<typeof ContextMenuProvider>
  const props: Omit<ProviderProps, 'children'> = {
    render: async (items: ContextMenuItem[]) => {
      menus.push(items)
      return pick
    }
  }
  return createElement(
    ContextMenuProvider,
    props as ProviderProps,
    createElement(c.Component, { adapter: adapter as never, drill })
  )
}

/** 渲染（同一条用例里再调一次 = 同一个实例换 props），并等扫描回来 */
async function show(c: GroupCase, adapter: FakeAdapter, drill?: LibraryDrill): Promise<void> {
  mounted = true
  act(() => root.render(element(c, adapter, drill)))
  await flush()
}

const drillAt = (scope: string | null, extra: Partial<LibraryDrill> = {}): LibraryDrill => ({
  scope,
  onOpen: vi.fn(),
  ...extra
})

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
const navRow = (c: GroupCase): HTMLElement | null => q(`[data-group-nav="${c.key}"]`)
const navCount = (): string | null => q('[data-group-count]')?.textContent ?? null
const builtinSel = (c: GroupCase, name: string): string => `[data-${c.attr}-builtin-row="${name}"]`
const userSel = (c: GroupCase, fileName: string): string => `[data-${c.attr}-row="${fileName}"]`
const invalidSel = (c: GroupCase, fileName: string): string =>
  `[data-${c.attr}-invalid-row="${fileName}"]`
/** 一行的身份：内置按名、用户与解析不过的按文件名 */
const rowIdOf = (c: GroupCase, el: Element): string =>
  el.getAttribute(`data-${c.attr}-builtin-row`) ??
  el.getAttribute(`data-${c.attr}-row`) ??
  el.getAttribute(`data-${c.attr}-invalid-row`) ??
  '?'
const sectionRows = (c: GroupCase, key: string): string[] =>
  qa(`[data-library-section="${key}"] [data-library-row]`).map((el) => rowIdOf(c, el))
const sectionKeys = (): string[] =>
  qa('[data-library-section]').map((el) => el.getAttribute('data-library-section') ?? '')
const titleOf = (el: HTMLElement): HTMLElement => must('[data-library-row-title]', el)
const badgeOf = (el: HTMLElement): string | null =>
  q('[data-library-row-badge]', el)?.textContent ?? null
const countText = (from: ParentNode = container): string | null =>
  q('[data-library-count]', from)?.textContent ?? null

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
/** 右键（长按）这个元素，回到弹出的菜单项（并按 pick 分发） */
async function menuOn(el: Element): Promise<ContextMenuItem[]> {
  const before = menus.length
  await act(async () => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await flush()
  expect(menus.length).toBe(before + 1)
  return menus[menus.length - 1]
}
/** 点一颗会弹菜单的按钮 */
async function menuByClick(el: Element): Promise<ContextMenuItem[]> {
  const before = menus.length
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await flush()
  expect(menus.length).toBe(before + 1)
  return menus[menus.length - 1]
}
const ids = (items: ContextMenuItem[]): Array<string | undefined> =>
  items.map((item) => ('id' in item ? item.id : undefined))
const itemById = (
  items: ContextMenuItem[],
  id: string
): ContextMenuItem & { label?: string; enabled?: boolean } =>
  items.find((item) => 'id' in item && item.id === id) as ContextMenuItem & {
    label?: string
    enabled?: boolean
  }
function emit(type: string): void {
  act(() => {
    for (const fn of [...(mocks.appEvents.get(type) ?? [])]) fn()
  })
}
const labelOf = (c: GroupCase): string => i18n.t(c.labelKey)
const groupMenuIds = (c: GroupCase): Array<string | undefined> => [
  c.newId,
  'open-folder',
  undefined,
  'refresh'
]

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

describe.each(CASES)('$id registry group in drill mode', (c) => {
  const id = (n: number): string => `${c.id}-${n}`

  describe('the top level', () => {
    it(`${id(1)} one nav row with the label, no rows, no page; scanned once at mount without a click`, async () => {
      const adapter = makeAdapter(c, FIXTURE)
      await show(c, adapter, drillAt(null))
      const rows = qa('[data-group-nav]')
      expect(rows).toHaveLength(1)
      expect(rows[0].getAttribute('data-group-nav')).toBe(c.key)
      expect(rows[0].getAttribute('data-group')).toBe(c.key)
      expect(rows[0].textContent).toContain(labelOf(c))
      expect(q('[data-library-page]')).toBeNull()
      expect(qa('[data-library-row]')).toEqual([])
      expect(q(builtinSel(c, 'b1'))).toBeNull()
      expect(q(userSel(c, 'u1.md'))).toBeNull()
      expect(adapter.list).toHaveBeenCalledTimes(1)
    })

    it(`${id(2)} the count is the items in effect: overridden copies and invalid files are not counted`, async () => {
      await show(c, makeAdapter(c, FIXTURE), drillAt(null))
      expect(navCount()).toBe('3')
    })

    it(`${id(2)} no count with zero items, and none before the scan resolves`, async () => {
      await show(c, makeAdapter(c, { items: [], invalid: [BAD] }), drillAt(null))
      expect(navRow(c)).not.toBeNull()
      expect(navCount()).toBeNull()

      act(() => root.unmount())
      root = createRoot(container)
      const held = makeAdapter(c, FIXTURE)
      let release: (value: Record<string, unknown>) => void = () => {}
      held.list.mockImplementation(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            release = resolve
          })
      )
      await show(c, held, drillAt(null))
      expect(held.list).toHaveBeenCalledTimes(1)
      expect(navRow(c)).not.toBeNull()
      expect(navCount()).toBeNull()

      await act(async () => {
        release({ [c.key]: FIXTURE.items, invalid: FIXTURE.invalid })
      })
      await flush()
      expect(navCount()).toBe('3')
    })

    it(`${id(3)} a click on the nav row → drill.onOpen(key, label) once; nothing expands, no rescan`, async () => {
      const adapter = makeAdapter(c, FIXTURE)
      const drill = drillAt(null)
      await show(c, adapter, drill)
      click(must('button', navRow(c)!))
      await flush()
      expect(drill.onOpen).toHaveBeenCalledTimes(1)
      expect(drill.onOpen).toHaveBeenCalledWith(c.key, labelOf(c))
      expect(qa('[data-library-row]')).toEqual([])
      expect(q(builtinSel(c, 'b1'))).toBeNull()
      expect(adapter.list).toHaveBeenCalledTimes(1)
    })

    it(`${id(4)} a long press on the nav row opens the group menu: new, open folder, refresh`, async () => {
      const adapter = makeAdapter(c, FIXTURE)
      await show(c, adapter, drillAt(null))
      expect(ids(await menuOn(navRow(c)!))).toEqual(groupMenuIds(c))
      expect(adapter.create).not.toHaveBeenCalled()

      pick = c.newId
      await menuOn(navRow(c)!)
      expect(adapter.create).toHaveBeenCalledTimes(1)

      pick = 'open-folder'
      await menuOn(navRow(c)!)
      expect(adapter.openFolder).toHaveBeenCalledTimes(1)

      expect(adapter.list).toHaveBeenCalledTimes(1)
      pick = 'refresh'
      await menuOn(navRow(c)!)
      expect(adapter.list).toHaveBeenCalledTimes(2)
    })

    it(`${id(18)} the change event and a window focus rescan; the count follows`, async () => {
      const adapter = makeAdapter(c, FIXTURE, { items: [B1], invalid: [] })
      await show(c, adapter, drillAt(null))
      expect(navCount()).toBe('3')

      emit(c.event)
      await flush()
      expect(adapter.list).toHaveBeenCalledTimes(2)
      expect(navCount()).toBe('1')

      act(() => {
        window.dispatchEvent(new Event('focus'))
      })
      await flush()
      expect(adapter.list).toHaveBeenCalledTimes(3)
    })

    it(`${id(19)} list rejecting: no count, a page without sections, nothing thrown`, async () => {
      const adapter = makeAdapter(c, FIXTURE)
      adapter.list.mockRejectedValue(new Error('offline'))
      await show(c, adapter, drillAt(null))
      expect(navRow(c)).not.toBeNull()
      expect(navCount()).toBeNull()

      await show(c, adapter, drillAt(c.key))
      expect(q(`[data-library-page="${c.key}"]`)).not.toBeNull()
      expect(sectionKeys()).toEqual([])
      expect(qa('[data-library-row]')).toEqual([])
    })

    it(`${id(20)} a new drill object with the same scope on re-render does not rescan`, async () => {
      const adapter = makeAdapter(c, FIXTURE)
      await show(c, adapter, drillAt(null))
      await show(c, adapter, drillAt(null))
      await show(c, adapter, drillAt(null, { toolbarSlot: slot(), menuSlot: null }))
      expect(adapter.list).toHaveBeenCalledTimes(1)
      expect(navCount()).toBe('3')
    })

    it(`${id(24)} unmounted in the same tick as mounted: list is never called`, async () => {
      const adapter = makeAdapter(c, FIXTURE)
      act(() => root.render(element(c, adapter, drillAt(null))))
      act(() => root.unmount())
      await flush()
      expect(adapter.list).not.toHaveBeenCalled()
    })
  })

  describe('another page open', () => {
    const others = ['skills', 'knowledge:knowledge/x', ...CASES.map((x) => x.key)].filter(
      (scope) => scope !== c.key
    )

    it.each(others)(`${id(5)} scope %s: nothing is drawn, yet it scanned once`, async (scope) => {
      const adapter = makeAdapter(c, FIXTURE)
      await show(c, adapter, drillAt(scope))
      expect(container.children).toHaveLength(0)
      expect(container.textContent).toBe('')
      expect(adapter.list).toHaveBeenCalledTimes(1)
    })

    it(`${id(5)} switching to its own scope shows the rows without a second scan`, async () => {
      const adapter = makeAdapter(c, FIXTURE)
      await show(c, adapter, drillAt(others[0]))
      await show(c, adapter, drillAt(c.key))
      expect(q(`[data-library-page="${c.key}"]`)).not.toBeNull()
      expect(qa('[data-library-row]')).toHaveLength(6)
      expect(adapter.list).toHaveBeenCalledTimes(1)
    })
  })

  describe('its own page', () => {
    it(`${id(6)} the page: Mine above Built-in; user files then invalid files, builtins, each in the host’s order`, async () => {
      await show(c, makeAdapter(c, FIXTURE), drillAt(c.key))
      expect(q(`[data-library-page="${c.key}"]`)).not.toBeNull()
      expect(navRow(c)).toBeNull()
      expect(sectionKeys()).toEqual(['mine', 'builtin'])
      expect(qa('[data-library-section-label]').map((el) => el.textContent)).toEqual([
        i18n.t('mobile.libraryMine'),
        i18n.t('mobile.libraryBuiltin')
      ])
      expect(sectionRows(c, 'mine')).toEqual(['u1.md', 'u2.md', 'bad.md'])
      expect(sectionRows(c, 'builtin')).toEqual(['b1', 'b2', 'b3'])
    })

    it(`${id(7)} a row: the display name, the description when there is one, a lock on builtins only, the old anchors`, async () => {
      await show(c, makeAdapter(c, FIXTURE), drillAt(c.key))
      const b1 = must(builtinSel(c, 'b1'))
      expect(b1.hasAttribute('data-library-row')).toBe(true)
      expect(titleOf(b1).textContent).toBe('Builtin One')
      expect(q('[data-library-row-description]', b1)?.textContent).toBe('the first builtin')
      expect(q('[data-library-row-lock]', b1)).not.toBeNull()
      expect(badgeOf(b1)).toBeNull()

      const b2 = must(builtinSel(c, 'b2'))
      expect(titleOf(b2).textContent).toBe('Builtin Two')
      expect(q('[data-library-row-description]', b2)).toBeNull()
      expect(q('[data-library-row-lock]', b2)).not.toBeNull()

      const u1 = must(userSel(c, 'u1.md'))
      expect(u1.hasAttribute('data-library-row')).toBe(true)
      expect(titleOf(u1).textContent).toBe('User One')
      expect(q('[data-library-row-description]', u1)?.textContent).toBe('the live user file')
      expect(q('[data-library-row-lock]', u1)).toBeNull()
      expect(u1.hasAttribute(`data-${c.attr}-overridden`)).toBe(false)
      expect(titleOf(u1).className).not.toContain('line-through')
      expect(u1.hasAttribute('title')).toBe(false)
    })

    it(`${id(8)} overridden rows: struck, the overridden badge, the anchor; only the shadowed user file names the winner`, async () => {
      await show(c, makeAdapter(c, FIXTURE), drillAt(c.key))
      const overridden = i18n.t(c.overriddenKey)

      const u2 = must(userSel(c, 'u2.md'))
      expect(titleOf(u2).className).toContain('line-through')
      expect(badgeOf(u2)).toBe(overridden)
      expect(u2.getAttribute('title')).toBe(
        i18n.t('settings.shadowedByFileHint', { file: 'u1.md' })
      )
      expect(u2.hasAttribute(`data-${c.attr}-overridden`)).toBe(true)
      expect(q('[data-library-row-lock]', u2)).toBeNull()

      const b3 = must(builtinSel(c, 'b3'))
      expect(titleOf(b3).className).toContain('line-through')
      expect(badgeOf(b3)).toBe(overridden)
      expect(q('[data-library-row-lock]', b3)).not.toBeNull()
      expect(b3.hasAttribute(`data-${c.attr}-overridden`)).toBe(true)
      // 这一页上被压过的内置行没有悬停提示（A6，桌面的树有）
      expect(b3.hasAttribute('title')).toBe(false)
    })

    it(`${id(9)} an invalid file: its file name in monospace, a warning, the parser’s reason as the hint, no lock`, async () => {
      await show(c, makeAdapter(c, FIXTURE), drillAt(c.key))
      const bad = must(invalidSel(c, 'bad.md'))
      expect(bad.hasAttribute('data-library-row')).toBe(true)
      expect(titleOf(bad).textContent).toBe('bad.md')
      expect(titleOf(bad).className).toContain('font-mono')
      expect(bad.querySelector('.text-amber-500')).not.toBeNull()
      expect(bad.getAttribute('title')).toBe('boom')
      expect(q('[data-library-row-lock]', bad)).toBeNull()
      expect(q('[data-library-row-description]', bad)).toBeNull()
      expect(badgeOf(bad)).toBeNull()
    })

    it(`${id(10)} empty sections are not drawn; with nothing at all the toolbar still is`, async () => {
      await show(c, makeAdapter(c, { items: [B1, B2], invalid: [] }), drillAt(c.key))
      expect(sectionKeys()).toEqual(['builtin'])

      act(() => root.unmount())
      root = createRoot(container)
      await show(c, makeAdapter(c, { items: [], invalid: [] }), drillAt(c.key))
      expect(sectionKeys()).toEqual([])
      expect(q('[data-library-toolbar]')).not.toBeNull()
      expect(countText()).toBe(i18n.t('mobile.libraryCount', { count: 0, name: labelOf(c) }))
    })

    it(`${id(11)} a tap: a builtin → openBuiltin(item), a user file → open(fileName, displayName), an invalid file → open(fileName)`, async () => {
      const adapter = makeAdapter(c, FIXTURE)
      await show(c, adapter, drillAt(c.key))

      click(must(builtinSel(c, 'b1')))
      expect(adapter.openBuiltin).toHaveBeenCalledTimes(1)
      expect(adapter.openBuiltin.mock.calls[0][0]).toBe(B1)
      expect(adapter.open).not.toHaveBeenCalled()

      click(must(userSel(c, 'u1.md')))
      expect(adapter.open.mock.calls).toEqual([['u1.md', 'User One']])

      click(must(invalidSel(c, 'bad.md')))
      expect(adapter.open.mock.calls).toEqual([['u1.md', 'User One'], ['bad.md']])
      expect(adapter.openBuiltin).toHaveBeenCalledTimes(1)
    })

    it(`${id(12)} a tap opens the note even when it is the active session (the desktop tree does not)`, async () => {
      mocks.chat.sessions = [
        { id: 'nu', projectId: c.carrier.user, settings: { notebookPath: 'u1.md' } },
        { id: 'nb', projectId: c.carrier.builtin, settings: { notebookPath: 'b1.md' } }
      ]

      // 手机：列表与对话是两屏，点的就是活跃的那一份也得再开（宿主据此推入对话页）
      mocks.chat.activeSessionId = 'nu'
      const adapter = makeAdapter(c, FIXTURE)
      await show(c, adapter, drillAt(c.key))
      click(must(userSel(c, 'u1.md')))
      expect(adapter.open.mock.calls).toEqual([['u1.md', 'User One']])

      mocks.chat.activeSessionId = 'nb'
      await show(c, adapter, drillAt(c.key))
      click(must(builtinSel(c, 'b1')))
      expect(adapter.openBuiltin).toHaveBeenCalledTimes(1)

      // 桌面的树：同一个状态下点活跃的那一行什么都不做
      act(() => root.unmount())
      root = createRoot(container)
      const tree = makeAdapter(c, FIXTURE)
      await show(c, tree)
      click(must(`[data-group="${c.key}"] button`))
      await flush()
      click(must(builtinSel(c, 'b1')))
      expect(tree.openBuiltin).not.toHaveBeenCalled()
      click(must(builtinSel(c, 'b2')))
      expect(tree.openBuiltin).toHaveBeenCalledTimes(1)

      mocks.chat.activeSessionId = 'nu'
      await show(c, tree)
      click(must(userSel(c, 'u1.md')))
      expect(tree.open).not.toHaveBeenCalled()
    })

    it(`${id(13)} a long press on a row: the same menus as the tree rows`, async () => {
      const adapter = makeAdapter(c, FIXTURE)
      await show(c, adapter, drillAt(c.key))

      // 内置：创建覆盖副本（有停用开关的组再加一项）
      pick = 'create-override'
      const builtinItems = await menuOn(must(builtinSel(c, 'b1')))
      expect(ids(builtinItems)).toEqual(
        c.disableable ? ['create-override', 'toggle-enabled'] : ['create-override']
      )
      expect(itemById(builtinItems, 'create-override').enabled).toBe(true)
      expect(adapter.createOverride).toHaveBeenCalledTimes(1)
      expect(adapter.createOverride.mock.calls[0][0]).toBe(B1)

      // 已经被覆盖的内置：那一项置灰
      pick = null
      const overriddenItems = await menuOn(must(builtinSel(c, 'b3')))
      expect(itemById(overriddenItems, 'create-override').enabled).toBe(false)

      // 生效的用户文件：按名删
      pick = c.deleteId
      expect(ids(await menuOn(must(userSel(c, 'u1.md'))))).toEqual([c.deleteId])
      expect(adapter.delete).toHaveBeenCalledTimes(1)
      expect(adapter.delete.mock.calls[0][0]).toBe(U1)
      expect(adapter.deleteFile).not.toHaveBeenCalled()

      // 被遮蔽的用户文件与解析不过的文件：按文件名删
      pick = c.deleteFileId
      expect(ids(await menuOn(must(userSel(c, 'u2.md'))))).toEqual([c.deleteFileId])
      expect(adapter.deleteFile.mock.calls).toEqual([['u2.md']])
      expect(ids(await menuOn(must(invalidSel(c, 'bad.md'))))).toEqual([c.deleteFileId])
      expect(adapter.deleteFile.mock.calls).toEqual([['u2.md'], ['bad.md']])
      expect(adapter.delete).toHaveBeenCalledTimes(1)
    })

    it(`${id(14)} the toolbar text: the count of items in effect, then how many are the user’s own`, async () => {
      await show(c, makeAdapter(c, FIXTURE), drillAt(c.key))
      expect(countText()).toBe(
        `${i18n.t('mobile.libraryCount', { count: 3, name: labelOf(c) })} · ${i18n.t(
          'mobile.libraryOwn',
          { count: 1 }
        )}`
      )

      // 没有生效的用户文件（被遮蔽的、解析不过的都不算）→ 没有后半句
      act(() => root.unmount())
      root = createRoot(container)
      await show(c, makeAdapter(c, { items: [B1, B2, U2], invalid: [BAD] }), drillAt(c.key))
      expect(countText()).toBe(i18n.t('mobile.libraryCount', { count: 2, name: labelOf(c) }))
      expect(countText()).not.toContain(' · ')
    })

    it(`${id(15)} the new button calls adapter.create once and is named by the new label`, async () => {
      const adapter = makeAdapter(c, FIXTURE)
      await show(c, adapter, drillAt(c.key))
      const add = must('[data-library-new]')
      expect(add.getAttribute('aria-label')).toBe(i18n.t(c.newLabelKey))
      click(add)
      expect(adapter.create).toHaveBeenCalledTimes(1)
    })

    it(`${id(16)} the menu button is drawn in menuSlot and opens the group menu; without a slot there is none`, async () => {
      const adapter = makeAdapter(c, FIXTURE)
      await show(c, adapter, drillAt(c.key))
      expect(document.querySelector('[data-library-menu]')).toBeNull()

      const menuSlot = slot()
      await show(c, adapter, drillAt(c.key, { menuSlot }))
      const button = must('[data-library-menu]', menuSlot)
      expect(q('[data-library-menu]')).toBeNull()
      expect(button.getAttribute('aria-label')).toBe(i18n.t('sidebar.moreActions'))
      expect(ids(await menuByClick(button))).toEqual(groupMenuIds(c))
    })

    it(`${id(17)} toolbarSlot: an element → the toolbar is drawn there; null → none`, async () => {
      const adapter = makeAdapter(c, FIXTURE)
      const toolbarSlot = slot()
      await show(c, adapter, drillAt(c.key, { toolbarSlot }))
      expect(q('[data-library-toolbar]', toolbarSlot)).not.toBeNull()
      expect(q('[data-library-toolbar]')).toBeNull()
      expect(countText(toolbarSlot)).toContain(
        i18n.t('mobile.libraryCount', { count: 3, name: labelOf(c) })
      )

      await show(c, adapter, drillAt(c.key, { toolbarSlot: null }))
      expect(document.querySelector('[data-library-toolbar]')).toBeNull()
    })
  })

  if (c.disableable) {
    describe('the disable switch (policies and hooks)', () => {
      const OFF: Item = { ...B1, disabled: true }
      const OFF_OVERRIDDEN: Item = { ...B3, disableable: true, disabled: true }

      it(`${id(21)} a disabled row fades and says Disabled; disabled + overridden shows only the overridden state`, async () => {
        await show(
          c,
          makeAdapter(c, { items: [OFF, U1, OFF_OVERRIDDEN], invalid: [] }),
          drillAt(c.key)
        )
        const off = must(builtinSel(c, 'b1'))
        expect(off.hasAttribute(`data-${c.attr}-disabled`)).toBe(true)
        expect(off.className).toContain('opacity-50')
        expect(badgeOf(off)).toBe(i18n.t('sidebar.disabledBadge'))
        expect(titleOf(off).className).not.toContain('line-through')

        const both = must(builtinSel(c, 'b3'))
        expect(both.hasAttribute(`data-${c.attr}-disabled`)).toBe(true)
        expect(both.hasAttribute(`data-${c.attr}-overridden`)).toBe(true)
        expect(badgeOf(both)).toBe(i18n.t(c.overriddenKey))
        expect(qa('[data-library-row-badge]', both)).toHaveLength(1)
        expect(titleOf(both).className).toContain('line-through')
        expect(both.className).not.toContain('opacity-50')
      })

      it(`${id(22)} toggle-enabled on a page row → adapter.setEnabled(item, !!item.disabled); the label says what it will do`, async () => {
        const adapter = makeAdapter(c, {
          items: [B1, { ...B2, disableable: true, disabled: true }],
          invalid: []
        })
        await show(c, adapter, drillAt(c.key))

        pick = 'toggle-enabled'
        const onItems = await menuOn(must(builtinSel(c, 'b1')))
        expect(itemById(onItems, 'toggle-enabled').label).toBe(i18n.t('common.disable'))
        expect(adapter.setEnabled!.mock.calls).toHaveLength(1)
        expect(adapter.setEnabled!.mock.calls[0][0]).toBe(B1)
        expect(adapter.setEnabled!.mock.calls[0][1]).toBe(false)

        const offItems = await menuOn(must(builtinSel(c, 'b2')))
        expect(itemById(offItems, 'toggle-enabled').label).toBe(i18n.t('common.enable'))
        expect(adapter.setEnabled!.mock.calls).toHaveLength(2)
        expect(adapter.setEnabled!.mock.calls[1][1]).toBe(true)
        expect(adapter.createOverride).not.toHaveBeenCalled()
      })

      it(`${id(25)} a disabled copy that is not overridden still counts (nav count and toolbar)`, async () => {
        // A3（现状）：数量只扣掉同名里被压过的；被停用的照样算
        const listing: Listing = { items: [OFF, B2], invalid: [] }
        const adapter = makeAdapter(c, listing)
        await show(c, adapter, drillAt(null))
        expect(navCount()).toBe('2')
        await show(c, adapter, drillAt(c.key))
        expect(countText()).toBe(i18n.t('mobile.libraryCount', { count: 2, name: labelOf(c) }))
      })
    })
  }

  describe('without drill (the desktop tree)', () => {
    it(`${id(23)} nothing is scanned at mount, the header is not a nav row; expanding shows the tree rows with the old anchors`, async () => {
      const adapter = makeAdapter(c, FIXTURE)
      await show(c, adapter)
      expect(adapter.list).not.toHaveBeenCalled()
      const header = must(`[data-group="${c.key}"]`)
      expect(header.hasAttribute('data-group-nav')).toBe(false)
      expect(q('[data-group-count]')).toBeNull()
      expect(q(builtinSel(c, 'b1'))).toBeNull()

      click(must('button', header))
      await flush()
      expect(adapter.list).toHaveBeenCalledTimes(1)
      const rowSel = `[data-${c.attr}-builtin-row], [data-${c.attr}-row], [data-${c.attr}-invalid-row]`
      // 内置置顶，然后用户文件，解析不过的缀在末尾
      expect(qa(rowSel).map((el) => rowIdOf(c, el))).toEqual([
        'b1',
        'b2',
        'b3',
        'u1.md',
        'u2.md',
        'bad.md'
      ])
      expect(q('[data-library-page]')).toBeNull()
      expect(qa('[data-library-row]')).toEqual([])
      expect(q('[data-library-toolbar]')).toBeNull()
      expect(q('[data-group-count]')).toBeNull()

      // 树里的内置行：行首一把锁；点它 → openBuiltin
      const b1 = must(builtinSel(c, 'b1'))
      expect(b1.querySelector('.sb-icon svg')).not.toBeNull()
      expect(must(userSel(c, 'u1.md')).querySelector('.sb-icon svg')).toBeNull()
      expect(must(builtinSel(c, 'b3')).hasAttribute(`data-${c.attr}-overridden`)).toBe(true)
      click(b1)
      expect(adapter.openBuiltin).toHaveBeenCalledTimes(1)
      expect(adapter.openBuiltin.mock.calls[0][0]).toBe(B1)
      click(must(userSel(c, 'u1.md')))
      expect(adapter.open.mock.calls).toEqual([['u1.md', 'User One']])
    })
  })
})
