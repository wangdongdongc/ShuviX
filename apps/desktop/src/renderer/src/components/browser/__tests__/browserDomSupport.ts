/**
 * 浏览器窗口渲染层 DOM 单测共用的几样东西（不是用例文件 —— 桌面 vitest 只收 `*.test.ts`）。
 *
 *  - `initEnI18n`：真的 en 资源（文案按产品里的英文断）；
 *  - `installFakeApi`：`window.api` 的浏览器窗口那几块（browserView 的动作是间谍、on* 记下回调，
 *    contextMenu.popup 回用例钉好的 actionId，app / settings / events / browserData 够组件跑起来）；
 *  - `installRaf`：requestAnimationFrame 换成 setTimeout(0)（jsdom 没有可靠的帧；组件在一帧之后才读
 *    刚挂上的 input / 布局，同步执行的话那一刻节点还没挂上），`flush` 把排着的帧跑完；
 *  - ResizeObserver / scrollIntoView / getBoundingClientRect 的桩（jsdom 没有 / 回全 0）：
 *    `installResizeObserver` 回一个手动触发器（`trigger(el)` 只叫醒还在看着 el 的观察者，observe 时不报），
 *    `stubRects` 所有元素同一个矩形、`stubRectsBy` 按元素给矩形，`stubInnerHeight` 改 window.innerHeight；
 *  - `tabInfo`：一行 BrowserTabInfo；`mountInto` / `typeInto` / `keyDown` / `mouseDown`；
 *  - 拖动：`mouseMove`（document 上，带 buttons）/ `mouseUp`（document 上）/ `windowBlur`。
 *
 * 一律 createElement（桌面 vitest 不带 react 插件）。
 */
import { act, createElement, type FunctionComponent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { vi, type Mock, type MockInstance } from 'vitest'
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
    agentDevtoolsCalls: 0,
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
  browserData: {
    listSites: Mock
    clearSite: Mock
    /** 缺省回 null（这个网站没有数据） */
    siteDetails: Mock
    clearSiteCategory: Mock
    clearOrigin: Mock
    removeCookie: Mock
    clearAll: Mock
    siteInfo: Mock
    clearSiteData: Mock
    certExceptions: Mock
  }
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
  'onTabDevtools',
  'onAgentDevtoolsChanged',
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
  'openSettings',
  'openInternal',
  'proceedUnsafe',
  'setLayout',
  'setVisible',
  'capture',
  'openDevtools',
  'closeDevtools',
  'setDevtoolsLayout',
  'clearAgentDevtools'
] as const

export function installFakeApi(platform = 'darwin'): FakeApi {
  const callbacks: Record<string, Callback> = {}
  const browserView: Record<string, Mock> = {}
  for (const name of ACTIONS) browserView[name] = vi.fn(async () => undefined)
  browserView.capture.mockImplementation(async () => '')
  browserView.listTabs = vi.fn(async () => [])
  browserView.agentDevtools = vi.fn(async () => ({
    calls: [],
    attached: false,
    capturing: { network: false, console: false },
    network: [],
    console: []
  }))
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
      siteDetails: vi.fn(async () => null),
      clearSiteCategory: vi.fn(async () => undefined),
      clearOrigin: vi.fn(async () => undefined),
      removeCookie: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => undefined),
      siteInfo: vi.fn(async () => ({ cookieCount: 0, certException: false })),
      clearSiteData: vi.fn(async () => undefined),
      certExceptions: vi.fn(async () => [])
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

/** ResizeObserver 桩的手动触发器 */
export interface ResizeObserverControl {
  /** 叫醒还在看着 el 的观察者（没 disconnect、没 unobserve 它），在 act 里同步跑它们的回调 */
  trigger(el: Element): void
  /** 此刻还在看着 el 的观察者个数 */
  observing(el: Element): number
}

