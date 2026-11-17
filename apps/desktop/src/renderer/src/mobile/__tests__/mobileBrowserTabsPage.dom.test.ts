// @vitest-environment jsdom
/**
 * 手机布局「浏览器」的标签页列表（mobile/MobileBrowser.tsx 的 MobileBrowserTabsPage，jsdom）。
 *
 * 契约：`state`（{tabs, listError, reload}）由上层给；顶上一行开新标签页，下面一张卡片一个标签页一行两排（标题；
 * 网站 · 状态），行上没有按钮 —— 点一行 `onOpenTab`，长按是刷新 / 关闭；agent 用着的页刷新 / 关闭先问；再下面一行
 * 进「浏览器设置」；「⋯」刷新列表；底部是数量。搜索引擎在 `active` 变成 true 时读一次。
 *
 *   TL-1..3    框架、说明、底部数量
 *   TL-4..7    列表的几种状态
 *   TL-8..16   一行的内容
 *   TL-17..19  点一行 / 浏览器设置 / 「⋯」
 *   TL-20..27  开新标签页
 *   TL-28..30  长按菜单与确认框
 *   TL-31      `active`：false 不读设置；false → true 重新读搜索引擎
 *
 * `window.api` 是 browserDomSupport 的假件；@shuvix/chat-ui 是真的；@shuvix/app-shell 只把 useContextMenu 换成
 * 记下菜单项的替身（ConfirmDialog 是真的，取消要等 120ms 的退场）。真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

interface MenuItem {
  id?: string
  label?: string
}

const rec = vi.hoisted(() => ({
  menus: [] as Array<{ items: MenuItem[]; pick: (id: string) => void }>
}))

vi.mock('@shuvix/app-shell', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useContextMenu:
      () =>
      (_e: unknown, items: MenuItem[], pick: (id: string) => void): Promise<void> => {
        rec.menus.push({ items, pick })
        return Promise.resolve()
      }
  }
})

import { MobileBrowserTabsPage, type MobileBrowserTabsPageProps } from '../MobileBrowser'
import type { TabRow } from '../../components/browser/tabsManagerPure'
import { searchUrl } from '../../../../shared/browserSearchEngines'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  installRaf,
  typeInto,
  type FakeApi
} from '../../components/browser/__tests__/browserDomSupport'

const M = en.browser.manager
const I = en.browser.infobar

const row = (over: Partial<TabRow> & { id: string }): TabRow =>
  ({
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

let api: FakeApi
let container: HTMLDivElement
let root: Root
let mounted = false
const onBack = vi.fn<() => void>()
const onOpenTab = vi.fn<(id: string) => void>()
const onOpenSettings = vi.fn<() => void>()
const reload = vi.fn<() => void>()

type Over = Partial<Omit<MobileBrowserTabsPageProps, 'state'>> & {
  tabs?: TabRow[] | null
  listError?: string | null
}

/** 画（或用新的 props 重画）这一页 */
async function render(over: Over = {}): Promise<void> {
  const { tabs = [], listError = null, ...rest } = over
  act(() =>
    root.render(
      createElement(MobileBrowserTabsPage, {
        state: { tabs, listError, reload },
        headless: false,
        active: true,
        onBack,
        onOpenTab,
        onOpenSettings,
        ...rest
      })
    )
  )
  mounted = true
  await flush()
}

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  container.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [
  ...container.querySelectorAll<T>(sel)
]
const rowEl = (id: string): HTMLElement => {
  const el = $(`[data-mobile-browser-tab="${id}"]`)
  if (!el) throw new Error(`no row ${id}`)
  return el
}
const rowTitle = (id: string): string => rowEl(id).querySelector('span span')?.textContent ?? ''
const meta = (id: string): HTMLElement | null => rowEl(id).querySelector('[data-tab-meta]')
const input = (): HTMLInputElement => $<HTMLInputElement>('[data-mobile-browser-new-tab-input]')!
const openBtn = (): HTMLButtonElement => $<HTMLButtonElement>('[data-mobile-browser-new-tab-open]')!
const errorText = (): string | null => $('[data-mobile-browser-error]')?.textContent ?? null
const dialog = (): HTMLElement | null => $('[data-browser-tab-agent-confirm]')
const dialogButtons = (): HTMLButtonElement[] => [
  ...dialog()!.closest('.dialog-panel')!.querySelectorAll('button')
]

