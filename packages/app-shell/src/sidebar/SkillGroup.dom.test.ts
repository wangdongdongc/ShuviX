// @vitest-environment jsdom
/**
 * SkillGroup 的共用目录（jsdom）—— `~/.claude/skills` / `~/.agents/skills` 由宿主固定列出（`isShared`）：
 *
 *   SKG-1 行上的字：共用目录显示宿主给的 `label`（路径写法），外部目录没给 label 就显示 dirName；
 *         title 是 dirPath；文件夹行都不挂锁，内置目录也不画文件夹行；
 *   SKG-2 目录菜单：共用 = 开关 + 打开（没有移除）；外部 = 开关、打开、分隔线、移除；
 *         在关着的共用目录上点开关 → setFolderEnabled(folder, true)，removeFolder 从不被调；
 *   SKG-3 关着的共用目录：文件夹行与组内每一行都带 data-skill-off，开关项写 Enable；
 *   SKG-4 共用目录里技能行的菜单只有开关（删除只对默认目录开放）；
 *   SKG-5 当前笔记高亮：共用目录的载体 id 是 `__skills:<dirName>__` —— agents:pdf 亮，同一个 dirEntry 的
 *         claude:pdf 不亮。
 *
 * 内置技能平铺（不占文件夹行，行首一把锁），整组开关在组头菜单里（`toggle-builtin`）：
 *
 *   SKG-6 画的顺序：内置 → 共用 → 外部 → 默认；宿主把清单倒过来给，内置仍在最前、默认仍在最后；
 *   SKG-7 行的样子：内置 = 图标位一把锁、本地化名字（与标识名不只差大小写时并排留标识名）、title 是界面说明；
 *         没有文案的内置退回原名与 description；默认目录里同名的 `drawing` 是普通的书图标；目录下的行缩进；
 *   SKG-8 点内置行 = open 那个技能对象；⋮ 只开菜单不开笔记；菜单只有开关，点不出删除；
 *   SKG-9 组头菜单（开着）：有 toggle-builtin，文案 Disable Built-in Skills，点它 = setFolderEnabled(builtin, false)；
 *         宿主没给内置目录就没有这一项；
 *   SKG-10 组头菜单（关着）：每一行内置都变淡（技能自己那一级仍开着），文案换 Enable；
 *          toggle-default 与 toggle-builtin 不串线；
 *   SKG-11 重扫跟状态：单个技能关着 → 只有它淡；整组关掉 → 全淡，组头文案跟着换；
 *   SKG-12 空态表：连一行可画的都没有才显示提示（空的外部目录也算一行）；
 *   SKG-13 跨载体高亮：同一个 `drawing/SKILL.md`，内置载体只亮内置那行，默认载体只亮默认那行。
 *
 * 两层导航（`drill`，手机布局的资料库，见 LibraryPage）—— 文件末尾那一组：
 *
 *   SK-1 / SK-2 / SK-3 顶层只有一行导航行：数量 = 所有目录里的技能（内置、关着的都算），挂上就扫；点它 = onOpen；
 *         长按 = 组头菜单；
 *   SK-4 / SK-5 / SK-6 / SK-7 技能页的节：我的（默认目录）→ 共用 / 外部目录各一节 → 内置，与宿主给的顺序无关；
 *         空的共用 / 外部目录也画一节（一句话），空的默认 / 内置目录不画；一节都没有 → 整页的那一句；
 *   SK-8 / SK-9 / SK-10 / SK-17 目录小标题的长按菜单；关着的目录：小标题划线、组内每一行都是「已停用」；
 *   SK-11 / SK-12 行的内容：内置 = 锁 + 本地化名字（+ 标识名）+ 界面说明，其余 = 原名 + description；
 *   SK-13 / SK-14 点一行 = open 那个技能对象；长按一行的菜单；
 *   SK-15 / SK-16 工具栏那句话（没有新建）与「⋯」；
 *   SK-18 别的页开着：什么都不画但扫过，`skill.changed` 重扫；SK-19 不给 drill：挂上不扫、没有导航行。
 *
 * 右键菜单走 ContextMenuProvider 的 `render` 注入：记录菜单项、按预设回一个 id（模拟用户点了它）——
 * 预设的 id 不在这份菜单里就回 null（真菜单点不出一个它没有的项）。`@shuvix/chat-ui` 替掉
 * useAppEvent（记下订阅者，SK-18 按事件名派发）/ useChatStore / useChatHost；chatStore 的状态放在可变的
 * `store` 里（SKG-5 换活动会话）。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'

interface StoreSession {
  id: string
  projectId: string | null
  settings: { notebookPath?: string }
}
const store = vi.hoisted(() => ({
  sessions: [] as StoreSession[],
  activeSessionId: null as string | null
}))
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
    useChatStore: (selector: (s: typeof store) => unknown) => selector(store),
    useChatHost: () => ({ appearance: { focusMode: false } })
  }
})

import {
  SkillGroup,
  type SkillGroupAdapter,
  type SkillGroupFolder,
  type SkillGroupItem
} from './SkillGroup'
import type { LibraryDrill } from './LibraryPage'
import { ContextMenuProvider } from '../contextmenu/ContextMenuProvider'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
/** 每次弹出的菜单项；pick = 「用户」点的那一项（null = 取消；不在菜单里也当取消） */
let menus: ContextMenuItem[][]
let pick: string | null

type Adapter = SkillGroupAdapter & {
  list: ReturnType<typeof vi.fn<SkillGroupAdapter['list']>>
  open: ReturnType<typeof vi.fn<SkillGroupAdapter['open']>>
  setFolderEnabled: ReturnType<typeof vi.fn<SkillGroupAdapter['setFolderEnabled']>>
  removeFolder: ReturnType<typeof vi.fn<SkillGroupAdapter['removeFolder']>>
  setSkillEnabled: ReturnType<typeof vi.fn<SkillGroupAdapter['setSkillEnabled']>>
  deleteSkill: ReturnType<typeof vi.fn<SkillGroupAdapter['deleteSkill']>>
}

const skill = (
  name: string,
  dirEntry: string,
  over: Partial<SkillGroupItem> = {}
): SkillGroupItem => ({
  name,
  displayName: name.includes(':') ? name.slice(name.indexOf(':') + 1) : name,
  dirEntry,
  description: `${name} description`,
  isEnabled: true,
  ...over
})

const folder = (
  over: Partial<SkillGroupFolder> & Pick<SkillGroupFolder, 'dirName'>
): SkillGroupFolder => ({
  dirPath: `/home/u/${over.dirName}`,
  isDefault: false,
  isBuiltin: false,
  isShared: false,
  isEnabled: true,
  skills: [],
  ...over
})

