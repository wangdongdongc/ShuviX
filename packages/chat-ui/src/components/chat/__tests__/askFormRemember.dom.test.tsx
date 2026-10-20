// @vitest-environment jsdom
/**
 * 询问卡片的「允许并记住」—— 记进会话权限表：这条路径本身，或（文件）它所在的那一级文件夹。
 *
 *   AR-1  rememberFolderOf：文件所在的文件夹；少于三段的（`/`、`/Users`、家目录这一层）不给；Windows 不数盘符
 *   AR-2  文件路径的读 / 写询问：「允许该路径」旁有下拉；点开才出现「允许整个文件夹 <父目录>」，点它回
 *         `extra.rememberPath = <父目录>`；主按钮照旧回 `rememberPath: true`
 *   AR-3  父目录太浅（家目录里的文件）→ 没有下拉；目录询问（允许此目录）→ 没有下拉
 *   AR-4  没有宿主（getHostApi 为 null）或不是路径询问（命令）→ 没有记住按钮，也没有下拉
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

const byText = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === text)
const options = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('[data-remember-options]')
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
  it('AR-2 文件：下拉点开才有「允许整个文件夹」，回父目录；主按钮回 true', () => {
    const onSubmit = render(ask())
    expect(folderButton()).toBeNull()
    act(() => options()!.click())
    const folder = folderButton()!
    expect(folder.dataset.rememberFolder).toBe('/Users/u/proj/docs')
    expect(folder.textContent).toContain(en.toolCall.rememberFolder)
    act(() => folder.click())
    expect(onSubmit).toHaveBeenLastCalledWith({
      kind: 'ask',
      allowed: true,
      extra: { rememberPath: '/Users/u/proj/docs' }
    })

    act(() => byText(en.toolCall.allowAndRememberPath)!.click())
    expect(onSubmit).toHaveBeenLastCalledWith({
      kind: 'ask',
      allowed: true,
      extra: { rememberPath: true }
    })
  })

  it('AR-2 写询问同样有下拉', () => {
    render(ask({ toolName: 'write', command: 'Write(/Users/u/proj/out/b.txt)' }))
    act(() => options()!.click())
    expect(folderButton()!.dataset.rememberFolder).toBe('/Users/u/proj/out')
  })

  it('AR-3 家目录里的文件、目录询问：没有下拉', () => {
    render(ask({ command: 'Read(/Users/u/notes.txt)' }))
    expect(byText(en.toolCall.allowAndRememberPath)).toBeDefined()
    expect(options()).toBeNull()

    render(ask({ command: 'Read(/Users/u/proj/docs)', pathIsDirectory: true }))
    expect(byText(en.toolCall.allowThisDirectory)).toBeDefined()
    expect(options()).toBeNull()
  })

  it('AR-4 没有宿主 / 命令询问：没有记住按钮与下拉', () => {
    host.api = null
    render(ask())
    expect(byText(en.toolCall.allowAndRememberPath)).toBeUndefined()
    expect(options()).toBeNull()

    host.api = {}
    render(ask({ toolName: 'bash', command: 'ls -la' }))
    expect(byText(en.toolCall.allowAndRememberPath)).toBeUndefined()
    expect(options()).toBeNull()
  })
})
