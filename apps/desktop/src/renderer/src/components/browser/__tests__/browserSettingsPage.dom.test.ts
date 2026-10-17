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
 *   BS-U44  跳转请求（store 的 settingsFocus）：填上搜索词、把那一节滚进视野，然后 settingsFocus 变回 null；之后
 *           重新挂载什么也不再做；挂着的时候新来的请求也照办；左侧导航点一下滚到那一节；紧凑版（卡片里）没有导航。
 *
 * 网站数据（2026-10-16 改成按网站分组的 SiteSummary：Cookie + 配额存储 + 本地存储）：
 *   SD-U23  每行 = 网站名 + 「大小 · N cookies[ · Local storage]」（大小 = usageBytes + cookieBytes，formatBytes）；
 *           合计一行「N sites, X in total」（单数 / 复数）数的是全部网站、不随搜索变；没有网站时没有合计一行；
 *   SD-U24  排序：缺省按名字；选 By size 按大小从大到小、一样大按名字；切回按名字；
 *   SD-U25  搜索：子串（不分大小写），或搜索词以 `.<网站>` 结尾（www.github.com 留下 github.com）；空态文字；
 *   SD-U26  每行删除要确认 → clearSite(site) → 再列一次；取消什么也不做；删除失败：行留着、确认收起、不重列、
 *           没有未处理的拒绝；
 *   SD-U27  点网站名 / 行尾的箭头 → 那个网站的详情（siteDetails(site)），列表收起；详情里的返回 → 回到列表、
 *           再列一次；在详情里点左侧导航 → 离开详情、再列一次、滚到那一节；
 *   SD-U28  带 site 的跳转请求 → 直接进那个网站的详情（不滚动），请求清掉；重新挂载回到设置页本身；挂着的时候
 *           来的也照办；
 *   SD-U29  不带 site 的跳转请求、此刻在详情里 → 离开详情、再列一次、滚到那一节。
 *
 * `window.api` 是 browserDomSupport 的假件；store 是真的；SettingsPrimitives 走 vitest 别名到 app-shell 的真组件；
 * 真 en 文案。jsdom 没有 scrollIntoView：换成间谍（按 this 认是哪一节）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act } from 'react'
import { BrowserSettingsPage } from '../BrowserSettingsPage'
import { useBrowserTabsStore } from '../../../stores/browserTabsStore'
import type { SiteSummary } from '../../../../../shared/browserSiteData'
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
/** 网站数据一行标题下面的那行字 */
const subtitle = (site: string): string =>
  $(`[data-site-row="${site}"] .mt-0\\.5`)?.textContent ?? ''
/** 合计一行；没有为 null */
const total = (): string | null => $('[data-site-data-total]')?.textContent ?? null
/** 网站数据一节的排序下拉框（privacy 节里唯一的 select） */
const sortSelect = (): HTMLSelectElement => section('privacy').querySelector('select')!
/** 某一行的箭头（进详情） */
const chevron = (site: string): HTMLButtonElement =>
  [...$(`[data-site-row="${site}"]`)!.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === 'View this site’s data'
  )!
const detailsSite = (): string | null =>
  $('[data-site-details]')?.getAttribute('data-site-details') ?? null

/** 一行网站摘要 */
const summary = (over: Partial<SiteSummary> & { site: string }): SiteSummary => ({
  cookieCount: 0,
  cookieBytes: 0,
  usageBytes: 0,
  localStorage: false,
  originCount: 0,
  ...over
})

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
    api.browserData.listSites.mockResolvedValueOnce([
      summary({ site: 'a.test', cookieCount: 2, cookieBytes: 10 })
    ])
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

