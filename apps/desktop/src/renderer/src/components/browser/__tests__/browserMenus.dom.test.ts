// @vitest-environment jsdom
/**
 * 浏览器窗口的三份原生菜单（browserMenus.ts）：标签的右键菜单、工具条的 ⋮、标签条右端的「搜索标签页」。
 *
 *   CB-U45  标签菜单：项与顺序（含分隔符）；「在系统浏览器里打开」只对 http(s)；空白页上刷新 / 复制 / 复制链接
 *           禁用；没有可关的时「关闭其他 / 关闭右侧」禁用；
 *   CB-U46  标签菜单的动作：新标签页、刷新、复制标签（createTab(url)）、复制链接（剪贴板）、系统浏览器打开、
 *           关闭、关闭其他（除它以外全关）、关闭右侧（它后面的全关）；取消什么也不做；
 *   CB-U47  ⋮ 菜单：单页视图给「平铺」、平铺视图给「单页」；没有页面（没有 tab / 空白页）时缩放项禁用；
 *           100% 时「重置缩放」禁用、标签里写着当前百分比；动作：新标签页、重开、缩放三项、切视图、
 *           系统浏览器打开、设置（openSettings('mcp')）；
 *   CB-U48  搜索标签页：列出全部标签，选中的前面一个「✓ 」，接着 agent 的后面「 · 会话名」；选一个就选中它；
 *           没有 tab 不弹。
 *   MN-1    ⋮ 菜单的「历史记录」：有页面、空白页、没有 tab 都有（紧挨在设置前面，叫 History）；选它 →
 *           openInternal('history')，不碰设置页。
 *
 * 菜单经 `window.api.contextMenu.popup`（假件按用例钉好的 actionId 回答）；store 直接灌；真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from 'i18next'
import { showMoreMenu, showTabMenu, showTabSearchMenu } from '../browserMenus'
import { useBrowserTabsStore, type BrowserTabInfo } from '../../../stores/browserTabsStore'
import { initEnI18n, installFakeApi, lastMenu, tabInfo, type FakeApi } from './browserDomSupport'

let api: FakeApi
let writeText: ReturnType<typeof vi.fn>
const t = i18n.t.bind(i18n)

const A = tabInfo({ id: 'a', url: 'https://a.test/', title: 'Alpha page' })
const B = tabInfo({ id: 'b', url: 'http://b.test/x', title: 'Beta page' })
const C = tabInfo({ id: 'c', url: 'file:///tmp/c.html', title: '' })
const BLANK = tabInfo({ id: 'n', url: 'about:blank', title: '' })

function seed(tabs: BrowserTabInfo[], activeTabId: string | null = tabs[0]?.id ?? null): void {
  useBrowserTabsStore.setState({ tabs, activeTabId })
}

const ids = (items: Array<{ id: string }>): string[] => items.map((i) => i.id)
const item = (id: string): { id: string; label?: string; enabled?: boolean } => {
  const found = lastMenu(api).find((i) => i.id === id)
  if (!found) throw new Error(`no menu item ${id}`)
  return found
}
/** 未写 enabled 的项是可用的 */
const enabled = (id: string): boolean => item(id).enabled !== false

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true
  })
  useBrowserTabsStore.setState({ tabs: [], activeTabId: null, omniboxFocusNonce: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('标签的右键菜单：项（CB-U45）', () => {
  it('CB-U45 网页：newTab · 刷新 / 复制 / 复制链接 / 系统浏览器 · 关闭 / 关闭其他 / 关闭右侧（按这个顺序，含分隔符）', async () => {
    seed([A, B, C])
    await showTabMenu(B, t)
    expect(ids(lastMenu(api))).toEqual([
      'newTab',
      '---',
      'reload',
      'duplicate',
      'copyLink',
      'openExternal',
      '---',
      'close',
      'closeOthers',
      'closeRight'
    ])
    for (const id of ['reload', 'duplicate', 'copyLink', 'close', 'closeOthers', 'closeRight']) {
      expect(enabled(id), id).toBe(true)
    }
    expect(item('newTab').label).toBe('New tab')
    expect(item('closeRight').label).toBe('Close tabs to the right')
  })

  it('CB-U45 file: 页：没有「在系统浏览器里打开」', async () => {
    seed([A, C])
    await showTabMenu(C, t)
    expect(ids(lastMenu(api))).not.toContain('openExternal')
    expect(ids(lastMenu(api))).toEqual([
      'newTab',
      '---',
      'reload',
      'duplicate',
      'copyLink',
      '---',
      'close',
      'closeOthers',
      'closeRight'
    ])
  })

  it('CB-U45 空白页：刷新 / 复制标签 / 复制链接禁用，没有系统浏览器那一项', async () => {
    seed([A, BLANK])
    await showTabMenu(BLANK, t)
    expect(enabled('reload')).toBe(false)
    expect(enabled('duplicate')).toBe(false)
    expect(enabled('copyLink')).toBe(false)
    expect(ids(lastMenu(api))).not.toContain('openExternal')
    expect(enabled('close')).toBe(true)
  })

  it('CB-U45 只有它一个：关闭其他、关闭右侧都禁用；最右那个：只有关闭右侧禁用', async () => {
    seed([A])
    await showTabMenu(A, t)
    expect(enabled('closeOthers')).toBe(false)
    expect(enabled('closeRight')).toBe(false)

    seed([A, B, C])
    await showTabMenu(C, t)
    expect(enabled('closeOthers')).toBe(true)
    expect(enabled('closeRight')).toBe(false)
  })
})

describe('标签的右键菜单：动作（CB-U46）', () => {
  const pick = async (actionId: string | null, tab: BrowserTabInfo): Promise<void> => {
    api.menuPick = actionId
    await showTabMenu(tab, t)
  }

  it('CB-U46 newTab → createTab()；reload → reload(id)；close → closeTab(id)', async () => {
    seed([A, B, C])
    await pick('newTab', B)
    expect(api.browserView.createTab.mock.calls).toEqual([[undefined]])
    await pick('reload', B)
    expect(api.browserView.reload.mock.calls).toEqual([['b']])
    await pick('close', B)
    expect(api.browserView.closeTab.mock.calls).toEqual([['b']])
  })

  it('CB-U46 duplicate → createTab(它的地址)；copyLink → 剪贴板写它的地址', async () => {
    seed([A, B, C])
    await pick('duplicate', B)
    expect(api.browserView.createTab.mock.calls).toEqual([['http://b.test/x']])
    await pick('copyLink', B)
    expect(writeText.mock.calls).toEqual([['http://b.test/x']])
  })

  it('CB-U46 openExternal → app.openExternal(它的地址)', async () => {
    seed([A, B])
    await pick('openExternal', A)
    expect(api.app.openExternal.mock.calls).toEqual([['https://a.test/']])
  })

  it('CB-U46 closeOthers：除它以外全关；closeRight：只关它后面的', async () => {
    const D = tabInfo({ id: 'd', url: 'https://d.test/' })
    seed([A, B, C, D])
    await pick('closeOthers', B)
    expect(api.browserView.closeTab.mock.calls).toEqual([['a'], ['c'], ['d']])

    api.browserView.closeTab.mockClear()
    await pick('closeRight', B)
    expect(api.browserView.closeTab.mock.calls).toEqual([['c'], ['d']])
  })

  it('CB-U46 取消（没选）：什么也不做', async () => {
    seed([A, B])
    await pick(null, A)
    expect(api.browserView.createTab).not.toHaveBeenCalled()
    expect(api.browserView.closeTab).not.toHaveBeenCalled()
    expect(api.browserView.reload).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
    expect(api.app.openExternal).not.toHaveBeenCalled()
  })
})

describe('⋮ 菜单（CB-U47）', () => {
  const more = async (
    tab: BrowserTabInfo | null,
    viewMode: 'single' | 'wall',
    actionId: string | null = null
  ): Promise<ReturnType<typeof vi.fn>> => {
    const onViewMode = vi.fn()
    api.menuPick = actionId
    await showMoreMenu({ tab, viewMode, onViewMode, t })
    return onViewMode
  }

  it('CB-U47 单页视图：有 viewWall 没有 viewSingle；平铺视图反过来', async () => {
    seed([A])
    await more(A, 'single')
    expect(ids(lastMenu(api))).toContain('viewWall')
    expect(ids(lastMenu(api))).not.toContain('viewSingle')
    await more(A, 'wall')
    expect(ids(lastMenu(api))).toContain('viewSingle')
    expect(ids(lastMenu(api))).not.toContain('viewWall')
  })

  it('CB-U47 网页上的项与顺序；系统浏览器只对网页', async () => {
    seed([A])
    await more(A, 'single')
    expect(ids(lastMenu(api))).toEqual([
      'newTab',
      'reopen',
      '---',
      'zoomIn',
      'zoomOut',
      'zoomReset',
      '---',
      'viewWall',
      '---',
      'devtools',
      '---',
      'openExternal',
      'history',
      'settings'
    ])
    seed([C])
    await more(C, 'single')
    expect(ids(lastMenu(api))).not.toContain('openExternal')
  })

  it.each([
    ['没有 tab', null],
    ['空白页', BLANK]
  ] as const)('CB-U47 %s：三个缩放项都禁用', async (_l, tab) => {
    seed(tab ? [tab] : [])
    await more(tab, 'single')
    expect(enabled('zoomIn')).toBe(false)
    expect(enabled('zoomOut')).toBe(false)
    expect(enabled('zoomReset')).toBe(false)
    expect(ids(lastMenu(api))).not.toContain('openExternal')
  })

  it('CB-U47 100%：放大 / 缩小可用、重置禁用（标签写着 100%）；125%：重置可用、写着 125%', async () => {
    seed([A])
    await more(A, 'single')
    expect(enabled('zoomIn')).toBe(true)
    expect(enabled('zoomOut')).toBe(true)
    expect(enabled('zoomReset')).toBe(false)
    expect(item('zoomReset').label).toBe('Reset zoom (now 100%)')

    const zoomed = { ...A, zoomPercent: 125 }
    seed([zoomed])
    await more(zoomed, 'single')
    expect(enabled('zoomReset')).toBe(true)
    expect(item('zoomReset').label).toBe('Reset zoom (now 125%)')
  })

  it('CB-U47 动作：newTab / reopen / zoomIn / zoomOut / zoomReset / openExternal / settings', async () => {
    const zoomed = { ...A, zoomPercent: 125 }
    seed([zoomed])
    await more(zoomed, 'single', 'newTab')
    expect(api.browserView.createTab.mock.calls).toEqual([[undefined]])
    await more(zoomed, 'single', 'reopen')
    expect(api.browserView.reopenClosedTab).toHaveBeenCalledTimes(1)
    await more(zoomed, 'single', 'zoomIn')
    await more(zoomed, 'single', 'zoomOut')
    await more(zoomed, 'single', 'zoomReset')
    expect(api.browserView.zoom.mock.calls).toEqual([
      ['a', 'in'],
      ['a', 'out'],
      ['a', 'reset']
    ])
    await more(zoomed, 'single', 'openExternal')
    expect(api.app.openExternal.mock.calls).toEqual([['https://a.test/']])
    // ⋮ → 设置：打开浏览器自己的设置页（内部页面），不再去主设置窗口
    await more(zoomed, 'single', 'settings')
    expect(api.browserView.openInternal.mock.calls).toEqual([['settings']])
    expect(api.app.openSettings).not.toHaveBeenCalled()
  })

  it('CB-U47 viewWall / viewSingle → onViewMode', async () => {
    seed([A])
    expect((await more(A, 'single', 'viewWall')).mock.calls).toEqual([['wall']])
    expect((await more(A, 'wall', 'viewSingle')).mock.calls).toEqual([['single']])
  })
})

describe('⋮ 菜单的历史记录（MN-1）', () => {
  it.each([
    ['有页面', A],
    ['空白页', BLANK],
    ['没有 tab', null]
  ] as const)('MN-1 %s：有 History，紧挨在 Settings 前面', async (_l, tab) => {
    seed(tab ? [tab] : [])
    await showMoreMenu({ tab, viewMode: 'single', onViewMode: vi.fn(), t })
    const list = ids(lastMenu(api))
    expect(list.indexOf('history')).toBeGreaterThan(-1)
    expect(list.indexOf('settings')).toBe(list.indexOf('history') + 1)
    expect(item('history').label).toBe('History')
    expect(enabled('history')).toBe(true)
  })

  it("MN-1 选 History → openInternal('history')，不开设置页", async () => {
    seed([A])
    api.menuPick = 'history'
    await showMoreMenu({ tab: A, viewMode: 'single', onViewMode: vi.fn(), t })
    expect(api.browserView.openInternal.mock.calls).toEqual([['history']])
    expect(api.app.openSettings).not.toHaveBeenCalled()
    api.menuPick = 'history'
    await showMoreMenu({ tab: null, viewMode: 'wall', onViewMode: vi.fn(), t })
    expect(api.browserView.openInternal.mock.calls).toEqual([['history'], ['history']])
  })
})

describe('搜索标签页（CB-U48）', () => {
  it('CB-U48 列出全部标签：选中的前缀「✓ 」，接着 agent 的后缀「 · 会话名」；标题空的用主机名 / New Tab', async () => {
    const attached = {
      ...B,
      cdpAttached: true,
      agentSessionId: 's1',
      agentSessionTitle: 'Research'
    }
    const titledButDetached = { ...C, agentSessionId: 's2', agentSessionTitle: 'Old' }
    seed([A, attached, titledButDetached, BLANK], 'a')
    await showTabSearchMenu(t)
    expect(lastMenu(api).map((i) => [i.id, i.label])).toEqual([
      ['a', '✓ Alpha page'],
      ['b', 'Beta page · Research'],
      ['c', 'file:///tmp/c.html'],
      ['n', 'New Tab']
    ])
  })

  it('CB-U48 选一个 → activateTab(id)；取消什么也不做', async () => {
    seed([A, B], 'a')
    api.menuPick = 'b'
    await showTabSearchMenu(t)
    expect(api.browserView.activateTab.mock.calls).toEqual([['b']])
    api.browserView.activateTab.mockClear()
    await showTabSearchMenu(t)
    expect(api.browserView.activateTab).not.toHaveBeenCalled()
  })

  it('CB-U48 没有 tab：不弹', async () => {
    seed([], null)
    await showTabSearchMenu(t)
    expect(api.contextMenu.popup).not.toHaveBeenCalled()
  })
})
