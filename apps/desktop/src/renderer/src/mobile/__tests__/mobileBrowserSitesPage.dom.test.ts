// @vitest-environment jsdom
/**
 * 手机布局的「网站数据」页（mobile/MobileBrowserSettings.tsx 的 MobileBrowserSitesPage，jsdom）。
 *
 * 契约：在最上面时（`active`）取一次 `browserData.listSites()`，每次回到最上面再取一次；一个网站一行两排（名字，下面
 * 「占用 · N 个 Cookie」），点一行进那个网站；搜索框按名字过滤（也认网站下面的主机名），「⋯」里按名称 / 占用排；底部
 * 写全部网站的个数与总占用（不随搜索变）。再取一次取不到时列表保持原样；一次都没取到才说读不到。不在最上面、或
 * 卸载之后回来的结果不写。搜索词与排序在这一页挂着期间一直留着。
 *
 *   SI-1..8    框架、行、底部、还没回来 / 空 / 读不到
 *   SI-9..12   搜索与排序
 *   SI-13..17  active
 *
 * `window.api` 是 browserDomSupport 的假件；PullDownMenu 是真的（挂在 body 上）；真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { MobileBrowserSitesPage, type MobileBrowserSitesPageProps } from '../MobileBrowserSettings'
import { formatBytes, type SiteSummary } from '../../../../shared/browserSiteData'
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

const S = en.browser.settingsPage

let api: FakeApi
let m: Mounted | null = null
const onBack = vi.fn<() => void>()
const onOpenSite = vi.fn<(site: string) => void>()

const site = (name: string, over: Partial<SiteSummary> = {}): SiteSummary => ({
  site: name,
  cookieCount: 0,
  cookieBytes: 0,
  usageBytes: 0,
  localStorage: false,
  originCount: 1,
  ...over
})
/** 名称序：example.org、github.com、z.test；占用序：z.test、github.com、example.org */
const THREE = [
  site('github.com', { usageBytes: 2048, cookieBytes: 1024, cookieCount: 2 }),
  site('z.test', { usageBytes: 1024 * 1024, cookieCount: 0 }),
  site('example.org', { usageBytes: 0, cookieBytes: 512, cookieCount: 1 })
]

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

const propsOf = (over: Partial<MobileBrowserSitesPageProps> = {}): MobileBrowserSitesPageProps => ({
  active: true,
  onBack,
  onOpenSite,
  ...over
})
async function mount(over: Partial<MobileBrowserSitesPageProps> = {}): Promise<void> {
  m = await mountInto(MobileBrowserSitesPage, propsOf(over))
  await flush()
}
async function rerender(over: Partial<MobileBrowserSitesPageProps>): Promise<void> {
  await act(async () => {
    m!.root.render(createElement(MobileBrowserSitesPage, propsOf(over)))
  })
  await flush()
}

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [
  ...m!.container.querySelectorAll<T>(sel)
]
const text = (sel: string): string | null => $(sel)?.textContent ?? null
const rows = (): string[] =>
  $$('[data-mobile-browser-site]').map((el) => el.getAttribute('data-mobile-browser-site')!)
const rowEl = (name: string): HTMLElement => $(`[data-mobile-browser-site="${name}"]`)!
const meta = (name: string): string | null =>
  rowEl(name).querySelector('[data-site-meta]')?.textContent ?? null
const empty = (): string | null =>
  $('[data-mobile-browser-sites-empty]')?.getAttribute('data-mobile-browser-sites-empty') ?? null
const total = (): string | null => text('[data-mobile-browser-sites-total]')
const search = (): HTMLInputElement => $<HTMLInputElement>('[data-mobile-browser-sites-search]')!
const menuBtn = (): HTMLButtonElement => $<HTMLButtonElement>('[data-mobile-browser-sites-menu]')!
const menuItem = (id: string): HTMLButtonElement | null =>
  document.body.querySelector<HTMLButtonElement>(
    `[data-mobile-pulldown] [data-mobile-menu-item="${id}"]`
  )
const calls = (): number => api.browserData.listSites.mock.calls.length

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  onBack.mockReset()
  onOpenSite.mockReset()
})

afterEach(() => {
  m?.unmount()
  m = null
  vi.restoreAllMocks()
})