describe('网站数据的行与合计（SD-U23）', () => {
  it('SD-U23 每行：网站名 + 「大小 · N cookies[ · Local storage]」；大小 = 占用 + Cookie 字节', async () => {
    api.browserData.listSites.mockResolvedValue([
      summary({
        site: 'github.com',
        cookieCount: 2,
        cookieBytes: 512,
        usageBytes: 1024,
        localStorage: true,
        originCount: 2
      }),
      summary({ site: 'a.test', cookieCount: 1, cookieBytes: 9 }),
      summary({ site: 'storage.test', usageBytes: 3 * 1024 * 1024, originCount: 1 })
    ])
    await mount()
    expect(siteRows()).toEqual(['a.test', 'github.com', 'storage.test'])
    expect(subtitle('github.com')).toBe('1.5 KB · 2 cookies · Local storage')
    expect(subtitle('a.test')).toBe('9 B · 1 cookie')
    expect(subtitle('storage.test')).toBe('3 MB · 0 cookies')
    // 网站名是那个可点的按钮
    expect($('[data-site-open="github.com"]')?.textContent).toBe('github.com')
  })

  it('SD-U23 合计一行：「N sites, X in total」（复数），数的是全部网站、不随搜索变', async () => {
    api.browserData.listSites.mockResolvedValue([
      summary({ site: 'a.test', cookieCount: 1, cookieBytes: 1024 }),
      summary({ site: 'b.test', usageBytes: 1024 }),
      summary({ site: 'c.test', usageBytes: 512, cookieBytes: 512, cookieCount: 1 })
    ])
    await mount()
    expect(total()).toBe('3 sites, 3 KB in total')
    typeInto(search(), 'b.test')
    expect(siteRows()).toEqual(['b.test'])
    expect(total()).toBe('3 sites, 3 KB in total')
    typeInto(search(), 'nothing-here')
    expect(siteRows()).toEqual([])
    expect(total()).toBe('3 sites, 3 KB in total')
  })

  it('SD-U23 一个网站：单数「1 site」', async () => {
    api.browserData.listSites.mockResolvedValue([
      summary({ site: 'a.test', cookieCount: 1, cookieBytes: 9 })
    ])
    await mount()
    expect(total()).toBe('1 site, 9 B in total')
  })

  it('SD-U23 一个网站都没有：没有合计一行，空态「No sites with saved data」', async () => {
    await mount()
    expect(total()).toBeNull()
    expect(siteRows()).toEqual([])
    expect(section('privacy').textContent).toContain('No sites with saved data')
    expect(section('privacy').textContent).not.toContain('No matching sites')
  })

  it('SD-U23 还没列出来：没有合计一行', async () => {
    api.browserData.listSites.mockImplementation(() => new Promise(() => undefined))
    await mount()
    expect(total()).toBeNull()
  })
})

describe('排序（SD-U24）', () => {
  const SITES = [
    summary({ site: 'c.test', usageBytes: 100 }),
    summary({ site: 'z.test', cookieCount: 3, cookieBytes: 6000 }),
    summary({ site: 'a.test', usageBytes: 60, cookieBytes: 40, cookieCount: 1 }),
    summary({ site: 'b.test', usageBytes: 5000 })
  ]

  it('SD-U24 缺省按名字；By size：从大到小、一样大按名字；切回按名字', async () => {
    api.browserData.listSites.mockResolvedValue(SITES)
    await mount()
    expect(sortSelect().value).toBe('name')
    expect([...sortSelect().options].map((o) => [o.value, o.textContent])).toEqual([
      ['name', 'By name'],
      ['size', 'By size']
    ])
    expect(siteRows()).toEqual(['a.test', 'b.test', 'c.test', 'z.test'])

    choose(sortSelect(), 'size')
    expect(sortSelect().value).toBe('size')
    expect(siteRows()).toEqual(['z.test', 'b.test', 'a.test', 'c.test'])

    choose(sortSelect(), 'name')
    expect(siteRows()).toEqual(['a.test', 'b.test', 'c.test', 'z.test'])
    // 排序不写设置、不重新列
    expect(api.settings.set).not.toHaveBeenCalled()
    expect(api.browserData.listSites).toHaveBeenCalledTimes(1)
  })

  it('SD-U24 按大小排的时候搜索照样过滤', async () => {
    api.browserData.listSites.mockResolvedValue(SITES)
    await mount()
    choose(sortSelect(), 'size')
    typeInto(search(), '.test')
    expect(siteRows()).toEqual(['z.test', 'b.test', 'a.test', 'c.test'])
    typeInto(search(), 'c')
    expect(siteRows()).toEqual(['c.test'])
  })
})

