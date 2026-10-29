// @vitest-environment jsdom
/**
 * Widget 面板卡片上的项目标签（WidgetPanel 的 ProjectTags）—— 用过这个组件的会话所在的项目，名字由 widget:list 补
 * （`WidgetSummary.projects`，最近的在前），只作信息展示。
 *
 *   WP-1 没有项目（空数组 / 没有这个字段）→ 没有 [data-widget-projects]；id / 时间那一行仍是卡片那一列的最后一个子节点
 *        （e2e 的卡片读数 pages.ts widgetPanelPane.card 靠它，有标签的卡片也一样）
 *   WP-2 两个项目 → 两个 [data-widget-project=<id>]，按给的顺序、写着名字；没有「+N」
 *   WP-3 恰好三个 → 三个标签，没有「+N」
 *   WP-4 五个 → 前三个标签 + 「+2」；整行的悬停提示是 `Used in projects: A, B, C, D, E`（全部名字）
 *   WP-5 名字里有 & < " → 标签与提示里原样出现（不转义成实体）
 *   WP-6 收到 widget.changed → 重新取列表，标签跟着变
 *
 * 桌面 vitest 对渲染层只收 `*.test.ts`（本文件自己切 jsdom），不带 react 插件 —— 一律 createElement。
 * `window.api` 只铺面板挂载时用到的几样（widget.list / listArchived / getServerStatus、widgetWindow.status、
 * events.subscribe）；`isWebHost` 定成桌面，共享的右键菜单换成空壳。i18n 走真 en 资源（同渲染层：不转义插值）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { initEnI18n } from './browserDomSupport'

vi.mock('../../../host/hostMedia', () => ({ isWebHost: false }))
vi.mock('@shuvix/app-shell', () => ({ useContextMenu: () => async () => {} }))

import { WidgetPanel } from '../WidgetPanel'
import { useWidgetStore } from '../../../stores/widgetStore'

type AppEventCallback = (event: { type: string }) => void

const api = {
  app: { platform: 'darwin' },
  widget: {
    list: vi.fn<() => Promise<WidgetSummary[]>>(),
    listArchived: vi.fn<() => Promise<WidgetSummary[]>>(),
    getServerStatus: vi.fn()
  },
  widgetWindow: { status: vi.fn() },
  events: { subscribe: vi.fn<(cb: AppEventCallback) => () => void>() }
}

let listed: WidgetSummary[] = []
let subscribers: AppEventCallback[] = []
let container: HTMLDivElement
let root: Root

function widget(id: string, projects?: Array<{ id: string; name: string }>): WidgetSummary {
  return {
    id,
    name: `Name ${id}`,
    description: `About ${id}`,
    createdAt: Date.now() - 60_000,
    updatedAt: 1,
    lastOpenedAt: 0,
    archivedAt: 0,
    projectIds: (projects ?? []).map((p) => p.id),
    ...(projects ? { projects } : {})
  }
}

const P = (id: string, name: string): { id: string; name: string } => ({ id, name })

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(widgets: WidgetSummary[]): Promise<void> {
  listed = widgets
  await act(async () => {
    root.render(createElement(WidgetPanel))
  })
  await flush()
  await flush()
}

const card = (id: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[data-widget-card="${id}"]`)
  if (!el) throw new Error(`no card ${id}`)
  return el
}
const row = (id: string): HTMLElement | null =>
  card(id).querySelector<HTMLElement>('[data-widget-projects]')
const tags = (id: string): Array<[string, string]> =>
  [...card(id).querySelectorAll<HTMLElement>('[data-widget-project]')].map((t) => [
    t.getAttribute('data-widget-project') ?? '',
    t.textContent ?? ''
  ])
const more = (id: string): string | null =>
  card(id).querySelector('[data-widget-projects-more]')?.textContent ?? null

/** 同 e2e 的读法：卡片那一列的最后一个子节点里第一个 span 是 id */
function lastRowIsIdRow(id: string): boolean {
  const col = card(id).querySelector('.flex-1.min-w-0')
  const last = col?.lastElementChild
  if (!last || last.hasAttribute('data-widget-projects')) return false
  const spans = [...last.querySelectorAll('span')]
  return spans.length >= 2 && (spans[0].textContent ?? '').trim() === id
}

beforeAll(async () => {
  await initEnI18n()
  ;(window as unknown as { api: unknown }).api = api
})

