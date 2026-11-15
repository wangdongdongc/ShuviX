// @vitest-environment jsdom
/**
 * Widget 面板的桌面样子没被手机布局带走（`<WidgetPanel />`，不给 `mobile`，桌面宿主）。
 *
 *   WD-1  卡片网格：没有手机的分组卡片 / 行 / 名字、时间、圆点的锚点；卡片上有 id 与扳手图标
 *   WD-2  相对时间（「5m ago」/「Just now」/「Never opened」），从不写时分
 *   WD-3  悬浮按钮：归档 / 删除每张都有，停止只在运行中的卡片上
 *   WD-4  悬浮按钮做事但不打开卡片
 *   WD-5  运行中的卡片：data-running 与图标右下角的绿点，没有手机那颗 [data-widget-running]
 *   WD-6  右键菜单以「在面板中打开」开头；选它 → 写偏好 false，再在面板里打开
 *   WD-7  桌面顶栏：返回里带名字，重新加载 / 独立窗口两颗，没有「⋯」、没有下拉菜单
 *   WD-8  记住的「独立窗口」选择：点卡片开窗口，不在面板里打开，也不改偏好
 *   WD-9  `mobile: false` 明着给 = 不给
 *   WD-11 桌面不装那只 60 秒的钟（没有 interval）
 *
 * （WD-10「RightPanel 不给 mobile」在 rightPanel.dom.test.ts。）
 *
 * 脚手架同 widgetPanelMobile.dom.test.ts：`isWebHost` 定成桌面，右键菜单是间谍，WidgetFrame / ConfirmDialog 是带锚点的桩。
 * 钟只假 Date 与 setInterval / clearInterval，挂载之前定在 NOW。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type FunctionComponent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { click, initEnI18n } from './browserDomSupport'

type MenuItem = { id: string; label: string; type?: string }

const menu = vi.hoisted(() => ({
  calls: [] as Array<Array<{ id: string; label: string; type?: string }>>,
  nextPick: null as string | null
}))
const downloadServerFile = vi.hoisted(() => vi.fn())

vi.mock('../../../host/hostMedia', () => ({ isWebHost: false }))
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

const api = {
  app: { platform: 'darwin' },
  widget: {
    list: vi.fn<() => Promise<WidgetSummary[]>>(),
    listArchived: vi.fn<() => Promise<WidgetSummary[]>>(),
    getServerStatus: vi.fn(),
    exportForDownload: vi.fn(),
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

/** 本地时间的 2025-06-18 15:30:00 */
const NOW = new Date(2025, 5, 18, 15, 30, 0).getTime()

let listed: WidgetSummary[] = []
let status: { running: boolean; registeredIds?: string[] } = { running: false, registeredIds: [] }
let container: HTMLDivElement
let root: Root

const NAMES: Record<string, string> = { a: 'Alpha board', b: 'Beta notes' }

function widget(id: string, over: Partial<WidgetSummary> = {}): WidgetSummary {
  return {
    id,
    name: NAMES[id] ?? `Widget ${id.toUpperCase()}`,
    description: `About the ${NAMES[id] ?? 'thing'}`,
    createdAt: NOW - 3 * 3600_000,
    updatedAt: 1,
    lastOpenedAt: 0,
    archivedAt: 0,
    projectIds: [],
    ...over
  }
}

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

async function mount(widgets: WidgetSummary[], props?: WidgetPanelProps): Promise<void> {
  listed = widgets
  await act(async () => {
    root.render(props ? createElement(Panel, props) : createElement(WidgetPanel))
  })
  await settle()
}

const q = <T extends HTMLElement = HTMLElement>(sel: string): T | null =>
  container.querySelector<T>(sel)
const card = (id: string): HTMLElement => {
  const el = q(`[data-widget-card="${id}"]`)
  if (!el) throw new Error(`no card ${id}`)
  return el
}
const list = (): HTMLElement => q('[data-widget-list]')!
const app = (id: string): HTMLElement | null => q(`[data-panel-app="${id}"]`)
const nonce = (id: string): string | null =>
  q(`[data-stub-frame="${id}"]`)?.getAttribute('data-reload-nonce') ?? null
const confirm = (): HTMLElement | null => q('[data-stub-confirm]')
const state = (): ReturnType<typeof useWidgetStore.getState> => useWidgetStore.getState()

async function rightClick(el: Element, pickId: string | null = null): Promise<MenuItem[]> {
  menu.nextPick = pickId
  act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await settle()
  const items = menu.calls.at(-1)
  if (!items) throw new Error('no context menu was requested')
  return items
}

