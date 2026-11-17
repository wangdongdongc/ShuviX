// @vitest-environment jsdom
/**
 * 手机布局「浏览器」里一个标签页那一页（mobile/MobileBrowser.tsx 的 MobileBrowserTabPage，jsdom）。
 *
 * 契约：大标题是页面标题、下面是地址；谁在用（「View conversation」→ onOpenSession）；截图进这一页截一次、可以
 * 重新截、不自动刷新；换个地址、刷新 / 停止、关闭。agent 用着的页刷新、关闭、换地址先问（崩了的页刷新、换地址不问）。
 * 清单到了却没有这一页 → onBack 一次、这一帧不画；清单还没到（或被拒）→ 照样有返回键的一页。
 *
 *   TB-1..3    框架
 *   TB-4..7    这一页没了 / 清单不在
 *   TB-8..13   状态卡片
 *   TB-14..21  截图
 *   TB-22..28  换地址
 *   TB-29..31  刷新 / 停止 / 关闭
 *   TB-32..36  确认框
 *
 * `window.api` 是 browserDomSupport 的假件；@shuvix/chat-ui、@shuvix/app-shell 是真的（ConfirmDialog 取消要等
 * 120ms 的退场）。真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { MobileBrowserTabPage } from '../MobileBrowser'
import { screenshotWidth, type TabRow } from '../../components/browser/tabsManagerPure'
import { searchUrl } from '../../../../shared/browserSearchEngines'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  installRaf,
  keyDown,
  typeInto,
  type FakeApi
} from '../../components/browser/__tests__/browserDomSupport'

const M = en.browser.manager
const I = en.browser.infobar

const row = (over: Partial<TabRow> = {}): TabRow =>
  ({
    id: 'a',
    url: 'https://example.com/',
    title: 'Example',
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
/** 会话 s1（标题 Fix）用着的页 */
const used = (over: Partial<TabRow> = {}): TabRow =>
  row({ agentSessionId: 's1', agentSessionTitle: 'Fix', cdpAttached: true, ...over })

let api: FakeApi
let container: HTMLDivElement
let root: Root
let mounted = false
const onBack = vi.fn<() => void>()
const onOpenSession = vi.fn<(id: string) => void>()
const reload = vi.fn<() => void>()

interface Over {
  tabs?: TabRow[] | null
  listError?: string | null
  tabId?: string
}

async function render(over: Over = {}): Promise<void> {
  const tabs = over.tabs === undefined ? [row()] : over.tabs
  act(() =>
    root.render(
      createElement(MobileBrowserTabPage, {
        state: { tabs, listError: over.listError ?? null, reload },
        tabId: over.tabId ?? 'a',
        onBack,
        onOpenSession
      })
    )
  )
  mounted = true
  await flush()
}
function unmount(): void {
  if (mounted) act(() => root.unmount())
  mounted = false
}

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  container.querySelector<T>(sel)
const shot = (): string | null =>
  $('[data-mobile-browser-screenshot]')?.getAttribute('data-mobile-browser-screenshot') ?? null
const retake = (): HTMLButtonElement =>
  $<HTMLButtonElement>('[data-mobile-browser-screenshot-retake]')!
const address = (): HTMLInputElement | null =>
  $<HTMLInputElement>('[data-mobile-browser-tab-address]')
const errorText = (): string | null => $('[data-mobile-browser-error]')?.textContent ?? null
const dialog = (): HTMLElement | null => $('[data-browser-tab-agent-confirm]')
const dialogAction = (): string | null =>
  dialog()?.getAttribute('data-browser-tab-agent-confirm') ?? null
