// @vitest-environment jsdom
/**
 * `web/WebStatusLayer.tsx` 的服务端路径卡片（server mode phase D）—— 「在文件管理器中打开 / 显示」在浏览器里换成一张卡片：
 * 显示那个服务端路径、给一个复制按钮，用户关掉为止（`webPathNotice` 驱动；复制走 `copyText`：安全上下文用
 * `navigator.clipboard`，否则 / 失败时退回 textarea + `execCommand('copy')`）。连接是假的（state 恒为 'open'，横幅不出现）。
 *
 *   SP-1 showServerPath → `[data-web-path-notice=<通道>][data-web-path=<路径>]`，`[data-web-path-text]` 就是路径；
 *        目录用 pathNoticeFolder、文件用 pathNoticeFile
 *   SP-2 `[data-web-path-close]` 关掉；新的一条换掉旧的
 *   SP-3 复制：安全上下文 → clipboard.writeText(路径)、按钮 `data-web-path-copy="copied"`、1.5 秒后复原（假定时器）；
 *        clipboard 拒绝或不是安全上下文 → execCommand 退路（临时 textarea 里是路径、用完摘掉）；execCommand 回 false /
 *        抛 → "failed"；新的一条把复制状态复原
 *
 * 渲染层的 vitest 只收 `*.test.ts`、没有 react 插件：一律 createElement。i18n 用真的 en 资源；不引 `@shuvix/chat-ui`。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { WebStatusLayer } from '../WebStatusLayer'
import { currentServerPath, dismissServerPath, showServerPath } from '../webPathNotice'
import type { WsConnection } from '../wsConnection'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const W = en.web
const FOLDER = '/Users/me/.shuvix/agents'
const FILE = '/Users/me/.shuvix/knowledge/notes/a.md'

const connection = {
  state: () => 'open',
  onState: () => () => {},
  transport: {},
  sync: {},
  dispose: () => {}
} as unknown as WsConnection

let container: HTMLDivElement
let root: Root
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>
let execCommand: ReturnType<typeof vi.fn<(command: string) => boolean>>
/** execCommand 被调的那一刻，页面上那个 textarea 里的值 */
let textareaAtCopy: Array<string | null>

/** 让 copyText 的那几个 await 与随之的 setState 落定（不靠定时器，假定时器下也能用） */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

const $ = <T extends Element = HTMLElement>(selector: string): T | null =>
  document.body.querySelector<T>(selector)

function must<T extends Element = HTMLElement>(selector: string): T {
  const el = $<T>(selector)
  if (!el) throw new Error(`${selector} not rendered`)
  return el
}

function show(channel: string, path: string, target: 'folder' | 'file'): void {
  act(() => showServerPath({ channel, path, target }))
}

const card = (): HTMLElement => must('[data-web-path-notice]')
const copyButton = (): HTMLButtonElement => must<HTMLButtonElement>('[data-web-path-copy]')

async function clickCopy(): Promise<void> {
  act(() => copyButton().click())
  await settle()
}

function setSecure(secure: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true })
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  setSecure(true)
  textareaAtCopy = []
  execCommand = vi.fn(() => {
    textareaAtCopy.push(document.querySelector('textarea')?.value ?? null)
    return true
  })
  ;(document as unknown as { execCommand: unknown }).execCommand = execCommand
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(createElement(WebStatusLayer, { connection })))
})

