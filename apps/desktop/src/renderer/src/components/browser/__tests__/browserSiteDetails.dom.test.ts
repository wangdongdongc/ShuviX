// @vitest-environment jsdom
/**
 * 站点详情（BrowserSiteDetails）—— 浏览器设置页「网站数据」里点进一个网站看到的那一页（2026-10-16）。
 *
 *   SD-U30  还没回答：有返回、有 Loading…；回答之后：网站名 + 「大小 · N cookies · N origins」（单复数）；返回 → onBack；
 *           siteDetails 回 null → 「This site has no stored data.」；
 *   SD-U31  存储一栏只列有数据的类别（本地存储写 Has data，其余写大小），都没有 → 「No local storage, …」；
 *   SD-U32  删一类 / 删整个网站都要确认：确认 → clearSiteCategory(site, 类别) / clearSite(site) → 重读一遍；取消什么也不做；
 *   SD-U33  来源一栏：每行「大小 · Local storage · last used <日期>」（没有的部分不写）；删一个来源要确认 → clearOrigin；
 *           一个来源都没有就没有这一栏；
 *   SD-U34  Cookie 表：每行名字、域 + 路径、过期（会话 Cookie 写 When the session ends）、大小；同一时刻只展开一条的值；
 *           标志一行 Secure / HttpOnly / SameSite=None|Lax|Strict（unspecified 不写）/ Host only；
 *           两条同名 Cookie 的 `data-site-cookie-key` 各不相同、展开互不牵连；
 *   SD-U35  删一条 Cookie 不确认、送 {name, domain, path, secure} → 重读；「删除全部 Cookie」要确认 →
 *           clearSiteCategory(site, 'cookies')；没有 Cookie → No cookies、没有全部删除；
 *   SD-U36  每一种删除失败：不重读、没有未处理的拒绝、没有转圈、确认收起、数据照旧；
 *   SD-U37  挂在设置页下、换了网站（key = 网站）：上一个网站的数据、待确认的删除、展开的 Cookie 一样都不带过来；
 *           上一个网站的回答迟到也不盖掉这一个。
 *
 * `window.api` 是 browserDomSupport 的假件；SettingsPrimitives 走 vitest 别名到 app-shell 的真组件；真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act } from 'react'
import { BrowserSiteDetails } from '../BrowserSiteDetails'
import { BrowserSettingsPage } from '../BrowserSettingsPage'
import { useBrowserTabsStore } from '../../../stores/browserTabsStore'
import {
  formatBytes,
  type SiteCookie,
  type SiteDetails
} from '../../../../../shared/browserSiteData'
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

let api: FakeApi
let m: Mounted | null = null
let onBack: Mock<() => void>

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [
  ...m!.container.querySelectorAll<T>(sel)
]

const T_ACCESSED = Date.UTC(2026, 9, 1, 8, 30)
const T_EXPIRES = Date.UTC(2027, 0, 15, 12, 0)
const dateText = (ms: number): string =>
  new Date(ms).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })

const cookie = (over: Partial<SiteCookie> & { name: string; domain: string }): SiteCookie => ({
  value: 'v',
  path: '/',
  secure: false,
  httpOnly: false,
  hostOnly: !over.domain.startsWith('.'),
  sameSite: 'unspecified',
  size: over.name.length + (over.value ?? 'v').length,
  ...over
})

function githubDetails(): SiteDetails {
  const cookies = [
    cookie({
      name: 'sid',
      value: 'secret-token',
      domain: '.github.com',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expires: T_EXPIRES
    }),
    cookie({ name: 'pref', value: 'dark', domain: 'www.github.com' }),
    cookie({
      name: 'csrf',
      value: '',
      domain: 'www.github.com',
      path: '/login',
      secure: true,
      sameSite: 'strict',
      expires: T_EXPIRES
    }),
    cookie({ name: 'x3', domain: 'gist.github.com', sameSite: 'no_restriction', secure: true })
  ]
  return {
    site: 'github.com',
    cookieCount: cookies.length,
    cookieBytes: 1024,
    usageBytes: 2048,
    localStorage: true,
    originCount: 2,
    lastAccessed: T_ACCESSED,
    origins: [
      {
        origin: 'https://github.com',
        usageBytes: 1536,
        usage: { indexedDB: 1024, cacheStorage: 0, serviceWorkers: 0, other: 512 },
        localStorage: true,
        lastAccessed: T_ACCESSED
      },
      {
        origin: 'https://www.github.com',
        usageBytes: 512,
        usage: { indexedDB: 0, cacheStorage: 512, serviceWorkers: 0, other: 0 },
        localStorage: false
      }
    ],
    cookies
  }
}

/** 一个只有一条 Cookie、一个来源的网站（单数） */
function singleDetails(site = 'a.test'): SiteDetails {
  return {
    site,
    cookieCount: 1,
    cookieBytes: 9,
    usageBytes: 1024,
    localStorage: false,
    originCount: 1,
    origins: [
      {
        origin: `https://${site}`,
        usageBytes: 1024,
        usage: { indexedDB: 0, cacheStorage: 0, serviceWorkers: 1024, other: 0 },
        localStorage: false
      }
    ],
    cookies: [cookie({ name: `${site}-c`, value: 'one', domain: site })]
  }
}