const builtinFolder = (over: Partial<SkillGroupFolder> = {}): SkillGroupFolder =>
  folder({
    dirName: 'builtin',
    dirPath: '/app/Resources/skills/en',
    isBuiltin: true,
    skills: [skill('builtin:drawing', 'drawing')],
    ...over
  })
const claudeFolder = (over: Partial<SkillGroupFolder> = {}): SkillGroupFolder =>
  folder({
    dirName: 'claude',
    dirPath: '/home/u/.claude/skills',
    isShared: true,
    label: '~/.claude/skills',
    isEnabled: false,
    skills: [skill('claude:pdf', 'pdf')],
    ...over
  })
const agentsFolder = (over: Partial<SkillGroupFolder> = {}): SkillGroupFolder =>
  folder({
    dirName: 'agents',
    dirPath: '/home/u/.agents/skills',
    isShared: true,
    label: '~/.agents/skills',
    isEnabled: false,
    skills: [skill('agents:pdf', 'pdf'), skill('agents:docx', 'docx')],
    ...over
  })
const extFolder = (over: Partial<SkillGroupFolder> = {}): SkillGroupFolder =>
  folder({
    dirName: 'my-ext',
    dirPath: '/home/u/work/skills',
    skills: [skill('my-ext:tool', 'tool')],
    ...over
  })
const defaultFolder = (over: Partial<SkillGroupFolder> = {}): SkillGroupFolder =>
  folder({
    dirName: 'default',
    dirPath: '/home/u/.shuvix/skills',
    isDefault: true,
    skills: [skill('mine', 'mine')],
    ...over
  })
/** 两个有界面文案的内置技能 */
const twoBuiltins = (over: Partial<SkillGroupFolder> = {}): SkillGroupFolder =>
  builtinFolder({
    skills: [skill('builtin:drawing', 'drawing'), skill('builtin:widget', 'widget')],
    ...over
  })

