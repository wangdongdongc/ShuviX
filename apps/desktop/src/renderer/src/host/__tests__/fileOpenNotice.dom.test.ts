// @vitest-environment jsdom
/**
 * 「这个文件打不开」的轻提示 —— `host/fileOpenNotice.ts`（模块级 store + 文案）与 `host/FileOpenNoticeLayer.tsx`
 * （窗口底部的小药丸，FILE_OPEN_NOTICE_MS 后自己收起，新的一条顶掉旧的）。
 *
 *   N-1 fileNameOf：路径 / Windows 路径 / `library:` / `shown:` 引用取最后一段；以 `/` 结尾的整串原样
 *   N-2 formatBytes 各档的边界
 *   N-3 fileOpenReasonText：每个原因 → 它的键与参数（size / cap 已格式化）
 *   N-4 三种语言的 fileOpen 键一致；tooLarge 带 {{size}} / {{cap}}，unsupportedExt 带 {{ext}}
 *   N-5 store：show 通知订阅者、current 带文件名与原因；同一路径 id 递增；旧 id 的 dismiss 不动新的；
 *       当前 id 的 dismiss 清空并通知；退订之后不再通知
 *   N-6 层：portal 到 body，`[data-file-open-notice=<原因>]` + role=status，文字含文件名与原因；没有提示时什么都没有
 *   N-7 FILE_OPEN_NOTICE_MS 到点收起（差 1ms 时还在）
 *   N-8 换掉的竞态：A，+3000ms，B → 只有一个、是 B；再 +600ms（A 的定时器若还在早该到了）B 还在；
 *       B 在 3000 + FILE_OPEN_NOTICE_MS 收起
 *   N-9 定时器到点之前卸载 → 不留定时器
 *
 * 渲染层的 vitest 只收 `*.test.ts`、没有 react 插件：一律 createElement。i18n 用真的 en 资源。
 * store 没有重置入口：每条用例之后收起当前那条、卸载。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n, { type TFunction } from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import type { FileOpenRefusal } from '@shuvix/chat-protocol/types/filePreview'
import {
  currentFileOpenNotice,
  dismissFileOpenNotice,
  fileNameOf,
  fileOpenReasonText,
  formatBytes,
  showFileOpenNotice,
  subscribeFileOpenNotice
} from '../fileOpenNotice'
import { FILE_OPEN_NOTICE_MS, FileOpenNoticeLayer } from '../FileOpenNoticeLayer'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const MB = 1024 * 1024

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

let container: HTMLDivElement
let root: Root | undefined

const mount = (): void => {
  root = createRoot(container)
  act(() => root!.render(createElement(FileOpenNoticeLayer)))
}
const unmount = (): void => {
  act(() => root?.unmount())
  root = undefined
}
const notices = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[data-file-open-notice]'))
const dismissCurrent = (): void => {
  const current = currentFileOpenNotice()
  if (current) act(() => dismissFileOpenNotice(current.id))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  dismissCurrent()
  unmount()
  container.remove()
  vi.useRealTimers()
})

describe('N-1 fileNameOf', () => {
  it.each([
    ['/a/b/c.png', 'c.png'],
    ['C:\\x\\y.bin', 'y.bin'],
    ['library:abc', 'library:abc'],
    [`shown:${'d'.repeat(64)}.png`, `shown:${'d'.repeat(64)}.png`],
    ['/a/b/', '/a/b/']
  ])('%s → %s', (path, name) => {
    expect(fileNameOf(path)).toBe(name)
  })
})

describe('N-2 formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [MB - 1, '1024.0 KB'],
    [2 * MB, '2.0 MB'],
    [50 * MB + 1, '50.0 MB'],
    [3 * 1024 * MB, '3.0 GB']
  ])('%d → %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })
})

describe('N-3 fileOpenReasonText', () => {
  /** 记下键与参数的 t */
  const t = ((key: string, args?: Record<string, unknown>) =>
    JSON.stringify({ key, args: args ?? null })) as unknown as TFunction
  const call = (refusal: FileOpenRefusal): unknown => JSON.parse(fileOpenReasonText(t, refusal))

  it.each<[FileOpenRefusal, unknown]>([
    [
      { reason: 'unsupported', ext: '.zip' },
      { key: 'fileOpen.unsupportedExt', args: { ext: '.zip' } }
    ],
    [
      { reason: 'unsupported', ext: '' },
      { key: 'fileOpen.unsupported', args: null }
    ],
    [
      { reason: 'too-large', size: 50 * MB + 1, cap: 50 * MB },
      { key: 'fileOpen.tooLarge', args: { size: '50.0 MB', cap: '50.0 MB' } }
    ],
    [{ reason: 'missing' }, { key: 'fileOpen.missing', args: null }],
    [{ reason: 'directory' }, { key: 'fileOpen.directory', args: null }],
    [{ reason: 'unreadable' }, { key: 'fileOpen.unreadable', args: null }]
  ])('%j', (refusal, expected) => {
    expect(call(refusal)).toEqual(expected)
  })
})

