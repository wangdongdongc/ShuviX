// @vitest-environment jsdom
/**
 * 浏览器管理页的「标签页」一节（BrowserTabsManager，web 客户端的 #browser-manager，2026-11-01）—— 另一台设备上管理运行
 * ShuviX 的那台电脑上内置浏览器的标签页。
 *
 *   TM-1  三行：有标题的网页写标题；内部设置页（标题空）写本地化的页名；没标题的网页写地址；地址一行写 url，空的写
 *         about:blank；标题「3 tabs」/「1 tab」；0 个 → 空态
 *   TM-2  加载中 → data-tab-loading + 停止按钮（stop(id)）；没在加载 → 刷新（reload(id)）；崩了 → [data-browser-tab-crashed]
 *         「Page crashed」；拦截中写「Intercepting network requests」
 *   TM-3  agent 用着：写会话标题 + [data-browser-tab-open-session]；没有标题就写会话 id
 *   TM-4  browser.tabsChanged → 重新列、重画；别的事件不列
 *   TM-5  过期的回答：先发的 listTabs 晚于后发的回来，不盖掉后来的
 *   TM-6  输入空 / 全是空白 + Open → createTab()（不带参数）
 *   TM-7  引擎 bing：'example.com' → createTab('https://example.com', 'typed')；'two words' → bing 的搜索地址；
 *         'shuvix://settings' 原样；成功后输入框清空；请求中 Open 禁用
 *   TM-8  引擎认不出、或 settings.getAll 失败 → 缺省（google）的搜索地址
 *   TM-9  createTab 拒绝 {code:'remote_url_refused', message:'raw server text'} → [data-browser-manager-error] 是本地化的那句、
 *         不是原文；输入框留着；重新列一次；普通 Error('denied by rule X') →「That did not work: denied by rule X」；
 *         下一个动作清掉错误
 *   TM-10 铅笔 → 聚焦的输入框、预填 url；回车 / Go（'example.org'）→ navigate(id, 'https://example.org', 'typed') 并收起；
 *         失败 → 留着、显示错误；空字 → 收起、不导航
 *   TM-11 Escape、Cancel → 收起、不调；内部页面那一行没有铅笔
 *   TM-12 View conversation → app.openSessionWithDraft({sessionId:'s1', draft:''}) 一次
 *   TM-13 关闭 → closeTab(id)，然后重新列
 *   TM-14 listTabs 拒绝 Error('NB prompt') → [data-browser-tabs-denied]「This device may not see the tabs: NB prompt」，没有行、
 *         没有空态；之后一次 tabsChanged 列到了 → 画出行
 *   TM-15 [data-browser-manager-note]：headless 一句、不 headless 另一句
 *
 * 截图（P2，TabScreenshot）：
 *   TS-1  挂载 + 两次 tabsChanged → 不截、没有面板；每个网页行一个开关（aria-expanded false、showScreenshot）
 *   TS-2  点开 → capture('a', 720) 一次、loading 文案、说明一行、重新截图禁用、开关 aria-expanded true / hideScreenshot
 *   TS-3  宽度 = min(1280, round(720 × max(1, dpr)))：2→1280、1.5→1080、1.25→900、0.5→720、没有→720
 *   TS-4  data URL → shown、src 原样、alt、「Taken at <时间>」、重新截图可点
 *   TS-5  '' → empty 文案、没有 img、说明一行
 *   TS-6  Error('NB rule prompt') → failed「Could not take a screenshot: NB rule prompt」
 *   TS-7  remote_url_refused → 本地化的那句，原文不出现
 *   TS-8  拒绝的是字符串 'boom' → 原因就是 boom
 *   TS-9  再点开关收起（不再截）；再点开 → 再截一次、从 loading 开始
 *   TS-10 一次只开一张：开 a 再开 b → 只有 b 的面板；a 晚回来的结果不画
 *   TS-11 重新截图：loading + 禁用 → 新图；失败之后重新截图 → shown
 *   TS-12 截图中重新截图是禁用的（点了不截），第一次的结果照常画（晚回来的旧结果只可能出现在收起再点开时，见 TS-13）
 *   TS-13 收起后结果才回来 → 什么都不画、没有 React 警告；收起再点开，旧结果晚回来不动新面板
 *   TS-14 那一页从列表里没了 / 列表被拒 → 面板收起；回来了也不自己再开、不再截
 *   TS-15 tabsChanged 里那一行变了（标题 / 地址 / 加载）→ 不再截，同一张图、同一个节点
 *   TS-16 内部页面没有开关；开着的网页行变成内部页面 → 面板与开关都没了，变回网页也不自己开
 *   I18N-1 zh / en / ja 九个截图文案非空；screenshotTakenAt 有 {{time}}、screenshotFailed 有 {{reason}}
 *
 * `window.api` 是 browserDomSupport 的假件（events.subscribe 记下订阅者，用例手动派发）；@shuvix/chat-ui 是真的
 * （useAppEvent 退回 window.api.events）；真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act } from 'react'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import { BrowserTabsManager } from '../BrowserTabsManager'
import { searchUrl } from '../../../../../shared/browserSearchEngines'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  installRaf,
  keyDown,
  mountInto,
  typeInto,
  type FakeApi,
  type Mounted
} from './browserDomSupport'

const M = en.browser.manager

type Row = Awaited<ReturnType<typeof window.api.browserView.listTabs>>[number]

let api: FakeApi
let m: Mounted | null = null
let subscribers: Set<(event: { type: string; [k: string]: unknown }) => void>
let openSessionWithDraft: Mock

const row = (over: Partial<Row> & { id: string }): Row => ({
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
})

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [
  ...m!.container.querySelectorAll<T>(sel)
]
const rowEl = (id: string): HTMLElement => {
  const el = $(`[data-browser-manager-tab="${id}"]`)
  if (!el) throw new Error(`no row ${id}`)
  return el
}
const rowIds = (): string[] =>
  $$('[data-browser-manager-tab]').map((el) => el.getAttribute('data-browser-manager-tab')!)
/** 行里的标题（第一行字） */
const titleOf = (id: string): string =>
  rowEl(id).querySelector('.min-w-0.flex-1 > div')?.textContent ?? ''
