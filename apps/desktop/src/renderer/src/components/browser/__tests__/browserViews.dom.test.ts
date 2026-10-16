// @vitest-environment jsdom
/**
 * 浏览器窗口的页面区：单页视图（缺省）、平铺墙（第二种视图），以及在两者之间切换的外壳。
 *
 *   CB-U52  BrowserSinglePage：布局表里只有选中的那页、**不带 zoom 键**（主进程按用户的站点缩放显示），之后
 *           setVisible(true)；空白页 / 错误页不进布局表（setLayout([])），换成新标签页 / 错误页；
 *           `.dialog-overlay` 出现 → setVisible(false)，撤掉后恢复；新标签页的搜索框提交 → navigate（没有
 *           tab 时 createTab）；错误页的 Retry → 按出错的地址 navigate；
 *   CB-U53  BrowserWall：卡片只有标题头与关闭按钮（没有地址栏、后退、前进、刷新）；mousedown 卡片选中它；
 *           布局表的每一项带 zoom = cardZoomFor(卡片宽度)；底部不再有状态栏；
 *   CB-U54  BrowserWindowShell：`browser.viewMode` 为 wall → 平铺墙，没设 / 别的值 → 单页；切换按钮当场换视图
 *           并写进设置；
 *   CB-U55  `browser.searchEngine` 决定地址栏的占位文字。
 *   BS-U33  单页视图选中设置页（shuvix://settings）：渲染 [data-browser-settings-page]（三个 [data-settings-nav]），
 *           没有页面区，布局表是空的（setLayout([]) + setVisible(true)）；
 *   BS-U34  单页视图的 pageCover（站点信息气泡开着）：setVisible(false)，[data-browser-page] 里一张
 *           <img data-page-cover>（截图为 '' 时没有图）；撤掉 → 布局恢复、setVisible(true)；
 *   BS-U35  平铺墙：pageCover → setVisible(false)；设置页的卡片是紧凑版（没有导航）、从不进布局表；一张卡片的地址
 *           变成 shuvix://settings → 下一次布局表里没有它；
 *   BS-U36  设置页在标签条、墙上卡片头、搜索标签页菜单里都叫 Settings，图标是设置图标（不是地球）。
 *
 * jsdom 没有布局：getBoundingClientRect 一律回一个固定矩形、ResizeObserver 是哑桩、rAF 换成 setTimeout(0)。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { BrowserSinglePage } from '../BrowserSinglePage'
import { BrowserWall } from '../BrowserWall'
import { BrowserWindowShell } from '../BrowserWindowShell'
import { BrowserTabStrip } from '../BrowserTabStrip'
import { showTabSearchMenu } from '../browserMenus'
import { cardZoomFor } from '../tabUtils'
import i18n from 'i18next'
import { useBrowserTabsStore, type BrowserTabInfo } from '../../../stores/browserTabsStore'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  installRaf,
  installResizeObserver,
  lastMenu,
  mountInto,
  mouseDown,
  stubRects,
  stubScrollIntoView,
  tabInfo,
  typeInto,
  type FakeApi,
  type Mounted
} from './browserDomSupport'

let api: FakeApi
let m: Mounted | null = null

const RECT = { x: 0, y: 76, width: 550, height: 600 }
const BOUNDS = { x: 0, y: 76, width: 550, height: 600 }

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [
  ...m!.container.querySelectorAll<T>(sel)
]

function seed(tabs: BrowserTabInfo[], activeTabId: string | null): void {
  useBrowserTabsStore.setState({ tabs, activeTabId })
}

const layoutCalls = (): unknown[] => api.browserView.setLayout.mock.calls.map(([e]) => e)
const visibleCalls = (): unknown[] => api.browserView.setVisible.mock.calls.map(([v]) => v)

/** 新标签页里的搜索框提交一次 */
function submitNewTab(text: string): void {
  const form = $('[data-new-tab-page] form') as HTMLFormElement
  typeInto(form.querySelector('input')!, text)
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  installRaf()
  installResizeObserver()
  stubScrollIntoView()
  stubRects(RECT)
  useBrowserTabsStore.setState({
    tabs: [],
    activeTabId: null,
    omniboxFocusNonce: 0,
    pageCover: null,
    settingsFocus: null
  })
})

