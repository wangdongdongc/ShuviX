// @vitest-environment jsdom
/**
 * 询问卡片的「允许并记住」—— 记进会话权限表：这条路径本身，或（文件）它所在的那一级文件夹。
 *
 *   AR-1  rememberFolderOf：文件所在的文件夹；少于三段的（`/`、`/Users`、家目录这一层）不给；Windows 不数盘符
 *   AR-2  文件路径的读 / 写询问：选项行自上而下是「允许这一次 / 记住这个文件 / 记住所在的文件夹 / 拒绝」；
 *         文件夹那一行直接摆着父目录（`data-remember-folder`、第二行的路径），点它回
 *         `extra.rememberPath = <父目录>`；「记住这个文件」回 `rememberPath: true`；「允许这一次」不带 extra
 *   AR-3  父目录太浅（家目录里的文件）→ 没有文件夹那一行；目录询问 → 没有「允许这一次」，只有「记住这个文件夹」与拒绝
 *   AR-4  没有宿主（getHostApi 为 null）或不是路径询问（命令）→ 没有任何记住的行
 *   XS-64/65 会话询问、WT4-UI-01..05 组件询问：见文件后面各自的 describe
 *
 * 包入口 `@shuvix/chat-ui` 顶掉（AskForm 从那里取 getHostApi）；i18n 走真 en 资源。文件是 .tsx 但不写 JSX。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AskInputRequest } from '@shuvix/chat-protocol/types/inputRequest'

const host = vi.hoisted(() => ({ api: {} as unknown }))
vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => host.api }))

import { AskForm, rememberFolderOf } from '../inputs/AskForm'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false }
  })
})

beforeEach(() => {
  host.api = {}
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const ask = (extra: Partial<AskInputRequest> = {}): AskInputRequest => ({
  id: 'tc-1',
  kind: 'ask',
  toolName: 'read',
  command: 'Read(/Users/u/proj/docs/a.md)',
  description: '',
  createdAt: 0,
  ...extra
})

function render(request: AskInputRequest, onSubmit = vi.fn()): typeof onSubmit {
  act(() => {
    root.render(createElement(AskForm, { request, draft: {}, onDraftChange: vi.fn(), onSubmit }))
  })
  return onSubmit
}

/** 选项行（`[data-ask-option]`，DOM 序）的 id 与正文（不含行首序号） */
const rows = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('[data-ask-option]')
]
const rowIds = (): string[] => rows().map((r) => r.dataset.askOption ?? '')
const labelOf = (r: HTMLElement): string =>
  r.querySelector('[data-option-label]')?.textContent ?? ''
const row = (id: string): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`[data-ask-option="${id}"]`)
const folderButton = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('[data-remember-folder]')

describe('rememberFolderOf', () => {
  it.each([
    ['/Users/u/proj/docs/a.md', '/Users/u/proj/docs'],
    ['/Users/u/proj/a.md', '/Users/u/proj'],
    ['/Users/u/a.md', null],
    ['/home/u/a.md', null],
    ['/root/a.md', null],
    ['/a.md', null],
    ['a.md', null],
    ['C:\\Users\\u\\proj\\a.md', 'C:\\Users\\u\\proj'],
    ['C:\\Users\\u\\a.md', null]
  ])('AR-1 %s → %s', (path, folder) => {
    expect(rememberFolderOf(path)).toBe(folder)
  })
})