describe('N-4 三种语言的 fileOpen 键', () => {
  const KEYS = ['directory', 'missing', 'tooLarge', 'unreadable', 'unsupported', 'unsupportedExt']

  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja]
  ])('%s', (_lng, locale) => {
    const block = (locale as unknown as { fileOpen: Record<string, string> }).fileOpen
    expect(Object.keys(block).sort()).toEqual(KEYS)
    for (const key of KEYS) expect(block[key].trim(), key).not.toBe('')
    expect(block.tooLarge).toContain('{{size}}')
    expect(block.tooLarge).toContain('{{cap}}')
    expect(block.unsupportedExt).toContain('{{ext}}')
  })
})

describe('N-5 store', () => {
  it('show / dismiss / 订阅', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeFileOpenNotice(listener)

    showFileOpenNotice('/a/b/file.zip', { reason: 'unsupported', ext: '.zip' })
    expect(listener).toHaveBeenCalledTimes(1)
    const first = currentFileOpenNotice()!
    expect(first).toMatchObject({
      name: 'file.zip',
      refusal: { reason: 'unsupported', ext: '.zip' }
    })

    showFileOpenNotice('/a/b/file.zip', { reason: 'unsupported', ext: '.zip' })
    expect(listener).toHaveBeenCalledTimes(2)
    const second = currentFileOpenNotice()!
    expect(second.id).toBeGreaterThan(first.id)

    // 旧的那条到点：新的不动、不通知
    dismissFileOpenNotice(first.id)
    expect(currentFileOpenNotice()).toBe(second)
    expect(listener).toHaveBeenCalledTimes(2)

    dismissFileOpenNotice(second.id)
    expect(currentFileOpenNotice()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(3)

    unsubscribe()
    showFileOpenNotice('/x.bin', { reason: 'unreadable' })
    expect(listener).toHaveBeenCalledTimes(3)
  })
})

describe('N-6…N-9 FileOpenNoticeLayer', () => {
  it('N-6 portal 到 body，带原因与 role=status；没有提示时什么都没有', () => {
    mount()
    expect(notices()).toHaveLength(0)

    act(() =>
      showFileOpenNotice('/data/huge.log', { reason: 'too-large', size: 50 * MB + 1, cap: 50 * MB })
    )
    const [el] = notices()
    expect(notices()).toHaveLength(1)
    expect(container.contains(el)).toBe(false)
    expect(el.parentElement).toBe(document.body)
    expect(el.getAttribute('data-file-open-notice')).toBe('too-large')
    expect(el.getAttribute('role')).toBe('status')
    expect(el.textContent).toContain('huge.log')
    expect(el.textContent).toContain('Too large to preview (50.0 MB, limit 50.0 MB)')
  })

  it('N-7 FILE_OPEN_NOTICE_MS 到点收起', () => {
    vi.useFakeTimers()
    mount()
    act(() => showFileOpenNotice('/a/missing.txt', { reason: 'missing' }))
    expect(notices()).toHaveLength(1)

    act(() => vi.advanceTimersByTime(FILE_OPEN_NOTICE_MS - 1))
    expect(notices()).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(notices()).toHaveLength(0)
    expect(currentFileOpenNotice()).toBeNull()
  })

  it('N-8 新的一条顶掉旧的，计时从新的那条算', () => {
    vi.useFakeTimers()
    mount()
    act(() => showFileOpenNotice('/a/A.zip', { reason: 'unsupported', ext: '.zip' }))
    act(() => vi.advanceTimersByTime(3000))
    act(() => showFileOpenNotice('/a/B', { reason: 'directory' }))

    expect(notices()).toHaveLength(1)
    expect(notices()[0].getAttribute('data-file-open-notice')).toBe('directory')
    expect(notices()[0].textContent).toContain('B')

    act(() => vi.advanceTimersByTime(600))
    expect(notices()).toHaveLength(1)
    expect(notices()[0].getAttribute('data-file-open-notice')).toBe('directory')

    act(() => vi.advanceTimersByTime(FILE_OPEN_NOTICE_MS - 600 - 1))
    expect(notices()).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(notices()).toHaveLength(0)
  })

  it('N-9 到点之前卸载 → 不留定时器', () => {
    vi.useFakeTimers()
    mount()
    act(() => showFileOpenNotice('/a/x.bin', { reason: 'unreadable' }))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