const urlOf = (id: string): string =>
  rowEl(id).querySelector('[data-browser-tab-url]')?.textContent ?? ''
const heading = (): string => $('[data-browser-tab-count]')?.textContent ?? ''
const newInput = (): HTMLInputElement => $<HTMLInputElement>('[data-browser-new-tab-input]')!
const openBtn = (): HTMLButtonElement => $<HTMLButtonElement>('[data-browser-new-tab-open]')!
const errorText = (): string | null => $('[data-browser-manager-error]')?.textContent ?? null

async function mount(props: { headless?: boolean; compact?: boolean } = {}): Promise<void> {
  m = await mountInto(BrowserTabsManager, { headless: false, compact: false, ...props })
  await flush()
}

/** 派发一条 app 事件给所有订阅者 */
async function emit(event: { type: string; [k: string]: unknown }): Promise<void> {
  await act(async () => {
    for (const fn of [...subscribers]) fn(event)
  })
  await flush()
}

/** 提交新建表单（Open） */
async function submitNew(): Promise<void> {
  click(openBtn())
  await flush()
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

/** 主进程拒绝地址时那种带 code 的错误 */
function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  installRaf()
  subscribers = new Set()
  api.events.subscribe.mockImplementation((fn: (event: { type: string }) => void) => {
    subscribers.add(fn)
    return () => {
      subscribers.delete(fn)
    }
  })
  openSessionWithDraft = vi.fn(async () => ({ success: true }))
  ;(api.app as Record<string, unknown>).openSessionWithDraft = openSessionWithDraft
  api.browserView.createTab.mockImplementation(async () => 'tab-new')
})

afterEach(() => {
  m?.unmount()
  m = null
})

describe('列表（TM-1 … TM-3）', () => {
  it('TM-1 三行：标题 / 内部页面的本地化页名 / 没标题写地址；地址一行；标题「3 tabs」', async () => {
    api.browserView.listTabs.mockResolvedValue([
      row({ id: 'a', url: 'https://a.test/page', title: 'A page' }),
      row({ id: 's', url: 'shuvix://settings', title: '', internalPage: 'settings' }),
      row({ id: 'u', url: 'https://u.test/x', title: '' })
    ])
    await mount()
    expect(rowIds()).toEqual(['a', 's', 'u'])
    expect(titleOf('a')).toBe('A page')
    expect(titleOf('s')).toBe(en.browser.internal.settings)
    expect(titleOf('u')).toBe('https://u.test/x')
    expect(urlOf('a')).toBe('https://a.test/page')
    expect(urlOf('s')).toBe('shuvix://settings')
    expect(heading()).toBe('3 tabs')
    expect($('[data-browser-tabs-empty]')).toBeNull()
  })

  it('TM-1 地址是空串 → 地址一行写 about:blank；一个 tab →「1 tab」', async () => {
    api.browserView.listTabs.mockResolvedValue([row({ id: 'b', url: '', title: '' })])
    await mount()
    expect(urlOf('b')).toBe('about:blank')
    expect(heading()).toBe('1 tab')
  })

  it('TM-1 一个都没有 → 空态「No tabs are open」、「0 tabs」', async () => {
    await mount()
    expect(rowIds()).toEqual([])
    expect($('[data-browser-tabs-empty]')?.textContent).toBe(M.noTabs)
    expect(heading()).toBe('0 tabs')
  })

  it('TM-2 加载中：data-tab-loading、停止按钮 → stop(id)；没在加载：刷新 → reload(id)', async () => {
    api.browserView.listTabs.mockResolvedValue([
      row({ id: 'l', loading: true }),
      row({ id: 'r', loading: false })
    ])
    await mount()
    expect(rowEl('l').getAttribute('data-tab-loading')).toBe('true')
    expect(rowEl('r').hasAttribute('data-tab-loading')).toBe(false)
    expect(rowEl('l').querySelector('[data-browser-tab-reload]')).toBeNull()
    expect(rowEl('r').querySelector('[data-browser-tab-stop]')).toBeNull()

    click(rowEl('l').querySelector('[data-browser-tab-stop]')!)
    await flush()
    expect(api.browserView.stop.mock.calls).toEqual([['l']])
    click(rowEl('r').querySelector('[data-browser-tab-reload]')!)
    await flush()
    expect(api.browserView.reload.mock.calls).toEqual([['r']])
  })

  it('TM-2 崩了：[data-browser-tab-crashed]「Page crashed」；拦截中：「Intercepting network requests」', async () => {
    api.browserView.listTabs.mockResolvedValue([
      row({ id: 'c', crashed: true }),
      row({ id: 'i', cdpAttached: true, cdpIntercepting: true, agentSessionId: 's1' }),
      row({ id: 'n' })
    ])
    await mount()
    expect(rowEl('c').getAttribute('data-tab-crashed')).toBe('true')
    expect(rowEl('c').querySelector('[data-browser-tab-crashed]')?.textContent).toBe(M.crashed)
    expect(rowEl('i').textContent).toContain(M.intercepting)
    expect(rowEl('n').querySelector('[data-browser-tab-crashed]')).toBeNull()
    expect(rowEl('n').textContent).not.toContain(M.intercepting)
  })

  it('TM-3 agent 用着：写会话标题 + View conversation；没有标题写会话 id', async () => {
    api.browserView.listTabs.mockResolvedValue([
      row({ id: 'a', agentSessionId: 's1', agentSessionTitle: 'Fix the build' }),
      row({ id: 'b', agentSessionId: 's2' }),
      row({ id: 'c' })
    ])
    await mount()
    expect(rowEl('a').getAttribute('data-tab-agent')).toBe('s1')
    expect(rowEl('a').textContent).toContain('In use by “Fix the build”')
    expect(rowEl('a').querySelector('[data-browser-tab-open-session]')?.textContent).toBe(
      en.browser.infobar.openSession
    )
    expect(rowEl('b').textContent).toContain('In use by “s2”')
    expect(rowEl('c').querySelector('[data-browser-tab-open-session]')).toBeNull()
  })
})

