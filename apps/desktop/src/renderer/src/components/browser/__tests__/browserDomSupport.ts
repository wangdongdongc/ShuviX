/**
 * 浏览器窗口渲染层 DOM 单测共用的几样东西（不是用例文件 —— 桌面 vitest 只收 `*.test.ts`）。
 *
 *  - `initEnI18n`：真的 en 资源（文案按产品里的英文断）；
 *  - `installFakeApi`：`window.api` 的浏览器窗口那几块（browserView 的动作是间谍、on* 记下回调，
 *    contextMenu.popup 回用例钉好的 actionId，app / settings / events / browserData 够组件跑起来）；
 *  - `installRaf`：requestAnimationFrame 换成 setTimeout(0)（jsdom 没有可靠的帧；组件在一帧之后才读
 *    刚挂上的 input / 布局，同步执行的话那一刻节点还没挂上），`flush` 把排着的帧跑完；
 *  - ResizeObserver / scrollIntoView / getBoundingClientRect 的桩（jsdom 没有 / 回全 0）；
 *  - `tabInfo`：一行 BrowserTabInfo；`mountInto` / `typeInto` / `keyDown` / `mouseDown`。
 *
 * 一律 createElement（桌面 vitest 不带 react 插件）。
 */
import { act, createElement, type FunctionComponent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { vi, type Mock } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { BrowserTabInfo } from '../../../stores/browserTabsStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

export async function initEnI18n(): Promise<void> {
  if (i18n.isInitialized) {
    await i18n.changeLanguage('en')
    return
  }
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
}

export function tabInfo(over: Partial<BrowserTabInfo> & { id: string }): BrowserTabInfo {
  return {
    url: 'https://example.com/',
    title: '',
    isLoading: false,
    loadError: null,
    cdpAttached: false,
    cdpIntercepting: false,
    canGoBack: false,
    canGoForward: false,
    zoomPercent: 100,
    ...over
  }
}

export type Callback = (payload: Record<string, unknown>) => void

export interface FakeApi {
  browserView: Record<string, Mock>
  /** on* 收下的回调（按方法名） */
  callbacks: Record<string, Callback>
  contextMenu: { popup: Mock }
  app: Record<string, unknown> & { openExternal: Mock; openSettings: Mock; windowReady: Mock }
  settings: { getAll: Mock; set: Mock }
  events: { subscribe: Mock }
  browserData: { listSites: Mock; clearSite: Mock; clearAll: Mock }
  /** 下一次菜单弹出时「选」哪一项（null = 取消）；弹一次清一次 */
  menuPick: string | null
  /** settings.getAll 回什么 */
  settingsMap: Record<string, string>
}

const ON_METHODS = [
  'onTabCreated',
  'onTabClosed',
  'onTabActivated',
  'onTabTitleUpdated',
  'onTabFaviconUpdated',
  'onTabCdpState',
  'onTabAgent',
  'onTabZoom',
  'onCommand',
  'onDidStartLoading',
  'onDidNavigate',
  'onDidStopLoading',
  'onDidFailLoad'
] as const

const ACTIONS = [
  'createTab',
  'closeTab',
  'reopenClosedTab',
  'activateTab',
  'navigate',
  'goBack',
  'goForward',
  'reload',
  'stop',
  'zoom',
  'openSession',
  'setLayout',
  'setVisible',
  'capture'
] as const

export function installFakeApi(platform = 'darwin'): FakeApi {
  const callbacks: Record<string, Callback> = {}
  const browserView: Record<string, Mock> = {}
  for (const name of ACTIONS) browserView[name] = vi.fn(async () => undefined)
  browserView.capture.mockImplementation(async () => '')
  browserView.listTabs = vi.fn(async () => [])
  for (const name of ON_METHODS) {
    browserView[name] = vi.fn((cb: Callback) => {
      callbacks[name] = cb
      return () => {
        delete callbacks[name]
      }
    })
  }
  const api: FakeApi = {
    browserView,
    callbacks,
    contextMenu: { popup: vi.fn() },
    app: {
      platform,
      openExternal: vi.fn(async () => undefined),
      openSettings: vi.fn(async () => undefined),
      windowReady: vi.fn()
    },
    settings: { getAll: vi.fn(), set: vi.fn(async () => undefined) },
    events: { subscribe: vi.fn(() => () => undefined) },
    browserData: {
      listSites: vi.fn(async () => []),
      clearSite: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined)
    },
    menuPick: null,
    settingsMap: {}
  }
  api.contextMenu.popup.mockImplementation(async () => {
    const actionId = api.menuPick
    api.menuPick = null
    return { actionId }
  })
  api.settings.getAll.mockImplementation(async () => ({ ...api.settingsMap }))
  ;(window as unknown as { api: unknown }).api = api
  return api
}

/** 最近一次菜单弹出的项（分隔符记作 `---`，其余记 id） */
export function lastMenu(api: FakeApi): Array<{
  id: string
  label?: string
  enabled?: boolean
}> {
  const calls = api.contextMenu.popup.mock.calls
  if (calls.length === 0) throw new Error('no context menu popped')
  const items = (calls[calls.length - 1][0] as { items: Array<Record<string, unknown>> }).items
  return items.map((it) =>
    it.type === 'separator'
      ? { id: '---' }
      : {
          id: String(it.id),
          label: it.label as string | undefined,
          ...(it.enabled === undefined ? {} : { enabled: it.enabled as boolean })
        }
  )
}

/** requestAnimationFrame → setTimeout(0)；cancelAnimationFrame 对应 clearTimeout */
export function installRaf(): void {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(performance.now()), 0)) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((id: number) =>
    window.clearTimeout(id)) as typeof window.cancelAnimationFrame
}

/** 把排着的帧、微任务与状态更新跑完（几轮：一帧里可能又排了下一帧） */
export async function flush(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** jsdom 没有 ResizeObserver：一个什么也不报的桩 */
export function installResizeObserver(): void {
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
}

/** 所有元素的 getBoundingClientRect 都回这个矩形（jsdom 缺省全 0，布局同步会把页面当成没尺寸） */
export function stubRects(rect: { x: number; y: number; width: number; height: number }): void {
  const full = {
    ...rect,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON: () => rect
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => full as DOMRect)
}

export function stubScrollIntoView(): Mock {
  const fn = vi.fn()
  ;(HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = fn
  return fn
}

export interface Mounted {
  container: HTMLDivElement
  root: Root
  unmount(): void
}

export async function mountInto<P extends object>(
  component: FunctionComponent<P>,
  props: P
): Promise<Mounted> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(component, props))
  })
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    }
  }
}

/** 往受控 input 里「打」一段字（走原生 value setter + input 事件，React 才认） */
export function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

export function keyDown(el: Element, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    )
  })
}

export function mouseDown(el: Element, button = 0): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true, cancelable: true }))
  })
}

export function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