function makeAdapter(folders: SkillGroupFolder[]): Adapter {
  return {
    list: vi.fn<SkillGroupAdapter['list']>(async () => folders),
    open: vi.fn<SkillGroupAdapter['open']>(),
    setSkillEnabled: vi.fn<SkillGroupAdapter['setSkillEnabled']>(),
    setFolderEnabled: vi.fn<SkillGroupAdapter['setFolderEnabled']>(),
    addFolder: vi.fn(),
    removeFolder: vi.fn<SkillGroupAdapter['removeFolder']>(),
    deleteSkill: vi.fn<SkillGroupAdapter['deleteSkill']>(),
    openFolder: vi.fn()
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** 渲染分组并展开（首次展开才扫） */
async function mount(adapter: Adapter): Promise<void> {
  await act(async () => {
    type ProviderProps = ComponentProps<typeof ContextMenuProvider>
    const props: Omit<ProviderProps, 'children'> = {
      render: async (items: ContextMenuItem[]) => {
        menus.push(items)
        return pick !== null && items.some((it) => it.id === pick) ? pick : null
      }
    }
    root.render(
      createElement(
        ContextMenuProvider,
        props as ProviderProps,
        createElement(SkillGroup, { adapter })
      )
    )
  })
  const toggle = container.querySelector('[data-group="skills"] button') as HTMLButtonElement
  await act(async () => {
    toggle.click()
  })
  await flush()
}

const el = (sel: string): HTMLElement => {
  const found = container.querySelector(sel) as HTMLElement | null
  if (!found) throw new Error(`${sel} not rendered`)
  return found
}
const folderSel = (dirName: string): string => `[data-skill-folder="${dirName}"]`
const rowSel = (name: string): string => `[data-skill-row="${name}"]`
/** 文件夹行上显示的字（第二个 span：第一个是图标位） */
const folderLabel = (dirName: string): string =>
  (el(folderSel(dirName)).querySelectorAll('span')[1]?.textContent ?? '').trim()
const isLocked = (dirName: string): boolean =>
  el(folderSel(dirName)).querySelector(`[aria-label="${en.tool.subAgentBuiltin}"]`) !== null
/** 某个文件夹下面的技能行（文件夹行的下一个兄弟就是它那层折叠容器） */
const rowsUnder = (dirName: string): HTMLElement[] => [
  ...((el(folderSel(dirName)).nextElementSibling?.querySelectorAll('[data-skill-row]') ??
    []) as NodeListOf<HTMLElement>)
]

/** 右键这一行，回到弹出的菜单项（并按 pick 分发） */
async function menuOf(sel: string): Promise<ContextMenuItem[]> {
  const target = el(sel)
  const before = menus.length
  await act(async () => {
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await flush()
  expect(menus.length).toBe(before + 1)
  return menus[menus.length - 1]
}
/** 菜单项的 id；分隔线记作 'separator' */
const ids = (items: ContextMenuItem[]): string[] => items.map((item) => item.id ?? item.type ?? '?')
const labelOf = (items: ContextMenuItem[], id: string): string | undefined =>
  items.find((item) => item.id === id)?.label

/** 组头（右键它与点它的 ⋮ 是同一份菜单） */
const GROUP = '[data-group="skills"]'
/** 分组里所有行（技能行 + 文件夹行）按 DOM 序 */
const drawOrder = (): Array<string | null> =>
  [...container.querySelectorAll('[data-skill-row],[data-skill-folder]')].map(
    (node) => node.getAttribute('data-skill-row') ?? node.getAttribute('data-skill-folder')
  )
/** 技能行的图标位 */
const iconCell = (name: string): Element | null => el(rowSel(name)).querySelector('.sb-icon')
/** 技能行上显示名字的那个 span */
const rowLabel = (name: string): HTMLElement => {
  const label = el(rowSel(name)).querySelector('span.truncate') as HTMLElement | null
  if (!label) throw new Error(`${name} has no label`)
  return label
}
const offRows = (): Array<string | null> =>
  [...container.querySelectorAll('[data-skill-row][data-skill-off]')].map((row) =>
    row.getAttribute('data-skill-row')
  )
const activeRows = (): Array<string | null> =>
  [...container.querySelectorAll('[data-skill-row]')]
    .filter((row) => row.className.includes('bg-bg-active'))
    .map((row) => row.getAttribute('data-skill-row'))
/** 点这一行的 ⋮，回到弹出的菜单项 */
async function clickMore(name: string): Promise<ContextMenuItem[]> {
  const button = el(rowSel(name)).querySelector(
    `button[aria-label="${en.sidebar.moreActions}"]`
  ) as HTMLButtonElement | null
  if (!button) throw new Error(`${name} has no menu button`)
  const before = menus.length
  await act(async () => {
    button.click()
  })
  await flush()
  expect(menus.length).toBe(before + 1)
  return menus[menus.length - 1]
}

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
  store.sessions = []
  store.activeSessionId = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SkillGroup —— 共用目录的行', () => {
  it('SKG-1 行上的字：共用目录 = label，外部（无 label）= dirName；title = dirPath；文件夹行不挂锁，内置目录不画文件夹行', async () => {
    await mount(
      makeAdapter([builtinFolder(), claudeFolder(), agentsFolder(), extFolder(), defaultFolder()])
    )

    expect(
      [...container.querySelectorAll('[data-skill-folder]')].map((f) =>
        f.getAttribute('data-skill-folder')
      )
    ).toEqual(['claude', 'agents', 'my-ext'])

    expect(folderLabel('claude')).toBe('~/.claude/skills')
    expect(folderLabel('agents')).toBe('~/.agents/skills')
    expect(folderLabel('my-ext')).toBe('my-ext')

    expect(el(folderSel('claude')).title).toBe('/home/u/.claude/skills')
    expect(el(folderSel('agents')).title).toBe('/home/u/.agents/skills')
    expect(el(folderSel('my-ext')).title).toBe('/home/u/work/skills')

    // 锁 = 只读；共用目录是用户自己的文件（可编辑），不挂锁
    expect(isLocked('claude')).toBe(false)
    expect(isLocked('agents')).toBe(false)
    expect(isLocked('my-ext')).toBe(false)

    // 共用技能行上只显示技能自己的名字
    expect(rowsUnder('agents').map((r) => r.textContent?.trim())).toEqual(['pdf', 'docx'])
  })

  it('SKG-3 关着的共用目录：文件夹行与组内每一行都带 data-skill-off（技能自己那一级仍开着）；开着的外部目录都不带', async () => {
    await mount(makeAdapter([agentsFolder(), extFolder(), defaultFolder()]))

    expect(el(folderSel('agents')).hasAttribute('data-skill-off')).toBe(true)
    const rows = rowsUnder('agents')
    expect(rows).toHaveLength(2)
    for (const row of rows)
      expect(row.hasAttribute('data-skill-off'), row.dataset.skillRow).toBe(true)

    expect(el(folderSel('my-ext')).hasAttribute('data-skill-off')).toBe(false)
    expect(el(rowSel('my-ext:tool')).hasAttribute('data-skill-off')).toBe(false)
    expect(el(rowSel('mine')).hasAttribute('data-skill-off')).toBe(false)

    // 开关项的字随组的状态：关着 → Enable
    expect(labelOf(await menuOf(folderSel('agents')), 'toggle')).toBe(en.common.enable)
    expect(labelOf(await menuOf(folderSel('my-ext')), 'toggle')).toBe(en.common.disable)
  })
})

describe('SkillGroup —— 共用目录的菜单', () => {
  it('SKG-2 目录菜单：共用 = [toggle, open]，外部 = [toggle, open, separator, remove]；在关着的共用目录上点开关 → setFolderEnabled(folder, true)', async () => {
    const adapter = makeAdapter([claudeFolder(), agentsFolder(), extFolder()])
    await mount(adapter)

    expect(ids(await menuOf(folderSel('claude')))).toEqual(['toggle', 'open'])
    expect(ids(await menuOf(folderSel('agents')))).toEqual(['toggle', 'open'])
    expect(ids(await menuOf(folderSel('my-ext')))).toEqual([
      'toggle',
      'open',
      'separator',
      'remove'
    ])

    pick = 'toggle'
    await menuOf(folderSel('agents'))
    expect(adapter.setFolderEnabled).toHaveBeenCalledTimes(1)
    expect(adapter.setFolderEnabled.mock.calls[0][0]).toMatchObject({
      dirName: 'agents',
      isShared: true
    })
    expect(adapter.setFolderEnabled.mock.calls[0][1]).toBe(true)

    // 菜单里没有「移除」：点不出来，宿主那一侧的移除一次都不被调
    pick = 'remove'
    await menuOf(folderSel('agents'))
    await menuOf(folderSel('claude'))
    expect(adapter.removeFolder).not.toHaveBeenCalled()
  })

  it('SKG-4 共用目录里技能行的菜单只有开关', async () => {
    const adapter = makeAdapter([agentsFolder(), defaultFolder()])
    await mount(adapter)

    expect(ids(await menuOf(rowSel('agents:pdf')))).toEqual(['toggle'])
    // 对照组：默认目录的技能有删除
    expect(ids(await menuOf(rowSel('mine')))).toEqual(['toggle', 'separator', 'delete'])

    pick = 'toggle'
    await menuOf(rowSel('agents:pdf'))
    expect(adapter.setSkillEnabled).toHaveBeenCalledTimes(1)
    expect(adapter.setSkillEnabled.mock.calls[0][0]).toMatchObject({ name: 'agents:pdf' })
    expect(adapter.setSkillEnabled.mock.calls[0][1]).toBe(false)
    expect(adapter.deleteSkill).not.toHaveBeenCalled()
  })
})

describe('SkillGroup —— 当前笔记高亮', () => {
  it('SKG-5 活动会话是 `__skills:agents__` 下的 pdf/SKILL.md：agents:pdf 亮，同一个 dirEntry 的 claude:pdf 不亮', async () => {
    store.sessions = [
      { id: 's1', projectId: '__skills:agents__', settings: { notebookPath: 'pdf/SKILL.md' } }
    ]
    store.activeSessionId = 's1'
    await mount(makeAdapter([claudeFolder(), agentsFolder(), defaultFolder()]))

    const active = [...container.querySelectorAll('[data-skill-row]')]
      .filter((r) => r.className.includes('bg-bg-active'))
      .map((r) => r.getAttribute('data-skill-row'))
    expect(active).toEqual(['agents:pdf'])
    expect(el(rowSel('claude:pdf')).className).not.toContain('bg-bg-active')
  })
})

describe('SkillGroup —— 内置技能平铺', () => {
  it('SKG-6 画的顺序：内置 → 共用 → 外部 → 默认', async () => {
    await mount(
      makeAdapter([twoBuiltins(), claudeFolder(), agentsFolder(), extFolder(), defaultFolder()])
    )
    expect(drawOrder()).toEqual([
      'builtin:drawing',
      'builtin:widget',
      'claude',
      'claude:pdf',
      'agents',
      'agents:pdf',
      'agents:docx',
      'my-ext',
      'my-ext:tool',
      'mine'
    ])
  })

  it('SKG-6 宿主给的顺序倒过来：内置仍在最前，默认仍在最后', async () => {
    await mount(makeAdapter([defaultFolder(), extFolder(), twoBuiltins()]))
    expect(drawOrder()).toEqual([
      'builtin:drawing',
      'builtin:widget',
      'my-ext',
      'my-ext:tool',
      'mine'
    ])
  })

  it('SKG-7 内置行：图标位是锁（无障碍名「内置」）、不缩进；本地化名字，title 是界面说明', async () => {
    await mount(makeAdapter([builtinFolder(), defaultFolder()]))
    const row = el(rowSel('builtin:drawing'))

    const cell = iconCell('builtin:drawing')
    expect(cell?.querySelector('.lucide-lock')).not.toBeNull()
    expect(cell?.getAttribute('aria-label')).toBe(en.tool.subAgentBuiltin)
    expect(row.querySelector('.lucide-book-open')).toBeNull()
    expect(row.classList.contains('sb-depth-1')).toBe(false)

    expect(rowLabel('builtin:drawing').textContent).toBe(en.builtinSkill.drawing.label)
    // 英文名 Drawing 与标识名 drawing 只差大小写：sameAsIdentifier 不让它并排再写一遍
    expect(row.querySelector('[data-skill-identifier]')).toBeNull()
    expect(row.title).toBe(en.builtinSkill.drawing.hint)
    expect(row.title).not.toBe('builtin:drawing description')
  })

  it('SKG-7 名字与标识名不只差大小写（Widgets / widget）：标识名并排留着', async () => {
    await mount(makeAdapter([twoBuiltins()]))
    const row = el(rowSel('builtin:widget'))

    expect(rowLabel('builtin:widget').textContent).toBe(en.builtinSkill.widget.label)
    expect(row.querySelector('[data-skill-identifier]')?.textContent).toBe('widget')
    expect(row.title).toBe(en.builtinSkill.widget.hint)
  })

  it('SKG-7 没有文案的内置（builtin:zzz）：锁还在；显示原名、没有标识名，title 退回 description', async () => {
    await mount(makeAdapter([builtinFolder({ skills: [skill('builtin:zzz', 'zzz')] })]))
    const row = el(rowSel('builtin:zzz'))

    expect(iconCell('builtin:zzz')?.querySelector('.lucide-lock')).not.toBeNull()
    expect(rowLabel('builtin:zzz').textContent).toBe('zzz')
    expect(row.querySelector('[data-skill-identifier]')).toBeNull()
    expect(row.title).toBe('builtin:zzz description')
  })

  it('SKG-7 默认目录里恰好叫 drawing 的技能：书图标、原名、不缩进（文案只认内置）', async () => {
    await mount(makeAdapter([defaultFolder({ skills: [skill('drawing', 'drawing')] })]))
    const row = el(rowSel('drawing'))

    expect(row.querySelector('.lucide-book-open')).not.toBeNull()
    expect(row.querySelector('.lucide-lock')).toBeNull()
    expect(rowLabel('drawing').textContent).toBe('drawing')
    expect(row.querySelector('[data-skill-identifier]')).toBeNull()
    expect(row.title).toBe('drawing description')
    expect(row.classList.contains('sb-depth-1')).toBe(false)
  })

  it('SKG-7 目录下的行：书图标、缩进一层', async () => {
    await mount(makeAdapter([extFolder()]))
    const row = el(rowSel('my-ext:tool'))

    expect(row.querySelector('.lucide-book-open')).not.toBeNull()
    expect(row.querySelector('.lucide-lock')).toBeNull()
    expect(row.classList.contains('sb-depth-1')).toBe(true)
  })

  it('SKG-8 点内置行 = open 那个技能对象一次；点 ⋮ 只开菜单、不开笔记', async () => {
    const item = skill('builtin:drawing', 'drawing')
    const adapter = makeAdapter([builtinFolder({ skills: [item] }), defaultFolder()])
    await mount(adapter)

    await act(async () => {
      el(rowSel('builtin:drawing')).click()
    })
    expect(adapter.open).toHaveBeenCalledTimes(1)
    expect(adapter.open.mock.calls[0][0]).toBe(item)

    adapter.open.mockClear()
    expect(ids(await clickMore('builtin:drawing'))).toEqual(['toggle'])
    expect(adapter.open).not.toHaveBeenCalled()
  })

  it('SKG-8 内置行的菜单只有开关：Disable → setSkillEnabled(skill, false)，不碰整组；点不出删除', async () => {
    const item = skill('builtin:drawing', 'drawing')
    const adapter = makeAdapter([builtinFolder({ skills: [item] }), defaultFolder()])
    await mount(adapter)

    const items = await menuOf(rowSel('builtin:drawing'))
    expect(ids(items)).toEqual(['toggle'])
    expect(labelOf(items, 'toggle')).toBe(en.common.disable)

    pick = 'toggle'
    await menuOf(rowSel('builtin:drawing'))
    expect(adapter.setSkillEnabled).toHaveBeenCalledTimes(1)
    expect(adapter.setSkillEnabled.mock.calls[0][0]).toBe(item)
    expect(adapter.setSkillEnabled.mock.calls[0][1]).toBe(false)
    expect(adapter.setFolderEnabled).not.toHaveBeenCalled()

    pick = 'delete'
    await menuOf(rowSel('builtin:drawing'))
    expect(adapter.deleteSkill).not.toHaveBeenCalled()
  })
})

describe('SkillGroup —— 内置技能的组头开关', () => {
  it('SKG-9 开着：菜单里有 toggle-builtin（Disable Built-in Skills），点它 = setFolderEnabled(builtin, false)', async () => {
    const adapter = makeAdapter([builtinFolder(), defaultFolder()])
    await mount(adapter)

    const items = await menuOf(GROUP)
    expect(ids(items)).toEqual([
      'add-folder',
      'open-default',
      'toggle-default',
      'toggle-builtin',
      'separator',
      'refresh'
    ])
    expect(labelOf(items, 'toggle-builtin')).toBe(en.settings.skillBuiltinDisable)
    expect(labelOf(items, 'toggle-default')).toBe(en.settings.skillDefaultDisable)

    pick = 'toggle-builtin'
    await menuOf(GROUP)
    expect(adapter.setFolderEnabled).toHaveBeenCalledTimes(1)
    expect(adapter.setFolderEnabled.mock.calls[0][0]).toMatchObject({ dirName: 'builtin' })
    expect(adapter.setFolderEnabled.mock.calls[0][1]).toBe(false)
  })

  it('SKG-9 宿主没给内置目录：没有 toggle-builtin，点也点不出东西', async () => {
    const adapter = makeAdapter([extFolder(), defaultFolder()])
    await mount(adapter)

    expect(ids(await menuOf(GROUP))).not.toContain('toggle-builtin')

    pick = 'toggle-builtin'
    await menuOf(GROUP)
    expect(adapter.setFolderEnabled).not.toHaveBeenCalled()
  })

  it('SKG-10 关着：每一行内置都变淡（技能自己那一级仍开着），别的组不受牵连；文案换 Enable，点它 = setFolderEnabled(builtin, true)', async () => {
    const adapter = makeAdapter([twoBuiltins({ isEnabled: false }), extFolder(), defaultFolder()])
    await mount(adapter)

    for (const name of ['builtin:drawing', 'builtin:widget']) {
      expect(el(rowSel(name)).hasAttribute('data-skill-off'), name).toBe(true)
      expect(iconCell(name)?.className, name).toContain('opacity-40')
      expect(rowLabel(name).className, name).toContain('line-through')
    }
    expect(el(rowSel('mine')).hasAttribute('data-skill-off')).toBe(false)
    expect(el(rowSel('my-ext:tool')).hasAttribute('data-skill-off')).toBe(false)

    expect(labelOf(await menuOf(GROUP), 'toggle-builtin')).toBe(en.settings.skillBuiltinEnable)

    pick = 'toggle-builtin'
    await menuOf(GROUP)
    expect(adapter.setFolderEnabled).toHaveBeenCalledTimes(1)
    expect(adapter.setFolderEnabled.mock.calls[0][0]).toMatchObject({ dirName: 'builtin' })
    expect(adapter.setFolderEnabled.mock.calls[0][1]).toBe(true)
  })

  it('SKG-10 不串线：内置关着时点 toggle-default，只动默认目录', async () => {
    const adapter = makeAdapter([twoBuiltins({ isEnabled: false }), defaultFolder()])
    await mount(adapter)

    pick = 'toggle-default'
    await menuOf(GROUP)
    expect(adapter.setFolderEnabled).toHaveBeenCalledTimes(1)
    expect(adapter.setFolderEnabled.mock.calls[0][0]).toMatchObject({ dirName: 'default' })
    expect(adapter.setFolderEnabled.mock.calls[0][1]).toBe(false)
  })

  it('SKG-11 重扫跟状态：单个技能关着 → 只有它淡；整组关掉 → 全淡，组头文案跟着换', async () => {
    const skills = [
      skill('builtin:drawing', 'drawing', { isEnabled: false }),
      skill('builtin:widget', 'widget')
    ]
    const adapter = makeAdapter([builtinFolder({ skills }), defaultFolder()])
    await mount(adapter)

    expect(offRows()).toEqual(['builtin:drawing'])
    expect(labelOf(await menuOf(GROUP), 'toggle-builtin')).toBe(en.settings.skillBuiltinDisable)

    adapter.list.mockResolvedValue([builtinFolder({ skills, isEnabled: false }), defaultFolder()])
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()

    expect(offRows()).toEqual(['builtin:drawing', 'builtin:widget'])
    expect(labelOf(await menuOf(GROUP), 'toggle-builtin')).toBe(en.settings.skillBuiltinEnable)
  })
})

describe('SkillGroup —— 空态', () => {
  const rejecting = (): Adapter => {
    const adapter = makeAdapter([])
    adapter.list.mockRejectedValue(new Error('scan failed'))
    return adapter
  }

  it.each<[string, () => Adapter, boolean, number]>([
    ['清单是空的', () => makeAdapter([]), true, 0],
    ['清单读取失败', rejecting, true, 0],
    [
      '内置与默认都没有技能',
      () => makeAdapter([builtinFolder({ skills: [] }), defaultFolder({ skills: [] })]),
      true,
      0
    ],
    [
      '内置有一个、默认没有',
      () => makeAdapter([builtinFolder(), defaultFolder({ skills: [] })]),
      false,
      1
    ],
    ['默认有一个', () => makeAdapter([defaultFolder()]), false, 1],
    [
      '三组都没有技能，但有一个空的外部目录',
      () =>
        makeAdapter([
          builtinFolder({ skills: [] }),
          extFolder({ skills: [] }),
          defaultFolder({ skills: [] })
        ]),
      false,
      0
    ]
  ])('SKG-12 %s', async (_label, makeIt, hint, rowCount) => {
    await mount(makeIt())

    const shown = container.querySelector('.sb-hint')
    if (hint) expect(shown?.textContent).toBe(en.settings.skillEmpty)
    else expect(shown).toBeNull()
    expect(container.querySelectorAll('[data-skill-row]')).toHaveLength(rowCount)
  })

  it('SKG-12 空的外部目录照样画文件夹行（移除入口只长在那一行的菜单上）', async () => {
    await mount(
      makeAdapter([
        builtinFolder({ skills: [] }),
        extFolder({ skills: [] }),
        defaultFolder({ skills: [] })
      ])
    )
    expect(container.querySelector(folderSel('my-ext'))).not.toBeNull()
  })
})

describe('SkillGroup —— 跨载体高亮', () => {
  it.each([
    ['__skills_builtin__', 'builtin:drawing'],
    ['__skills__', 'drawing']
  ])(
    'SKG-13 活动会话在 %s 下的 drawing/SKILL.md：只亮 %s',
    async (projectId: string, lit: string) => {
      store.sessions = [{ id: 's1', projectId, settings: { notebookPath: 'drawing/SKILL.md' } }]
      store.activeSessionId = 's1'
      await mount(
        makeAdapter([
          builtinFolder(),
          agentsFolder({ skills: [skill('agents:drawing', 'drawing')] }),
          defaultFolder({ skills: [skill('drawing', 'drawing')] })
        ])
      )

      expect(activeRows()).toEqual([lit])
    }
  )
})

/**
 * 两层导航（手机布局的资料库）。夹具按宿主给的顺序：内置（drawing、widget）→ 共用 claude（关着，1 个）→
 * 共用 agents（开着，空的）→ 外部 team（开着，2 个，其中一个自己关着）→ 默认目录（2 个）。
 */
describe('SkillGroup drill mode (the phone library)', () => {
  const slots: HTMLElement[] = []
  function slot(): HTMLElement {
    const node = document.createElement('div')
    node.setAttribute('data-test-slot', '')
    document.body.appendChild(node)
    slots.push(node)
    return node
  }
  afterEach(() => {
    for (const node of slots.splice(0)) node.remove()
  })

  const teamFolder = (over: Partial<SkillGroupFolder> = {}): SkillGroupFolder =>
    folder({
      dirName: 'team',
      dirPath: '/home/u/work/team-skills',
      skills: [skill('team:lint', 'lint'), skill('team:ship', 'ship', { isEnabled: false })],
      ...over
    })
  const hostOrder = (): SkillGroupFolder[] => [
    twoBuiltins(),
    claudeFolder(),
    agentsFolder({ isEnabled: true, skills: [] }),
    teamFolder(),
    defaultFolder({ skills: [skill('mine', 'mine'), skill('notes', 'notes')] })
  ]
  const TOTAL = 7
  const OWN = 5
  const GROUP_MENU = [
    'add-folder',
    'open-default',
    'toggle-default',
    'toggle-builtin',
    'separator',
    'refresh'
  ]

  const drillAt = (scope: string | null, extra: Partial<LibraryDrill> = {}): LibraryDrill => ({
    scope,
    onOpen: vi.fn(),
    ...extra
  })
  /** 渲染带 drill 的分组（不点组头）；同一条用例里再调 = 同一个实例换 props */
  async function mountDrill(adapter: Adapter, drill?: LibraryDrill): Promise<void> {
    type ProviderProps = ComponentProps<typeof ContextMenuProvider>
    const props: Omit<ProviderProps, 'children'> = {
      render: async (items: ContextMenuItem[]) => {
        menus.push(items)
        return pick !== null && items.some((it) => it.id === pick) ? pick : null
      }
    }
    act(() =>
      root.render(
        createElement(
          ContextMenuProvider,
          props as ProviderProps,
          createElement(SkillGroup, { adapter, drill })
        )
      )
    )
    await flush()
  }
  const NAV = '[data-group-nav="skills"]'
  const navCount = (): string | null =>
    container.querySelector('[data-group-count]')?.textContent ?? null
  const sectionKeys = (): Array<string | null> =>
    [...container.querySelectorAll('[data-library-section]')].map((node) =>
      node.getAttribute('data-library-section')
    )
  const sectionSel = (dirName: string): string => `[data-library-section="dir:${dirName}"]`
  const sectionLabel = (dirName: string): HTMLElement =>
    el(`${sectionSel(dirName)} [data-library-section-label]`)
  const sectionRows = (dirName: string): Array<string | null> =>
    [...el(sectionSel(dirName)).querySelectorAll('[data-library-row]')].map((node) =>
      node.getAttribute('data-skill-row')
    )
  const titleOf = (name: string): HTMLElement => el(`${rowSel(name)} [data-library-row-title]`)
  const part = (name: string, what: string): string | null =>
    el(rowSel(name)).querySelector(`[data-library-row-${what}]`)?.textContent ?? null
  const hasLock = (name: string): boolean =>
    el(rowSel(name)).querySelector('[data-library-row-lock]') !== null
  const countText = (): string | null =>
    container.querySelector('[data-library-count]')?.textContent ?? null
  const skillsLabel = (): string => i18n.t('sidebar.skillsGroup')
  function emit(type: string): void {
    act(() => {
      for (const fn of [...(appEvents.get(type) ?? [])]) fn()
    })
  }

  it('SK-1 the top level: one nav row; the count is every skill in every folder (builtin, off folders and off skills too); scanned once at mount', async () => {
    const adapter = makeAdapter(hostOrder())
    await mountDrill(adapter, drillAt(null))
    const row = el(NAV)
    expect(row.getAttribute('data-group')).toBe('skills')
    expect(row.textContent).toContain(skillsLabel())
    expect(navCount()).toBe(String(TOTAL))
    expect(adapter.list).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-skill-row]')).toBeNull()
    expect(container.querySelector('[data-library-page]')).toBeNull()
  })

  it('SK-2 a click on the nav row → onOpen("skills", the group label)', async () => {
    const drill = drillAt(null)
    const adapter = makeAdapter(hostOrder())
    await mountDrill(adapter, drill)
    await act(async () => {
      ;(el(`${NAV} button`) as HTMLButtonElement).click()
    })
    expect(drill.onOpen).toHaveBeenCalledTimes(1)
    expect(drill.onOpen).toHaveBeenCalledWith('skills', skillsLabel())
    expect(container.querySelector('[data-skill-row]')).toBeNull()
    expect(adapter.list).toHaveBeenCalledTimes(1)
  })

  it('SK-3 a long press on the nav row opens the group menu; add-folder → adapter.addFolder()', async () => {
    const adapter = makeAdapter(hostOrder())
    await mountDrill(adapter, drillAt(null))
    pick = 'add-folder'
    expect(ids(await menuOf(NAV))).toEqual(GROUP_MENU)
    expect(adapter.addFolder).toHaveBeenCalledTimes(1)
  })

  it.each<[string, () => SkillGroupFolder[]]>([
    ['the host order', hostOrder],
    ['the reverse order', () => [...hostOrder()].reverse()]
  ])(
    'SK-4 section order with %s: Mine → shared / external folders → Built-in',
    async (_l, list) => {
      await mountDrill(makeAdapter(list()), drillAt('skills'))
      expect(el('[data-library-page]').getAttribute('data-library-page')).toBe('skills')
      const keys = sectionKeys()
      expect(keys[0]).toBe('dir:default')
      expect(keys.at(-1)).toBe('dir:builtin')
      expect([...keys.slice(1, -1)].sort()).toEqual(['dir:agents', 'dir:claude', 'dir:team'])
      expect(keys).toHaveLength(5)
    }
  )

  it('SK-4 the folders in between keep the host’s order', async () => {
    await mountDrill(makeAdapter(hostOrder()), drillAt('skills'))
    expect(sectionKeys()).toEqual([
      'dir:default',
      'dir:claude',
      'dir:agents',
      'dir:team',
      'dir:builtin'
    ])
    expect(sectionRows('default')).toEqual(['mine', 'notes'])
    expect(sectionRows('team')).toEqual(['team:lint', 'team:ship'])
    expect(sectionRows('builtin')).toEqual(['builtin:drawing', 'builtin:widget'])
  })

  it('SK-5 section labels: Mine / the folder’s label or dirName / Built-in; only shared and external labels carry data-skill-folder', async () => {
    await mountDrill(makeAdapter(hostOrder()), drillAt('skills'))
    expect(sectionLabel('default').textContent).toBe(i18n.t('mobile.libraryMine'))
    expect(sectionLabel('claude').textContent).toBe('~/.claude/skills')
    expect(sectionLabel('agents').textContent).toBe('~/.agents/skills')
    expect(sectionLabel('team').textContent).toBe('team')
    expect(sectionLabel('builtin').textContent).toBe(i18n.t('mobile.libraryBuiltin'))

    expect(sectionLabel('claude').getAttribute('data-skill-folder')).toBe('claude')
    expect(sectionLabel('agents').getAttribute('data-skill-folder')).toBe('agents')
    expect(sectionLabel('team').getAttribute('data-skill-folder')).toBe('team')
    expect(sectionLabel('default').hasAttribute('data-skill-folder')).toBe(false)
    expect(sectionLabel('builtin').hasAttribute('data-skill-folder')).toBe(false)
  })

  it('SK-6 an empty shared / external folder is drawn with a sentence; an empty default or builtin folder is not drawn', async () => {
    await mountDrill(makeAdapter(hostOrder()), drillAt('skills'))
    const agents = el(sectionSel('agents'))
    expect(agents.textContent).toContain(i18n.t('settings.skillEmpty'))
    expect(agents.querySelector('[data-library-row]')).toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    await mountDrill(
      makeAdapter([builtinFolder({ skills: [] }), teamFolder(), defaultFolder({ skills: [] })]),
      drillAt('skills')
    )
    expect(sectionKeys()).toEqual(['dir:team'])
  })

  it.each<[string, SkillGroupFolder[]]>([
    ['no folders at all', []],
    [
      'only an empty default and an empty builtin folder',
      [builtinFolder({ skills: [] }), defaultFolder({ skills: [] })]
    ]
  ])('SK-7 nothing to draw (%s) → the page’s empty sentence', async (_l, folders) => {
    await mountDrill(makeAdapter(folders), drillAt('skills'))
    expect(sectionKeys()).toEqual([])
    expect(container.querySelector('[data-library-empty]')?.textContent).toBe(
      i18n.t('settings.skillEmpty')
    )
  })

  it('SK-8 a long press on a folder label: shared = toggle + open, external adds remove; the actions reach the adapter with the folder', async () => {
    const folders = hostOrder()
    const adapter = makeAdapter(folders)
    await mountDrill(adapter, drillAt('skills'))
    const labelSel = (dirName: string): string =>
      `${sectionSel(dirName)} [data-library-section-label]`

    pick = 'toggle'
    expect(ids(await menuOf(labelSel('claude')))).toEqual(['toggle', 'open'])
    expect(adapter.setFolderEnabled.mock.calls).toEqual([[folders[1], true]])

    pick = 'remove'
    expect(ids(await menuOf(labelSel('team')))).toEqual(['toggle', 'open', 'separator', 'remove'])
    expect(adapter.removeFolder.mock.calls).toEqual([[folders[3]]])

    // 共用目录没有「移除」：点不出来
    await menuOf(labelSel('agents'))
    expect(adapter.removeFolder).toHaveBeenCalledTimes(1)

    // 「我的」与「内置」的小标题没有菜单
    const before = menus.length
    await act(async () => {
      sectionLabel('default').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      )
      sectionLabel('builtin').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      )
    })
    await flush()
    expect(menus.length).toBe(before)
  })

  it('SK-9 an off folder: a struck label with data-skill-off; its skill row is off although the skill itself is enabled', async () => {
    await mountDrill(makeAdapter(hostOrder()), drillAt('skills'))
    const label = sectionLabel('claude')
    expect(label.className).toContain('line-through')
    expect(label.hasAttribute('data-skill-off')).toBe(true)
    expect(sectionLabel('team').className).not.toContain('line-through')
    expect(sectionLabel('team').hasAttribute('data-skill-off')).toBe(false)

    const row = el(rowSel('claude:pdf'))
    expect(row.hasAttribute('data-skill-off')).toBe(true)
    expect(titleOf('claude:pdf').className).toContain('line-through')
    expect(row.className).toContain('opacity-50')
    expect(part('claude:pdf', 'badge')).toBe(i18n.t('sidebar.disabledBadge'))
  })

  it('SK-10 one off skill in an on folder: only that row is off', async () => {
    await mountDrill(makeAdapter(hostOrder()), drillAt('skills'))
    const off = el(rowSel('team:ship'))
    expect(off.hasAttribute('data-skill-off')).toBe(true)
    expect(part('team:ship', 'badge')).toBe(i18n.t('sidebar.disabledBadge'))
    expect(titleOf('team:ship').className).toContain('line-through')

    const on = el(rowSel('team:lint'))
    expect(on.hasAttribute('data-skill-off')).toBe(false)
    expect(part('team:lint', 'badge')).toBeNull()
    expect(on.className).not.toContain('opacity-50')
    expect(titleOf('team:lint').className).not.toContain('line-through')
    expect(offRows()).toEqual(['claude:pdf', 'team:ship'])
  })

  it('SK-11 builtin rows: a lock, the localized name, the identifier only when it differs by more than case, the interface hint', async () => {
    await mountDrill(
      makeAdapter([
        builtinFolder({
          skills: [
            skill('builtin:drawing', 'drawing'),
            skill('builtin:widget', 'widget'),
            skill('builtin:zzz', 'zzz')
          ]
        })
      ]),
      drillAt('skills')
    )
    expect(hasLock('builtin:drawing')).toBe(true)
    expect(titleOf('builtin:drawing').textContent).toBe(en.builtinSkill.drawing.label)
    expect(part('builtin:drawing', 'identifier')).toBeNull()
    expect(part('builtin:drawing', 'description')).toBe(en.builtinSkill.drawing.hint)

    expect(hasLock('builtin:widget')).toBe(true)
    expect(titleOf('builtin:widget').textContent).toBe(en.builtinSkill.widget.label)
    expect(part('builtin:widget', 'identifier')).toBe('widget')
    expect(part('builtin:widget', 'description')).toBe(en.builtinSkill.widget.hint)

    // 没有界面文案的内置：原名、没有标识名、说明退回 description
    expect(hasLock('builtin:zzz')).toBe(true)
    expect(titleOf('builtin:zzz').textContent).toBe('zzz')
    expect(part('builtin:zzz', 'identifier')).toBeNull()
    expect(part('builtin:zzz', 'description')).toBe('builtin:zzz description')
  })

  it('SK-12 rows outside the builtin folder: no lock, the display name, the skill’s own description; a default skill named drawing gets no localized copy', async () => {
    await mountDrill(
      makeAdapter([
        twoBuiltins(),
        teamFolder(),
        defaultFolder({ skills: [skill('drawing', 'drawing')] })
      ]),
      drillAt('skills')
    )
    expect(hasLock('team:lint')).toBe(false)
    expect(titleOf('team:lint').textContent).toBe('lint')
    expect(part('team:lint', 'description')).toBe('team:lint description')
    expect(part('team:lint', 'identifier')).toBeNull()

    expect(hasLock('drawing')).toBe(false)
    expect(titleOf('drawing').textContent).toBe('drawing')
    expect(part('drawing', 'description')).toBe('drawing description')
    expect(part('drawing', 'identifier')).toBeNull()
  })

  it('SK-13 a tap → adapter.open with that skill object, once', async () => {
    const folders = hostOrder()
    const adapter = makeAdapter(folders)
    await mountDrill(adapter, drillAt('skills'))
    await act(async () => {
      el(rowSel('team:lint')).click()
    })
    expect(adapter.open).toHaveBeenCalledTimes(1)
    expect(adapter.open.mock.calls[0][0]).toBe(folders[3].skills[0])

    await act(async () => {
      el(rowSel('builtin:widget')).click()
    })
    expect(adapter.open).toHaveBeenCalledTimes(2)
    expect(adapter.open.mock.calls[1][0]).toBe(folders[0].skills[1])
  })

  it('SK-14 a long press on a row: default folder = toggle + delete, every other folder = toggle only', async () => {
    const folders = hostOrder()
    const adapter = makeAdapter(folders)
    await mountDrill(adapter, drillAt('skills'))

    pick = 'delete'
    expect(ids(await menuOf(rowSel('mine')))).toEqual(['toggle', 'separator', 'delete'])
    expect(adapter.deleteSkill.mock.calls).toEqual([[folders[4].skills[0]]])

    // 别的目录点不出删除
    expect(ids(await menuOf(rowSel('claude:pdf')))).toEqual(['toggle'])
    expect(ids(await menuOf(rowSel('team:lint')))).toEqual(['toggle'])
    expect(ids(await menuOf(rowSel('builtin:drawing')))).toEqual(['toggle'])
    expect(adapter.deleteSkill).toHaveBeenCalledTimes(1)

    pick = 'toggle'
    const onItems = await menuOf(rowSel('team:lint'))
    expect(labelOf(onItems, 'toggle')).toBe(en.common.disable)
    expect(adapter.setSkillEnabled.mock.calls).toEqual([[folders[3].skills[0], false]])
    const offItems = await menuOf(rowSel('team:ship'))
    expect(labelOf(offItems, 'toggle')).toBe(en.common.enable)
    expect(adapter.setSkillEnabled.mock.calls[1]).toEqual([folders[3].skills[1], true])
  })

  it('SK-15 the toolbar: all skills, then how many are outside the builtin folder; no new button', async () => {
    await mountDrill(makeAdapter(hostOrder()), drillAt('skills'))
    expect(countText()).toBe(
      `${i18n.t('mobile.libraryCount', { count: TOTAL, name: skillsLabel() })} · ${i18n.t(
        'mobile.libraryOwn',
        { count: OWN }
      )}`
    )
    expect(container.querySelector('[data-library-new]')).toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    await mountDrill(makeAdapter([twoBuiltins(), defaultFolder({ skills: [] })]), drillAt('skills'))
    expect(countText()).toBe(i18n.t('mobile.libraryCount', { count: 2, name: skillsLabel() }))
    expect(container.querySelector('[data-library-new]')).toBeNull()
  })

  it('SK-16 the menu button in menuSlot opens the group menu', async () => {
    const menuSlot = slot()
    const adapter = makeAdapter(hostOrder())
    await mountDrill(adapter, drillAt('skills', { menuSlot }))
    const button = menuSlot.querySelector('[data-library-menu]') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    expect(container.querySelector('[data-library-menu]')).toBeNull()
    expect(button!.getAttribute('aria-label')).toBe(i18n.t('sidebar.moreActions'))
    const before = menus.length
    await act(async () => {
      button!.click()
    })
    await flush()
    expect(menus.length).toBe(before + 1)
    expect(ids(menus.at(-1)!)).toEqual(GROUP_MENU)
  })

  it('SK-17 the default or the builtin folder switched off: its Mine / Built-in label is struck', async () => {
    await mountDrill(
      makeAdapter([twoBuiltins({ isEnabled: false }), defaultFolder({ isEnabled: false })]),
      drillAt('skills')
    )
    expect(sectionLabel('default').className).toContain('line-through')
    expect(sectionLabel('builtin').className).toContain('line-through')
    expect(offRows()).toEqual(['mine', 'builtin:drawing', 'builtin:widget'])

    act(() => root.unmount())
    root = createRoot(container)
    await mountDrill(makeAdapter([twoBuiltins(), defaultFolder()]), drillAt('skills'))
    expect(sectionLabel('default').className).not.toContain('line-through')
    expect(sectionLabel('builtin').className).not.toContain('line-through')
  })

  it.each(['agents', 'knowledge', 'knowledge:knowledge/notes'])(
    'SK-18 another page open (%s): nothing is drawn, yet it scanned once; skill.changed rescans',
    async (scope) => {
      const adapter = makeAdapter(hostOrder())
      await mountDrill(adapter, drillAt(scope))
      expect(container.children).toHaveLength(0)
      expect(adapter.list).toHaveBeenCalledTimes(1)

      emit('skill.changed')
      await flush()
      expect(adapter.list).toHaveBeenCalledTimes(2)

      // 轮到自己：直接有行，不再扫
      await mountDrill(adapter, drillAt('skills'))
      expect(sectionKeys()).toHaveLength(5)
      expect(adapter.list).toHaveBeenCalledTimes(2)
    }
  )

  it('SK-18 skill.changed at the top level rescans and the count follows', async () => {
    const adapter = makeAdapter(hostOrder())
    await mountDrill(adapter, drillAt(null))
    expect(navCount()).toBe(String(TOTAL))
    adapter.list.mockResolvedValue([twoBuiltins()])
    emit('skill.changed')
    await flush()
    expect(adapter.list).toHaveBeenCalledTimes(2)
    expect(navCount()).toBe('2')
  })

  it('SK-19 without drill: nothing is scanned at mount and the header is not a nav row', async () => {
    const adapter = makeAdapter(hostOrder())
    await mountDrill(adapter)
    expect(adapter.list).not.toHaveBeenCalled()
    expect(el(GROUP).hasAttribute('data-group-nav')).toBe(false)
    expect(container.querySelector('[data-group-count]')).toBeNull()
    expect(container.querySelector('[data-library-page]')).toBeNull()

    // 事件在展开之前不触发扫描（桌面：展开才扫）
    emit('skill.changed')
    await flush()
    expect(adapter.list).not.toHaveBeenCalled()
  })
})