describe('跟着事件重新列（TM-4 / TM-5）', () => {
  it('TM-4 browser.tabsChanged → 重新列、重画；别的事件不列', async () => {
    api.browserView.listTabs.mockResolvedValueOnce([row({ id: 'a', title: 'A' })])
    await mount()
    expect(rowIds()).toEqual(['a'])
    expect(api.browserView.listTabs).toHaveBeenCalledTimes(1)

    await emit({ type: 'settings.changed', keys: [] })
    await emit({ type: 'session.changed' })
    expect(api.browserView.listTabs).toHaveBeenCalledTimes(1)

    api.browserView.listTabs.mockResolvedValueOnce([
      row({ id: 'a', title: 'A renamed' }),
      row({ id: 'b', title: 'B' })
    ])
    await emit({ type: 'browser.tabsChanged', count: 2 })
    expect(api.browserView.listTabs).toHaveBeenCalledTimes(2)
    expect(rowIds()).toEqual(['a', 'b'])
    expect(titleOf('a')).toBe('A renamed')
    expect(heading()).toBe('2 tabs')
  })

  it('TM-5 先发的 listTabs 晚回来：不盖掉后发的那一份', async () => {
    const first = deferred<Row[]>()
    api.browserView.listTabs.mockImplementationOnce(() => first.promise)
    await mount()
    api.browserView.listTabs.mockResolvedValueOnce([row({ id: 'new', title: 'New' })])
    await emit({ type: 'browser.tabsChanged', count: 1 })
    expect(rowIds()).toEqual(['new'])

    await act(async () => first.resolve([row({ id: 'old', title: 'Old' })]))
    await flush()
    expect(rowIds()).toEqual(['new'])
  })
})

