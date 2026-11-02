// @vitest-environment jsdom
/**
 * 顶栏的「浏览器窗口」按钮（components/chat/BrowserWindowButton.tsx，2026-11-01 起 web 客户端里也有：在新标签页开浏览器
 * 管理页）。
 *
 *   BWB-1 初值是 listTabs 的条数（2 → 徽标 2）；browser.tabsChanged {count:5} → 5；{count:0} → 没有徽标
 *   BWB-2 listTabs 拒绝（这台设备没有 admin）→ 没有未处理的拒绝、没有徽标；之后的事件 {count:3} → 3
 *   BWB-3 点按钮 → browserView.openWindow() 一次
 *
 * `window.api` 是 browserDomSupport 的假件（events.subscribe 记下订阅者，用例手动派发）；@shuvix/chat-ui 是真的；真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { BrowserWindowButton } from '../BrowserWindowButton'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  mountInto,
  type FakeApi,
  type Mounted
} from '../../browser/__tests__/browserDomSupport'

let api: FakeApi
let m: Mounted | null = null
let subscribers: Set<(event: { type: string; [k: string]: unknown }) => void>

const badge = (): string | null =>
  m!.container.querySelector('[data-browser-tab-count]')?.textContent ?? null
const button = (): HTMLButtonElement =>
  m!.container.querySelector<HTMLButtonElement>('[data-open-browser-window]')!

async function mount(): Promise<void> {
  m = await mountInto(BrowserWindowButton, {})
  await flush()
}

async function emit(event: { type: string; [k: string]: unknown }): Promise<void> {
  await act(async () => {
    for (const fn of [...subscribers]) fn(event)
  })
  await flush()
}

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  api.browserView.openWindow = vi.fn(async () => undefined)
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
})

describe('浏览器窗口按钮（BWB-1 … BWB-3）', () => {
  it('BWB-1 初值 = listTabs 的条数；事件里的 count 跟着变；0 → 没有徽标', async () => {
    api.browserView.listTabs.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    await mount()
    expect(badge()).toBe('2')
    await emit({ type: 'browser.tabsChanged', count: 5 })
    expect(badge()).toBe('5')
    await emit({ type: 'browser.tabsChanged', count: 0 })
    expect(badge()).toBeNull()
  })

  it('BWB-2 listTabs 拒绝：没有未处理的拒绝、没有徽标；之后的事件照样更新', async () => {
    const seen: unknown[] = []
    const onRejection = (reason: unknown): void => void seen.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      api.browserView.listTabs.mockRejectedValue(new Error('This device may not list tabs'))
      await mount()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(seen).toEqual([])
      expect(badge()).toBeNull()
      await emit({ type: 'browser.tabsChanged', count: 3 })
      expect(badge()).toBe('3')
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('BWB-3 点按钮 → browserView.openWindow() 一次', async () => {
    await mount()
    click(button())
    await flush()
    expect(api.browserView.openWindow).toHaveBeenCalledTimes(1)
  })
})