describe('框架与列表（SI-1 … SI-8）', () => {
  it('SI-1 browser-sites 页：返回键写「Browser settings」、标题「Site data」；返回 → onBack', async () => {
    await mount()
    expect($('[data-mobile-panel="browser-sites"]')).not.toBeNull()
    expect(text('[data-mobile-panel-back]')).toBe(en.mobile.browserSettings)
    expect(text('[data-mobile-panel-title]')).toBe(S.siteData)
    click($('[data-mobile-panel-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('SI-2 在最上面挂上 → listSites 一次；一个网站一行，按名称排', async () => {
    api.browserData.listSites.mockResolvedValue(THREE)
    await mount()
    expect(calls()).toBe(1)
    expect(rows()).toEqual(['example.org', 'github.com', 'z.test'])
  })

  it('SI-3 第二排：占用（配额存储 + Cookie）· N 个 Cookie（1 个是单数）', async () => {
    api.browserData.listSites.mockResolvedValue(THREE)
    await mount()
    expect(meta('github.com')).toBe(`${formatBytes(3072)} · 2 cookies`)
    expect(meta('example.org')).toBe(`${formatBytes(512)} · 1 cookie`)
    expect(meta('z.test')).toBe(`${formatBytes(1024 * 1024)} · 0 cookies`)
  })

  it('SI-4 点一行 → onOpenSite(那个网站)', async () => {
    api.browserData.listSites.mockResolvedValue(THREE)
    await mount()
    click(rowEl('github.com'))
    expect(onOpenSite.mock.calls).toEqual([['github.com']])
  })

  it('SI-5 底部：全部网站的个数与总占用，不随搜索变；没有网站 / 还没取到 → 空', async () => {
    api.browserData.listSites.mockResolvedValue(THREE)
    await mount()
    const all = `3 sites, ${formatBytes(3072 + 1024 * 1024 + 512)} in total`
    expect(total()).toBe(all)
    typeInto(search(), 'github')
    expect(rows()).toEqual(['github.com'])
    expect(total()).toBe(all)
  })

  it('SI-5 一个网站 → 单数；没有网站 → 空', async () => {
    api.browserData.listSites.mockResolvedValue([site('a.test', { usageBytes: 10 })])
    await mount()
    expect(total()).toBe(`1 site, ${formatBytes(10)} in total`)
    m!.unmount()
    m = null
    api.browserData.listSites.mockResolvedValue([])
    await mount()
    expect(total()).toBe('')
  })

  it('SI-6 还没回来：没有行、没有空态的字、底部是空的', async () => {
    api.browserData.listSites.mockReturnValue(deferred<SiteSummary[]>().promise)
    await mount()
    expect(rows()).toEqual([])
    expect(empty()).toBeNull()
    expect(total()).toBe('')
  })

  it('SI-7 一个都没有 → 空态 none', async () => {
    await mount()
    expect(empty()).toBe('none')
    expect(text('[data-mobile-browser-sites-empty]')).toBe(en.settings.toolBrowserNoSites)
  })

  it('SI-8 头一次就读不到 → 空态 error', async () => {
    api.browserData.listSites.mockRejectedValue(new Error('no'))
    await mount()
    expect(empty()).toBe('error')
    expect(text('[data-mobile-browser-sites-empty]')).toBe(en.browser.siteData.loadFailed)
    expect(rows()).toEqual([])
  })
})

describe('搜索与排序（SI-9 … SI-12）', () => {
  beforeEach(() => {
    api.browserData.listSites.mockResolvedValue(THREE)
  })

  it('SI-9 按名字的一段过滤；有字才有清除键，点了清空', async () => {
    await mount()
    expect($('[data-mobile-browser-sites-search-clear]')).toBeNull()
    typeInto(search(), 'TEST')
    expect(rows()).toEqual(['z.test'])
    const clear = $('[data-mobile-browser-sites-search-clear]')
    expect(clear).not.toBeNull()
    click(clear!)
    expect(search().value).toBe('')
    expect(rows()).toEqual(['example.org', 'github.com', 'z.test'])
    expect($('[data-mobile-browser-sites-search-clear]')).toBeNull()
  })

  it('SI-10 搜 www.github.com → github.com', async () => {
    await mount()
    typeInto(search(), 'www.github.com')
    expect(rows()).toEqual(['github.com'])
  })

  it('SI-11 搜不到 → 空态 search（不是 none）', async () => {
    await mount()
    typeInto(search(), 'zzz')
    expect(rows()).toEqual([])
    expect(empty()).toBe('search')
    expect(text('[data-mobile-browser-sites-empty]')).toBe(S.noMatch)
  })

  it('SI-12 「⋯」：按名称 / 按占用，当前那个点不了；选占用 → 大的在前，再选名称 → 回来', async () => {
    await mount()
    expect(menuBtn().getAttribute('data-sort')).toBe('name')
    expect(menuBtn().getAttribute('aria-expanded')).toBe('false')
    click(menuBtn())
    expect(menuBtn().getAttribute('aria-expanded')).toBe('true')
    expect(menuItem('name')!.textContent).toContain(en.browser.siteData.sortName)
    expect(menuItem('size')!.textContent).toContain(en.browser.siteData.sortSize)
    expect(menuItem('name')!.disabled).toBe(true)
    expect(menuItem('size')!.disabled).toBe(false)

    click(menuItem('size')!)
    expect(menuItem('size')).toBeNull()
    expect(menuBtn().getAttribute('data-sort')).toBe('size')
    expect(rows()).toEqual(['z.test', 'github.com', 'example.org'])

    click(menuBtn())
    expect(menuItem('size')!.disabled).toBe(true)
    expect(menuItem('name')!.disabled).toBe(false)
    click(menuItem('name')!)
    expect(menuBtn().getAttribute('data-sort')).toBe('name')
    expect(rows()).toEqual(['example.org', 'github.com', 'z.test'])
  })
})

describe('active（SI-13 … SI-17）', () => {
  it('SI-13 挂上时不在最上面 → 不取；到了最上面 → 取', async () => {
    api.browserData.listSites.mockResolvedValue(THREE)
    await mount({ active: false })
    expect(calls()).toBe(0)
    expect(rows()).toEqual([])
    expect(empty()).toBeNull()
    await rerender({ active: true })
    expect(calls()).toBe(1)
    expect(rows()).toHaveLength(3)
  })

  it('SI-14 真 → 假 → 真 → 再取一次，新清单换掉旧的（删掉的网站没了）', async () => {
    api.browserData.listSites
      .mockResolvedValueOnce(THREE)
      .mockResolvedValueOnce([THREE[1], THREE[2]])
    await mount()
    await rerender({ active: false })
    expect(calls()).toBe(1)
    expect(rows()).toHaveLength(3)
    await rerender({ active: true })
    expect(calls()).toBe(2)
    expect(rows()).toEqual(['example.org', 'z.test'])
    expect(total()).toBe(`2 sites, ${formatBytes(1024 * 1024 + 512)} in total`)
  })

  it('SI-15 取到过之后再取一次读不到 → 原来的清单留着，不写读不到', async () => {
    api.browserData.listSites.mockResolvedValueOnce(THREE).mockRejectedValueOnce(new Error('no'))
    await mount()
    await rerender({ active: false })
    await rerender({ active: true })
    expect(calls()).toBe(2)
    expect(rows()).toEqual(['example.org', 'github.com', 'z.test'])
    expect(empty()).toBeNull()
  })

  it('SI-16 搜索词与排序在 假 → 真 之间留着', async () => {
    api.browserData.listSites.mockResolvedValue(THREE)
    await mount()
    typeInto(search(), '.')
    click(menuBtn())
    click(menuItem('size')!)
    const input = search()
    await rerender({ active: false })
    await rerender({ active: true })
    expect(search()).toBe(input)
    expect(search().value).toBe('.')
    expect(menuBtn().getAttribute('data-sort')).toBe('size')
    expect(rows()).toEqual(['z.test', 'github.com', 'example.org'])
  })

  it('SI-17 结果回来时已经不在最上面 → 不写；回到最上面那一次的结果才算', async () => {
    const first = deferred<SiteSummary[]>()
    api.browserData.listSites.mockReturnValueOnce(first.promise).mockResolvedValueOnce([THREE[0]])
    await mount()
    await rerender({ active: false })
    first.resolve(THREE)
    await flush()
    expect(rows()).toEqual([])
    expect(total()).toBe('')

    await rerender({ active: true })
    expect(rows()).toEqual(['github.com'])
  })

  it('SI-17 被拒的结果回来时已经不在最上面 → 不写读不到', async () => {
    const first = deferred<SiteSummary[]>()
    api.browserData.listSites.mockReturnValueOnce(first.promise)
    await mount()
    await rerender({ active: false })
    first.reject(new Error('no'))
    await flush()
    expect(empty()).toBeNull()
  })

  it('SI-17 卸载之后才回来 → 不写、没有警告', async () => {
    const pending = deferred<SiteSummary[]>()
    api.browserData.listSites.mockReturnValue(pending.promise)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await mount()
    m!.unmount()
    m = null
    pending.resolve(THREE)
    await flush()
    expect(errors).not.toHaveBeenCalled()
  })
})
