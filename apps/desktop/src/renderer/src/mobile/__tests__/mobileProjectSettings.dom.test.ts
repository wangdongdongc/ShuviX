// @vitest-environment jsdom
/**
 * 手机布局的项目设置（mobile/MobileProjectSettings.tsx，jsdom）。
 *
 * 契约：首页是分组卡片 —— 名称（就地改：失焦或回车存，去掉首尾空白；空的 / 没变的不存并退回；输入法组字中的回车
 * 不算；那一格还聚焦着就走了也存）与文件夹（只显示路径）；项目提示词（推入一页，行尾写着填没填）；「新会话的
 * 默认值」下面是扩展能力（数 = 勾着的、还在的 MCP）与知识库（数 = 选着的、还在的库；没存过跟着宿主的缺省），各推入
 * 一页，没有可选的就没有那一行；归档项目（先确认；存上了才收起）。没有「保存」：改了就存 —— 提示词停笔 600ms 或
 * 离开那一页 / 失焦 / 卸载时存一次；扩展能力与知识库每动一下存一次整份清单；知识库没动过就不写。环境变量不在这里。
 * 哪一页由外面管（`page` / `onOpenPage` / `onBack` / `onClosed`）。项目不在了 → `onClosed()`；工具清单或知识库
 * 清单取不到只是少那两行。
 *
 *   MP-1..13  首页：框架、加载、改名、各行与行尾的数、归档、环境变量
 *   MP-14..18 提示词那一页的存法
 *   MP-19..23 扩展能力 / 知识库两页
 *
 * `window.api` 的四个调用是替身；`@shuvix/chat-ui` 只留真的 `isImeComposing`；`@shuvix/app-shell` 的
 * ExtensionsSection 是记 props 的替身，ConfirmDialog 是两颗按钮；MobilePage 是真的。真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

type Props = Record<string, unknown>
interface ToolRow {
  name: string
  group?: string
}
interface KbOptions {
  options: Array<{ name: string; label: string }>
  selected: string[]
}

const rec = vi.hoisted(() => ({
  sections: [] as Array<Record<string, unknown>>,
  sectionMounts: 0
}))

vi.mock('@shuvix/chat-ui', async () => {
  const ime = await import('../../../../../../../packages/chat-ui/src/utils/ime')
  return { isImeComposing: ime.isImeComposing }
})

vi.mock('@shuvix/app-shell', async () => {
  const { createElement: h, useState } = await import('react')
  return {
    ExtensionsSection: (props: Props) => {
      useState(() => ++rec.sectionMounts)
      rec.sections.push(props)
      return h('div', { 'data-stub-extensions': String(props.only) })
    },
    ConfirmDialog: ({ title, description, confirmText, onConfirm, onCancel }: Props) =>
      h(
        'div',
        { 'data-stub-confirm': '' },
        h('h3', null, title as never),
        h('p', null, description as never),
        h(
          'button',
          { type: 'button', 'data-stub-confirm-ok': '', onClick: onConfirm as () => void },
          confirmText as never
        ),
        h('button', {
          type: 'button',
          'data-stub-confirm-cancel': '',
          onClick: onCancel as () => void
        })
      )
  }
})

import { MobileProjectSettings, type MobileProjectSettingsProps } from '../MobileProjectSettings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const M = en.mobile
const F = en.projectForm

const getById = vi.fn<(id: string) => Promise<Record<string, unknown> | null>>()
const update = vi.fn<(patch: Record<string, unknown>) => Promise<unknown>>()
const toolsList = vi.fn<() => Promise<ToolRow[]>>()
const baseOptions = vi.fn<() => Promise<KbOptions>>()
const onOpenPage = vi.fn<(page: string) => void>()
const onBack = vi.fn<() => void>()
const onClosed = vi.fn<() => void>()
/** 这个文件里所有用例存过的东西（MP-13 最后一起看） */
const allUpdates: Array<Record<string, unknown>> = []

let container: HTMLDivElement
let root: Root
let mounted = false

