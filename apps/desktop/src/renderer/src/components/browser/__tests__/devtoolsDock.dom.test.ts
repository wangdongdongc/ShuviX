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
 *   DD-U35  拖上沿改高度（照 Chrome 实时变）：每次 mousemove → onHeight(按起点高度与起点 Y 算、夹过, false)；
 *           mouseup / 窗口失焦 / 左键已松开的 mousemove → onHeight(最后的高度, true) 一次，之后什么也不再报；
 *           只认左键；拖动中光标 row-resize、不可选中文字，结束复原；拖动期间不截图、不 setVisible、不盖
 *           pageCover、不报 null 矩形；
 *   DD-U36  原生 DevTools 的占位在 ResizeObserver 回调里**当场**报矩形（零尺寸报 null）；窗口缩放仍排到下一帧
 *           （同一帧里 ResizeObserver 先报了就只报一次）；卸载之后旧占位的尺寸变化不再报。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
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
  mouseDown,
  mouseMove,
  mouseUp,
  restoreInnerHeight,
  stubInnerHeight,
  stubRects,
  tabInfo,
  windowBlur,
  type FakeApi,
  type Mounted,
  type ResizeObserverControl
} from './browserDomSupport'

vi.mock('../sessionColor', () => ({
  sessionDotColor: () => 'rgb(1, 2, 3)',
  INTERCEPTING_DOT_COLOR: 'rgb(217, 119, 6)'
}))

let api: FakeApi
let ro: ResizeObserverControl
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
  ro = installResizeObserver()
  stubRects({ x: 0, y: 500, width: 1000, height: 260 })
  useBrowserTabsStore.setState({
    tabs: [],
    activeTabId: null,
    pageCover: null
  })
})

