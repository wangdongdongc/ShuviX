// @vitest-environment jsdom
/**
 * SkillGroup 的共用目录（jsdom）—— `~/.claude/skills` / `~/.agents/skills` 由宿主固定列出（`isShared`）：
 *
 *   SKG-1 行上的字：共用目录显示宿主给的 `label`（路径写法），外部目录没给 label 就显示 dirName，
 *         内置那行永远是本地化的「内置」（哪怕宿主给了 label）；title 是 dirPath；锁只给内置；
 *   SKG-2 目录菜单：共用 = 开关 + 打开（没有移除，同内置）；外部 = 开关、打开、分隔线、移除；
 *         在关着的共用目录上点开关 → setFolderEnabled(folder, true)，removeFolder 从不被调；
 *   SKG-3 关着的共用目录：文件夹行与组内每一行都带 data-skill-off，开关项写 Enable；
 *   SKG-4 共用目录里技能行的菜单只有开关（删除只对默认目录开放）；
 *   SKG-5 当前笔记高亮：共用目录的载体 id 是 `__skills:<dirName>__` —— agents:pdf 亮，同一个 dirEntry 的
 *         claude:pdf 不亮。
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
const defaultFolder = (): SkillGroupFolder =>
  folder({
    dirName: 'default',
    dirPath: '/home/u/.shuvix/skills',
    isDefault: true,
    skills: [skill('mine', 'mine')]
  })

function makeAdapter(folders: SkillGroupFolder[]): Adapter {
  return {
    list: vi.fn(async () => folders),
    open: vi.fn(),
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
  it('SKG-1 行上的字：共用目录 = label，外部（无 label）= dirName，内置 = 本地化的「内置」（哪怕给了 label）；title = dirPath；锁只给内置', async () => {
    await mount(
      makeAdapter([
        builtinFolder({ label: '/should/not/show' }),
        claudeFolder(),
        agentsFolder(),
        extFolder(),
        defaultFolder()
      ])
    )

    expect(
      [...container.querySelectorAll('[data-skill-folder]')].map((f) =>
        f.getAttribute('data-skill-folder')
      )
    ).toEqual(['builtin', 'claude', 'agents', 'my-ext'])

    expect(folderLabel('builtin')).toBe(en.settings.skillDirBuiltin)
    expect(folderLabel('claude')).toBe('~/.claude/skills')
    expect(folderLabel('agents')).toBe('~/.agents/skills')
    expect(folderLabel('my-ext')).toBe('my-ext')

    expect(el(folderSel('builtin')).title).toBe('/app/Resources/skills/en')
    expect(el(folderSel('claude')).title).toBe('/home/u/.claude/skills')
    expect(el(folderSel('agents')).title).toBe('/home/u/.agents/skills')
    expect(el(folderSel('my-ext')).title).toBe('/home/u/work/skills')

    // 锁 = 只读；共用目录是用户自己的文件（可编辑），不挂锁
    expect(isLocked('builtin')).toBe(true)
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
  it('SKG-2 目录菜单：共用 / 内置 = [toggle, open]，外部 = [toggle, open, separator, remove]；在关着的共用目录上点开关 → setFolderEnabled(folder, true)', async () => {
    const adapter = makeAdapter([builtinFolder(), claudeFolder(), agentsFolder(), extFolder()])
    await mount(adapter)

    expect(ids(await menuOf(folderSel('claude')))).toEqual(['toggle', 'open'])
    expect(ids(await menuOf(folderSel('agents')))).toEqual(['toggle', 'open'])
    expect(ids(await menuOf(folderSel('builtin')))).toEqual(['toggle', 'open'])
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
