// @vitest-environment jsdom
/**
 * 浏览器 tab 状态桥（useBrowserTabsBridge）—— 页面的渲染进程崩了（CR-U17）。
 *
 * 崩溃靠两条路到卡片上：
 *   - 实时：主进程的 did-fail-load 带 `crashed: true` → 镜像的 loadError 原样带上 crashed（普通的加载失败
 *     **没有**这个键 —— 卡片据它分「页面崩溃了」与「无法访问」）；重新加载开始（did-start-loading）清掉它；
 *   - 水合：浏览器窗口晚于崩溃才打开（崩溃事件当时没人收），listTabs 的行带 `crashed` → 补一条
 *     `{ errorCode 0, errorDescription 'crashed', url, crashed: true }`；没崩的行 loadError 为 null。
 *
 * Chrome 化之后（CB-U37…39）：
 *   CB-U37  地址栏只在用户的动作之后聚焦：tab-created **从不**加 omniboxFocusNonce（连 `{about:blank, active:true}`
 *           也不加 —— 空浏览器里 agent 开的第一个 tab 长得一模一样）；只有 `browser-view:command {focusOmnibox}`
 *           加一次，不认识的命令不动；
 *   CB-U38  tab-agent 记下会话与时刻（agentActiveAt，圆点据此脉动）；tab-zoom 改 zoomPercent；did-navigate
 *           只带地址时只改地址（后退 / 前进 / 缩放留着），全量时全改；tab-closed 的 activeTabId 照主进程给的；
 *   CB-U39  水合：loading → isLoading，后退 / 前进 / 缩放 / agent 会话照抄；**不**给 agentActiveAt（重开窗口
 *           不脉动）。
 *
 * `window.api.browserView` 是假的：每个 on* 记下回调（用例直接调它当作主进程发来的事件），listTabs 由用例
 * 决定回什么。挂一个只调这个 hook 的小组件；store 每条用例清空。桌面 vitest 对渲染层只收 `*.test.ts`
 * （本文件自己切 jsdom），不带 react 插件 —— 一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useBrowserTabsBridge } from '../useBrowserTabsBridge'
import { useBrowserTabsStore, type BrowserTabInfo } from '../../stores/browserTabsStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Callback = (payload: Record<string, unknown>) => void

interface ListedTab {
  id: string
  url: string
  title: string
  active: boolean
  cdpAttached: boolean
  cdpIntercepting: boolean
  crashed: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  zoomPercent: number
  agentSessionId?: string
  agentSessionTitle?: string
  openerSessionId?: string
}

/** 每个 on* 收下的回调（按方法名） */
let callbacks: Record<string, Callback> = {}
let listed: Promise<ListedTab[]> = Promise.resolve([])
let container: HTMLDivElement
let root: Root

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

function fakeBrowserViewApi(): Record<string, unknown> {
  const api: Record<string, unknown> = { listTabs: vi.fn(() => listed) }
  for (const name of ON_METHODS) {
    api[name] = (cb: Callback) => {
      callbacks[name] = cb
      return () => {
        delete callbacks[name]
      }
    }
  }
  return api
}

/** 主进程发来一条事件（在 act 里，store 的订阅者跟着更新） */
function fire(name: (typeof ON_METHODS)[number], payload: Record<string, unknown>): void {
  const cb = callbacks[name]
  if (!cb) throw new Error(`${name} was not subscribed`)
  act(() => cb(payload))
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function Probe(): null {
  useBrowserTabsBridge()
  return null
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe))
  })
  await flush()
}

const tab = (id: string): BrowserTabInfo | undefined =>
  useBrowserTabsStore.getState().tabs.find((t) => t.id === id)

const PAGE_URL = 'https://x.test/page'