async function mount(site = 'github.com'): Promise<void> {
  m = await mountInto(BrowserSiteDetails, { site, onBack })
  await flush()
}

const root = (): HTMLElement | null => $('[data-site-details]')
/** 网站名下面那一行（大小 · cookies · origins）；空态时是空态那一行 */
const headerLine = (): string => $('[data-site-details] h2 + p')?.textContent ?? ''
const categories = (): Array<[string, string]> =>
  $$('[data-site-category]').map((r) => [
    r.getAttribute('data-site-category')!,
    r.querySelector('.tabular-nums')?.textContent ?? ''
  ])
const originRows = (): string[] =>
  $$('[data-site-origin]').map((r) => r.getAttribute('data-site-origin')!)
const originSubtitle = (origin: string): string =>
  $(`[data-site-origin="${origin}"] .mt-0\\.5`)?.textContent ?? ''
const cookieRow = (key: string): HTMLElement => {
  const el = $(`[data-site-cookie-key="${key}"]`)
  if (!el) throw new Error(`no cookie row ${key}`)
  return el
}
const cookieKeys = (): string[] =>
  $$('[data-site-cookie]').map((r) => r.getAttribute('data-site-cookie-key')!)
/** 展开着值的那些 Cookie 行（key） */
const openCookies = (): string[] =>
  $$('[data-site-cookie]')
    .filter((r) => r.querySelector('[data-site-cookie-value]'))
    .map((r) => r.getAttribute('data-site-cookie-key')!)
const cookieValue = (key: string): string | null =>
  cookieRow(key).querySelector('[data-site-cookie-value]')?.textContent ?? null
const cookieFlags = (key: string): string =>
  cookieRow(key).querySelector('[data-site-cookie-value] + p')?.textContent ?? ''
const toggleCookie = (key: string): void =>
  click(cookieRow(key).querySelector('[data-site-cookie-toggle]')!)
const del = (key: string): HTMLButtonElement => {
  const el = $<HTMLButtonElement>(`[data-site-data-delete="${key}"]`)
  if (!el) throw new Error(`no delete button ${key}`)
  return el
}
const confirmBtn = (key: string): HTMLButtonElement | null =>
  $<HTMLButtonElement>(`[data-site-data-confirm="${key}"]`)
const cancelNextTo = (key: string): HTMLButtonElement =>
  confirmBtn(key)!.nextElementSibling as HTMLButtonElement
const spinners = (): number => $$('.animate-spin').length
const text = (): string => root()?.textContent ?? ''

/** 一个还没回答的 promise */
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  installRaf()
  stubScrollIntoView()
  onBack = vi.fn<() => void>()
  api.browserData.siteDetails.mockImplementation(async (site: string) =>
    site === 'github.com' ? githubDetails() : null
  )
  useBrowserTabsStore.setState({ settingsFocus: null, pageCover: null })
})

