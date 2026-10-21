/**
 * agent 的 devtool（agentDevtools.ts）—— 停靠区「Agent」页签的数据：调用记录 + agent 手里的采集缓冲。
 *
 *   DD-U1  摘要：evaluate 是表达式首行（多行带 …、过长截断）、cdp 是方法名、events 是事件 · sinceSeq · limit、
 *          network / console 是 limit（没给就空）；只记 evaluate / network / console / cdp / events；
 *   DD-U2  一次调用：开始就记（没有 ok / 耗时 / 结果 = 进行中），落定补上成败、耗时、agent 收到的文字、aborted；
 *          参数是去掉 tabId 的缩进 JSON（只有 tabId = 空串）；会话标题读的时候现查；
 *   DD-U3  截断：结果超 20000 字截断并记原长；参数 JSON 超 8000 字截断并在末尾注明原长；
 *   DD-U4  每页最多 200 条（丢最老的）；不同页各记各的；
 *   DD-U5  「变了」节流：150ms 内的多次变化只发一次 browser-view:agent-devtools-changed{tabId, callCount}，
 *          各页分开；浏览器窗口没建 / 已销毁时不发也不抛；采集变化（noteAgentCaptureChange）同样走它；
 *   DD-U6  清空只清调用记录（agent 的采集原样还在）、发一次「变了」；本来就空的不发；
 *   DD-U7  tab 关掉（forget）：记录没了、排着的「变了」撤掉；跑到一半的调用之后落定也不再通知；
 *   DD-U8  快照里的采集是 agent 的 CDP 会话现取的（peek，不 attach）：没接入 → attached false、两份都空；
 *          接入了 → capturing 与条目原样（网络行不带 CDP 的单调时间戳）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  /** peek 回的会话（没有 = agent 没接入） */
  session: undefined as
    | undefined
    | {
        capturing: { network: boolean; console: boolean }
        getNetworkRequests: () => unknown[]
        getConsoleMessages: () => unknown[]
      },
  peek: vi.fn(),
  titles: new Map<string, string>(),
  send: vi.fn(),
  windowAlive: true
}))

vi.mock('../browserCdpService', () => ({
  browserCdpManager: {
    peek: (tabId: string) => {
      state.peek(tabId)
      return state.session
    }
  }
}))

vi.mock('../browserViewService', () => ({
  agentSessionTitle: (sessionId: string) => state.titles.get(sessionId) ?? '',
  getBrowserHostWindow: () =>
    state.windowAlive ? { isDestroyed: () => false, webContents: { send: state.send } } : null
}))

import {
  agentDevtoolsCallCount,
  agentDevtoolsSnapshot,
  clearAgentDevtoolsCalls,
  forgetAgentDevtools,
  isAgentDevtoolsTool,
  noteAgentCaptureChange,
  recordAgentDevtoolsCall,
  resetAgentDevtools,
  summaryOf
} from '../agentDevtools'

beforeEach(() => {
  vi.useFakeTimers()
  state.session = undefined
  state.peek.mockClear()
  state.titles.clear()
  state.send.mockClear()
  state.windowAlive = true
})

afterEach(() => {
  resetAgentDevtools()
  vi.useRealTimers()
})

const changedEvents = (): unknown[] =>
  state.send.mock.calls
    .filter(([channel]) => channel === 'browser-view:agent-devtools-changed')
    .map(([, payload]) => payload)

describe('摘要与记哪些（DD-U1）', () => {
  it.each([
    ['evaluate', { expression: 'document.title' }, 'document.title'],
    ['evaluate', { expression: '  a = 1\nb = 2\n' }, 'a = 1 …'],
    ['evaluate', { expression: 'x'.repeat(300) }, `${'x'.repeat(159)}…`],
    [
      'cdp',
      { method: 'Network.getResponseBody', params: { requestId: '1' } },
      'Network.getResponseBody'
    ],
    ['events', {}, '*'],
    [
      'events',
      { event: 'Network.responseReceived', sinceSeq: 5, limit: 10 },
      'Network.responseReceived · sinceSeq 5 · limit 10'
    ],
    ['network', {}, ''],
    ['network', { limit: 20 }, 'limit 20'],
    ['console', { limit: '5' }, 'limit 5']
  ] as const)('DD-U1 %s %j → %j', (tool, args, expected) => {
    expect(summaryOf(tool, args as Record<string, unknown>)).toBe(expected)
  })

  it('DD-U1 只记 devtool 那五个', () => {
    for (const t of ['evaluate', 'network', 'console', 'cdp', 'events']) {
      expect(isAgentDevtoolsTool(t)).toBe(true)
    }
    for (const t of ['click', 'snapshot', 'navigate', 'screenshot', 'cdp_recipes', 'list_tabs']) {
      expect(isAgentDevtoolsTool(t)).toBe(false)
    }
  })
})