beforeEach(() => {
  listed = []
  subscribers = []
  api.widget.list.mockReset().mockImplementation(async () => listed)
  api.widget.listArchived.mockReset().mockResolvedValue([])
  api.widget.getServerStatus
    .mockReset()
    .mockResolvedValue({ running: false, port: 0, widgetCount: 0, registeredIds: [] })
  api.widgetWindow.status.mockReset().mockResolvedValue({ open: [], preferWindow: [] })
  api.events.subscribe.mockReset().mockImplementation((cb) => {
    subscribers.push(cb)
    return () => {
      subscribers = subscribers.filter((s) => s !== cb)
    }
  })
  useWidgetStore.setState({
    widgets: [],
    archived: [],
    loaded: false,
    serverStatus: null,
    windowOpen: [],
    preferWindow: [],
    panelApps: [],
    foregroundApp: null
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('WidgetPanel 卡片上的项目标签', () => {
  it('WP-1 没有项目（空数组 / 没有字段）→ 没有标签行；id 那一行仍是最后一个子节点', async () => {
    const missing = widget('no-field')
    expect('projects' in missing).toBe(false)
    await mount([widget('empty-list', []), missing, widget('has-one', [P('p1', 'Alpha')])])

    expect(row('empty-list')).toBeNull()
    expect(row('no-field')).toBeNull()
    expect(card('empty-list').querySelector('[data-widget-project]')).toBeNull()
    for (const id of ['empty-list', 'no-field', 'has-one']) {
      expect(lastRowIsIdRow(id), id).toBe(true)
    }
    expect(row('has-one')).not.toBeNull()
  })

  it('WP-2 两个项目 → 两个标签，按顺序、写着名字；没有 +N', async () => {
    await mount([widget('two-tags', [P('p2', 'Beta'), P('p1', 'Alpha')])])
    expect(tags('two-tags')).toEqual([
      ['p2', 'Beta'],
      ['p1', 'Alpha']
    ])
    expect(more('two-tags')).toBeNull()
    expect(lastRowIsIdRow('two-tags')).toBe(true)
  })

  it('WP-3 恰好三个 → 三个标签，没有 +N', async () => {
    await mount([widget('three-tags', [P('a', 'A'), P('b', 'B'), P('c', 'C')])])
    expect(tags('three-tags').map(([id]) => id)).toEqual(['a', 'b', 'c'])
    expect(more('three-tags')).toBeNull()
  })

  it('WP-4 五个 → 前三个 + 「+2」；悬停提示列出全部名字', async () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map((n) => P(`id-${n}`, n))
    await mount([widget('five-tags', five)])
    expect(tags('five-tags')).toEqual([
      ['id-A', 'A'],
      ['id-B', 'B'],
      ['id-C', 'C']
    ])
    expect(more('five-tags')).toBe('+2')
    expect(row('five-tags')!.title).toBe('Used in projects: A, B, C, D, E')
    expect(en.widgets.usedInProjects).toBe('Used in projects: {{names}}')
  })

  it('WP-5 名字里的 & < " 原样出现在标签与提示里', async () => {
    const odd = 'R&D <"core">'
    await mount([widget('odd-name', [P('p-odd', odd), P('p2', 'Plain')])])
    expect(tags('odd-name')).toEqual([
      ['p-odd', odd],
      ['p2', 'Plain']
    ])
    expect(row('odd-name')!.title).toBe(`Used in projects: ${odd}, Plain`)
    expect(row('odd-name')!.title).not.toContain('&amp;')
  })

  it('WP-6 widget.changed → 重新取列表，标签跟着变', async () => {
    await mount([widget('live-tags', [P('p1', 'Alpha')])])
    expect(tags('live-tags')).toEqual([['p1', 'Alpha']])
    expect(subscribers).toHaveLength(1)
    const calls = api.widget.list.mock.calls.length

    listed = [widget('live-tags', [P('p2', 'Beta'), P('p1', 'Alpha renamed')])]
    await act(async () => {
      for (const cb of subscribers) cb({ type: 'widget.changed' })
    })
    await flush()
    await flush()

    expect(api.widget.list.mock.calls.length).toBe(calls + 1)
    expect(tags('live-tags')).toEqual([
      ['p2', 'Beta'],
      ['p1', 'Alpha renamed']
    ])

    // 别的事件不重取
    await act(async () => {
      for (const cb of subscribers) cb({ type: 'session.changed' })
    })
    await flush()
    expect(api.widget.list.mock.calls.length).toBe(calls + 1)
  })
})