describe('AskForm 的允许并记住', () => {
  it('AR-2 文件：四行，文件夹那一行摆着父目录、回父目录；「记住这个文件」回 true；「允许这一次」不带 extra', () => {
    const onSubmit = render(ask())
    expect(rowIds()).toEqual(['allow', 'remember-path', 'remember-folder', 'deny'])
    expect(rows().map(labelOf)).toEqual([
      en.toolCall.askAllowOnce,
      en.toolCall.askRememberFile,
      en.toolCall.askRememberFolder,
      en.toolCall.deny
    ])
    const folder = folderButton()!
    expect(folder).toBe(row('remember-folder'))
    expect(folder.dataset.rememberFolder).toBe('/Users/u/proj/docs')
    expect(folder.querySelector('[data-option-detail]')?.textContent).toBe('/Users/u/proj/docs')
    act(() => folder.click())
    expect(onSubmit).toHaveBeenLastCalledWith({
      kind: 'ask',
      allowed: true,
      extra: { rememberPath: '/Users/u/proj/docs' }
    })

    act(() => row('remember-path')!.click())
    expect(onSubmit).toHaveBeenLastCalledWith({
      kind: 'ask',
      allowed: true,
      extra: { rememberPath: true }
    })

    act(() => row('allow')!.click())
    expect(onSubmit.mock.lastCall).toEqual([{ kind: 'ask', allowed: true }])
  })

  it('AR-2 写询问同样有文件夹那一行', () => {
    render(ask({ toolName: 'write', command: 'Write(/Users/u/proj/out/b.txt)' }))
    expect(folderButton()!.dataset.rememberFolder).toBe('/Users/u/proj/out')
  })

  it('AR-3 家目录里的文件：没有文件夹那一行；目录询问：只有「记住这个文件夹」与拒绝', () => {
    render(ask({ command: 'Read(/Users/u/notes.txt)' }))
    expect(rowIds()).toEqual(['allow', 'remember-path', 'deny'])
    expect(folderButton()).toBeNull()

    render(ask({ command: 'Read(/Users/u/proj/docs)', pathIsDirectory: true }))
    expect(rowIds()).toEqual(['remember-path', 'deny'])
    expect(labelOf(row('remember-path')!)).toBe(en.toolCall.askRememberDirectory)
    expect(folderButton()).toBeNull()
  })

  it('AR-4 没有宿主 / 命令询问：没有记住的行', () => {
    host.api = null
    render(ask())
    expect(rowIds()).toEqual(['allow', 'deny'])

    host.api = {}
    render(ask({ toolName: 'bash', command: 'ls -la' }))
    expect(rowIds()).toEqual(['allow', 'deny'])
  })
})

/**
 * 会话询问（request.session —— `session` 工具要与一条不是自己子会话的会话交互）：
 *
 *   XS-64 对话（write）询问 + 消息预览：标题「Talk to another session」；[data-ask-session=<id>] 摆标题与 id；
 *         「Message it will send」+ 原文在 <pre> 里；选项行恰为 Allow once / [data-remember-session]「Allow and
 *         remember this session」/ Deny，没有路径的记住行；记住 → extra.remember: true；允许 → 不带 extra；
 *         拒绝 → allowed: false
 *   XS-65 查看（read）询问：标题「Read another session」、没有消息块；空标题 →「Untitled session」；
 *         没有宿主（getHostApi 为 null）→ 没有记住那一行，允许 / 拒绝照在
 */
