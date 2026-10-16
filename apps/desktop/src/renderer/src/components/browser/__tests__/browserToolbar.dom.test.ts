// @vitest-environment jsdom
/**
 * 浏览器窗口的工具条（BrowserToolbar）—— 后退 / 前进 / 刷新、地址栏、视图切换、⋮ 菜单，一律作用于选中的那页。
 *
 *   CB-U40  未聚焦的地址栏：主机名与其余部分分开（其余变淡），https 一把锁、http 写 Not secure、file: 显示
 *           路径；空白页 / 没有 tab 时是占位文字，引擎名随 prop；
 *   CB-U41  mousedown 进编辑：完整地址、整段选中；Enter 照 Chrome 的判断打开（像域名补 https://、有空白
 *           按引擎搜索）；没选中任何 tab 时新开一个；空输入什么也不做；Esc 不导航、显示复原；输入法组字中
 *           的 Enter 什么也不做；
 *   CB-U42  requestOmniboxFocus() → 进编辑；挂载时 nonce 已经不是 0 不算；
 *   CB-U43  缩放标识只在不是 100% 的非空白页上出现，点它 → zoom(id, 'reset')；
 *   CB-U44  后退 / 前进按 canGoBack / canGoForward 禁用、点了调 goBack / goForward；加载中是停止按钮；
 *           空白页刷新禁用；视图切换回另一种视图；⋮ 弹原生菜单。
 *
 * store 直接灌；`window.api` 是 browserDomSupport 的假件；真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act } from 'react'
import { BrowserToolbar } from '../BrowserToolbar'
import {
  useBrowserTabsStore,
  type BrowserTabInfo,
  type BrowserViewMode
} from '../../../stores/browserTabsStore'
import type { SearchEngineId } from '../omnibox'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  installRaf,
  keyDown,
  mountInto,
  mouseDown,
  tabInfo,
  typeInto,
  type FakeApi,
  type Mounted
} from './browserDomSupport'

let api: FakeApi
let m: Mounted | null = null
let onViewMode: Mock<(mode: BrowserViewMode) => void>

function seed(tabs: BrowserTabInfo[], activeTabId: string | null): void {
  useBrowserTabsStore.setState({ tabs, activeTabId })
}

async function mount(
  props: { engine?: SearchEngineId; viewMode?: 'single' | 'wall' } = {}
): Promise<HTMLElement> {
  m = await mountInto(BrowserToolbar, {
    engine: props.engine ?? 'google',
    viewMode: props.viewMode ?? 'single',
    onViewMode
  })
  return m.container
}

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const display = (): HTMLElement | null => $('[data-omnibox-display]')
const input = (): HTMLInputElement | null => $<HTMLInputElement>('[data-omnibox-input]')

/** 点地址栏进编辑（mousedown + 等一帧让 input 挂上并选中） */
async function beginEdit(): Promise<HTMLInputElement> {
  mouseDown(display()!)
  await flush()
  const el = input()
  if (!el) throw new Error('omnibox did not enter edit mode')
  return el
}

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  installRaf()
  onViewMode = vi.fn<(mode: BrowserViewMode) => void>()
  useBrowserTabsStore.setState({ tabs: [], activeTabId: null, omniboxFocusNonce: 0 })
})

afterEach(() => {
  m?.unmount()
  m = null
})

describe('未聚焦的地址栏（CB-U40）', () => {
  it('CB-U40 https：主机名突出、其余变淡，一把锁', async () => {
    seed([tabInfo({ id: 't1', url: 'https://example.com/path?q=1' })], 't1')
    await mount()
    const d = display()!
    expect(d.getAttribute('data-omnibox-display')).toBe('https://example.com/path?q=1')
    const spans = [...d.querySelectorAll('span')].filter((s) => s.children.length === 0)
    const host = spans.find((s) => s.textContent === 'example.com')
    const rest = spans.find((s) => s.textContent === '/path?q=1')
    expect(host).toBeDefined()
    expect(rest).toBeDefined()
    expect(host!.className).toContain('text-text-primary')
    expect(rest!.className).toContain('text-text-tertiary')
    expect(d.querySelector('svg.lucide-lock')).not.toBeNull()
    expect(d.textContent).not.toContain('Not secure')
    expect(d.textContent).not.toContain('https://')
  })

  it('CB-U40 http：写着 Not secure，没有锁', async () => {
    seed([tabInfo({ id: 't1', url: 'http://plain.test/a' })], 't1')
    await mount()
    const d = display()!
    expect(d.textContent).toContain('Not secure')
    expect(d.textContent).toContain('plain.test')
    expect(d.querySelector('svg.lucide-lock')).toBeNull()
  })

  it('CB-U40 file:：显示解码后的路径', async () => {
    seed([tabInfo({ id: 't1', url: 'file:///Users/me/My%20Doc.html' })], 't1')
    await mount()
    expect(display()!.textContent).toContain('/Users/me/My Doc.html')
    expect(display()!.textContent).not.toContain('Not secure')
  })

  it.each([
    ['blank tab', [tabInfo({ id: 't1', url: 'about:blank' })], 't1'],
    ['no tab', [], null]
  ] as const)('CB-U40 %s：占位文字「Search Google or type a URL」', async (_l, tabs, active) => {
    seed([...tabs], active)
    await mount()
    expect(display()!.textContent).toBe('Search Google or type a URL')
    expect(display()!.getAttribute('data-omnibox-display')).toBe('')
  })

  it('CB-U40 占位文字里的引擎名随 prop', async () => {
    seed([], null)
    await mount({ engine: 'duckduckgo' })
    expect(display()!.textContent).toBe('Search DuckDuckGo or type a URL')
  })
})

