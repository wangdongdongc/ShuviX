// @vitest-environment jsdom
/**
 * HookGroup 的停用开关（jsdom）—— 内置 hook 的停用开关在侧栏行菜单里（md 扩展元数据，2026-10-10）。
 *
 * 契约：菜单项 `toggle-enabled`（文案 common.disable / 停用后 common.enable）只出现在**宿主标了 disableable**
 * 且宿主提供了 `adapter.setEnabled` 的行上 —— 内置行（被同名覆盖时也有）与沿用了内置 id 的生效用户行；
 * 被遮蔽的用户行与解析不过的行只能按文件名删。停用的行带 `data-hook-disabled`、标签变淡、挂「已停用」徽标；
 * 已被覆盖的那份已经划线、挂「已覆盖」，不再叠一枚「已停用」。
 *
 *   SG-1 内置行菜单 = 创建覆盖副本 + 停用 / 启用；SG-2 选它 → adapter.setEnabled(item, !disabled)；
 *   SG-3 生效的用户行：有 disableable → 停用 / 启用 + 删除，没有 → 只有删除；
 *   SG-4 被遮蔽的用户行、解析不过的行 → 只有按文件名删；SG-5 被覆盖的内置行照样有开关、覆盖副本那一项置灰；
 *   SG-6 停用且没被覆盖 → data 属性、淡、徽标；SG-6b 停用且被覆盖 → data 属性、划线 + 已覆盖、没有已停用；
 *   SG-7 宿主没提供 setEnabled / 行没有 disableable（哪怕 objectId 长得像内置）→ 没有开关。
 *
 * 右键菜单走 ContextMenuProvider 的 `render` 注入：记录菜单项、按预设回一个 id（模拟用户点了它）。
 * `@shuvix/chat-ui` 替掉 useAppEvent / useChatStore / useChatHost。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'

vi.mock('@shuvix/chat-ui', () => ({
  useAppEvent: () => {},
  useChatStore: (selector: (s: { sessions: never[]; activeSessionId: null }) => unknown) =>
    selector({ sessions: [], activeSessionId: null }),
  useChatHost: () => ({ appearance: { focusMode: false } })
}))

import {
  HookGroup,
  type HookGroupAdapter,
  type HookGroupItem,
  type HookGroupInvalidFile
} from './HookGroup'
import { ContextMenuProvider } from '../contextmenu/ContextMenuProvider'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const BUILTIN = 'auto-title'
const BUILTIN_ID = 'hook:builtin:auto-title'
const UUID = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'

let container: HTMLDivElement
let root: Root
let mounted = false
/** 最近一次弹出的菜单项；pick = 「用户」点的那一项（null = 取消） */
let menus: ContextMenuItem[][]
let pick: string | null
let adapter: HookGroupAdapter & {
  setEnabled: ReturnType<typeof vi.fn<(item: HookGroupItem, enabled: boolean) => void>>
}

const builtinRow = (over: Partial<HookGroupItem> = {}): HookGroupItem => ({
  name: BUILTIN,
  displayName: 'Builtin  hook ',
  source: 'builtin',
  fileName: 'auto-title.md',
  objectId: BUILTIN_ID,
  disableable: true,
  ...over
})
const userRow = (fileName: string, over: Partial<HookGroupItem> = {}): HookGroupItem => ({
  name: fileName.replace(/\.md$/, ''),
  displayName: `User ${fileName}`,
  source: 'user',
  fileName,
  ...over
})