beforeEach(() => {
  callbacks = {}
  listed = Promise.resolve([])
  useBrowserTabsStore.setState({ tabs: [], activeTabId: null, omniboxFocusNonce: 0 })
  ;(window as unknown as { api: unknown }).api = { browserView: fakeBrowserViewApi() }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('实时：主进程报来的崩溃（CR-U17）', () => {
  it('CR-U17 did-fail-load 带 crashed → loadError 原样带上 crashed、spinner 熄灭；did-start-loading 清掉它', async () => {
    await mount()
    fire('onTabCreated', { tabId: 't1', url: PAGE_URL, active: true })
    fire('onDidStartLoading', { tabId: 't1' })
    expect(tab('t1')?.isLoading).toBe(true)

    fire('onDidFailLoad', {
      tabId: 't1',
      errorCode: 0,
      errorDescription: 'crashed',
      url: PAGE_URL,
      crashed: true
    })
    expect(tab('t1')?.loadError).toStrictEqual({
      errorCode: 0,
      errorDescription: 'crashed',
      url: PAGE_URL,
      crashed: true
    })
    expect(tab('t1')?.isLoading).toBe(false)

    // 重新加载开始：卡片换回页面
    fire('onDidStartLoading', { tabId: 't1' })
    expect(tab('t1')?.loadError).toBeNull()
  })

  it('CR-U17 对照：普通的加载失败（没带 crashed）→ loadError 没有 crashed 这个键', async () => {
    await mount()
    fire('onTabCreated', { tabId: 't1', url: PAGE_URL, active: true })
    fire('onDidFailLoad', {
      tabId: 't1',
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      url: PAGE_URL
    })
    expect(tab('t1')?.loadError).toStrictEqual({
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      url: PAGE_URL
    })
    expect(tab('t1')?.loadError).not.toHaveProperty('crashed')
  })
})

describe('水合：浏览器窗口晚于崩溃才打开（CR-U17）', () => {
  it('CR-U17 listTabs 的行带 crashed → 补上「崩了」的 loadError（原因已经不知道了）；没崩的行 loadError 为 null', async () => {
    const row = (id: string, url: string, crashed: boolean): ListedTab => ({
      id,
      url,
      title: '',
      active: id === 't1',
      cdpAttached: false,
      cdpIntercepting: false,
      crashed,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100
    })
    listed = Promise.resolve([
      row('t1', 'https://crashed.test/', true),
      row('t2', 'https://fine.test/', false)
    ])
    await mount()

    expect(useBrowserTabsStore.getState().tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(tab('t1')?.loadError).toStrictEqual({
      errorCode: 0,
      errorDescription: 'crashed',
      url: 'https://crashed.test/',
      crashed: true
    })
    expect(tab('t2')?.loadError).toBeNull()
    expect(useBrowserTabsStore.getState().activeTabId).toBe('t1')
  })
})

describe('地址栏只在用户的动作之后聚焦（CB-U37）', () => {
  const nonce = (): number => useBrowserTabsStore.getState().omniboxFocusNonce

  it('CB-U37 tab-created 从不加 nonce —— 连 {about:blank, active:true} 也不加', async () => {
    await mount()
    fire('onTabCreated', { tabId: 't1', url: 'about:blank', active: true })
    fire('onTabCreated', { tabId: 't2', url: 'https://a.test/', active: true })
    fire('onTabCreated', { tabId: 't3', url: 'about:blank', active: false })
    expect(nonce()).toBe(0)
    expect(useBrowserTabsStore.getState().activeTabId).toBe('t2')
  })

  it('CB-U37 command focusOmnibox → nonce +1；不认识的命令不动', async () => {
    await mount()
    fire('onCommand', { command: 'focusOmnibox' })
    expect(nonce()).toBe(1)
    fire('onCommand', { command: 'somethingElse' })
    fire('onCommand', {})
    expect(nonce()).toBe(1)
    fire('onCommand', { command: 'focusOmnibox' })
    expect(nonce()).toBe(2)
  })
})

describe('agent 标记、缩放、导航、关闭（CB-U38）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('CB-U38 tab-agent → agentSessionId / agentSessionTitle / agentActiveAt（= 此刻）；再来一次刷新时刻', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(1_000_000))
    await mount()
    fire('onTabCreated', { tabId: 't1', url: PAGE_URL, active: true })
    fire('onTabAgent', { tabId: 't1', sessionId: 's1', sessionTitle: 'Alpha' })
    expect(tab('t1')).toMatchObject({
      agentSessionId: 's1',
      agentSessionTitle: 'Alpha',
      agentActiveAt: 1_000_000
    })
    vi.setSystemTime(new Date(1_005_000))
    fire('onTabAgent', { tabId: 't1', sessionId: 's2', sessionTitle: 'Beta' })
    expect(tab('t1')).toMatchObject({
      agentSessionId: 's2',
      agentSessionTitle: 'Beta',
      agentActiveAt: 1_005_000
    })
  })

  it('CB-U38 tab-zoom → zoomPercent', async () => {
    await mount()
    fire('onTabCreated', { tabId: 't1', url: PAGE_URL, active: true })
    expect(tab('t1')?.zoomPercent).toBe(100)
    fire('onTabZoom', { tabId: 't1', zoomPercent: 125 })
    expect(tab('t1')?.zoomPercent).toBe(125)
  })

  it('CB-U38 did-navigate 只带 {tabId, url}：只改地址；全量：全改', async () => {
    await mount()
    fire('onTabCreated', { tabId: 't1', url: PAGE_URL, active: true })
    fire('onDidNavigate', {
      tabId: 't1',
      url: 'https://x.test/one',
      canGoBack: true,
      canGoForward: true,
      zoomPercent: 150
    })
    expect(tab('t1')).toMatchObject({
      url: 'https://x.test/one',
      canGoBack: true,
      canGoForward: true,
      zoomPercent: 150
    })

    fire('onDidNavigate', { tabId: 't1', url: 'https://y.test/two' })
    expect(tab('t1')).toMatchObject({
      url: 'https://y.test/two',
      canGoBack: true,
      canGoForward: true,
      zoomPercent: 150
    })

    fire('onDidNavigate', {
      tabId: 't1',
      url: 'https://y.test/two',
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100
    })
    expect(tab('t1')).toMatchObject({ canGoBack: false, canGoForward: false, zoomPercent: 100 })
  })

  it('CB-U38 tab-closed：activeTabId 照主进程给的（包括 null）', async () => {
    await mount()
    fire('onTabCreated', { tabId: 't1', url: PAGE_URL, active: true })
    fire('onTabCreated', { tabId: 't2', url: PAGE_URL, active: false })
    fire('onTabCreated', { tabId: 't3', url: PAGE_URL, active: false })
    fire('onTabClosed', { tabId: 't1', activeTabId: 't3' })
    expect(useBrowserTabsStore.getState().activeTabId).toBe('t3')
    expect(useBrowserTabsStore.getState().tabs.map((t) => t.id)).toEqual(['t2', 't3'])
    fire('onTabClosed', { tabId: 't3', activeTabId: 't2' })
    fire('onTabClosed', { tabId: 't2', activeTabId: null })
    expect(useBrowserTabsStore.getState().activeTabId).toBeNull()
    expect(useBrowserTabsStore.getState().tabs).toEqual([])
  })
})