const project = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'p1',
  name: 'Alpha',
  path: '/w/alpha',
  systemPrompt: '',
  settings: {},
  ...over
})
const TOOLS: ToolRow[] = [
  { name: 'mcp:a', group: 'mcp:a' },
  { name: 'mcp:b', group: 'mcp:b' },
  { name: 'read', group: 'builtin' }
]
const KB: KbOptions = {
  options: [
    { name: 'notes', label: 'Notes' },
    { name: 'cook', label: 'Cooking' }
  ],
  selected: ['notes']
}

function render(over: Partial<MobileProjectSettingsProps> = {}): void {
  act(() =>
    root.render(
      createElement(MobileProjectSettings, {
        projectId: 'p1',
        page: 'index',
        backLabel: 'Chats',
        onOpenPage,
        onBack,
        onClosed,
        ...over
      })
    )
  )
  mounted = true
}
const flush = (): Promise<void> => act(async () => {})
/** 挂上并等三样都取到 */
async function open(over: Partial<MobileProjectSettingsProps> = {}): Promise<void> {
  render(over)
  await flush()
}
function unmount(): void {
  if (!mounted) return
  act(() => root.unmount())
  mounted = false
}
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const text = (sel: string): string | null => q(sel)?.textContent ?? null
function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const kind = (): string | null =>
  q('[data-mobile-panel]')?.getAttribute('data-mobile-panel') ?? null
const nameInput = (): HTMLInputElement =>
  container.querySelector<HTMLInputElement>('[data-mobile-project-name]')!