async function submit(): Promise<void> {
  act(() => {
    $('[data-mobile-browser-new-tab]')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )
  })
  await flush()
}
/** 长按一行，回菜单 */
function longPress(id: string): { items: MenuItem[]; pick: (id: string) => void } {
  act(() => {
    rowEl(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  return rec.menus[rec.menus.length - 1]
}
async function pick(id: string, action: string): Promise<void> {
  const menu = longPress(id)
  act(() => menu.pick(action))
  await flush()
}
/** 确认框取消的退场（120ms） */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
}
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const codedError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code })

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  installRaf()
  api.browserView.createTab.mockImplementation(async () => 'tab-new')
  rec.menus.length = 0
  vi.clearAllMocks()
  api.settings.getAll.mockImplementation(async () => ({ ...api.settingsMap }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  mounted = false
  container.remove()
})

describe('框架（TL-1 … TL-3）', () => {
  it('TL-1 browser-tabs 页；返回键写 Settings，大标题 Browser；返回键 → onBack 一次', async () => {
    await render()
    expect($('[data-mobile-panel="browser-tabs"]')).not.toBeNull()
    expect($('[data-mobile-panel-back]')!.textContent).toBe(en.mobile.tabSettings)
    expect($('[data-mobile-panel-title]')!.textContent).toBe(M.title)
    click($('[data-mobile-panel-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('TL-2 说明一行：不是无头 → remoteNote；无头 → headlessNote', async () => {
    await render()
    expect($('[data-mobile-browser-note]')!.textContent).toBe(M.remoteNote)
    await render({ headless: true })
    expect($('[data-mobile-browser-note]')!.textContent).toBe(M.headlessNote)
  })

  it('TL-3 底部数量：3 / 1 / 0 个；没取到、或有 listError（哪怕留着旧列表）→ 空', async () => {
    const count = (): string => $('[data-mobile-browser-count]')!.textContent ?? ''
    await render({ tabs: [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })] })
    expect(count()).toBe('3 tabs')
    await render({ tabs: [row({ id: 'a' })] })
    expect(count()).toBe('1 tab')
    await render({ tabs: [] })
    expect(count()).toBe('0 tabs')
    await render({ tabs: null })
    expect(count()).toBe('')
    await render({ tabs: [row({ id: 'a' })], listError: 'no' })
    expect(count()).toBe('')
  })
})

describe('列表的状态（TL-4 … TL-7）', () => {
  it('TL-4 还没取到：加载中一行，没有行、空态、拒绝', async () => {
    await render({ tabs: null })
    expect($('[data-mobile-panel-body]')!.textContent).toContain(en.common.loading)
    expect($$('[data-mobile-browser-tab]')).toEqual([])
    expect($('[data-mobile-browser-empty]')).toBeNull()
    expect($('[data-mobile-browser-denied]')).toBeNull()
  })

  it('TL-5 一个都没有 → 空态「No tabs are open」', async () => {
    await render({ tabs: [] })
    expect($('[data-mobile-browser-empty]')!.textContent).toBe(M.noTabs)
  })

  it('TL-6 listError：写那句话；旧列表的行不画；开新标签页与「浏览器设置」还在', async () => {
    await render({ tabs: [row({ id: 'a' })], listError: 'NB prompt' })
    expect($('[data-mobile-browser-denied]')!.textContent).toBe(
      'This device may not see the tabs: NB prompt'
    )
    expect($$('[data-mobile-browser-tab]')).toEqual([])
    expect($('[data-mobile-browser-new-tab]')).not.toBeNull()
    expect($('[data-mobile-browser-open-settings]')).not.toBeNull()
  })

  it('TL-7 一个标签页一行、按清单的顺序；行里没有按钮', async () => {
    await render({
      tabs: [
        row({ id: 'b', loading: true }),
        row({ id: 'a', agentSessionId: 's1', cdpAttached: true }),
        row({ id: 'c', crashed: true })
      ]
    })
    const rows = $$('[data-mobile-browser-tab]')
    expect(rows.map((el) => el.getAttribute('data-mobile-browser-tab'))).toEqual(['b', 'a', 'c'])
    for (const el of rows) {
      expect(el.tagName).toBe('BUTTON')
      expect(el.querySelector('button')).toBeNull()
    }
  })
})

