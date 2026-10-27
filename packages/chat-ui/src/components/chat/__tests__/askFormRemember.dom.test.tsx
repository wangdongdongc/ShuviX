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