describe('编辑地址栏（CB-U41）', () => {
  it('CB-U41 mousedown → input 拿到焦点，填着完整地址、整段选中', async () => {
    seed([tabInfo({ id: 't1', url: 'https://example.com/path?q=1' })], 't1')
    await mount()
    const el = await beginEdit()
    expect(display()).toBeNull()
    expect(el.value).toBe('https://example.com/path?q=1')
    expect(document.activeElement).toBe(el)
    expect(el.selectionStart).toBe(0)
    expect(el.selectionEnd).toBe(el.value.length)
  })

  it('CB-U41 Enter：example.org → navigate(tabId, https://example.org)，退出编辑', async () => {
    seed([tabInfo({ id: 't1', url: 'https://example.com/' })], 't1')
    await mount()
    const el = await beginEdit()
    typeInto(el, 'example.org')
    keyDown(el, 'Enter')
    expect(api.browserView.navigate.mock.calls).toEqual([['t1', 'https://example.org']])
    expect(api.browserView.createTab).not.toHaveBeenCalled()
    expect(input()).toBeNull()
  })

  it('CB-U41 Enter：hello world + bing → Bing 搜索地址', async () => {
    seed([tabInfo({ id: 't1', url: 'https://example.com/' })], 't1')
    await mount({ engine: 'bing' })
    const el = await beginEdit()
    typeInto(el, 'hello world')
    keyDown(el, 'Enter')
    expect(api.browserView.navigate.mock.calls).toEqual([
      ['t1', 'https://www.bing.com/search?q=hello%20world']
    ])
  })

  it('CB-U41 没有选中的 tab：Enter → createTab(目标地址)', async () => {
    seed([], null)
    await mount()
    const el = await beginEdit()
    expect(el.value).toBe('')
    typeInto(el, 'localhost:3000')
    keyDown(el, 'Enter')
    expect(api.browserView.createTab.mock.calls).toEqual([['http://localhost:3000']])
    expect(api.browserView.navigate).not.toHaveBeenCalled()
  })

  it('CB-U41 空输入（只有空白）：Enter 什么也不做', async () => {
    seed([tabInfo({ id: 't1', url: 'https://example.com/' })], 't1')
    await mount()
    const el = await beginEdit()
    typeInto(el, '   ')
    keyDown(el, 'Enter')
    expect(api.browserView.navigate).not.toHaveBeenCalled()
    expect(api.browserView.createTab).not.toHaveBeenCalled()
  })

  it('CB-U41 Esc：不导航，显示复原成原来的地址', async () => {
    seed([tabInfo({ id: 't1', url: 'https://example.com/a' })], 't1')
    await mount()
    const el = await beginEdit()
    typeInto(el, 'somewhere.else')
    keyDown(el, 'Escape')
    expect(api.browserView.navigate).not.toHaveBeenCalled()
    expect(input()).toBeNull()
    expect(display()?.getAttribute('data-omnibox-display')).toBe('https://example.com/a')
  })

  it('CB-U41 输入法组字中的 Enter：什么也不做、仍在编辑', async () => {
    seed([tabInfo({ id: 't1', url: 'https://example.com/' })], 't1')
    await mount()
    const el = await beginEdit()
    typeInto(el, 'example.org')
    keyDown(el, 'Enter', { isComposing: true })
    expect(api.browserView.navigate).not.toHaveBeenCalled()
    expect(input()).not.toBeNull()
  })
})

describe('请求聚焦（CB-U42）', () => {
  it('CB-U42 requestOmniboxFocus() → 进编辑、拿到焦点', async () => {
    seed([tabInfo({ id: 't1', url: 'https://example.com/' })], 't1')
    await mount()
    expect(input()).toBeNull()
    act(() => useBrowserTabsStore.getState().requestOmniboxFocus())
    await flush()
    expect(input()).not.toBeNull()
    expect(document.activeElement).toBe(input())
    expect(input()!.value).toBe('https://example.com/')
  })

  it('CB-U42 挂载时 nonce 已是 5：不进编辑', async () => {
    seed([tabInfo({ id: 't1', url: 'https://example.com/' })], 't1')
    useBrowserTabsStore.setState({ omniboxFocusNonce: 5 })
    await mount()
    await flush()
    expect(input()).toBeNull()
    expect(display()).not.toBeNull()
  })
})

