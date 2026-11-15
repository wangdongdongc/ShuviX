// @vitest-environment jsdom
/**
 * Widget 面板的手机布局（`<WidgetPanel mobile />`，web 客户端）—— 一张分组卡片里的行，开着的应用的顶栏与「⋯」下拉菜单。
 *
 * 行（WM）
 *   WM-1  一张 [data-widget-rows] 里的行：每行同时带 data-widget-card=<id> 与 data-widget-row，按 store 的顺序
 *   WM-2  行里：名字 → 说明 → 项目标签；行尾一个时间与箭头
 *   WM-3  没有说明 → 没有 [data-widget-description]
 *   WM-4  行上没有 id、没有扳手图标
 *   WM-5  没有悬浮按钮（运行中的也没有）
 *   WM-6  运行中 → 行有 data-running 与一颗 [data-widget-running]（title / aria-label = mobile.widgetRunning）
 *   WM-7  服务没在跑（或没有 registeredIds）→ 没有圆点
 *   WM-8  圆点跟着 widget.changed 亮 / 灭
 *   WM-9  项目标签同桌面卡片：0 / 2 / 3 / 5 个
 *   WM-10 一分钟之内 →「刚刚」
 *   WM-11 一分钟的边界：59 999 ms →「刚刚」；60 000 ms → 时分
 *   WM-12 今天早些时候 → HH:MM
 *   WM-13 昨天 →「昨天」
 *   WM-14 一周之内 → 星期几
 *   WM-15 更早 → 月-日；不是今年 → 带年份
 *   WM-16 从没打开过 → 用创建时间；两样都有 → 上次打开的；两样都没有（都是 0）→「从未打开」
 *   WM-17 钟每 60 秒走一下：「刚刚」过一分钟变成时分
 *   WM-27 过了午夜：今天的时分变成「昨天」
 *   WM-28 那只钟是一个 60 秒的 interval，卸载时清掉
 *   WM-18 点一行就地打开（不开窗口）
 *   WM-19 点行里任何地方（名字 / 项目标签 / 时间）都打开
 *   WM-20 web 客户端不理会记住的「独立窗口」选择
 *   WM-21 launchTarget 回 'window' → focusWindow，不在面板里打开
 *   WM-22 长按菜单 = 卡片那份菜单去掉「在面板中打开」；运行中多一项「停止」
 *   WM-23 菜单的动作：开窗口 / 停止 / 归档 / 删除（确认框）
 *   WM-24 行菜单里的导出（web 客户端：导出到服务端再下载）
 *   WM-25 长按不打开小组件
 *   WM-26 空列表的提示；列表还没回来时没有行
 *
 * 顶栏与下拉菜单（WB）
 *   WB-1  顶栏三格：返回 / 名字 / 「⋯」
 *   WB-2  返回按钮没有文字
 *   WB-3  名字原样（含 & < "）
 *   WB-4  只有一颗「⋯」，没有桌面那两颗
 *   WB-5  返回回列表，应用留在后台（再打开还是同一个 frame 节点）
 *   WB-6  菜单（没在跑）：reload / popout / export
 *   WB-7  在跑才有 stop
 *   WB-8  两组
 *   WB-9  贴在按钮下面、右边对齐；开着时 aria-expanded=true
 *   WB-10 重新加载只动那一个 frame
 *   WB-11 在新标签页打开：开窗口、从面板收走、不写偏好
 *   WB-12 导出：成功 → 下载；失败 → 各个 code 的说明
 *   WB-13 停止
 *   WB-14 菜单属于按下按钮的那个应用
 *   WB-15 选一项就收起
 *   WB-16 点菜单外收起
 *   WB-17 Esc 收起
 *   WB-18 返回手势（popstate）收起
 *   WB-19 点菜单里不是项的地方不收
 *   WB-20 「停止」那一项跟着运行状态现变
 *   WB-21 小组件不在了菜单就收掉；它回来（哪怕再打开）也不再冒出来，要再按一次按钮
 *   WB-23 菜单开着时回列表 → 菜单收掉
 *   WB-22 开着几个应用：只有前台那个可见
 *
 * 桌面 vitest 对渲染层只收 `*.test.ts`（本文件自己切 jsdom），不带 react 插件 —— 一律 createElement。
 * `isWebHost` 定成 web 客户端；共享的右键菜单换成间谍（记下菜单项，用例钉了 pick 就回那一项）；WidgetFrame /
 * ConfirmDialog 换成带锚点的桩；下拉菜单（PullDownMenu）是真的。钟：只假 Date 与 setInterval / clearInterval
 * （`flush()` 走真的 setTimeout），挂载之前定在 NOW。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type FunctionComponent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { click, initEnI18n, stubRectsBy } from './browserDomSupport'

type MenuItem = { id: string; label: string; type?: string }

const menu = vi.hoisted(() => ({
  calls: [] as Array<Array<{ id: string; label: string; type?: string }>>,
  nextPick: null as string | null
}))
const downloadServerFile = vi.hoisted(() => vi.fn())

vi.mock('../../../host/hostMedia', () => ({ isWebHost: true }))
vi.mock('../../../host/serverDownload', () => ({ downloadServerFile }))
vi.mock('@shuvix/app-shell', async () => {
  const listTime = await vi.importActual<typeof import('@shuvix/app-shell/sidebar/listTime')>(
    '@shuvix/app-shell/sidebar/listTime'
  )
  return {
    listTimeLabel: listTime.listTimeLabel,
    useContextMenu:
      () =>
      async (
        _e: unknown,
        items: Array<{ id: string; label: string; type?: string }>,
        onAction: (id: string) => void
      ) => {
        menu.calls.push(items)
        const pick = menu.nextPick
        menu.nextPick = null
        if (pick) onAction(pick)
      }
  }
})
vi.mock('../../widget/WidgetFrame', async () => {
  const react = await import('react')
  return {
    WidgetFrame: (props: { widgetId: string; reloadNonce: number }) =>
      react.createElement('div', {
        'data-stub-frame': props.widgetId,
        'data-reload-nonce': String(props.reloadNonce)
      })
  }
})
vi.mock('../../common/ConfirmDialog', async () => {
  const react = await import('react')
  return {
    ConfirmDialog: (props: {
      title: string
      description?: string
      onConfirm: () => void
      onCancel: () => void
    }) =>
      react.createElement(
        'div',
        { 'data-stub-confirm': '' },
        react.createElement('div', { 'data-stub-title': '' }, props.title),
        react.createElement('div', { 'data-stub-description': '' }, props.description),
        react.createElement('button', { 'data-stub-ok': '', onClick: props.onConfirm }),
        react.createElement('button', { 'data-stub-cancel': '', onClick: props.onCancel })
      )
  }
})

import { WidgetPanel, type WidgetPanelProps } from '../WidgetPanel'
import { useWidgetStore } from '../../../stores/widgetStore'

// 组件的参数带缺省值（`= {}`），createElement 直接传 props 过不了类型检查
const Panel = WidgetPanel as FunctionComponent<WidgetPanelProps>

type AppEventCallback = (event: { type: string }) => void
type ExportResult =
  | { success: true; zipPath: string }
  | { success: false; code: string; error: string }

const api = {
  app: { platform: 'darwin' },
  widget: {
    list: vi.fn<() => Promise<WidgetSummary[]>>(),
    listArchived: vi.fn<() => Promise<WidgetSummary[]>>(),
    getServerStatus: vi.fn(),
    exportForDownload: vi.fn<(p: { id: string }) => Promise<ExportResult>>(),
    pickExportTarget: vi.fn(),
    exportAsVite: vi.fn(),
    revealExport: vi.fn(),
    stopWidget: vi.fn(async (_id: string) => ({ success: true })),
    setArchived: vi.fn(async (_p: { id: string; archived: boolean }) => ({ success: true })),
    delete: vi.fn(async (_id: string) => ({ success: true }))
  },
  widgetWindow: {
    status: vi.fn(),
    open: vi.fn(async (_id: string) => ({ success: true })),
    setPreferWindow: vi.fn(),
    close: vi.fn()
  },
  events: { subscribe: vi.fn<(cb: AppEventCallback) => () => void>() }
}

/** 本地时间的 2025-06-18（周三）15:30:00 —— 一律用本地时间的构造，用例不依赖时区 */
const NOW = new Date(2025, 5, 18, 15, 30, 0).getTime()
const at = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m, d, h, min).getTime()

