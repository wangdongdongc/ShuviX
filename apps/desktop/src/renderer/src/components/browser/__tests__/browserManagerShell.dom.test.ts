// @vitest-environment jsdom
/**
 * 浏览器管理页的外壳（BrowserManagerShell，web 客户端的 `#browser-manager[?section=settings]`，2026-11-01）。
 *
 *   MS-1  hash 决定哪一节：`#browser-manager` → 标签页（BrowserTabsManager）；`?section=settings` → 设置
 *         （BrowserSettingsPage）；认不出的 section → 标签页
 *   MS-2  点「Settings」：换到设置、history.replaceState(…, '#browser-manager?section=settings')，history 长度不变；
 *         点回「Tabs」→ '#browser-manager'
 *   MS-3  hostInfo {headless:true} → data-headless="true"，传到两节（标签页的说明是 headless 那句；设置里有
 *         [data-headless-search-note]）；hostInfo 拒绝 / 回 {} → 没有 data-headless、没有未处理的拒绝
 *   MS-4  document.title 是本地化的「Browser」；先 settings.getAll 再 app.windowReady；settings.changed → 再读一次设置
 *
 * 模块求值时 window.api 是 web 平台（isWebHost，手机布局的判断走 matchMedia 桩）；之后每条用例换成 browserDomSupport 的假件
 * （加上 hostInfo；events.subscribe 记下订阅者）；matchMedia 是桩（不是手机布局、
 * 系统主题亮色）；@shuvix/chat-ui、settingsStore 是真的；真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { act } from 'react'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { BrowserManagerShell } from '../BrowserManagerShell'
import { useBrowserTabsStore } from '../../../stores/browserTabsStore'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  installRaf,
  mountInto,
  stubScrollIntoView,
  type FakeApi,
  type Mounted
} from './browserDomSupport'

// hostMedia / useCompactLayout 在模块求值时读 window.api.app.platform：先装一个 web 平台的最小 api
// （vi.hoisted 被提到所有 import 之前）
vi.hoisted(() => {
  ;(window as unknown as { api: unknown }).api = { app: { platform: 'web' } }
})

const M = en.browser.manager

let api: FakeApi
let m: Mounted | null = null
let hostInfo: Mock
let subscribers: Set<(event: { type: string; [k: string]: unknown }) => void>

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const shell = (): HTMLElement => $('[data-browser-manager]')!
const navButton = (label: string): HTMLButtonElement =>
  [...$('[data-browser-manager-nav]')!.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === label
  )!

async function mount(): Promise<void> {
  m = await mountInto(BrowserManagerShell, {})
  await flush(5)
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
  installRaf()
  stubScrollIntoView()
  useBrowserTabsStore.setState({ settingsFocus: null, pageCover: null })
  hostInfo = vi.fn(async () => ({ headless: false }))
  api.browserView.hostInfo = hostInfo
  subscribers = new Set()
  api.events.subscribe.mockImplementation((fn: (event: { type: string }) => void) => {
    subscribers.add(fn)
    return () => {
      subscribers.delete(fn)
    }
  })
  window.matchMedia = vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false)
  })) as unknown as typeof window.matchMedia
  window.history.replaceState(null, '', '#browser-manager')
})

afterEach(() => {
  m?.unmount()
  m = null
  vi.restoreAllMocks()
})

describe('哪一节（MS-1 / MS-2）', () => {
  it.each([
    ['#browser-manager', 'tabs'],
    ['#browser-manager?section=settings', 'settings'],
    ['#browser-manager?section=bogus', 'tabs']
  ])('MS-1 %s → %s', async (hash, section) => {
    window.history.replaceState(null, '', hash)
    await mount()
    expect(shell().getAttribute('data-browser-manager-section')).toBe(section)
    if (section === 'tabs') {
      expect($('[data-browser-tabs-manager]')).not.toBeNull()
      expect($('[data-browser-settings-page]')).toBeNull()
    } else {
      expect($('[data-browser-settings-page]')).not.toBeNull()
      expect($('[data-browser-tabs-manager]')).toBeNull()
    }
  })

  it('MS-2 点 Settings：换节、replaceState 写 ?section=settings、history 长度不变；点回 Tabs → #browser-manager', async () => {
    await mount()
    const length = window.history.length
    const replace = vi.spyOn(window.history, 'replaceState')

    click(navButton(M.settings))
    await flush()
    expect(shell().getAttribute('data-browser-manager-section')).toBe('settings')
    expect($('[data-browser-settings-page]')).not.toBeNull()
    expect(replace).toHaveBeenLastCalledWith(null, '', '#browser-manager?section=settings')
    expect(window.location.hash).toBe('#browser-manager?section=settings')
    expect(window.history.length).toBe(length)

    click(navButton(M.tabs))
    await flush()
    expect(shell().getAttribute('data-browser-manager-section')).toBe('tabs')
    expect($('[data-browser-tabs-manager]')).not.toBeNull()
    expect(replace).toHaveBeenLastCalledWith(null, '', '#browser-manager')
    expect(window.history.length).toBe(length)
  })
})

describe('无头运行（MS-3）', () => {
  it('MS-3 hostInfo {headless:true} → data-headless="true"；标签页的说明是 headless 那句，设置里有搜索那一节的说明', async () => {
    hostInfo.mockResolvedValue({ headless: true })
    await mount()
    expect(hostInfo).toHaveBeenCalledTimes(1)
    expect(shell().getAttribute('data-headless')).toBe('true')
    expect($('[data-browser-manager-note]')?.textContent).toBe(M.headlessNote)

    click(navButton(M.settings))
    await flush()
    expect($('[data-headless-search-note]')).not.toBeNull()
    expect(
      $('[data-search-settings-disabled]')?.getAttribute('data-search-settings-disabled')
    ).toBe('true')
    // remote：没有「View history」
    expect($('[data-open-history]')).toBeNull()
  })

  it.each([
    ['拒绝', () => hostInfo.mockRejectedValue(new Error('denied'))],
    ['回 {}', () => hostInfo.mockResolvedValue({})]
  ])('MS-3 hostInfo %s → 没有 data-headless，没有未处理的拒绝', async (_l, arrange) => {
    const seen: unknown[] = []
    const onRejection = (reason: unknown): void => void seen.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      arrange()
      await mount()
      expect(shell().hasAttribute('data-headless')).toBe(false)
      expect($('[data-browser-manager-note]')?.textContent).toBe(M.remoteNote)
      click(navButton(M.settings))
      await flush()
      expect($('[data-headless-search-note]')).toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})

describe('标题与初始化（MS-4）', () => {
  it('MS-4 document.title 是「Browser」；先读设置再 windowReady；settings.changed → 再读一次', async () => {
    document.title = ''
    await mount()
    expect(document.title).toBe(M.title)
    expect(api.settings.getAll).toHaveBeenCalled()
    expect(api.app.windowReady).toHaveBeenCalledTimes(1)
    expect(api.app.windowReady.mock.invocationCallOrder[0]).toBeGreaterThan(
      api.settings.getAll.mock.invocationCallOrder[0]
    )

    const before = api.settings.getAll.mock.calls.length
    await emit({ type: 'settings.changed', keys: ['general.theme'] })
    expect(api.settings.getAll.mock.calls.length).toBe(before + 1)
    // windowReady 只在第一次
    expect(api.app.windowReady).toHaveBeenCalledTimes(1)
  })
})
