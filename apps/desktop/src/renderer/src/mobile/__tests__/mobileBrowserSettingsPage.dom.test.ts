// @vitest-environment jsdom
/**
 * 手机布局的「浏览器设置」页（mobile/MobileBrowserSettings.tsx 的 MobileBrowserSettingsPage，jsdom）。
 *
 * 契约：三组卡片 —— 搜索（引擎、搜索建议；那台电脑无头运行时整组置灰、点不动、写不进）、隐私和安全（网站数据一行写
 * 网站个数、点了进网站数据页；删除浏览历史 / 删除浏览数据各先问一句）、证书（忽略证书错误、这次运行里放行过的网站）。
 * 各样东西各取各的，一样取不到不耽误别的。写设置没存上（被拒）→ 控件退回原来的值。这一页压在网站数据页下面时还
 * 挂着：每次回到最上面（`active` 变成 true）重新数一遍网站。
 *
 *   BS-1..7    框架与头一次读取
 *   BS-8..13   搜索那一组（含无头、写不进时退回）
 *   BS-14..20  隐私和安全
 *   BS-21..24  证书
 *
 * `window.api` 是 browserDomSupport 的假件；真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import {
  MobileBrowserSettingsPage,
  type MobileBrowserSettingsPageProps
} from '../MobileBrowserSettings'
import {
  SEARCH_ENGINES,
  SEARCH_ENGINE_SETTING,
  SEARCH_SUGGEST_SETTING
} from '../../../../shared/browserSearchEngines'
import type { SiteSummary } from '../../../../shared/browserSiteData'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  mountInto,
  type FakeApi,
  type Mounted
} from '../../components/browser/__tests__/browserDomSupport'

const S = en.browser.settingsPage
const IGNORE_CERT = 'tool.browser.ignoreCertificateErrors'

let api: FakeApi
let m: Mounted | null = null
const onBack = vi.fn<() => void>()
const onOpenSites = vi.fn<() => void>()

const site = (name: string): SiteSummary => ({
  site: name,
  cookieCount: 1,
  cookieBytes: 10,
  usageBytes: 100,
  localStorage: false,
  originCount: 1
})
const sites = (n: number): SiteSummary[] => Array.from({ length: n }, (_, i) => site(`s${i}.test`))

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

const propsOf = (
  over: Partial<MobileBrowserSettingsPageProps> = {}
): MobileBrowserSettingsPageProps => ({
  headless: false,
  active: true,
  onBack,
  onOpenSites,
  ...over
})
async function mount(over: Partial<MobileBrowserSettingsPageProps> = {}): Promise<void> {
  m = await mountInto(MobileBrowserSettingsPage, propsOf(over))
  await flush()
}
async function rerender(over: Partial<MobileBrowserSettingsPageProps>): Promise<void> {
  await act(async () => {
    m!.root.render(createElement(MobileBrowserSettingsPage, propsOf(over)))
  })
  await flush()
}

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [
  ...m!.container.querySelectorAll<T>(sel)
]
const text = (sel: string): string | null => $(sel)?.textContent ?? null
const engineName = (): string | null => text('[data-mobile-browser-engine-name]')
const select = (): HTMLSelectElement => $<HTMLSelectElement>('[data-mobile-browser-engine]')!
const suggest = (): string | null =>
  $('[data-mobile-browser-suggest]')?.getAttribute('data-mobile-browser-suggest') ?? null
const ignoreCert = (): string | null =>
  $('[data-mobile-browser-ignore-cert]')?.getAttribute('data-mobile-browser-ignore-cert') ?? null
const suggestToggle = (): HTMLButtonElement =>
  $<HTMLButtonElement>('[data-mobile-browser-suggest] button')!
const certToggle = (): HTMLButtonElement =>
  $<HTMLButtonElement>('[data-mobile-browser-ignore-cert] button')!
const siteCount = (): string | null => text('[data-mobile-browser-site-count]')
const certHosts = (): string | null => text('[data-mobile-browser-cert-hosts]')
const searchCard = (): HTMLElement =>
  $('[data-mobile-browser-section="search"]')!.querySelector<HTMLElement>('.rounded-xl')!
const searchNote = (): string => $('[data-mobile-browser-section="search"] p')?.textContent ?? ''
const panel = (): HTMLElement | null => $('.dialog-panel')
const dialogTitle = (): string | null => panel()?.querySelector('h3')?.textContent ?? null
const dialogBtn = (label: string): HTMLButtonElement => {
  const btn = [...(panel()?.querySelectorAll('button') ?? [])].find(
    (el) => el.textContent === label
  )
  if (!btn) throw new Error(`no dialog button ${label}`)
  return btn as HTMLButtonElement
}

async function chooseEngine(value: string): Promise<void> {
  const el = select()
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value)
  act(() => {
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}
async function tap(el: Element): Promise<void> {
  click(el)
  await flush()
}
/** 等确认框的退场动画（120ms）走完 */
async function settleDialog(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160))
  })
}

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  onBack.mockReset()
  onOpenSites.mockReset()
})

