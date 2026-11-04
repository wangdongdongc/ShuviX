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
 * agent 用着的页，刷新 / 关闭 / 换地址先问一声（ConfirmDialog）。「问」= 出现 [data-browser-tab-agent-confirm=<动作>] 且 reload /
 * closeTab 没调；「直接做」= 没有框，api 一次，之后重新列一次：
 *   TC-1  agentSessionId + 标题 + cdpAttached / 只有 agentSessionId / 只有 cdpAttached / cdpAttached + cdpIntercepting ×
 *         刷新、关闭 → 问，动作对得上，不额外重新列
 *   TC-2  全空 / 只有 openerSessionId / 只有 agentDevtoolsCalls / 只有 active × 刷新、关闭 → 直接做
 *   TC-3  内部页面（settings / history）无 agent → 直接做
 *   TC-5  无 agent → 有 agent → 又没了，每阶段点一次关闭：判断跟着最新列表走
 *   TC-6  a 在用、b 空闲：b 直接做，a 问
 *   TC-7a 只有 cdpAttached 的行 [data-browser-tab-agent-unknown]（usingUnknown）；带会话的、空闲的没有
 *   TC-7  关闭框确认 → closeTab(a)，框消失，closeTab 之后重新列，行没了，reload 没调
 *   TC-8  刷新框确认 → reload(a)，closeTab 没调，行还在，重新列一次
 *   TC-9  动作被拒（Error('x') / remote_url_refused）× 刷新、关闭 → 框消失，错误行写原因（后者本地化），重新列
 *   TC-11 确认刷新后仍在用、或刚取消 → 再点再问；同一会话的两个 tab 各问各的
 *   TC-12 截图面板开着：确认刷新 → 面板、img 节点、capture 次数不变；确认关闭 → 行和面板都没了
 *   TC-13 Cancel / Escape / 点遮罩 × 刷新、关闭 → 退场（120ms）后框消失，api 没调，不重新列
 *   TC-14 点面板内部（标题）不关闭
 *   TC-15 错误行、截图面板、地址编辑框开着，打开确认框再取消 → 都留着，输入框的字不变
 *   TC-16 取消关闭后点同一行刷新 → 新框是刷新的文案，没有 dialog-closing
 *   TC-17 框开着再点一次同一行按钮 → 仍只有一个框，api 没调
 *   TC-18 在用且加载中，点停止 → stop 直接调用，没框
 *   TC-19 在用：截图开关、View conversation → 都直接发生，没框（换地址要问，见 TN-*）
 *   TC-20 框开着 / 刚点完取消时卸载，等 150ms 再挂载 → 没调 api，没有 console.error，新挂载没框
 *   TC-21 框开着，a 从列表里没了 → 框立刻消失（不等 120ms），api 没调
 *   TC-22 接上，a 回来了 → 不自己再弹，再点才问
 *   TC-23 框开着，listTabs 被拒 → 框消失，[data-browser-tabs-denied]，api 没调
 *   TC-24 接上，下一次列到 a → 行回来，不自己再弹
 *   TC-25 手动 [data-browser-tabs-reload-list]：a 还在 → 框留着；a 没了 → 收起
 *   TC-26 a 的标题 / 地址 / loading 变了（仍在用），别的行增减 → 框留着；确认后照样对 a 做
 *   TC-27 agentSessionTitle 改名、agentSessionId 换了会话 → 第一行字跟着变
 *   TC-28 先发的 listTabs（不含 a）晚回来（resolve / reject）→ 被忽略，框留着，没有 denied
 *   TC-29 a 还在但 agent 全没了（另一例：成了没有 agent 的内部页面）→ 框立刻消失，api 没调，再点直接做
 *   TC-30 崩了 + 三种在用状态，点刷新 → 直接 reload，不问
 *   TC-31 崩了 + 三种在用状态，点关闭 → 问
 *   TC-32 崩了 + 无 agent → 都直接做
 *   TC-33 恢复（crashed:false，仍在用）后点刷新 → 问
 *   TC-34 刷新框开着，a 崩了（仍在用）→ 框收起，api 没调；关闭框开着时同样变化 → 框留着
 *   TC-35 'Fix' / s1 →「“Fix” is using this page」，行上 In use by 同名
 *   TC-36 '  Fix  ' / s1 → “Fix”
 *   TC-37 ''、'   '、undefined / s1 → “s1”
 *   TC-38 无标题无 id、cdpAttached → usingUnknown，不出现 {{session}} 或 undefined
 *   TC-39 '<b>&"x' 原样显示，不成标签
 *   TC-40 关闭框：confirmCloseTitle、confirmCloseBody、确认钮 browser.closeTab（bg-error）、取消钮 browser.manager.cancel，
 *         没有 [data-browser-tab-confirm-target]
 *   TC-41 刷新框：confirmReloadTitle、confirmReloadBody、确认钮 browser.refresh（bg-accent，没有 bg-error），不混入关闭的文案，
 *         没有 [data-browser-tab-confirm-target]
 *   I18N-2 zh / en / ja 四个确认文案非空、不带 {{；Close 与 Reload 的 Title、Body 互不相同
 *   I18N-3 zh / en / ja 的 infobar.using 有 {{session}}，usingUnknown 没有占位符；closeTab、refresh、manager.cancel 非空
 *
 * 换地址（navigate）：「框」= [data-browser-tab-agent-confirm=navigate]，引擎 bing，a = agentSessionId + cdpAttached：
 *   TN-1  点铅笔：只展开输入框、预填 url，没有框，navigate 没调
 *   TN-2  输入 example.org，回车 / Go：出现框，navigate 没调，输入框和字留着
 *   TN-3  只有 agentSessionId / 只有 cdpAttached / cdpAttached + cdpIntercepting，回车：都问
 *   TN-4  打开时空闲，打字期间变成在用，回车：问
 *   TN-5  打开时在用，打字期间 agent 没了，回车：直接 navigate，没有框，成功后收起
 *   TN-6  在用，不改字点 Go：也问，目标是 url 解析后的地址
 *   TN-7  在用，''、'   '：收起，没有框，navigate 没调
 *   TN-8  框的内容：confirmNavigateTitle、confirmNavigateBody、确认钮 browser.manager.go（bg-accent，没有 bg-error）、
 *         取消钮 browser.manager.cancel、第一行 browser.infobar.using
 *   TN-9  example.org、'  example.org  '、two words、shuvix://settings → 目标 https://example.org、同左、bing 搜索地址、原样
 *   TN-10 目标 https://x.test/?a=<b>&c=1 原样显示，不成标签
 *   TN-11 很长的目标：textContent 和 title 属性都是完整地址
 *   TN-12 只有 cdpAttached 的行写 usingUnknown；标题为空的行回退到 id
 *   TN-13 确认成功：navigate(a, https://example.org, typed)，框消失，输入框收起、地址行回来，navigate 之后重新列
 *   TN-14 确认后被拒（Error('nope') / remote_url_refused）：框消失，输入框和字留着，错误行写原因（后者本地化），重新列，
 *         焦点回输入框
 *   TN-15 接 TN-14 不改字再回车：再问一次，再确认才再调用 navigate
 *   TN-16 框开着时输入框被收起（清空字提交 / 表单 Cancel）：框也立刻收起（不等 120ms），navigate 没调
 *   TN-16b 关闭 / 刷新框开着时输入框被收起（清空字提交）：输入框收起，框留着 —— 它问的不是这次换地址
 *   TN-17 框的 Cancel / 点遮罩，退场后：框消失，navigate 没调，不重新列，输入框同一个节点、字不变，焦点回输入框
 *   TN-18 焦点在确认钮上按 Esc（冒泡到 document），退场后：框消失，输入框和字留着，焦点回输入框
 *   TN-19 接 TN-18，在输入框上再按 Esc：这次输入框收起，navigate 没调
 *   TN-20 框开着、焦点挪回输入框，在输入框上按 Esc：只取消框，输入框留着
 *   TN-21 输入框开着，关闭 / 刷新框开着，在输入框上按 Esc：只关框，输入框留着
 *   TN-22 回车打开框后焦点在框的确认钮上；关闭、刷新框的确认钮不抢焦点
 *   TN-23 已有错误行，打开框后取消：错误行留着；确认时才清掉
 *   TN-24 取消后不改字回车：再问，新框没有 dialog-closing
 *   TN-28 框开着，a 从列表没了：框立刻消失，navigate 没调
 *   TN-29 接上，a 回来：不自己再弹，navigate 没调（输入框是否回来不断言）
 *   TN-30 listTabs 被拒，之后恢复：框消失、denied；恢复后不自己再弹
 *   TN-31 框开着，agent 全没了：框立刻收起，navigate 没调，输入框和字留着；再回车直接 navigate，没有框
 *   TN-32 框开着，a 变成没有 agent 的内部页面：框收起，navigate 没调
 *   TN-33 框开着，a 崩了（仍在用）：框收起，输入框和字留着；再回车直接 navigate
 *   TN-34 框开着，a 的 url、标题、loading 变了（仍在用）：框留着，目标和输入框的字不变，确认后去原目标
 *   TN-35 先发的 listTabs（不含 a）晚回来（resolve / reject）：被忽略，框留着
 *   TN-36 崩了 + 三种在用状态，回车 / Go：直接 navigate，没有框，成功后收起
 *   TN-37 空闲的崩溃页回车：直接 navigate
 *   TN-38 崩了 + 在用，输入框开着，点关闭：仍问；取消后输入框留着
 *   TN-39 在用，输入框开着，刷新框 / 关闭框确认：刷新后输入框和字留着，关闭后行没了；框上都没有目标元素
 *   TN-40 没有 agent 的行回车 / Go：直接 navigate，全程没有框；成功后收起；失败后输入框留着并显示错误
 *   TN-41 没有 agent 的行：空字、Esc、表单 Cancel 都收起，不导航
 *   TN-42 a 的 navigate 挂着时打开 b 的铅笔，a 成功：b 的输入框不被收掉
 *   I18N-4 zh / en / ja 的 confirmNavigateTitle、confirmNavigateBody、manager.go 非空；前两个不带 {{
 *   I18N-5 zh / en / ja 里 Close、Reload、Navigate 的 Title 两两不同，Body 也两两不同
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

describe('agent 用着的页：刷新 / 关闭 / 换地址先问一声', () => {
  type Action = 'reload' | 'close'
  const ACTIONS: Action[] = ['reload', 'close']
  const USING = en.browser.infobar.using
  const USING_UNKNOWN = en.browser.infobar.usingUnknown

  const IN_USE: Array<[string, Partial<Row>]> = [
    [
      'agentSessionId + 标题 + cdpAttached',
      { agentSessionId: 's1', agentSessionTitle: 'T', cdpAttached: true }
    ],
    ['只有 agentSessionId', { agentSessionId: 's1' }],
    ['只有 cdpAttached', { cdpAttached: true }],
    ['cdpAttached + cdpIntercepting', { cdpAttached: true, cdpIntercepting: true }]
  ]
  const IN_USE_X_ACTIONS = IN_USE.flatMap(([label, over]) =>
    ACTIONS.map((action) => [label, action, over] as const)
  )

  const apiOf = (action: Action): Mock =>
    action === 'close' ? api.browserView.closeTab : api.browserView.reload
  const setList = (...rows: Row[]): void => void api.browserView.listTabs.mockResolvedValue(rows)
  const listCount = (): number => api.browserView.listTabs.mock.calls.length

  const box = (): HTMLElement | null => $('[data-browser-tab-agent-confirm]')
  const panel = (): HTMLElement | null => $('.dialog-panel')
  const overlay = (): HTMLElement | null => $('.dialog-overlay')
  const dialogBtn = (text: string): HTMLButtonElement => {
    const btn = [...panel()!.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === text
    )
    if (!btn) throw new Error(`no dialog button ${text}`)
    return btn
  }
  const cancelBtn = (): HTMLButtonElement => dialogBtn(M.cancel)
  const confirmBtn = (action: Action): HTMLButtonElement =>
    dialogBtn(action === 'close' ? en.browser.closeTab : en.browser.refresh)
  const firstLine = (): string => box()!.querySelectorAll('p')[0].textContent ?? ''
  const secondLine = (): string => box()!.querySelectorAll('p')[1].textContent ?? ''
  const shotPanel = (id: string): HTMLElement | null =>
    $(`[data-browser-manager-tab="${id}"] [data-browser-tab-screenshot]`)

  /** 点那一行的刷新 / 关闭 */
  async function press(id: string, action: Action): Promise<void> {
    click(rowEl(id).querySelector(`[data-browser-tab-${action}]`)!)
    await flush()
  }
  async function confirm(action: Action): Promise<void> {
    click(confirmBtn(action))
    await flush()
  }
  /** 取消走 useDialogClose，120ms 之后才卸载；flush 等不到，这里真等 */
  async function waitMs(ms: number): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    })
    await flush()
  }
  const waitExit = (): Promise<void> => waitMs(130)

  /** 「问」：框是这个动作的，两个动作都没调 */
  function expectAsked(action: Action): void {
    expect(box()?.getAttribute('data-browser-tab-agent-confirm')).toBe(action)
    expect(api.browserView.reload).not.toHaveBeenCalled()
    expect(api.browserView.closeTab).not.toHaveBeenCalled()
  }
  /** 没有框，两个动作都没调 */
  function expectNothing(): void {
    expect(box()).toBeNull()
    expect(panel()).toBeNull()
    expect(api.browserView.reload).not.toHaveBeenCalled()
    expect(api.browserView.closeTab).not.toHaveBeenCalled()
  }
  /** 「直接做」：点下去没有框，api 调用一次，之后重新列一次 */
  async function expectDirect(id: string, action: Action): Promise<void> {
    const before = listCount()
    await press(id, action)
    expect(box()).toBeNull()
    expect(panel()).toBeNull()
    expect(apiOf(action).mock.calls).toEqual([[id]])
    expect(listCount()).toBe(before + 1)
    expect(apiOf(action).mock.invocationCallOrder[0]).toBeLessThan(
      api.browserView.listTabs.mock.invocationCallOrder[before]
    )
  }

  describe('A 哪些状态算在用', () => {
    it.each(IN_USE_X_ACTIONS)('TC-1 %s，点 %s → 问，不额外重新列', async (_l, action, over) => {
      setList(row({ id: 'a', ...over }))
      await mount()
      const before = listCount()
      await press('a', action)
      expectAsked(action)
      expect(listCount()).toBe(before)
    })

    it.each(
      (
        [
          ['全空', {}],
          ['只有 openerSessionId', { openerSessionId: 's1' }],
          ['只有 agentDevtoolsCalls:3', { agentDevtoolsCalls: 3 }],
          ['只有 active:true', { active: true }]
        ] as Array<[string, Partial<Row>]>
      ).flatMap(([label, over]) => ACTIONS.map((action) => [label, action, over] as const))
    )('TC-2 %s，点 %s → 直接做', async (_l, action, over) => {
      setList(row({ id: 'a', ...over }))
      await mount()
      await expectDirect('a', action)
    })

    it.each(
      (['settings', 'history'] as const).flatMap((page) =>
        ACTIONS.map((action) => [page, action] as const)
      )
    )('TC-3 内部页面 %s 无 agent，点 %s → 直接做', async (page, action) => {
      setList(row({ id: 'p', url: `shuvix://${page}`, internalPage: page }))
      await mount()
      await expectDirect('p', action)
    })

    it('TC-5 判断跟着最新列表走：无 agent → 有 agent → 又没了', async () => {
      const idle = row({ id: 'a' })
      setList(idle)
      await mount()
      await press('a', 'close')
      expect(box()).toBeNull()
      expect(api.browserView.closeTab).toHaveBeenCalledTimes(1)

      setList(row({ id: 'a', agentSessionId: 's1' }))
      await emit({ type: 'browser.tabsChanged', count: 1 })
      await press('a', 'close')
      expect(box()?.getAttribute('data-browser-tab-agent-confirm')).toBe('close')
      expect(api.browserView.closeTab).toHaveBeenCalledTimes(1)

      setList(idle)
      await emit({ type: 'browser.tabsChanged', count: 1 })
      expect(box()).toBeNull()
      await press('a', 'close')
      expect(box()).toBeNull()
      expect(api.browserView.closeTab).toHaveBeenCalledTimes(2)
    })

    it('TC-6 a 在用、b 空闲：b 直接做，a 问', async () => {
      setList(row({ id: 'a', agentSessionId: 's1' }), row({ id: 'b' }))
      await mount()
      await expectDirect('b', 'close')
      await press('a', 'close')
      expect(box()?.getAttribute('data-browser-tab-agent-confirm')).toBe('close')
      expect(api.browserView.closeTab.mock.calls).toEqual([['b']])
    })

    it('TC-7a 只有 cdpAttached 的行写「An agent is using this page」；带会话的、空闲的都没有', async () => {
      setList(
        row({ id: 'u', cdpAttached: true }),
        row({ id: 's', cdpAttached: true, agentSessionId: 's1' }),
        row({ id: 'i' })
      )
      await mount()
      expect(rowEl('u').querySelector('[data-browser-tab-agent-unknown]')?.textContent).toBe(
        USING_UNKNOWN
      )
      expect(rowEl('s').querySelector('[data-browser-tab-agent-unknown]')).toBeNull()
      expect(rowEl('i').querySelector('[data-browser-tab-agent-unknown]')).toBeNull()
    })
  })

  describe('B 确认', () => {
    it('TC-7 关闭框点确认 → closeTab(a)，框消失，之后重新列，行没了，reload 没调', async () => {
      setList(row({ id: 'a', agentSessionId: 's1' }), row({ id: 'b' }))
      await mount()
      await press('a', 'close')
      const before = listCount()
      api.browserView.listTabs.mockResolvedValueOnce([row({ id: 'b' })])
      await confirm('close')
      expect(api.browserView.closeTab.mock.calls).toEqual([['a']])
      expect(box()).toBeNull()
      expect(panel()).toBeNull()
      expect(listCount()).toBe(before + 1)
      expect(api.browserView.listTabs.mock.invocationCallOrder[before]).toBeGreaterThan(
        api.browserView.closeTab.mock.invocationCallOrder[0]
      )
      expect(rowIds()).toEqual(['b'])
      expect(api.browserView.reload).not.toHaveBeenCalled()
    })

    it('TC-8 刷新框点确认 → reload(a)，closeTab 没调，行还在，重新列一次', async () => {
      setList(row({ id: 'a', agentSessionId: 's1' }))
      await mount()
      await press('a', 'reload')
      const before = listCount()
      await confirm('reload')
      expect(api.browserView.reload.mock.calls).toEqual([['a']])
      expect(api.browserView.closeTab).not.toHaveBeenCalled()
      expect(box()).toBeNull()
      expect(rowIds()).toEqual(['a'])
      expect(listCount()).toBe(before + 1)
    })

    it.each(
      (
        [
          ['Error(x)', () => new Error('x'), 'x'],
          [
            'remote_url_refused',
            () => codedError('remote_url_refused', 'raw server text'),
            M.remoteUrlRefused
          ]
        ] as Array<[string, () => Error, string]>
      ).flatMap(([label, make, reason]) =>
        ACTIONS.map((action) => [label, action, make, reason] as const)
      )
    )('TC-9 动作被拒（%s，%s）→ 框消失，错误行写原因，重新列', async (_l, action, make, reason) => {
      setList(row({ id: 'a', agentSessionId: 's1' }))
      apiOf(action).mockRejectedValueOnce(make())
      await mount()
      await press('a', action)
      const before = listCount()
      await confirm(action)
      expect(box()).toBeNull()
      expect(panel()).toBeNull()
      expect(errorText()).toBe(M.actionFailed.replace('{{reason}}', reason))
      expect(errorText()).not.toContain('raw server text')
      expect(listCount()).toBe(before + 1)
    })

    it('TC-11 确认刷新后 a 仍在用 → 再点再问，不记忆', async () => {
      setList(row({ id: 'a', agentSessionId: 's1' }))
      await mount()
      await press('a', 'reload')
      await confirm('reload')
      expect(api.browserView.reload).toHaveBeenCalledTimes(1)
      await press('a', 'reload')
      expect(box()?.getAttribute('data-browser-tab-agent-confirm')).toBe('reload')
      expect(api.browserView.reload).toHaveBeenCalledTimes(1)
    })

    it('TC-11 刚取消 → 再点再问', async () => {
      setList(row({ id: 'a', agentSessionId: 's1' }))
      await mount()
      await press('a', 'reload')
      click(cancelBtn())
      await waitExit()
      expect(box()).toBeNull()
      await press('a', 'reload')
      expectAsked('reload')
    })

    it('TC-11 同一会话的两个 tab 各问各的', async () => {
      setList(row({ id: 'a', agentSessionId: 's1' }), row({ id: 'b', agentSessionId: 's1' }))
      await mount()
      await press('a', 'reload')
      await confirm('reload')
      expect(api.browserView.reload.mock.calls).toEqual([['a']])
      await press('b', 'reload')
      expect(box()?.getAttribute('data-browser-tab-agent-confirm')).toBe('reload')
      expect(api.browserView.reload.mock.calls).toEqual([['a']])
      await confirm('reload')
      expect(api.browserView.reload.mock.calls).toEqual([['a'], ['b']])
    })

    it('TC-12 截图面板开着：确认刷新 → 面板、img 节点、capture 次数都不变；确认关闭 → 行和面板都没了', async () => {
      setList(row({ id: 'a', agentSessionId: 's1' }), row({ id: 'b' }))
      api.browserView.capture.mockResolvedValueOnce('data:image/png;base64,KEEP')
      await mount()
      click(rowEl('a').querySelector('[data-browser-tab-screenshot-toggle]')!)
      await flush()
      const shot = shotPanel('a')!
      const img = shot.querySelector('img')!
      expect(img.getAttribute('src')).toBe('data:image/png;base64,KEEP')

      await press('a', 'reload')
      await confirm('reload')
      expect(api.browserView.reload.mock.calls).toEqual([['a']])
      expect(shotPanel('a')).toBe(shot)
      expect(shot.querySelector('img')).toBe(img)
      expect(api.browserView.capture).toHaveBeenCalledTimes(1)

      await press('a', 'close')
      api.browserView.listTabs.mockResolvedValueOnce([row({ id: 'b' })])
      await confirm('close')
      expect(rowIds()).toEqual(['b'])
      expect($('[data-browser-tab-screenshot]')).toBeNull()
      expect(api.browserView.capture).toHaveBeenCalledTimes(1)
    })
  })

  describe('C 取消，其余动作不受影响', () => {
    it.each(
      (
        [
          ['Cancel', () => click(cancelBtn())],
          ['Escape', () => keyDown(document.body, 'Escape')],
          ['点遮罩', () => click(overlay()!)]
        ] as Array<[string, () => void]>
      ).flatMap(([label, cancel]) => ACTIONS.map((action) => [label, action, cancel] as const))
    )('TC-13 %s（%s 框）→ 退场后框消失，没调 api，不重新列', async (_l, action, cancel) => {
      setList(row({ id: 'a', agentSessionId: 's1' }))
      await mount()
      await press('a', action)
      const before = listCount()
      cancel()
      expect(overlay()?.classList.contains('dialog-closing')).toBe(true)
      await waitExit()
      expectNothing()
      expect(listCount()).toBe(before)
    })

    it('TC-14 点面板内部（标题）不关闭', async () => {
      setList(row({ id: 'a', agentSessionId: 's1' }))
      await mount()
      await press('a', 'close')
      click(panel()!.querySelector('h3')!)
      await waitExit()
      expectAsked('close')
      expect(overlay()?.classList.contains('dialog-closing')).toBe(false)
    })

    it.each(ACTIONS)(
      'TC-15 错误行、截图面板、地址编辑框都开着：打开 %s 框再取消 → 都留着，输入框的字不变',
      async (action) => {
        setList(row({ id: 'a', agentSessionId: 's1' }), row({ id: 'b' }))
        api.browserView.reload.mockRejectedValueOnce(new Error('boom'))
        api.browserView.capture.mockResolvedValueOnce('data:image/png;base64,KEEP')
        await mount()
        await press('b', 'reload')
        const error = errorText()
        expect(error).toBe(M.actionFailed.replace('{{reason}}', 'boom'))
        api.browserView.reload.mockClear()

        click(rowEl('a').querySelector('[data-browser-tab-screenshot-toggle]')!)
        await flush()
        const shot = shotPanel('a')!
        const img = shot.querySelector('img')!
        click(rowEl('a').querySelector('[data-browser-tab-edit]')!)
        const input = $<HTMLInputElement>('[data-browser-tab-address-input]')!
        typeInto(input, 'draft.example')

        await press('a', action)
        expectAsked(action)
        click(cancelBtn())
        await waitExit()
        expectNothing()
        expect(errorText()).toBe(error)
        expect(shotPanel('a')).toBe(shot)
        expect(shot.querySelector('img')).toBe(img)
        expect($<HTMLInputElement>('[data-browser-tab-address-input]')).toBe(input)
        expect(input.value).toBe('draft.example')
        expect(api.browserView.navigate).not.toHaveBeenCalled()
      }
    )

    it('TC-16 取消关闭后点同一行刷新 → 新框是刷新的文案，没有 dialog-closing', async () => {
      setList(row({ id: 'a', agentSessionId: 's1' }))
      await mount()
      await press('a', 'close')
      click(cancelBtn())
      await waitExit()
      await press('a', 'reload')
      expectAsked('reload')
      expect(panel()!.querySelector('h3')?.textContent).toBe(M.confirmReloadTitle)
      expect(secondLine()).toBe(M.confirmReloadBody)
      expect(overlay()!.classList.contains('dialog-closing')).toBe(false)
    })

    it.each(ACTIONS)(
      'TC-17 %s 框开着再点一次同一行按钮 → 仍只有一个框，api 没调',
      async (action) => {
        setList(row({ id: 'a', agentSessionId: 's1' }))
        await mount()
        await press('a', action)
        await press('a', action)
        expectAsked(action)
        expect($$('.dialog-panel')).toHaveLength(1)
        expect($$('[data-browser-tab-agent-confirm]')).toHaveLength(1)
      }
    )

    it('TC-18 在用且加载中，点停止 → stop 直接调用，没有框', async () => {
      setList(row({ id: 'a', agentSessionId: 's1', cdpAttached: true, loading: true }))
      await mount()
      click(rowEl('a').querySelector('[data-browser-tab-stop]')!)
      await flush()
      expect(api.browserView.stop.mock.calls).toEqual([['a']])
      expectNothing()
    })

    it('TC-19 在用：截图开关、View conversation → 都直接发生，没有框', async () => {
      setList(
        row({ id: 'a', agentSessionId: 's1', agentSessionTitle: 'T', cdpAttached: true }),
        row({ id: 'b' })
      )
      await mount()
      click(rowEl('a').querySelector('[data-browser-tab-screenshot-toggle]')!)
      await flush()
      expect(api.browserView.capture).toHaveBeenCalledTimes(1)
      expect(box()).toBeNull()

      click(rowEl('a').querySelector('[data-browser-tab-open-session]')!)
      await flush()
      expect(openSessionWithDraft.mock.calls).toEqual([[{ sessionId: 's1', draft: '' }]])
      expectNothing()
    })

    it.each([
      ['框开着', false],
      ['刚点完取消（120ms 内）', true]
    ])(
      'TC-20 %s 卸载，等 150ms，再挂载 → 没调 api，没有 console.error，新挂载没框',
      async (_l, cancelFirst) => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        try {
          setList(row({ id: 'a', agentSessionId: 's1' }))
          await mount()
          await press('a', 'close')
          if (cancelFirst) click(cancelBtn())
          m!.unmount()
          m = null
          await waitMs(150)
          expect(api.browserView.reload).not.toHaveBeenCalled()
          expect(api.browserView.closeTab).not.toHaveBeenCalled()
          await mount()
          expectNothing()
          expect(rowIds()).toEqual(['a'])
          expect(errors).not.toHaveBeenCalled()
        } finally {
          errors.mockRestore()
        }
      }
    )
  })

  describe('D 框开着时列表变了', () => {
    const used = (over: Partial<Row> = {}): Row =>
      row({ id: 'a', agentSessionId: 's1', cdpAttached: true, ...over })

    it('TC-21 + TC-22 a 没了 → 框立刻消失、api 没调；a 回来了不自己再弹，再点才问', async () => {
      setList(used(), row({ id: 'b' }))
      await mount()
      await press('a', 'close')
      setList(row({ id: 'b' }))
      await emit({ type: 'browser.tabsChanged', count: 1 })
      expectNothing()

      setList(used(), row({ id: 'b' }))
      await emit({ type: 'browser.tabsChanged', count: 2 })
      expect(rowIds()).toEqual(['a', 'b'])
      expectNothing()

      await press('a', 'close')
      expectAsked('close')
    })

    it('TC-23 + TC-24 listTabs 被拒 → 框消失、denied、api 没调；下一次列到 a → 行回来，不自己再弹', async () => {
      setList(used())
      await mount()
      await press('a', 'reload')
      api.browserView.listTabs.mockRejectedValueOnce(new Error('NB prompt'))
      await emit({ type: 'browser.tabsChanged', count: 1 })
      expectNothing()
      expect($('[data-browser-tabs-denied]')).not.toBeNull()

      await emit({ type: 'browser.tabsChanged', count: 1 })
      expect($('[data-browser-tabs-denied]')).toBeNull()
      expect(rowIds()).toEqual(['a'])
      expectNothing()
    })

    it('TC-25 手动刷新列表：a 还在 → 框留着；a 没了 → 收起', async () => {
      setList(used(), row({ id: 'b' }))
      await mount()
      await press('a', 'close')
      click($('[data-browser-tabs-reload-list]')!)
      await flush()
      expectAsked('close')

      setList(row({ id: 'b' }))
      click($('[data-browser-tabs-reload-list]')!)
      await flush()
      expectNothing()
    })

    it.each(ACTIONS)(
      'TC-26 %s 框开着：a 的标题 / 地址 / loading 变了（仍在用），别的行增减 → 框留着；确认后照样对 a 做',
      async (action) => {
        setList(used({ title: 'A' }), row({ id: 'b' }))
        await mount()
        await press('a', action)
        setList(
          used({ title: 'A next', url: 'https://a.test/next', loading: true }),
          row({ id: 'c' })
        )
        await emit({ type: 'browser.tabsChanged', count: 2 })
        expect(rowIds()).toEqual(['a', 'c'])
        expect(titleOf('a')).toBe('A next')
        expectAsked(action)
        await confirm(action)
        expect(apiOf(action).mock.calls).toEqual([['a']])
        expect(box()).toBeNull()
      }
    )

    it.each([
      ['改名', { agentSessionTitle: 'New' }, 'New'],
      ['换了会话', { agentSessionId: 's2', agentSessionTitle: 'Other' }, 'Other'],
      ['换了会话、没有标题', { agentSessionId: 's2', agentSessionTitle: undefined }, 's2']
    ] as Array<[string, Partial<Row>, string]>)(
      'TC-27 %s → 第一行字跟着变',
      async (_l, over, name) => {
        setList(used({ agentSessionTitle: 'Old' }))
        await mount()
        await press('a', 'close')
        expect(firstLine()).toBe(USING.replace('{{session}}', 'Old'))
        setList(used({ agentSessionTitle: 'Old', ...over }))
        await emit({ type: 'browser.tabsChanged', count: 1 })
        expect(firstLine()).toBe(USING.replace('{{session}}', name))
        expectAsked('close')
      }
    )

    it.each(['resolve', 'reject'])(
      'TC-28 先发的 listTabs（不含 a）晚回来（%s）→ 被忽略：框留着，没有 denied',
      async (how) => {
        setList(used())
        await mount()
        const stale = deferred<Row[]>()
        api.browserView.listTabs.mockImplementationOnce(() => stale.promise)
        await emit({ type: 'browser.tabsChanged', count: 1 })
        await emit({ type: 'browser.tabsChanged', count: 1 })
        await press('a', 'close')
        expectAsked('close')

        await act(async () => {
          if (how === 'resolve') stale.resolve([row({ id: 'gone' })])
          else stale.reject(new Error('late'))
        })
        await flush()
        expectAsked('close')
        expect(rowIds()).toEqual(['a'])
        expect($('[data-browser-tabs-denied]')).toBeNull()
      }
    )

    it.each(
      (
        [
          ['agent 全没了', {}],
          ['变成内部页面', { url: 'shuvix://settings', internalPage: 'settings' }]
        ] as Array<[string, Partial<Row>]>
      ).flatMap(([label, over]) => ACTIONS.map((action) => [label, action, over] as const))
    )('TC-29 %s（%s 框开着）→ 框立刻消失，api 没调，再点直接做', async (_l, action, over) => {
      setList(used())
      await mount()
      await press('a', action)
      setList(row({ id: 'a', ...over }))
      await emit({ type: 'browser.tabsChanged', count: 1 })
      expectNothing()
      await expectDirect('a', action)
    })

    it('TC-34 刷新框开着，a 崩了（仍在用）→ 框收起，api 没调', async () => {
      setList(used())
      await mount()
      await press('a', 'reload')
      setList(used({ crashed: true }))
      await emit({ type: 'browser.tabsChanged', count: 1 })
      expectNothing()
    })

    it('TC-34 关闭框开着，a 崩了（仍在用）→ 框留着', async () => {
      setList(used())
      await mount()
      await press('a', 'close')
      setList(used({ crashed: true }))
      await emit({ type: 'browser.tabsChanged', count: 1 })
      expectAsked('close')
    })
  })

  describe('E 崩溃页', () => {
    const USE_STATES: Array<[string, Partial<Row>]> = [
      ['agentSessionId + cdpAttached', { agentSessionId: 's1', cdpAttached: true }],
      ['只有 agentSessionId', { agentSessionId: 's1' }],
      ['只有 cdpAttached', { cdpAttached: true }]
    ]

    it.each(USE_STATES)('TC-30 崩了 + %s，点刷新 → 直接 reload，不问', async (_l, over) => {
      setList(row({ id: 'a', crashed: true, ...over }))
      await mount()
      await expectDirect('a', 'reload')
    })

    it.each(USE_STATES)('TC-31 崩了 + %s，点关闭 → 问', async (_l, over) => {
      setList(row({ id: 'a', crashed: true, ...over }))
      await mount()
      await press('a', 'close')
      expectAsked('close')
    })

    it.each(ACTIONS)('TC-32 崩了 + 无 agent，点 %s → 直接做', async (action) => {
      setList(row({ id: 'a', crashed: true }))
      await mount()
      await expectDirect('a', action)
    })

    it('TC-33 恢复（crashed:false，仍在用）后点刷新 → 问', async () => {
      const used = { agentSessionId: 's1', cdpAttached: true }
      setList(row({ id: 'a', crashed: true, ...used }))
      await mount()
      setList(row({ id: 'a', crashed: false, ...used }))
      await emit({ type: 'browser.tabsChanged', count: 1 })
      await press('a', 'reload')
      expectAsked('reload')
    })
  })

  describe('F 会话名', () => {
    /** 框的第一行和行上的 In use by 写同一个名字 */
    async function expectName(over: Partial<Row>, name: string): Promise<void> {
      setList(row({ id: 'a', ...over }))
      await mount()
      await press('a', 'close')
      expect(firstLine()).toBe(USING.replace('{{session}}', name))
      expect(rowEl('a').textContent).toContain(en.browser.tabUsedBy.replace('{{session}}', name))
    }

    it('TC-35 标题 Fix → “Fix”', async () => {
      await expectName({ agentSessionId: 's1', agentSessionTitle: 'Fix' }, 'Fix')
      expect(firstLine()).toBe('“Fix” is using this page')
    })

    it('TC-36 标题两头有空白 → 去掉', async () => {
      await expectName({ agentSessionId: 's1', agentSessionTitle: '  Fix  ' }, 'Fix')
    })

    it.each([
      ['空串', ''],
      ['全是空白', '   '],
      ['undefined', undefined]
    ])('TC-37 标题是%s → 写会话 id', async (_l, title) => {
      await expectName({ agentSessionId: 's1', agentSessionTitle: title }, 's1')
    })

    it('TC-38 无标题无 id、只有 cdpAttached → usingUnknown，不漏占位符或 undefined', async () => {
      setList(row({ id: 'a', cdpAttached: true }))
      await mount()
      await press('a', 'close')
      expect(firstLine()).toBe(USING_UNKNOWN)
      for (const text of [panel()!.textContent, rowEl('a').textContent]) {
        expect(text).not.toContain('{{')
        expect(text).not.toContain('undefined')
      }
    })

    it('TC-39 标题里的 HTML 字符原样显示', async () => {
      const name = '<b>&"x'
      await expectName({ agentSessionId: 's1', agentSessionTitle: name }, name)
      expect(firstLine()).toContain(name)
      expect(box()!.querySelector('b')).toBeNull()
      expect(rowEl('a').querySelector('b')).toBeNull()
    })
  })

  describe('G 框的内容', () => {
    const buttonTexts = (): string[] =>
      [...panel()!.querySelectorAll('button')].map((b) => b.textContent ?? '')

    it('TC-40 关闭：标题、第二行、确认钮 Close tab（红）、取消钮，不混入刷新的文案', async () => {
      setList(row({ id: 'a', agentSessionId: 's1' }))
      await mount()
      await press('a', 'close')
      expect(panel()!.querySelector('h3')?.textContent).toBe(M.confirmCloseTitle)
      expect(secondLine()).toBe(M.confirmCloseBody)
      expect(buttonTexts()).toEqual([M.cancel, en.browser.closeTab])
      expect(confirmBtn('close').classList.contains('bg-error')).toBe(true)
      expect(panel()!.textContent).not.toContain(M.confirmReloadTitle)
      expect(panel()!.textContent).not.toContain(M.confirmReloadBody)
      expect($('[data-browser-tab-confirm-target]')).toBeNull()
    })

    it('TC-41 刷新：标题、第二行、确认钮 Refresh（bg-accent，不是 bg-error）、取消钮，不混入关闭的文案', async () => {
      setList(row({ id: 'a', agentSessionId: 's1' }))
      await mount()
      await press('a', 'reload')
      expect(panel()!.querySelector('h3')?.textContent).toBe(M.confirmReloadTitle)
      expect(secondLine()).toBe(M.confirmReloadBody)
      expect(buttonTexts()).toEqual([M.cancel, en.browser.refresh])
      expect(confirmBtn('reload').classList.contains('bg-accent')).toBe(true)
      expect(confirmBtn('reload').classList.contains('bg-error')).toBe(false)
      expect(panel()!.textContent).not.toContain(M.confirmCloseTitle)
      expect(panel()!.textContent).not.toContain(M.confirmCloseBody)
      expect($('[data-browser-tab-confirm-target]')).toBeNull()
    })
  })

  describe('H 三种语言', () => {
    const LOCALES = [
      ['en', en],
      ['zh', zh],
      ['ja', ja]
    ] as const

    it.each(LOCALES)(
      'I18N-2 %s：四个确认文案非空、不带占位符；关闭与刷新互不相同',
      (_l, locale) => {
        const manager = locale.browser.manager as Record<string, unknown>
        for (const key of [
          'confirmCloseTitle',
          'confirmCloseBody',
          'confirmReloadTitle',
          'confirmReloadBody'
        ]) {
          expect(typeof manager[key], key).toBe('string')
          expect((manager[key] as string).trim().length, key).toBeGreaterThan(0)
          expect(manager[key], key).not.toContain('{{')
        }
        expect(manager.confirmCloseTitle).not.toBe(manager.confirmReloadTitle)
        expect(manager.confirmCloseBody).not.toBe(manager.confirmReloadBody)
      }
    )

    it.each(LOCALES)(
      'I18N-3 %s：using 有 {{session}}，usingUnknown 没有占位符；按钮文案非空',
      (_l, locale) => {
        const browser = locale.browser
        expect(browser.infobar.using).toContain('{{session}}')
        expect(browser.infobar.usingUnknown.trim().length).toBeGreaterThan(0)
        expect(browser.infobar.usingUnknown).not.toContain('{{')
        for (const text of [browser.closeTab, browser.refresh, browser.manager.cancel]) {
          expect(text.trim().length).toBeGreaterThan(0)
        }
      }
    )

    it.each(LOCALES)('I18N-4 %s：换地址的文案非空，标题和正文不带占位符', (_l, locale) => {
      const manager = locale.browser.manager
      for (const text of [manager.confirmNavigateTitle, manager.confirmNavigateBody]) {
        expect(text.trim().length).toBeGreaterThan(0)
        expect(text).not.toContain('{{')
      }
      expect(manager.go.trim().length).toBeGreaterThan(0)
    })

    it.each(LOCALES)('I18N-5 %s：三个动作的标题两两不同，正文也两两不同', (_l, locale) => {
      const manager = locale.browser.manager
      const titles = [
        manager.confirmCloseTitle,
        manager.confirmReloadTitle,
        manager.confirmNavigateTitle
      ]
      const bodies = [
        manager.confirmCloseBody,
        manager.confirmReloadBody,
        manager.confirmNavigateBody
      ]
      expect(new Set(titles).size).toBe(3)
      expect(new Set(bodies).size).toBe(3)
    })
  })

  describe('I 换地址', () => {
    const URL_A = 'https://a.test/x'
    const used = (over: Partial<Row> = {}): Row =>
      row({ id: 'a', url: URL_A, agentSessionId: 's1', cdpAttached: true, ...over })
    const idle = (over: Partial<Row> = {}): Row => row({ id: 'a', url: URL_A, ...over })

    const addr = (): HTMLInputElement | null =>
      $<HTMLInputElement>('[data-browser-tab-address-input]')
    const target = (): HTMLElement | null => $('[data-browser-tab-confirm-target]')
    const urlLine = (id: string): Element | null =>
      rowEl(id).querySelector('[data-browser-tab-url]')
    const formCancel = (): HTMLButtonElement =>
      [...addr()!.form!.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent === M.cancel
      )!
    const navigate = (): Mock => api.browserView.navigate
    const confirmNav = async (): Promise<void> => {
      click(dialogBtn(M.go))
      await flush()
    }

    function openEditor(id = 'a'): HTMLInputElement {
      click(rowEl(id).querySelector('[data-browser-tab-edit]')!)
      return addr()!
    }
    async function pressEnter(): Promise<void> {
      await act(async () => addr()!.form!.requestSubmit())
      await flush()
    }
    async function pressGo(): Promise<void> {
      click($('[data-browser-tab-address-go]')!)
      await flush()
    }
    /** 铅笔 + 打字 + 回车：框开着，停在这里 */
    async function askFor(text = 'example.org'): Promise<HTMLInputElement> {
      const input = openEditor()
      typeInto(input, text)
      await pressEnter()
      return input
    }
    const SUBMITS: Array<[string, () => Promise<void>]> = [
      ['回车', pressEnter],
      ['Go', pressGo]
    ]
    /** 框开着、问的是换地址，navigate 没调 */
    function expectNavAsked(): void {
      expect(box()?.getAttribute('data-browser-tab-agent-confirm')).toBe('navigate')
      expect(navigate()).not.toHaveBeenCalled()
    }
    /** 没有框，navigate 没调 */
    function expectNoNav(): void {
      expect(box()).toBeNull()
      expect(panel()).toBeNull()
      expect(navigate()).not.toHaveBeenCalled()
    }

    beforeEach(() => {
      api.settingsMap = { 'browser.searchEngine': 'bing' }
    })

    describe('什么时候问', () => {
      it('TN-1 点铅笔：只展开输入框、预填 url，没有框，navigate 没调', async () => {
        setList(used())
        await mount()
        const input = openEditor()
        expect(input.value).toBe(URL_A)
        expectNoNav()
      })

      it.each(SUBMITS)('TN-2 %s：出现框，navigate 没调，输入框和字留着', async (_l, submit) => {
        setList(used())
        await mount()
        const input = openEditor()
        typeInto(input, 'example.org')
        await submit()
        expectNavAsked()
        expect(addr()).toBe(input)
        expect(input.value).toBe('example.org')
      })

      it.each([
        ['只有 agentSessionId', { agentSessionId: 's1' }],
        ['只有 cdpAttached', { cdpAttached: true }],
        ['cdpAttached + cdpIntercepting', { cdpAttached: true, cdpIntercepting: true }]
      ] as Array<[string, Partial<Row>]>)('TN-3 %s，回车 → 问', async (_l, over) => {
        setList(idle(over))
        await mount()
        await askFor()
        expectNavAsked()
      })

      it('TN-4 打开时空闲，打字期间变成在用，回车 → 问', async () => {
        setList(idle())
        await mount()
        const input = openEditor()
        typeInto(input, 'example.org')
        setList(used())
        await emit({ type: 'browser.tabsChanged', count: 1 })
        expect(addr()?.value).toBe('example.org')
        await pressEnter()
        expectNavAsked()
      })

      it('TN-5 打开时在用，打字期间 agent 没了，回车 → 直接 navigate，没有框，成功后收起', async () => {
        setList(used())
        await mount()
        const input = openEditor()
        typeInto(input, 'example.org')
        setList(idle())
        await emit({ type: 'browser.tabsChanged', count: 1 })
        await pressEnter()
        expect(box()).toBeNull()
        expect(navigate().mock.calls).toEqual([['a', 'https://example.org', 'typed']])
        expect(addr()).toBeNull()
      })

      it('TN-6 在用，不改字点 Go：也问，目标是 url 解析后的地址', async () => {
        setList(used())
        await mount()
        openEditor()
        await pressGo()
        expectNavAsked()
        expect(target()?.textContent).toBe(URL_A)
      })

      it.each(['', '   '])('TN-7 在用，输入 %j：收起，没有框，navigate 没调', async (text) => {
        setList(used())
        await mount()
        await askFor(text)
        expect(addr()).toBeNull()
        expectNoNav()
      })
    })

    describe('框的内容', () => {
      it('TN-8 标题、正文、确认钮 Go（bg-accent，没有 bg-error）、取消钮、第一行', async () => {
        setList(used({ agentSessionTitle: 'Fix' }))
        await mount()
        await askFor()
        expect(panel()!.querySelector('h3')?.textContent).toBe(M.confirmNavigateTitle)
        expect(firstLine()).toBe(USING.replace('{{session}}', 'Fix'))
        expect(secondLine()).toBe(M.confirmNavigateBody)
        expect([...panel()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
          M.cancel,
          M.go
        ])
        const go = dialogBtn(M.go)
        expect(go.classList.contains('bg-accent')).toBe(true)
        expect(go.classList.contains('bg-error')).toBe(false)
      })

      it.each([
        ['example.org', 'https://example.org'],
        ['  example.org  ', 'https://example.org'],
        ['two words', searchUrl('two words', 'bing')],
        ['shuvix://settings', 'shuvix://settings']
      ])('TN-9 输入 %j → 目标 %s', async (text, expected) => {
        setList(used())
        await mount()
        await askFor(text)
        expect(target()?.textContent).toBe(expected)
        expect(target()?.getAttribute('title')).toBe(expected)
        await confirmNav()
        expect(navigate().mock.calls).toEqual([['a', expected, 'typed']])
      })

      it('TN-10 目标里的 HTML 字符原样显示，不成标签', async () => {
        const url = 'https://x.test/?a=<b>&c=1'
        setList(used())
        await mount()
        await askFor(url)
        expect(target()?.textContent).toBe(url)
        expect(target()?.querySelector('b')).toBeNull()
      })

      it('TN-11 很长的目标：textContent 和 title 属性都是完整地址', async () => {
        const url = `https://x.test/${'long-segment/'.repeat(100)}end`
        setList(used())
        await mount()
        await askFor(url)
        expect(target()?.textContent).toBe(url)
        expect(target()?.getAttribute('title')).toBe(url)
      })

      it.each([
        ['只有 cdpAttached → usingUnknown', { cdpAttached: true }, USING_UNKNOWN],
        [
          '标题为空 → 回退到 id',
          { agentSessionId: 's1', agentSessionTitle: '' },
          USING.replace('{{session}}', 's1')
        ]
      ] as Array<[string, Partial<Row>, string]>)('TN-12 %s', async (_l, over, line) => {
        setList(idle(over))
        await mount()
        await askFor()
        expect(firstLine()).toBe(line)
      })
    })

    describe('确认', () => {
      it('TN-13 确认成功：navigate 一次，框消失，输入框收起、地址行回来，之后重新列', async () => {
        setList(used())
        await mount()
        await askFor()
        const before = listCount()
        await confirmNav()
        expect(navigate().mock.calls).toEqual([['a', 'https://example.org', 'typed']])
        expect(box()).toBeNull()
        expect(panel()).toBeNull()
        expect(addr()).toBeNull()
        expect(urlLine('a')?.textContent).toBe(URL_A)
        expect(listCount()).toBe(before + 1)
        expect(api.browserView.listTabs.mock.invocationCallOrder[before]).toBeGreaterThan(
          navigate().mock.invocationCallOrder[0]
        )
      })

      describe.each([
        ['Error(nope)', () => new Error('nope'), 'nope'],
        [
          'remote_url_refused',
          () => codedError('remote_url_refused', 'raw server text'),
          M.remoteUrlRefused
        ]
      ] as Array<[string, () => Error, string]>)('确认后被拒：%s', (_l, make, reason) => {
        it('TN-14 + TN-15 框消失，字留着，写原因，重新列，焦点回输入框；再回车再问，再确认才再调', async () => {
          setList(used())
          navigate().mockRejectedValueOnce(make())
          await mount()
          const input = await askFor()
          const before = listCount()
          await confirmNav()
          expect(box()).toBeNull()
          expect(panel()).toBeNull()
          expect(addr()).toBe(input)
          expect(input.value).toBe('example.org')
          expect(errorText()).toBe(M.actionFailed.replace('{{reason}}', reason))
          expect(errorText()).not.toContain('raw server text')
          expect(listCount()).toBe(before + 1)
          expect(document.activeElement).toBe(input)
          expect(navigate()).toHaveBeenCalledTimes(1)

          await pressEnter()
          expect(box()?.getAttribute('data-browser-tab-agent-confirm')).toBe('navigate')
          expect(navigate()).toHaveBeenCalledTimes(1)
          await confirmNav()
          expect(navigate()).toHaveBeenCalledTimes(2)
          expect(navigate().mock.calls[1]).toEqual(['a', 'https://example.org', 'typed'])
          expect(addr()).toBeNull()
        })
      })
    })

    describe('取消与焦点', () => {
      it.each([
        [
          '把字清空后提交',
          async (input: HTMLInputElement) => {
            typeInto(input, '')
            await pressEnter()
          }
        ],
        [
          '点地址表单的 Cancel',
          async () => {
            click(formCancel())
            await flush()
          }
        ]
      ] as Array<[string, (input: HTMLInputElement) => Promise<void>]>)(
        'TN-16 框开着时输入框被收起（%s）：框也立刻收起，navigate 没调',
        async (_l, collapse) => {
          setList(used())
          await mount()
          const input = await askFor()
          expectNavAsked()
          await collapse(input)
          expect(addr()).toBeNull()
          expectNoNav()
        }
      )

      it.each(ACTIONS)('TN-16b %s 框开着时输入框被收起：输入框收起，框留着', async (action) => {
        setList(used())
        await mount()
        const input = openEditor()
        await press('a', action)
        expectAsked(action)
        typeInto(input, '')
        await act(async () => input.form!.requestSubmit())
        await flush()
        expect(addr()).toBeNull()
        expectAsked(action)
      })

      it.each([
        ['框的 Cancel', () => click(cancelBtn())],
        ['点遮罩', () => click(overlay()!)]
      ] as Array<[string, () => void]>)(
        'TN-17 %s：退场后框消失，不重新列，输入框同一个节点、字不变，焦点回输入框',
        async (_l, cancel) => {
          setList(used())
          await mount()
          const input = await askFor()
          const before = listCount()
          cancel()
          await waitExit()
          expectNoNav()
          expect(listCount()).toBe(before)
          expect(addr()).toBe(input)
          expect(input.value).toBe('example.org')
          expect(document.activeElement).toBe(input)
        }
      )

      it('TN-18 + TN-19 焦点在确认钮上按 Esc：只取消框，焦点回输入框；在输入框上再按 Esc：输入框收起', async () => {
        setList(used())
        await mount()
        const input = await askFor()
        expect(document.activeElement).toBe(dialogBtn(M.go))
        keyDown(document.activeElement!, 'Escape')
        await waitExit()
        expectNoNav()
        expect(addr()).toBe(input)
        expect(input.value).toBe('example.org')
        expect(document.activeElement).toBe(input)

        keyDown(input, 'Escape')
        await flush()
        expect(addr()).toBeNull()
        expectNoNav()
      })

      it('TN-20 框开着、焦点挪回输入框，在输入框上按 Esc：只取消框，输入框留着', async () => {
        setList(used())
        await mount()
        const input = await askFor()
        act(() => input.focus())
        expect(document.activeElement).toBe(input)
        keyDown(input, 'Escape')
        await waitExit()
        expectNoNav()
        expect(addr()).toBe(input)
        expect(input.value).toBe('example.org')
      })

      it.each(ACTIONS)(
        'TN-21 输入框开着、%s 框开着，在输入框上按 Esc：只关框，输入框留着',
        async (action) => {
          setList(used())
          await mount()
          const input = openEditor()
          typeInto(input, 'example.org')
          await press('a', action)
          expectAsked(action)
          keyDown(input, 'Escape')
          await waitExit()
          expectNothing()
          expect(addr()).toBe(input)
          expect(input.value).toBe('example.org')
        }
      )

      it('TN-22 回车打开框后，焦点在框的确认钮上', async () => {
        setList(used())
        await mount()
        await askFor()
        expect(document.activeElement).toBe(dialogBtn(M.go))
      })

      it.each(ACTIONS)('TN-22 %s 框的确认钮不抢焦点', async (action) => {
        setList(used())
        await mount()
        const input = openEditor()
        expect(document.activeElement).toBe(input)
        await press('a', action)
        expectAsked(action)
        expect(document.activeElement).toBe(input)
        expect(document.activeElement).not.toBe(confirmBtn(action))
      })

      it('TN-23 已有错误行：打开框后取消，错误行留着；确认时才清掉', async () => {
        setList(used(), row({ id: 'b' }))
        api.browserView.reload.mockRejectedValueOnce(new Error('boom'))
        await mount()
        await press('b', 'reload')
        const error = M.actionFailed.replace('{{reason}}', 'boom')
        expect(errorText()).toBe(error)

        await askFor()
        expect(errorText()).toBe(error)
        click(cancelBtn())
        await waitExit()
        expect(errorText()).toBe(error)

        await pressEnter()
        expect(errorText()).toBe(error)
        await confirmNav()
        expect(errorText()).toBeNull()
      })

      it('TN-24 取消后不改字回车：再问，新框没有 dialog-closing', async () => {
        setList(used())
        await mount()
        await askFor()
        click(cancelBtn())
        await waitExit()
        await pressEnter()
        expectNavAsked()
        expect(target()?.textContent).toBe('https://example.org')
        expect(overlay()!.classList.contains('dialog-closing')).toBe(false)
      })
    })

    describe('框开着时列表变了', () => {
      it('TN-28 + TN-29 a 没了：框立刻消失；a 回来：不自己再弹', async () => {
        setList(used(), row({ id: 'b' }))
        await mount()
        await askFor()
        setList(row({ id: 'b' }))
        await emit({ type: 'browser.tabsChanged', count: 1 })
        expectNoNav()

        setList(used(), row({ id: 'b' }))
        await emit({ type: 'browser.tabsChanged', count: 2 })
        expect(rowIds()).toEqual(['a', 'b'])
        expectNoNav()
      })

      it('TN-30 listTabs 被拒：框消失、denied；恢复后不自己再弹', async () => {
        setList(used())
        await mount()
        await askFor()
        api.browserView.listTabs.mockRejectedValueOnce(new Error('NB prompt'))
        await emit({ type: 'browser.tabsChanged', count: 1 })
        expectNoNav()
        expect($('[data-browser-tabs-denied]')).not.toBeNull()

        await emit({ type: 'browser.tabsChanged', count: 1 })
        expect($('[data-browser-tabs-denied]')).toBeNull()
        expect(rowIds()).toEqual(['a'])
        expectNoNav()
      })

      it('TN-31 agent 全没了：框立刻收起，字留着；再回车直接 navigate，没有框', async () => {
        setList(used())
        await mount()
        const input = await askFor()
        setList(idle())
        await emit({ type: 'browser.tabsChanged', count: 1 })
        expectNoNav()
        expect(addr()).toBe(input)
        expect(input.value).toBe('example.org')

        await pressEnter()
        expect(box()).toBeNull()
        expect(navigate().mock.calls).toEqual([['a', 'https://example.org', 'typed']])
      })

      it('TN-32 a 变成没有 agent 的内部页面：框收起，navigate 没调', async () => {
        setList(used())
        await mount()
        await askFor()
        setList(row({ id: 'a', url: 'shuvix://settings', internalPage: 'settings' }))
        await emit({ type: 'browser.tabsChanged', count: 1 })
        expectNoNav()
      })

      it('TN-33 a 崩了（仍在用）：框收起，字留着；再回车直接 navigate', async () => {
        setList(used())
        await mount()
        const input = await askFor()
        setList(used({ crashed: true }))
        await emit({ type: 'browser.tabsChanged', count: 1 })
        expectNoNav()
        expect(addr()).toBe(input)
        expect(input.value).toBe('example.org')

        await pressEnter()
        expect(box()).toBeNull()
        expect(navigate().mock.calls).toEqual([['a', 'https://example.org', 'typed']])
      })

      it('TN-34 a 的 url、标题、loading 变了（仍在用）：框留着，目标和字不变，确认后去原目标', async () => {
        setList(used({ title: 'A' }))
        await mount()
        const input = await askFor()
        setList(used({ title: 'A next', url: 'https://a.test/next', loading: true }))
        await emit({ type: 'browser.tabsChanged', count: 1 })
        expect(titleOf('a')).toBe('A next')
        expectNavAsked()
        expect(target()?.textContent).toBe('https://example.org')
        expect(input.value).toBe('example.org')

        await confirmNav()
        expect(navigate().mock.calls).toEqual([['a', 'https://example.org', 'typed']])
      })

      it.each(['resolve', 'reject'])(
        'TN-35 先发的 listTabs（不含 a）晚回来（%s）：被忽略，框留着',
        async (how) => {
          setList(used())
          await mount()
          const stale = deferred<Row[]>()
          api.browserView.listTabs.mockImplementationOnce(() => stale.promise)
          await emit({ type: 'browser.tabsChanged', count: 1 })
          await emit({ type: 'browser.tabsChanged', count: 1 })
          await askFor()
          expectNavAsked()

          await act(async () => {
            if (how === 'resolve') stale.resolve([row({ id: 'gone' })])
            else stale.reject(new Error('late'))
          })
          await flush()
          expectNavAsked()
          expect(rowIds()).toEqual(['a'])
          expect($('[data-browser-tabs-denied]')).toBeNull()
        }
      )
    })

    describe('崩溃页', () => {
      const USE_STATES: Array<[string, Partial<Row>]> = [
        ['agentSessionId + cdpAttached', { agentSessionId: 's1', cdpAttached: true }],
        ['只有 agentSessionId', { agentSessionId: 's1' }],
        ['只有 cdpAttached', { cdpAttached: true }]
      ]

      it.each(
        USE_STATES.flatMap(([label, over]) =>
          SUBMITS.map(([how, submit]) => [label, how, over, submit] as const)
        )
      )('TN-36 崩了 + %s，%s：直接 navigate，没有框，成功后收起', async (_l, _h, over, submit) => {
        setList(idle({ crashed: true, ...over }))
        await mount()
        typeInto(openEditor(), 'example.org')
        await submit()
        expect(box()).toBeNull()
        expect(navigate().mock.calls).toEqual([['a', 'https://example.org', 'typed']])
        expect(addr()).toBeNull()
      })

      it('TN-37 空闲的崩溃页回车：直接 navigate', async () => {
        setList(idle({ crashed: true }))
        await mount()
        await askFor()
        expect(box()).toBeNull()
        expect(navigate().mock.calls).toEqual([['a', 'https://example.org', 'typed']])
      })

      it('TN-38 崩了 + 在用，输入框开着，点关闭：仍问；取消后输入框留着', async () => {
        setList(used({ crashed: true }))
        await mount()
        const input = openEditor()
        typeInto(input, 'example.org')
        await press('a', 'close')
        expectAsked('close')
        click(cancelBtn())
        await waitExit()
        expectNothing()
        expect(addr()).toBe(input)
        expect(input.value).toBe('example.org')
      })
    })

    describe('输入框开着时的刷新 / 关闭', () => {
      it('TN-39 刷新框确认：框上没有目标元素，输入框和字留着', async () => {
        setList(used())
        await mount()
        const input = openEditor()
        typeInto(input, 'example.org')
        await press('a', 'reload')
        expect(target()).toBeNull()
        await confirm('reload')
        expect(api.browserView.reload.mock.calls).toEqual([['a']])
        expect(addr()).toBe(input)
        expect(input.value).toBe('example.org')
        expect(navigate()).not.toHaveBeenCalled()
      })

      it('TN-39 关闭框确认：框上没有目标元素，行没了', async () => {
        setList(used(), row({ id: 'b' }))
        await mount()
        typeInto(openEditor(), 'example.org')
        await press('a', 'close')
        expect(target()).toBeNull()
        api.browserView.listTabs.mockResolvedValueOnce([row({ id: 'b' })])
        await confirm('close')
        expect(api.browserView.closeTab.mock.calls).toEqual([['a']])
        expect(rowIds()).toEqual(['b'])
        expect(addr()).toBeNull()
        expect(navigate()).not.toHaveBeenCalled()
      })
    })

    describe('没有 agent 的行', () => {
      it.each(SUBMITS)('TN-40 %s：直接 navigate，全程没有框，成功后收起', async (_l, submit) => {
        setList(idle())
        await mount()
        typeInto(openEditor(), 'example.org')
        expect(box()).toBeNull()
        await submit()
        expect(box()).toBeNull()
        expect(navigate().mock.calls).toEqual([['a', 'https://example.org', 'typed']])
        expect(addr()).toBeNull()
      })

      it.each(SUBMITS)('TN-40 %s：失败后输入框留着并显示错误，没有框', async (_l, submit) => {
        setList(idle())
        navigate().mockRejectedValueOnce(new Error('nope'))
        await mount()
        const input = openEditor()
        typeInto(input, 'example.org')
        await submit()
        expect(box()).toBeNull()
        expect(addr()).toBe(input)
        expect(input.value).toBe('example.org')
        expect(errorText()).toBe(M.actionFailed.replace('{{reason}}', 'nope'))
      })

      it.each([
        [
          '空字',
          async (input: HTMLInputElement) => {
            typeInto(input, '  ')
            await pressEnter()
          }
        ],
        [
          'Esc',
          async (input: HTMLInputElement) => {
            keyDown(input, 'Escape')
            await flush()
          }
        ],
        [
          '表单 Cancel',
          async () => {
            click(formCancel())
            await flush()
          }
        ]
      ] as Array<[string, (input: HTMLInputElement) => Promise<void>]>)(
        'TN-41 %s → 收起，不导航',
        async (_l, collapse) => {
          setList(idle())
          await mount()
          await collapse(openEditor())
          expect(addr()).toBeNull()
          expectNoNav()
        }
      )

      it('TN-42 a 的 navigate 挂着时打开 b 的铅笔，a 成功：b 的输入框不被收掉', async () => {
        setList(idle(), row({ id: 'b', url: 'https://b.test/' }))
        const pending = deferred<void>()
        navigate().mockImplementationOnce(() => pending.promise)
        await mount()
        await askFor()
        expect(navigate().mock.calls).toEqual([['a', 'https://example.org', 'typed']])

        const inputB = openEditor('b')
        expect(inputB.value).toBe('https://b.test/')
        await act(async () => pending.resolve())
        await flush()
        expect(addr()).toBe(inputB)
        expect(rowEl('b').contains(inputB)).toBe(true)
        expect(urlLine('a')?.textContent).toBe(URL_A)
      })
    })
  })
})