let listed: WidgetSummary[] = []
let status: { running: boolean; registeredIds?: string[] } = { running: false, registeredIds: [] }
let subscribers: AppEventCallback[] = []
let container: HTMLDivElement
let root: Root
let mounted = false

/** 名字里不带 id（WM-4 要断行上没有 id） */
const NAMES: Record<string, string> = { a: 'Alpha board', b: 'Beta notes', c: 'Gamma timer' }

function widget(id: string, over: Partial<WidgetSummary> = {}): WidgetSummary {
  return {
    id,
    name: NAMES[id] ?? `Widget ${id.toUpperCase()}`,
    description: `About the ${NAMES[id] ?? 'thing'}`,
    createdAt: NOW - 3 * 3600_000,
    updatedAt: 1,
    lastOpenedAt: 0,
    archivedAt: 0,
    projectIds: (over.projects ?? []).map((p) => p.id),
    ...over
  }
}

const P = (id: string, name: string): { id: string; name: string } => ({ id, name })
const running = (...ids: string[]): typeof status => ({ running: true, registeredIds: ids })

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function settle(): Promise<void> {
  await flush()
  await flush()
  await flush()
}

async function mount(
  widgets: WidgetSummary[],
  props: WidgetPanelProps = { mobile: true }
): Promise<void> {
  listed = widgets
  await act(async () => {
    root.render(createElement(Panel, props))
  })
  mounted = true
  await settle()
}

function unmount(): void {
  if (!mounted) return
  act(() => root.unmount())
  mounted = false
}

async function fireChanged(): Promise<void> {
  await act(async () => {
    for (const cb of subscribers) cb({ type: 'widget.changed' })
  })
  await settle()
}

const q = <T extends HTMLElement = HTMLElement>(sel: string): T | null =>
  container.querySelector<T>(sel)
const row = (id: string): HTMLElement => {
  const el = q(`[data-widget-card="${id}"]`)
  if (!el) throw new Error(`no row ${id}`)
  return el
}
const timeOf = (id: string): string | null =>
  row(id).querySelector('[data-widget-time]')?.textContent ?? null
const list = (): HTMLElement => q('[data-widget-list]')!
const app = (id: string): HTMLElement | null => q(`[data-panel-app="${id}"]`)
const frame = (id: string): HTMLElement | null => q(`[data-stub-frame="${id}"]`)
const nonce = (id: string): string | null => frame(id)?.getAttribute('data-reload-nonce') ?? null
const menuButton = (id: string): HTMLElement =>
  app(id)!.querySelector<HTMLElement>('[data-app-menu]')!
const pulldown = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-mobile-pulldown]')
const pulldownIds = (): string[] =>
  [...(pulldown()?.querySelectorAll('[data-mobile-menu-item]') ?? [])].map(
    (el) => el.getAttribute('data-mobile-menu-item') ?? ''
  )
const pulldownLabel = (id: string): string | null =>
  pulldown()?.querySelector(`[data-mobile-menu-item="${id}"]`)?.textContent ?? null
const confirm = (): HTMLElement | null => q('[data-stub-confirm]')
const state = (): ReturnType<typeof useWidgetStore.getState> => useWidgetStore.getState()

