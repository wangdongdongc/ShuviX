// @vitest-environment jsdom
/**
 * 停靠区的外壳一侧（BrowserDevtoolsDock / AgentDevtoolsPanel / 提示条入口）。
 *
 *   DD-U30  停靠区只跟着**选中的那页**：那页没开着就什么也没有；开着就是页签条 + 当前页签；点页签 →
 *           browserView.openDevtools(tab, panel)，✕ → closeDevtools(tab)；Agent 页签带调用数；
 *   DD-U31  DevTools 页签：占位把自己的矩形报给 setDevtoolsLayout({tabId, bounds})；换到 Agent 页签（或停靠区
 *           关掉）报 null；Agent 页签不报矩形；
 *   DD-U32  Agent 页签：挂上就取一次快照；只在**这一页**的「变了」到来时再取；调用一行一条（data-tool /
 *           data-status：ok / failed / aborted / running），点开看参数与 agent 收到的结果（截断注明原长）；
 *           清空 → clearAgentDevtools(tab)；网络 / 控制台页：没接入、没开采集、有条目三种样子；
 *   DD-U33  提示条：这页有 devtool 调用时才多一个「Agent's DevTools activity (n)」，点了 →
 *           openDevtools(tab, 'agent')；
 *   DD-U34  高度夹在 [140, 可用高度 − 120] 之间。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { BrowserDevtoolsDock } from '../BrowserDevtoolsDock'
import { clampDockHeight } from '../dockHeight'
import { AgentInfobar } from '../AgentInfobar'
import { useBrowserTabsStore, type BrowserTabInfo } from '../../../stores/browserTabsStore'
import type {
  AgentDevtoolsCall,
  AgentDevtoolsSnapshot
} from '../../../../../shared/browserAgentDevtools'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  installRaf,
  installResizeObserver,
  mountInto,
  stubRects,
  tabInfo,
  type FakeApi,
  type Mounted
} from './browserDomSupport'

vi.mock('../sessionColor', () => ({
  sessionDotColor: () => 'rgb(1, 2, 3)',
  INTERCEPTING_DOT_COLOR: 'rgb(217, 119, 6)'
}))

let api: FakeApi
let m: Mounted | null = null

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  m!.container.querySelector<T>(sel)
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [
  ...m!.container.querySelectorAll<T>(sel)
]

function seed(tabs: BrowserTabInfo[], activeTabId: string | null): void {
  act(() => {
    useBrowserTabsStore.setState({ tabs, activeTabId })
  })
}

function call(over: Partial<AgentDevtoolsCall> & { id: number }): AgentDevtoolsCall {
  return {
    tool: 'evaluate',
    sessionId: 's1',
    sessionTitle: 'Session one',
    startedAt: 0,
    summary: 'document.title',
    params: '{\n  "expression": "document.title"\n}',
    durationMs: 3,
    ok: true,
    result: '"Home"',
    ...over
  }
}

function snapshot(over: Partial<AgentDevtoolsSnapshot> = {}): AgentDevtoolsSnapshot {
  return {
    calls: [],
    attached: true,
    capturing: { network: true, console: true },
    network: [],
    console: [],
    ...over
  }
}

const mountDock = async (): Promise<void> => {
  m = await mountInto(BrowserDevtoolsDock, { height: 300, onHeight: () => undefined })
  await flush()
}

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  api = installFakeApi()
  installRaf()
  installResizeObserver()
  stubRects({ x: 0, y: 500, width: 1000, height: 260 })
  useBrowserTabsStore.setState({
    tabs: [],
    activeTabId: null,
    dockResizing: false,
    pageCover: null
  })
})

afterEach(() => {
  m?.unmount()
  m = null
  vi.restoreAllMocks()
})

describe('停靠区跟着选中的那页（DD-U30）', () => {
  it('DD-U30 选中的那页没开：什么也没有（别的页开着也不算）', async () => {
    seed([tabInfo({ id: 'a' }), tabInfo({ id: 'b', devtools: { panel: 'devtools' } })], 'a')
    await mountDock()
    expect($('[data-devtools-dock]')).toBeNull()
  })

  it('DD-U30 开着：页签条 + 当前页签；点页签 → openDevtools；✕ → closeDevtools；Agent 页签带调用数', async () => {
    seed([tabInfo({ id: 'a', devtools: { panel: 'devtools' }, agentDevtoolsCalls: 4 })], 'a')
    await mountDock()
    const dock = $('[data-devtools-dock]')
    expect(dock?.getAttribute('data-devtools-dock')).toBe('a')
    expect(dock?.getAttribute('data-panel')).toBe('devtools')
    expect($('[data-devtools-tab="devtools"]')?.getAttribute('aria-selected')).toBe('true')
    expect($('[data-devtools-tab="agent"]')?.textContent).toBe('Agent4')

    click($('[data-devtools-tab="agent"]')!)
    expect(api.browserView.openDevtools).toHaveBeenCalledWith('a', 'agent')
    click($('[data-devtools-close]')!)
    expect(api.browserView.closeDevtools).toHaveBeenCalledWith('a')
  })
})

describe('原生 DevTools 的占位（DD-U31）', () => {
  it('DD-U31 DevTools 页签报矩形；换到 Agent 页签报 null、不再报矩形', async () => {
    seed([tabInfo({ id: 'a', devtools: { panel: 'devtools' } })], 'a')
    await mountDock()
    expect(api.browserView.setDevtoolsLayout).toHaveBeenLastCalledWith({
      tabId: 'a',
      bounds: { x: 0, y: 500, width: 1000, height: 260 }
    })
    api.browserView.setDevtoolsLayout.mockClear()

    seed([tabInfo({ id: 'a', devtools: { panel: 'agent' } })], 'a')
    await flush()
    expect(api.browserView.setDevtoolsLayout.mock.calls).toEqual([[null]])
  })

  it('DD-U31 停靠区关掉（那页不再有 devtools）→ 报 null', async () => {
    seed([tabInfo({ id: 'a', devtools: { panel: 'devtools' } })], 'a')
    await mountDock()
    api.browserView.setDevtoolsLayout.mockClear()
    seed([tabInfo({ id: 'a' })], 'a')
    await flush()
    expect(api.browserView.setDevtoolsLayout.mock.calls).toEqual([[null]])
    expect($('[data-devtools-dock]')).toBeNull()
  })
})

describe('Agent 页签（DD-U32）', () => {
  const openAgent = async (snap: AgentDevtoolsSnapshot): Promise<void> => {
    api.browserView.agentDevtools.mockResolvedValue(snap)
    seed([tabInfo({ id: 'a', devtools: { panel: 'agent' } })], 'a')
    await mountDock()
  }

  it('DD-U32 挂上取一次；只在这一页「变了」时再取', async () => {
    await openAgent(snapshot())
    expect(api.browserView.agentDevtools.mock.calls).toEqual([['a']])
    act(() => api.callbacks.onAgentDevtoolsChanged({ tabId: 'other', callCount: 1 }))
    await flush()
    expect(api.browserView.agentDevtools).toHaveBeenCalledTimes(1)
    api.browserView.agentDevtools.mockResolvedValue(snapshot({ calls: [call({ id: 1 })] }))
    act(() => api.callbacks.onAgentDevtoolsChanged({ tabId: 'a', callCount: 1 }))
    await flush()
    expect(api.browserView.agentDevtools).toHaveBeenCalledTimes(2)
    expect($$('[data-agent-call]')).toHaveLength(1)
  })

  it('DD-U32 一行一条调用（四种状态）；点开看参数与结果，截断注明原长；清空 → clearAgentDevtools', async () => {
    await openAgent(
      snapshot({
        calls: [
          call({ id: 1 }),
          call({ id: 2, tool: 'cdp', summary: 'Browser.close', ok: false, result: 'blocked' }),
          call({ id: 3, tool: 'network', ok: false, aborted: true, result: 'Aborted' }),
          call({ id: 4, tool: 'console', ok: undefined, durationMs: undefined, result: undefined }),
          call({ id: 5, result: 'x'.repeat(10), resultTruncatedFrom: 25_000 })
        ]
      })
    )
    expect(
      $$('[data-agent-call]').map((el) => [
        el.getAttribute('data-tool'),
        el.getAttribute('data-status')
      ])
    ).toEqual([
      ['evaluate', 'ok'],
      ['cdp', 'failed'],
      ['network', 'aborted'],
      ['console', 'running'],
      ['evaluate', 'ok']
    ])
    // 进行中的那条没有结果区
    click($('[data-agent-call="4"] button')!)
    expect($('[data-agent-call="4"] [data-agent-call-detail]')?.textContent).not.toContain(
      'What the agent received'
    )
    click($('[data-agent-call="2"] button')!)
    const failed = $('[data-agent-call="2"] [data-agent-call-detail]')?.textContent ?? ''
    expect(failed).toContain('What the agent received · Failed')
    expect(failed).toContain('blocked')
    click($('[data-agent-call="5"] button')!)
    expect($('[data-agent-call="5"] [data-agent-call-detail]')?.textContent).toContain(
      '… truncated (25000 characters in total)'
    )

    click($('[data-agent-devtools-clear]')!)
    expect(api.browserView.clearAgentDevtools).toHaveBeenCalledWith('a')
  })

  it('DD-U32 没有调用：空状态说明；清空按钮不可点', async () => {
    await openAgent(snapshot())
    expect(m!.container.textContent).toContain('The agent has not used DevTools on this page yet.')
    expect($<HTMLButtonElement>('[data-agent-devtools-clear]')?.disabled).toBe(true)
  })

  it('DD-U32 网络页：没接入 / 没开采集 / 有条目', async () => {
    await openAgent(snapshot({ attached: false, capturing: { network: false, console: false } }))
    click($('[data-agent-devtools-view="network"]')!)
    expect(m!.container.textContent).toContain('The agent is not attached to this page right now')
    m!.unmount()

    await openAgent(snapshot({ capturing: { network: false, console: true } }))
    click($('[data-agent-devtools-view="network"]')!)
    expect(m!.container.textContent).toContain('first time it calls network')
    m!.unmount()

    await openAgent(
      snapshot({
        network: [
          {
            id: '9.1',
            url: 'https://a.test/api',
            method: 'POST',
            status: 500,
            mimeType: 'application/json',
            completed: true,
            failed: false,
            size: 2048
          },
          { id: '9.2', url: 'https://a.test/x', method: 'GET', completed: false, failed: false }
        ]
      })
    )
    click($('[data-agent-devtools-view="network"]')!)
    const rows = $$('[data-agent-request]').map((r) =>
      [...r.querySelectorAll('td')].map((td) => td.textContent)
    )
    expect(rows).toEqual([
      ['9.1', '500', 'POST', 'https://a.test/api', 'application/json', '2.0 kB'],
      ['9.2', '…', 'GET', 'https://a.test/x', '', '']
    ])
  })

  it('DD-U32 控制台页：级别、文字、来源（文件名:行号，从 1 数）', async () => {
    await openAgent(
      snapshot({
        console: [
          {
            id: 1,
            type: 'error',
            text: 'boom',
            url: 'https://a.test/js/app.js',
            lineNumber: 9,
            timestamp: 0
          },
          { id: 2, type: 'log', text: 'hello', timestamp: 0 }
        ]
      })
    )
    click($('[data-agent-devtools-view="console"]')!)
    const lines = $$('[data-agent-console-line]')
    expect(lines.map((l) => l.getAttribute('data-agent-console-line'))).toEqual(['error', 'log'])
    expect(lines[0].textContent).toContain('boom')
    expect(lines[0].textContent).toContain('app.js:10')
    expect(lines[1].textContent).toContain('hello')
  })
})

describe('提示条入口（DD-U33）', () => {
  it('DD-U33 有调用才出现；点了 → openDevtools(tab, agent)', async () => {
    seed(
      [tabInfo({ id: 'a', cdpAttached: true, agentSessionId: 's1', agentSessionTitle: 'S' })],
      'a'
    )
    m = await mountInto(AgentInfobar, {})
    expect($('[data-agent-infobar-devtools]')).toBeNull()

    seed(
      [
        tabInfo({
          id: 'a',
          cdpAttached: true,
          agentSessionId: 's1',
          agentSessionTitle: 'S',
          agentDevtoolsCalls: 3
        })
      ],
      'a'
    )
    expect($('[data-agent-infobar-devtools]')?.textContent).toBe("Agent's DevTools activity (3)")
    click($('[data-agent-infobar-devtools]')!)
    expect(api.browserView.openDevtools).toHaveBeenCalledWith('a', 'agent')
  })
})

describe('高度（DD-U34）', () => {
  it.each([
    [50, 900, 140],
    [300, 900, 300],
    [850, 900, 780],
    [300, 200, 140]
  ])('DD-U34 想要 %i、可用 %i → %i', (want, available, got) => {
    expect(clampDockHeight(want, available)).toBe(got)
  })
})