/** WD-1 的断言（WD-9 再跑一遍） */
function expectCardGrid(ids: string[]): void {
  expect(q('[data-widget-rows]')).toBeNull()
  expect(q('[data-widget-row]')).toBeNull()
  expect(q('[data-widget-name]')).toBeNull()
  expect(q('[data-widget-time]')).toBeNull()
  expect(q('[data-widget-running]')).toBeNull()
  expect(container.querySelectorAll('[data-widget-card]')).toHaveLength(ids.length)
  for (const id of ids) {
    expect(card(id).hasAttribute('data-widget-row')).toBe(false)
    const spans = [...card(id).querySelectorAll('span')].map((s) => s.textContent)
    expect(spans, id).toContain(id)
    expect(card(id).querySelector('svg[class*="lucide-wrench"]'), id).not.toBeNull()
  }
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
  menu.calls = []
  menu.nextPick = null
  downloadServerFile.mockReset()
  api.widget.list.mockReset().mockImplementation(async () => listed)
  api.widget.listArchived.mockReset().mockResolvedValue([])
  api.widget.getServerStatus
    .mockReset()
    .mockImplementation(async () => ({ port: 0, widgetCount: 0, ...status }))
  api.widget.exportForDownload.mockReset()
  api.widget.pickExportTarget.mockReset().mockResolvedValue({ success: false })
  api.widget.exportAsVite.mockReset()
  api.widget.revealExport.mockReset()
  api.widget.stopWidget.mockClear()
  api.widget.setArchived.mockClear()
  api.widget.delete.mockClear()
  api.widgetWindow.status.mockReset().mockResolvedValue({ open: [], preferWindow: [] })
  api.widgetWindow.open.mockClear()
  api.widgetWindow.setPreferWindow.mockReset()
  api.widgetWindow.close.mockReset()
  api.events.subscribe.mockReset().mockImplementation(() => () => {})
  useWidgetStore.setState(useWidgetStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('WidgetPanel 桌面：没被手机布局带走', () => {
  it('WD-1 卡片网格：没有手机的行与锚点；卡片上有 id 与扳手图标', async () => {
    status = { running: true, registeredIds: ['a'] }
    await mount([widget('a'), widget('b')])
    expectCardGrid(['a', 'b'])
  })

  it('WD-2 相对时间：几分钟前 / 刚刚 / 从未打开，从不写时分', async () => {
    await mount([
      widget('five', { createdAt: NOW - 5 * 60_000 - 1000 }),
      widget('fresh', { createdAt: NOW - 10_000 }),
      widget('never', { createdAt: 0, lastOpenedAt: 0 }),
      widget('opened', { createdAt: NOW - 9 * 3600_000, lastOpenedAt: NOW - 2 * 3600_000 })
    ])
    expect(card('five').textContent).toContain(i18n.t('widgets.minutesAgo', { count: 5 }))
    expect(card('fresh').textContent).toContain(en.widgets.justNow)
    expect(card('never').textContent).toContain(en.widgets.never)
    expect(card('opened').textContent).toContain(i18n.t('widgets.hoursAgo', { count: 2 }))
    for (const id of ['five', 'fresh', 'never', 'opened']) {
      expect(card(id).textContent, id).not.toMatch(/\d{2}:\d{2}/)
    }
  })

  it('WD-3 悬浮按钮：归档 / 删除每张都有，停止只在运行中的卡片上', async () => {
    status = { running: true, registeredIds: ['a'] }
    await mount([widget('a'), widget('b')])
    for (const id of ['a', 'b']) {
      expect(card(id).querySelector('[data-card-archive]'), id).not.toBeNull()
      expect(card(id).querySelector('[data-card-delete]'), id).not.toBeNull()
    }
    expect(card('a').querySelector('[data-card-stop]')).not.toBeNull()
    expect(card('b').querySelector('[data-card-stop]')).toBeNull()
  })

  it('WD-4 悬浮按钮做事但不打开卡片：归档 / 删除（确认框）/ 停止', async () => {
    status = { running: true, registeredIds: ['a'] }
    await mount([widget('a'), widget('b')])

    click(card('b').querySelector('[data-card-archive]')!)
    await settle()
    expect(api.widget.setArchived).toHaveBeenCalledTimes(1)
    expect(api.widget.setArchived).toHaveBeenCalledWith({ id: 'b', archived: true })
    expect(state().foregroundApp).toBeNull()

    click(card('b').querySelector('[data-card-delete]')!)
    await settle()
    expect(confirm()).not.toBeNull()
    expect(confirm()!.querySelector('[data-stub-title]')!.textContent).toBe(
      en.widgets.confirmDeleteTitle
    )
    expect(api.widget.delete).not.toHaveBeenCalled()
    expect(state().foregroundApp).toBeNull()
    click(confirm()!.querySelector('[data-stub-cancel]')!)

    click(card('a').querySelector('[data-card-stop]')!)
    await settle()
    expect(api.widget.stopWidget).toHaveBeenCalledTimes(1)
    expect(api.widget.stopWidget).toHaveBeenCalledWith('a')
    expect(state().foregroundApp).toBeNull()
    expect(state().panelApps).toEqual([])
  })

  it('WD-5 运行中的卡片：data-running 与图标盒子里的绿点，没有手机那颗圆点', async () => {
    status = { running: true, registeredIds: ['a'] }
    await mount([widget('a'), widget('b')])
    expect(card('a').getAttribute('data-running')).toBe('')
    expect(card('b').hasAttribute('data-running')).toBe(false)
    const iconBox = (id: string): HTMLElement =>
      card(id).querySelector<HTMLElement>('svg[class*="lucide-wrench"]')!.parentElement!
    expect(iconBox('a').querySelectorAll('span')).toHaveLength(1)
    expect(iconBox('b').querySelectorAll('span')).toHaveLength(0)
    expect(q('[data-widget-running]')).toBeNull()
  })

  it('WD-6 右键菜单以「在面板中打开」开头；选它 → 写偏好 false，再在面板里打开', async () => {
    await mount([widget('a')])
    const items = await rightClick(card('a'))
    expect(items.map((i) => i.id)).toEqual([
      'openPanel',
      'openWindow',
      'sep1',
      'export',
      'archive',
      'sep2',
      'delete'
    ])
    expect(items[0].label).toBe(en.widgets.openInPanel)
    expect(state().foregroundApp).toBeNull()

    await rightClick(card('a'), 'openPanel')
    expect(api.widgetWindow.setPreferWindow).toHaveBeenCalledTimes(1)
    expect(api.widgetWindow.setPreferWindow).toHaveBeenCalledWith({ id: 'a', value: false })
    expect(state().foregroundApp).toBe('a')
    expect(app('a')!.hasAttribute('data-foreground')).toBe(true)
    expect(api.widgetWindow.open).not.toHaveBeenCalled()
  })

  it('WD-7 桌面顶栏：返回里带名字，重新加载 / 独立窗口两颗，没有「⋯」与下拉菜单', async () => {
    await mount([widget('a')])
    click(card('a'))
    await settle()
    const panelApp = app('a')!
    expect(panelApp.hasAttribute('data-foreground')).toBe(true)

    const back = panelApp.querySelector<HTMLElement>('[data-app-back]')!
    expect(back.textContent).toBe('Alpha board')
    const reload = panelApp.querySelector<HTMLElement>('[data-app-reload]')!
    const popout = panelApp.querySelector<HTMLElement>('[data-app-popout]')!
    expect(reload.title).toBe(en.widgets.windowReload)
    expect(popout.title).toBe(en.widgets.openInWindow)
    expect(q('[data-app-menu]')).toBeNull()
    expect(q('[data-app-name]')).toBeNull()
    expect(q('[data-app-bar]')).toBeNull()

    expect(nonce('a')).toBe('0')
    click(reload)
    expect(nonce('a')).toBe('1')
    expect(document.body.querySelector('[data-mobile-pulldown]')).toBeNull()

    click(popout)
    await settle()
    expect(api.widgetWindow.setPreferWindow).toHaveBeenCalledTimes(1)
    expect(api.widgetWindow.setPreferWindow).toHaveBeenCalledWith({ id: 'a', value: true })
    expect(api.widgetWindow.open).toHaveBeenCalledTimes(1)
    expect(api.widgetWindow.open).toHaveBeenCalledWith('a')
    expect(app('a')).toBeNull()
    expect(state().panelApps).toEqual([])
    expect(list().style.visibility).toBe('')
    expect(document.body.querySelector('[data-mobile-pulldown]')).toBeNull()
  })

  it('WD-8 记住的「独立窗口」选择：点卡片开窗口，不在面板里打开，也不改偏好', async () => {
    api.widgetWindow.status.mockResolvedValue({ open: [], preferWindow: ['a'] })
    await mount([widget('a'), widget('b')])
    click(card('a'))
    await settle()
    expect(api.widgetWindow.open).toHaveBeenCalledTimes(1)
    expect(api.widgetWindow.open).toHaveBeenCalledWith('a')
    expect(api.widgetWindow.setPreferWindow).not.toHaveBeenCalled()
    expect(state().foregroundApp).toBeNull()
    expect(app('a')).toBeNull()

    // 没记过的那张照旧在面板里打开
    click(card('b'))
    await settle()
    expect(state().foregroundApp).toBe('b')
    expect(api.widgetWindow.open).toHaveBeenCalledTimes(1)
  })

  it('WD-9 mobile: false 明着给 = 不给', async () => {
    status = { running: true, registeredIds: ['a'] }
    await mount([widget('a'), widget('b')], { mobile: false })
    expectCardGrid(['a', 'b'])
    expect(card('a').querySelector('[data-card-stop]')).not.toBeNull()
    const items = await rightClick(card('b'))
    expect(items[0].id).toBe('openPanel')
    click(card('b'))
    await settle()
    expect(app('b')!.querySelector('[data-app-reload]')).not.toBeNull()
    expect(q('[data-app-menu]')).toBeNull()
  })

  it.each([
    ['不给 mobile', undefined],
    ['mobile: false', { mobile: false }]
  ])('WD-11 桌面不装那只 60 秒的钟（%s）', async (_name, props) => {
    const set = vi.spyOn(window, 'setInterval')
    await mount([widget('a', { lastOpenedAt: NOW - 30_000 })], props)
    expect(set.mock.calls.filter((c) => c[1] === 60_000)).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