function openApp(id: string): void {
  act(() => state().openInPanel(id))
}
function goHome(): void {
  act(() => state().goHome())
}
function openMenu(id: string): void {
  click(menuButton(id))
}
async function pick(itemId: string): Promise<void> {
  const item = pulldown()?.querySelector(`[data-mobile-menu-item="${itemId}"]`)
  if (!item) throw new Error(`no menu item ${itemId}`)
  click(item)
  await settle()
}

/** 长按（合成的 contextmenu）；pick 给了就让菜单回那一项 */
async function longPress(el: Element, pickId: string | null = null): Promise<MenuItem[]> {
  menu.nextPick = pickId
  act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await settle()
  const items = menu.calls.at(-1)
  if (!items) throw new Error('no context menu was requested')
  return items
}

beforeAll(async () => {
  await initEnI18n()
  ;(window as unknown as { api: unknown }).api = api
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  listed = []
  status = { running: false, registeredIds: [] }
  subscribers = []
  menu.calls = []
  menu.nextPick = null
  downloadServerFile.mockReset()
  api.widget.list.mockReset().mockImplementation(async () => listed)
  api.widget.listArchived.mockReset().mockResolvedValue([])
  api.widget.getServerStatus
    .mockReset()
    .mockImplementation(async () => ({ port: 0, widgetCount: 0, ...status }))
  api.widget.exportForDownload
    .mockReset()
    .mockResolvedValue({ success: true, zipPath: '/tmp/x.zip' })
  api.widget.pickExportTarget.mockReset()
  api.widget.exportAsVite.mockReset()
  api.widget.revealExport.mockReset()
  api.widget.stopWidget.mockClear()
  api.widget.setArchived.mockClear()
  api.widget.delete.mockClear()
  api.widgetWindow.status.mockReset().mockResolvedValue({ open: [], preferWindow: [] })
  api.widgetWindow.open.mockClear()
  api.widgetWindow.setPreferWindow.mockReset()
  api.widgetWindow.close.mockReset()
  api.events.subscribe.mockReset().mockImplementation((cb) => {
    subscribers.push(cb)
    return () => {
      subscribers = subscribers.filter((s) => s !== cb)
    }
  })
  useWidgetStore.setState(useWidgetStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = true
})

afterEach(() => {
  unmount()
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('WidgetPanel 手机布局：行', () => {
  it('WM-1 一张分组卡片里的行，按 store 的顺序', async () => {
    await mount([widget('b'), widget('a'), widget('c')])
    const groups = container.querySelectorAll('[data-widget-rows]')
    expect(groups).toHaveLength(1)
    expect(list().contains(groups[0])).toBe(true)
    const children = [...groups[0].children]
    expect(children).toHaveLength(3)
    expect(children.map((el) => el.getAttribute('data-widget-card'))).toEqual(['b', 'a', 'c'])
    for (const el of children) expect(el.hasAttribute('data-widget-row')).toBe(true)
    expect(container.querySelectorAll('[data-widget-card]')).toHaveLength(3)
  })

  it('WM-2 行的内容：名字 → 说明 → 项目标签；行尾时间与箭头', async () => {
    await mount([widget('a', { projects: [P('p1', 'Proj One')] })])
    const r = row('a')
    const name = r.querySelector('[data-widget-name]')!
    const description = r.querySelector('[data-widget-description]')!
    const projects = r.querySelector('[data-widget-projects]')!
    expect(name.textContent).toBe('Alpha board')
    expect(description.textContent).toBe('About the Alpha board')
    expect(r.querySelectorAll('[data-widget-time]')).toHaveLength(1)
    expect(r.querySelector('svg[class*="lucide-chevron-right"]')).not.toBeNull()
    const follows = (x: Element, y: Element): boolean =>
      Boolean(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(name, description)).toBe(true)
    expect(follows(description, projects)).toBe(true)
  })

  it('WM-3 没有说明 → 没有说明那一行', async () => {
    await mount([widget('a', { description: '' }), widget('b')])
    expect(row('a').querySelector('[data-widget-description]')).toBeNull()
    expect(row('b').querySelector('[data-widget-description]')).not.toBeNull()
  })

  it('WM-4 行上没有 id，也没有扳手图标', async () => {
    await mount([widget('zq-71x', { name: 'Ledger', description: 'Money in and out' })])
    const r = row('zq-71x')
    expect(r.textContent).not.toContain('zq-71x')
    expect(r.querySelector('svg[class*="lucide-wrench"]')).toBeNull()
  })

  it('WM-5 没有悬浮按钮，运行中的也没有', async () => {
    status = running('a')
    await mount([widget('a'), widget('b')])
    expect(row('a').hasAttribute('data-running')).toBe(true)
    for (const sel of ['[data-card-stop]', '[data-card-archive]', '[data-card-delete]']) {
      expect(q(sel), sel).toBeNull()
    }
  })

  it('WM-6 运行中的行：data-running 与一颗带说明的圆点；别的行都没有', async () => {
    status = running('a')
    await mount([widget('a'), widget('b')])
    expect(row('a').getAttribute('data-running')).toBe('')
    const dots = row('a').querySelectorAll<HTMLElement>('[data-widget-running]')
    expect(dots).toHaveLength(1)
    expect(dots[0].title).toBe(en.mobile.widgetRunning)
    expect(dots[0].getAttribute('aria-label')).toBe(en.mobile.widgetRunning)
    expect(row('b').hasAttribute('data-running')).toBe(false)
    expect(row('b').querySelector('[data-widget-running]')).toBeNull()
  })

  it('WM-7 服务没在跑 → 没有圆点（registeredIds 里有它也一样）', async () => {
    status = { running: false, registeredIds: ['a'] }
    await mount([widget('a')])
    expect(q('[data-widget-running]')).toBeNull()
    expect(row('a').hasAttribute('data-running')).toBe(false)
  })

  it('WM-7b 在跑但没有 registeredIds → 没有圆点，也不抛', async () => {
    status = { running: true }
    await mount([widget('a')])
    expect(q('[data-widget-running]')).toBeNull()
    expect(row('a').hasAttribute('data-running')).toBe(false)
  })

  it('WM-8 圆点跟着 widget.changed 亮起来、再灭掉', async () => {
    await mount([widget('a')])
    expect(q('[data-widget-running]')).toBeNull()

    status = running('a')
    await fireChanged()
    expect(row('a').querySelector('[data-widget-running]')).not.toBeNull()
    expect(row('a').hasAttribute('data-running')).toBe(true)

    status = { running: false, registeredIds: [] }
    await fireChanged()
    expect(q('[data-widget-running]')).toBeNull()
    expect(row('a').hasAttribute('data-running')).toBe(false)
  })

  it('WM-9 项目标签同桌面卡片：0 / 2 / 3 / 5 个', async () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map((n) => P(`id-${n}`, n))
    await mount([
      widget('none'),
      widget('two', { projects: [P('p2', 'Beta'), P('p1', 'Alpha')] }),
      widget('three', { projects: five.slice(0, 3) }),
      widget('five', { projects: five })
    ])
    const tagIds = (id: string): string[] =>
      [...row(id).querySelectorAll('[data-widget-project]')].map(
        (el) => el.getAttribute('data-widget-project') ?? ''
      )
    expect(row('none').querySelector('[data-widget-projects]')).toBeNull()
    expect(tagIds('two')).toEqual(['p2', 'p1'])
    expect(row('two').querySelector('[data-widget-projects-more]')).toBeNull()
    expect(tagIds('three')).toEqual(['id-A', 'id-B', 'id-C'])
    expect(row('three').querySelector('[data-widget-projects-more]')).toBeNull()
    expect(tagIds('five')).toEqual(['id-A', 'id-B', 'id-C'])
    expect(row('five').querySelector('[data-widget-projects-more]')?.textContent).toBe('+2')
    expect(row('five').querySelector<HTMLElement>('[data-widget-projects]')!.title).toBe(
      i18n.t('widgets.usedInProjects', { names: 'A, B, C, D, E' })
    )
  })

  it('WM-10 一分钟之内 →「刚刚」', async () => {
    await mount([widget('a', { lastOpenedAt: NOW - 30_000 })])
    expect(timeOf('a')).toBe(en.widgets.justNow)
  })

  it('WM-11 一分钟的边界：59 999 ms 还是「刚刚」，60 000 ms 是时分', async () => {
    await mount([
      widget('a', { lastOpenedAt: NOW - 59_999 }),
      widget('b', { lastOpenedAt: NOW - 60_000 })
    ])
    expect(timeOf('a')).toBe(en.widgets.justNow)
    expect(timeOf('b')).toBe('15:29')
  })

  it('WM-12 今天早些时候 → HH:MM', async () => {
    await mount([widget('a', { lastOpenedAt: at(2025, 5, 18, 9, 5) })])
    expect(timeOf('a')).toBe('09:05')
  })

  it('WM-13 昨天 →「昨天」', async () => {
    await mount([widget('a', { lastOpenedAt: at(2025, 5, 17, 23, 59) })])
    expect(timeOf('a')).toBe(en.mobile.yesterday)
  })

  it('WM-14 一周之内 → 星期几', async () => {
    const weekday = (ts: number): string =>
      new Intl.DateTimeFormat('en', { weekday: 'short' }).format(new Date(ts))
    const three = at(2025, 5, 15, 10, 0)
    const six = at(2025, 5, 12)
    await mount([widget('a', { lastOpenedAt: three }), widget('b', { lastOpenedAt: six })])
    expect(timeOf('a')).toBe(weekday(three))
    expect(timeOf('b')).toBe(weekday(six))
    expect(timeOf('a')).not.toBe(timeOf('b'))
  })

  it('WM-15 更早 → 月-日；不是今年 → 带年份', async () => {
    await mount([
      widget('a', { lastOpenedAt: at(2025, 5, 11, 10, 0) }),
      widget('b', { lastOpenedAt: at(2024, 11, 25) })
    ])
    expect(timeOf('a')).toBe('06-11')
    expect(timeOf('b')).toBe('2024-12-25')
  })

  it('WM-16 从没打开过 → 创建时间；两样都有 → 上次打开的；都没有 →「从未打开」', async () => {
    await mount([
      widget('a', { lastOpenedAt: 0, createdAt: at(2025, 5, 17, 8, 0) }),
      widget('b', { lastOpenedAt: at(2025, 5, 18, 9, 5), createdAt: at(2025, 5, 17, 8, 0) }),
      widget('c', { lastOpenedAt: 0, createdAt: 0 })
    ])
    expect(timeOf('a')).toBe(en.mobile.yesterday)
    expect(timeOf('b')).toBe('09:05')
    expect(timeOf('c')).toBe(en.widgets.never)
    expect(row('c').textContent).not.toContain('1970')
  })

  it('WM-17 钟每 60 秒走一下：「刚刚」过一分钟变成时分', async () => {
    await mount([widget('a', { lastOpenedAt: NOW - 30_000 })])
    expect(timeOf('a')).toBe(en.widgets.justNow)

    // 还没到一分钟：不重算
    act(() => {
      vi.advanceTimersByTime(59_000)
    })
    expect(timeOf('a')).toBe(en.widgets.justNow)

    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(timeOf('a')).toBe('15:29')
  })

  it('WM-27 过了午夜：今天的时分变成「昨天」', async () => {
    vi.setSystemTime(new Date(2025, 5, 18, 23, 59, 30))
    await mount([widget('a', { lastOpenedAt: at(2025, 5, 18, 10, 0) })])
    expect(timeOf('a')).toBe('10:00')
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(timeOf('a')).toBe(en.mobile.yesterday)
  })

  it('WM-28 那只钟是一个 60 秒的 interval，卸载时清掉', async () => {
    const set = vi.spyOn(window, 'setInterval')
    await mount([widget('a')])
    expect(set.mock.calls.filter((c) => c[1] === 60_000)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('WM-18 点一行就地打开，不开窗口', async () => {
    await mount([widget('a'), widget('b')])
    expect(list().style.visibility).toBe('')
    click(row('a'))
    await settle()

    expect(state().foregroundApp).toBe('a')
    expect(state().panelApps).toEqual(['a'])
    expect(app('a')!.hasAttribute('data-foreground')).toBe(true)
    expect(list().style.visibility).toBe('hidden')
    expect(api.widgetWindow.open).not.toHaveBeenCalled()
  })

  it('WM-19 点行里任何地方都打开：名字 / 项目标签 / 时间', async () => {
    await mount([widget('a', { projects: [P('p1', 'Proj One')] })])
    for (const sel of ['[data-widget-name]', '[data-widget-project="p1"]', '[data-widget-time]']) {
      click(row('a').querySelector(sel)!)
      expect(state().foregroundApp, sel).toBe('a')
      goHome()
      expect(state().foregroundApp).toBeNull()
    }
    expect(api.widgetWindow.open).not.toHaveBeenCalled()
  })

  it('WM-20 web 客户端不理会记住的「独立窗口」选择：照样就地打开', async () => {
    api.widgetWindow.status.mockResolvedValue({ open: [], preferWindow: ['a'] })
    await mount([widget('a')])
    expect(state().preferWindow).toEqual(['a'])
    click(row('a'))
    await settle()
    expect(state().foregroundApp).toBe('a')
    expect(app('a')!.hasAttribute('data-foreground')).toBe(true)
    expect(api.widgetWindow.open).not.toHaveBeenCalled()
  })

  it("WM-21 launchTarget 回 'window' → focusWindow 一次，不在面板里打开", async () => {
    const focusWindow = vi.fn(async (_id: string) => ({ success: true }))
    await mount([widget('a')])
    act(() => useWidgetStore.setState({ launchTarget: () => 'window', focusWindow }))
    click(row('a'))
    await settle()
    expect(focusWindow).toHaveBeenCalledTimes(1)
    expect(focusWindow).toHaveBeenCalledWith('a')
    expect(state().foregroundApp).toBeNull()
    expect(app('a')).toBeNull()
  })

  it('WM-22 长按菜单 = 卡片那份去掉「在面板中打开」；运行中多一项「停止」', async () => {
    status = running('b')
    await mount([widget('a'), widget('b')])

    const idle = await longPress(row('a'))
    expect(idle.map((i) => i.id)).toEqual([
      'openWindow',
      'sep1',
      'export',
      'archive',
      'sep2',
      'delete'
    ])
    const label = (items: MenuItem[], id: string): string | undefined =>
      items.find((i) => i.id === id)?.label
    expect(label(idle, 'openWindow')).toBe(en.widgets.openInWindow)
    expect(label(idle, 'export')).toBe(en.widgets.exportAsVite)
    expect(label(idle, 'archive')).toBe(en.widgets.archive)
    expect(label(idle, 'delete')).toBe(en.widgets.delete)
    expect(idle.filter((i) => i.type === 'separator').map((i) => i.id)).toEqual(['sep1', 'sep2'])
    expect(idle.some((i) => i.label === en.widgets.openInPanel)).toBe(false)

    const live = await longPress(row('b'))
    expect(live.map((i) => i.id)).toEqual([
      'openWindow',
      'stop',
      'sep1',
      'export',
      'archive',
      'sep2',
      'delete'
    ])
    expect(label(live, 'stop')).toBe(en.widgets.stop)
  })

  it('WM-23 菜单：开窗口 → widgetWindow.open，不写偏好', async () => {
    await mount([widget('a')])
    await longPress(row('a'), 'openWindow')
    expect(api.widgetWindow.open).toHaveBeenCalledTimes(1)
    expect(api.widgetWindow.open).toHaveBeenCalledWith('a')
    expect(api.widgetWindow.setPreferWindow).not.toHaveBeenCalled()
  })

  it('WM-23 菜单：停止 → widget.stopWidget', async () => {
    status = running('a')
    await mount([widget('a')])
    await longPress(row('a'), 'stop')
    expect(api.widget.stopWidget).toHaveBeenCalledTimes(1)
    expect(api.widget.stopWidget).toHaveBeenCalledWith('a')
  })

  it('WM-23 菜单：归档 → widget.setArchived({id, archived: true})', async () => {
    await mount([widget('a')])
    await longPress(row('a'), 'archive')
    expect(api.widget.setArchived).toHaveBeenCalledTimes(1)
    expect(api.widget.setArchived).toHaveBeenCalledWith({ id: 'a', archived: true })
  })

  it('WM-23 菜单：删除 → 确认框（标题与名字）；确认才删，取消不删', async () => {
    await mount([widget('a')])
    await longPress(row('a'), 'delete')
    expect(confirm()).not.toBeNull()
    expect(confirm()!.querySelector('[data-stub-title]')!.textContent).toBe(
      en.widgets.confirmDeleteTitle
    )
    expect(confirm()!.querySelector('[data-stub-description]')!.textContent).toBe(
      i18n.t('widgets.confirmDeleteDescription', { name: 'Alpha board' })
    )
    expect(api.widget.delete).not.toHaveBeenCalled()

    click(confirm()!.querySelector('[data-stub-cancel]')!)
    await settle()
    expect(confirm()).toBeNull()
    expect(api.widget.delete).not.toHaveBeenCalled()

    await longPress(row('a'), 'delete')
    click(confirm()!.querySelector('[data-stub-ok]')!)
    await settle()
    expect(api.widget.delete).toHaveBeenCalledTimes(1)
    expect(api.widget.delete).toHaveBeenCalledWith('a')
    expect(confirm()).toBeNull()
  })

  it('WM-24 行菜单里的导出：导出到服务端再下载，不弹框、不走保存框', async () => {
    api.widget.exportForDownload.mockResolvedValue({ success: true, zipPath: '/srv/out/a.zip' })
    await mount([widget('a')])
    await longPress(row('a'), 'export')
    expect(api.widget.exportForDownload).toHaveBeenCalledTimes(1)
    expect(api.widget.exportForDownload).toHaveBeenCalledWith({ id: 'a' })
    expect(downloadServerFile).toHaveBeenCalledTimes(1)
    expect(downloadServerFile).toHaveBeenCalledWith('/srv/out/a.zip')
    expect(confirm()).toBeNull()
    expect(api.widget.pickExportTarget).not.toHaveBeenCalled()
    expect(api.widget.exportAsVite).not.toHaveBeenCalled()
  })

  it('WM-25 长按不打开小组件', async () => {
    await mount([widget('a')])
    const items = await longPress(row('a'))
    expect(items.length).toBeGreaterThan(0)
    expect(state().foregroundApp).toBeNull()
    expect(state().panelApps).toEqual([])
    expect(app('a')).toBeNull()
  })

  it('WM-26 没有小组件 → 空列表的提示，没有分组卡片', async () => {
    await mount([])
    expect(list().textContent).toContain(en.widgets.panelEmptyHint)
    expect(q('[data-widget-rows]')).toBeNull()
    expect(q('[data-widget-card]')).toBeNull()
  })

  it('WM-26 列表还没回来 → 没有行，也没有空列表的提示', async () => {
    api.widget.list.mockImplementation(() => new Promise<WidgetSummary[]>(() => {}))
    await mount([widget('a')])
    expect(q('[data-widget-card]')).toBeNull()
    expect(q('[data-widget-rows]')).toBeNull()
    expect(list().textContent).not.toContain(en.widgets.panelEmptyHint)
  })
})

describe('WidgetPanel 手机布局：开着的应用的顶栏与下拉菜单', () => {
  it('WB-1 顶栏三格：返回 / 名字 / 「⋯」', async () => {
    await mount([widget('a')])
    openApp('a')
    const bar = app('a')!.querySelector('[data-app-bar]')!
    const cells = [...bar.children]
    expect(cells).toHaveLength(3)
    expect(cells[0].querySelector('[data-app-back]')).not.toBeNull()
    expect(cells[1].hasAttribute('data-app-name')).toBe(true)
    expect(cells[2].querySelector('[data-app-menu]')).not.toBeNull()
  })

  it('WB-2 返回按钮没有文字，只有说明', async () => {
    await mount([widget('a')])
    openApp('a')
    const back = app('a')!.querySelector<HTMLElement>('[data-app-back]')!
    expect(back.textContent).toBe('')
    expect(back.getAttribute('aria-label')).toBe(en.widgets.backToHome)
    expect(back.title).toBe(en.widgets.backToHome)
    expect(back.querySelector('[data-app-name]')).toBeNull()
  })

  it('WB-3 名字原样，含 & < "', async () => {
    const odd = 'R&D <"core">'
    await mount([widget('a'), widget('b', { name: odd })])
    openApp('a')
    expect(app('a')!.querySelector('[data-app-name]')!.textContent).toBe('Alpha board')
    openApp('b')
    expect(app('b')!.querySelector('[data-app-name]')!.textContent).toBe(odd)
  })

  it('WB-4 只有一颗「⋯」，没有桌面的重新加载 / 独立窗口两颗', async () => {
    await mount([widget('a')])
    openApp('a')
    const buttons = app('a')!.querySelectorAll('[data-app-menu]')
    expect(buttons).toHaveLength(1)
    const button = buttons[0]
    expect(button.getAttribute('aria-label')).toBe(en.mobile.moreActions)
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(q('[data-app-reload]')).toBeNull()
    expect(q('[data-app-popout]')).toBeNull()
  })

  it('WB-5 返回回列表，应用留在后台；再打开还是同一个 frame 节点', async () => {
    await mount([widget('a')])
    click(row('a'))
    const before = frame('a')
    expect(before).not.toBeNull()

    click(app('a')!.querySelector('[data-app-back]')!)
    expect(state().foregroundApp).toBeNull()
    expect(state().panelApps).toEqual(['a'])
    expect(app('a')).not.toBeNull()
    expect(app('a')!.hasAttribute('data-foreground')).toBe(false)
    expect(app('a')!.style.visibility).toBe('hidden')
    expect(list().style.visibility).toBe('')

    click(row('a'))
    expect(app('a')!.hasAttribute('data-foreground')).toBe(true)
    expect(frame('a')).toBe(before)
  })

  it('WB-6 菜单（没在跑）：重新加载 / 在新标签页打开 / 导出', async () => {
    await mount([widget('a')])
    openApp('a')
    expect(pulldown()).toBeNull()
    openMenu('a')
    expect(pulldown()).not.toBeNull()
    expect(document.body.contains(pulldown())).toBe(true)
    expect(pulldownIds()).toEqual(['reload', 'popout', 'export'])
    expect(pulldownLabel('reload')).toBe(en.widgets.windowReload)
    expect(pulldownLabel('popout')).toBe(en.mobile.widgetOpenTab)
    expect(pulldownLabel('export')).toBe(en.mobile.widgetExport)
  })

  it('WB-7 在跑才有「停止」，排在最后', async () => {
    status = running('a')
    await mount([widget('a')])
    openApp('a')
    openMenu('a')
    expect(pulldownIds()).toEqual(['reload', 'popout', 'export', 'stop'])
    expect(pulldownLabel('stop')).toBe(en.widgets.stop)
  })

  it('WB-8 两组：{reload, popout} 与 {export[, stop]}', async () => {
    status = running('a')
    await mount([widget('a'), widget('b')])
    const groupsOf = (): string[][] =>
      [...pulldown()!.children].map((group) =>
        [...group.querySelectorAll('[data-mobile-menu-item]')].map(
          (el) => el.getAttribute('data-mobile-menu-item') ?? ''
        )
      )
    openApp('a')
    openMenu('a')
    expect(groupsOf()).toEqual([
      ['reload', 'popout'],
      ['export', 'stop']
    ])
    await pick('reload')

    openApp('b')
    openMenu('b')
    expect(groupsOf()).toEqual([['reload', 'popout'], ['export']])
  })

  it('WB-9 贴在按钮下面、右边与按钮对齐；开着时 aria-expanded=true', async () => {
    stubRectsBy((el) =>
      el.hasAttribute('data-app-menu')
        ? { x: 340, y: 4, width: 40, height: 40 }
        : { x: 0, y: 0, width: 0, height: 0 }
    )
    await mount([widget('a')])
    openApp('a')
    openMenu('a')
    expect(pulldown()!.style.top).toBe('50px')
    expect(pulldown()!.style.right).toBe(`${window.innerWidth - 380}px`)
    expect(menuButton('a').getAttribute('aria-expanded')).toBe('true')
  })

  it('WB-10 重新加载只动那一个 frame', async () => {
    await mount([widget('a'), widget('b')])
    openApp('a')
    openApp('b')
    expect(nonce('a')).toBe('0')
    expect(nonce('b')).toBe('0')

    openMenu('b')
    await pick('reload')
    expect(nonce('b')).toBe('1')
    expect(nonce('a')).toBe('0')
    expect(pulldown()).toBeNull()

    openMenu('b')
    await pick('reload')
    expect(nonce('b')).toBe('2')
    expect(nonce('a')).toBe('0')
  })

  it('WB-11 在新标签页打开：开窗口、从面板收走、不写偏好', async () => {
    await mount([widget('a')])
    openApp('a')
    openMenu('a')
    await pick('popout')
    expect(api.widgetWindow.open).toHaveBeenCalledTimes(1)
    expect(api.widgetWindow.open).toHaveBeenCalledWith('a')
    expect(api.widgetWindow.setPreferWindow).not.toHaveBeenCalled()
    expect(state().panelApps).toEqual([])
    expect(state().foregroundApp).toBeNull()
    expect(app('a')).toBeNull()
    expect(list().style.visibility).toBe('')
  })

  it('WB-12 导出成功 → 下载那个 zip，不弹框', async () => {
    api.widget.exportForDownload.mockResolvedValue({ success: true, zipPath: '/srv/out/a.zip' })
    await mount([widget('a')])
    openApp('a')
    openMenu('a')
    await pick('export')
    expect(api.widget.exportForDownload).toHaveBeenCalledWith({ id: 'a' })
    expect(downloadServerFile).toHaveBeenCalledTimes(1)
    expect(downloadServerFile).toHaveBeenCalledWith('/srv/out/a.zip')
    expect(confirm()).toBeNull()
    expect(api.widget.pickExportTarget).not.toHaveBeenCalled()
    expect(api.widget.exportAsVite).not.toHaveBeenCalled()
  })

  it.each([
    ['WIDGET_NOT_FOUND', 'raw', () => en.widgets.exportErrorWidgetNotFound],
    ['PACK_FAILED', 'boom', () => i18n.t('widgets.exportErrorPackFailed', { reason: 'boom' })],
    ['TARGET_EXISTS', 'raw', () => en.widgets.exportErrorTargetExists],
    ['INVALID_PATH', 'raw', () => en.widgets.exportErrorInvalidPath],
    ['SOMETHING_ELSE', 'the raw error text', () => 'the raw error text']
  ])('WB-12 导出失败 %s → 失败框写着名字与原因', async (code, error, reason) => {
    api.widget.exportForDownload.mockResolvedValue({ success: false, code, error })
    await mount([widget('a')])
    openApp('a')
    openMenu('a')
    await pick('export')

    expect(downloadServerFile).not.toHaveBeenCalled()
    expect(confirm()).not.toBeNull()
    expect(confirm()!.querySelector('[data-stub-title]')!.textContent).toBe(
      en.widgets.exportFailedTitle
    )
    const description = confirm()!.querySelector('[data-stub-description]')!.textContent ?? ''
    expect(description).toBe(
      i18n.t('widgets.exportFailedDescription', { name: 'Alpha board', reason: reason() })
    )
    expect(description).toContain('Alpha board')
    expect(description).toContain(reason())
  })

  it.each([
    ['确认', '[data-stub-ok]'],
    ['取消', '[data-stub-cancel]']
  ])('WB-12 失败框按「%s」关掉，不去打开文件夹', async (_name, button) => {
    api.widget.exportForDownload.mockResolvedValue({
      success: false,
      code: 'PACK_FAILED',
      error: 'boom'
    })
    await mount([widget('a')])
    openApp('a')
    openMenu('a')
    await pick('export')
    expect(confirm()).not.toBeNull()

    click(confirm()!.querySelector(button)!)
    await settle()
    expect(confirm()).toBeNull()
    expect(api.widget.revealExport).not.toHaveBeenCalled()
  })

  it('WB-13 停止：注销、应用从面板收走、回到列表，行上的圆点灭掉', async () => {
    status = running('a')
    await mount([widget('a')])
    openApp('a')
    expect(row('a').querySelector('[data-widget-running]')).not.toBeNull()
    openMenu('a')
    api.widget.stopWidget.mockImplementationOnce(async () => {
      status = { running: false, registeredIds: [] }
      return { success: true }
    })
    await pick('stop')

    expect(api.widget.stopWidget).toHaveBeenCalledTimes(1)
    expect(api.widget.stopWidget).toHaveBeenCalledWith('a')
    expect(app('a')).toBeNull()
    expect(state().panelApps).toEqual([])
    expect(list().style.visibility).toBe('')
    expect(row('a').querySelector('[data-widget-running]')).toBeNull()
    expect(row('a').hasAttribute('data-running')).toBe(false)
  })

  it('WB-14 菜单属于按下按钮的那个应用', async () => {
    status = running('a', 'b')
    await mount([widget('a'), widget('b')])
    openApp('a')
    openApp('b')
    openApp('a')
    openMenu('a')
    expect(menuButton('a').getAttribute('aria-expanded')).toBe('true')
    expect(menuButton('b').getAttribute('aria-expanded')).toBe('false')

    goHome()
    openApp('b')
    openMenu('b')
    expect(menuButton('b').getAttribute('aria-expanded')).toBe('true')
    expect(menuButton('a').getAttribute('aria-expanded')).toBe('false')
    expect(document.body.querySelectorAll('[data-mobile-pulldown]')).toHaveLength(1)

    await pick('stop')
    expect(api.widget.stopWidget).toHaveBeenCalledTimes(1)
    expect(api.widget.stopWidget).toHaveBeenCalledWith('b')
    expect(app('a')).not.toBeNull()
    expect(app('b')).toBeNull()
  })

  it('WB-15 选一项就收起，aria-expanded 回 false', async () => {
    await mount([widget('a')])
    openApp('a')
    openMenu('a')
    expect(menuButton('a').getAttribute('aria-expanded')).toBe('true')
    await pick('reload')
    expect(pulldown()).toBeNull()
    expect(document.body.querySelector('[data-mobile-pulldown-layer]')).toBeNull()
    expect(menuButton('a').getAttribute('aria-expanded')).toBe('false')
  })

  it('WB-16 点菜单外收起，什么也不做', async () => {
    status = running('a')
    await mount([widget('a')])
    openApp('a')
    openMenu('a')
    click(document.body.querySelector('[data-mobile-pulldown-layer]')!)
    await settle()
    expect(pulldown()).toBeNull()
    expect(nonce('a')).toBe('0')
    expect(api.widgetWindow.open).not.toHaveBeenCalled()
    expect(api.widget.exportForDownload).not.toHaveBeenCalled()
    expect(api.widget.stopWidget).not.toHaveBeenCalled()
    expect(state().foregroundApp).toBe('a')
  })

  it('WB-17 Esc 收起；别的键不收', async () => {
    await mount([widget('a')])
    openApp('a')
    openMenu('a')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    })
    expect(pulldown()).not.toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(pulldown()).toBeNull()
    expect(state().foregroundApp).toBe('a')
  })

  it('WB-18 返回手势（popstate）收起，什么也不做', async () => {
    status = running('a')
    await mount([widget('a')])
    openApp('a')
    openMenu('a')
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await settle()
    expect(pulldown()).toBeNull()
    expect(nonce('a')).toBe('0')
    expect(api.widgetWindow.open).not.toHaveBeenCalled()
    expect(api.widget.exportForDownload).not.toHaveBeenCalled()
    expect(api.widget.stopWidget).not.toHaveBeenCalled()
  })

  it('WB-19 点菜单里不是项的地方不收', async () => {
    await mount([widget('a')])
    openApp('a')
    openMenu('a')
    click(pulldown()!)
    await settle()
    expect(pulldown()).not.toBeNull()
    expect(pulldownIds()).toEqual(['reload', 'popout', 'export'])
  })

  it('WB-20 「停止」那一项跟着运行状态现变，不用重新打开菜单', async () => {
    await mount([widget('a')])
    openApp('a')
    openMenu('a')
    expect(pulldownIds()).toEqual(['reload', 'popout', 'export'])

    status = running('a')
    await fireChanged()
    expect(pulldownIds()).toEqual(['reload', 'popout', 'export', 'stop'])

    status = { running: false, registeredIds: [] }
    await fireChanged()
    expect(pulldownIds()).toEqual(['reload', 'popout', 'export'])
  })

  it('WB-21 小组件不在了菜单就收掉；它回来、再打开也不冒出来，再按一次按钮才有', async () => {
    await mount([widget('a'), widget('b')])
    openApp('a')
    openMenu('a')
    expect(pulldown()).not.toBeNull()

    listed = [widget('b')]
    await fireChanged()
    expect(pulldown()).toBeNull()
    expect(app('a')).toBeNull()

    // 回到列表里：菜单不跟着回来
    listed = [widget('a'), widget('b')]
    await fireChanged()
    expect(row('a')).not.toBeNull()
    expect(pulldown()).toBeNull()

    // 再打开它：还是没有，直到再按一次按钮
    click(row('a'))
    await settle()
    expect(app('a')!.hasAttribute('data-foreground')).toBe(true)
    expect(pulldown()).toBeNull()
    expect(menuButton('a').getAttribute('aria-expanded')).toBe('false')

    openMenu('a')
    expect(pulldown()).not.toBeNull()
  })

  it('WB-23 菜单开着时回列表 → 菜单收掉，再打开那个应用也不冒出来', async () => {
    await mount([widget('a')])
    openApp('a')
    openMenu('a')
    expect(pulldown()).not.toBeNull()

    click(app('a')!.querySelector('[data-app-back]')!)
    await settle()
    expect(state().foregroundApp).toBeNull()
    expect(pulldown()).toBeNull()

    click(row('a'))
    await settle()
    expect(pulldown()).toBeNull()
    expect(menuButton('a').getAttribute('aria-expanded')).toBe('false')
  })

  it('WB-22 开着几个应用：只有前台那个可见，各有各的顶栏与名字', async () => {
    await mount([widget('a'), widget('b')])
    openApp('a')
    openApp('b')
    expect(container.querySelectorAll('[data-panel-app]')).toHaveLength(2)
    expect(app('b')!.hasAttribute('data-foreground')).toBe(true)
    expect(app('a')!.hasAttribute('data-foreground')).toBe(false)
    expect(app('a')!.style.pointerEvents).toBe('none')
    expect(app('a')!.style.visibility).toBe('hidden')
    expect(app('b')!.style.visibility).toBe('')
    expect(container.querySelectorAll('[data-app-bar]')).toHaveLength(2)
    expect(app('a')!.querySelector('[data-app-name]')!.textContent).toBe('Alpha board')
    expect(app('b')!.querySelector('[data-app-name]')!.textContent).toBe('Beta notes')
  })
})
