// @vitest-environment jsdom
/**
 * 浏览器自己的设置页（BrowserSettingsPage，内部页面 shuvix://settings）。
 *
 *   BS-U40  挂载时 settings.getAll / browserData.listSites / browserData.certExceptions 各读一次；搜索引擎下拉框
 *           显示存着的值（不认识的值 → google）；「忽略证书错误」开关照存着的值、开着才有警告；放行过的网站一行
 *           写「None」或「a.test · b.test」；
 *   BS-U41  改搜索引擎写 `browser.searchEngine`；拨开关写 `tool.browser.ignoreCertificateErrors` 'true' / 'false'，
 *           警告跟着出现 / 消失；
 *   BS-U42  删除浏览数据要确认：确认 → clearAll 一次、再列一次站点；取消什么也不做；
 *   BS-U43  网站数据：每行 host + 「2 cookies」/「1 cookie」；搜索按子串过滤，也认父域（敲 www.github.com 留下
 *           github.com）；一个都没有 / 一个都不匹配的空态文字；每行删除要确认 → clearSite(host) 再列一次；
 *   BS-U44  跳转请求（store 的 settingsFocus）：填上搜索词、把那一节滚进视野，然后 settingsFocus 变回 null；之后
 *           重新挂载什么也不再做；挂着的时候新来的请求也照办；左侧导航点一下滚到那一节；紧凑版（卡片里）没有导航。
 *
 * `window.api` 是 browserDomSupport 的假件；store 是真的；SettingsPrimitives 走 vitest 别名到 app-shell 的真组件；
 * 真 en 文案。jsdom 没有 scrollIntoView：换成间谍（按 this 认是哪一节）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock } from 'vitest'
import { act } from 'react'
import { BrowserSettingsPage } from '../BrowserSettingsPage'
import { useBrowserTabsStore } from '../../../stores/browserTabsStore'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  installRaf,
  mountInto,
  stubScrollIntoView,
  typeInto,
  type FakeApi,
  type Mounted
} from './browserDomSupport'

let api: FakeApi
let m: Mounted | null = null
let scrollSpy: Mock

const ENGINE_KEY = 'browser.searchEngine'
const IGNORE_KEY = 'tool.browser.ignoreCertificateErrors'
const WARNING = 'Warning: enabling this bypasses ALL HTTPS certificate validation'

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [
  ...m!.container.querySelectorAll<T>(sel)
]

async function mount(props: { compact?: boolean } = {}): Promise<void> {
  m = await mountInto(BrowserSettingsPage, props)
  await flush()
}

const section = (id: string): HTMLElement => {
  const el = $(`[data-settings-section="${id}"]`)
  if (!el) throw new Error(`no section ${id}`)
  return el
}
const engineSelect = (): HTMLSelectElement => section('search').querySelector('select')!
const ignoreToggle = (): HTMLButtonElement =>
  section('certificates').querySelector<HTMLButtonElement>('button.rounded-full')!
const toggleOn = (): boolean => ignoreToggle().className.includes('bg-accent')
const warningShown = (): boolean => !!section('certificates').textContent?.includes(WARNING)
/** 「Allowed sites」那一行标题下面的那行字 */
const certLine = (): string => {
  const rows = [...section('certificates').querySelectorAll('div.px-4.py-3')]
  const row = rows.find((r) => r.textContent?.includes('Allowed sites'))
  return row?.querySelector('.mt-0\\.5')?.textContent ?? ''
}
const siteRows = (): string[] => $$('[data-site-row]').map((r) => r.getAttribute('data-site-row')!)
const search = (): HTMLInputElement => $<HTMLInputElement>('[data-site-search]')!