describe('AskForm 的会话询问', () => {
  const SESSION_ID = 'sess-0123456789ab'
  const MESSAGE = 'Please summarize the plan.\n  - keep <b>this</b> & that'

  const sessionAsk = (
    session: Partial<NonNullable<AskInputRequest['session']>> = {},
    extra: Partial<AskInputRequest> = {}
  ): AskInputRequest =>
    ask({
      toolName: 'session',
      command: `session "Refactor plan" (${SESSION_ID})`,
      session: {
        sessionId: SESSION_ID,
        title: 'Refactor plan',
        access: 'write',
        operation: 'prompt-session',
        ...session
      },
      ...extra
    })

  const sessionBox = (): HTMLElement | null =>
    container.querySelector<HTMLElement>('[data-ask-session]')
  const titleText = (): string | null | undefined => container.querySelector('p')?.textContent
  const buttonTexts = (): string[] => rows().map(labelOf)
  const rememberSession = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('[data-remember-session]')

  it('XS-64 对话询问：标题、目标会话、要发的那段话、三个按钮', () => {
    render(sessionAsk({}, { preview: { kind: 'message', text: MESSAGE } }))

    expect(titleText()).toBe(en.toolCall.sessionAskWrite)
    expect(titleText()).toBe('Talk to another session')

    const box = sessionBox()!
    expect(box).not.toBeNull()
    expect(box.dataset.askSession).toBe(SESSION_ID)
    const [titleLine, idLine] = [...box.querySelectorAll<HTMLElement>('.truncate')]
    expect(titleLine.textContent).toBe('Refactor plan')
    expect(idLine.textContent).toBe(SESSION_ID)
    expect(idLine.classList.contains('font-mono')).toBe(true)

    // 要发进那条会话的话：小标题 + <pre> 里一字不差（换行、缩进、尖括号都原样）
    expect(box.textContent).toContain(en.toolCall.sessionAskMessage)
    expect(box.textContent).toContain('Message it will send')
    const pres = box.querySelectorAll('pre')
    expect(pres).toHaveLength(1)
    expect(pres[0].textContent).toBe(MESSAGE)
    expect(pres[0].querySelector('b')).toBeNull()

    // 没有命令预览 / 路径预览：卡上唯一的 <pre> 就是消息
    expect(container.querySelectorAll('pre')).toHaveLength(1)

    expect(buttonTexts()).toEqual([
      en.toolCall.askAllowOnce,
      en.toolCall.askRememberSession,
      en.toolCall.deny
    ])
    expect(buttonTexts()).toEqual(['Allow once', 'Allow and remember this session', 'Deny'])
    expect(labelOf(rememberSession()!)).toBe('Allow and remember this session')
    expect(rememberSession()).toBe(row('remember-session'))
    expect(row('remember-path')).toBeNull()
    expect(folderButton()).toBeNull()
  })

  it('XS-64 记住 → extra.remember: true；允许 → 不带 extra；拒绝 → allowed: false', () => {
    const onSubmit = render(sessionAsk({}, { preview: { kind: 'message', text: MESSAGE } }))

    act(() => rememberSession()!.click())
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenLastCalledWith({
      kind: 'ask',
      allowed: true,
      extra: { remember: true }
    })

    act(() => row('allow')!.click())
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(onSubmit.mock.calls[1]).toEqual([{ kind: 'ask', allowed: true }])
    expect(onSubmit.mock.calls[1][0]).not.toHaveProperty('extra')

    act(() => row('deny')!.click())
    expect(onSubmit).toHaveBeenCalledTimes(3)
    expect(onSubmit.mock.calls[2]).toEqual([{ kind: 'ask', allowed: false }])
  })

  it('XS-65 查看询问：「Read another session」，没有消息块', () => {
    const onSubmit = render(sessionAsk({ access: 'read', operation: 'read-session' }))

    expect(titleText()).toBe(en.toolCall.sessionAskRead)
    expect(titleText()).toBe('Read another session')
    const box = sessionBox()!
    expect(box.dataset.askSession).toBe(SESSION_ID)
    expect(box.textContent).toContain('Refactor plan')
    expect(box.textContent).toContain(SESSION_ID)
    expect(box.textContent).not.toContain(en.toolCall.sessionAskMessage)
    expect(container.querySelector('pre')).toBeNull()

    expect(buttonTexts()).toEqual(['Allow once', 'Allow and remember this session', 'Deny'])
    act(() => rememberSession()!.click())
    expect(onSubmit).toHaveBeenLastCalledWith({
      kind: 'ask',
      allowed: true,
      extra: { remember: true }
    })
  })

  it('XS-65 空标题 →「Untitled session」，id 照写', () => {
    render(sessionAsk({ title: '' }, { command: `session ${SESSION_ID}` }))
    const [titleLine, idLine] = [...sessionBox()!.querySelectorAll<HTMLElement>('.truncate')]
    expect(titleLine.textContent).toBe(en.toolCall.sessionAskUntitled)
    expect(titleLine.textContent).toBe('Untitled session')
    expect(idLine.textContent).toBe(SESSION_ID)
  })

  it('XS-65 没有宿主：没有「Allow and remember」，允许 / 拒绝照在', () => {
    host.api = null
    const onSubmit = render(sessionAsk({}, { preview: { kind: 'message', text: MESSAGE } }))

    expect(rememberSession()).toBeNull()
    expect(buttonTexts()).toEqual(['Allow once', 'Deny'])
    // 卡片本身照旧：标题、目标会话、要发的话
    expect(titleText()).toBe(en.toolCall.sessionAskWrite)
    expect(sessionBox()!.querySelector('pre')!.textContent).toBe(MESSAGE)

    act(() => row('allow')!.click())
    expect(onSubmit).toHaveBeenLastCalledWith({ kind: 'ask', allowed: true })
    act(() => row('deny')!.click())
    expect(onSubmit).toHaveBeenLastCalledWith({ kind: 'ask', allowed: false })
  })
})