describe('搜索（SD-U25）', () => {
  const SITES = [
    summary({ site: '127.0.0.1', cookieCount: 1 }),
    summary({ site: 'a.test', cookieCount: 1 }),
    summary({ site: 'foo.github.io', cookieCount: 1 }),
    summary({ site: 'github.com', cookieCount: 1 })
  ]

  it('SD-U25 子串（不分大小写）；搜索词以 .<网站> 结尾也算；没有匹配的空态；全是空白 = 不过滤', async () => {
    api.browserData.listSites.mockResolvedValue(SITES)
    await mount()
    typeInto(search(), 'GITHUB')
    expect(siteRows()).toEqual(['foo.github.io', 'github.com'])
    typeInto(search(), 'www.github.com')
    expect(siteRows()).toEqual(['github.com'])
    typeInto(search(), 'x.foo.github.io')
    expect(siteRows()).toEqual(['foo.github.io'])
    typeInto(search(), '127.0')
    expect(siteRows()).toEqual(['127.0.0.1'])
    typeInto(search(), 'nothing-here')
    expect(siteRows()).toEqual([])
    expect(section('privacy').textContent).toContain('No matching sites')
    typeInto(search(), '  ')
    expect(siteRows()).toEqual(['127.0.0.1', 'a.test', 'foo.github.io', 'github.com'])
  })

  it('SD-U25 只是后缀不算：搜 xgithub.com 不留 github.com', async () => {
    api.browserData.listSites.mockResolvedValue(SITES)
    await mount()
    typeInto(search(), 'xgithub.com')
    expect(siteRows()).toEqual([])
  })
})