const promptBox = (): HTMLTextAreaElement =>
  container.querySelector<HTMLTextAreaElement>('[data-mobile-project-prompt]')!
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function blur(el: HTMLElement): void {
  act(() => {
    el.focus()
    el.blur()
  })
}
function keyDown(el: HTMLElement, init: KeyboardEventInit): void {
  act(() => {
    el.focus()
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}
const navRow = (id: string): HTMLElement | null => q(`[data-mobile-project-row="${id}"]`)
const rowValue = (id: string): string | null =>
  navRow(id)?.querySelector('[data-mobile-project-value]')?.textContent ?? null
const lastSection = (): Record<string, unknown> => rec.sections.at(-1)!
const knowledgeOf = (
  section: Record<string, unknown>
): { options: unknown; selected: string[]; onToggle: (name: string) => void; hint: string } =>
  section.knowledge as never

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  window.history.replaceState(null, '')
  rec.sections.length = 0
  rec.sectionMounts = 0
  getById.mockReset().mockResolvedValue(project())
  update.mockReset().mockResolvedValue(undefined)
  toolsList.mockReset().mockResolvedValue(TOOLS)
  baseOptions.mockReset().mockResolvedValue(KB)
  onOpenPage.mockReset()
  onBack.mockReset()
  onClosed.mockReset()
  ;(window as unknown as { api: unknown }).api = {
    project: { getById, update },
    tools: { list: toolsList },
    knowledge: { baseOptions }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = false
})

afterEach(() => {
  unmount()
  allUpdates.push(...update.mock.calls.map((call) => call[0]))
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('MobileProjectSettings: the index', () => {
  it('MP-1 loads the project, the tools and the knowledge options once, then draws the cards', async () => {
    render()
    expect(kind()).toBe('project-index')
    expect(q('[data-mobile-project-name]')).toBeNull()
    await flush()
    expect(getById).toHaveBeenCalledTimes(1)
    expect(getById).toHaveBeenCalledWith('p1')
    expect(toolsList).toHaveBeenCalledTimes(1)
    expect(baseOptions).toHaveBeenCalledTimes(1)
    expect(kind()).toBe('project-index')
    expect(text('[data-mobile-panel-title]')).toBe(F.editTitle)
    expect(text('[data-mobile-panel-back]')).toBe('Chats')
    expect(nameInput().value).toBe('Alpha')
    const path = q('[data-mobile-project-path]')!
    expect(path.textContent).toBe('/w/alpha')
    expect(path.tagName).toBe('SPAN')
    expect(container.querySelectorAll('input')).toHaveLength(1)
    expect(text('[data-mobile-project-archive]')).toBe(F.archiveProject)
    expect(update).not.toHaveBeenCalled()
    expect(onClosed).not.toHaveBeenCalled()
    click(q('[data-mobile-panel-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('MP-1 re-rendering with another page does not load again', async () => {
    await open()
    render({ page: 'prompt' })
    render({ page: 'index' })
    await flush()
    expect(getById).toHaveBeenCalledTimes(1)
    expect(toolsList).toHaveBeenCalledTimes(1)
    expect(baseOptions).toHaveBeenCalledTimes(1)
  })

  it('MP-2 a project that is gone closes the page', async () => {
    getById.mockResolvedValue(null)
    await open()
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(q('[data-mobile-project-name]')).toBeNull()
    expect(q('[data-mobile-project-archive]')).toBeNull()
  })

  it('MP-3 the project cannot be read: an empty page that can still go back', async () => {
    getById.mockRejectedValue(new Error('offline'))
    await open()
    expect(kind()).toBe('project-index')
    expect(q('[data-mobile-project-name]')).toBeNull()
    expect(onClosed).not.toHaveBeenCalled()
    click(q('[data-mobile-panel-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('MP-3 the tools list cannot be read: the project still loads, without the extensions row', async () => {
    toolsList.mockRejectedValue(new Error('offline'))
    await open()
    expect(nameInput().value).toBe('Alpha')
    expect(navRow('prompt')).not.toBeNull()
    expect(navRow('extensions')).toBeNull()
    expect(navRow('knowledge')).not.toBeNull()
    expect(q('[data-mobile-project-archive]')).not.toBeNull()
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('MP-3 the knowledge options cannot be read: the project still loads, without the knowledge row', async () => {
    baseOptions.mockRejectedValue(new Error('offline'))
    await open()
    expect(nameInput().value).toBe('Alpha')
    expect(navRow('extensions')).not.toBeNull()
    expect(navRow('knowledge')).toBeNull()
  })

  it('MP-3 neither can be read: name, prompt and archive are still there', async () => {
    toolsList.mockRejectedValue(new Error('offline'))
    baseOptions.mockRejectedValue(new Error('offline'))
    await open()
    expect(nameInput().value).toBe('Alpha')
    expect(navRow('prompt')).not.toBeNull()
    expect(container.textContent).not.toContain(M.projectDefaults)
    expect(q('[data-mobile-project-archive]')).not.toBeNull()
  })

  it.each([
    ['Beta', 'Beta'],
    ['  Beta ', 'Beta']
  ])('MP-4 a name typed as %j is saved trimmed, once, on blur', async (typed, saved) => {
    await open()
    type(nameInput(), typed)
    expect(update).not.toHaveBeenCalled()
    blur(nameInput())
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ id: 'p1', name: saved })
    expect(nameInput().value).toBe(saved)
    // 再失焦一次：已经是这个名字，不再存
    blur(nameInput())
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('MP-4 Enter saves through blur', async () => {
    await open()
    type(nameInput(), 'Beta')
    keyDown(nameInput(), { key: 'Enter' })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ id: 'p1', name: 'Beta' })
    expect(document.activeElement).not.toBe(nameInput())
  })

  it('MP-4 another key does not save', async () => {
    await open()
    type(nameInput(), 'Beta')
    keyDown(nameInput(), { key: 'a' })
    expect(update).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(nameInput())
  })

  it.each([[''], ['   '], ['Alpha'], ['Alpha ']])(
    'MP-5 a name typed as %j is not saved and the field goes back',
    async (typed) => {
      await open()
      type(nameInput(), typed)
      blur(nameInput())
      expect(update).not.toHaveBeenCalled()
      expect(nameInput().value).toBe('Alpha')
    }
  )

  it.each<[string, KeyboardEventInit]>([
    ['isComposing', { key: 'Enter', isComposing: true }],
    ['keyCode 229', { key: 'Enter', keyCode: 229 }]
  ])('MP-6 Enter while the IME is composing (%s) does nothing', async (_label, init) => {
    await open()
    type(nameInput(), 'Beta')
    keyDown(nameInput(), init)
    expect(update).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(nameInput())
    expect(nameInput().value).toBe('Beta')
  })

  it('MP-4 leaving with the name field still focused saves the typed name once', async () => {
    await open()
    type(nameInput(), ' Beta ')
    unmount()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ id: 'p1', name: 'Beta' })
  })

  it.each([['Alpha'], ['Alpha  '], [''], ['   ']])(
    'MP-5 leaving with the field holding %j saves nothing',
    async (typed) => {
      await open()
      type(nameInput(), typed)
      unmount()
      expect(update).not.toHaveBeenCalled()
    }
  )

  it('MP-4 a name saved on blur is not saved again when the page goes away', async () => {
    await open()
    type(nameInput(), 'Beta')
    blur(nameInput())
    unmount()
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('MP-5 leaving before the project loaded saves nothing', () => {
    render()
    unmount()
    expect(update).not.toHaveBeenCalled()
  })

  it.each<[string, string]>([
    ['', M.projectPromptUnset],
    ['  \n ', M.projectPromptUnset],
    ['x', M.projectPromptSet]
  ])('MP-7 a prompt of %j reads %s', async (systemPrompt, expected) => {
    getById.mockResolvedValue(project({ systemPrompt }))
    await open()
    expect(navRow('prompt')!.textContent).toContain(F.systemPrompt)
    expect(rowValue('prompt')).toBe(expected)
  })

  it('MP-7 a project without a prompt field reads as not set', async () => {
    getById.mockResolvedValue(project({ systemPrompt: undefined }))
    await open()
    expect(rowValue('prompt')).toBe(M.projectPromptUnset)
  })

  it.each(['prompt', 'extensions', 'knowledge'])(
    'MP-7 a tap on the %s row opens its page',
    async (id) => {
      await open()
      click(navRow(id)!)
      expect(onOpenPage).toHaveBeenCalledTimes(1)
      expect(onOpenPage).toHaveBeenCalledWith(id)
      expect(update).not.toHaveBeenCalled()
    }
  )

  it.each<[string, Record<string, unknown>, string | null]>([
    ['never saved', {}, null],
    ['saved empty', { enabledTools: [] }, null],
    [
      'one listed server on; unlisted, opt-out and builtin entries not counted',
      { enabledTools: ['mcp:a', 'mcp:gone', '-mcp:b', 'read'] },
      '1'
    ],
    ['both on', { enabledTools: ['mcp:b', 'mcp:a'] }, '2']
  ])('MP-8 the extensions row, %s', async (_label, settings, expected) => {
    getById.mockResolvedValue(project({ settings }))
    await open()
    expect(navRow('extensions')!.textContent).toContain(en.sessionConfig.extensionsGroup)
    expect(rowValue('extensions')).toBe(expected)
  })

  it.each<[string, Record<string, unknown>, KbOptions, string | null]>([
    ['never saved: the default that still exists', {}, KB, '1'],
    [
      'never saved: a default that is gone',
      {},
      { ...KB, selected: ['gone', 'notes', 'cook'] },
      '2'
    ],
    ['saved, one of them gone', { knowledgeBases: ['cook', 'gone'] }, KB, '1'],
    ['saved empty', { knowledgeBases: [] }, KB, null]
  ])('MP-9 the knowledge row, %s', async (_label, settings, kb, expected) => {
    getById.mockResolvedValue(project({ settings }))
    baseOptions.mockResolvedValue(kb)
    await open()
    expect(navRow('knowledge')!.textContent).toContain(en.sessionConfig.knowledgeGroup)
    expect(rowValue('knowledge')).toBe(expected)
  })

  it('MP-10 no MCP server: no extensions row', async () => {
    toolsList.mockResolvedValue([{ name: 'read', group: 'builtin' }, { name: 'bash' }])
    await open()
    expect(navRow('extensions')).toBeNull()
    expect(navRow('knowledge')).not.toBeNull()
    expect(container.textContent).toContain(M.projectDefaults)
  })

  it('MP-10 no knowledge base to pick: no knowledge row', async () => {
    baseOptions.mockResolvedValue({ options: [], selected: [] })
    await open()
    expect(navRow('knowledge')).toBeNull()
    expect(navRow('extensions')).not.toBeNull()
  })

  it('MP-10 neither: the whole defaults section is absent, label included', async () => {
    toolsList.mockResolvedValue([])
    baseOptions.mockResolvedValue({ options: [], selected: [] })
    await open()
    expect(navRow('extensions')).toBeNull()
    expect(navRow('knowledge')).toBeNull()
    expect(container.textContent).not.toContain(M.projectDefaults)
    expect(container.querySelector('section')).toBeNull()
    expect(navRow('prompt')).not.toBeNull()
  })

  it('MP-11 Archive asks first; cancelling saves nothing', async () => {
    await open()
    expect(q('[data-stub-confirm]')).toBeNull()
    click(q('[data-mobile-project-archive]')!)
    const dialog = q('[data-stub-confirm]')!
    expect(dialog.querySelector('h3')!.textContent).toBe(F.archiveConfirmTitle)
    expect(dialog.querySelector('p')!.textContent).toBe(F.archiveConfirmDesc)
    expect(text('[data-stub-confirm-ok]')).toBe(F.archiveConfirmAction)
    expect(update).not.toHaveBeenCalled()
    click(q('[data-stub-confirm-cancel]')!)
    expect(q('[data-stub-confirm]')).toBeNull()
    expect(update).not.toHaveBeenCalled()
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('MP-11 confirming archives the project, then closes the page once the save settled', async () => {
    let settle!: () => void
    update.mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve
      })
    )
    await open()
    click(q('[data-mobile-project-archive]')!)
    click(q('[data-stub-confirm-ok]')!)
    expect(q('[data-stub-confirm]')).toBeNull()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ id: 'p1', archived: true })
    await flush()
    expect(onClosed).not.toHaveBeenCalled()
    settle()
    await flush()
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('MP-12 an archive that could not be saved leaves the page open', async () => {
    update.mockRejectedValue(new Error('offline'))
    await open()
    click(q('[data-mobile-project-archive]')!)
    expect(() => click(q('[data-stub-confirm-ok]')!)).not.toThrow()
    await flush()
    expect(update).toHaveBeenCalledTimes(1)
    expect(onClosed).not.toHaveBeenCalled()
    expect(kind()).toBe('project-index')
    expect(q('[data-mobile-project-archive]')).not.toBeNull()
  })

  it('MP-12 a name that could not be saved does not throw', async () => {
    update.mockRejectedValue(new Error('offline'))
    await open()
    type(nameInput(), 'Beta')
    expect(() => blur(nameInput())).not.toThrow()
    await flush()
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('MP-13 there is no place for environment variables', async () => {
    getById.mockResolvedValue(project({ settings: { env: { TOKEN: 'x' } } }))
    await open()
    expect(container.textContent).not.toContain('TOKEN')
    expect(container.querySelectorAll('[data-mobile-project-row]')).toHaveLength(3)
    expect(container.querySelectorAll('input, textarea')).toHaveLength(1)
  })
})

describe('MobileProjectSettings: the prompt page', () => {
  const openPrompt = async (systemPrompt = ''): Promise<void> => {
    getById.mockResolvedValue(project({ systemPrompt }))
    await open({ page: 'prompt' })
  }

  it('MP-14 the frame of the prompt page', async () => {
    await openPrompt('old')
    expect(kind()).toBe('project-prompt')
    expect(text('[data-mobile-panel-title]')).toBe(F.systemPrompt)
    expect(text('[data-mobile-panel-back]')).toBe(F.editTitle)
    expect(promptBox().value).toBe('old')
    expect(promptBox().getAttribute('placeholder')).toBe(F.systemPromptPlaceholder)
    expect(container.textContent).toContain(M.projectPromptHint)
    click(q('[data-mobile-panel-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('MP-14 typing saves once, 600 ms after the last key', async () => {
    await openPrompt()
    type(promptBox(), 'a')
    advance(100)
    type(promptBox(), 'ab')
    advance(100)
    type(promptBox(), 'abc')
    advance(599)
    expect(update).not.toHaveBeenCalled()
    advance(1)
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ id: 'p1', systemPrompt: 'abc' })
    advance(5000)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('MP-14 a second burst of typing is a second save', async () => {
    await openPrompt()
    type(promptBox(), 'a')
    advance(600)
    type(promptBox(), 'ab')
    advance(600)
    expect(update.mock.calls.map((call) => call[0])).toEqual([
      { id: 'p1', systemPrompt: 'a' },
      { id: 'p1', systemPrompt: 'ab' }
    ])
  })

  it('MP-14 clearing the prompt saves the empty text', async () => {
    await openPrompt('old')
    type(promptBox(), '')
    advance(600)
    expect(update).toHaveBeenCalledWith({ id: 'p1', systemPrompt: '' })
  })

  it('MP-15 blur before 600 ms saves at once, and the timer adds nothing', async () => {
    await openPrompt()
    type(promptBox(), 'abc')
    advance(100)
    blur(promptBox())
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ id: 'p1', systemPrompt: 'abc' })
    advance(5000)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('MP-16 going back to the index before 600 ms saves at once; the row then says it is set', async () => {
    await openPrompt()
    type(promptBox(), 'abc')
    advance(100)
    render({ page: 'index' })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ id: 'p1', systemPrompt: 'abc' })
    expect(rowValue('prompt')).toBe(M.projectPromptSet)
    advance(5000)
    unmount()
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('MP-17 unmounting before 600 ms saves the pending text once', async () => {
    await openPrompt()
    type(promptBox(), 'abc')
    advance(100)
    unmount()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ id: 'p1', systemPrompt: 'abc' })
    advance(5000)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('MP-18 nothing typed: blur, leaving the page and unmounting save nothing', async () => {
    await openPrompt('old')
    blur(promptBox())
    advance(1000)
    render({ page: 'index' })
    render({ page: 'prompt' })
    advance(1000)
    unmount()
    expect(update).not.toHaveBeenCalled()
  })

  it('MP-18 a prompt that could not be saved does not throw', async () => {
    update.mockRejectedValue(new Error('offline'))
    await openPrompt()
    type(promptBox(), 'abc')
    expect(() => advance(600)).not.toThrow()
    await flush()
    expect(update).toHaveBeenCalledTimes(1)
  })
})

describe('MobileProjectSettings: the extensions and knowledge pages', () => {
  it('MP-19 the extensions page: the MCP servers only, with the saved selection', async () => {
    getById.mockResolvedValue(project({ settings: { enabledTools: ['mcp:a', '-mcp:b'] } }))
    await open({ page: 'extensions' })
    expect(kind()).toBe('project-extensions')
    expect(text('[data-mobile-panel-title]')).toBe(en.sessionConfig.extensionsGroup)
    expect(text('[data-mobile-panel-back]')).toBe(F.editTitle)
    expect(q('[data-mobile-project-section]')!.getAttribute('data-mobile-project-section')).toBe(
      'extensions'
    )
    expect(lastSection()).toMatchObject({
      only: 'mcp',
      title: en.sessionConfig.extensionsGroup,
      footer: F.extensionsDesc,
      mcpTools: [TOOLS[0], TOOLS[1]],
      enabledTools: ['mcp:a', '-mcp:b']
    })
  })

  it('MP-19 a project that never saved its extensions starts with none', async () => {
    await open({ page: 'extensions' })
    expect(lastSection().enabledTools).toEqual([])
  })

  it('MP-20 a change saves the whole list at once and is shown back', async () => {
    await open({ page: 'extensions' })
    act(() => (lastSection().onChange as (next: string[]) => void)(['mcp:a']))
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ id: 'p1', enabledTools: ['mcp:a'] })
    expect(Object.keys(update.mock.calls[0][0])).toEqual(['id', 'enabledTools'])
    expect(lastSection().enabledTools).toEqual(['mcp:a'])

    act(() => (lastSection().onChange as (next: string[]) => void)(['mcp:a', 'mcp:b']))
    expect(update).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenLastCalledWith({ id: 'p1', enabledTools: ['mcp:a', 'mcp:b'] })
    render({ page: 'index' })
    expect(rowValue('extensions')).toBe('2')
  })

  it('MP-21 the knowledge page: the saved selection', async () => {
    getById.mockResolvedValue(project({ settings: { knowledgeBases: ['cook', 'gone'] } }))
    await open({ page: 'knowledge' })
    expect(kind()).toBe('project-knowledge')
    expect(text('[data-mobile-panel-title]')).toBe(en.sessionConfig.knowledgeGroup)
    expect(q('[data-mobile-project-section]')!.getAttribute('data-mobile-project-section')).toBe(
      'knowledge'
    )
    expect(lastSection()).toMatchObject({ only: 'knowledge', footer: undefined })
    expect(knowledgeOf(lastSection())).toMatchObject({
      options: KB.options,
      selected: ['cook', 'gone'],
      hint: F.knowledgeBasesDesc
    })
  })

  it("MP-21 a project that never saved its knowledge bases shows the host's default", async () => {
    await open({ page: 'knowledge' })
    expect(knowledgeOf(lastSection()).selected).toEqual(['notes'])
  })

  it('MP-21 a saved empty list is shown as empty, not as the default', async () => {
    getById.mockResolvedValue(project({ settings: { knowledgeBases: [] } }))
    await open({ page: 'knowledge' })
    expect(knowledgeOf(lastSection()).selected).toEqual([])
  })

  it('MP-22 each toggle saves the whole list once, starting from the default', async () => {
    await open({ page: 'knowledge' })
    act(() => knowledgeOf(lastSection()).onToggle('cook'))
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ id: 'p1', knowledgeBases: ['notes', 'cook'] })
    expect(Object.keys(update.mock.calls[0][0])).toEqual(['id', 'knowledgeBases'])
    expect(knowledgeOf(lastSection()).selected).toEqual(['notes', 'cook'])

    act(() => knowledgeOf(lastSection()).onToggle('notes'))
    expect(update).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenLastCalledWith({ id: 'p1', knowledgeBases: ['cook'] })

    act(() => knowledgeOf(lastSection()).onToggle('cook'))
    expect(update).toHaveBeenLastCalledWith({ id: 'p1', knowledgeBases: [] })
    render({ page: 'index' })
    expect(rowValue('knowledge')).toBeNull()
  })

  it('MP-23 visiting the knowledge page without toggling saves nothing', async () => {
    await open()
    render({ page: 'knowledge' })
    render({ page: 'index' })
    render({ page: 'extensions' })
    render({ page: 'index' })
    unmount()
    expect(update).not.toHaveBeenCalled()
  })

  it('MP-23 a sub page before the project loaded draws only its frame', () => {
    render({ page: 'knowledge' })
    expect(kind()).toBe('project-knowledge')
    expect(q('[data-stub-extensions]')).toBeNull()
    click(q('[data-mobile-panel-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('MobileProjectSettings: what is never saved', () => {
  it('MP-13 no save in this file carried environment variables or tool settings', () => {
    expect(allUpdates.length).toBeGreaterThan(10)
    const allowed = new Set([
      'id',
      'name',
      'systemPrompt',
      'enabledTools',
      'knowledgeBases',
      'archived'
    ])
    for (const patch of allUpdates) {
      expect(patch.id).toBe('p1')
      expect(Object.keys(patch).filter((key) => !allowed.has(key))).toEqual([])
    }
  })
})