/**
 * 组件询问（request.widget —— `widget` 工具要用一个这条会话还没被授权的组件）：
 *
 *   WT4-UI-01 写（write）询问：标题「Change a widget」；[data-ask-widget=<id>] 先摆名字、再摆 id（等宽那一行）；
 *             「Operation」+ [data-ask-widget-op] = 操作名；选项行恰为 Allow once / 记成可读写 / Deny，记住那一行
 *             data-ask-option="remember-widget"、data-remember-widget="write"；没有路径 / 文件夹 / 会话的记住行
 *   WT4-UI-02 读（read）询问：标题「Read a widget」；Allow once / 记成只读 / 记成可读写 / Deny（remember-widget 与
 *             remember-widget-write，data-remember-widget 依次 read、write）
 *   WT4-UI-03 读卡片上逐行点：允许 → 不带 extra；记成只读 → extra.remember: true；记成可读写 →
 *             extra.remember + rememberAccess: 'write'；拒绝 → allowed: false。写卡片的记住行 → 只有 remember: true
 *   WT4-UI-04 没有宿主（getHostApi 为 null）→ 只有 Allow once / Deny，组件那一栏照旧
 *   WT4-UI-05 空名字 →「Unnamed widget」，id 照写；空操作名 → 没有「Operation」那一行
 *             （数字键选行由 askFormCard 的 AC-1 与 optionRows 按选项序统一钉住，这里不重复）
 */