afterEach(() => {
  m?.unmount()
  m = null
})

describe('加载、头部与返回（SD-U30）', () => {
  it('SD-U30 还没回答：网站的根、返回按钮、Loading…；没有删除', async () => {
    api.browserData.siteDetails.mockImplementation(() => new Promise(() => undefined))
    await mount()
    expect(root()?.getAttribute('data-site-details')).toBe('github.com')
    expect($('[data-site-details-back]')?.textContent).toBe('Site data')
    expect(text()).toContain('Loading…')
    expect($('[data-site-data-delete]')).toBeNull()
    expect(api.browserData.siteDetails.mock.calls).toEqual([['github.com']])
  })

  it('SD-U30 回答之后：网站名 + 「大小 · 4 cookies · 2 origins」（大小 = 占用 + Cookie 字节）', async () => {
    await mount()
    expect($('[data-site-details] h2')?.textContent).toBe('github.com')
    expect(headerLine()).toBe(`${formatBytes(2048 + 1024)} · 4 cookies · 2 origins`)
    expect(headerLine()).toBe('3 KB · 4 cookies · 2 origins')
    expect(text()).not.toContain('Loading…')
    expect(del('site').textContent).toBe('Delete all data for this site')
  })

  it('SD-U30 单数：「1 cookie · 1 origin」', async () => {
    api.browserData.siteDetails.mockImplementation(async () => singleDetails())
    await mount('a.test')
    expect(headerLine()).toBe('1 KB · 1 cookie · 1 origin')
  })

  it('SD-U30 返回 → onBack（一次，不删除任何东西）', async () => {
    await mount()
    click($('[data-site-details-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(api.browserData.clearSite).not.toHaveBeenCalled()
  })

  it('SD-U30 siteDetails 回 null：网站名 + 「This site has no stored data.」；没有删除、没有各栏；返回照样能用', async () => {
    await mount('nothing.test')
    expect($('[data-site-details] h2')?.textContent).toBe('nothing.test')
    expect($('[data-site-details-empty]')?.textContent).toBe('This site has no stored data.')
    expect($('[data-site-data-delete]')).toBeNull()
    expect($('[data-site-category]')).toBeNull()
    expect($('[data-site-cookie]')).toBeNull()
    click($('[data-site-details-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('存储一栏（SD-U31）', () => {
  it('SD-U31 只列有数据的类别：本地存储写 Has data，其余写各来源之和', async () => {
    await mount()
    expect(categories()).toEqual([
      ['localStorage', 'Has data'],
      ['indexedDB', '1 KB'],
      ['cacheStorage', '512 B'],
      ['other', '512 B']
    ])
    expect($('[data-site-category="localStorage"]')?.textContent).toContain('Local storage')
    expect($('[data-site-category="indexedDB"]')?.textContent).toContain('IndexedDB databases')
    expect(del('indexedDB').getAttribute('aria-label')).toBe('Delete IndexedDB databases')
  })

  it('SD-U31 只有 Service Worker：只有那一行', async () => {
    api.browserData.siteDetails.mockImplementation(async () => singleDetails())
    await mount('a.test')
    expect(categories()).toEqual([['serviceWorkers', '1 KB']])
  })

  it('SD-U31 一类都没有（只有 Cookie）：「No local storage, IndexedDB, …」', async () => {
    api.browserData.siteDetails.mockImplementation(async () => ({
      ...singleDetails(),
      usageBytes: 0,
      originCount: 0,
      origins: []
    }))
    await mount('a.test')
    expect(categories()).toEqual([])
    expect(text()).toContain('No local storage, IndexedDB, cache storage or other stored data.')
  })
})

describe('删一类、删整个网站（SD-U32）', () => {
  it.each([['localStorage'], ['indexedDB'], ['cacheStorage'], ['other']])(
    'SD-U32 删 %s：先确认，确认 → clearSiteCategory(site, 类别) → 重读',
    async (category) => {
      await mount()
      click(del(category))
      expect(api.browserData.clearSiteCategory).not.toHaveBeenCalled()
      expect(confirmBtn(category)?.textContent).toBe('Confirm')
      click(confirmBtn(category)!)
      await flush()
      expect(api.browserData.clearSiteCategory.mock.calls).toEqual([['github.com', category]])
      expect(api.browserData.siteDetails).toHaveBeenCalledTimes(2)
      expect(api.browserData.siteDetails.mock.invocationCallOrder[1]).toBeGreaterThan(
        api.browserData.clearSiteCategory.mock.invocationCallOrder[0]
      )
      expect(confirmBtn(category)).toBeNull()
    }
  )

  it('SD-U32 确认里的取消：回到垃圾桶，什么也不删', async () => {
    await mount()
    click(del('indexedDB'))
    click(cancelNextTo('indexedDB'))
    expect(confirmBtn('indexedDB')).toBeNull()
    expect(del('indexedDB')).not.toBeNull()
    expect(api.browserData.clearSiteCategory).not.toHaveBeenCalled()
    expect(api.browserData.siteDetails).toHaveBeenCalledTimes(1)
  })

  it('SD-U32 同一时刻只有一个待确认：点了 A 的垃圾桶再点 B 的，A 的确认收起', async () => {
    await mount()
    click(del('indexedDB'))
    click(del('cacheStorage'))
    expect(confirmBtn('indexedDB')).toBeNull()
    expect(confirmBtn('cacheStorage')).not.toBeNull()
  })

  it('SD-U32 删除整个网站：确认（会退出登录）→ clearSite(site) → 重读；重读回 null 就是空态', async () => {
    await mount()
    click(del('site'))
    expect(api.browserData.clearSite).not.toHaveBeenCalled()
    expect(confirmBtn('site')?.textContent).toBe('Confirm (signs you out)')
    api.browserData.siteDetails.mockImplementation(async () => null)
    click(confirmBtn('site')!)
    await flush()
    expect(api.browserData.clearSite.mock.calls).toEqual([['github.com']])
    expect(api.browserData.siteDetails).toHaveBeenCalledTimes(2)
    expect($('[data-site-details-empty]')).not.toBeNull()
    expect(onBack).not.toHaveBeenCalled()
  })

  it('SD-U32 删除整个网站的取消：什么也不删', async () => {
    await mount()
    click(del('site'))
    click(cancelNextTo('site'))
    expect(confirmBtn('site')).toBeNull()
    expect(api.browserData.clearSite).not.toHaveBeenCalled()
  })
})

describe('来源一栏（SD-U33）', () => {
  it('SD-U33 每行「大小 · Local storage · last used <日期>」，没有的部分不写；按回答的顺序', async () => {
    await mount()
    expect(originRows()).toEqual(['https://github.com', 'https://www.github.com'])
    expect(originSubtitle('https://github.com')).toBe(
      `1.5 KB · Local storage · last used ${dateText(T_ACCESSED)}`
    )
    expect(originSubtitle('https://www.github.com')).toBe('512 B')
  })

  it('SD-U33 删一个来源：先确认，确认 → clearOrigin(origin) → 重读', async () => {
    await mount()
    const key = 'origin:https://www.github.com'
    click($(`[data-site-origin="https://www.github.com"] [data-site-data-delete="${key}"]`)!)
    expect(api.browserData.clearOrigin).not.toHaveBeenCalled()
    click(confirmBtn(key)!)
    await flush()
    expect(api.browserData.clearOrigin.mock.calls).toEqual([['https://www.github.com']])
    expect(api.browserData.clearSiteCategory).not.toHaveBeenCalled()
    expect(api.browserData.removeCookie).not.toHaveBeenCalled()
    expect(api.browserData.siteDetails).toHaveBeenCalledTimes(2)
  })

  it('SD-U33 一个来源都没有：没有来源这一栏', async () => {
    api.browserData.siteDetails.mockImplementation(async () => ({
      ...singleDetails(),
      origins: [],
      originCount: 0
    }))
    await mount('a.test')
    expect(originRows()).toEqual([])
    expect(text()).not.toContain('Origins')
  })
})

describe('Cookie 表（SD-U34）', () => {
  it('SD-U34 每行：名字、域 + 路径、过期、大小；标题带条数；值默认收着', async () => {
    await mount()
    expect(text()).toContain('Cookies (4)')
    expect(cookieKeys()).toEqual([
      '.github.com|/|sid',
      'www.github.com|/|pref',
      'www.github.com|/login|csrf',
      'gist.github.com|/|x3'
    ])
    expect($$('[data-site-cookie]').map((r) => r.getAttribute('data-site-cookie'))).toEqual([
      'sid',
      'pref',
      'csrf',
      'x3'
    ])
    const sid = cookieRow('.github.com|/|sid').textContent ?? ''
    expect(sid).toContain('.github.com/')
    expect(sid).toContain(dateText(T_EXPIRES))
    expect(sid).toContain(formatBytes('sid'.length + 'secret-token'.length))
    expect(cookieRow('www.github.com|/|pref').textContent).toContain('When the session ends')
    expect(cookieRow('www.github.com|/login|csrf').textContent).toContain('www.github.com/login')
    expect(openCookies()).toEqual([])
    expect(text()).not.toContain('secret-token')
  })

  it('SD-U34 同一时刻只展开一条：展开 A、再展开 B → A 收起；再点 B → 都收起', async () => {
    await mount()
    const toggle = cookieRow('.github.com|/|sid').querySelector('[data-site-cookie-toggle]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('Show value')

    toggleCookie('.github.com|/|sid')
    expect(openCookies()).toEqual(['.github.com|/|sid'])
    expect(cookieValue('.github.com|/|sid')).toBe('secret-token')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('Hide value')

    toggleCookie('www.github.com|/|pref')
    expect(openCookies()).toEqual(['www.github.com|/|pref'])
    expect(cookieValue('www.github.com|/|pref')).toBe('dark')

    toggleCookie('www.github.com|/|pref')
    expect(openCookies()).toEqual([])
  })

  it('SD-U34 标志一行：Secure / HttpOnly / SameSite=Lax|Strict|None，unspecified 不写；只限主机的写 Host only；空值写 ""', async () => {
    await mount()
    toggleCookie('.github.com|/|sid')
    expect(cookieFlags('.github.com|/|sid')).toBe('.github.com/ · Secure · HttpOnly · SameSite=Lax')
    toggleCookie('www.github.com|/|pref')
    expect(cookieFlags('www.github.com|/|pref')).toBe('www.github.com/ · Host only')
    toggleCookie('www.github.com|/login|csrf')
    expect(cookieValue('www.github.com|/login|csrf')).toBe('""')
    expect(cookieFlags('www.github.com|/login|csrf')).toBe(
      'www.github.com/login · Secure · SameSite=Strict · Host only'
    )
    toggleCookie('gist.github.com|/|x3')
    expect(cookieFlags('gist.github.com|/|x3')).toBe(
      'gist.github.com/ · Secure · SameSite=None · Host only'
    )
  })

  it('SD-U34 两条同名 Cookie（/ 与 /sub）：data-site-cookie 一样、data-site-cookie-key 各不相同，展开互不牵连', async () => {
    const d = githubDetails()
    d.cookies = [
      cookie({ name: 'dup', value: 'root', domain: '127.0.0.1', path: '/' }),
      cookie({ name: 'dup', value: 'sub', domain: '127.0.0.1', path: '/sub' })
    ]
    d.cookieCount = 2
    api.browserData.siteDetails.mockImplementation(async () => d)
    await mount('127.0.0.1')
    const rows = $$('[data-site-cookie="dup"]')
    expect(rows).toHaveLength(2)
    expect(cookieKeys()).toEqual(['127.0.0.1|/|dup', '127.0.0.1|/sub|dup'])
    expect(new Set(cookieKeys()).size).toBe(2)
    toggleCookie('127.0.0.1|/sub|dup')
    expect(openCookies()).toEqual(['127.0.0.1|/sub|dup'])
    expect(cookieValue('127.0.0.1|/sub|dup')).toBe('sub')
  })
})

describe('删 Cookie（SD-U35）', () => {
  it('SD-U35 删一条不确认：送 {name, domain, path, secure}（不多不少）→ 重读', async () => {
    await mount()
    click(cookieRow('www.github.com|/login|csrf').querySelector('[data-site-cookie-delete]')!)
    await flush()
    expect(api.browserData.removeCookie.mock.calls).toEqual([
      [{ name: 'csrf', domain: 'www.github.com', path: '/login', secure: true }]
    ])
    expect(api.browserData.siteDetails).toHaveBeenCalledTimes(2)
    expect(api.browserData.clearSiteCategory).not.toHaveBeenCalled()
  })

  it('SD-U35 删同名两条里 /sub 那一条：送的是 /sub 的路径', async () => {
    const d = githubDetails()
    d.cookies = [
      cookie({ name: 'dup', value: 'root', domain: '127.0.0.1', path: '/' }),
      cookie({ name: 'dup', value: 'sub', domain: '127.0.0.1', path: '/sub' })
    ]
    api.browserData.siteDetails.mockImplementation(async () => d)
    await mount('127.0.0.1')
    click(cookieRow('127.0.0.1|/sub|dup').querySelector('[data-site-cookie-delete]')!)
    await flush()
    expect(api.browserData.removeCookie.mock.calls).toEqual([
      [{ name: 'dup', domain: '127.0.0.1', path: '/sub', secure: false }]
    ])
  })

  it('SD-U35 删除全部 Cookie：先确认，确认 → clearSiteCategory(site, cookies) → 重读', async () => {
    await mount()
    expect(del('cookies').getAttribute('aria-label')).toBe('Delete all cookies')
    click(del('cookies'))
    expect(api.browserData.clearSiteCategory).not.toHaveBeenCalled()
    click(confirmBtn('cookies')!)
    await flush()
    expect(api.browserData.clearSiteCategory.mock.calls).toEqual([['github.com', 'cookies']])
    expect(api.browserData.removeCookie).not.toHaveBeenCalled()
    expect(api.browserData.siteDetails).toHaveBeenCalledTimes(2)
  })

  it('SD-U35 没有 Cookie：「No cookies」、没有全部删除', async () => {
    api.browserData.siteDetails.mockImplementation(async () => ({
      ...githubDetails(),
      cookieCount: 0,
      cookieBytes: 0,
      cookies: []
    }))
    await mount()
    expect(text()).toContain('Cookies (0)')
    expect(text()).toContain('No cookies')
    expect($('[data-site-data-delete="cookies"]')).toBeNull()
    expect($('[data-site-cookie]')).toBeNull()
  })
})

describe('删除失败（SD-U36）', () => {
  const failing: Array<[string, () => void, () => Mock]> = [
    [
      '整个网站',
      () => (click(del('site')), click(confirmBtn('site')!)),
      () => api.browserData.clearSite
    ],
    [
      '一类',
      () => (click(del('indexedDB')), click(confirmBtn('indexedDB')!)),
      () => api.browserData.clearSiteCategory
    ],
    [
      '一个来源',
      () => (
        click(del('origin:https://github.com')),
        click(confirmBtn('origin:https://github.com')!)
      ),
      () => api.browserData.clearOrigin
    ],
    [
      '全部 Cookie',
      () => (click(del('cookies')), click(confirmBtn('cookies')!)),
      () => api.browserData.clearSiteCategory
    ],
    [
      '一条 Cookie',
      () => click(cookieRow('.github.com|/|sid').querySelector('[data-site-cookie-delete]')!),
      () => api.browserData.removeCookie
    ]
  ]

  it.each(failing)(
    'SD-U36 删%s失败：不重读、没有未处理的拒绝、没有转圈、确认收起、数据照旧',
    async (_what, act_, fn) => {
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      try {
        fn().mockRejectedValue(new Error('partition locked'))
        await mount()
        act_()
        await flush()
        await new Promise((r) => setTimeout(r, 0))
        expect(fn()).toHaveBeenCalledTimes(1)
        expect(api.browserData.siteDetails).toHaveBeenCalledTimes(1)
        expect(unhandled).not.toHaveBeenCalled()
        expect(spinners()).toBe(0)
        expect($('[data-site-data-confirm]')).toBeNull()
        // 数据照旧：头部、各栏、Cookie 都还在，垃圾桶可以再点
        expect(headerLine()).toBe('3 KB · 4 cookies · 2 origins')
        expect(categories()).toHaveLength(4)
        expect(originRows()).toHaveLength(2)
        expect(cookieKeys()).toHaveLength(4)
        expect(del('site')).not.toBeNull()
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    }
  )

  it('SD-U36 确认之后、回答之前：确认按钮禁用并转圈；回答失败之后收起', async () => {
    let rejectIt!: (e: unknown) => void
    api.browserData.clearSite.mockImplementation(
      () =>
        new Promise<void>((_res, rej) => {
          rejectIt = rej
        })
    )
    await mount()
    click(del('site'))
    click(confirmBtn('site')!)
    await flush()
    expect(confirmBtn('site')?.disabled).toBe(true)
    expect(spinners()).toBe(1)
    await act(async () => {
      rejectIt(new Error('nope'))
    })
    await flush()
    expect(spinners()).toBe(0)
    expect(confirmBtn('site')).toBeNull()
    expect(api.browserData.siteDetails).toHaveBeenCalledTimes(1)
  })
})

describe('挂在设置页下、换了网站（SD-U37）', () => {
  it('SD-U37 A 的数据、待确认的删除、展开的 Cookie 都不带到 B；A 迟到的回答也不盖掉 B', async () => {
    const lateA = deferred<SiteDetails>()
    let aCalls = 0
    api.browserData.siteDetails.mockImplementation(async (site: string) => {
      if (site === 'github.com') {
        aCalls++
        // 第二次问 A（换回来之前不会有）走迟到的那一个
        return aCalls === 1 ? githubDetails() : lateA.promise
      }
      if (site === 'b.test') return singleDetails('b.test')
      return null
    })
    useBrowserTabsStore.setState({
      settingsFocus: { section: 'privacy', site: 'github.com', nonce: 1 }
    })
    m = await mountInto(BrowserSettingsPage, {})
    await flush()
    expect(root()?.getAttribute('data-site-details')).toBe('github.com')

    // A 上：展开一条 Cookie、点开一个待确认的删除
    toggleCookie('.github.com|/|sid')
    click(del('indexedDB'))
    expect(openCookies()).toEqual(['.github.com|/|sid'])
    expect(confirmBtn('indexedDB')).not.toBeNull()

    // 换到 B
    act(() =>
      useBrowserTabsStore.setState({
        settingsFocus: { section: 'privacy', site: 'b.test', nonce: 2 }
      })
    )
    await flush()
    expect(root()?.getAttribute('data-site-details')).toBe('b.test')
    expect(headerLine()).toBe('1 KB · 1 cookie · 1 origin')
    expect($('[data-site-data-confirm]')).toBeNull()
    expect(openCookies()).toEqual([])
    expect(text()).not.toContain('github.com')
    expect(text()).not.toContain('secret-token')
    expect(cookieKeys()).toEqual(['b.test|/|b.test-c'])

    // 回到 A 又马上换到 B：A 那次的回答在 B 挂上之后才到 —— 不盖掉 B
    act(() =>
      useBrowserTabsStore.setState({
        settingsFocus: { section: 'privacy', site: 'github.com', nonce: 3 }
      })
    )
    await flush()
    act(() =>
      useBrowserTabsStore.setState({
        settingsFocus: { section: 'privacy', site: 'b.test', nonce: 4 }
      })
    )
    await flush()
    await act(async () => {
      lateA.resolve(githubDetails())
    })
    await flush()
    expect(root()?.getAttribute('data-site-details')).toBe('b.test')
    expect(headerLine()).toBe('1 KB · 1 cookie · 1 origin')
    expect(text()).not.toContain('github.com')
  })
})