function makeAdapter(items: HookGroupItem[], invalid: HookGroupInvalidFile[] = []): typeof adapter {
  return {
    list: vi.fn(async () => ({ hooks: items, invalid })),
    open: vi.fn(),
    openBuiltin: vi.fn(),
    create: vi.fn(),
    createOverride: vi.fn(),
    openFolder: vi.fn(),
    delete: vi.fn(),
    deleteFile: vi.fn(),
    setEnabled: vi.fn<(item: HookGroupItem, enabled: boolean) => void>()
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** 渲染一个全新的分组实例并展开（首次展开才扫）；同一条用例里再挂一次 = 先卸掉旧的 */
async function mount(next: typeof adapter | Omit<typeof adapter, 'setEnabled'>): Promise<void> {
  if (mounted) {
    act(() => root.unmount())
    root = createRoot(container)
  }
  mounted = true
  await act(async () => {
    // props 的类型要求 children，而 lint 不许把 children 放进 props —— 子节点照常作第三个参数，props 断言一下
    type ProviderProps = ComponentProps<typeof ContextMenuProvider>
    const props: Omit<ProviderProps, 'children'> = {
      render: async (items: ContextMenuItem[]) => {
        menus.push(items)
        return pick
      }
    }
    root.render(
      createElement(
        ContextMenuProvider,
        props as ProviderProps,
        createElement(HookGroup, { adapter: next as HookGroupAdapter })
      )
    )
  })
  const toggle = container.querySelector('[data-group="hooks"] button') as HTMLButtonElement
  await act(async () => {
    toggle.click()
  })
  await flush()
}

const rowEl = (sel: string): HTMLElement => {
  const el = container.querySelector(sel) as HTMLElement | null
  if (!el) throw new Error(`${sel} not rendered`)
  return el
}
const builtinSel = `[data-hook-builtin-row="${BUILTIN}"]`
const userSel = (fileName: string): string => `[data-hook-row="${fileName}"]`
const invalidSel = (fileName: string): string => `[data-hook-invalid-row="${fileName}"]`

/** 右键这一行，回到弹出的菜单项（并按 pick 分发） */
async function menuOf(sel: string): Promise<ContextMenuItem[]> {
  const el = rowEl(sel)
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
const itemById = (
  items: ContextMenuItem[],
  id: string
): ContextMenuItem & { label?: string; enabled?: boolean } =>
  items.find((item) => 'id' in item && item.id === id) as ContextMenuItem & {
    label?: string
    enabled?: boolean
  }
/** 行里那个显示名标签（第二个 span） */
const labelOf = (sel: string): HTMLElement => rowEl(sel).querySelectorAll('span')[1] as HTMLElement
const hasBadge = (sel: string, text: string): boolean =>
  [...rowEl(sel).querySelectorAll('span')].some((s) => s.textContent === text)

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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('HookGroup —— 停用开关的菜单项', () => {
  it('SG-1 内置行（disableable）→ 菜单恰是 [create-override, toggle-enabled]；启用着写 Disable，停用着写 Enable', async () => {
    adapter = makeAdapter([builtinRow()])
    await mount(adapter)
    let items = await menuOf(builtinSel)
    expect(ids(items)).toEqual(['create-override', 'toggle-enabled'])
    expect(itemById(items, 'toggle-enabled').label).toBe(en.common.disable)

    adapter = makeAdapter([builtinRow({ disabled: true })])
    await mount(adapter)
    items = await menuOf(builtinSel)
    expect(ids(items)).toEqual(['create-override', 'toggle-enabled'])
    expect(itemById(items, 'toggle-enabled').label).toBe(en.common.enable)
  })

  it('SG-2 点了 toggle-enabled → adapter.setEnabled(item, !item.disabled)；启用着 → false，停用着 → true', async () => {
    adapter = makeAdapter([builtinRow()])
    await mount(adapter)
    pick = 'toggle-enabled'
    await menuOf(builtinSel)
    expect(adapter.setEnabled).toHaveBeenCalledTimes(1)
    expect(adapter.setEnabled.mock.calls[0][0]).toMatchObject({
      name: BUILTIN,
      objectId: BUILTIN_ID
    })
    expect(adapter.setEnabled.mock.calls[0][1]).toBe(false)
    expect(adapter.createOverride).not.toHaveBeenCalled()

    adapter = makeAdapter([builtinRow({ disabled: true })])
    await mount(adapter)
    await menuOf(builtinSel)
    expect(adapter.setEnabled).toHaveBeenCalledTimes(1)
    expect(adapter.setEnabled.mock.calls[0][1]).toBe(true)
  })

  it('SG-3 生效的用户行：有 disableable → [toggle-enabled, delete-hook]；没有 → 只有 delete-hook', async () => {
    adapter = makeAdapter([
      userRow('copy.md', { objectId: BUILTIN_ID, disableable: true }),
      userRow('mine.md', { objectId: UUID })
    ])
    await mount(adapter)
    expect(ids(await menuOf(userSel('copy.md')))).toEqual(['toggle-enabled', 'delete-hook'])
    expect(ids(await menuOf(userSel('mine.md')))).toEqual(['delete-hook'])

    pick = 'toggle-enabled'
    await menuOf(userSel('copy.md'))
    expect(adapter.setEnabled).toHaveBeenCalledTimes(1)
    expect(adapter.setEnabled.mock.calls[0][0]).toMatchObject({ fileName: 'copy.md' })
    expect(adapter.setEnabled.mock.calls[0][1]).toBe(false)
    expect(adapter.delete).not.toHaveBeenCalled()
  })

  it('SG-4 被遮蔽的用户行（哪怕 disableable）与解析不过的行 → 只有 delete-hook-file', async () => {
    adapter = makeAdapter(
      [
        userRow('auto-title.md', { name: BUILTIN, objectId: BUILTIN_ID, disableable: true }),
        userRow('a.md', {
          name: BUILTIN,
          objectId: BUILTIN_ID,
          disableable: true,
          overridden: true,
          overriddenBy: 'auto-title.md'
        })
      ],
      [{ fileName: 'broken.md', error: 'bad' }]
    )
    await mount(adapter)
    expect(ids(await menuOf(userSel('a.md')))).toEqual(['delete-hook-file'])
    expect(ids(await menuOf(invalidSel('broken.md')))).toEqual(['delete-hook-file'])
  })

  it('SG-5 被同名覆盖的内置行：照样有开关，创建覆盖副本那一项置灰', async () => {
    adapter = makeAdapter([
      builtinRow({ overridden: true, overriddenBy: 'auto-title.md' }),
      userRow('auto-title.md', { name: BUILTIN, objectId: BUILTIN_ID, disableable: true })
    ])
    await mount(adapter)
    const items = await menuOf(builtinSel)
    expect(ids(items)).toEqual(['create-override', 'toggle-enabled'])
    expect(itemById(items, 'create-override').enabled).toBe(false)
  })

  it('SG-7 宿主没提供 setEnabled → 没有开关；行没有 disableable（objectId 长得像内置也一样）→ 没有开关', async () => {
    const full = makeAdapter([builtinRow()])
    const { setEnabled: _drop, ...withoutToggle } = full
    await mount(withoutToggle)
    expect(ids(await menuOf(builtinSel))).toEqual(['create-override'])

    adapter = makeAdapter([
      builtinRow({ disableable: undefined }),
      userRow('copy.md', { objectId: BUILTIN_ID })
    ])
    await mount(adapter)
    expect(ids(await menuOf(builtinSel))).toEqual(['create-override'])
    expect(ids(await menuOf(userSel('copy.md')))).toEqual(['delete-hook'])
  })
})

describe('HookGroup —— 停用的行', () => {
  it('SG-6 停用且没被覆盖 → data-hook-disabled、标签 opacity-50、挂「已停用」徽标；没停用的行都没有', async () => {
    adapter = makeAdapter([
      builtinRow({ disabled: true }),
      userRow('copy.md', { objectId: BUILTIN_ID, disableable: true, disabled: true }),
      userRow('mine.md')
    ])
    await mount(adapter)
    for (const sel of [builtinSel, userSel('copy.md')]) {
      expect(rowEl(sel).hasAttribute('data-hook-disabled'), sel).toBe(true)
      expect(labelOf(sel).className, sel).toContain('opacity-50')
      expect(labelOf(sel).className, sel).not.toContain('line-through')
      expect(hasBadge(sel, en.sidebar.disabledBadge), sel).toBe(true)
    }
    expect(rowEl(userSel('mine.md')).hasAttribute('data-hook-disabled')).toBe(false)
    expect(hasBadge(userSel('mine.md'), en.sidebar.disabledBadge)).toBe(false)
  })

  it('SG-6b 停用且被覆盖 → data 属性在、划线 + 「已覆盖」，不叠「已停用」', async () => {
    adapter = makeAdapter([
      builtinRow({ disabled: true, overridden: true, overriddenBy: 'auto-title.md' }),
      userRow('auto-title.md', {
        name: BUILTIN,
        objectId: BUILTIN_ID,
        disableable: true,
        disabled: true
      })
    ])
    await mount(adapter)
    expect(rowEl(builtinSel).hasAttribute('data-hook-disabled')).toBe(true)
    expect(rowEl(builtinSel).hasAttribute('data-hook-overridden')).toBe(true)
    expect(labelOf(builtinSel).className).toContain('line-through')
    expect(hasBadge(builtinSel, en.settings.hookOverridden)).toBe(true)
    expect(hasBadge(builtinSel, en.sidebar.disabledBadge)).toBe(false)
  })
})