afterEach(() => {
  const current = currentServerPath()
  if (current) act(() => dismissServerPath(current.id))
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('SP-1 卡片的内容', () => {
  it('SP-1 目录：通道、路径、pathNoticeFolder', () => {
    expect($('[data-web-path-notice]')).toBeNull()
    show('subAgent:openFolder', FOLDER, 'folder')
    expect(card().getAttribute('data-web-path-notice')).toBe('subAgent:openFolder')
    expect(card().getAttribute('data-web-path')).toBe(FOLDER)
    expect(must('[data-web-path-text]').textContent).toBe(FOLDER)
    expect(card().textContent).toContain(W.pathNoticeFolder)
    expect(card().textContent).not.toContain(W.pathNoticeFile)
    // 没有连接横幅（连着）
    expect($('[data-web-connection]')).toBeNull()
  })

  it('SP-1 文件：pathNoticeFile', () => {
    show('knowledge:revealFile', FILE, 'file')
    expect(card().getAttribute('data-web-path-notice')).toBe('knowledge:revealFile')
    expect(must('[data-web-path-text]').textContent).toBe(FILE)
    expect(card().textContent).toContain(W.pathNoticeFile)
    expect(card().textContent).not.toContain(W.pathNoticeFolder)
  })
})

describe('SP-2 关掉与换掉', () => {
  it('SP-2 关闭按钮把它收起；新的一条换掉旧的', () => {
    show('app:open-folder', '/a', 'folder')
    act(() => must('[data-web-path-close]').click())
    expect($('[data-web-path-notice]')).toBeNull()
    expect(currentServerPath()).toBeNull()

    show('app:open-folder', '/a', 'folder')
    show('app:reveal-path', '/b/c.txt', 'file')
    expect(document.body.querySelectorAll('[data-web-path-notice]')).toHaveLength(1)
    expect(card().getAttribute('data-web-path')).toBe('/b/c.txt')
    expect(card().textContent).toContain(W.pathNoticeFile)
  })
})

describe('SP-3 复制', () => {
  it('SP-3 安全上下文 → clipboard.writeText(路径)，copied；1.5 秒后复原', async () => {
    vi.useFakeTimers()
    show('hook:openFolder', FOLDER, 'folder')
    expect(copyButton().getAttribute('data-web-path-copy')).toBe('')
    expect(copyButton().textContent).toBe(W.copyPath)

    await clickCopy()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(FOLDER)
    expect(execCommand).not.toHaveBeenCalled()
    expect(copyButton().getAttribute('data-web-path-copy')).toBe('copied')
    expect(copyButton().textContent).toBe(W.copied)

    act(() => vi.advanceTimersByTime(1400))
    expect(copyButton().getAttribute('data-web-path-copy')).toBe('copied')
    act(() => vi.advanceTimersByTime(200))
    expect(copyButton().getAttribute('data-web-path-copy')).toBe('')
    expect(copyButton().textContent).toBe(W.copyPath)
  })

  it('SP-3 clipboard 拒绝 → execCommand 退路；临时 textarea 里是路径、用完摘掉', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    show('bot:openFolder', FOLDER, 'folder')
    await clickCopy()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(execCommand).toHaveBeenCalledTimes(1)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(textareaAtCopy).toStrictEqual([FOLDER])
    expect(document.querySelector('textarea')).toBeNull()
    expect(copyButton().getAttribute('data-web-path-copy')).toBe('copied')
  })

  it('SP-3 不是安全上下文 → 不碰 clipboard，直接 execCommand', async () => {
    setSecure(false)
    show('policy:openFolder', FOLDER, 'folder')
    await clickCopy()
    expect(writeText).not.toHaveBeenCalled()
    expect(textareaAtCopy).toStrictEqual([FOLDER])
    expect(document.querySelector('textarea')).toBeNull()
    expect(copyButton().getAttribute('data-web-path-copy')).toBe('copied')
  })

  it('SP-3 execCommand 回 false / 抛 → failed', async () => {
    setSecure(false)
    execCommand.mockImplementationOnce(() => false)
    show('app:open-folder', '/a', 'folder')
    await clickCopy()
    expect(copyButton().getAttribute('data-web-path-copy')).toBe('failed')
    expect(copyButton().textContent).toBe(W.copyFailed)
    expect(document.querySelector('textarea')).toBeNull()

    show('app:open-folder', '/b', 'folder')
    execCommand.mockImplementationOnce(() => {
      throw new Error('not allowed')
    })
    await clickCopy()
    expect(copyButton().getAttribute('data-web-path-copy')).toBe('failed')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('SP-3 新的一条把复制状态复原', async () => {
    show('app:open-folder', '/a', 'folder')
    await clickCopy()
    expect(copyButton().getAttribute('data-web-path-copy')).toBe('copied')
    show('app:open-folder', '/a', 'folder')
    expect(copyButton().getAttribute('data-web-path-copy')).toBe('')
    expect(copyButton().textContent).toBe(W.copyPath)
  })
})
