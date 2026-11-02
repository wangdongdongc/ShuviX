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
 * 右键菜单走 ContextMenuProvider 的 `render` 注入：记录菜单项、按预设回一个 id（模拟用户点了它）——
 * 预设的 id 不在这份菜单里就回 null（真菜单点不出一个它没有的项）。`@shuvix/chat-ui` 替掉
 * useAppEvent / useChatStore / useChatHost；chatStore 的状态放在可变的 `store` 里（SKG-5 换活动会话）。
 * 文件是 `.ts`，一律 createElement。
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

vi.mock('@shuvix/chat-ui', () => ({
  useAppEvent: () => {},
  useChatStore: (selector: (s: typeof store) => unknown) => selector(store),
  useChatHost: () => ({ appearance: { focusMode: false } })
}))

import {
  SkillGroup,
  type SkillGroupAdapter,
  type SkillGroupFolder,
  type SkillGroupItem
} from './SkillGroup'
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