describe('新建标签页（TM-6 … TM-9）', () => {
  it.each(['', '   '])('TM-6 输入 %j + Open → createTab()（不带参数）', async (text) => {
    await mount()
    typeInto(newInput(), text)
    await submitNew()
    expect(api.browserView.createTab).toHaveBeenCalledTimes(1)
    expect(api.browserView.createTab.mock.calls[0]).toEqual([])
  })

  it.each([
    ['example.com', 'https://example.com'],
    ['two words', searchUrl('two words', 'bing')],
    ['shuvix://settings', 'shuvix://settings']
  ])("TM-7 引擎 bing：%j → createTab(%j, 'typed')，成功后清空", async (text, target) => {
    api.settingsMap = { 'browser.searchEngine': 'bing' }
    await mount()
    typeInto(newInput(), text)
    await submitNew()
    expect(api.browserView.createTab.mock.calls).toEqual([[target, 'typed']])
    expect(newInput().value).toBe('')
    if (text === 'two words') expect(target).toContain('bing.com')
  })

  it('TM-7 请求中 Open 禁用，回来之后恢复', async () => {
    const pending = deferred<string>()
    api.browserView.createTab.mockImplementationOnce(() => pending.promise)
    await mount()
    typeInto(newInput(), 'example.com')
    await submitNew()
    expect(openBtn().disabled).toBe(true)
    await act(async () => pending.resolve('tab-1'))
    await flush()
    expect(openBtn().disabled).toBe(false)
    expect(newInput().value).toBe('')
  })

  it.each([
    ['认不出的引擎', () => void (api.settingsMap = { 'browser.searchEngine': 'altavista' })],
    ['settings.getAll 失败', () => void api.settings.getAll.mockRejectedValue(new Error('offline'))]
  ])('TM-8 %s → 缺省（google）的搜索地址', async (_l, arrange) => {
    arrange()
    await mount()
    typeInto(newInput(), 'two words')
    await submitNew()
    const expected = searchUrl('two words', 'google')
    expect(expected).toContain('google.')
    expect(api.browserView.createTab.mock.calls).toEqual([[expected, 'typed']])
  })

  it('TM-9 remote_url_refused → 本地化的那句（不是原文）；输入框留着；重新列一次；下一个动作清掉错误', async () => {
    api.browserView.listTabs.mockResolvedValue([row({ id: 'a' })])
    api.browserView.createTab.mockRejectedValueOnce(
      codedError('remote_url_refused', 'raw server text')
    )
    await mount()
    const listedBefore = api.browserView.listTabs.mock.calls.length
    typeInto(newInput(), 'file:///etc/hosts')
    await submitNew()
    const error = errorText()
    expect(error).toContain(M.remoteUrlRefused)
    expect(error).not.toContain('raw server text')
    expect(error).not.toContain('remote_url_refused')
    expect(newInput().value).toBe('file:///etc/hosts')
    expect(api.browserView.listTabs.mock.calls.length).toBe(listedBefore + 1)

    click(rowEl('a').querySelector('[data-browser-tab-reload]')!)
    await flush()
    expect(errorText()).toBeNull()
  })

  it("TM-9 普通 Error('denied by rule X') →「That did not work: denied by rule X」", async () => {
    api.browserView.createTab.mockRejectedValueOnce(new Error('denied by rule X'))
    await mount()
    typeInto(newInput(), 'example.com')
    await submitNew()
    expect(errorText()).toBe('That did not work: denied by rule X')
    expect(newInput().value).toBe('example.com')
  })
})

describe('换地址（TM-10 / TM-11）', () => {
  const editBtn = (id: string): HTMLButtonElement | null =>
    rowEl(id).querySelector<HTMLButtonElement>('[data-browser-tab-edit]')
  const addressInput = (): HTMLInputElement | null =>
    $<HTMLInputElement>('[data-browser-tab-address-input]')
  const goBtn = (): HTMLButtonElement => $<HTMLButtonElement>('[data-browser-tab-address-go]')!
  const cancelBtn = (): HTMLButtonElement =>
    [...addressInput()!.form!.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === M.cancel
    )!

  beforeEach(() => {
    api.browserView.listTabs.mockResolvedValue([
      row({ id: 'a', url: 'https://a.test/x', title: 'A' }),
      row({ id: 's', url: 'shuvix://settings', internalPage: 'settings' })
    ])
  })

  it('TM-10 铅笔 → 聚焦的输入框、预填 url；回车 → navigate(id, https://example.org, typed) 并收起', async () => {
    await mount()
    click(editBtn('a')!)
    const input = addressInput()!
    expect(input).not.toBeNull()
    expect(input.value).toBe('https://a.test/x')
    expect(document.activeElement).toBe(input)
    expect(rowEl('a').querySelector('[data-browser-tab-url]')).toBeNull()

    typeInto(input, 'example.org')
    await act(async () => input.form!.requestSubmit())
    await flush()
    expect(api.browserView.navigate.mock.calls).toEqual([['a', 'https://example.org', 'typed']])
    expect(addressInput()).toBeNull()
  })

  it('TM-10 Go 按钮同样导航并收起', async () => {
    await mount()
    click(editBtn('a')!)
    typeInto(addressInput()!, 'example.org')
    click(goBtn())
    await flush()
    expect(api.browserView.navigate.mock.calls).toEqual([['a', 'https://example.org', 'typed']])
    expect(addressInput()).toBeNull()
  })

  it('TM-10 导航失败 → 输入框留着、显示错误', async () => {
    api.browserView.navigate.mockRejectedValueOnce(new Error('nope'))
    await mount()
    click(editBtn('a')!)
    typeInto(addressInput()!, 'example.org')
    click(goBtn())
    await flush()
    expect(addressInput()?.value).toBe('example.org')
    expect(errorText()).toBe('That did not work: nope')
  })

  it('TM-10 空字 → 收起、不导航', async () => {
    await mount()
    click(editBtn('a')!)
    typeInto(addressInput()!, '  ')
    click(goBtn())
    await flush()
    expect(addressInput()).toBeNull()
    expect(api.browserView.navigate).not.toHaveBeenCalled()
  })

  it('TM-11 Escape 与 Cancel 收起、不调；内部页面那一行没有铅笔', async () => {
    await mount()
    expect(editBtn('s')).toBeNull()

    click(editBtn('a')!)
    keyDown(addressInput()!, 'Escape')
    await flush()
    expect(addressInput()).toBeNull()

    click(editBtn('a')!)
    click(cancelBtn())
    await flush()
    expect(addressInput()).toBeNull()
    expect(api.browserView.navigate).not.toHaveBeenCalled()
  })
})