describe('一行的内容（TL-8 … TL-16）', () => {
  it('TL-8 名字：内部页面的页名 > 标题 > 地址 >「New Tab」', async () => {
    await render({
      tabs: [
        row({ id: 's', url: 'about:blank', title: 'x', internalPage: 'settings' }),
        row({ id: 'h', url: 'about:blank', internalPage: 'history' }),
        row({ id: 't', title: 'A page' }),
        row({ id: 'u', url: 'https://u.test/x' }),
        row({ id: 'n', url: '' })
      ]
    })
    expect(rowTitle('s')).toBe(en.browser.internal.settings)
    expect(rowTitle('h')).toBe(en.browser.internal.history)
    expect(rowTitle('t')).toBe('A page')
    expect(rowTitle('u')).toBe('https://u.test/x')
    expect(rowTitle('n')).toBe(en.browser.untitledTab)
  })

  it('TL-9 普通网页第二排只有主机名；空白页没有第二排', async () => {
    await render({ tabs: [row({ id: 'a' }), row({ id: 'b', url: 'about:blank' })] })
    expect(meta('a')!.textContent).toBe('example.com')
    expect(meta('b')).toBeNull()
  })

  it('TL-10 会话用着：主机名 · In use by “标题”；没有标题写会话 id', async () => {
    await render({
      tabs: [
        row({ id: 'a', agentSessionId: 's1', agentSessionTitle: 'Fix', cdpAttached: true }),
        row({ id: 'b', agentSessionId: 's2' })
      ]
    })
    expect(meta('a')!.textContent).toBe('example.com · In use by “Fix”')
    expect(meta('b')!.textContent).toBe('example.com · In use by “s2”')
  })

  it('TL-11 只接着 CDP：主机名 · An agent is using this page', async () => {
    await render({ tabs: [row({ id: 'a', cdpAttached: true })] })
    expect(meta('a')!.textContent).toBe(`example.com · ${I.usingUnknown}`)
  })

  it('TL-12 加载中：主机名 · Loading；data-tab-loading', async () => {
    await render({ tabs: [row({ id: 'a', loading: true }), row({ id: 'b' })] })
    expect(meta('a')!.textContent).toBe(`example.com · ${M.loading}`)
    expect(rowEl('a').getAttribute('data-tab-loading')).toBe('true')
    expect(rowEl('b').hasAttribute('data-tab-loading')).toBe(false)
  })

  it('TL-13 先后：会话 > 接着 CDP > 加载中', async () => {
    await render({
      tabs: [
        row({ id: 'a', agentSessionId: 's1', cdpAttached: true, loading: true }),
        row({ id: 'b', cdpAttached: true, loading: true })
      ]
    })
    expect(meta('a')!.textContent).toBe('example.com · In use by “s1”')
    expect(meta('b')!.textContent).toBe(`example.com · ${I.usingUnknown}`)
  })

  it('TL-14 崩了：主机名 · Page crashed、错误色、data-tab-crashed；会话用着也只写崩了；没有主机名只写崩了', async () => {
    await render({
      tabs: [
        row({ id: 'a', crashed: true }),
        row({ id: 'b', crashed: true, agentSessionId: 's1', agentSessionTitle: 'Fix' }),
        row({ id: 'c', crashed: true, url: 'about:blank' })
      ]
    })
    expect(meta('a')!.textContent).toBe(`example.com · ${M.crashed}`)
    expect(meta('a')!.className).toContain('text-error')
    expect(rowEl('a').getAttribute('data-tab-crashed')).toBe('true')
    expect(meta('b')!.textContent).toBe(`example.com · ${M.crashed}`)
    expect(meta('c')!.textContent).toBe(M.crashed)
  })

  it('TL-15 内部页面的第二排没有主机名', async () => {
    await render({
      tabs: [
        row({ id: 's', url: 'https://example.com/', internalPage: 'settings' }),
        row({ id: 'h', url: 'https://example.com/', internalPage: 'history', loading: true })
      ]
    })
    expect(meta('s')).toBeNull()
    expect(meta('h')!.textContent).toBe(M.loading)
  })

  it('TL-16 data-tab-agent = 会话 id（没有就没有这个属性）；色点只在 agent 用着的行上', async () => {
    await render({
      tabs: [
        row({ id: 'a', agentSessionId: 's1' }),
        row({ id: 'b', cdpAttached: true }),
        row({ id: 'c' })
      ]
    })
    expect(rowEl('a').getAttribute('data-tab-agent')).toBe('s1')
    expect(rowEl('b').hasAttribute('data-tab-agent')).toBe(false)
    expect(rowEl('c').hasAttribute('data-tab-agent')).toBe(false)
    expect(rowEl('a').querySelector('[data-tab-agent-dot]')).not.toBeNull()
    expect(rowEl('b').querySelector('[data-tab-agent-dot]')).not.toBeNull()
    expect(rowEl('c').querySelector('[data-tab-agent-dot]')).toBeNull()
  })
})