function choose(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  act(() => {
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** scrollIntoView 被谁调过（`data-settings-section` 的值，按顺序）与各自的参数 */
const scrolled = (): Array<[string | null, unknown]> =>
  scrollSpy.mock.contexts.map((el, i) => [
    (el as HTMLElement).getAttribute('data-settings-section'),
    scrollSpy.mock.calls[i][0]
  ])

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  installRaf()
  scrollSpy = stubScrollIntoView()
  useBrowserTabsStore.setState({ settingsFocus: null, pageCover: null })
})

afterEach(() => {
  m?.unmount()
  m = null
})

describe('读出来的样子（BS-U40）', () => {
  it('BS-U40 挂载时三样各读一次；空的时候：google、开关关着没有警告、放行的网站 None', async () => {
    await mount()
    expect(api.settings.getAll).toHaveBeenCalledTimes(1)
    expect(api.browserData.listSites).toHaveBeenCalledTimes(1)
    expect(api.browserData.certExceptions).toHaveBeenCalledTimes(1)
    expect(engineSelect().value).toBe('google')
    expect(toggleOn()).toBe(false)
    expect(warningShown()).toBe(false)
    expect(certLine()).toBe('None')
  })

  it.each([
    ['bing', 'bing'],
    ['duckduckgo', 'duckduckgo'],
    ['yahoo', 'google'],
    ['toString', 'google']
  ])('BS-U40 存着 browser.searchEngine=%s → 下拉框是 %s', async (stored, shown) => {
    api.settingsMap = { [ENGINE_KEY]: stored }
    await mount()
    expect(engineSelect().value).toBe(shown)
  })

  it('BS-U40 存着忽略证书错误 = true：开关开着、有警告；放行过两个网站：「a.test · b.test」', async () => {
    api.settingsMap = { [IGNORE_KEY]: 'true' }
    api.browserData.certExceptions.mockResolvedValue(['a.test', 'b.test'])
    await mount()
    expect(toggleOn()).toBe(true)
    expect(warningShown()).toBe(true)
    expect(certLine()).toBe('a.test · b.test')
  })

  it('BS-U40 站点还没列出来：显示 Loading…', async () => {
    api.browserData.listSites.mockImplementation(() => new Promise(() => undefined))
    await mount()
    expect(section('privacy').textContent).toContain('Loading…')
    expect(siteRows()).toEqual([])
  })
})

describe('写回设置（BS-U41）', () => {
  it('BS-U41 改搜索引擎 → settings.set(browser.searchEngine)，下拉框跟着变', async () => {
    await mount()
    choose(engineSelect(), 'baidu')
    expect(api.settings.set.mock.calls).toEqual([[{ key: ENGINE_KEY, value: 'baidu' }]])
    expect(engineSelect().value).toBe('baidu')
  })

  it("BS-U41 拨开关：写 'true'，出现警告；再拨：写 'false'，警告消失", async () => {
    await mount()
    click(ignoreToggle())
    expect(api.settings.set.mock.calls).toEqual([[{ key: IGNORE_KEY, value: 'true' }]])
    expect(toggleOn()).toBe(true)
    expect(warningShown()).toBe(true)

    click(ignoreToggle())
    expect(api.settings.set.mock.calls.at(-1)).toEqual([{ key: IGNORE_KEY, value: 'false' }])
    expect(toggleOn()).toBe(false)
    expect(warningShown()).toBe(false)
  })
})

describe('删除浏览数据（BS-U42）', () => {
  it('BS-U42 删除 → 确认 → clearAll 一次、再列一次站点；之后回到删除按钮', async () => {
    api.browserData.listSites.mockResolvedValueOnce([{ host: 'a.test', cookieCount: 2 }])
    await mount()
    expect(siteRows()).toEqual(['a.test'])
    click($('[data-clear-all]')!)
    expect(api.browserData.clearAll).not.toHaveBeenCalled()
    expect($('[data-clear-all-confirm]')?.textContent).toContain('Confirm delete')

    click($('[data-clear-all-confirm]')!)
    await flush()
    expect(api.browserData.clearAll).toHaveBeenCalledTimes(1)
    expect(api.browserData.listSites).toHaveBeenCalledTimes(2)
    expect(api.browserData.listSites.mock.invocationCallOrder[1]).toBeGreaterThan(
      api.browserData.clearAll.mock.invocationCallOrder[0]
    )
    expect(siteRows()).toEqual([])
    expect($('[data-clear-all-confirm]')).toBeNull()
    expect($('[data-clear-all]')).not.toBeNull()
  })

  it('BS-U42 确认里的取消：什么也不清', async () => {
    await mount()
    click($('[data-clear-all]')!)
    const cancel = [...section('privacy').querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Cancel'
    )
    click(cancel!)
    expect($('[data-clear-all-confirm]')).toBeNull()
    expect(api.browserData.clearAll).not.toHaveBeenCalled()
    expect(api.browserData.listSites).toHaveBeenCalledTimes(1)
  })
})

describe('网站数据（BS-U43）', () => {
  const SITES = [
    { host: 'a.test', cookieCount: 2 },
    { host: 'github.com', cookieCount: 1 },
    { host: 'gist.github.com', cookieCount: 3 }
  ]

  it('BS-U43 每行 host + cookie 数（单数 / 复数）', async () => {
    api.browserData.listSites.mockResolvedValue(SITES)
    await mount()
    expect(siteRows()).toEqual(['a.test', 'github.com', 'gist.github.com'])
    expect($('[data-site-row="a.test"]')!.textContent).toContain('2 cookies')
    expect($('[data-site-row="github.com"]')!.textContent).toContain('1 cookie')
    expect($('[data-site-row="github.com"]')!.textContent).not.toContain('1 cookies')
  })

  it('BS-U43 搜索：子串过滤（不分大小写）；父域规则：www.github.com 留下 github.com；没有匹配的空态', async () => {
    api.browserData.listSites.mockResolvedValue(SITES)
    await mount()
    typeInto(search(), 'GITHUB')
    expect(siteRows()).toEqual(['github.com', 'gist.github.com'])
    typeInto(search(), 'www.github.com')
    expect(siteRows()).toEqual(['github.com'])
    typeInto(search(), 'deep.gist.github.com')
    expect(siteRows()).toEqual(['github.com', 'gist.github.com'])
    typeInto(search(), 'nothing-here')
    expect(siteRows()).toEqual([])
    expect(section('privacy').textContent).toContain('No matching sites')
    typeInto(search(), '  ')
    expect(siteRows()).toEqual(['a.test', 'github.com', 'gist.github.com'])
  })

  it('BS-U43 一个站点都没有：「No sites with saved data」', async () => {
    await mount()
    expect(siteRows()).toEqual([])
    expect(section('privacy').textContent).toContain('No sites with saved data')
    expect(section('privacy').textContent).not.toContain('No matching sites')
  })

  it('BS-U43 每行删除要确认：确认 → clearSite(host)，再列一次', async () => {
    api.browserData.listSites.mockResolvedValueOnce(SITES).mockResolvedValueOnce(SITES.slice(1))
    await mount()
    const row = $('[data-site-row="a.test"]')!
    click(row.querySelector('[data-clear-site]')!)
    expect(api.browserData.clearSite).not.toHaveBeenCalled()
    click($('[data-site-row="a.test"] [data-clear-site-confirm]')!)
    await flush()
    expect(api.browserData.clearSite.mock.calls).toEqual([['a.test']])
    expect(api.browserData.listSites).toHaveBeenCalledTimes(2)
    expect(api.browserData.listSites.mock.invocationCallOrder[1]).toBeGreaterThan(
      api.browserData.clearSite.mock.invocationCallOrder[0]
    )
    expect(siteRows()).toEqual(['github.com', 'gist.github.com'])
  })
})

describe('跳转请求与导航（BS-U44）', () => {
  it('BS-U44 挂载时有请求：填上搜索词、把那一节滚进视野，然后 settingsFocus 变回 null；之后重新挂载什么也不做', async () => {
    api.browserData.listSites.mockResolvedValue([
      { host: 'github.com', cookieCount: 1 },
      { host: 'a.test', cookieCount: 1 }
    ])
    useBrowserTabsStore.setState({
      settingsFocus: { section: 'privacy', search: 'www.github.com', nonce: 1 }
    })
    await mount()
    expect(search().value).toBe('www.github.com')
    expect(siteRows()).toEqual(['github.com'])
    expect(scrolled()).toEqual([['privacy', { block: 'start' }]])
    expect(useBrowserTabsStore.getState().settingsFocus).toBeNull()

    m!.unmount()
    m = null
    scrollSpy.mockClear()
    await mount()
    expect(search().value).toBe('')
    expect(scrollSpy).not.toHaveBeenCalled()
    expect(siteRows()).toEqual(['github.com', 'a.test'])
  })

  it('BS-U44 挂着的时候来了请求（没有搜索词）：滚到那一节，搜索框不动，请求清掉', async () => {
    await mount()
    typeInto(search(), 'mine')
    act(() =>
      useBrowserTabsStore.setState({ settingsFocus: { section: 'certificates', nonce: 7 } })
    )
    await flush()
    expect(scrolled()).toEqual([['certificates', { block: 'start' }]])
    expect(search().value).toBe('mine')
    expect(useBrowserTabsStore.getState().settingsFocus).toBeNull()
  })

  it('BS-U44 左侧导航：三项（搜索引擎 / 隐私和安全 / 证书），点一下平滑滚到那一节', async () => {
    await mount()
    const nav = $$('[data-settings-nav]')
    expect(nav.map((b) => b.getAttribute('data-settings-nav'))).toEqual([
      'search',
      'privacy',
      'certificates'
    ])
    expect(nav.map((b) => b.textContent?.trim())).toEqual([
      'Search engine',
      'Privacy and security',
      'Certificates'
    ])
    click($('[data-settings-nav="certificates"]')!)
    click($('[data-settings-nav="search"]')!)
    expect(scrolled()).toEqual([
      ['certificates', { block: 'start', behavior: 'smooth' }],
      ['search', { block: 'start', behavior: 'smooth' }]
    ])
  })

  it('BS-U44 紧凑版：没有导航，三节照有', async () => {
    await mount({ compact: true })
    expect($('[data-browser-settings-page]')).not.toBeNull()
    expect($$('[data-settings-nav]')).toEqual([])
    for (const id of ['search', 'privacy', 'certificates']) {
      expect($(`[data-settings-section="${id}"]`), id).not.toBeNull()
    }
  })
})