describe('一次调用（DD-U2）', () => {
  it('DD-U2 开始即记（进行中），落定补上成败 / 耗时 / 结果；参数去掉 tabId；会话标题读时现查', () => {
    vi.setSystemTime(1_000_000)
    const done = recordAgentDevtoolsCall('tab-a', 's1', 'cdp', {
      tabId: 't3',
      method: 'Runtime.evaluate',
      params: { expression: '1+1' }
    })
    const running = agentDevtoolsSnapshot('tab-a').calls
    expect(running).toHaveLength(1)
    expect(running[0]).toEqual({
      id: expect.any(Number),
      tool: 'cdp',
      sessionId: 's1',
      sessionTitle: '',
      startedAt: 1_000_000,
      summary: 'Runtime.evaluate',
      params: JSON.stringify({ method: 'Runtime.evaluate', params: { expression: '1+1' } }, null, 2)
    })

    vi.setSystemTime(1_000_042)
    done({ ok: true, text: '{"result":{"type":"number","value":2}}' })
    state.titles.set('s1', 'Checkout bug')
    expect(agentDevtoolsSnapshot('tab-a').calls[0]).toMatchObject({
      ok: true,
      durationMs: 42,
      result: '{"result":{"type":"number","value":2}}',
      sessionTitle: 'Checkout bug'
    })
    expect(agentDevtoolsSnapshot('tab-a').calls[0]).not.toHaveProperty('aborted')
    expect(agentDevtoolsCallCount('tab-a')).toBe(1)
  })

  it('DD-U2 没做成 / 被取消：ok false，取消多一个 aborted；只有 tabId 的参数记成空串', () => {
    recordAgentDevtoolsCall('tab-a', 's1', 'network', { tabId: 't3' })({
      ok: false,
      text: 'The page in this tab crashed'
    })
    recordAgentDevtoolsCall('tab-a', 's1', 'evaluate', { tabId: 't3', expression: 'x' })({
      ok: false,
      text: 'Aborted',
      aborted: true
    })
    const [failed, aborted] = agentDevtoolsSnapshot('tab-a').calls
    expect(failed).toMatchObject({ ok: false, params: '', result: 'The page in this tab crashed' })
    expect(failed).not.toHaveProperty('aborted')
    expect(aborted).toMatchObject({ ok: false, aborted: true, result: 'Aborted' })
  })
})

describe('截断（DD-U3）', () => {
  it('DD-U3 结果超 20000 字截断并记原长；参数 JSON 超 8000 字截断、末尾注明原长', () => {
    const expression = 'y'.repeat(9000)
    recordAgentDevtoolsCall('tab-a', 's1', 'evaluate', { tabId: 't1', expression })({
      ok: true,
      text: 'z'.repeat(25_000)
    })
    const [call] = agentDevtoolsSnapshot('tab-a').calls
    expect(call.result).toHaveLength(20_000)
    expect(call.resultTruncatedFrom).toBe(25_000)
    const fullJson = JSON.stringify({ expression }, null, 2)
    expect(call.params).toBe(`${fullJson.slice(0, 8000)}\n… (${fullJson.length} chars)`)
  })
})

describe('上限与分页（DD-U4）', () => {
  it('DD-U4 每页最多 200 条（丢最老的），不同页各记各的', () => {
    for (let i = 0; i < 205; i++) {
      recordAgentDevtoolsCall('tab-a', 's1', 'cdp', { tabId: 't1', method: `Dom.m${i}` })
    }
    recordAgentDevtoolsCall('tab-b', 's2', 'console', { tabId: 't2' })
    const calls = agentDevtoolsSnapshot('tab-a').calls
    expect(calls).toHaveLength(200)
    expect(calls[0].summary).toBe('Dom.m5')
    expect(calls[199].summary).toBe('Dom.m204')
    expect(agentDevtoolsCallCount('tab-b')).toBe(1)
    expect(agentDevtoolsCallCount('tab-c')).toBe(0)
  })
})

