// @vitest-environment jsdom
/**
 * `components/widget/WidgetFrame.tsx` —— 承载 widget 页面的 iframe：挂上之后先透明，等这个 iframe 自己发来就绪信号
 * （shared/widgetReady.ts）再揭开；等不到就按 load 之后 2500ms / 拿到地址之后 12s 兜底揭开。「正在启动」的转圈按
 * 一次打开（挂载 / 重试 / 重新加载）计时，等了 400ms 还没揭开才出，拿到地址时不断一下。
 *
 *   WF-1  挂载：open('w1') 一次、startWidget 不调；等地址时没有 iframe；转圈 399ms 没有、400ms 出
 *   WF-2  地址到了：iframe 的 src 就是它、data-widget-frame="w1"、没有 data-revealed、class 带 opacity-0 与
 *         pointer-events-none；快的打开没有转圈；onWidget 收到摘要
 *   WF-3  自己的 iframe 发来信号 → data-revealed=""、opacity-100、没有 pointer-events-none；转圈没了；15s 后仍揭开着
 *   WF-4  不认：形状对、来源不对（另一个 iframe / window / null）；来源对、形状不对（字符串本身、别的 type、null）→
 *         2000ms 后仍透明（没有 load）；之后一条对的信号照样揭开
 *   WF-5  load 兜底：load 之后 2499ms 还透明、2500ms 揭开；之后再来一次 load 不会把它藏回去
 *   WF-6  截止：没有 load 也没有信号 → 地址到了之后 11999ms 还透明、12000ms 揭开
 *   WF-7  地址马上就到、信号迟迟不来：地址到了 400ms 才出转圈；揭开时转圈没了
 *   WF-8  转圈不闪：open 挂 600ms；400ms 出转圈；600ms 地址到了 → 601–999ms 一直在，直到揭开
 *   WF-9  重新加载：揭开之后换 reloadNonce → startWidget('w1')、open 不再调；等地址时没有 iframe；同一个地址回来 →
 *         新的 iframe 元素、没有 data-revealed；旧 iframe 的 window 发来的信号不认；旧 iframe 的 load 兜底到点也不揭开
 *         新的；新 iframe 自己的信号揭开
 *   WF-10 (a) open 失败 → 错误文字 + 重试按钮、没有 iframe、1s 后也没有转圈 (b) 点重试 → startWidget（open 一共一次）、
 *         点之后 400ms 出转圈、回来是透明的 iframe、它的信号揭开 (c) open 成功但没有地址 → widgets.serverStopped
 *   WF-11 web 客户端：sandbox 就是那串（没有 allow-same-origin）；自己的信号照样揭开
 *   WF-12 等的中途卸载：+15s、再来一条信号都没有 console.error / 异常；message 监听摘掉了
 *
 * 桌面 vitest 不带 react 插件 —— 一律 createElement。假定时器只假 setTimeout / clearTimeout / Date；jsdom 不会自己给
 * iframe 发 load（用例里手动派发）。`isWebHost` 是模块加载时读的值：mock 成随用例可变的 getter。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { initEnI18n } from '../../browser/__tests__/browserDomSupport'
import { WIDGET_READY_MESSAGE } from '../../../../../shared/widgetReady'

const flags = vi.hoisted(() => ({ web: false }))
vi.mock('../../../host/hostMedia', () => ({
  get isWebHost() {
    return flags.web
  }
}))

import { WidgetFrame } from '../WidgetFrame'

type OpenResult =
  | { success: true; url: string | null; widget?: WidgetSummary }
  | { success: false; error: string }

interface Deferred {
  promise: Promise<OpenResult>
  resolve: (value: OpenResult) => void
}

function deferred(): Deferred {
  let resolve!: (value: OpenResult) => void
  const promise = new Promise<OpenResult>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const WEB_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads'
const URL_1 = 'http://127.0.0.1:5555/w/w1/'
const READY = { type: WIDGET_READY_MESSAGE }

const api = {
  app: { platform: 'darwin' },
  widget: {
    open: vi.fn<(id: string) => Promise<OpenResult>>(),
    startWidget: vi.fn<(id: string) => Promise<OpenResult>>()
  }
}

let container: HTMLDivElement
let root: Root
let mounted = false
let openCall: Deferred
let startCalls: Deferred[]

function summary(id: string): WidgetSummary {
  return {
    id,
    name: `Name ${id}`,
    description: '',
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 0,
    archivedAt: 0,
    projectIds: []
  }
}

function render(reloadNonce = 0, onWidget?: (w: WidgetSummary) => void): void {
  act(() => {
    root.render(
      createElement(WidgetFrame, { widgetId: 'w1', title: 'Widget One', reloadNonce, onWidget })
    )
  })
  mounted = true
}

function unmount(): void {
  act(() => root.unmount())
  mounted = false
}

/** 让 open / startWidget 回来，并把 .then 里的 setState 落定 */
async function settle(d: Deferred, value: OpenResult): Promise<void> {
  await act(async () => {
    d.resolve(value)
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

const ok = (url: string | null = URL_1): OpenResult => ({
  success: true,
  url,
  widget: summary('w1')
})

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

const frame = (): HTMLIFrameElement | null => container.querySelector('iframe')
function mustFrame(): HTMLIFrameElement {
  const el = frame()
  if (!el) throw new Error('no iframe')
  return el
}
const spinner = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-widget-frame-loading]')

function revealed(el: HTMLIFrameElement = mustFrame()): boolean {
  return el.getAttribute('data-revealed') === ''
}

/** 断言 iframe 是透明、点不着的那个状态 */
function expectHidden(el: HTMLIFrameElement = mustFrame()): void {
  expect(el.hasAttribute('data-revealed')).toBe(false)
  expect(el.classList.contains('opacity-0')).toBe(true)
  expect(el.classList.contains('pointer-events-none')).toBe(true)
  expect(el.classList.contains('opacity-100')).toBe(false)
}

function expectRevealed(el: HTMLIFrameElement = mustFrame()): void {
  expect(el.getAttribute('data-revealed')).toBe('')
  expect(el.classList.contains('opacity-100')).toBe(true)
  expect(el.classList.contains('opacity-0')).toBe(false)
  expect(el.classList.contains('pointer-events-none')).toBe(false)
}

function post(data: unknown, source: MessageEventSource | null): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source }))
  })
}

