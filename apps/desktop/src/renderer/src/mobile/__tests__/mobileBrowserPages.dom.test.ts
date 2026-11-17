// @vitest-environment jsdom
/**
 * 手机布局「浏览器」那一摞页面（mobile/MobileBrowserPages.tsx，jsdom）。
 *
 * 契约：`stack` 里一层一页，全都挂着、只显示最上面那一层（下面的 `display:none`）—— 退回来时那一页的节点与里面打的
 * 字还在。标签页的清单在这里取一次，列表页与单个标签页那一页共用。每一页往里进一层 → `onPush(<页面 id>)`，每一页的
 * 返回键 → 同一个 `onBack`。那台电脑是不是无头运行问一次 `browserView.hostInfo()`（问不到当作不是）。「此刻在最上面」
 * 传给各页（网站数据页据此重新取）。
 *
 *   PG-1..3   层
 *   PG-4..5   共用一份清单、节点保留
 *   PG-6..7   onPush / onBack
 *   PG-8      无头
 *   PG-9      active 跟着「在最上面」
 *   PG-10..11 查看对话、那一页被关掉
 *   PG-12     认不出的页面 id
 *
 * 各页都是真的；`window.api` 是 browserDomSupport 的假件（加上 hostInfo）；真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement } from 'react'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { MobileBrowserPages, type MobileBrowserPagesProps } from '../MobileBrowserPages'
import type { TabRow } from '../../components/browser/tabsManagerPure'
import type { SiteSummary } from '../../../../shared/browserSiteData'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  mountInto,
  typeInto,
  type FakeApi,
  type Mounted
} from '../../components/browser/__tests__/browserDomSupport'

let api: FakeApi
let hostInfo: Mock
let m: Mounted | null = null
let subscribers: Set<(event: { type: string }) => void>
const onPush = vi.fn<(page: string) => void>()
const onBack = vi.fn<() => void>()
const onOpenSession = vi.fn<(sessionId: string) => void>()

const row = (id: string, over: Partial<TabRow> = {}): TabRow =>
  ({
    id,
    url: `https://${id}.test/`,
    title: `Tab ${id}`,
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

const site = (name: string): SiteSummary => ({
  site: name,
  cookieCount: 1,
  cookieBytes: 10,
  usageBytes: 100,
  localStorage: false,
  originCount: 1
})

const propsOf = (stack: readonly string[]): MobileBrowserPagesProps => ({
  stack,
  onPush,
  onBack,
  onOpenSession
})
async function mount(stack: readonly string[]): Promise<void> {
  m = await mountInto(MobileBrowserPages, propsOf(stack))
  await flush()
}
async function restack(stack: readonly string[]): Promise<void> {
  await act(async () => {
    m!.root.render(createElement(MobileBrowserPages, propsOf(stack)))
  })
  await flush()
}
async function emit(type: string): Promise<void> {
  await act(async () => {
    for (const fn of [...subscribers]) fn({ type })
  })
  await flush()
}

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [
  ...m!.container.querySelectorAll<T>(sel)
]
const layers = (): string[] =>
  $$('[data-mobile-browser-layer]').map((el) => el.getAttribute('data-mobile-browser-layer')!)
const layer = (page: string): HTMLElement => $(`[data-mobile-browser-layer="${page}"]`)!
const hidden = (page: string): boolean => layer(page).style.display === 'none'
const visibleLayers = (): string[] => layers().filter((page) => !hidden(page))
const within = <T extends Element = HTMLElement>(page: string, sel: string): T | null =>
  layer(page).querySelector<T>(sel)

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  hostInfo = vi.fn(async () => ({ headless: false }))
  api.browserView.hostInfo = hostInfo
  subscribers = new Set()
  api.events.subscribe.mockImplementation((fn: (event: { type: string }) => void) => {
    subscribers.add(fn)
    return () => {
      subscribers.delete(fn)
    }
  })
  api.browserView.listTabs.mockResolvedValue([row('7'), row('8')])
  onPush.mockReset()
  onBack.mockReset()
  onOpenSession.mockReset()
})

afterEach(() => {
  m?.unmount()
  m = null
  vi.restoreAllMocks()
})

describe('层（PG-1 … PG-3）', () => {
  it("PG-1 ['tabs'] → 一层，显示着", async () => {
    await mount(['tabs'])
    expect(layers()).toEqual(['tabs'])
    expect(hidden('tabs')).toBe(false)
    expect(within('tabs', '[data-mobile-panel="browser-tabs"]')).not.toBeNull()
  })

  it("PG-2 ['tabs','tab:7'] → 两层都挂着；列表那层 display:none，标签页那层显示着", async () => {
    await mount(['tabs', 'tab:7'])
    expect(layers()).toEqual(['tabs', 'tab:7'])
    expect(hidden('tabs')).toBe(true)
    expect(hidden('tab:7')).toBe(false)
    expect(within('tabs', '[data-mobile-panel="browser-tabs"]')).not.toBeNull()
    expect(within('tab:7', '[data-mobile-browser-tab-detail="7"]')).not.toBeNull()
  })

  it('PG-3 四层：只有最上面那层显示；网站那层里是那个网站的详情', async () => {
    await mount(['tabs', 'settings', 'sites', 'site:a.test'])
    expect(layers()).toEqual(['tabs', 'settings', 'sites', 'site:a.test'])
    expect(visibleLayers()).toEqual(['site:a.test'])
    expect(within('settings', '[data-mobile-panel="browser-settings"]')).not.toBeNull()
    expect(within('sites', '[data-mobile-panel="browser-sites"]')).not.toBeNull()
    expect(within('site:a.test', '[data-mobile-panel="browser-site"]')).not.toBeNull()
    expect(within('site:a.test', '[data-mobile-browser-site-detail="a.test"]')).not.toBeNull()
    expect(api.browserData.siteDetails).toHaveBeenCalledWith('a.test')
  })
})

describe('共用一份清单、节点保留（PG-4 … PG-5）', () => {
  it('PG-4 整摞只取一次 listTabs；browser.tabsChanged → 再取一次，两页都跟着变', async () => {
    await mount(['tabs', 'tab:7'])
    expect(api.browserView.listTabs).toHaveBeenCalledTimes(1)
    expect(within('tabs', '[data-mobile-browser-tab="7"]')!.textContent).toContain('Tab 7')
    expect(within('tab:7', '[data-mobile-panel-title]')!.textContent).toBe('Tab 7')

    api.browserView.listTabs.mockResolvedValue([row('7', { title: 'Renamed' }), row('8')])
    await emit('browser.tabsChanged')
    expect(api.browserView.listTabs).toHaveBeenCalledTimes(2)
    expect(within('tabs', '[data-mobile-browser-tab="7"]')!.textContent).toContain('Renamed')
    expect(within('tab:7', '[data-mobile-panel-title]')!.textContent).toBe('Renamed')
  })

  it("PG-5 ['tabs'] → ['tabs','tab:7'] → ['tabs']：列表那层是同一个节点，打的字还在", async () => {
    await mount(['tabs'])
    const node = layer('tabs')
    const input = within<HTMLInputElement>('tabs', '[data-mobile-browser-new-tab-input]')!
    typeInto(input, 'half typed')

    await restack(['tabs', 'tab:7'])
    expect(layer('tabs')).toBe(node)
    expect(hidden('tabs')).toBe(true)

    await restack(['tabs'])
    expect(layers()).toEqual(['tabs'])
    expect(layer('tabs')).toBe(node)
    expect(hidden('tabs')).toBe(false)
    expect(within<HTMLInputElement>('tabs', '[data-mobile-browser-new-tab-input]')).toBe(input)
    expect(input.value).toBe('half typed')
    expect(api.browserView.listTabs).toHaveBeenCalledTimes(1)
  })
})

describe('onPush / onBack（PG-6 … PG-7）', () => {
  it("PG-6 点标签页一行 → onPush('tab:<id>')；浏览器设置 → onPush('settings')", async () => {
    await mount(['tabs'])
    click(within('tabs', '[data-mobile-browser-tab="8"]')!)
    click(within('tabs', '[data-mobile-browser-open-settings]')!)
    expect(onPush.mock.calls).toEqual([['tab:8'], ['settings']])
  })

  it("PG-6 网站数据 → onPush('sites')；网站一行 → onPush('site:<网站>')", async () => {
    api.browserData.listSites.mockResolvedValue([site('a.test')])
    await mount(['tabs', 'settings'])
    click(within('settings', '[data-mobile-browser-open-sites]')!)
    expect(onPush.mock.calls).toEqual([['sites']])

    await restack(['tabs', 'settings', 'sites'])
    click(within('sites', '[data-mobile-browser-site="a.test"]')!)
    expect(onPush.mock.calls).toEqual([['sites'], ['site:a.test']])
  })

  it('PG-7 每一层的返回键 → 同一个 onBack', async () => {
    const stacks = [
      ['tabs'],
      ['tabs', 'tab:7'],
      ['tabs', 'settings'],
      ['tabs', 'settings', 'sites'],
      ['tabs', 'settings', 'sites', 'site:a.test']
    ]
    for (const [index, stack] of stacks.entries()) {
      await mount(stack)
      click(within(stack[stack.length - 1], '[data-mobile-panel-back]')!)
      expect(onBack).toHaveBeenCalledTimes(index + 1)
      m!.unmount()
      m = null
    }
    expect(onPush).not.toHaveBeenCalled()
  })
})

describe('无头（PG-8）', () => {
  it('PG-8 hostInfo 说无头 → 列表页是无头那一句，设置页的搜索那组置灰', async () => {
    hostInfo.mockResolvedValue({ headless: true })
    await mount(['tabs', 'settings'])
    expect(hostInfo).toHaveBeenCalledTimes(1)
    expect(within('tabs', '[data-mobile-browser-note]')!.textContent).toBe(
      en.browser.manager.headlessNote
    )
    expect(within('settings', '[data-search-settings-disabled="true"]')).not.toBeNull()
  })

  it('PG-8 不是无头 / 问不到 → 当作不是', async () => {
    for (const answer of [
      (): Promise<unknown> => Promise.resolve({ headless: false }),
      (): Promise<unknown> => Promise.reject(new Error('no'))
    ]) {
      hostInfo.mockImplementation(answer)
      await mount(['tabs', 'settings'])
      expect(within('tabs', '[data-mobile-browser-note]')!.textContent).toBe(
        en.browser.manager.remoteNote
      )
      expect(within('settings', '[data-search-settings-disabled]')).toBeNull()
      m!.unmount()
      m = null
    }
  })
})

describe('active 跟着「在最上面」（PG-9）', () => {
  it('PG-9 网站那页退掉、网站数据页回到最上面 → 再取一次 listSites', async () => {
    api.browserData.listSites.mockResolvedValue([site('a.test'), site('b.test')])
    await mount(['tabs', 'settings', 'sites', 'site:a.test'])
    const before = api.browserData.listSites.mock.calls.length
    expect(within('sites', '[data-mobile-browser-site]')).toBeNull()

    await restack(['tabs', 'settings', 'sites'])
    expect(api.browserData.listSites.mock.calls.length).toBe(before + 1)
    expect(within('sites', '[data-mobile-browser-site="a.test"]')).not.toBeNull()
    expect(hidden('sites')).toBe(false)
  })
})

describe('查看对话、那一页被关掉（PG-10 … PG-11）', () => {
  it('PG-10 标签页那页的「View conversation」→ onOpenSession(会话 id)', async () => {
    api.browserView.listTabs.mockResolvedValue([
      row('7', { agentSessionId: 's1', agentSessionTitle: 'Fix', cdpAttached: true })
    ])
    await mount(['tabs', 'tab:7'])
    click(within('tab:7', '[data-mobile-browser-tab-open-session]')!)
    expect(onOpenSession.mock.calls).toEqual([['s1']])
  })

  it('PG-11 最上面那一页的标签页被关掉（清单里没有它了）→ onBack 一次', async () => {
    await mount(['tabs', 'tab:7'])
    expect(onBack).not.toHaveBeenCalled()
    api.browserView.listTabs.mockResolvedValue([row('8')])
    await emit('browser.tabsChanged')
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(within('tab:7', '[data-mobile-browser-tab-detail]')).toBeNull()
  })
})

describe('认不出的页面 id（PG-12）', () => {
  it("PG-12 ['tabs','x'] → 那一层是空的，不抛", async () => {
    await mount(['tabs', 'x'])
    expect(layers()).toEqual(['tabs', 'x'])
    expect(layer('x').childElementCount).toBe(0)
    expect(hidden('tabs')).toBe(true)
    expect(hidden('x')).toBe(false)
  })
})