describe('进别的页（TL-17 … TL-19）', () => {
  it('TL-17 点一行 → onOpenTab(id) 一次，不调 api', async () => {
    await render({ tabs: [row({ id: 'a', agentSessionId: 's1' })] })
    click(rowEl('a'))
    await flush()
    expect(onOpenTab.mock.calls).toEqual([['a']])
    for (const name of ['reload', 'closeTab', 'navigate', 'createTab', 'activateTab']) {
      expect(api.browserView[name]).not.toHaveBeenCalled()
    }
    expect(reload).not.toHaveBeenCalled()
  })

  it('TL-18 「Browser settings」一行 → onOpenSettings', async () => {
    await render()
    const settingsRow = $('[data-mobile-browser-open-settings]')!
    expect(settingsRow.textContent).toBe(en.mobile.browserSettings)
    click(settingsRow)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('TL-19 「⋯」：菜单里是 Refresh list，选它 → state.reload()；aria-expanded 跟着', async () => {
    await render()
    const more = $('[data-mobile-browser-menu]')!
    expect(more.getAttribute('aria-expanded')).toBe('false')
    click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const items = [...document.querySelectorAll('[data-mobile-pulldown] [data-mobile-menu-item]')]
    expect(items.map((el) => el.textContent)).toEqual([M.refreshList])
    click(items[0])
    expect(reload).toHaveBeenCalledTimes(1)
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-mobile-pulldown]')).toBeNull()
  })
})

describe('开新标签页（TL-20 … TL-27）', () => {
  it('TL-20 空着提交 → createTab()（不带参数），之后重新取列表', async () => {
    await render()
    await submit()
    expect(api.browserView.createTab.mock.calls).toEqual([[]])
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('TL-21 example.com → createTab(https://example.com, typed)', async () => {
    await render()
    typeInto(input(), 'example.com')
    click(openBtn())
    await flush()
    expect(api.browserView.createTab.mock.calls).toEqual([['https://example.com', 'typed']])
  })

  it('TL-22 two words：缺省引擎 → google 的搜索地址', async () => {
    await render()
    typeInto(input(), 'two words')
    await submit()
    expect(api.browserView.createTab.mock.calls).toEqual([
      [searchUrl('two words', 'google'), 'typed']
    ])
  })

  it('TL-22 设置里是 bing → bing 的搜索地址', async () => {
    api.settingsMap['browser.searchEngine'] = 'bing'
    await render()
    typeInto(input(), 'two words')
    await submit()
    expect(api.browserView.createTab.mock.calls).toEqual([
      [searchUrl('two words', 'bing'), 'typed']
    ])
  })

  it('TL-22 settings.getAll 失败 → 缺省引擎，不出错', async () => {
    api.settings.getAll.mockRejectedValue(new Error('no'))
    await render()
    typeInto(input(), 'two words')
    await submit()
    expect(api.browserView.createTab.mock.calls).toEqual([
      [searchUrl('two words', 'google'), 'typed']
    ])
  })

  it('TL-23 成功 → 输入框清空，没有错误卡片', async () => {
    await render()
    typeInto(input(), 'example.com')
    await submit()
    expect(input().value).toBe('')
    expect(errorText()).toBeNull()
  })

  it('TL-24 失败 → 错误卡片写原因，字留着，照样重新取列表', async () => {
    api.browserView.createTab.mockRejectedValue(new Error('denied by rule X'))
    await render()
    typeInto(input(), 'example.com')
    await submit()
    expect(errorText()).toBe('That did not work: denied by rule X')
    expect(input().value).toBe('example.com')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('TL-25 remote_url_refused → 卡片里是本地化的那句，不是原文', async () => {
    api.browserView.createTab.mockRejectedValue(codedError('remote_url_refused', 'raw text'))
    await render()
    typeInto(input(), 'file:///etc/passwd')
    await submit()
    expect(errorText()).toBe(`That did not work: ${M.remoteUrlRefused}`)
    expect(errorText()).not.toContain('raw text')
  })

  it('TL-26 请求中 Open 禁用，再提交一次不再调 createTab', async () => {
    const pending = deferred<string>()
    api.browserView.createTab.mockImplementation(() => pending.promise)
    await render()
    typeInto(input(), 'example.com')
    await submit()
    expect(openBtn().disabled).toBe(true)
    await submit()
    expect(api.browserView.createTab).toHaveBeenCalledTimes(1)
    pending.resolve('t')
    await flush()
    expect(openBtn().disabled).toBe(false)
    expect(input().value).toBe('')
  })

  it('TL-27 之后一次成功的动作清掉先前的错误卡片', async () => {
    api.browserView.createTab.mockRejectedValueOnce(new Error('x'))
    await render()
    await submit()
    expect(errorText()).not.toBeNull()
    await submit()
    expect(errorText()).toBeNull()
  })
})

describe('长按菜单与确认框（TL-28 … TL-30）', () => {
  it('TL-28 长按：正好 Reload 与 Close；没有 agent 的页直接做', async () => {
    await render({ tabs: [row({ id: 'a' })] })
    const menu = longPress('a')
    expect(menu.items).toEqual([
      { id: 'reload', label: en.browser.refresh },
      { id: 'close', label: en.browser.closeTab }
    ])
    act(() => menu.pick('reload'))
    await flush()
    expect(api.browserView.reload.mock.calls).toEqual([['a']])
    expect(dialog()).toBeNull()
    await pick('a', 'close')
    expect(api.browserView.closeTab.mock.calls).toEqual([['a']])
    expect(dialog()).toBeNull()
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('TL-29 agent 用着：Close 先问（写着会话）；取消 → 什么都不调；确认 → closeTab 然后重新取', async () => {
    await render({
      tabs: [row({ id: 'a', agentSessionId: 's1', agentSessionTitle: 'Fix', cdpAttached: true })]
    })
    await pick('a', 'close')
    expect(dialog()!.getAttribute('data-browser-tab-agent-confirm')).toBe('close')
    expect(dialog()!.textContent).toContain('“Fix” is using this page')
    expect(dialog()!.textContent).toContain(M.confirmCloseBody)
    expect(api.browserView.closeTab).not.toHaveBeenCalled()

    click(dialogButtons()[0])
    await settle()
    expect(dialog()).toBeNull()
    expect(api.browserView.closeTab).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()

    await pick('a', 'close')
    click(dialogButtons()[1])
    await flush()
    expect(dialog()).toBeNull()
    expect(api.browserView.closeTab.mock.calls).toEqual([['a']])
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('TL-29 只接着 CDP：确认框写不知道是谁的那句；Reload 同样先问，确认 → reload', async () => {
    await render({ tabs: [row({ id: 'a', cdpAttached: true })] })
    await pick('a', 'reload')
    expect(dialog()!.getAttribute('data-browser-tab-agent-confirm')).toBe('reload')
    expect(dialog()!.textContent).toContain(I.usingUnknown)
    expect(api.browserView.reload).not.toHaveBeenCalled()
    click(dialogButtons()[1])
    await flush()
    expect(api.browserView.reload.mock.calls).toEqual([['a']])
    expect(api.browserView.closeTab).not.toHaveBeenCalled()
  })

  it('TL-29 崩了的 agent 页：Reload 直接做，Close 照问', async () => {
    await render({ tabs: [row({ id: 'a', agentSessionId: 's1', crashed: true })] })
    await pick('a', 'reload')
    expect(dialog()).toBeNull()
    expect(api.browserView.reload.mock.calls).toEqual([['a']])
    await pick('a', 'close')
    expect(dialog()!.getAttribute('data-browser-tab-agent-confirm')).toBe('close')
    expect(api.browserView.closeTab).not.toHaveBeenCalled()
  })

  it('TL-30 框开着，那一页没了 → 框消失，什么都不调；回来了也不自己再弹', async () => {
    const used = row({ id: 'a', agentSessionId: 's1' })
    await render({ tabs: [used] })
    await pick('a', 'close')
    expect(dialog()).not.toBeNull()
    await render({ tabs: [] })
    expect(dialog()).toBeNull()
    await render({ tabs: [used] })
    expect(dialog()).toBeNull()
    expect(api.browserView.closeTab).not.toHaveBeenCalled()
    // 再点才问
    await pick('a', 'close')
    expect(dialog()).not.toBeNull()
  })

  it('TL-30 框开着，agent 不用了 → 框消失；又用上也不自己再弹', async () => {
    await render({ tabs: [row({ id: 'a', cdpAttached: true })] })
    await pick('a', 'close')
    expect(dialog()).not.toBeNull()
    await render({ tabs: [row({ id: 'a' })] })
    expect(dialog()).toBeNull()
    await render({ tabs: [row({ id: 'a', cdpAttached: true })] })
    expect(dialog()).toBeNull()
    expect(api.browserView.closeTab).not.toHaveBeenCalled()
  })

  it('TL-30 刷新框开着，那一页崩了 → 框消失；恢复了也不自己再弹', async () => {
    await render({ tabs: [row({ id: 'a', agentSessionId: 's1' })] })
    await pick('a', 'reload')
    expect(dialog()).not.toBeNull()
    await render({ tabs: [row({ id: 'a', agentSessionId: 's1', crashed: true })] })
    expect(dialog()).toBeNull()
    await render({ tabs: [row({ id: 'a', agentSessionId: 's1' })] })
    expect(dialog()).toBeNull()
    expect(api.browserView.reload).not.toHaveBeenCalled()
  })
})

describe('active（TL-31）', () => {
  it('TL-31 挂上时不在最上面 → 不读设置', async () => {
    await render({ active: false })
    expect(api.settings.getAll).not.toHaveBeenCalled()
  })

  it('TL-31 false → true 重新读搜索引擎：开新标签页用的是其间改过的那个', async () => {
    await render()
    expect(api.settings.getAll).toHaveBeenCalledTimes(1)
    await render({ active: false })
    api.settingsMap['browser.searchEngine'] = 'bing'
    expect(api.settings.getAll).toHaveBeenCalledTimes(1)
    await render({ active: true })
    expect(api.settings.getAll).toHaveBeenCalledTimes(2)
    typeInto(input(), 'hello world')
    await submit()
    expect(api.browserView.createTab.mock.calls).toEqual([
      [searchUrl('hello world', 'bing'), 'typed']
    ])
  })
})