afterEach(() => {
  m?.unmount()
  m = null
  vi.restoreAllMocks()
})

describe('框架与头一次读取（BS-1 … BS-7）', () => {
  it('BS-1 browser-settings 页：返回键写「Browser」、标题「Browser settings」；返回 → onBack', async () => {
    await mount()
    expect($('[data-mobile-panel="browser-settings"]')).not.toBeNull()
    expect(text('[data-mobile-panel-back]')).toBe(en.browser.manager.title)
    expect(text('[data-mobile-panel-title]')).toBe(en.mobile.browserSettings)
    click($('[data-mobile-panel-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('BS-2 值来自 settings.getAll：引擎名、下拉框、搜索建议、忽略证书错误', async () => {
    api.settingsMap = {
      [SEARCH_ENGINE_SETTING]: 'bing',
      [SEARCH_SUGGEST_SETTING]: 'false',
      [IGNORE_CERT]: 'true'
    }
    await mount()
    expect(engineName()).toBe(SEARCH_ENGINES.bing.name)
    expect(select().value).toBe('bing')
    expect(suggest()).toBe('off')
    expect(ignoreCert()).toBe('on')
  })

  it('BS-3 没设过：google、搜索建议开、忽略证书错误关', async () => {
    await mount()
    expect(engineName()).toBe(SEARCH_ENGINES.google.name)
    expect(select().value).toBe('google')
    expect(suggest()).toBe('on')
    expect(ignoreCert()).toBe('off')
  })

  it("BS-3 搜索建议只有字面量 'false' 算关", async () => {
    for (const [value, shown] of [
      ['false', 'off'],
      ['0', 'on'],
      ['no', 'on'],
      ['true', 'on']
    ]) {
      api.settingsMap = { [SEARCH_SUGGEST_SETTING]: value }
      await mount()
      expect(suggest()).toBe(shown)
      m!.unmount()
      m = null
    }
  })

  it('BS-4 getAll 被拒 → 缺省值；网站个数与证书网站照样取到', async () => {
    api.settings.getAll.mockRejectedValue(new Error('no'))
    api.browserData.listSites.mockResolvedValue(sites(2))
    api.browserData.certExceptions.mockResolvedValue(['a.test'])
    await mount()
    expect(engineName()).toBe(SEARCH_ENGINES.google.name)
    expect(suggest()).toBe('on')
    expect(ignoreCert()).toBe('off')
    expect(siteCount()).toBe('2')
    expect(certHosts()).toBe('a.test')
  })

  it('BS-5 certExceptions 被拒 →「None」；别的照样', async () => {
    api.settingsMap = { [SEARCH_ENGINE_SETTING]: 'bing' }
    api.browserData.certExceptions.mockRejectedValue(new Error('no'))
    api.browserData.listSites.mockResolvedValue(sites(1))
    await mount()
    expect(certHosts()).toBe(S.noCertExceptions)
    expect(engineName()).toBe(SEARCH_ENGINES.bing.name)
    expect(siteCount()).toBe('1')
  })

  it('BS-6 listSites 被拒 → 行尾不写个数；别的照样', async () => {
    api.settingsMap = { [SEARCH_ENGINE_SETTING]: 'bing' }
    api.browserData.listSites.mockRejectedValue(new Error('no'))
    api.browserData.certExceptions.mockResolvedValue(['a.test'])
    await mount()
    expect($('[data-mobile-browser-site-count]')).toBeNull()
    expect($('[data-mobile-browser-open-sites]')).not.toBeNull()
    expect(engineName()).toBe(SEARCH_ENGINES.bing.name)
    expect(certHosts()).toBe('a.test')
  })

  it('BS-7 读取还没回来就卸载 → 之后回来不写、没有警告', async () => {
    const all = deferred<Record<string, string>>()
    const hosts = deferred<string[]>()
    const list = deferred<SiteSummary[]>()
    api.settings.getAll.mockReturnValue(all.promise)
    api.browserData.certExceptions.mockReturnValue(hosts.promise)
    api.browserData.listSites.mockReturnValue(list.promise)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await mount()
    m!.unmount()
    m = null
    all.resolve({ [SEARCH_ENGINE_SETTING]: 'bing' })
    hosts.resolve(['a.test'])
    list.resolve(sites(3))
    await flush()
    expect(errors).not.toHaveBeenCalled()
  })
})

describe('搜索那一组（BS-8 … BS-13）', () => {
  it('BS-8 下拉框列出每个引擎；改成 bing → 写设置、名字与说明跟着变', async () => {
    await mount()
    expect([...select().options].map((o) => o.value)).toEqual(Object.keys(SEARCH_ENGINES))
    expect([...select().options].map((o) => o.textContent)).toEqual(
      Object.values(SEARCH_ENGINES).map((engine) => engine.name)
    )
    expect(searchNote()).toContain(SEARCH_ENGINES.google.name)

    await chooseEngine('bing')
    expect(api.settings.set.mock.calls).toEqual([[{ key: SEARCH_ENGINE_SETTING, value: 'bing' }]])
    expect(engineName()).toBe(SEARCH_ENGINES.bing.name)
    expect(select().value).toBe('bing')
    expect(searchNote()).toContain(SEARCH_ENGINES.bing.name)
    expect(searchNote()).not.toContain(SEARCH_ENGINES.google.name)
  })

  it("BS-9 搜索建议：点一下写 'false'，再点写 'true'", async () => {
    await mount()
    await tap(suggestToggle())
    expect(suggest()).toBe('off')
    await tap(suggestToggle())
    expect(suggest()).toBe('on')
    expect(api.settings.set.mock.calls).toEqual([
      [{ key: SEARCH_SUGGEST_SETTING, value: 'false' }],
      [{ key: SEARCH_SUGGEST_SETTING, value: 'true' }]
    ])
  })

  it('BS-10 无头：卡片置灰（disabled 标记、aria-disabled、inert），说明换成无头那一句', async () => {
    await mount({ headless: true })
    const card = searchCard()
    expect(card.getAttribute('data-search-settings-disabled')).toBe('true')
    expect(card.getAttribute('aria-disabled')).toBe('true')
    expect(card.hasAttribute('inert')).toBe(true)
    expect(text('[data-headless-search-note]')).toBe(S.headlessSearchNote)
    expect(searchNote()).toBe(S.headlessSearchNote)
  })

  it('BS-11 无头：下拉框的 change、开关的点击都不写设置，显示的值不变', async () => {
    api.settingsMap = { [SEARCH_ENGINE_SETTING]: 'bing' }
    await mount({ headless: true })
    await chooseEngine('google')
    await tap(suggestToggle())
    expect(api.settings.set).not.toHaveBeenCalled()
    expect(engineName()).toBe(SEARCH_ENGINES.bing.name)
    expect(select().value).toBe('bing')
    expect(suggest()).toBe('on')
  })

  it('BS-12 不是无头：没有置灰的标记，没有无头那一句', async () => {
    await mount()
    const card = searchCard()
    expect(card.hasAttribute('data-search-settings-disabled')).toBe(false)
    expect(card.hasAttribute('aria-disabled')).toBe(false)
    expect(card.hasAttribute('inert')).toBe(false)
    expect($('[data-headless-search-note]')).toBeNull()
  })

  it('BS-13 settings.set 被拒（引擎）→ 退回原来的引擎', async () => {
    api.settingsMap = { [SEARCH_ENGINE_SETTING]: 'bing' }
    api.settings.set.mockRejectedValue(new Error('refused by policy'))
    await mount()
    await chooseEngine('duckduckgo')
    expect(api.settings.set).toHaveBeenCalledTimes(1)
    expect(engineName()).toBe(SEARCH_ENGINES.bing.name)
    expect(select().value).toBe('bing')
    expect(searchNote()).toContain(SEARCH_ENGINES.bing.name)
  })

  it('BS-13 settings.set 被拒（搜索建议）→ 退回开着', async () => {
    api.settings.set.mockRejectedValue(new Error('refused by policy'))
    await mount()
    await tap(suggestToggle())
    expect(api.settings.set).toHaveBeenCalledTimes(1)
    expect(suggest()).toBe('on')
  })

  it('BS-13 settings.set 被拒（忽略证书错误）→ 退回关着，警告不留', async () => {
    api.settings.set.mockRejectedValue(new Error('refused by policy'))
    await mount()
    await tap(certToggle())
    expect(api.settings.set).toHaveBeenCalledTimes(1)
    expect(ignoreCert()).toBe('off')
    expect($('[data-mobile-browser-cert-warning]')).toBeNull()
  })
})

describe('隐私和安全（BS-14 … BS-20）', () => {
  it('BS-14 网站数据一行写网站个数；点了 → onOpenSites', async () => {
    api.browserData.listSites.mockResolvedValue(sites(3))
    await mount()
    expect(siteCount()).toBe('3')
    click($('[data-mobile-browser-open-sites]')!)
    expect(onOpenSites).toHaveBeenCalledTimes(1)
  })

  it('BS-14 一个网站都没有 →「0」', async () => {
    await mount()
    expect(siteCount()).toBe('0')
  })

  it('BS-15 删除浏览历史 → 先问（历史的标题与说明）；取消 → 不删', async () => {
    await mount()
    await tap($('[data-mobile-browser-clear="history"]')!)
    expect(dialogTitle()).toBe(S.clearHistory)
    expect(panel()!.textContent).toContain(S.clearHistoryDesc)
    expect(api.browserHistory.clear).not.toHaveBeenCalled()

    click(dialogBtn(en.common.cancel))
    await settleDialog()
    expect(panel()).toBeNull()
    expect(api.browserHistory.clear).not.toHaveBeenCalled()
    expect(api.browserData.clearAll).not.toHaveBeenCalled()
  })

  it('BS-16 确认 → browserHistory.clear() 一次，框收起；clearAll 不调', async () => {
    await mount()
    await tap($('[data-mobile-browser-clear="history"]')!)
    await tap(dialogBtn(S.clearHistoryConfirm))
    expect(api.browserHistory.clear).toHaveBeenCalledTimes(1)
    expect(api.browserData.clearAll).not.toHaveBeenCalled()
    expect(panel()).toBeNull()
  })

  it('BS-16 clear 被拒 → 吞掉，页面照常', async () => {
    api.browserHistory.clear.mockRejectedValue(new Error('no'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await mount()
    await tap($('[data-mobile-browser-clear="history"]')!)
    await tap(dialogBtn(S.clearHistoryConfirm))
    expect(api.browserHistory.clear).toHaveBeenCalledTimes(1)
    expect(panel()).toBeNull()
    expect($('[data-mobile-panel="browser-settings"]')).not.toBeNull()
    expect(errors).not.toHaveBeenCalled()
  })

  it('BS-17 删除浏览数据 → 问的是全部数据；确认 → clearAll 一次，然后重新数网站（3 → 0）', async () => {
    api.browserData.listSites.mockResolvedValueOnce(sites(3)).mockResolvedValue([])
    await mount()
    expect(siteCount()).toBe('3')
    await tap($('[data-mobile-browser-clear="all"]')!)
    expect(dialogTitle()).toBe(S.clearAll)
    expect(panel()!.textContent).toContain(S.clearAllDesc)
    expect(api.browserData.clearAll).not.toHaveBeenCalled()

    await tap(dialogBtn(S.clearAllConfirm))
    expect(api.browserData.clearAll).toHaveBeenCalledTimes(1)
    expect(api.browserHistory.clear).not.toHaveBeenCalled()
    expect(api.browserData.listSites).toHaveBeenCalledTimes(2)
    expect(siteCount()).toBe('0')
    expect(panel()).toBeNull()
  })

  it('BS-18 clearAll 被拒 → 个数不变，不重新数，页面照常', async () => {
    api.browserData.listSites.mockResolvedValue(sites(3))
    api.browserData.clearAll.mockRejectedValue(new Error('no'))
    await mount()
    await tap($('[data-mobile-browser-clear="all"]')!)
    await tap(dialogBtn(S.clearAllConfirm))
    expect(api.browserData.clearAll).toHaveBeenCalledTimes(1)
    expect(api.browserData.listSites).toHaveBeenCalledTimes(1)
    expect(siteCount()).toBe('3')
    expect($('[data-mobile-panel="browser-settings"]')).not.toBeNull()
  })

  it('BS-19 一次只有一个框；两个框的标题、确认钮不一样', async () => {
    await mount()
    await tap($('[data-mobile-browser-clear="history"]')!)
    expect($$('.dialog-panel')).toHaveLength(1)
    const history = { title: dialogTitle(), confirm: S.clearHistoryConfirm }
    expect(() => dialogBtn(S.clearHistoryConfirm)).not.toThrow()

    await tap($('[data-mobile-browser-clear="all"]')!)
    expect($$('.dialog-panel')).toHaveLength(1)
    expect(dialogTitle()).toBe(S.clearAll)
    expect(dialogTitle()).not.toBe(history.title)
    expect(() => dialogBtn(S.clearAllConfirm)).not.toThrow()
    expect(S.clearAllConfirm).not.toBe(history.confirm)
    expect(api.browserHistory.clear).not.toHaveBeenCalled()
    expect(api.browserData.clearAll).not.toHaveBeenCalled()
  })

  it('BS-20 压在别的页下面再回到最上面（active 假 → 真）→ 重新数网站', async () => {
    api.browserData.listSites.mockResolvedValueOnce(sites(3)).mockResolvedValue(sites(2))
    await mount()
    expect(siteCount()).toBe('3')

    await rerender({ active: false })
    expect(api.browserData.listSites).toHaveBeenCalledTimes(1)
    expect(siteCount()).toBe('3')

    await rerender({ active: true })
    expect(api.browserData.listSites).toHaveBeenCalledTimes(2)
    expect(siteCount()).toBe('2')
  })

  it('BS-20 挂上时不在最上面 → 先不数；到了最上面才数', async () => {
    api.browserData.listSites.mockResolvedValue(sites(4))
    await mount({ active: false })
    expect(api.browserData.listSites).not.toHaveBeenCalled()
    expect($('[data-mobile-browser-site-count]')).toBeNull()
    await rerender({ active: true })
    expect(api.browserData.listSites).toHaveBeenCalledTimes(1)
    expect(siteCount()).toBe('4')
  })
})

describe('证书（BS-21 … BS-24）', () => {
  it("BS-21 打开忽略证书错误 → 写 'true'、出现警告；关上 → 写 'false'、警告没了", async () => {
    await mount()
    expect($('[data-mobile-browser-cert-warning]')).toBeNull()
    await tap(certToggle())
    expect(ignoreCert()).toBe('on')
    expect(text('[data-mobile-browser-cert-warning]')).toBe(en.settings.toolBrowserSecurityWarning)
    await tap(certToggle())
    expect(ignoreCert()).toBe('off')
    expect($('[data-mobile-browser-cert-warning]')).toBeNull()
    expect(api.settings.set.mock.calls).toEqual([
      [{ key: IGNORE_CERT, value: 'true' }],
      [{ key: IGNORE_CERT, value: 'false' }]
    ])
  })

  it("BS-22 设置本来就是 'true' → 一进来就有警告", async () => {
    api.settingsMap = { [IGNORE_CERT]: 'true' }
    await mount()
    expect($('[data-mobile-browser-cert-warning]')).not.toBeNull()
  })

  it('BS-23 放行过的网站：没有 →「None」；有 → 用 · 连起来', async () => {
    await mount()
    expect(certHosts()).toBe(S.noCertExceptions)
    m!.unmount()
    m = null
    api.browserData.certExceptions.mockResolvedValue(['a.test', 'b.test'])
    await mount()
    expect(certHosts()).toBe('a.test · b.test')
  })

  it('BS-24 无头时证书那一组不置灰，开关照样写', async () => {
    await mount({ headless: true })
    const card = $('[data-mobile-browser-section="certificates"]')!.querySelector('.rounded-xl')!
    expect(card.hasAttribute('inert')).toBe(false)
    expect(card.hasAttribute('aria-disabled')).toBe(false)
    await tap(certToggle())
    expect(api.settings.set.mock.calls).toEqual([[{ key: IGNORE_CERT, value: 'true' }]])
    expect(ignoreCert()).toBe('on')
  })
})