describe('水合带上 Chrome 化的字段（CB-U39）', () => {
  it('CB-U39 loading → isLoading；后退 / 前进 / 缩放 / agent 会话照抄；不给 agentActiveAt', async () => {
    listed = Promise.resolve([
      {
        id: 't1',
        url: 'https://a.test/',
        title: 'A',
        active: false,
        cdpAttached: true,
        cdpIntercepting: false,
        crashed: false,
        loading: true,
        canGoBack: true,
        canGoForward: false,
        zoomPercent: 125,
        agentSessionId: 's1',
        agentSessionTitle: 'Alpha',
        openerSessionId: 's1'
      },
      {
        id: 't2',
        url: 'https://b.test/',
        title: 'B',
        active: true,
        cdpAttached: false,
        cdpIntercepting: false,
        crashed: false,
        loading: false,
        canGoBack: false,
        canGoForward: true,
        zoomPercent: 100
      }
    ])
    await mount()

    expect(tab('t1')).toMatchObject({
      isLoading: true,
      canGoBack: true,
      canGoForward: false,
      zoomPercent: 125,
      cdpAttached: true,
      agentSessionId: 's1',
      agentSessionTitle: 'Alpha'
    })
    expect(tab('t1')).not.toHaveProperty('agentActiveAt')
    expect(tab('t2')).toMatchObject({
      isLoading: false,
      canGoBack: false,
      canGoForward: true,
      zoomPercent: 100
    })
    expect(tab('t2')).not.toHaveProperty('agentSessionId')
    expect(tab('t2')).not.toHaveProperty('agentActiveAt')
    expect(useBrowserTabsStore.getState().activeTabId).toBe('t2')
  })
})