describe('行上的别的动作（TM-12 / TM-13）', () => {
  it("TM-12 View conversation → app.openSessionWithDraft({sessionId:'s1', draft:''}) 一次", async () => {
    api.browserView.listTabs.mockResolvedValue([
      row({ id: 'a', agentSessionId: 's1', agentSessionTitle: 'T' })
    ])
    await mount()
    click(rowEl('a').querySelector('[data-browser-tab-open-session]')!)
    await flush()
    expect(openSessionWithDraft.mock.calls).toEqual([[{ sessionId: 's1', draft: '' }]])
  })

  it('TM-13 关闭 → closeTab(id)，之后重新列', async () => {
    api.browserView.listTabs.mockResolvedValueOnce([row({ id: 'a' }), row({ id: 'b' })])
    await mount()
    api.browserView.listTabs.mockResolvedValueOnce([row({ id: 'b' })])
    click(rowEl('a').querySelector('[data-browser-tab-close]')!)
    await flush()
    expect(api.browserView.closeTab.mock.calls).toEqual([['a']])
    expect(api.browserView.listTabs).toHaveBeenCalledTimes(2)
    expect(api.browserView.listTabs.mock.invocationCallOrder[1]).toBeGreaterThan(
      api.browserView.closeTab.mock.invocationCallOrder[0]
    )
    expect(rowIds()).toEqual(['b'])
  })
})

describe('列不出来与说明（TM-14 / TM-15）', () => {
  it('TM-14 listTabs 拒绝 → denied 一句、没有行、没有空态；之后一次 tabsChanged 列到了 → 画出行', async () => {
    api.browserView.listTabs.mockRejectedValueOnce(new Error('NB prompt'))
    await mount()
    expect($('[data-browser-tabs-denied]')?.textContent).toBe(
      'This device may not see the tabs: NB prompt'
    )
    expect(rowIds()).toEqual([])
    expect($('[data-browser-tabs-empty]')).toBeNull()

    api.browserView.listTabs.mockResolvedValueOnce([row({ id: 'a', title: 'A' })])
    await emit({ type: 'browser.tabsChanged', count: 1 })
    expect($('[data-browser-tabs-denied]')).toBeNull()
    expect(rowIds()).toEqual(['a'])
  })

  it.each([
    [true, M.headlessNote],
    [false, M.remoteNote]
  ])('TM-15 headless=%s → 对应的那句说明', async (headless, note) => {
    await mount({ headless })
    expect($('[data-browser-manager-note]')?.textContent).toBe(note)
  })
})