function load(el: HTMLIFrameElement = mustFrame()): void {
  act(() => {
    el.dispatchEvent(new Event('load'))
  })
}

beforeAll(async () => {
  await initEnI18n()
  ;(window as unknown as { api: unknown }).api = api
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  flags.web = false
  api.app.platform = 'darwin'
  openCall = deferred()
  startCalls = []
  api.widget.open.mockReset().mockImplementation(() => openCall.promise)
  api.widget.startWidget.mockReset().mockImplementation(() => {
    const d = deferred()
    startCalls.push(d)
    return d.promise
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  if (mounted) unmount()
  container.remove()
  document.body.innerHTML = ''
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WF-1 挂载', () => {
  it('WF-1 open 一次、startWidget 不调；没有 iframe；转圈 399ms 没有、400ms 出', () => {
    render()
    expect(api.widget.open).toHaveBeenCalledTimes(1)
    expect(api.widget.open).toHaveBeenCalledWith('w1')
    expect(api.widget.startWidget).not.toHaveBeenCalled()
    expect(frame()).toBeNull()
    advance(399)
    expect(spinner()).toBeNull()
    expect(frame()).toBeNull()
    advance(1)
    expect(spinner()).not.toBeNull()
    expect(spinner()!.textContent).toContain(en.widgets.windowStarting)
  })
})

describe('WF-2 / WF-3 地址到了、信号揭开', () => {
  it('WF-2 iframe 指向地址、透明、点不着；快的打开没有转圈；onWidget 收到摘要', async () => {
    const onWidget = vi.fn()
    render(0, onWidget)
    await settle(openCall, ok())
    const el = mustFrame()
    expect(el.getAttribute('src')).toBe(URL_1)
    expect(el.getAttribute('data-widget-frame')).toBe('w1')
    expect(el.getAttribute('title')).toBe('Widget One')
    expect(el.hasAttribute('sandbox')).toBe(false)
    expectHidden(el)
    expect(spinner()).toBeNull()
    expect(onWidget).toHaveBeenCalledTimes(1)
    expect(onWidget).toHaveBeenCalledWith(summary('w1'))
  })

  it('WF-3 自己的 iframe 发来信号 → 揭开、转圈没了；15s 后仍揭开着', async () => {
    render()
    await settle(openCall, ok())
    advance(500)
    expect(spinner()).not.toBeNull()
    expectHidden()
    post(READY, mustFrame().contentWindow)
    expectRevealed()
    expect(spinner()).toBeNull()
    advance(15_000)
    expectRevealed()
    expect(spinner()).toBeNull()
  })
})

describe('WF-4 不认的消息', () => {
  it('WF-4 来源不对、形状不对的都不认；之后对的那条照样揭开', async () => {
    render()
    await settle(openCall, ok())
    const own = mustFrame().contentWindow
    expect(own).not.toBeNull()
    const other = document.createElement('iframe')
    document.body.appendChild(other)
    expect(other.contentWindow).not.toBeNull()
    expect(other.contentWindow).not.toBe(own)

    // 形状对、来源不对
    post(READY, other.contentWindow)
    post(READY, window)
    post(READY, null)
    expectHidden()
    // 来源对、形状不对
    post(WIDGET_READY_MESSAGE, own)
    post({ type: 'other' }, own)
    post(null, own)
    expectHidden()

    advance(2000)
    expectHidden()
    post(READY, own)
    expectRevealed()
  })
})

describe('WF-5 / WF-6 兜底', () => {
  it('WF-5 load 之后 2499ms 还透明、2500ms 揭开；再来一次 load 不会藏回去', async () => {
    render()
    await settle(openCall, ok())
    load()
    advance(2499)
    expectHidden()
    advance(1)
    expectRevealed()
    load()
    expectRevealed()
    advance(3000)
    expectRevealed()
  })

  it('WF-6 没有 load 也没有信号 → 11999ms 还透明、12000ms 揭开', async () => {
    render()
    advance(100) // 地址晚一点到：截止时间从拿到地址算
    await settle(openCall, ok())
    advance(11_999)
    expectHidden()
    advance(1)
    expectRevealed()
    expect(spinner()).toBeNull()
  })
})

describe('WF-7 / WF-8 转圈', () => {
  it('WF-7 地址马上就到、信号迟迟不来：400ms 才出转圈；揭开时没了', async () => {
    render()
    await settle(openCall, ok())
    expect(spinner()).toBeNull()
    advance(399)
    expect(spinner()).toBeNull()
    advance(1)
    expect(spinner()).not.toBeNull()
    expectHidden()
    advance(3000)
    expect(spinner()).not.toBeNull()
    post(READY, mustFrame().contentWindow)
    expect(spinner()).toBeNull()
    expectRevealed()
  })

  it('WF-8 open 挂 600ms：400ms 出转圈，地址到了之后一直在，直到揭开', async () => {
    render()
    advance(400)
    expect(spinner()).not.toBeNull()
    advance(200) // 600
    await settle(openCall, ok())
    expect(frame()).not.toBeNull()
    expect(spinner()).not.toBeNull()
    advance(1) // 601
    expect(spinner()).not.toBeNull()
    advance(398) // 999
    expect(spinner()).not.toBeNull()
    advance(4000)
    expect(spinner()).not.toBeNull()
    expectHidden()
    post(READY, mustFrame().contentWindow)
    expect(spinner()).toBeNull()
    expectRevealed()
  })
})

describe('WF-9 重新加载', () => {
  it('WF-9 新的 iframe 从透明开始；旧 iframe 的信号与 load 兜底都不揭开它；它自己的信号揭开', async () => {
    render()
    await settle(openCall, ok())
    const oldFrame = mustFrame()
    const oldWin = oldFrame.contentWindow
    expect(oldWin).not.toBeNull()
    load(oldFrame) // 兜底在 2500ms
    advance(100)
    post(READY, oldWin)
    expectRevealed(oldFrame)

    advance(900) // 1000
    render(1)
    expect(api.widget.startWidget).toHaveBeenCalledTimes(1)
    expect(api.widget.startWidget).toHaveBeenCalledWith('w1')
    expect(api.widget.open).toHaveBeenCalledTimes(1)
    expect(frame()).toBeNull()

    await settle(startCalls[0], { success: true, url: URL_1 })
    const newFrame = mustFrame()
    expect(newFrame).not.toBe(oldFrame)
    expect(newFrame.getAttribute('src')).toBe(URL_1)
    expectHidden(newFrame)

    post(READY, oldWin)
    expectHidden(newFrame)
    advance(1600) // 2600：旧 iframe 的 load 兜底已经到点
    expectHidden(newFrame)

    post(READY, newFrame.contentWindow)
    expectRevealed(newFrame)
    expect(revealed(newFrame)).toBe(true)
  })
})

describe('WF-10 出错与重试', () => {
  it('WF-10a open 失败 → 错误文字 + 重试，没有 iframe，1s 后也没有转圈', async () => {
    render()
    await settle(openCall, { success: false, error: 'boom' })
    expect(container.textContent).toContain('boom')
    expect(container.textContent).toContain(en.widgets.windowStartFailed)
    const retry = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === en.widgets.windowRetry
    )
    expect(retry).toBeDefined()
    expect(frame()).toBeNull()
    advance(1000)
    expect(spinner()).toBeNull()
    expect(frame()).toBeNull()
  })

  it('WF-10b 点重试 → startWidget（open 一共一次）；400ms 出转圈；回来是透明的 iframe，它的信号揭开', async () => {
    render()
    await settle(openCall, { success: false, error: 'boom' })
    advance(1000)
    const retry = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === en.widgets.windowRetry
    )!
    act(() => retry.click())
    expect(api.widget.startWidget).toHaveBeenCalledTimes(1)
    expect(api.widget.startWidget).toHaveBeenCalledWith('w1')
    expect(api.widget.open).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('boom')
    advance(399)
    expect(spinner()).toBeNull()
    advance(1)
    expect(spinner()).not.toBeNull()

    await settle(startCalls[0], { success: true, url: URL_1 })
    expectHidden()
    expect(spinner()).not.toBeNull()
    post(READY, mustFrame().contentWindow)
    expectRevealed()
    expect(spinner()).toBeNull()
  })

  it('WF-10c open 成功但没有地址 → Server stopped，没有 iframe', async () => {
    render()
    await settle(openCall, ok(null))
    expect(container.textContent).toContain(en.widgets.serverStopped)
    expect(frame()).toBeNull()
    advance(1000)
    expect(spinner()).toBeNull()
  })
})

