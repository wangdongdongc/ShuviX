/**
 * browserViewService 把 tab 的事件接到历史记录上（history.ts）：哪次提交记成访问、记在谁头上（用户 / 哪个会话）、
 * 标题与图标、内部页面 shuvix://history。
 *
 *   BVH-1   createTab(url) → 用户的 link；带 transition:'typed' → 第一次访问 typed；带 openerSessionId:'s1' → s1
 *   BVH-2   noteAgentUse(tab, 's1') 之后用户的 tab 下一次提交记在 s1 头上；不存在的 tab id 什么也不记
 *   BVH-3   before-mouse-event 的 mouseDown：agent 的动作没在进行（agentOpInFlight 假）→ 用户；进行中 → 仍是 s1；
 *           mouseUp / mouseMove / mouseWheel 从不改
 *   BVH-4   before-input-event 的 keyDown：动作没在进行 → 用户；keyUp 什么也不做；进行中 → 仍是 agent
 *   BVH-5   navigateTab(t, url, 'typed') → typed、用户的（agent 动过也一样）；不给 transition → link、用户的；
 *           navigateTab(t, 'shuvix://history') → 不记，它那张 about:blank 占位的提交也不记；
 *           X → shuvix://history → X：第二次 X 是一次新的访问（不当刷新），记在用户头上
 *   BVH-6   did-navigate-in-page：主框架只改锚点 → 不记；hash 路由 → 记；子框架 → 不记
 *   BVH-7   主框架 did-fail-load（-105）清掉挂着的 typed；-3 与子框架的不清
 *   BVH-8   page-title-updated / page-favicon-updated → setTitle / setFavicon 记到最近记下的地址；图标取 favicons[0]
 *   BVH-9   弹出页（window.open handler，开它的 tab 没装防护）：页面自己弹的（agent 此刻没在动作）跟开它的那页
 *           记在同一方头上（s1 → s1、用户 → 用户），行上没有 openerSessionId；agent 正在动作时弹出的 → 那个会话
 *           （openerSessionId）
 *   BVH-10  closeTab 之后晚到的 page-title-updated 什么也不记
 *   BVH-11  openInternalPage('history') 单例；runShortcut({type:'history'}) 没有就开、有就选中；它是内部页面
 *           （isInternalTab、listTabs 的行 internalPage 'history'、url shuvix://history）
 *   BVH-12  快捷键的刷新 / 后退 / 前进是用户的动作：agent 动过的选中页，runShortcut 之后下一次提交记在用户头上；
 *           后退 / 前进只在真的能退 / 进时才记（canGoBack 假 → 仍是 agent 的）
 *
 * electron 是 ./fakeElectron.ts（loadURL 不发事件：导航事件由用例经 `wc.fire` 手工发）；agentGuards 是间谍
 * （agentActing / agentOpInFlight / hasAgentGuards 按用例拨的 tab 集合回答）；browserCdpService 是间谍；
 * browserViewService 与 history.ts 都是真的 —— resetModules 之后先导入 browserViewService，再导入 history 拿到
 * **同一份**模块实例、注入假的落盘处。没有打开浏览器窗口（弹出页走「窗口不在前台」那条路，开在后台）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeElectron, type FakeView } from './fakeElectron'

vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)

const state = vi.hoisted(() => ({
  /** agentActing 回 true 的 tab（动作进行中或宽限期里） */
  acting: new Set<string>(),
  /** agentOpInFlight 回 true 的 tab（动作正在进行） */
  inFlight: new Set<string>(),
  /** hasAgentGuards 回 true 的 tab */
  guarded: new Set<string>()
}))

// mock 路径按**测试文件**解析：被测模块在 services/browser/，测试在其 __tests__/ 下
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../../dao/settingsDao', () => ({
  settingsDao: { findByKey: () => undefined, upsert: () => {} }
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
}))
vi.mock('../../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../externalOpen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../externalOpen')>()),
  guardAppWindow: () => {}
}))
vi.mock('../agentGuards', () => ({
  installAgentGuards: vi.fn(async () => {}),
  uninstallAgentGuards: vi.fn(),
  hasAgentGuards: (tabId: string) => state.guarded.has(tabId),
  agentActing: (tabId: string) => state.acting.has(tabId),
  agentOpInFlight: (tabId: string) => state.inFlight.has(tabId)
}))
vi.mock('../browserCdpService', () => ({
  browserCdpManager: {
    session: vi.fn(async () => ({ enableDialogHandling: async () => {} })),
    handleExternalDetach: vi.fn(),
    detach: vi.fn(async () => {}),
    cdpState: () => ({ attached: false, intercepting: false }),
    detachAll: vi.fn(async () => {})
  }
}))