afterEach(() => {
  m?.unmount()
  m = null
  document.querySelectorAll('.dialog-overlay').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

describe('单页视图（CB-U52）', () => {
  it('CB-U52 布局表只有选中的那页、没有 zoom 键；之后 setVisible(true)', async () => {
    seed(
      [tabInfo({ id: 'a', url: 'https://a.test/' }), tabInfo({ id: 'b', url: 'https://b.test/' })],
      'b'
    )
    m = await mountInto(BrowserSinglePage, { engine: 'google' })
    await flush()
    expect($('[data-browser-page]')?.getAttribute('data-browser-page')).toBe('b')
    expect(layoutCalls().at(-1)).toStrictEqual([{ tabId: 'b', bounds: BOUNDS }])
    for (const entries of layoutCalls() as Array<Array<Record<string, unknown>>>) {
      for (const e of entries) expect(e).not.toHaveProperty('zoom')
    }
    expect(visibleCalls().at(-1)).toBe(true)
    const lastLayout = api.browserView.setLayout.mock.invocationCallOrder.at(-1)!
    const lastVisible = api.browserView.setVisible.mock.invocationCallOrder.at(-1)!
    expect(lastLayout).toBeLessThan(lastVisible)

    // 用户选中另一页：布局表换成它
    act(() => useBrowserTabsStore.setState({ activeTabId: 'a' }))
    await flush()
    expect(layoutCalls().at(-1)).toStrictEqual([{ tabId: 'a', bounds: BOUNDS }])
  })

  it('CB-U52 空白页：setLayout([])，显示新标签页；提交 example.org → navigate(id, https://example.org)', async () => {
    seed([tabInfo({ id: 'n', url: 'about:blank' })], 'n')
    m = await mountInto(BrowserSinglePage, { engine: 'google' })
    await flush()
    expect(layoutCalls().at(-1)).toStrictEqual([])
    expect(visibleCalls().at(-1)).toBe(true)
    expect($('[data-new-tab-page]')).not.toBeNull()
    expect($('[data-browser-page]')).toBeNull()

    submitNewTab('example.org')
    expect(api.browserView.navigate.mock.calls).toEqual([['n', 'https://example.org']])
    expect(api.browserView.createTab).not.toHaveBeenCalled()
  })

  it('CB-U52 没有 tab：新标签页，提交 → createTab(目标)；空白提交什么也不做', async () => {
    seed([], null)
    m = await mountInto(BrowserSinglePage, { engine: 'bing' })
    await flush()
    expect(layoutCalls().at(-1)).toStrictEqual([])
    submitNewTab('   ')
    expect(api.browserView.createTab).not.toHaveBeenCalled()
    submitNewTab('hello world')
    expect(api.browserView.createTab.mock.calls).toEqual([
      ['https://www.bing.com/search?q=hello%20world']
    ])
  })

  it('CB-U52 加载失败：setLayout([])，错误页；Retry → 按出错的地址 navigate', async () => {
    seed(
      [
        tabInfo({
          id: 'e',
          url: 'https://now.test/',
          loadError: {
            errorCode: -105,
            errorDescription: 'ERR_NAME_NOT_RESOLVED',
            url: 'https://failed.test/'
          }
        })
      ],
      'e'
    )
    m = await mountInto(BrowserSinglePage, { engine: 'google' })
    await flush()
    expect(layoutCalls().at(-1)).toStrictEqual([])
    expect($('[data-page-error]')?.getAttribute('data-page-error')).toBe('failed')
    const retry = $$('button').find((b) => b.textContent?.trim() === 'Retry')
    click(retry!)
    expect(api.browserView.navigate.mock.calls).toEqual([['e', 'https://failed.test/']])
  })

  it('CB-U52 对话框覆盖层出现 → setVisible(false)；撤掉 → 恢复布局与可见', async () => {
    seed([tabInfo({ id: 'a', url: 'https://a.test/' })], 'a')
    m = await mountInto(BrowserSinglePage, { engine: 'google' })
    await flush()
    expect(visibleCalls().at(-1)).toBe(true)
    api.browserView.setLayout.mockClear()

    const overlay = document.createElement('div')
    overlay.className = 'dialog-overlay'
    await act(async () => {
      document.body.appendChild(overlay)
    })
    await flush()
    expect(visibleCalls().at(-1)).toBe(false)
    expect(layoutCalls()).toEqual([])

    await act(async () => {
      overlay.remove()
    })
    await flush()
    expect(layoutCalls().at(-1)).toStrictEqual([{ tabId: 'a', bounds: BOUNDS }])
    expect(visibleCalls().at(-1)).toBe(true)
  })
})

describe('平铺墙（CB-U53）', () => {
  const TABS = [
    tabInfo({ id: 'a', url: 'https://a.test/', title: 'Alpha' }),
    tabInfo({ id: 'b', url: 'https://b.test/', title: 'Beta' }),
    tabInfo({ id: 'n', url: 'about:blank' })
  ]

  it('CB-U53 卡片只有标题头与关闭按钮：没有地址栏 / 后退 / 前进 / 刷新', async () => {
    seed(TABS, 'a')
    m = await mountInto(BrowserWall, { engine: 'google' })
    await flush()
    expect($$('[data-browser-card]').map((c) => c.getAttribute('data-browser-card'))).toEqual([
      'a',
      'b',
      'n'
    ])
    for (const card of $$('[data-browser-card]')) {
      for (const sel of [
        '[data-omnibox]',
        '[data-omnibox-input]',
        '[data-browser-back]',
        '[data-browser-forward]',
        '[data-browser-reload]',
        '[data-browser-stop]',
        'input'
      ]) {
        expect(card.querySelector(sel), `${card.getAttribute('data-browser-card')} ${sel}`).toBe(
          null
        )
      }
      const buttons = [...card.querySelectorAll('button')]
      expect(buttons).toHaveLength(1)
      expect(buttons[0].getAttribute('aria-label')).toBe('Close tab')
    }
  })

  it('CB-U53 mousedown 没选中的卡片 → activateTab；选中的那张不再发；关闭按钮只关', async () => {
    seed(TABS, 'a')
    m = await mountInto(BrowserWall, { engine: 'google' })
    await flush()
    mouseDown($('[data-browser-card="b"]')!)
    expect(api.browserView.activateTab.mock.calls).toEqual([['b']])
    mouseDown($('[data-browser-card="a"]')!)
    expect(api.browserView.activateTab.mock.calls).toEqual([['b']])
    const close = $('[data-browser-card="b"] button')!
    mouseDown(close)
    click(close)
    expect(api.browserView.closeTab.mock.calls).toEqual([['b']])
    expect(api.browserView.activateTab.mock.calls).toEqual([['b']])
  })

  it('CB-U53 布局表：每张显示页面的卡片一项，zoom = cardZoomFor(卡片宽度)；空白卡不进表', async () => {
    seed(TABS, 'a')
    m = await mountInto(BrowserWall, { engine: 'google' })
    await flush()
    const zoom = cardZoomFor(RECT.width)
    expect(zoom).toBe(0.5)
    expect(layoutCalls().at(-1)).toStrictEqual([
      { tabId: 'a', bounds: BOUNDS, zoom },
      { tabId: 'b', bounds: BOUNDS, zoom }
    ])
    expect(visibleCalls().at(-1)).toBe(true)
  })

  it('CB-U53 底部没有状态栏（没有尺寸、没有「同屏 x/y」）', async () => {
    seed(TABS, 'a')
    m = await mountInto(BrowserWall, { engine: 'google' })
    await flush()
    const wall = $('[data-browser-wall]')!
    expect(wall.children).toHaveLength(1)
    expect(wall.textContent).not.toMatch(/\d+\s*x\s*\d+/)
    expect(wall.textContent).not.toMatch(/\d+\s*\/\s*\d+/)
  })
})

describe('外壳与两种视图（CB-U54 / CB-U55）', () => {
  const mountShell = async (settings: Record<string, string>): Promise<void> => {
    api.settingsMap = settings
    m = await mountInto(BrowserWindowShell, {})
    await flush()
  }

  it.each([
    ['wall', '[data-browser-wall]', 'wall'],
    [undefined, '[data-browser-single]', 'single'],
    ['grid', '[data-browser-single]', 'single'],
    ['single', '[data-browser-single]', 'single']
  ] as const)('CB-U54 browser.viewMode=%s → %s', async (value, sel, mode) => {
    await mountShell(value === undefined ? {} : { 'browser.viewMode': value })
    expect($(sel)).not.toBeNull()
    expect($('[data-browser-window]')?.getAttribute('data-view-mode')).toBe(mode)
    expect($(mode === 'wall' ? '[data-browser-single]' : '[data-browser-wall]')).toBeNull()
  })

  it('CB-U54 切换按钮：当场换成平铺墙、写进设置；再点回单页', async () => {
    await mountShell({})
    expect($('[data-browser-single]')).not.toBeNull()
    click($('[data-browser-view-toggle]')!)
    expect($('[data-browser-wall]')).not.toBeNull()
    expect(api.settings.set.mock.calls).toEqual([[{ key: 'browser.viewMode', value: 'wall' }]])
    click($('[data-browser-view-toggle]')!)
    expect($('[data-browser-single]')).not.toBeNull()
    expect(api.settings.set.mock.calls.at(-1)).toEqual([
      { key: 'browser.viewMode', value: 'single' }
    ])
  })

  it.each([
    [undefined, 'Search Google or type a URL'],
    ['duckduckgo', 'Search DuckDuckGo or type a URL'],
    ['baidu', 'Search 百度 or type a URL'],
    ['yahoo', 'Search Google or type a URL']
  ] as const)('CB-U55 browser.searchEngine=%s → 占位「%s」', async (value, placeholder) => {
    await mountShell(value === undefined ? {} : { 'browser.searchEngine': value })
    expect($('[data-omnibox-display]')?.textContent).toBe(placeholder)
  })
})

describe('设置页在单页视图里（BS-U33）', () => {
  it('BS-U33 选中设置页：渲染设置页（三个导航），没有页面区；setLayout([]) + setVisible(true)', async () => {
    seed(
      [
        tabInfo({ id: 'a', url: 'https://a.test/' }),
        tabInfo({ id: 's', url: 'shuvix://settings' })
      ],
      's'
    )
    m = await mountInto(BrowserSinglePage, { engine: 'google' })
    await flush()
    const page = $('[data-browser-settings-page]')
    expect(page).not.toBeNull()
    expect($$('[data-settings-nav]').map((el) => el.getAttribute('data-settings-nav'))).toEqual([
      'search',
      'privacy',
      'certificates'
    ])
    expect($('[data-page-area]')).toBeNull()
    expect($('[data-browser-page]')).toBeNull()
    expect($('[data-new-tab-page]')).toBeNull()
    expect(layoutCalls().length).toBeGreaterThan(0)
    for (const entries of layoutCalls()) expect(entries).toStrictEqual([])
    expect(visibleCalls().at(-1)).toBe(true)
  })

  it('BS-U33 从网页换到设置页：布局表从那一页变成空', async () => {
    seed(
      [
        tabInfo({ id: 'a', url: 'https://a.test/' }),
        tabInfo({ id: 's', url: 'shuvix://settings' })
      ],
      'a'
    )
    m = await mountInto(BrowserSinglePage, { engine: 'google' })
    await flush()
    expect(layoutCalls().at(-1)).toStrictEqual([{ tabId: 'a', bounds: BOUNDS }])
    act(() => useBrowserTabsStore.setState({ activeTabId: 's' }))
    await flush()
    expect(layoutCalls().at(-1)).toStrictEqual([])
    expect(visibleCalls().at(-1)).toBe(true)
    expect($('[data-browser-settings-page]')).not.toBeNull()
  })
})

describe('单页视图的 pageCover（BS-U34）', () => {
  it('BS-U34 盖上：setVisible(false)，页面区里一张截图；撤掉：布局恢复、setVisible(true)', async () => {
    seed([tabInfo({ id: 'a', url: 'https://a.test/' })], 'a')
    m = await mountInto(BrowserSinglePage, { engine: 'google' })
    await flush()
    expect(visibleCalls().at(-1)).toBe(true)
    api.browserView.setLayout.mockClear()

    act(() =>
      useBrowserTabsStore
        .getState()
        .setPageCover({ tabId: 'a', snapshot: 'data:image/png;base64,C' })
    )
    await flush()
    expect(visibleCalls().at(-1)).toBe(false)
    expect(layoutCalls()).toEqual([])
    const img = $<HTMLImageElement>('[data-browser-page="a"] img[data-page-cover]')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('data:image/png;base64,C')

    act(() => useBrowserTabsStore.getState().setPageCover(null))
    await flush()
    expect($('[data-page-cover]')).toBeNull()
    expect(layoutCalls().at(-1)).toStrictEqual([{ tabId: 'a', bounds: BOUNDS }])
    expect(visibleCalls().at(-1)).toBe(true)
  })

  it("BS-U34 截图是 ''：照样让位（setVisible(false)），但没有图", async () => {
    seed([tabInfo({ id: 'a', url: 'https://a.test/' })], 'a')
    m = await mountInto(BrowserSinglePage, { engine: 'google' })
    await flush()
    act(() => useBrowserTabsStore.getState().setPageCover({ tabId: 'a', snapshot: '' }))
    await flush()
    expect(visibleCalls().at(-1)).toBe(false)
    expect($('[data-browser-page="a"]')).not.toBeNull()
    expect($('[data-page-cover]')).toBeNull()
  })
})

describe('平铺墙里的设置页与 pageCover（BS-U35）', () => {
  it('BS-U35 pageCover → setVisible(false)；撤掉 → 布局恢复', async () => {
    seed([tabInfo({ id: 'a', url: 'https://a.test/' })], 'a')
    m = await mountInto(BrowserWall, { engine: 'google' })
    await flush()
    expect(visibleCalls().at(-1)).toBe(true)
    api.browserView.setLayout.mockClear()

    act(() => useBrowserTabsStore.getState().setPageCover({ tabId: 'a', snapshot: 'data:x' }))
    await flush()
    expect(visibleCalls().at(-1)).toBe(false)
    expect(layoutCalls()).toEqual([])

    act(() => useBrowserTabsStore.getState().setPageCover(null))
    await flush()
    expect(layoutCalls().at(-1)).toStrictEqual([
      { tabId: 'a', bounds: BOUNDS, zoom: cardZoomFor(RECT.width) }
    ])
    expect(visibleCalls().at(-1)).toBe(true)
  })

  it('BS-U35 设置页的卡片：紧凑版设置页（没有导航），从不进布局表', async () => {
    seed(
      [
        tabInfo({ id: 'a', url: 'https://a.test/' }),
        tabInfo({ id: 's', url: 'shuvix://settings' })
      ],
      's'
    )
    m = await mountInto(BrowserWall, { engine: 'google' })
    await flush()
    const card = $('[data-browser-card="s"]')!
    expect(card.querySelector('[data-browser-settings-page]')).not.toBeNull()
    expect(card.querySelector('[data-settings-nav]')).toBeNull()
    expect(card.querySelector('[data-page-area]')).toBeNull()
    expect(layoutCalls().length).toBeGreaterThan(0)
    for (const entries of layoutCalls() as Array<Array<{ tabId: string }>>) {
      expect(entries.map((e) => e.tabId)).not.toContain('s')
    }
    expect(layoutCalls().at(-1)).toStrictEqual([
      { tabId: 'a', bounds: BOUNDS, zoom: cardZoomFor(RECT.width) }
    ])
  })

  it('BS-U35 一张卡片的地址变成 shuvix://settings：下一次布局表里没有它', async () => {
    seed(
      [tabInfo({ id: 'a', url: 'https://a.test/' }), tabInfo({ id: 'b', url: 'https://b.test/' })],
      'a'
    )
    m = await mountInto(BrowserWall, { engine: 'google' })
    await flush()
    expect((layoutCalls().at(-1) as Array<{ tabId: string }>).map((e) => e.tabId)).toEqual([
      'a',
      'b'
    ])
    api.browserView.setLayout.mockClear()

    act(() =>
      useBrowserTabsStore.setState({
        tabs: [
          tabInfo({ id: 'a', url: 'https://a.test/' }),
          tabInfo({ id: 'b', url: 'shuvix://settings' })
        ]
      })
    )
    await flush()
    expect(layoutCalls().length).toBeGreaterThan(0)
    expect((layoutCalls().at(-1) as Array<{ tabId: string }>).map((e) => e.tabId)).toEqual(['a'])
    expect($('[data-browser-card="b"] [data-browser-settings-page]')).not.toBeNull()
  })
})

describe('设置页的名字与图标（BS-U36）', () => {
  const SETTINGS_TAB = tabInfo({ id: 's', url: 'shuvix://settings', title: '' })
  const PAGE_TAB = tabInfo({ id: 'a', url: 'https://a.test/', title: 'Alpha' })

  it('BS-U36 标签条：叫 Settings，图标是设置图标（不是地球）', async () => {
    seed([PAGE_TAB, SETTINGS_TAB], 's')
    m = await mountInto(BrowserTabStrip, {})
    await flush()
    const tab = $('[data-browser-tab="s"]')!
    expect(tab.textContent).toContain('Settings')
    expect(tab.querySelector('svg.lucide-settings')).not.toBeNull()
    expect(tab.querySelector('svg.lucide-globe')).toBeNull()
    // 对照：普通网页的标签没有设置图标
    expect($('[data-browser-tab="a"] svg.lucide-settings')).toBeNull()
  })

  it('BS-U36 平铺墙的卡片头：叫 Settings，图标是设置图标', async () => {
    seed([PAGE_TAB, SETTINGS_TAB], 'a')
    m = await mountInto(BrowserWall, { engine: 'google' })
    await flush()
    const card = $('[data-browser-card="s"]')!
    const head = card.firstElementChild!
    expect(head.textContent).toContain('Settings')
    expect(head.querySelector('svg.lucide-settings')).not.toBeNull()
    expect(head.querySelector('svg.lucide-globe')).toBeNull()
  })

  it('BS-U36 搜索标签页菜单：设置页那一项叫 Settings（选中的带 ✓）', async () => {
    seed([PAGE_TAB, SETTINGS_TAB], 's')
    await showTabSearchMenu(i18n.t.bind(i18n))
    expect(lastMenu(api).map((it) => [it.id, it.label])).toEqual([
      ['a', 'Alpha'],
      ['s', '✓ Settings']
    ])
  })
})