describe('WF-11 web 客户端', () => {
  it('WF-11 sandbox 是 web 那串、没有 allow-same-origin；自己的信号照样揭开', async () => {
    flags.web = true
    api.app.platform = 'web'
    render()
    await settle(openCall, ok())
    const el = mustFrame()
    expect(el.getAttribute('sandbox')).toBe(WEB_SANDBOX)
    expect(el.getAttribute('sandbox')).not.toContain('allow-same-origin')
    // 经网络服务的 /w/ 转发
    expect(el.getAttribute('src')).toBe(`${window.location.origin}/w/w1/`)
    expectHidden(el)
    post(READY, el.contentWindow)
    expectRevealed(el)
  })
})

describe('WF-12 等的中途卸载', () => {
  it('WF-12 地址到了、load 兜底与截止都挂着时卸载 → 没有错误；message 监听摘掉了', async () => {
    const consoleError = vi.spyOn(console, 'error')
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    render()
    await settle(openCall, ok())
    const el = mustFrame()
    const win = el.contentWindow
    load(el)
    const handlers = added.mock.calls.filter(([type]) => type === 'message').map(([, fn]) => fn)
    expect(handlers).toHaveLength(1)

    unmount()
    expect(removed.mock.calls.some(([type, fn]) => type === 'message' && fn === handlers[0])).toBe(
      true
    )
    expect(() => advance(15_000)).not.toThrow()
    expect(() => post(READY, win)).not.toThrow()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('WF-12 open 还没回来就卸载，之后才回来 → 没有错误', async () => {
    const consoleError = vi.spyOn(console, 'error')
    render()
    advance(500)
    unmount()
    await settle(openCall, ok())
    expect(() => advance(15_000)).not.toThrow()
    expect(consoleError).not.toHaveBeenCalled()
    expect(container.querySelector('iframe')).toBeNull()
  })
})