const fx = fakeElectron()

type ViewService = typeof import('../browserViewService')
type History = typeof import('../history')

interface Visit {
  url: string
  title: string
  visitedAt: number
  transition: string
  sessionId: string | null
}

let views: ViewService
let history: History
let visits: Visit[]
let titles: Array<[string, string]>
let favicons: Array<[string, string]>

beforeEach(async () => {
  vi.resetModules()
  fx.reset()
  state.acting.clear()
  state.inFlight.clear()
  state.guarded.clear()
  views = await import('../browserViewService')
  // 同一个模块注册表：拿到的就是 browserViewService 在用的那一份
  history = await import('../history')
  visits = []
  titles = []
  favicons = []
  history.setHistoryStore({
    addVisit: (v: Visit) => void visits.push(v),
    setTitle: (url: string, title: string) => void titles.push([url, title]),
    setFavicon: (url: string, icon: string) => void favicons.push([url, icon]),
    candidates: () => [],
    listGroups: () => [],
    removeGroup: () => {},
    removeUrl: () => {},
    clear: () => {},
    pruneBefore: () => {}
  } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  expect(fx.hiddenViews(), 'a tab view was setVisible(false)').toEqual([])
})

/** 建一个 tab，回它的 id 与 view */
function tab(
  url?: string,
  opts?: Parameters<ViewService['createTab']>[1]
): { id: string; view: FakeView } {
  const id = views.createTab(url, opts)
  return { id, view: fx.views[fx.views.length - 1] }
}

/** 主框架提交了一次导航 */
const navigated = (view: FakeView, url: string): void => {
  view.webContents.fire('did-navigate', {}, url)
}
const inPage = (view: FakeView, url: string, isMainFrame = true): void => {
  view.webContents.fire('did-navigate-in-page', {}, url, isMainFrame)
}
const mouse = (view: FakeView, type: string): void => {
  view.webContents.fire('before-mouse-event', {}, { type, x: 10, y: 10, button: 'left' })
}
const key = (view: FakeView, type: 'keyDown' | 'keyUp', k = 'a'): void => {
  view.webContents.fire(
    'before-input-event',
    { preventDefault: () => {} },
    {
      type,
      key: k,
      code: `Key${k.toUpperCase()}`,
      shift: false,
      control: false,
      alt: false,
      meta: false
    }
  )
}

/** 记下的访问：[地址, transition, sessionId] */
const recorded = (): Array<[string, string, string | null]> =>
  visits.map((v) => [v.url, v.transition, v.sessionId])
const lastVisit = (): [string, string, string | null] | undefined => recorded().at(-1)

describe('createTab 的第一次访问（BVH-1）', () => {
  it('BVH-1 createTab(url) → 用户的 link', () => {
    const t = tab('https://a.test/')
    navigated(t.view, 'https://a.test/')
    expect(recorded()).toEqual([['https://a.test/', 'link', null]])
  })

  it("BVH-1 transition:'typed' → 第一次访问 typed（之后的不是）", () => {
    const t = tab('https://a.test/', { activate: true, transition: 'typed' })
    navigated(t.view, 'https://a.test/')
    navigated(t.view, 'https://b.test/')
    expect(recorded()).toEqual([
      ['https://a.test/', 'typed', null],
      ['https://b.test/', 'link', null]
    ])
  })

  it("BVH-1 openerSessionId:'s1' → 记在 s1 头上", () => {
    const t = tab('https://a.test/', { openerSessionId: 's1' })
    navigated(t.view, 'https://a.test/')
    expect(recorded()).toEqual([['https://a.test/', 'link', 's1']])
  })
})

describe('agent 的工具调用（BVH-2）', () => {
  it('BVH-2 noteAgentUse 之后：用户的 tab 下一次提交记在 s1 头上', () => {
    const t = tab('https://a.test/')
    navigated(t.view, 'https://a.test/')
    views.noteAgentUse(t.id, 's1')
    navigated(t.view, 'https://b.test/')
    expect(recorded()).toEqual([
      ['https://a.test/', 'link', null],
      ['https://b.test/', 'link', 's1']
    ])
  })

  it('BVH-2 不存在的 tab id：什么也不记（那个 id 之后的提交仍是用户的）', () => {
    views.noteAgentUse('no-such-tab', 's1')
    history.historyNoteCommit('no-such-tab', 'https://a.test/', { sameDocument: false })
    expect(recorded()).toEqual([['https://a.test/', 'link', null]])
  })
})

describe('页面里真的鼠标（BVH-3）', () => {
  it('BVH-3 mouseDown、agent 的动作没在进行 → 之后的导航是用户的', () => {
    const t = tab('https://a.test/')
    views.noteAgentUse(t.id, 's1')
    mouse(t.view, 'mouseDown')
    navigated(t.view, 'https://b.test/')
    expect(lastVisit()).toEqual(['https://b.test/', 'link', null])
  })

  it('BVH-3 mouseDown、agent 的动作正在进行（CDP 发的鼠标）→ 仍是 s1', () => {
    const t = tab('https://a.test/')
    views.noteAgentUse(t.id, 's1')
    state.inFlight.add(t.id)
    mouse(t.view, 'mouseDown')
    navigated(t.view, 'https://b.test/')
    expect(lastVisit()).toEqual(['https://b.test/', 'link', 's1'])
  })

  it('BVH-3 宽限期里（agentActing 真、动作已经结束）的 mouseDown 是用户的', () => {
    const t = tab('https://a.test/')
    views.noteAgentUse(t.id, 's1')
    state.acting.add(t.id)
    mouse(t.view, 'mouseDown')
    navigated(t.view, 'https://b.test/')
    expect(lastVisit()).toEqual(['https://b.test/', 'link', null])
  })

  it.each(['mouseUp', 'mouseMove', 'mouseWheel', 'mouseEnter'])(
    'BVH-3 %s 从不改记在谁头上',
    (type) => {
      const t = tab('https://a.test/')
      views.noteAgentUse(t.id, 's1')
      mouse(t.view, type)
      navigated(t.view, 'https://b.test/')
      expect(lastVisit()).toEqual(['https://b.test/', 'link', 's1'])
    }
  )
})

describe('页面里真的按键（BVH-4）', () => {
  it('BVH-4 keyDown、动作没在进行 → 用户', () => {
    const t = tab('https://a.test/')
    views.noteAgentUse(t.id, 's1')
    key(t.view, 'keyDown')
    navigated(t.view, 'https://b.test/')
    expect(lastVisit()).toEqual(['https://b.test/', 'link', null])
  })

  it('BVH-4 keyUp 什么也不做', () => {
    const t = tab('https://a.test/')
    views.noteAgentUse(t.id, 's1')
    key(t.view, 'keyUp')
    navigated(t.view, 'https://b.test/')
    expect(lastVisit()).toEqual(['https://b.test/', 'link', 's1'])
  })

  it('BVH-4 keyDown、动作正在进行 → 仍是 agent', () => {
    const t = tab('https://a.test/')
    views.noteAgentUse(t.id, 's1')
    state.inFlight.add(t.id)
    key(t.view, 'keyDown', 'q')
    navigated(t.view, 'https://b.test/')
    expect(lastVisit()).toEqual(['https://b.test/', 'link', 's1'])
  })
})

describe('navigateTab（BVH-5）', () => {
  it("BVH-5 navigateTab(t, url, 'typed') → typed、用户的，agent 动过也一样", () => {
    const t = tab('https://a.test/')
    navigated(t.view, 'https://a.test/')
    views.noteAgentUse(t.id, 's1')
    views.navigateTab(t.id, 'https://b.test/', 'typed')
    expect(t.view.webContents.loaded.at(-1)).toBe('https://b.test/')
    navigated(t.view, 'https://b.test/')
    expect(lastVisit()).toEqual(['https://b.test/', 'typed', null])
  })

  it('BVH-5 不给 transition → link、用户的', () => {
    const t = tab('https://a.test/')
    views.noteAgentUse(t.id, 's1')
    views.navigateTab(t.id, 'https://b.test/')
    navigated(t.view, 'https://b.test/')
    expect(lastVisit()).toEqual(['https://b.test/', 'link', null])
  })

  it("BVH-5 navigateTab(t, 'shuvix://history')：不记；那张 about:blank 占位的提交也不记", () => {
    const t = tab('https://a.test/')
    navigated(t.view, 'https://a.test/')
    views.navigateTab(t.id, 'shuvix://history', 'typed')
    expect(t.view.webContents.loaded.at(-1)).toBe('about:blank')
    navigated(t.view, 'about:blank')
    inPage(t.view, 'about:blank#x')
    expect(recorded()).toEqual([['https://a.test/', 'link', null]])
    expect(views.isInternalTab(t.id)).toBe(true)
  })

  it('BVH-5 X → shuvix://history → X：第二次 X 是一次新的访问（不当刷新），记在用户头上', () => {
    const X = 'https://x.test/page'
    const t = tab(X)
    navigated(t.view, X)
    views.noteAgentUse(t.id, 's1')
    views.navigateTab(t.id, 'shuvix://history')
    navigated(t.view, 'about:blank')
    views.navigateTab(t.id, X)
    navigated(t.view, X)
    expect(recorded()).toEqual([
      [X, 'link', null],
      [X, 'link', null]
    ])
    expect(views.isInternalTab(t.id)).toBe(false)
  })
})

describe('页内导航（BVH-6）', () => {
  const DOC = 'https://docs.test/guide'

  it('BVH-6 主框架只改锚点 → 不记；hash 路由 → 记', () => {
    const t = tab(DOC)
    navigated(t.view, DOC)
    inPage(t.view, `${DOC}#install`)
    expect(recorded()).toEqual([[DOC, 'link', null]])
    inPage(t.view, `${DOC}#/settings`)
    expect(recorded()).toEqual([
      [DOC, 'link', null],
      [`${DOC}#/settings`, 'link', null]
    ])
  })

  it('BVH-6 子框架的页内导航 → 不记', () => {
    const t = tab(DOC)
    navigated(t.view, DOC)
    inPage(t.view, 'https://docs.test/other', false)
    expect(recorded()).toEqual([[DOC, 'link', null]])
  })
})

describe('加载失败（BVH-7）', () => {
  const failed = (view: FakeView, code: number, url: string, isMainFrame = true): void => {
    view.webContents.fire('did-fail-load', {}, code, 'ERR', url, isMainFrame)
  }

  it('BVH-7 主框架 -105：挂着的 typed 作废，随后的提交是 link', () => {
    const t = tab('https://a.test/')
    views.navigateTab(t.id, 'https://typo.invalid/', 'typed')
    failed(t.view, -105, 'https://typo.invalid/')
    navigated(t.view, 'https://b.test/')
    expect(recorded()).toEqual([['https://b.test/', 'link', null]])
  })

  it('BVH-7 -3（被新导航取代 / 用户停止）不清', () => {
    const t = tab('https://a.test/')
    views.navigateTab(t.id, 'https://b.test/', 'typed')
    failed(t.view, -3, 'https://b.test/')
    navigated(t.view, 'https://b.test/')
    expect(recorded()).toEqual([['https://b.test/', 'typed', null]])
  })

  it('BVH-7 子框架失败不清', () => {
    const t = tab('https://a.test/')
    views.navigateTab(t.id, 'https://b.test/', 'typed')
    failed(t.view, -105, 'https://ads.test/frame', false)
    navigated(t.view, 'https://b.test/')
    expect(recorded()).toEqual([['https://b.test/', 'typed', null]])
  })
})

describe('标题与图标（BVH-8）', () => {
  it('BVH-8 page-title-updated / page-favicon-updated → 记到最近记下的地址；图标取 favicons[0]', () => {
    const t = tab('https://a.test/')
    navigated(t.view, 'https://a.test/')
    t.view.webContents.fire('page-title-updated', {}, ' Alpha ')
    t.view.webContents.fire('page-favicon-updated', {}, [
      'https://a.test/icon-32.png',
      'https://a.test/icon-16.png'
    ])
    expect(titles).toEqual([['https://a.test/', 'Alpha']])
    expect(favicons).toEqual([['https://a.test/', 'https://a.test/icon-32.png']])
  })

  it('BVH-8 提交之前报上来的标题不记', () => {
    const t = tab('https://a.test/')
    t.view.webContents.fire('page-title-updated', {}, 'Early')
    t.view.webContents.fire('page-favicon-updated', {}, ['https://a.test/f.ico'])
    expect(titles).toEqual([])
    expect(favicons).toEqual([])
  })
})

describe('弹出页（BVH-9）', () => {
  /** 以这个 view 的名义 window.open(url)，回新 tab 的 id 与 view */
  function popup(opener: FakeView, url: string): { id: string; view: FakeView } {
    const handler = opener.webContents.openHandler
    if (!handler) throw new Error('createTab 没有登记 setWindowOpenHandler')
    expect(handler({ url })).toEqual({ action: 'deny' })
    const view = fx.views.at(-1)!
    expect(view).not.toBe(opener)
    const row = views.listTabs().at(-1)!
    return { id: row.id, view }
  }
  const rowOf = (id: string): ReturnType<ViewService['listTabs']>[number] | undefined =>
    views.listTabs().find((r) => r.id === id)

  it('BVH-9 用户的页面自己弹出的 → 用户的', () => {
    const opener = tab('https://o.test/')
    const p = popup(opener.view, 'https://p.test/')
    navigated(p.view, 'https://p.test/')
    expect(lastVisit()).toEqual(['https://p.test/', 'link', null])
    expect(rowOf(p.id)).not.toHaveProperty('openerSessionId')
  })

  it('BVH-9 agent 动过、此刻没在动作的页面自己弹出的 → 跟开它的那页记在 s1 头上；行上没有 openerSessionId', () => {
    const opener = tab('https://o.test/')
    views.noteAgentUse(opener.id, 's1')
    const p = popup(opener.view, 'https://p.test/')
    navigated(p.view, 'https://p.test/')
    expect(lastVisit()).toEqual(['https://p.test/', 'link', 's1'])
    expect(rowOf(p.id)).not.toHaveProperty('openerSessionId')
  })

  it('BVH-9 agent 正在那页上动作时弹出的 → 那个会话（openerSessionId）', () => {
    const opener = tab('https://o.test/')
    views.noteAgentUse(opener.id, 's2')
    state.acting.add(opener.id)
    const p = popup(opener.view, 'https://p.test/')
    navigated(p.view, 'https://p.test/')
    expect(lastVisit()).toEqual(['https://p.test/', 'link', 's2'])
    expect(rowOf(p.id)?.openerSessionId).toBe('s2')
  })

  it('BVH-9 开它的那页后来被用户点过：弹出页是用户的', () => {
    const opener = tab('https://o.test/')
    views.noteAgentUse(opener.id, 's1')
    mouse(opener.view, 'mouseDown')
    const p = popup(opener.view, 'https://p.test/')
    navigated(p.view, 'https://p.test/')
    expect(lastVisit()).toEqual(['https://p.test/', 'link', null])
  })
})

describe('关掉之后（BVH-10）', () => {
  it('BVH-10 closeTab 之后晚到的 page-title-updated / 图标什么也不记', () => {
    const t = tab('https://a.test/')
    navigated(t.view, 'https://a.test/')
    views.closeTab(t.id)
    t.view.webContents.fire('page-title-updated', {}, 'Late')
    t.view.webContents.fire('page-favicon-updated', {}, ['https://a.test/f.ico'])
    expect(titles).toEqual([])
    expect(favicons).toEqual([])
  })
})

describe('历史记录页 shuvix://history（BVH-11）', () => {
  const rowOf = (id: string): ReturnType<ViewService['listTabs']>[number] | undefined =>
    views.listTabs().find((r) => r.id === id)
  const selected = (): string | undefined => views.listTabs().find((r) => r.active)?.id

  it('BVH-11 openInternalPage(history)：内部页面、单例', () => {
    tab('https://a.test/', { activate: true })
    const h1 = views.openInternalPage('history')
    expect(views.isInternalTab(h1)).toBe(true)
    expect(rowOf(h1)).toMatchObject({
      url: 'shuvix://history',
      internalPage: 'history',
      active: true
    })
    expect(fx.views.at(-1)!.webContents.loaded).toEqual(['about:blank'])
    const count = views.listTabs().length
    expect(views.openInternalPage('history')).toBe(h1)
    expect(views.listTabs()).toHaveLength(count)
  })

  it('BVH-11 runShortcut({type:history})：没有就开一个并选中；有了就选中它', () => {
    const a = tab('https://a.test/', { activate: true })
    views.runShortcut({ type: 'history' })
    const h1 = views.listTabs().find((r) => r.internalPage === 'history')?.id
    expect(h1).toBeTruthy()
    expect(selected()).toBe(h1)

    views.activateTab(a.id)
    expect(selected()).toBe(a.id)
    views.runShortcut({ type: 'history' })
    expect(selected()).toBe(h1)
    expect(views.listTabs().filter((r) => r.internalPage === 'history')).toHaveLength(1)
  })

  it('BVH-11 设置页与历史记录页各是各的单例', () => {
    const s = views.openInternalPage('settings')
    const h1 = views.openInternalPage('history')
    expect(s).not.toBe(h1)
    expect(rowOf(s)?.internalPage).toBe('settings')
    expect(rowOf(h1)?.internalPage).toBe('history')
  })
})

describe('快捷键的刷新 / 后退 / 前进（BVH-12）', () => {
  /** 一个选中的、agent 动过的 tab */
  function agentSelected(): { id: string; view: FakeView } {
    const t = tab('https://a.test/', { activate: true })
    navigated(t.view, 'https://a.test/')
    views.noteAgentUse(t.id, 's1')
    return t
  }

  it('BVH-12 后退（能退）→ 之后的提交是用户的', () => {
    const t = agentSelected()
    t.view.webContents.canBack = true
    views.runShortcut({ type: 'back' })
    expect(t.view.webContents.navigationHistory.goBack).toHaveBeenCalledTimes(1)
    navigated(t.view, 'https://prev.test/')
    expect(lastVisit()).toEqual(['https://prev.test/', 'link', null])
  })

  it('BVH-12 后退（不能退）→ 不动，仍是 agent 的', () => {
    const t = agentSelected()
    t.view.webContents.canBack = false
    views.runShortcut({ type: 'back' })
    expect(t.view.webContents.navigationHistory.goBack).not.toHaveBeenCalled()
    navigated(t.view, 'https://next.test/')
    expect(lastVisit()).toEqual(['https://next.test/', 'link', 's1'])
  })

  it('BVH-12 前进：能进 → 用户的；不能进 → 仍是 agent 的', () => {
    const t = agentSelected()
    views.runShortcut({ type: 'forward' })
    navigated(t.view, 'https://n1.test/')
    expect(lastVisit()).toEqual(['https://n1.test/', 'link', 's1'])

    t.view.webContents.canForward = true
    views.runShortcut({ type: 'forward' })
    expect(t.view.webContents.navigationHistory.goForward).toHaveBeenCalledTimes(1)
    navigated(t.view, 'https://n2.test/')
    expect(lastVisit()).toEqual(['https://n2.test/', 'link', null])
  })

  it.each([false, true])('BVH-12 刷新（ignoreCache=%s）→ 之后的提交是用户的', (ignoreCache) => {
    const t = agentSelected()
    views.runShortcut({ type: 'reload', ignoreCache })
    const wc = t.view.webContents
    expect((ignoreCache ? wc.reloadIgnoringCache : wc.reload).mock.calls).toHaveLength(1)
    // 同一个地址再提交是刷新、不记；刷新之后页面自己跳去的地址记在用户头上
    navigated(t.view, 'https://a.test/')
    navigated(t.view, 'https://redirected.test/')
    expect(recorded()).toEqual([
      ['https://a.test/', 'link', null],
      ['https://redirected.test/', 'link', null]
    ])
  })

  it('BVH-12 快捷键只作用于选中的那页：没选中的 agent 页不受影响', () => {
    const other = tab('https://o.test/')
    navigated(other.view, 'https://o.test/')
    views.noteAgentUse(other.id, 's1')
    agentSelected()
    views.runShortcut({ type: 'reload', ignoreCache: false })
    navigated(other.view, 'https://o2.test/')
    expect(lastVisit()).toEqual(['https://o2.test/', 'link', 's1'])
  })
})