describe('AskForm 的组件询问', () => {
  const WIDGET_ID = 'reading-list'

  const widgetAsk = (
    widget: Partial<NonNullable<AskInputRequest['widget']>> = {},
    extra: Partial<AskInputRequest> = {}
  ): AskInputRequest => {
    const target = {
      widgetId: WIDGET_ID,
      name: 'Reading list',
      access: 'write' as const,
      operation: 'addBook',
      ...widget
    }
    return ask({
      toolName: 'widget',
      command: `Widget(${target.access}, ${target.widgetId})`,
      widget: target,
      ...extra
    })
  }

  const widgetBox = (): HTMLElement | null =>
    container.querySelector<HTMLElement>('[data-ask-widget]')
  const titleText = (): string | null | undefined =>
    container.querySelector('[data-ask-title]')?.textContent
  const opLine = (): HTMLElement | null =>
    container.querySelector<HTMLElement>('[data-ask-widget-op]')
  const rememberWidgetRows = (): string[] =>
    [...container.querySelectorAll<HTMLElement>('[data-remember-widget]')].map(
      (el) => el.dataset.rememberWidget ?? ''
    )

  it('WT4-UI-01 写询问：标题、组件名与 id、操作名；Allow once / 记成可读写 / Deny', () => {
    render(widgetAsk())

    expect(titleText()).toBe(en.toolCall.widgetAskWrite)
    expect(titleText()).toBe('Change a widget')

    const box = widgetBox()!
    expect(box).not.toBeNull()
    expect(box.dataset.askWidget).toBe(WIDGET_ID)
    const [nameLine, idLine] = [...box.querySelectorAll<HTMLElement>('.truncate')]
    expect(nameLine.textContent).toBe('Reading list')
    expect(idLine.textContent).toBe(WIDGET_ID)
    expect(idLine.classList.contains('font-mono')).toBe(true)
    // 名字在 id 前面
    expect(nameLine.compareDocumentPosition(idLine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(box.textContent).toContain(en.toolCall.widgetAskOperation)
    expect(box.textContent).toContain('Operation')
    expect(opLine()!.textContent).toBe('addBook')
    expect(box.contains(opLine())).toBe(true)

    expect(rows().map(labelOf)).toEqual([
      en.toolCall.askAllowOnce,
      en.toolCall.askRememberWidgetWrite,
      en.toolCall.deny
    ])
    expect(rows().map(labelOf)).toEqual([
      'Allow once',
      'Allow and remember: may read and change this widget',
      'Deny'
    ])
    expect(rowIds()).toEqual(['allow', 'remember-widget', 'deny'])
    expect(row('remember-widget')!.dataset.rememberWidget).toBe('write')
    expect(rememberWidgetRows()).toEqual(['write'])

    // 不是路径询问、也不是会话询问：没有那些记住行
    expect(row('remember-path')).toBeNull()
    expect(row('remember-folder')).toBeNull()
    expect(row('remember-session')).toBeNull()
    expect(folderButton()).toBeNull()
    expect(container.querySelector('[data-remember-session]')).toBeNull()
    expect(container.querySelector('[data-ask-session]')).toBeNull()
  })

  it('WT4-UI-02 读询问：标题「Read a widget」；记成只读与记成可读写两行', () => {
    render(widgetAsk({ access: 'read', operation: 'listBooks' }))

    expect(titleText()).toBe(en.toolCall.widgetAskRead)
    expect(titleText()).toBe('Read a widget')
    expect(opLine()!.textContent).toBe('listBooks')

    expect(rows().map(labelOf)).toEqual([
      'Allow once',
      'Allow and remember: may read this widget',
      'Allow and remember: may read and change this widget',
      'Deny'
    ])
    expect(rows().map(labelOf)).toEqual([
      en.toolCall.askAllowOnce,
      en.toolCall.askRememberWidgetRead,
      en.toolCall.askRememberWidgetWrite,
      en.toolCall.deny
    ])
    expect(rowIds()).toEqual(['allow', 'remember-widget', 'remember-widget-write', 'deny'])
    expect(rememberWidgetRows()).toEqual(['read', 'write'])
    expect(row('remember-widget')!.dataset.rememberWidget).toBe('read')
    expect(row('remember-widget-write')!.dataset.rememberWidget).toBe('write')
  })

  it('WT4-UI-03 读卡片逐行点；写卡片的记住行不带 rememberAccess', () => {
    const onSubmit = render(widgetAsk({ access: 'read', operation: 'listBooks' }))

    act(() => row('allow')!.click())
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]).toEqual([{ kind: 'ask', allowed: true }])
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('extra')

    act(() => row('remember-widget')!.click())
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(onSubmit.mock.calls[1]).toEqual([
      { kind: 'ask', allowed: true, extra: { remember: true } }
    ])

    act(() => row('remember-widget-write')!.click())
    expect(onSubmit).toHaveBeenCalledTimes(3)
    expect(onSubmit.mock.calls[2]).toEqual([
      { kind: 'ask', allowed: true, extra: { remember: true, rememberAccess: 'write' } }
    ])

    act(() => row('deny')!.click())
    expect(onSubmit).toHaveBeenCalledTimes(4)
    expect(onSubmit.mock.calls[3]).toEqual([{ kind: 'ask', allowed: false }])

    const onWrite = render(widgetAsk(), vi.fn())
    act(() => row('remember-widget')!.click())
    expect(onWrite).toHaveBeenCalledTimes(1)
    expect(onWrite.mock.calls[0]).toEqual([
      { kind: 'ask', allowed: true, extra: { remember: true } }
    ])
    expect(onWrite.mock.calls[0][0].extra).not.toHaveProperty('rememberAccess')
  })

  it('WT4-UI-04 没有宿主：只有允许这一次与拒绝，组件那一栏照旧', () => {
    host.api = null
    render(widgetAsk({ access: 'read', operation: 'listBooks' }))
    expect(rowIds()).toEqual(['allow', 'deny'])
    expect(rows().map(labelOf)).toEqual(['Allow once', 'Deny'])
    expect(rememberWidgetRows()).toEqual([])

    expect(titleText()).toBe('Read a widget')
    const box = widgetBox()!
    expect(box.dataset.askWidget).toBe(WIDGET_ID)
    const [nameLine, idLine] = [...box.querySelectorAll<HTMLElement>('.truncate')]
    expect(nameLine.textContent).toBe('Reading list')
    expect(idLine.textContent).toBe(WIDGET_ID)
    expect(opLine()!.textContent).toBe('listBooks')

    render(widgetAsk())
    expect(rowIds()).toEqual(['allow', 'deny'])
    expect(titleText()).toBe('Change a widget')
  })

  it('WT4-UI-05 空名字 →「Unnamed widget」、id 照写；空操作名 → 没有操作那一行', () => {
    render(widgetAsk({ name: '' }))
    const [nameLine, idLine] = [...widgetBox()!.querySelectorAll<HTMLElement>('.truncate')]
    expect(nameLine.textContent).toBe(en.toolCall.widgetAskUnnamed)
    expect(nameLine.textContent).toBe('Unnamed widget')
    expect(idLine.textContent).toBe(WIDGET_ID)
    expect(opLine()!.textContent).toBe('addBook')

    render(widgetAsk({ operation: '' }))
    expect(opLine()).toBeNull()
    expect(widgetBox()!.textContent).not.toContain(en.toolCall.widgetAskOperation)
    expect(widgetBox()!.textContent).toContain('Reading list')
    expect(widgetBox()!.textContent).toContain(WIDGET_ID)
  })
})
