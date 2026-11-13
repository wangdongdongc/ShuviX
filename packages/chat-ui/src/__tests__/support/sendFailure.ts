/**
 * 「发送失败」用例共用的夹具（只给单测用）：
 *
 *  - `lost()` / `notSent()` / `handlerError()`：传输层拒绝一次调用时的三种错误（chat-protocol `connectionErrors`）；
 *  - `fakeLink()`：`window.api.sync` 的替身，`goDown()` / `goUp()` 翻状态并触发监听，监听数读得到；
 *  - `useFakeClock()` / `flush()` / `advance()`：假时钟（不碰 setImmediate，React 的 act 靠它收尾）。`flush` 在真时钟下
 *    等一个 0ms 的定时器，假时钟下只冲微任务、不拨钟 —— 用例数的宽限才数得准；
 *  - DOM 操作与 `composerShot()`：输入框此刻的样子（文字、图片、镜像层胶囊、要藏的值的胶囊、命令芯片）。
 */
import { act } from 'react'
import { vi } from 'vitest'
import type { JsonValue } from '@shuvix/chat-protocol/sync'
import { useChatStore, type PendingImage } from '../../stores/chatStore'

export const lost = (): Error => Object.assign(new Error('disconnected'), { code: 'disconnected' })
export const notSent = (): Error =>
  Object.assign(new Error('not connected'), { code: 'not_connected' })
export const handlerError = (message: string): Error =>
  Object.assign(new Error(message), { code: 'handler_error' })

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export interface FakeLink {
  send: (link: string, frame: JsonValue) => void
  onFrame: (callback: (link: string, frame: JsonValue) => void) => () => void
  isUp: ReturnType<typeof vi.fn<() => boolean>>
  onUp: ReturnType<typeof vi.fn<(callback: () => void) => () => void>>
  onDown: ReturnType<typeof vi.fn<(callback: (reason: string) => void) => () => void>>
  goDown(): void
  goUp(): void
  upListeners(): number
  downListeners(): number
}

export function fakeLink(initiallyUp = true): FakeLink {
  let up = initiallyUp
  const ups = new Set<() => void>()
  const downs = new Set<(reason: string) => void>()
  return {
    send: vi.fn(),
    onFrame: vi.fn(() => () => {}),
    isUp: vi.fn(() => up),
    onUp: vi.fn((callback: () => void) => {
      ups.add(callback)
      return () => {
        ups.delete(callback)
      }
    }),
    onDown: vi.fn((callback: (reason: string) => void) => {
      downs.add(callback)
      return () => {
        downs.delete(callback)
      }
    }),
    goDown() {
      up = false
      for (const callback of [...downs]) callback('disconnected')
    },
    goUp() {
      up = true
      for (const callback of [...ups]) callback()
    },
    upListeners: () => ups.size,
    downListeners: () => downs.size
  }
}

export function useFakeClock(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
}

export async function flush(ms = 0): Promise<void> {
  if (vi.isFakeTimers()) {
    await act(() => vi.advanceTimersByTimeAsync(ms))
    return
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

/** 拨假时钟（React 的更新一并冲掉） */
export const advance = (ms: number): Promise<void> => flush(ms)

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, value)
}

/** 像用户敲字那样改 textarea（走 React 的 onChange） */
export async function typeInto(el: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    setNativeValue(el, value)
    el.selectionStart = el.selectionEnd = value.length
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

export async function pressKey(el: Element, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
  await flush()
}

export async function clickOn(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

/** 够折叠成芯片的一段长文 */
export const longPaste = (tag: string, extraLine?: string): string =>
  [...Array.from({ length: 12 }, (_, i) => `${tag} ${i}`), ...(extraLine ? [extraLine] : [])].join(
    '\n'
  )

/** 在光标（末尾）粘贴 */
export async function pasteInto(el: HTMLTextAreaElement, text: string): Promise<void> {
  el.selectionStart = el.selectionEnd = el.value.length
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: () => text, items: [], files: [] }
  })
  await act(async () => {
    el.dispatchEvent(event)
  })
  await flush()
}

/** 「+」→ 添加敏感信息 → 添加（值落在光标处，成为胶囊） */
export async function addSecretChip(container: Element, value: string): Promise<void> {
  await clickOn(container.querySelector('button[data-attach-button]')!)
  await clickOn(document.body.querySelector('[data-plus-secret]')!)
  const input = document.body.querySelector<HTMLInputElement>('[data-secret-input]')!
  await act(async () => {
    setNativeValue(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await clickOn(document.body.querySelector('[data-secret-add]')!)
}

export interface ComposerShot {
  text: string
  images: PendingImage[]
  /** 镜像层里的 @ / 粘贴胶囊 */
  chips: string[]
  /** 镜像层里要藏的值的胶囊 */
  secretChips: string[]
  /** 斜杠命令芯片（`/cmd`）；没有 = null */
  slash: string | null
}

export function composerShot(container: Element): ComposerShot {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea:not([data-other-input])')!
  const area = textarea.parentElement!
  // 只认 div：命令芯片的图标（lucide 的 svg）也带 aria-hidden，还排在镜像层前面
  const mirror = area.querySelector('div[aria-hidden="true"]')
  return {
    text: textarea.value,
    images: useChatStore.getState().pendingImages,
    chips: [
      ...(mirror?.querySelectorAll('span[role="button"]:not([data-token-kind="secret"])') ?? [])
    ].map((s) => (s.textContent ?? '').trim()),
    secretChips: [...(mirror?.querySelectorAll('[data-token-kind="secret"]') ?? [])].map(
      (s) => s.textContent ?? ''
    ),
    slash: area.querySelector('[data-token-kind="cmd"]')?.getAttribute('data-token-display') ?? null
  }
}

/** 期间冒出来的未处理 rejection（临时接管监听，真冒出来的那条落进返回值、让断言如实失败） */
export async function collectUnhandled(run: () => Promise<void>): Promise<unknown[]> {
  const vitestListeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  const unhandled: unknown[] = []
  process.on('unhandledRejection', (reason) => unhandled.push(reason))
  try {
    await run()
  } finally {
    process.removeAllListeners('unhandledRejection')
    for (const listener of vitestListeners) process.on('unhandledRejection', listener)
  }
  return unhandled
}