describe('列表里删除一个网站（SD-U26）', () => {
  const SITES = [
    summary({ site: 'a.test', cookieCount: 2, cookieBytes: 10 }),
    summary({ site: 'github.com', cookieCount: 1, usageBytes: 2048 })
  ]

  it('SD-U26 删除要确认：确认 → clearSite(site)，再列一次，那一行没了', async () => {
    api.browserData.listSites.mockResolvedValueOnce(SITES).mockResolvedValueOnce(SITES.slice(1))
    await mount()
    click($('[data-site-row="a.test"] [data-clear-site]')!)
    expect(api.browserData.clearSite).not.toHaveBeenCalled()
    expect($('[data-site-row="github.com"] [data-clear-site-confirm]')).toBeNull()
    click($('[data-site-row="a.test"] [data-clear-site-confirm]')!)
    await flush()
    expect(api.browserData.clearSite.mock.calls).toEqual([['a.test']])
    expect(api.browserData.listSites).toHaveBeenCalledTimes(2)
    expect(api.browserData.listSites.mock.invocationCallOrder[1]).toBeGreaterThan(
      api.browserData.clearSite.mock.invocationCallOrder[0]
    )
    expect(siteRows()).toEqual(['github.com'])
    expect($('[data-clear-site-confirm]')).toBeNull()
  })

  it('SD-U26 确认里的取消：回到垃圾桶，什么也不删', async () => {
    api.browserData.listSites.mockResolvedValue(SITES)
    await mount()
    click($('[data-site-row="a.test"] [data-clear-site]')!)
    const cancel = [...$('[data-site-row="a.test"]')!.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Cancel'
    )
    click(cancel!)
    expect($('[data-clear-site-confirm]')).toBeNull()
    expect($('[data-site-row="a.test"] [data-clear-site]')).not.toBeNull()
    expect(api.browserData.clearSite).not.toHaveBeenCalled()
  })

  it('SD-U26 删除失败：行留着、确认收起、不重列；没有未处理的拒绝；再删一次照常', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      api.browserData.listSites.mockResolvedValue(SITES)
      api.browserData.clearSite.mockRejectedValueOnce(new Error('partition locked'))
      await mount()
      click($('[data-site-row="a.test"] [data-clear-site]')!)
      click($('[data-site-row="a.test"] [data-clear-site-confirm]')!)
      await flush()
      await new Promise((r) => setTimeout(r, 0))
      expect(api.browserData.clearSite.mock.calls).toEqual([['a.test']])
      expect(api.browserData.listSites).toHaveBeenCalledTimes(1)
      expect(siteRows()).toEqual(['a.test', 'github.com'])
      expect($('[data-clear-site-confirm]')).toBeNull()
      expect($('[data-site-row="a.test"] [data-clear-site]')).not.toBeNull()
      expect(unhandled).not.toHaveBeenCalled()

      click($('[data-site-row="a.test"] [data-clear-site]')!)
      click($('[data-site-row="a.test"] [data-clear-site-confirm]')!)
      await flush()
      expect(api.browserData.clearSite).toHaveBeenCalledTimes(2)
      expect(api.browserData.listSites).toHaveBeenCalledTimes(2)
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('进出站点详情（SD-U27）', () => {
  const SITES = [
    summary({ site: 'a.test', cookieCount: 1 }),
    summary({ site: 'github.com', cookieCount: 2, usageBytes: 4096 })
  ]

  it('SD-U27 点网站名 → 那个网站的详情，列表收起；返回 → 回到列表、再列一次', async () => {
    api.browserData.listSites.mockResolvedValue(SITES)
    await mount()
    expect(detailsSite()).toBeNull()
    click($('[data-site-open="github.com"]')!)
    await flush()
    expect(detailsSite()).toBe('github.com')
    expect(api.browserData.siteDetails.mock.calls).toEqual([['github.com']])
    expect(siteRows()).toEqual([])
    expect($('[data-settings-section="privacy"]')).toBeNull()
    // 导航还在
    expect($$('[data-settings-nav]')).toHaveLength(3)

    click($('[data-site-details-back]')!)
    await flush()
    expect(detailsSite()).toBeNull()
    expect(siteRows()).toEqual(['a.test', 'github.com'])
    expect(api.browserData.listSites).toHaveBeenCalledTimes(2)
  })

  it('SD-U27 行尾的箭头也进详情', async () => {
    api.browserData.listSites.mockResolvedValue(SITES)
    await mount()
    click(chevron('a.test'))
    await flush()
    expect(detailsSite()).toBe('a.test')
    expect(api.browserData.siteDetails.mock.calls).toEqual([['a.test']])
  })

  it('SD-U27 在详情里点左侧导航：离开详情、再列一次、平滑滚到那一节', async () => {
    api.browserData.listSites.mockResolvedValue(SITES)
    await mount()
    click($('[data-site-open="github.com"]')!)
    await flush()
    expect(detailsSite()).toBe('github.com')

    click($('[data-settings-nav="certificates"]')!)
    await flush()
    expect(detailsSite()).toBeNull()
    expect(api.browserData.listSites).toHaveBeenCalledTimes(2)
    expect(siteRows()).toEqual(['a.test', 'github.com'])
    expect(scrolled()).toEqual([['certificates', { block: 'start', behavior: 'smooth' }]])
  })

  it('SD-U27 不在详情里点导航：不重列', async () => {
    api.browserData.listSites.mockResolvedValue(SITES)
    await mount()
    click($('[data-settings-nav="privacy"]')!)
    await flush()
    expect(api.browserData.listSites).toHaveBeenCalledTimes(1)
    expect(scrolled()).toEqual([['privacy', { block: 'start', behavior: 'smooth' }]])
  })
})

describe('带 site 的跳转请求（SD-U28）', () => {
  it('SD-U28 挂载时有请求：直接进那个网站的详情、不滚动，请求清掉；重新挂载回到设置页本身', async () => {
    api.browserData.listSites.mockResolvedValue([summary({ site: 'github.com', cookieCount: 1 })])
    useBrowserTabsStore.setState({
      settingsFocus: { section: 'privacy', search: 'www.github.com', site: 'github.com', nonce: 1 }
    })
    await mount()
    expect(detailsSite()).toBe('github.com')
    expect(api.browserData.siteDetails.mock.calls).toEqual([['github.com']])
    expect(scrollSpy).not.toHaveBeenCalled()
    expect(useBrowserTabsStore.getState().settingsFocus).toBeNull()

    // 回到列表：搜索框里是请求带来的主机名
    click($('[data-site-details-back]')!)
    await flush()
    expect(search().value).toBe('www.github.com')
    expect(siteRows()).toEqual(['github.com'])

    m!.unmount()
    m = null
    await mount()
    expect(detailsSite()).toBeNull()
    expect(search().value).toBe('')
    expect(siteRows()).toEqual(['github.com'])
  })

  it('SD-U28 挂着的时候来了带 site 的请求：进详情，请求清掉', async () => {
    api.browserData.listSites.mockResolvedValue([summary({ site: 'a.test', cookieCount: 1 })])
    await mount()
    act(() =>
      useBrowserTabsStore.setState({
        settingsFocus: { section: 'privacy', site: 'a.test', nonce: 3 }
      })
    )
    await flush()
    expect(detailsSite()).toBe('a.test')
    expect(useBrowserTabsStore.getState().settingsFocus).toBeNull()
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('SD-U28 已经在 A 的详情里、来了 B 的请求：换成 B 的详情', async () => {
    api.browserData.listSites.mockResolvedValue([
      summary({ site: 'a.test', cookieCount: 1 }),
      summary({ site: 'b.test', cookieCount: 1 })
    ])
    await mount()
    click($('[data-site-open="a.test"]')!)
    await flush()
    act(() =>
      useBrowserTabsStore.setState({
        settingsFocus: { section: 'privacy', site: 'b.test', nonce: 4 }
      })
    )
    await flush()
    expect(detailsSite()).toBe('b.test')
    expect(api.browserData.siteDetails.mock.calls).toEqual([['a.test'], ['b.test']])
  })
})

describe('不带 site 的跳转请求、此刻在详情里（SD-U29）', () => {
  it('SD-U29 离开详情、再列一次，请求清掉', async () => {
    api.browserData.listSites.mockResolvedValue([summary({ site: 'a.test', cookieCount: 1 })])
    await mount()
    click($('[data-site-open="a.test"]')!)
    await flush()
    expect(detailsSite()).toBe('a.test')

    act(() =>
      useBrowserTabsStore.setState({ settingsFocus: { section: 'certificates', nonce: 9 } })
    )
    await flush()
    expect(detailsSite()).toBeNull()
    expect(api.browserData.listSites).toHaveBeenCalledTimes(2)
    expect(siteRows()).toEqual(['a.test'])
    expect(useBrowserTabsStore.getState().settingsFocus).toBeNull()
  })

  // 离开详情要等下一帧那一节才渲染出来：产品在收起详情之后再排一帧滚动
  it('SD-U29 离开详情之后把那一节滚进视野（{block:"start"}）', async () => {
    api.browserData.listSites.mockResolvedValue([summary({ site: 'a.test', cookieCount: 1 })])
    await mount()
    click($('[data-site-open="a.test"]')!)
    await flush()
    expect(detailsSite()).toBe('a.test')

    act(() =>
      useBrowserTabsStore.setState({ settingsFocus: { section: 'certificates', nonce: 10 } })
    )
    await flush(6)
    expect(detailsSite()).toBeNull()
    expect(scrolled()).toEqual([['certificates', { block: 'start' }]])
  })
})

describe('跳转请求与导航（BS-U44）', () => {
  it('BS-U44 挂载时有请求：填上搜索词、把那一节滚进视野，然后 settingsFocus 变回 null；之后重新挂载什么也不做', async () => {
    api.browserData.listSites.mockResolvedValue([
      summary({ site: 'github.com', cookieCount: 1 }),
      summary({ site: 'a.test', cookieCount: 1 })
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
    // 列表按名字排（不是 listSites 回来的顺序）
    expect(siteRows()).toEqual(['a.test', 'github.com'])
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
    // 滚动排在下一帧（先让详情收起、那一节挂回来）
    click($('[data-settings-nav="certificates"]')!)
    await flush()
    click($('[data-settings-nav="search"]')!)
    await flush()
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