describe('截图（TS-1 … TS-16）', () => {
  const shotToggle = (id: string): HTMLButtonElement | null =>
    $<HTMLButtonElement>(`[data-browser-manager-tab="${id}"] [data-browser-tab-screenshot-toggle]`)
  const shotPanel = (id: string): HTMLElement | null =>
    $(`[data-browser-manager-tab="${id}"] [data-browser-tab-screenshot]`)
  const panels = (): HTMLElement[] => $$('[data-browser-tab-screenshot]')
  const shotState = (id: string): string | null =>
    shotPanel(id)?.getAttribute('data-browser-tab-screenshot') ?? null
  const retakeBtn = (id: string): HTMLButtonElement =>
    shotPanel(id)!.querySelector<HTMLButtonElement>('[data-browser-tab-screenshot-retake]')!
  /** 面板顶上那一行说明（第一个 span） */
  const noteOf = (id: string): string => shotPanel(id)!.querySelector('span')?.textContent ?? ''
  const imageOf = (id: string): HTMLImageElement | null =>
    shotPanel(id)?.querySelector<HTMLImageElement>('[data-browser-tab-screenshot-image]') ?? null
  const failedText = (id: string): string | null =>
    shotPanel(id)?.querySelector('[data-browser-tab-screenshot-failed]')?.textContent ?? null
  const captureCalls = (): unknown[][] => api.browserView.capture.mock.calls

  async function toggle(id: string): Promise<void> {
    click(shotToggle(id)!)
    await flush()
  }
  async function retake(id: string): Promise<void> {
    click(retakeBtn(id))
    await flush()
  }
  /** 下一次 capture 回一个挂着的 promise */
  function nextCapture(): ReturnType<typeof deferred<string>> {
    const d = deferred<string>()
    api.browserView.capture.mockImplementationOnce(() => d.promise)
    return d
  }
  async function settle(fn: () => void): Promise<void> {
    await act(async () => fn())
    await flush()
  }
  const setDpr = (value: number | undefined): void => {
    Object.defineProperty(window, 'devicePixelRatio', {
      value,
      configurable: true,
      writable: true
    })
  }

  let savedDpr: PropertyDescriptor | undefined
  let dateSpy: { mockRestore(): void } | null = null

  beforeEach(() => {
    savedDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
    setDpr(1)
    api.browserView.listTabs.mockResolvedValue([
      row({ id: 'a', url: 'https://a.test/', title: 'A' }),
      row({ id: 'b', url: 'https://b.test/', title: 'B' })
    ])
  })

  afterEach(() => {
    if (savedDpr) Object.defineProperty(window, 'devicePixelRatio', savedDpr)
    else delete (window as unknown as { devicePixelRatio?: number }).devicePixelRatio
    dateSpy?.mockRestore()
    dateSpy = null
    vi.useRealTimers()
  })

  it('TS-1 挂载 + 两次 tabsChanged：不截、没有面板；每个网页行一个关着的开关', async () => {
    await mount()
    await emit({ type: 'browser.tabsChanged', count: 2 })
    await emit({ type: 'browser.tabsChanged', count: 2 })
    expect(api.browserView.listTabs).toHaveBeenCalledTimes(3)
    expect(api.browserView.capture).not.toHaveBeenCalled()
    expect(panels()).toEqual([])
    for (const id of ['a', 'b']) {
      expect(rowEl(id).querySelectorAll('[data-browser-tab-screenshot-toggle]')).toHaveLength(1)
      const t = shotToggle(id)!
      expect(t.getAttribute('aria-expanded')).toBe('false')
      expect(t.getAttribute('aria-label')).toBe(M.showScreenshot)
      expect(t.getAttribute('title')).toBe(M.showScreenshot)
    }
  })

  it('TS-2 点开（dpr 1）→ capture(a, 720) 一次；loading、说明、重新截图禁用；开关展开', async () => {
    nextCapture()
    await mount()
    await toggle('a')
    expect(captureCalls()).toEqual([['a', 720]])
    expect(shotState('a')).toBe('loading')
    expect(shotPanel('a')!.textContent).toContain(M.screenshotLoading)
    expect(noteOf('a')).toBe(M.screenshotNote)
    expect(retakeBtn('a').disabled).toBe(true)
    expect(retakeBtn('a').textContent).toBe(M.retakeScreenshot)
    const t = shotToggle('a')!
    expect(t.getAttribute('aria-expanded')).toBe('true')
    expect(t.getAttribute('aria-label')).toBe(M.hideScreenshot)
    expect(t.getAttribute('title')).toBe(M.hideScreenshot)
    expect(shotToggle('b')!.getAttribute('aria-expanded')).toBe('false')
  })

  it.each([
    [2, 1280],
    [1.5, 1080],
    [1.25, 900],
    [0.5, 720],
    [undefined, 720]
  ])('TS-3 devicePixelRatio %s → 宽度 %i', async (dpr, width) => {
    setDpr(dpr)
    await mount()
    await toggle('a')
    expect(captureCalls()).toEqual([['a', width]])
  })

  it('TS-4 data URL → shown：src 原样、alt、「Taken at <时间>」、重新截图可点', async () => {
    const d = nextCapture()
    await mount()
    await toggle('a')
    const T = new Date(2026, 9, 31, 14, 5, 6).getTime()
    dateSpy = vi.spyOn(Date, 'now').mockReturnValue(T)
    const src = 'data:image/png;base64,QUJD'
    await settle(() => d.resolve(src))
    expect(shotState('a')).toBe('shown')
    const img = imageOf('a')!
    expect(img.getAttribute('src')).toBe(src)
    expect(img.getAttribute('alt')).toBe(M.screenshotAlt)
    const time = new Date(T).toLocaleTimeString('en')
    expect(noteOf('a')).toBe(M.screenshotTakenAt.replace('{{time}}', time))
    expect(retakeBtn('a').disabled).toBe(false)
    expect(shotPanel('a')!.textContent).not.toContain(M.screenshotLoading)
  })

  it("TS-5 截到 '' → empty 文案、没有 img、说明一行", async () => {
    await mount()
    await toggle('a')
    expect(shotState('a')).toBe('empty')
    expect(shotPanel('a')!.querySelector('[data-browser-tab-screenshot-empty]')?.textContent).toBe(
      M.screenshotEmpty
    )
    expect(imageOf('a')).toBeNull()
    expect(noteOf('a')).toBe(M.screenshotNote)
    expect(retakeBtn('a').disabled).toBe(false)
  })

  it.each([
    ['TS-6 Error 的 message', new Error('NB rule prompt'), 'NB rule prompt'],
    ['TS-8 字符串', 'boom', 'boom']
  ])('%s → failed、原因照写', async (_l, error, reason) => {
    api.browserView.capture.mockRejectedValueOnce(error)
    await mount()
    await toggle('a')
    expect(shotState('a')).toBe('failed')
    expect(failedText('a')).toBe(M.screenshotFailed.replace('{{reason}}', reason))
    expect(imageOf('a')).toBeNull()
    expect(noteOf('a')).toBe(M.screenshotNote)
  })

  it('TS-7 remote_url_refused → 原因是本地化的那句，原文不出现', async () => {
    api.browserView.capture.mockRejectedValueOnce(
      codedError('remote_url_refused', 'raw server text')
    )
    await mount()
    await toggle('a')
    expect(failedText('a')).toBe(M.screenshotFailed.replace('{{reason}}', M.remoteUrlRefused))
    expect(shotPanel('a')!.textContent).not.toContain('raw server text')
  })

  it('TS-9 再点开关收起（不再截）；再点开 → 再截一次、从 loading 开始', async () => {
    api.browserView.capture.mockResolvedValueOnce('data:image/png;base64,AAA')
    await mount()
    await toggle('a')
    expect(shotState('a')).toBe('shown')

    await toggle('a')
    expect(shotPanel('a')).toBeNull()
    const t = shotToggle('a')!
    expect(t.getAttribute('aria-expanded')).toBe('false')
    expect(t.getAttribute('aria-label')).toBe(M.showScreenshot)
    expect(t.getAttribute('title')).toBe(M.showScreenshot)
    expect(captureCalls()).toHaveLength(1)

    nextCapture()
    await toggle('a')
    expect(captureCalls()).toEqual([
      ['a', 720],
      ['a', 720]
    ])
    expect(shotState('a')).toBe('loading')
    expect(imageOf('a')).toBeNull()
  })

  it('TS-10 一次只开一张：开 a 再开 b → 只有 b；a 晚回来的结果不画', async () => {
    const da = nextCapture()
    nextCapture()
    await mount()
    await toggle('a')
    await toggle('b')
    expect(panels()).toHaveLength(1)
    expect(shotPanel('a')).toBeNull()
    expect(shotState('b')).toBe('loading')
    expect(shotToggle('a')!.getAttribute('aria-expanded')).toBe('false')
    expect(shotToggle('b')!.getAttribute('aria-expanded')).toBe('true')
    expect(captureCalls()).toEqual([
      ['a', 720],
      ['b', 720]
    ])

    await settle(() => da.resolve('data:image/png;base64,LATE-A'))
    expect(panels()).toHaveLength(1)
    expect(shotPanel('a')).toBeNull()
    expect(shotState('b')).toBe('loading')
    expect($('[data-browser-tab-screenshot-image]')).toBeNull()
  })

  it('TS-11 重新截图：先 loading + 禁用，再换成新图；参数不变', async () => {
    const d1 = nextCapture()
    await mount()
    await toggle('a')
    await settle(() => d1.resolve('data:image/png;base64,FIRST'))
    expect(imageOf('a')!.getAttribute('src')).toBe('data:image/png;base64,FIRST')

    const d2 = nextCapture()
    await retake('a')
    expect(shotState('a')).toBe('loading')
    expect(retakeBtn('a').disabled).toBe(true)
    expect(imageOf('a')).toBeNull()
    await settle(() => d2.resolve('data:image/png;base64,SECOND'))
    expect(shotState('a')).toBe('shown')
    expect(imageOf('a')!.getAttribute('src')).toBe('data:image/png;base64,SECOND')
    expect(captureCalls()).toEqual([
      ['a', 720],
      ['a', 720]
    ])
  })

  it('TS-11 失败之后重新截图 → shown', async () => {
    api.browserView.capture.mockRejectedValueOnce(new Error('nope'))
    await mount()
    await toggle('a')
    expect(shotState('a')).toBe('failed')
    api.browserView.capture.mockResolvedValueOnce('data:image/png;base64,OK')
    await retake('a')
    expect(shotState('a')).toBe('shown')
    expect(failedText('a')).toBeNull()
    expect(imageOf('a')!.getAttribute('src')).toBe('data:image/png;base64,OK')
  })

  it('TS-12 截图中重新截图是禁用的：点了不截，第一次的结果照常画', async () => {
    const d1 = nextCapture()
    await mount()
    await toggle('a')
    click(retakeBtn('a'))
    await flush()
    expect(captureCalls()).toHaveLength(1)
    await settle(() => d1.resolve('data:image/png;base64,ONE'))
    expect(imageOf('a')!.getAttribute('src')).toBe('data:image/png;base64,ONE')
  })

  it.each([
    ['成功', 'resolve'],
    ['失败', 'reject']
  ])('TS-13 收起之后截图才回来（%s）→ 什么都不画、没有 React 警告', async (_l, how) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const d1 = nextCapture()
      await mount()
      await toggle('a')
      await toggle('a')
      expect(shotPanel('a')).toBeNull()
      await settle(() =>
        how === 'resolve' ? d1.resolve('data:image/png;base64,LATE') : d1.reject(new Error('late'))
      )
      expect(panels()).toEqual([])
      expect($('[data-browser-tab-screenshot-image]')).toBeNull()
      expect($('[data-browser-tab-screenshot-failed]')).toBeNull()
      expect(shotToggle('a')!.getAttribute('aria-expanded')).toBe('false')
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  it('TS-13 收起再点开：旧的结果晚回来，新面板仍在 loading；新的回来才画', async () => {
    const d1 = nextCapture()
    await mount()
    await toggle('a')
    await toggle('a')
    const d2 = nextCapture()
    await toggle('a')
    expect(captureCalls()).toHaveLength(2)
    await settle(() => d1.resolve('data:image/png;base64,OLD'))
    expect(shotState('a')).toBe('loading')
    expect(imageOf('a')).toBeNull()
    await settle(() => d2.resolve('data:image/png;base64,NEW'))
    expect(imageOf('a')!.getAttribute('src')).toBe('data:image/png;base64,NEW')
  })

  it.each([
    ['列表里没了这一页', 'gone'],
    ['列表被拒', 'denied']
  ])('TS-14 %s → 面板收起；回来了也不自己再开、不再截', async (_l, how) => {
    api.browserView.capture.mockResolvedValueOnce('data:image/png;base64,A')
    await mount()
    await toggle('a')
    expect(shotState('a')).toBe('shown')

    if (how === 'gone') {
      api.browserView.listTabs.mockResolvedValueOnce([row({ id: 'b', url: 'https://b.test/' })])
    } else {
      api.browserView.listTabs.mockRejectedValueOnce(new Error('NB prompt'))
    }
    await emit({ type: 'browser.tabsChanged', count: 1 })
    expect(panels()).toEqual([])
    expect($('[data-browser-manager-tab="a"]')).toBeNull()
    if (how === 'denied') expect($('[data-browser-tabs-denied]')).not.toBeNull()

    api.browserView.listTabs.mockResolvedValueOnce([
      row({ id: 'a', url: 'https://a.test/', title: 'A' }),
      row({ id: 'b', url: 'https://b.test/', title: 'B' })
    ])
    await emit({ type: 'browser.tabsChanged', count: 2 })
    expect(rowIds()).toEqual(['a', 'b'])
    expect(shotPanel('a')).toBeNull()
    expect(panels()).toEqual([])
    expect(shotToggle('a')!.getAttribute('aria-expanded')).toBe('false')
    expect(captureCalls()).toHaveLength(1)
  })

  it('TS-15 tabsChanged 里那一行变了（标题 / 地址 / 加载）→ 不再截，同一张图、同一个节点', async () => {
    const SRC = 'data:image/png;base64,KEEP'
    api.browserView.capture.mockResolvedValueOnce(SRC)
    await mount()
    await toggle('a')
    const img = imageOf('a')!
    expect(img.getAttribute('src')).toBe(SRC)

    api.browserView.listTabs.mockResolvedValueOnce([
      row({ id: 'a', url: 'https://a.test/next', title: 'A next', loading: true }),
      row({ id: 'b', url: 'https://b.test/' })
    ])
    await emit({ type: 'browser.tabsChanged', count: 2 })
    expect(rowEl('a').getAttribute('data-tab-loading')).toBe('true')
    api.browserView.listTabs.mockResolvedValueOnce([
      row({ id: 'a', url: 'https://a.test/done', title: 'A done', loading: false }),
      row({ id: 'b', url: 'https://b.test/' })
    ])
    await emit({ type: 'browser.tabsChanged', count: 2 })
    expect(titleOf('a')).toBe('A done')
    expect(captureCalls()).toHaveLength(1)
    expect(imageOf('a')).toBe(img)
    expect(img.getAttribute('src')).toBe(SRC)
    expect(shotState('a')).toBe('shown')
  })

  it('TS-16 内部页面没有开关；开着的网页行变成内部页面 → 面板与开关都没了，变回网页也不自己开', async () => {
    const web = row({ id: 'w', url: 'https://w.test/', title: 'W' })
    api.browserView.listTabs.mockResolvedValue([
      web,
      row({ id: 's', url: 'shuvix://settings', internalPage: 'settings' }),
      row({ id: 'h', url: '', internalPage: 'history' })
    ])
    await mount()
    expect(shotToggle('s')).toBeNull()
    expect(shotToggle('h')).toBeNull()
    expect(rowEl('w').querySelectorAll('[data-browser-tab-screenshot-toggle]')).toHaveLength(1)

    api.browserView.capture.mockResolvedValueOnce('data:image/png;base64,W')
    await toggle('w')
    expect(shotState('w')).toBe('shown')

    api.browserView.listTabs.mockResolvedValueOnce([
      row({ id: 'w', url: 'shuvix://settings', internalPage: 'settings' })
    ])
    await emit({ type: 'browser.tabsChanged', count: 1 })
    expect(rowIds()).toEqual(['w'])
    expect(shotToggle('w')).toBeNull()
    expect(shotPanel('w')).toBeNull()

    api.browserView.listTabs.mockResolvedValueOnce([web])
    await emit({ type: 'browser.tabsChanged', count: 1 })
    expect(shotToggle('w')!.getAttribute('aria-expanded')).toBe('false')
    expect(shotPanel('w')).toBeNull()
    expect(captureCalls()).toHaveLength(1)
  })
})

describe('截图文案（I18N-1）', () => {
  const KEYS = [
    'showScreenshot',
    'hideScreenshot',
    'retakeScreenshot',
    'screenshotLoading',
    'screenshotNote',
    'screenshotTakenAt',
    'screenshotEmpty',
    'screenshotFailed',
    'screenshotAlt'
  ] as const

  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja]
  ])('I18N-1 %s：九个键非空；TakenAt 有 {{time}}、Failed 有 {{reason}}', (_lang, locale) => {
    const manager = locale.browser.manager as Record<string, unknown>
    for (const key of KEYS) {
      expect(typeof manager[key], key).toBe('string')
      expect((manager[key] as string).trim().length, key).toBeGreaterThan(0)
    }
    expect(manager.screenshotTakenAt).toContain('{{time}}')
    expect(manager.screenshotFailed).toContain('{{reason}}')
  })
})