describe('缩放标识（CB-U43）', () => {
  it('CB-U43 125% 的网页：显示 [data-browser-zoom="125"]，点它 → zoom(id, reset)', async () => {
    seed([tabInfo({ id: 't1', url: 'https://example.com/', zoomPercent: 125 })], 't1')
    await mount()
    const z = $('[data-browser-zoom]')
    expect(z?.getAttribute('data-browser-zoom')).toBe('125')
    expect(z?.textContent).toContain('125%')
    click(z!)
    expect(api.browserView.zoom.mock.calls).toEqual([['t1', 'reset']])
  })

  it.each([
    ['100%', tabInfo({ id: 't1', url: 'https://example.com/', zoomPercent: 100 })],
    ['blank page', tabInfo({ id: 't1', url: 'about:blank', zoomPercent: 125 })]
  ])('CB-U43 %s：没有缩放标识', async (_l, t) => {
    seed([t], 't1')
    await mount()
    expect($('[data-browser-zoom]')).toBeNull()
  })

  it('CB-U43 没有 tab：没有缩放标识', async () => {
    seed([], null)
    await mount()
    expect($('[data-browser-zoom]')).toBeNull()
  })
})

describe('按钮（CB-U44）', () => {
  const btn = (sel: string): HTMLButtonElement => {
    const b = $<HTMLButtonElement>(sel)
    if (!b) throw new Error(`no ${sel}`)
    return b
  }

  it('CB-U44 后退 / 前进按 canGoBack / canGoForward 禁用；能用时调 goBack / goForward(选中那页)', async () => {
    seed(
      [
        tabInfo({ id: 't0', url: 'https://other.test/', canGoBack: true, canGoForward: true }),
        tabInfo({ id: 't1', url: 'https://example.com/', canGoBack: true, canGoForward: false })
      ],
      't1'
    )
    await mount()
    expect(btn('[data-browser-back]').disabled).toBe(false)
    expect(btn('[data-browser-forward]').disabled).toBe(true)
    click(btn('[data-browser-back]'))
    expect(api.browserView.goBack.mock.calls).toEqual([['t1']])

    act(() =>
      useBrowserTabsStore.setState({
        tabs: [tabInfo({ id: 't1', url: 'https://example.com/', canGoForward: true })]
      })
    )
    expect(btn('[data-browser-back]').disabled).toBe(true)
    expect(btn('[data-browser-forward]').disabled).toBe(false)
    click(btn('[data-browser-forward]'))
    expect(api.browserView.goForward.mock.calls).toEqual([['t1']])
  })

  it('CB-U44 没有 tab：后退 / 前进 / 刷新都禁用', async () => {
    seed([], null)
    await mount()
    expect(btn('[data-browser-back]').disabled).toBe(true)
    expect(btn('[data-browser-forward]').disabled).toBe(true)
    expect(btn('[data-browser-reload]').disabled).toBe(true)
  })

  it('CB-U44 加载中：停止按钮（没有刷新按钮），点了 → stop(id)', async () => {
    seed([tabInfo({ id: 't1', url: 'https://example.com/', isLoading: true })], 't1')
    await mount()
    expect($('[data-browser-reload]')).toBeNull()
    click(btn('[data-browser-stop]'))
    expect(api.browserView.stop.mock.calls).toEqual([['t1']])
  })

  it('CB-U44 刷新：网页上可点 → reload(id)；空白页上禁用', async () => {
    seed([tabInfo({ id: 't1', url: 'https://example.com/' })], 't1')
    await mount()
    expect($('[data-browser-stop]')).toBeNull()
    click(btn('[data-browser-reload]'))
    expect(api.browserView.reload.mock.calls).toEqual([['t1']])

    act(() => useBrowserTabsStore.setState({ tabs: [tabInfo({ id: 't1', url: 'about:blank' })] }))
    expect(btn('[data-browser-reload]').disabled).toBe(true)
  })

  it.each([
    ['single', 'wall'],
    ['wall', 'single']
  ] as const)('CB-U44 视图切换：%s → onViewMode(%s)', async (mode, next) => {
    seed([], null)
    await mount({ viewMode: mode })
    const toggle = btn('[data-browser-view-toggle]')
    expect(toggle.getAttribute('data-browser-view-toggle')).toBe(mode)
    click(toggle)
    expect(onViewMode.mock.calls).toEqual([[next]])
  })

  it('CB-U44 ⋮ → 弹原生菜单（contextMenu.popup）', async () => {
    seed([tabInfo({ id: 't1', url: 'https://example.com/' })], 't1')
    await mount()
    click(btn('[data-browser-more]'))
    await flush()
    expect(api.contextMenu.popup).toHaveBeenCalledTimes(1)
  })
})