afterEach(() => {
  // 用例中途留着的拖动：先松手（document 上的监听摘掉），光标 / 选中复原
  mouseUp()
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  m?.unmount()
  m = null
  restoreInnerHeight()
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

describe('拖上沿改高度（DD-U35）', () => {
  let onHeight: ReturnType<typeof vi.fn<(height: number, commit: boolean) => void>>

  const render = (height: number): void => {
    act(() => {
      m!.root.render(createElement(BrowserDevtoolsDock, { height, onHeight }))
    })
  }

  const edge = (): HTMLElement => $('[data-devtools-resize]')!

  beforeEach(async () => {
    onHeight = vi.fn<(height: number, commit: boolean) => void>()
    stubInnerHeight(900)
    seed([tabInfo({ id: 'a', devtools: { panel: 'devtools' } })], 'a')
    m = await mountInto(BrowserDevtoolsDock, { height: 300, onHeight })
    await flush()
  })

  it('DD-U35 拖动中按起点算（重新渲染的高度不影响）；松手报一次 commit', () => {
    mouseDown(edge(), 0, { clientY: 600 })
    mouseMove(550)
    mouseMove(500)
    expect(onHeight.mock.calls).toEqual([
      [350, false],
      [400, false]
    ])
    render(400)
    mouseMove(450)
    expect(onHeight.mock.calls.at(-1)).toEqual([450, false])
    mouseUp()
    expect(onHeight.mock.calls).toEqual([
      [350, false],
      [400, false],
      [450, false],
      [450, true]
    ])
  })

  it('DD-U35 夹在 [140, innerHeight − 120] 之间', () => {
    mouseDown(edge(), 0, { clientY: 600 })
    mouseMove(-2000)
    expect(onHeight.mock.calls.at(-1)).toEqual([780, false])
    mouseMove(5000)
    expect(onHeight.mock.calls.at(-1)).toEqual([140, false])
    mouseUp()
    expect(onHeight.mock.calls.at(-1)).toEqual([140, true])
  })

  it('DD-U35 按下就松：只报一次 commit，高度不变', () => {
    mouseDown(edge(), 0, { clientY: 600 })
    mouseUp()
    expect(onHeight.mock.calls).toEqual([[300, true]])
  })

  it('DD-U35 窗口失焦结束拖动（commit 最后的高度）；之后的移动 / 松手 / 失焦不再报', () => {
    mouseDown(edge(), 0, { clientY: 600 })
    mouseMove(520)
    expect(onHeight.mock.calls).toEqual([[380, false]])
    windowBlur()
    expect(onHeight.mock.calls).toEqual([
      [380, false],
      [380, true]
    ])
    mouseMove(400)
    mouseUp()
    windowBlur()
    expect(onHeight).toHaveBeenCalledTimes(2)
  })

  it('DD-U35 左键已经松开的 mousemove：当作松手；之后的 mouseup 不再报', () => {
    mouseDown(edge(), 0, { clientY: 600 })
    mouseMove(550)
    expect(onHeight.mock.calls).toEqual([[350, false]])
    mouseMove(500, 0)
    expect(onHeight.mock.calls).toEqual([
      [350, false],
      [350, true]
    ])
    mouseUp()
    mouseMove(450)
    expect(onHeight).toHaveBeenCalledTimes(2)
  })

  it.each([
    [2, 'right'],
    [1, 'middle']
  ])('DD-U35 按的是 %i（%s）键：不开始拖动、不拦默认动作', (button) => {
    const down = mouseDown(edge(), button, { clientY: 600 })
    expect(down.defaultPrevented).toBe(false)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    mouseMove(500)
    mouseMove(400)
    mouseUp()
    expect(onHeight).not.toHaveBeenCalled()
    expect(document.body.style.cursor).toBe('')

    // 对照：左键按下拦掉默认动作（不选中文字、不拖走元素）
    expect(mouseDown(edge(), 0, { clientY: 600 }).defaultPrevented).toBe(true)
  })

  it.each([
    ['mouseup', (): void => mouseUp()],
    ['blur', (): void => windowBlur()],
    ['mousemove without the left button', (): void => mouseMove(500, 0)]
  ])('DD-U35 拖动中光标 row-resize、不可选中；%s 结束后复原', (_label, end) => {
    mouseDown(edge(), 0, { clientY: 600 })
    expect(document.body.style.cursor).toBe('row-resize')
    expect(document.body.style.userSelect).toBe('none')
    mouseMove(550)
    end()
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('DD-U35 第二次拖动从新的高度起算；上一次的监听不再报', () => {
    mouseDown(edge(), 0, { clientY: 600 })
    mouseMove(500)
    mouseUp()
    render(450)
    onHeight.mockClear()

    mouseDown(edge(), 0, { clientY: 600 })
    mouseMove(590)
    expect(onHeight.mock.calls).toEqual([[460, false]])
    mouseUp()
    expect(onHeight.mock.calls).toEqual([
      [460, false],
      [460, true]
    ])
  })

  it('DD-U35 拖动期间：不截图、不 setVisible、不盖 pageCover、不报 null 矩形', () => {
    const bv = api.browserView
    for (const fn of [bv.capture, bv.setVisible, bv.setDevtoolsLayout]) fn.mockClear()

    mouseDown(edge(), 0, { clientY: 600 })
    expect(useBrowserTabsStore.getState().pageCover).toBeNull()
    mouseMove(550)
    mouseMove(500)
    expect(useBrowserTabsStore.getState().pageCover).toBeNull()
    mouseUp()

    expect(bv.capture).not.toHaveBeenCalled()
    expect(bv.setVisible).not.toHaveBeenCalled()
    expect(useBrowserTabsStore.getState().pageCover).toBeNull()
    expect(bv.setDevtoolsLayout.mock.calls).not.toContainEqual([null])
    expect(useBrowserTabsStore.getState()).not.toHaveProperty('dockResizing')
    expect(useBrowserTabsStore.getState()).not.toHaveProperty('setDockResizing')
  })
})

describe('原生 DevTools 的占位当场报矩形（DD-U36）', () => {
  const native = (): HTMLElement => $('[data-devtools-native]')!

  beforeEach(async () => {
    seed([tabInfo({ id: 'a', devtools: { panel: 'devtools' } })], 'a')
    await mountDock()
    api.browserView.setDevtoolsLayout.mockClear()
  })

  it('DD-U36 ResizeObserver 一报就当场报新矩形（不等下一帧）', () => {
    expect(ro.observing(native())).toBe(1)
    stubRects({ x: 0, y: 450, width: 1000, height: 310 })
    ro.trigger(native())
    expect(api.browserView.setDevtoolsLayout.mock.calls).toEqual([
      [{ tabId: 'a', bounds: { x: 0, y: 450, width: 1000, height: 310 } }]
    ])
  })

  it('DD-U36 零尺寸：当场报 null', () => {
    stubRects({ x: 0, y: 450, width: 1000, height: 0 })
    ro.trigger(native())
    expect(api.browserView.setDevtoolsLayout.mock.calls).toEqual([[null]])
  })

  it('DD-U36 窗口缩放：排到下一帧再报当时的矩形', async () => {
    stubRects({ x: 0, y: 420, width: 1200, height: 280 })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(api.browserView.setDevtoolsLayout).not.toHaveBeenCalled()
    await flush()
    expect(api.browserView.setDevtoolsLayout.mock.calls).toEqual([
      [{ tabId: 'a', bounds: { x: 0, y: 420, width: 1200, height: 280 } }]
    ])
  })

  it('DD-U36 窗口缩放后、那一帧之前 ResizeObserver 先报了：总共只报一次', async () => {
    stubRects({ x: 0, y: 420, width: 1200, height: 280 })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    ro.trigger(native())
    expect(api.browserView.setDevtoolsLayout).toHaveBeenCalledTimes(1)
    await flush()
    expect(api.browserView.setDevtoolsLayout.mock.calls).toEqual([
      [{ tabId: 'a', bounds: { x: 0, y: 420, width: 1200, height: 280 } }]
    ])
  })

  it('DD-U36 换到 Agent 页签（报 null）之后，旧占位的尺寸变化不再报', async () => {
    const old = native()
    api.browserView.agentDevtools.mockResolvedValue(snapshot())
    seed([tabInfo({ id: 'a', devtools: { panel: 'agent' } })], 'a')
    await flush()
    expect(api.browserView.setDevtoolsLayout.mock.calls).toEqual([[null]])
    expect(ro.observing(old)).toBe(0)

    stubRects({ x: 0, y: 450, width: 1000, height: 310 })
    ro.trigger(old)
    await flush()
    expect(api.browserView.setDevtoolsLayout.mock.calls).toEqual([[null]])
  })
})