describe('「变了」节流（DD-U5）', () => {
  it('DD-U5 150ms 内的多次变化只发一次（各页分开），带此刻的调用数', () => {
    const done = recordAgentDevtoolsCall('tab-a', 's1', 'console', { tabId: 't1' })
    done({ ok: true, text: 'ok' })
    noteAgentCaptureChange('tab-a')
    recordAgentDevtoolsCall('tab-b', 's1', 'network', { tabId: 't2' })
    expect(changedEvents()).toEqual([])
    vi.advanceTimersByTime(150)
    expect(changedEvents()).toEqual([
      { tabId: 'tab-a', callCount: 1 },
      { tabId: 'tab-b', callCount: 1 }
    ])
    // 采集变化单独来也发（调用数照实）
    noteAgentCaptureChange('tab-a')
    vi.advanceTimersByTime(150)
    expect(changedEvents()).toHaveLength(3)
    expect(changedEvents()[2]).toEqual({ tabId: 'tab-a', callCount: 1 })
  })

  it('DD-U5 浏览器窗口没建：不发、不抛', () => {
    state.windowAlive = false
    recordAgentDevtoolsCall('tab-a', 's1', 'console', { tabId: 't1' })
    expect(() => vi.advanceTimersByTime(200)).not.toThrow()
    expect(state.send).not.toHaveBeenCalled()
  })
})

describe('清空与关 tab（DD-U6 / DD-U7）', () => {
  it('DD-U6 清空只清调用记录，agent 的采集原样；发一次「变了」；本来就空的不发', () => {
    state.session = {
      capturing: { network: true, console: false },
      getNetworkRequests: () => [
        {
          id: 'r1',
          url: 'https://a.test/',
          method: 'GET',
          timestamp: 1,
          completed: false,
          failed: false
        }
      ],
      getConsoleMessages: () => []
    }
    recordAgentDevtoolsCall('tab-a', 's1', 'network', { tabId: 't1' })
    vi.advanceTimersByTime(150)
    state.send.mockClear()

    clearAgentDevtoolsCalls('tab-a')
    const snap = agentDevtoolsSnapshot('tab-a')
    expect(snap.calls).toEqual([])
    expect(snap.network.map((r) => r.id)).toEqual(['r1'])
    vi.advanceTimersByTime(150)
    expect(changedEvents()).toEqual([{ tabId: 'tab-a', callCount: 0 }])

    clearAgentDevtoolsCalls('tab-a')
    vi.advanceTimersByTime(150)
    expect(changedEvents()).toHaveLength(1)
  })

  it('DD-U7 tab 关掉：记录没了、排着的「变了」撤掉；跑到一半的调用之后落定也不再通知', () => {
    const done = recordAgentDevtoolsCall('tab-a', 's1', 'evaluate', {
      tabId: 't1',
      expression: 'x'
    })
    forgetAgentDevtools('tab-a')
    vi.advanceTimersByTime(150)
    expect(state.send).not.toHaveBeenCalled()
    done({ ok: true, text: '1' })
    vi.advanceTimersByTime(150)
    expect(state.send).not.toHaveBeenCalled()
    expect(agentDevtoolsSnapshot('tab-a').calls).toEqual([])
  })
})

describe('采集是现取的（DD-U8）', () => {
  it('DD-U8 没接入：attached false、两份都空', () => {
    const snap = agentDevtoolsSnapshot('tab-a')
    expect(state.peek).toHaveBeenCalledWith('tab-a')
    expect(snap).toEqual({
      calls: [],
      attached: false,
      capturing: { network: false, console: false },
      network: [],
      console: []
    })
  })

  it('DD-U8 接入了：capturing 与条目原样；网络行不带 CDP 的单调时间戳，缺的字段不出现', () => {
    state.session = {
      capturing: { network: true, console: true },
      getNetworkRequests: () => [
        {
          id: 'r1',
          url: 'https://a.test/api',
          method: 'POST',
          status: 201,
          mimeType: 'application/json',
          timestamp: 123.45,
          completed: true,
          failed: false,
          size: 88
        },
        {
          id: 'r2',
          url: 'https://a.test/x',
          method: 'GET',
          timestamp: 124,
          completed: false,
          failed: false
        }
      ],
      getConsoleMessages: () => [
        {
          id: 1,
          type: 'error',
          text: 'boom',
          url: 'https://a.test/app.js',
          lineNumber: 9,
          timestamp: 1700
        }
      ]
    }
    const snap = agentDevtoolsSnapshot('tab-a')
    expect(snap.attached).toBe(true)
    expect(snap.capturing).toEqual({ network: true, console: true })
    expect(snap.network).toEqual([
      {
        id: 'r1',
        url: 'https://a.test/api',
        method: 'POST',
        status: 201,
        mimeType: 'application/json',
        completed: true,
        failed: false,
        size: 88
      },
      { id: 'r2', url: 'https://a.test/x', method: 'GET', completed: false, failed: false }
    ])
    expect(snap.console).toEqual([
      {
        id: 1,
        type: 'error',
        text: 'boom',
        url: 'https://a.test/app.js',
        lineNumber: 9,
        timestamp: 1700
      }
    ])
  })
})
