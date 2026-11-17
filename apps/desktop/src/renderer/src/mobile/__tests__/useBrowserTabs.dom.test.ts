// @vitest-environment jsdom
/**
 * 那台电脑上浏览器的标签页清单（mobile/useBrowserTabs.ts，jsdom）。
 *
 * 契约：挂上取一次 `browserView.listTabs()`；`reload()` 与 app 事件 `browser.tabsChanged` 各重新取一次；取不到时
 * `listError` 是那句话（`remote_url_refused` 换成本地化的说法），`tabs` 保持上一次的样子（一次都没取到就是 null）；
 * 取到了就清掉 `listError`；只认最新一次的结果，卸载之后回来的不写。
 *
 *   UT-1..4  头一次：还没回来 / 回来了 / 被拒 / 地址被拒的本地化说法
 *   UT-5..6  reload、browser.tabsChanged
 *   UT-7     错误与成功交替
 *   UT-8     晚回来的旧结果、卸载之后的结果
 *
 * `window.api` 是 browserDomSupport 的假件；@shuvix/chat-ui 是真的（useAppEvent 退回 window.api.events）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect } from 'react'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { useBrowserTabs, type BrowserTabsState } from '../useBrowserTabs'
import type { TabRow } from '../../components/browser/tabsManagerPure'
import {
  flush,
  initEnI18n,
  installFakeApi,
  mountInto,
  type FakeApi,
  type Mounted
} from '../../components/browser/__tests__/browserDomSupport'

let api: FakeApi
let m: Mounted | null = null
let subscribers: Set<(event: { type: string }) => void>
let latest: BrowserTabsState

const row = (id: string, over: Partial<TabRow> = {}): TabRow =>
  ({
    id,
    url: 'https://example.com/',
    title: '',
    active: false,
    cdpAttached: false,
    cdpIntercepting: false,
    crashed: false,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoomPercent: 100,
    agentDevtoolsCalls: 0,
    ...over
  }) as TabRow

function Probe(): null {
  const state = useBrowserTabs()
  useEffect(() => {
    latest = state
  })
  return null
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function mount(): Promise<void> {
  m = await mountInto(Probe, {})
}
async function emit(type: string): Promise<void> {
  await act(async () => {
    for (const fn of [...subscribers]) fn({ type })
  })
  await flush()
}
const ids = (): string[] | null => latest.tabs?.map((tab) => tab.id) ?? null
const calls = (): number => api.browserView.listTabs.mock.calls.length

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  subscribers = new Set()
  api.events.subscribe.mockImplementation((fn: (event: { type: string }) => void) => {
    subscribers.add(fn)
    return () => {
      subscribers.delete(fn)
    }
  })
})

afterEach(() => {
  m?.unmount()
  m = null
  vi.restoreAllMocks()
})

describe('头一次（UT-1 … UT-4）', () => {
  it('UT-1 还没回来：tabs 是 null、没有错误；listTabs 调一次', async () => {
    api.browserView.listTabs.mockReturnValue(deferred<TabRow[]>().promise)
    await mount()
    expect(latest.tabs).toBeNull()
    expect(latest.listError).toBeNull()
    expect(calls()).toBe(1)
  })

  it('UT-2 回来了 → tabs 就是那份清单', async () => {
    api.browserView.listTabs.mockResolvedValue([row('a'), row('b')])
    await mount()
    await flush()
    expect(ids()).toEqual(['a', 'b'])
    expect(latest.listError).toBeNull()
  })

  it('UT-3 被拒 → listError 是那句话，tabs 还是 null', async () => {
    api.browserView.listTabs.mockRejectedValue(new Error('NB prompt'))
    await mount()
    await flush()
    expect(latest.listError).toBe('NB prompt')
    expect(latest.tabs).toBeNull()
  })

  it('UT-4 code 是 remote_url_refused → 本地化的那句', async () => {
    api.browserView.listTabs.mockRejectedValue(
      Object.assign(new Error('raw server text'), { code: 'remote_url_refused' })
    )
    await mount()
    await flush()
    expect(latest.listError).toBe(en.browser.manager.remoteUrlRefused)
  })
})

describe('重新取（UT-5 … UT-6）', () => {
  it('UT-5 reload() → 再取一次，新清单换掉旧的', async () => {
    api.browserView.listTabs.mockResolvedValueOnce([row('a')]).mockResolvedValueOnce([row('b')])
    await mount()
    await flush()
    expect(ids()).toEqual(['a'])
    act(() => latest.reload())
    await flush()
    expect(calls()).toBe(2)
    expect(ids()).toEqual(['b'])
  })

  it('UT-6 browser.tabsChanged → 再取；别的事件不取', async () => {
    api.browserView.listTabs.mockResolvedValueOnce([row('a')]).mockResolvedValueOnce([row('c')])
    await mount()
    await flush()
    await emit('settings.changed')
    expect(calls()).toBe(1)
    await emit('browser.tabsChanged')
    expect(calls()).toBe(2)
    expect(ids()).toEqual(['c'])
  })
})

describe('错误与成功交替（UT-7）', () => {
  it('UT-7 错误之后取到了 → 错误清掉；取到之后出错 → 清单留着、写上错误', async () => {
    api.browserView.listTabs
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce([row('a')])
      .mockRejectedValueOnce(new Error('later'))
    await mount()
    await flush()
    expect(latest.listError).toBe('first')

    act(() => latest.reload())
    await flush()
    expect(latest.listError).toBeNull()
    expect(ids()).toEqual(['a'])

    act(() => latest.reload())
    await flush()
    expect(latest.listError).toBe('later')
    expect(ids()).toEqual(['a'])
  })
})

describe('晚回来的结果（UT-8）', () => {
  it('UT-8 两次都在路上，旧的后回来 → 不盖掉新的', async () => {
    const first = deferred<TabRow[]>()
    const second = deferred<TabRow[]>()
    api.browserView.listTabs.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await mount()
    act(() => latest.reload())
    await flush()
    expect(calls()).toBe(2)

    second.resolve([row('new')])
    await flush()
    expect(ids()).toEqual(['new'])
    first.resolve([row('old')])
    await flush()
    expect(ids()).toEqual(['new'])
  })

  it('UT-8 旧的那次晚回来是被拒 → 也不写错误', async () => {
    const first = deferred<TabRow[]>()
    api.browserView.listTabs.mockReturnValueOnce(first.promise).mockResolvedValueOnce([row('new')])
    await mount()
    act(() => latest.reload())
    await flush()
    first.reject(new Error('stale'))
    await flush()
    expect(ids()).toEqual(['new'])
    expect(latest.listError).toBeNull()
  })

  it('UT-8 卸载之后才回来 → 不写、没有警告', async () => {
    const pending = deferred<TabRow[]>()
    api.browserView.listTabs.mockReturnValue(pending.promise)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await mount()
    const before = latest
    m!.unmount()
    m = null
    pending.resolve([row('late')])
    await flush()
    expect(latest).toBe(before)
    expect(latest.tabs).toBeNull()
    expect(errors).not.toHaveBeenCalled()
  })
})