const dialogButtons = (): HTMLButtonElement[] => [
  ...dialog()!.closest('.dialog-panel')!.querySelectorAll('button')
]
const tap = async (sel: string): Promise<void> => {
  const el = $(sel)
  if (!el) throw new Error(`no ${sel}`)
  click(el)
  await flush()
}
/** 打开输入框、填字、点 Go */
async function go(text: string): Promise<void> {
  if (!address()) await tap('[data-mobile-browser-tab-edit]')
  typeInto(address()!, text)
  await tap('[data-mobile-browser-tab-go]')
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
const PNG = 'data:image/png;base64,AAAA'

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  installRaf()
  vi.clearAllMocks()
  api.settings.getAll.mockImplementation(async () => ({ ...api.settingsMap }))
  api.browserView.capture.mockImplementation(async () => PNG)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  unmount()
  container.remove()
  vi.restoreAllMocks()
})

describe('框架（TB-1 … TB-3）', () => {
  it('TB-1 browser-tab 页；返回键写 Browser；大标题是页面标题', async () => {
    await render()
    expect($('[data-mobile-panel="browser-tab"]')).not.toBeNull()
    expect($('[data-mobile-panel-back]')!.textContent).toBe(M.title)
    expect($('[data-mobile-panel-title]')!.textContent).toBe('Example')
    expect($('[data-mobile-browser-tab-detail="a"]')).not.toBeNull()
  })

  it('TB-1 标题的先后与列表一样：内部页面的页名 > 标题 > 地址 >「New Tab」', async () => {
    const title = (): string => $('[data-mobile-panel-title]')!.textContent ?? ''
    await render({ tabs: [row({ title: 'x', internalPage: 'history' })] })
    expect(title()).toBe(en.browser.internal.history)
    await render({ tabs: [row({ title: '' })] })
    expect(title()).toBe('https://example.com/')
    await render({ tabs: [row({ title: '', url: '' })] })
    expect(title()).toBe(en.browser.untitledTab)
  })

  it('TB-2 小字是地址；空地址写 about:blank；内部页面没有这一行', async () => {
    await render()
    expect($('[data-mobile-browser-tab-url]')!.textContent).toBe('https://example.com/')
    await render({ tabs: [row({ url: '' })] })
    expect($('[data-mobile-browser-tab-url]')!.textContent).toBe('about:blank')
    await render({ tabs: [row({ internalPage: 'settings' })] })
    expect($('[data-mobile-browser-tab-url]')).toBeNull()
    expect($('[data-mobile-panel-subtitle]')).toBeNull()
  })

  it('TB-3 返回键 → onBack 一次', async () => {
    await render()
    await tap('[data-mobile-panel-back]')
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('这一页没了 / 清单不在（TB-4 … TB-7）', () => {
  it('TB-4 清单到了、里面没有它 → onBack 正好一次（之后再取一遍还是没有，也不再调）；什么都不画', async () => {
    await render({ tabs: [row({ id: 'b' })] })
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(container.innerHTML).toBe('')
    await render({ tabs: [row({ id: 'b' }), row({ id: 'c' })] })
    await render({ tabs: [] })
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(api.browserView.capture).not.toHaveBeenCalled()
  })

  it('TB-5 清单还没到 → 不调 onBack', async () => {
    await render({ tabs: null })
    expect(onBack).not.toHaveBeenCalled()
  })

  it('TB-6 先在，重画后从清单里没了 → onBack 一次', async () => {
    await render()
    expect(onBack).not.toHaveBeenCalled()
    await render({ tabs: [] })
    expect(onBack).toHaveBeenCalledTimes(1)
    expect($('[data-mobile-panel]')).toBeNull()
  })

  it('TB-7 清单还没到：照样是一页，返回键能用，写着加载中', async () => {
    await render({ tabs: null })
    expect($('[data-mobile-panel="browser-tab"]')).not.toBeNull()
    expect($('[data-mobile-browser-tab-loading]')!.textContent).toContain(en.common.loading)
    expect($('[data-mobile-browser-denied]')).toBeNull()
    expect($('[data-mobile-browser-tab-detail]')).toBeNull()
    expect(api.browserView.capture).not.toHaveBeenCalled()
    await tap('[data-mobile-panel-back]')
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('TB-7 清单取不到（listError）：一页、返回键能用、写着那句话', async () => {
    await render({ tabs: null, listError: 'NB prompt' })
    expect($('[data-mobile-panel="browser-tab"]')).not.toBeNull()
    expect($('[data-mobile-browser-denied]')!.textContent).toBe(
      'This device may not see the tabs: NB prompt'
    )
    expect($('[data-mobile-browser-tab-loading]')).toBeNull()
    await tap('[data-mobile-panel-back]')
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('TB-7 清单后来到了 → 画出这一页', async () => {
    await render({ tabs: null })
    await render()
    expect($('[data-mobile-browser-tab-detail="a"]')).not.toBeNull()
    expect($('[data-mobile-browser-tab-loading]')).toBeNull()
    expect(onBack).not.toHaveBeenCalled()
  })
})

describe('状态卡片（TB-8 … TB-13）', () => {
  it('TB-8 普通的页没有状态卡片', async () => {
    await render()
    expect($('[data-mobile-browser-tab-status]')).toBeNull()
  })

  it('TB-9 崩了 → Page crashed', async () => {
    await render({ tabs: [row({ crashed: true })] })
    expect($('[data-mobile-browser-tab-crashed]')!.textContent).toBe(M.crashed)
    expect($('[data-mobile-browser-tab-agent]')).toBeNull()
  })

  it('TB-10 会话用着：“Fix” is using this page + View conversation → onOpenSession(s1)', async () => {
    await render({ tabs: [used()] })
    expect($('[data-mobile-browser-tab-agent]')!.textContent).toContain('“Fix” is using this page')
    const open = $('[data-mobile-browser-tab-open-session]')!
    expect(open.textContent).toBe(I.openSession)
    click(open)
    expect(onOpenSession.mock.calls).toEqual([['s1']])
    expect(dialog()).toBeNull()
  })

  it('TB-11 会话没有标题写 id；只接着 CDP → 不知道是谁的那句，没有 View conversation', async () => {
    await render({ tabs: [row({ agentSessionId: 's9' })] })
    expect($('[data-mobile-browser-tab-agent]')!.textContent).toContain('“s9” is using this page')
    await render({ tabs: [row({ cdpAttached: true })] })
    expect($('[data-mobile-browser-tab-agent]')!.textContent).toBe(I.usingUnknown)
    expect($('[data-mobile-browser-tab-open-session]')).toBeNull()
  })

  it('TB-12 拦截中：带会话的那句 / 不知道是谁的那句', async () => {
    await render({ tabs: [used({ cdpIntercepting: true })] })
    expect($('[data-mobile-browser-tab-agent]')!.textContent).toContain(
      I.intercepting.replace('{{session}}', 'Fix')
    )
    await render({ tabs: [row({ cdpAttached: true, cdpIntercepting: true })] })
    expect($('[data-mobile-browser-tab-agent]')!.textContent).toBe(I.interceptingUnknown)
  })

  it('TB-13 崩了又被用着：一张卡片里两行', async () => {
    await render({ tabs: [used({ crashed: true })] })
    const cards = container.querySelectorAll('[data-mobile-browser-tab-status]')
    expect(cards).toHaveLength(1)
    expect(cards[0].querySelector('[data-mobile-browser-tab-crashed]')).not.toBeNull()
    expect(cards[0].querySelector('[data-mobile-browser-tab-agent]')).not.toBeNull()
  })
})

describe('截图（TB-14 … TB-21）', () => {
  it('TB-14 挂上截一次（capture(id, 宽度)）；loading，重新截图禁用', async () => {
    const pending = deferred<string>()
    api.browserView.capture.mockImplementation(() => pending.promise)
    await render()
    expect(api.browserView.capture.mock.calls).toEqual([['a', screenshotWidth()]])
    expect(shot()).toBe('loading')
    expect(retake().disabled).toBe(true)
    expect($('[data-mobile-browser-screenshot]')!.textContent).toContain(M.screenshotLoading)
  })

  it('TB-15 回来一张图 → shown，img 的 src 是它，下面写 Taken at <时间>', async () => {
    await render()
    expect(shot()).toBe('shown')
    const img = $<HTMLImageElement>('[data-mobile-browser-screenshot-image]')!
    expect(img.getAttribute('src')).toBe(PNG)
    expect(img.getAttribute('alt')).toBe(M.screenshotAlt)
    const note = $('[data-mobile-browser-screenshot]')!.textContent ?? ''
    expect(note).toMatch(/^Taken at \d/)
    expect(note).not.toContain('{{')
    expect(retake().disabled).toBe(false)
  })

  it('TB-16 空的 → empty 的说法；失败 → failed 带原因；地址被拒 → 本地化的那句', async () => {
    api.browserView.capture.mockImplementation(async () => '')
    await render()
    expect(shot()).toBe('empty')
    expect($('[data-mobile-browser-screenshot]')!.textContent).toContain(M.screenshotEmpty)
    expect($('[data-mobile-browser-screenshot-image]')).toBeNull()

    api.browserView.capture.mockRejectedValueOnce(new Error('NB rule'))
    await tap('[data-mobile-browser-screenshot-retake]')
    expect(shot()).toBe('failed')
    expect($('[data-mobile-browser-screenshot]')!.textContent).toContain(
      'Could not take a screenshot: NB rule'
    )

    api.browserView.capture.mockRejectedValueOnce(codedError('remote_url_refused', 'raw text'))
    await tap('[data-mobile-browser-screenshot-retake]')
    expect(shot()).toBe('failed')
    const text = $('[data-mobile-browser-screenshot]')!.textContent ?? ''
    expect(text).toContain(M.remoteUrlRefused)
    expect(text).not.toContain('raw text')
  })

  it('TB-16 回来 null 也是 empty', async () => {
    api.browserView.capture.mockImplementation(async () => null)
    await render()
    expect(shot()).toBe('empty')
  })

  it('TB-17 不自动重新截：这一行变了（标题、加载中）→ capture 还是一次，同一张图', async () => {
    await render()
    const img = $('[data-mobile-browser-screenshot-image]')
    await render({ tabs: [row({ title: 'New title', loading: true })] })
    await render({ tabs: [row({ title: 'New title' }), row({ id: 'b' })] })
    expect(api.browserView.capture).toHaveBeenCalledTimes(1)
    expect($('[data-mobile-browser-screenshot-image]')).toBe(img)
    expect($('[data-mobile-panel-title]')!.textContent).toBe('New title')
  })

  it('TB-18 重新截图 → 回到 loading、再截一次、画新的结果', async () => {
    await render()
    const second = deferred<string>()
    api.browserView.capture.mockImplementation(() => second.promise)
    await tap('[data-mobile-browser-screenshot-retake]')
    expect(shot()).toBe('loading')
    expect(retake().disabled).toBe(true)
    expect(api.browserView.capture).toHaveBeenCalledTimes(2)
    second.resolve('data:image/png;base64,BBBB')
    await flush()
    expect(shot()).toBe('shown')
    expect($('[data-mobile-browser-screenshot-image]')!.getAttribute('src')).toBe(
      'data:image/png;base64,BBBB'
    )
  })

  it('TB-19 截图中重新截图是禁用的：点了不再截，第一次的结果照常画', async () => {
    const first = deferred<string>()
    api.browserView.capture.mockImplementation(() => first.promise)
    await render()
    click(retake())
    await flush()
    expect(api.browserView.capture).toHaveBeenCalledTimes(1)
    first.resolve(PNG)
    await flush()
    expect(shot()).toBe('shown')
  })

  it('TB-20 结果回来前卸载 → 不写 state、没有警告', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const first = deferred<string>()
    api.browserView.capture.mockImplementation(() => first.promise)
    await render()
    unmount()
    first.resolve(PNG)
    await flush()
    expect(errors).not.toHaveBeenCalled()
  })

  it('TB-21 内部页面没有截图卡片，capture 不调', async () => {
    await render({ tabs: [row({ internalPage: 'settings' })] })
    expect($('[data-mobile-browser-screenshot]')).toBeNull()
    expect(api.browserView.capture).not.toHaveBeenCalled()
  })
})

describe('换地址（TB-22 … TB-28）', () => {
  it('TB-22 起先是一行「Change address」；点它 → 预填地址、聚焦的输入框，Go 与 Cancel', async () => {
    await render()
    expect($('[data-mobile-browser-tab-edit]')!.textContent).toBe(M.changeAddress)
    expect(address()).toBeNull()
    await tap('[data-mobile-browser-tab-edit]')
    expect(address()!.value).toBe('https://example.com/')
    expect(document.activeElement).toBe(address())
    expect($('[data-mobile-browser-tab-go]')!.textContent).toBe(M.go)
    expect($('[data-mobile-browser-tab-cancel]')!.textContent).toBe(M.cancel)
    expect($('[data-mobile-browser-tab-edit]')).toBeNull()
  })

  it('TB-22 内部页面没有这一行', async () => {
    await render({ tabs: [row({ internalPage: 'settings' })] })
    expect($('[data-mobile-browser-tab-edit]')).toBeNull()
    expect(address()).toBeNull()
  })

  it('TB-23 Cancel → 变回那一行，什么都不调；输入框里按 Escape 也一样', async () => {
    await render()
    await tap('[data-mobile-browser-tab-edit]')
    await tap('[data-mobile-browser-tab-cancel]')
    expect(address()).toBeNull()
    expect($('[data-mobile-browser-tab-edit]')).not.toBeNull()

    await tap('[data-mobile-browser-tab-edit]')
    keyDown(address()!, 'Escape')
    expect(address()).toBeNull()
    expect(api.browserView.navigate).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('TB-24 空的（或全是空白）+ Go → 收起，不导航', async () => {
    await render()
    await go('')
    expect(address()).toBeNull()
    await go('   ')
    expect(address()).toBeNull()
    expect(api.browserView.navigate).not.toHaveBeenCalled()
  })

  it('TB-25 example.org + Go → navigate(id, https://example.org, typed)；重新取列表；成功后收起', async () => {
    await render()
    await go('example.org')
    expect(api.browserView.navigate.mock.calls).toEqual([['a', 'https://example.org', 'typed']])
    expect(reload).toHaveBeenCalledTimes(1)
    expect(address()).toBeNull()
    expect(errorText()).toBeNull()
  })

  it('TB-26 搜索词 → 设置里那个引擎的搜索地址', async () => {
    api.settingsMap['browser.searchEngine'] = 'bing'
    await render()
    await go('two words')
    expect(api.browserView.navigate.mock.calls).toEqual([
      ['a', searchUrl('two words', 'bing'), 'typed']
    ])
  })

  it('TB-27 失败 → 错误卡片，输入框和字留着、聚焦', async () => {
    api.browserView.navigate.mockRejectedValue(new Error('nope'))
    await render()
    await go('example.org')
    expect(errorText()).toBe('That did not work: nope')
    expect(address()!.value).toBe('example.org')
    expect(document.activeElement).toBe(address())
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('TB-28 回车（表单提交）与 Go 一样；输入法组字中的 Escape 不收起', async () => {
    await render()
    await tap('[data-mobile-browser-tab-edit]')
    keyDown(address()!, 'Escape', { isComposing: true })
    expect(address()).not.toBeNull()
    typeInto(address()!, 'example.org')
    act(() => {
      address()!.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await flush()
    expect(api.browserView.navigate.mock.calls).toEqual([['a', 'https://example.org', 'typed']])
    expect(address()).toBeNull()
  })
})

describe('刷新 / 停止 / 关闭（TB-29 … TB-31）', () => {
  it('TB-29 没在加载：Reload → reload(id)；加载中：那一行是 Stop → stop(id)，没有 Reload', async () => {
    await render()
    expect($('[data-mobile-browser-tab-stop]')).toBeNull()
    await tap('[data-mobile-browser-tab-reload]')
    expect(api.browserView.reload.mock.calls).toEqual([['a']])

    await render({ tabs: [row({ loading: true })] })
    expect($('[data-mobile-browser-tab-reload]')).toBeNull()
    expect($('[data-mobile-browser-tab-stop]')!.textContent).toBe(en.browser.stop)
    await tap('[data-mobile-browser-tab-stop]')
    expect(api.browserView.stop.mock.calls).toEqual([['a']])
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('TB-30 Close → closeTab(id)；失败 → 错误卡片，这一页还在', async () => {
    await render()
    await tap('[data-mobile-browser-tab-close]')
    expect(api.browserView.closeTab.mock.calls).toEqual([['a']])
    expect(errorText()).toBeNull()

    api.browserView.closeTab.mockRejectedValueOnce(new Error('denied'))
    await tap('[data-mobile-browser-tab-close]')
    expect(errorText()).toBe('That did not work: denied')
    expect($('[data-mobile-browser-tab-detail="a"]')).not.toBeNull()
    expect(onBack).not.toHaveBeenCalled()
  })

  it('TB-31 Stop 失败 → 错误卡片；之后一次成功的动作清掉它', async () => {
    api.browserView.stop.mockRejectedValueOnce(new Error('x'))
    await render({ tabs: [row({ loading: true })] })
    await tap('[data-mobile-browser-tab-stop]')
    expect(errorText()).toBe('That did not work: x')
    await tap('[data-mobile-browser-tab-stop]')
    expect(errorText()).toBeNull()
  })
})

describe('确认框（TB-32 … TB-36）', () => {
  it('TB-32 agent 用着：Reload → 问；取消 → 什么都不调；确认 → reload(id)', async () => {
    await render({ tabs: [used()] })
    await tap('[data-mobile-browser-tab-reload]')
    expect(dialogAction()).toBe('reload')
    expect(dialog()!.textContent).toContain('“Fix” is using this page')
    expect(dialog()!.textContent).toContain(M.confirmReloadBody)
    expect(dialog()!.querySelector('[data-browser-tab-confirm-target]')).toBeNull()
    expect(api.browserView.reload).not.toHaveBeenCalled()

    click(dialogButtons()[0])
    await settle()
    expect(dialog()).toBeNull()
    expect(api.browserView.reload).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()

    await tap('[data-mobile-browser-tab-reload]')
    click(dialogButtons()[1])
    await flush()
    expect(dialog()).toBeNull()
    expect(api.browserView.reload.mock.calls).toEqual([['a']])
  })

  it('TB-33 agent 用着：Close → 确认钮是危险色；确认 → closeTab', async () => {
    await render({ tabs: [used()] })
    await tap('[data-mobile-browser-tab-close]')
    expect(dialogAction()).toBe('close')
    const [cancel, confirm] = dialogButtons()
    expect(cancel.textContent).toBe(M.cancel)
    expect(confirm.textContent).toBe(en.browser.closeTab)
    expect(confirm.className).toContain('bg-error')
    expect(api.browserView.closeTab).not.toHaveBeenCalled()
    click(confirm)
    await flush()
    expect(api.browserView.closeTab.mock.calls).toEqual([['a']])
    expect(api.browserView.reload).not.toHaveBeenCalled()
  })

  it('TB-34 agent 用着：Go → 问，写着要去的地址；取消后输入框和字留着；确认 → navigate，成功后收起', async () => {
    await render({ tabs: [used()] })
    await go('example.org')
    expect(dialogAction()).toBe('navigate')
    expect(dialog()!.querySelector('[data-browser-tab-confirm-target]')!.textContent).toBe(
      'https://example.org'
    )
    expect(dialogButtons()[1].className).not.toContain('bg-error')
    expect(api.browserView.navigate).not.toHaveBeenCalled()
    expect(address()!.value).toBe('example.org')

    click(dialogButtons()[0])
    await settle()
    expect(dialog()).toBeNull()
    expect(address()!.value).toBe('example.org')
    expect(api.browserView.navigate).not.toHaveBeenCalled()

    await tap('[data-mobile-browser-tab-go]')
    click(dialogButtons()[1])
    await flush()
    expect(api.browserView.navigate.mock.calls).toEqual([['a', 'https://example.org', 'typed']])
    expect(dialog()).toBeNull()
    expect(address()).toBeNull()
  })

  it('TB-34 确认框开着时在输入框上按 Escape：只取消确认框，输入框留着', async () => {
    await render({ tabs: [used()] })
    await go('example.org')
    keyDown(address()!, 'Escape')
    await settle()
    expect(dialog()).toBeNull()
    expect(address()!.value).toBe('example.org')
    expect(api.browserView.navigate).not.toHaveBeenCalled()
  })

  it('TB-34 确认框开着时点表单的 Cancel：输入框和确认框都收起', async () => {
    await render({ tabs: [used()] })
    await go('example.org')
    expect(dialog()).not.toBeNull()
    await tap('[data-mobile-browser-tab-cancel]')
    expect(address()).toBeNull()
    expect(dialog()).toBeNull()
    expect(api.browserView.navigate).not.toHaveBeenCalled()
  })

  it('TB-35 崩了的 agent 页：Reload 与 Go 不问，Close 问', async () => {
    await render({ tabs: [used({ crashed: true })] })
    await tap('[data-mobile-browser-tab-reload]')
    expect(dialog()).toBeNull()
    expect(api.browserView.reload.mock.calls).toEqual([['a']])
    await go('example.org')
    expect(dialog()).toBeNull()
    expect(api.browserView.navigate.mock.calls).toEqual([['a', 'https://example.org', 'typed']])
    await tap('[data-mobile-browser-tab-close]')
    expect(dialogAction()).toBe('close')
    expect(api.browserView.closeTab).not.toHaveBeenCalled()
  })

  it('TB-35 Stop 从来不问', async () => {
    await render({ tabs: [used({ loading: true })] })
    await tap('[data-mobile-browser-tab-stop]')
    expect(dialog()).toBeNull()
    expect(api.browserView.stop.mock.calls).toEqual([['a']])
  })

  it('TB-36 框开着，agent 不用了 → 框消失，什么都不调；又用上也不自己再弹', async () => {
    await render({ tabs: [used()] })
    await tap('[data-mobile-browser-tab-close]')
    expect(dialog()).not.toBeNull()
    await render({ tabs: [row()] })
    expect(dialog()).toBeNull()
    await render({ tabs: [used()] })
    expect(dialog()).toBeNull()
    expect(api.browserView.closeTab).not.toHaveBeenCalled()
    // 再点才问
    await tap('[data-mobile-browser-tab-close]')
    expect(dialogAction()).toBe('close')
  })

  it('TB-36 刷新框开着，页面崩了 → 框消失；恢复了也不自己再弹', async () => {
    await render({ tabs: [used()] })
    await tap('[data-mobile-browser-tab-reload]')
    expect(dialogAction()).toBe('reload')
    await render({ tabs: [used({ crashed: true })] })
    expect(dialog()).toBeNull()
    // 崩着时再点刷新：直接做
    await tap('[data-mobile-browser-tab-reload]')
    expect(api.browserView.reload).toHaveBeenCalledTimes(1)
    await render({ tabs: [used()] })
    expect(dialog()).toBeNull()
    expect(api.browserView.reload).toHaveBeenCalledTimes(1)
  })

  it('TB-36 关闭框开着，页面崩了（仍被用着）→ 框留着', async () => {
    await render({ tabs: [used()] })
    await tap('[data-mobile-browser-tab-close]')
    await render({ tabs: [used({ crashed: true })] })
    expect(dialogAction()).toBe('close')
  })
})