/**
 * jsdom 没有 ResizeObserver：一个自己从不报的桩（observe 时也不报 —— 真的 ResizeObserver 会报一次初始尺寸，
 * 这里不模拟），用例要它报时用回的 `trigger(el)`。
 */
export function installResizeObserver(): ResizeObserverControl {
  const live = new Set<RO>()
  class RO {
    readonly targets = new Set<Element>()
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(el: Element): void {
      this.targets.add(el)
      live.add(this)
    }
    unobserve(el: Element): void {
      this.targets.delete(el)
    }
    disconnect(): void {
      this.targets.clear()
      live.delete(this)
    }
    fire(el: Element): void {
      const entry = { target: el, contentRect: el.getBoundingClientRect() } as ResizeObserverEntry
      this.callback([entry], this as unknown as ResizeObserver)
    }
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  const watching = (el: Element): RO[] => [...live].filter((ro) => ro.targets.has(el))
  return {
    trigger(el) {
      const observers = watching(el)
      act(() => {
        for (const ro of observers) ro.fire(el)
      })
    },
    observing: (el) => watching(el).length
  }
}

type RectLike = { x: number; y: number; width: number; height: number }

function domRect(rect: RectLike): DOMRect {
  return {
    ...rect,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON: () => rect
  } as DOMRect
}

/** getBoundingClientRect 的间谍（同一个用例里再桩一次就换实现，不叠第二层） */
function rectSpy(): MockInstance<(this: HTMLElement) => DOMRect> {
  const current = HTMLElement.prototype.getBoundingClientRect
  if (vi.isMockFunction(current)) {
    return current as unknown as MockInstance<(this: HTMLElement) => DOMRect>
  }
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect') as unknown as MockInstance<
    (this: HTMLElement) => DOMRect
  >
}

/** 所有元素的 getBoundingClientRect 都回这个矩形（jsdom 缺省全 0，布局同步会把页面当成没尺寸） */
export function stubRects(rect: RectLike): void {
  const full = domRect(rect)
  rectSpy().mockImplementation(() => full)
}

/** 按元素给 getBoundingClientRect 的矩形（同一个用例里可以再调一次换掉） */
export function stubRectsBy(rectOf: (el: HTMLElement) => RectLike): void {
  rectSpy().mockImplementation(function (this: HTMLElement) {
    return domRect(rectOf(this))
  })
}

let savedInnerHeight: PropertyDescriptor | undefined | null = null

/** window.innerHeight 改成 h（restoreInnerHeight 还原；没改过时还原什么也不做） */
export function stubInnerHeight(h: number): void {
  if (savedInnerHeight === null) {
    savedInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  }
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: h })
}

export function restoreInnerHeight(): void {
  if (savedInnerHeight === null) return
  if (savedInnerHeight) Object.defineProperty(window, 'innerHeight', savedInnerHeight)
  else delete (window as unknown as { innerHeight?: number }).innerHeight
  savedInnerHeight = null
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

/** 在 el 上按下鼠标；回派发的事件（`defaultPrevented` 看组件拦没拦） */
export function mouseDown(el: Element, button = 0, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('mousedown', {
    button,
    buttons: button === 0 ? 1 : button === 1 ? 4 : button === 2 ? 2 : 0,
    bubbles: true,
    cancelable: true,
    ...init
  })
  act(() => {
    el.dispatchEvent(event)
  })
  return event
}

/** document 上的一次 mousemove（拖动中的鼠标；buttons 缺省 1 = 左键还按着） */
export function mouseMove(clientY: number, buttons = 1): void {
  act(() => {
    document.dispatchEvent(
      new MouseEvent('mousemove', { clientY, buttons, bubbles: true, cancelable: true })
    )
  })
}

/** document 上的 mouseup */
export function mouseUp(): void {
  act(() => {
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
  })
}

/** 窗口失去焦点 */
export function windowBlur(): void {
  act(() => {
    window.dispatchEvent(new FocusEvent('blur'))
  })
}

export function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
